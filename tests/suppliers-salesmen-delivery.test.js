/**
 * Manufacturers & suppliers (full record and sign-ins), salesmen (admin screen and the salesman's own
 * dashboard), the Delivery group, and the admin sidebar keeping its scroll position.
 *
 * DB-free: the service rules run against a scripted transaction (every SQL statement is recorded and
 * answered by the test), and the screens/routes are checked as the server builds them. The same flows
 * against MySQL 8 are in tests/suppliers-salesmen-delivery.mysql.test.js (needs the test database).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.ERP_JWT_SECRET = process.env.ERP_JWT_SECRET || 'test-erp-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const vendors = require('../src/modules/erp/vendors/service.js');
const team = require('../src/modules/erp/sales/team.js');
const security = require('../src/modules/erp/core/security.js');
const staff = { type: 'staff', id: 7, label: 'erp-staff:7', role: 'procurement_manager' };

/** A transaction that records every statement; `answer(sql, params, kind)` returns the row(s), or undefined for the default. */
function scripted(answer) {
  const calls = [];
  let nextId = 100;
  const run = (kind) => async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [], kind });
    const a = answer ? answer(sql, params || [], kind) : undefined;
    if (a !== undefined) return a;
    if (kind === 'one') return null;
    return /^\s*INSERT/i.test(sql) ? { insertId: nextId++, affectedRows: 1 } : [];
  };
  return { query: run('all'), queryOne: run('one'), calls, find: (re) => calls.filter(c => re.test(c.sql)) };
}
const rejects = async (p, status, code) => {
  try { await p; } catch (e) { assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code, e.message); return e; }
  assert.fail('expected an error ' + status);
};

/* ── Manufacturers & suppliers ── */
test('a temporary password is long, readable, accepted by the password rules and different every time', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = vendors.temporaryPassword();
    assert.match(p, /^[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{4}7$/);
    seen.add(p);
  }
  assert.equal(seen.size, 50);
  assert.doesNotThrow(() => security.hashPassword(vendors.temporaryPassword()));
});

test('staff add a manufacturer with its owner\'s sign-in: vendor, capabilities, address, owner login (hashed, must change) and an audit row', async () => {
  const tx = scripted((sql) => {
    if (/FROM b2b_states WHERE id/.test(sql)) return { id: 12 };
    if (/FROM b2b_states WHERE gst_code/.test(sql)) return { id: 12 };
    return undefined;
  });
  const r = await vendors.createWithLogin(tx, staff, {
    legalName: 'Mandya Cane Products Pvt Ltd', tradeName: 'Mandya Cane', fssaiLicence: '11223344556677', paymentTermsDays: '30',
    capabilities: ['contract_manufacturer', 'manufacturer', 'manufacturer', 'nonsense'],
    address: { line1: 'Plot 4, KIADB', city: 'Mandya', pincode: '571401', stateId: 12 },
    user: { name: 'Kiran Rao', email: 'Kiran@Maker.test', mobile: '98765 00001' },
  });
  assert.equal(r.status, 'submitted');
  assert.equal(r.login.email, 'kiran@maker.test');
  assert.equal(r.login.mustChangeAtFirstSignIn, true);
  const v = tx.find(/^INSERT INTO b2b_vendors /)[0];
  assert.match(v.sql, /'submitted', 'invited'\)$/);
  assert.ok(v.params.includes('Mandya Cane Products Pvt Ltd') && v.params.includes(30));
  assert.deepEqual(tx.find(/INSERT INTO b2b_vendor_capabilities/).map(c => c.params[1]), ['contract_manufacturer', 'manufacturer'], 'each capability once, unknown ones dropped');
  const a = tx.find(/INSERT INTO b2b_vendor_addresses/)[0];
  assert.deepEqual(a.params.slice(1, 7), ['registered', 'Plot 4, KIADB', null, 'Mandya', 12, '571401']);
  const u = tx.find(/INSERT INTO b2b_vendor_users/)[0];
  assert.equal(u.params[5], 'owner');
  assert.ok(security.verifyPassword(r.login.temporaryPassword, u.params[4]), 'only the hash is stored, and it matches the password shown once');
  assert.ok(!JSON.stringify(tx.calls).includes(r.login.temporaryPassword), 'the clear password is never written anywhere');
  assert.equal(tx.find(/SET must_change_password = 1/).length, 1);
  const audit = tx.find(/INSERT INTO b2b_audit_logs/);
  assert.equal(audit.length, 1); assert.ok(audit[0].params.includes('vendor.created'));
});

