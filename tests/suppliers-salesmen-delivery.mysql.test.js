/**
 * Manufacturers & suppliers, salesmen and the delivery dashboard on MySQL 8 — TEST database only (the
 * runner refuses anything else, and refuses while 013/014 are present). Real server, real APIs.
 *
 * Covers: staff add a manufacturer with its owner's sign-in (temporary password → must change at /login →
 * portal works); the full record (sign-ins, addresses, bank accounts with maker-checker, capabilities,
 * edits audited); the vendor adds its own address, bank account and a team sign-in; a supplier self-registers
 * with several capabilities and an address; vendor isolation; the Salesmen list/detail/update (cash-in-hand
 * rule) and the salesman's own dashboard; the delivery summary; permissions on every new endpoint.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, bearer } = require('./helpers/erp.js');
const { gstin } = require('./helpers/db.js');

let c, s;
const S = {};
const num = async (sql, args) => Number(Object.values(await c.db.queryOne(sql, args || []))[0]);

test.before(async () => {
  c = await setup(); s = c.s;
  S.ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  S.pm = await c.person('procman', ['procurement_manager']);
  S.fin = await c.person('finman', ['finance_manager']);
  S.sales = await c.person('salesmgr', ['sales_manager']);
  S.drv = await c.person('driver1', ['delivery_staff']);
});
test.after(async () => { if (c) await c.stop(); });   // closes the database pool too, so the run ends

test('staff add a manufacturer with its owner\'s sign-in; the owner must choose a password at /login, then the portal works', async () => {
  const r = await s.post('/api/erp/vendors', {
    legalName: 'Mandya Cane Products Pvt Ltd', gstin: gstin('29', 'AAACM1234F'), fssaiLicence: '10019043000123', paymentTermsDays: 30,
    capabilities: ['contract_manufacturer', 'manufacturer'], address: { line1: 'Plot 4, KIADB', city: 'Mandya', pincode: '571401', stateId: S.ka },
    user: { name: 'Kiran Rao', email: 'kiran@maker.test', mobile: '9876500001' },
  }, S.pm.h);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  S.v = r.data.vendorId; S.temp = r.data.login.temporaryPassword;
  assert.equal(r.data.login.mustChangeAtFirstSignIn, true);
  assert.equal(await num('SELECT COUNT(*) FROM b2b_vendor_capabilities WHERE vendor_id = ?', [S.v]), 2);
  assert.equal(await num("SELECT COUNT(*) FROM b2b_vendor_addresses WHERE vendor_id = ? AND address_type = 'registered'", [S.v]), 1);
  const u = await c.db.queryOne('SELECT password_hash, must_change_password, role FROM b2b_vendor_users WHERE email = ?', ['kiran@maker.test']);
  assert.equal(u.role, 'owner'); assert.equal(Number(u.must_change_password), 1); assert.ok(!String(u.password_hash).includes(S.temp));
  // the temporary password opens nothing until it is changed
  const li = await s.post('/api/vendor/auth/login', { email: 'kiran@maker.test', password: S.temp });
  assert.equal(li.status, 200);
  assert.equal((await s.get('/api/vendor/me', bearer(li.data.token))).status, 403);
  const ch = await s.post('/api/platform/auth/change-password', { email: 'kiran@maker.test', currentPassword: S.temp, newPassword: 'Kiran-own-pass-2026' });
  assert.ok(ch.status === 200 || ch.status === 204, JSON.stringify(ch.data));
  const li2 = await s.post('/api/vendor/auth/login', { email: 'kiran@maker.test', password: 'Kiran-own-pass-2026' });
  assert.equal(li2.status, 200);
  S.vt = bearer(li2.data.token);
  const me = await s.get('/api/vendor/me', S.vt);
  assert.equal(me.status, 200); assert.equal(me.data.addresses.length, 1); assert.ok(Array.isArray(me.data.users) && Array.isArray(me.data.bankAccounts));
});

test('the vendor adds its own factory, bank account and a team sign-in; another vendor cannot see them', async () => {
  assert.equal((await s.post('/api/vendor/addresses', { type: 'factory', line1: 'Unit 2', city: 'Maddur', pincode: '571428', stateId: S.ka }, S.vt)).status, 201);
  const ba = await s.post('/api/vendor/bank-accounts', { accountName: 'Mandya Cane Products', accountNo: '123456789012', ifsc: 'HDFC0001234' }, S.vt);
  assert.equal(ba.status, 201); S.bank = ba.data.bankAccountId;
  const tm = await s.post('/api/vendor/users', { name: 'Meena', email: 'meena@maker.test', mobile: '9876500005', role: 'dispatch' }, S.vt);
  assert.equal(tm.status, 201); assert.ok(tm.data.temporaryPassword);
  const reg = await s.post('/api/vendor/register', { legalName: 'Wholesale Mart', gstin: gstin('29', 'AAACW1234F'), capabilities: ['supplier_wholesaler', 'authorised_distributor'],
    address: { type: 'registered', line1: 'APMC Yard', city: 'Hubballi', pincode: '580029', stateId: S.ka }, user: { name: 'W', email: 'w@sup.test', mobile: '9876500002', password: 'Supplier-pass-1234' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data)); S.v2 = reg.data.vendorId;
  assert.equal(await num('SELECT COUNT(*) FROM b2b_vendor_capabilities WHERE vendor_id = ?', [S.v2]), 2);
  const w = bearer((await s.post('/api/vendor/auth/login', { email: 'w@sup.test', password: 'Supplier-pass-1234' })).data.token);
  const other = await s.get('/api/vendor/me', w);
  assert.equal(other.data.addresses.length, 1, 'only its own address');
  assert.equal((await s.del('/api/vendor/addresses/' + (await c.db.queryOne("SELECT id FROM b2b_vendor_addresses WHERE vendor_id = ? AND address_type = 'factory'", [S.v])).id, w)).status, 404);
  // a dispatch user cannot manage the team or the bank
  const meena = await c.db.queryOne("SELECT id FROM b2b_vendor_users WHERE email = 'meena@maker.test'");
  await c.db.query('UPDATE b2b_vendor_users SET must_change_password = 0 WHERE id = ?', [meena.id]);
  const mt = bearer((await s.post('/api/vendor/auth/login', { email: 'meena@maker.test', password: tm.data.temporaryPassword })).data.token);
  assert.equal((await s.get('/api/vendor/users', mt)).status, 403);
  assert.equal((await s.post('/api/vendor/bank-accounts', { accountName: 'X', accountNo: '999999999999', ifsc: 'HDFC0001234' }, mt)).status, 403);
});

test('the admin record has everything; bank verification is maker-checker; edits and capability decisions are audited', async () => {
  const d = await s.get('/api/erp/vendors/' + S.v, S.pm.h);
  assert.equal(d.status, 200);
  assert.equal(d.data.users.length, 2); assert.equal(d.data.addresses.length, 2); assert.equal(d.data.bankAccounts[0].accountMasked, 'XXXX9012');
  assert.ok(!JSON.stringify(d.data).includes('123456789012'), 'the full account number is never sent');
  // staff-added account: the adder cannot verify it; the vendor-added one can be verified by finance
  const staffBank = await s.post('/api/erp/vendors/' + S.v + '/bank-accounts', { accountName: 'Mandya Cane', accountNo: '222233334444', ifsc: 'ICIC0000001' }, S.pm.h);
  assert.equal(staffBank.status, 201);
  const self = await s.post('/api/erp/vendors/' + S.v + '/bank-accounts/' + staffBank.data.bankAccountId + '/verify', { status: 'verified' }, S.pm.h);
  assert.ok(self.status === 403, JSON.stringify(self.data));
  const v1 = await s.post('/api/erp/vendors/' + S.v + '/bank-accounts/' + S.bank + '/verify', { status: 'verified' }, c.checker.h);
  assert.equal(v1.status, 200, JSON.stringify(v1.data));
  const ed = await s.put('/api/erp/vendors/' + S.v, { tradeName: 'Mandya Cane', paymentTermsDays: 45, reason: 'Agreed new terms' }, S.pm.h);
  assert.equal(ed.status, 200);
  assert.equal(await num("SELECT COUNT(*) FROM b2b_audit_logs WHERE action = 'vendor.updated' AND entity_id = ?", [String(S.v)]), 1);
  assert.equal((await s.post('/api/erp/vendors/' + S.v + '/capabilities', { capability: 'manufacturer', status: 'approved' }, c.maker.h)).status, 409, 'not before the business is approved');
  const rs = await s.post('/api/erp/vendors/' + S.v + '/users/' + (await c.db.queryOne("SELECT id FROM b2b_vendor_users WHERE email = 'kiran@maker.test'")).id + '/reset-password', {}, S.pm.h);
  assert.equal(rs.status, 200); assert.ok(rs.data.temporaryPassword);
  assert.equal((await s.get('/api/vendor/me', S.vt)).status, 401, 'the reset ended the old session');
  // the list finds it by owner e-mail and filters by capability
  const l = await s.get('/api/erp/vendors?q=kiran%40maker&capability=contract_manufacturer', S.pm.h);
  assert.equal(l.data.items.length, 1); assert.equal(l.data.items[0].owner.email, 'kiran@maker.test');
  // a delivery driver sees none of it
  assert.equal((await s.get('/api/erp/vendors', S.drv.h)).status, 403);
  assert.equal((await s.post('/api/erp/vendors', { legalName: 'X' }, S.drv.h)).status, 403);
});

test('salesmen: list with numbers, detail, update with the cash-in-hand rule, and the salesman\'s own dashboard', async () => {
  S.t1 = Number((await c.db.query("INSERT INTO b2b_territories (code, name, level, state_id, created_by) VALUES ('BLR-S', 'Bengaluru South', 'area', ?, ?)", [S.ka, c.maker.id])).insertId);
  S.sm = await c.person('salesguy', [{ code: 'salesman', scopeType: 'territory', scopeId: S.t1 }]);
  const lk = await s.get('/api/erp/sales/salesmen/lookups', c.maker.h);
  assert.equal(lk.status, 200); assert.ok(lk.data.staff.some(x => x.id === S.sm.id && x.hasSalesmanRole));
  const add = await s.post('/api/erp/sales/salesmen', { staffId: S.sm.id, employeeCode: 'SM-01', homeTerritoryId: S.t1, cashLimit: '5000' }, c.maker.h);
  assert.equal(add.status, 201, JSON.stringify(add.data)); S.smId = add.data.salesmanId;
  const list = await s.get('/api/erp/sales/salesmen', S.sales.h);
  assert.equal(list.status, 200);
  const row = list.data.items.find(x => x.id === S.smId);
  assert.equal(row.territory, 'Bengaluru South'); assert.equal(row.numbers.cashInHand, 0);
  const det = await s.get('/api/erp/sales/salesmen/' + S.smId, S.sales.h);
  assert.equal(det.status, 200); assert.equal(det.data.salesman.employeeCode, 'SM-01');
  // cash that was not handed over blocks switching off
  const payer = Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, contact_person, mobile, address_line1, city, district_name, pincode, state_id, approved_at) " +
    "VALUES ('retailer', 'approved', 'Cash Shop', 'Owner', '9845066666', 'x', 'Bengaluru', 'Bengaluru Urban', '560001', ?, UTC_TIMESTAMP())", [S.ka])).insertId);
  await c.db.query("INSERT INTO b2b_payments (receipt_no, payer_account_id, method, amount, status, collected_by_salesman_id, received_at) VALUES ('RC-T-1', ?, 'cash', 1500.00, 'pending', ?, UTC_TIMESTAMP())", [payer, S.smId]);
  const off = await s.put('/api/erp/sales/salesmen/' + S.smId, { active: false }, c.maker.h);
  assert.equal(off.status, 409); assert.equal(off.data.code, 'cash_in_hand');
  assert.equal((await s.put('/api/erp/sales/salesmen/' + S.smId, { cashLimit: 8000 }, S.sales.h)).status, 403, 'sales managers cannot change salesman settings');
  assert.equal((await s.put('/api/erp/sales/salesmen/' + S.smId, { cashLimit: 8000 }, c.maker.h)).status, 200);
  const dash = await s.get('/api/sales/dashboard', S.sm.h);
  assert.equal(dash.status, 200, JSON.stringify(dash.data));
  assert.equal(dash.data.cashInHand, 1500); assert.equal(dash.data.cashLimit, 8000); assert.equal(dash.data.overCashLimit, false);
  assert.equal((await s.get('/api/sales/dashboard', S.drv.h)).status, 403, 'only salesmen');
});

test('delivery summary: counts and the delivery staff list; drivers cannot open it', async () => {
  const r = await s.get('/api/erp/deliveries/summary', c.maker.h);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.staff.some(p => p.id === S.drv.id));
  for (const k of ['open', 'late', 'deliveredToday', 'failedToday', 'waitingForShipment', 'unassignedOwnVehicle']) assert.equal(typeof r.data[k], 'number', k);
  assert.equal((await s.get('/api/erp/deliveries/summary', S.drv.h)).status, 403);
});