test('adding without a capability, with a bad PIN or an unknown state is refused', async () => {
  await rejects(vendors.createWithLogin(scripted(), staff, { legalName: 'X Traders', capabilities: [], user: { name: 'A B', email: 'a@b.test', mobile: '9876500003' } }), 400);
  const noState = scripted(() => undefined);
  await rejects(vendors.addAddress(scripted((sql) => /FROM b2b_vendors WHERE id/.test(sql) ? { id: 1 } : undefined), staff, 1, { type: 'factory', line1: 'A', city: 'B', pincode: '12345', stateId: 1 }), 400);
  await rejects(vendors.addAddress(scripted((sql) => /FROM b2b_vendors WHERE id/.test(sql) ? { id: 1 } : undefined), staff, 1, { type: 'factory', line1: 'A', city: 'B', pincode: '560001', stateId: 99 }), 400);
  await rejects(vendors.addAddress(noState, staff, 1, { type: 'factory', line1: 'A', city: 'B', pincode: '560001', stateId: 1 }), 404);
});

test('bank accounts: the staff member who added one cannot verify it; an account the vendor added can be verified by any checker', async () => {
  const added = (actorType, actorId) => scripted((sql, p) => {
    if (/FROM b2b_vendor_bank_accounts WHERE id/.test(sql)) return { id: 5, status: 'pending' };
    if (/action = 'vendor.bank_added'/.test(sql)) { assert.equal(p[1], '{"bankAccountId":5,%'); return { actor_type: actorType, actor_id: String(actorId) }; }
    return undefined;
  });
  await rejects(vendors.verifyBankAccount(added('admin', 7), staff, 3, 5, { status: 'verified' }), 403, 'maker_cannot_check');
  const ok = added('business', 7);   // vendor user #7 is not staff #7
  assert.deepEqual(await vendors.verifyBankAccount(ok, staff, 3, 5, { status: 'verified' }), { bankAccountId: 5, status: 'verified' });
  assert.equal(ok.find(/UPDATE b2b_vendor_bank_accounts SET status/)[0].params[0], 'verified');
  await rejects(vendors.verifyBankAccount(scripted((sql) => /FROM b2b_vendor_bank_accounts/.test(sql) ? { id: 5, status: 'verified' } : undefined), staff, 3, 5, { status: 'verified' }), 409);
});

test('adding a bank account stores it encrypted with the last 4 digits only in clear, and records which account it was', async () => {
  const tx = scripted((sql) => /FROM b2b_vendors WHERE id/.test(sql) ? { id: 3 } : undefined);
  await vendors.addBankAccount(tx, staff, 3, { accountName: 'Mandya Cane', accountNo: '1234 5678 9012', ifsc: 'hdfc0001234' });
  const ins = tx.find(/INSERT INTO b2b_vendor_bank_accounts/)[0];
  assert.equal(ins.params[3], '9012'); assert.equal(ins.params[4], 'HDFC0001234');
  assert.ok(!String(ins.params[2]).includes('123456789012') && security.decrypt(ins.params[2]) === '123456789012');
  const audit = tx.find(/INSERT INTO b2b_audit_logs/)[0];
  assert.ok(audit.params.some(p => typeof p === 'string' && p.indexOf('{"bankAccountId":100,') === 0), 'the audit row names the account (used by the maker-checker rule)');
  await rejects(vendors.addBankAccount(scripted(), staff, 3, { accountName: 'X', accountNo: '12', ifsc: 'HDFC0001234' }), 400);
});

test('sign-ins: the only active owner cannot be turned off, nobody turns off themselves, a reset gives a new one-time password and ends old sessions', async () => {
  const owner = scripted((sql) => {
    if (/FROM b2b_vendor_users WHERE id = \? AND vendor_id/.test(sql)) return { id: 9, role: 'owner', status: 'active', password_hash: 'x', email: 'o@v.test' };
    if (/COUNT\(\*\) AS n FROM b2b_vendor_users/.test(sql)) return { n: 0 };
    return undefined;
  });
  await rejects(vendors.setUserStatus(owner, staff, 3, 9, 'disabled'), 409);
  await rejects(vendors.setUserStatus(owner, staff, 3, 9, 'disabled', 9), 409);
  const reset = scripted((sql) => /FROM b2b_vendor_users WHERE id = \? AND vendor_id/.test(sql) ? { id: 9, email: 'o@v.test', status: 'active' } : undefined);
  const r = await vendors.resetUserPassword(reset, staff, 3, 9);
  const upd = reset.find(/UPDATE b2b_vendor_users SET password_hash/)[0];
  assert.match(upd.sql, /token_version = token_version \+ 1/);
  assert.match(upd.sql, /locked_until = NULL/);
  assert.ok(security.verifyPassword(r.temporaryPassword, upd.params[0]));
  assert.equal(reset.find(/must_change_password = 1/).length, 1);
  await rejects(vendors.resetUserPassword(scripted((sql) => /FROM b2b_vendor_users/.test(sql) ? { id: 9, status: 'disabled' } : undefined), staff, 3, 9), 409);
});

test('a capability is approved only for an approved business; the vendor can ask for another', async () => {
  const tx = (vstatus, cap) => scripted((sql) => {
    if (/SELECT status FROM b2b_vendors/.test(sql)) return { status: vstatus };
    if (/FROM b2b_vendor_capabilities WHERE vendor_id/.test(sql)) return cap;
    return undefined;
  });
  await rejects(vendors.decideCapability(tx('under_verification', { status: 'requested' }), staff, 3, { capability: 'contract_manufacturer', status: 'approved' }), 409);
  assert.deepEqual(await vendors.decideCapability(tx('approved', { status: 'requested' }), staff, 3, { capability: 'contract_manufacturer', status: 'approved' }), { capability: 'contract_manufacturer', status: 'approved' });
  await rejects(vendors.decideCapability(tx('approved', null), staff, 3, { capability: 'contract_manufacturer', status: 'approved' }), 404);
  const me = { vendorId: 3, userId: 4, role: 'owner' };
  await rejects(vendors.requestCapability(tx('approved', { status: 'approved' }), me, 'manufacturer'), 409);
  const req = tx('approved', null);
  assert.deepEqual(await vendors.requestCapability(req, me, 'manufacturer'), { capability: 'manufacturer', status: 'requested' });
  assert.equal(req.find(/INSERT INTO b2b_vendor_capabilities/).length, 1);
});

test('staff edits are audited with the old values; a duplicate GSTIN is a clear 409', async () => {
  const tx = scripted((sql) => /FROM b2b_vendors WHERE id = \? FOR UPDATE/.test(sql) ? { id: 3, legal_name: 'Old', payment_terms_days: 15, gstin: null } : undefined);
  const r = await vendors.staffUpdate(tx, staff, 3, { legalName: 'New Name Pvt Ltd', paymentTermsDays: '45', reason: 'Name change certificate seen' });
  assert.deepEqual(r.changed.sort(), ['legal_name', 'payment_terms_days']);
  const audit = tx.find(/INSERT INTO b2b_audit_logs/)[0];
  assert.ok(audit.params.includes('vendor.updated'));
  assert.ok(audit.params.some(p => typeof p === 'string' && p.includes('"legal_name":"Old"')));
  const dup = scripted((sql) => {
    if (/FROM b2b_vendors WHERE id = \? FOR UPDATE/.test(sql)) return { id: 3, gstin: null };
    if (/^UPDATE b2b_vendors SET/.test(sql)) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    return undefined;
  });
  await rejects(vendors.staffUpdate(dup, staff, 3, { tradeName: 'X' }), 409);
});

test('the one-time invitation link points at the supplier portal', async () => {
  const r = await vendors.invite(scripted(), staff, { legalName: 'Invited Foods', capabilities: ['supplier_wholesaler'], user: { name: 'Asha', email: 'asha@inv.test', mobile: '9876500004' } });
  assert.match(r.invitePath, /^\/vendor-portal\/\?invite=[A-Za-z0-9_-]{32}$/);
});

/* ── Salesmen ── */
test('a salesman holding cash that was not handed over cannot be switched off (unless forced); changes are audited', async () => {
  const tx = (cash) => scripted((sql) => {
    if (/FROM b2b_salesmen WHERE id = \? FOR UPDATE/.test(sql)) return { id: 4, is_active: 1, cash_limit: '20000.00' };
    if (/SUM\(amount\)/.test(sql)) return { v: cash };
    return undefined;
  });
  await rejects(team.update(tx('1500.00'), staff, 4, { active: false }), 409, 'cash_in_hand');
  const ok = tx('0');
  assert.deepEqual((await team.update(ok, staff, 4, { active: false, reason: 'Left the company' })).changed, ['is_active']);
  assert.equal(ok.find(/INSERT INTO b2b_audit_logs/).length, 1);
  await rejects(team.update(tx('0'), staff, 4, { cashLimit: -5 }), 400);
  await rejects(team.update(tx('0'), staff, 4, {}), 400);
});

/* ── Screens, routes and the sidebar ── */
test('the sidebar has a Delivery group (dashboard, shop deliveries, trade deliveries, delivery staff) and a Salesmen screen; old addresses still work', () => {
  const reg = require('../src/platform/registry.js');
  const g = reg.GROUPS.map(x => x.id);
  assert.equal(g.indexOf('delivery'), g.indexOf('sales') + 1);
  const delivery = reg.PAGES.filter(p => p.group === 'delivery').map(p => p.id);
  assert.deepEqual(delivery.sort(), ['deliveries', 'erp-deliveries', 'erp-deliveryhub', 'erp-deliverystaff']);
  assert.equal(reg.PAGES.find(p => p.id === 'deliveries').path, '/admin/sales/deliveries', 'the shop delivery role\'s home page keeps its address');
  assert.equal(reg.PAGES.find(p => p.id === 'erp-deliveries').path, '/admin/sales/trade-deliveries');
  const sm = reg.PAGES.find(p => p.id === 'erp-salesmen');
  assert.equal(sm.group, 'sales'); assert.equal(sm.perm, 'sales.reports.view');
  reg.PAGES.filter(p => p.module === 'erp').forEach(p => assert.ok(p.scripts.includes('/admin/erp/people.js'), p.id));
  const nav = reg.navFor(null, true, { enabled: true, permissions: new Set(['deliveries.view', 'deliveries.manage', 'sales.reports.view', 'vendors.view']) });
  const dg = nav.groups.find(x => x.id === 'delivery');
  assert.deepEqual(dg.items.map(i => i.id), ['erp-deliveryhub', 'erp-deliveries', 'erp-deliverystaff']);
  assert.ok(nav.groups.find(x => x.id === 'sales').items.some(i => i.id === 'erp-salesmen'));
});

function routes(router) {
  return router.stack.filter(l => l.route).map(l => Object.keys(l.route.methods)[0].toUpperCase() + ' ' + l.route.path);
}
test('the APIs behind the new screens exist, with fixed paths before the :id routes', () => {
  const v = routes(require('../src/modules/erp/routes/vendors.js'));
  for (const r of ['POST /vendors', 'PUT /vendors/:id', 'POST /vendors/:id/addresses', 'DELETE /vendors/:id/addresses/:addressId', 'POST /vendors/:id/users', 'POST /vendors/:id/users/:userId/reset-password',
    'POST /vendors/:id/users/:userId/status', 'POST /vendors/:id/capabilities', 'GET /vendors-lookup/states', 'GET /vendors-lookup/products']) assert.ok(v.includes(r), r);
  const p = routes(require('../src/modules/erp/routes/vendor-portal.js'));
  for (const r of ['GET /states', 'GET /addresses', 'POST /addresses', 'DELETE /addresses/:id', 'GET /bank-accounts', 'POST /bank-accounts', 'GET /users', 'POST /users', 'POST /users/:id/reset-password', 'POST /users/:id/status', 'POST /capabilities']) assert.ok(p.includes(r), r);
  assert.ok(p.indexOf('GET /states') < p.indexOf('GET /me'), 'the state list is public (registration)');
  const sales = require('../src/modules/erp/routes/sales.js');
  const o = routes(sales.office);
  assert.ok(o.indexOf('GET /salesmen/lookups') < o.indexOf('GET /salesmen/:id'));
  assert.ok(o.includes('PUT /salesmen/:id') && o.includes('GET /salesmen'));
  assert.ok(routes(sales.app).includes('GET /dashboard'));
  const d = routes(require('../src/modules/erp/routes/deliveries.js'));
  assert.ok(d.indexOf('GET /summary') !== -1 && d.indexOf('GET /summary') < d.indexOf('GET /:id'));
});

test('the screens: suppliers in full, salesmen, delivery; the supplier portal registration and team; the field-app dashboard; the sign-in page links', () => {
  const people = read('erp-web/admin/people.js');
  for (const k of ["['people', 'Sign-ins", "['addresses', 'Addresses", "['bank', 'Bank accounts", "['docs', 'Documents & checks", "['products', 'Products & prices", 'Add manufacturer / supplier', 'secretBox']) assert.ok(people.includes(k), k);
  assert.match(people, /\{ id: 'vendors', label: 'Manufacturers & Suppliers', perm: 'vendors\.view', render: vendors \}/);
  assert.ok(!/id: 'vendors'/.test(read('erp-web/admin/modules.js')), 'one vendors screen only');
  assert.ok(read('erp-web/admin/index.html').includes('/admin/erp/people.js'));
  const portal = read('erp-web/vendor/app.js');
  for (const k of ["'/states'", "'/addresses'", "'/bank-accounts'", "'/users'", "'/capabilities'", 'Register as a manufacturer or supplier', "type: 'checkbox'"]) assert.ok(portal.includes(k), k);
  assert.ok(read('erp-web/sales/app.js').includes("'/api/sales/dashboard'"));
  const login = read('platform-web/login.html');
  assert.ok(login.includes('href="/vendor-portal/?register"') && login.includes('href="/b2b/"'));
  assert.ok(!/textContent\s*=\s*[^;]*innerHTML|\.innerHTML\s*=/.test(people), 'text only, no HTML injection');
});

test('the admin menu keeps its scroll position between pages and always shows the open page', () => {
  const a = read('frontend/admin/admin.js');
  assert.match(a, /document\.body\.innerHTML = renderShell\(activeId, title\);\s*restoreNavScroll\(\);\s*watchNavScroll\(\);/);
  assert.match(a, /el\.innerHTML = navHTML\(nav, activeId\); restoreNavScroll\(\);/, 'and again after the menu is refreshed from the server');
  assert.match(a, /addEventListener\('pagehide', saveNavScroll\)/);
  assert.match(a, /sessionStorage\.setItem\(NAV_SCROLL_KEY/);
});
