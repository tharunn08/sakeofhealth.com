/**
 * The 15 initial role accounts, end to end — MySQL 8 TEST database only
 * (name must end in _test; its b2b_* tables are wiped). NOT runnable without
 * MySQL; refuses while migrations 013/014 are present (D5).
 *
 * Seeds with the real scripts/seed-accounts.js seed(), then: every role signs in
 * at /login, every app refuses until the temporary password is changed, the
 * change works everywhere, re-seeding changes nothing, and roles stay apart.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, bearer } = require('./helpers/server.js');
const { TEST_DB, resetDatabase, db } = require('./helpers/db.js');

const ERP_SECRET = 'test-erp-secret-not-for-production-0123456789';
process.env.ERP_JWT_SECRET = ERP_SECRET;
process.env.B2B_JWT_SECRET = 'test-b2b-secret-not-for-production-123';
const loader = require('../src/modules/erp/catalog/load.js');
const seedTool = require('../scripts/seed-accounts.js');

let s, rows, temp;
const ip = () => '10.7.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
const X = (h) => Object.assign({ 'X-Forwarded-For': ip() }, h || {});
const email = (id) => seedTool.emailOf(seedTool.PLAN.find(p => p.id === id));
const login = (id, pw) => s.post('/api/platform/auth/login', { email: email(id), password: pw || temp[id] }, X());
const ws = (r, type) => r.data.workspaces.find(w => w.type === type);
const NEW = (id) => 'Own-choice-' + id + '-2027';

test.before(async () => {
  await resetDatabase();
  await db.transaction(function (tx) { return loader.apply(tx); });
  s = await startServer(Object.assign({}, TEST_DB, { B2B_ENABLED: 'true', ERP_ENABLED: 'true', B2B_JWT_SECRET: process.env.B2B_JWT_SECRET, ERP_JWT_SECRET: ERP_SECRET, ERP_WORKER_INTERVAL_MS: '3600000' }));
  process.env.DATA_DIR = s.dataDir;          // the seed writes shop staff where this server reads them
  temp = seedTool.passwordsFor(seedTool.PLAN);
  rows = await seedTool.seed(process.env, temp, () => {});
});
test.after(async () => { if (s) await s.stop(); await db.close(); });

test('seed creates all 15 role accounts, each flagged to change its password', async () => {
  assert.equal(rows.length, 15);
  rows.forEach(r => assert.ok(r.password, r.role + ' was created'));
  for (const p of seedTool.PLAN) {
    const e = email(p.id);
    if (p.erp) assert.equal(Number((await db.queryOne('SELECT must_change_password m FROM b2b_staff WHERE email = ?', [e])).m), 1, p.role);
    if (p.vendor) assert.equal(Number((await db.queryOne('SELECT must_change_password m FROM b2b_vendor_users WHERE email = ?', [e])).m), 1, p.role);
    if (p.business) assert.equal(Number((await db.queryOne('SELECT must_change_password m FROM b2b_users WHERE email = ?', [e])).m), 1, p.role);
  }
  const staff = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'staff.json'), 'utf8'));
  seedTool.PLAN.filter(p => p.shop).forEach(p => assert.equal(staff.find(x => x.email === email(p.id)).mustChangePassword, true, p.role));
  const vendors = await db.query('SELECT legal_name FROM b2b_vendors');
  vendors.forEach(v => assert.match(v.legal_name, /^LOCAL TEST — not a real business/));
  const sm = await db.queryOne('SELECT COUNT(*) n FROM b2b_salesmen sm JOIN b2b_staff st ON st.id = sm.staff_id WHERE st.email = ?', [email('salesman')]);
  assert.equal(Number(sm.n), 1);
});

test('all 15 sign in at the one /login with their temporary password and are told to change it', async () => {
  for (const p of seedTool.PLAN) {
    const r = await login(p.id);
    assert.equal(r.status, 200, p.role + ': ' + JSON.stringify(r.data));
    assert.equal(r.data.mustChangePassword, true, p.role);
    const types = r.data.workspaces.map(w => w.type);
    if (p.shop || (p.erp && !p.salesman)) assert.ok(types.includes('admin'), p.role + ' opens the admin panel');
    if (p.salesman && !p.shop) assert.deepEqual(types, ['sales'], 'a salesman with only that role goes straight to the field app');
    if (p.shop) assert.ok(ws(r, 'admin').token, p.role + ' has the shop/trade session');
    if (p.erp && !p.salesman) assert.ok(ws(r, 'admin').erpToken, p.role + ' has the ERP session');
    if (p.salesman) assert.ok(ws(r, 'sales').token, 'the salesman has the field-app session');
    if (p.salesman) assert.ok(types.includes('sales'), 'salesman opens the field app');
    if (p.vendor) assert.deepEqual(types, ['supplier'], p.role);
    if (p.business) assert.deepEqual(types, ['business'], p.role);
  }
});

test('until the password is changed every app refuses (only "who am I" stays open)', async () => {
  const sup = ws(await login('superadmin'), 'admin');
  const blocked = async (res, what) => { const r = await res; assert.deepEqual([r.status, r.data.code], [403, 'password_change_required'], what); };
  await blocked(s.get('/api/admin/orders', X(bearer(sup.token))), 'shop admin API');
  await blocked(s.get('/api/erp/core/staff', X(bearer(sup.erpToken))), 'ERP API');
  assert.equal((await s.get('/api/erp/core/me', X(bearer(sup.erpToken)))).status, 200, 'ERP who-am-I open');
  const ret = ws(await login('retailer'), 'business');
  await blocked(s.get('/api/b2b/dashboard', X(bearer(ret.token))), 'business portal');
  assert.equal((await s.get('/api/b2b/me', X(bearer(ret.token)))).status, 200, 'portal who-am-I open');
  const man = ws(await login('manufacturer'), 'supplier');
  await blocked(s.get('/api/vendor/me', X(bearer(man.token))), 'supplier portal');
  const sal = ws(await login('salesman'), 'sales');
  await blocked(s.get('/api/sales/retailers', X(bearer(sal.token))), 'field sales app');
});

test('changing the password at /login works for every kind of account and the temporary one stops working', async () => {
  const cases = { superadmin: ['staff', 'erp'], retailer: ['business'], manufacturer: ['supplier'], salesman: ['erp'] };
  for (const [id, stores] of Object.entries(cases)) {
    const r = await s.post('/api/platform/auth/change-password', { email: email(id), currentPassword: temp[id], newPassword: NEW(id) }, X());
    assert.equal(r.status, 200, id + ': ' + JSON.stringify(r.data));
    assert.deepEqual([...r.data.changed].sort(), [...stores].sort(), id);
    assert.equal((await login(id)).status, 401, id + ' temporary password refused');
    assert.equal((await login(id, NEW(id))).data.mustChangePassword, undefined, id + ' no longer flagged');
  }
  const sup = ws(await login('superadmin', NEW('superadmin')), 'admin');
  assert.equal((await s.get('/api/admin/orders', X(bearer(sup.token)))).status, 200);
  assert.equal((await s.get('/api/erp/core/staff', X(bearer(sup.erpToken)))).status, 200);
  assert.equal((await s.get('/api/b2b/dashboard', X(bearer(ws(await login('retailer', NEW('retailer')), 'business').token)))).status, 200);
  assert.equal((await s.get('/api/vendor/me', X(bearer(ws(await login('manufacturer', NEW('manufacturer')), 'supplier').token)))).status, 200);
  assert.equal((await s.get('/api/sales/me', X(bearer(ws(await login('salesman', NEW('salesman')), 'sales').token)))).status, 200);
  assert.equal(Number((await db.queryOne('SELECT must_change_password m FROM b2b_users WHERE email = ?', [email('retailer')])).m), 0);
});

test('seeding again changes nothing: no new rows, no password reset, report says "unchanged"', async () => {
  const count = async t => Number((await db.queryOne('SELECT COUNT(*) n FROM ' + t)).n);
  const before = { staff: await count('b2b_staff'), vu: await count('b2b_vendor_users'), u: await count('b2b_users'), acc: await count('b2b_accounts'), v: await count('b2b_vendors'),
    hash: (await db.queryOne('SELECT password_hash h FROM b2b_staff WHERE email = ?', [email('superadmin')])).h,
    json: fs.readFileSync(path.join(s.dataDir, 'staff.json'), 'utf8') };
  const again = await seedTool.seed(process.env, seedTool.passwordsFor(seedTool.PLAN), () => {});
  again.forEach(r => assert.equal(r.password, null, r.role + ' left unchanged'));
  assert.deepEqual({ staff: await count('b2b_staff'), vu: await count('b2b_vendor_users'), u: await count('b2b_users'), acc: await count('b2b_accounts'), v: await count('b2b_vendors'),
    hash: (await db.queryOne('SELECT password_hash h FROM b2b_staff WHERE email = ?', [email('superadmin')])).h,
    json: fs.readFileSync(path.join(s.dataDir, 'staff.json'), 'utf8') }, before);
  assert.equal((await login('superadmin', NEW('superadmin'))).status, 200, 'the chosen password still works');
});

test('roles stay apart: each account reaches only its own app and permissions', async () => {
  for (const id of ['warehouse', 'quality', 'support']) {
    const r = await s.post('/api/platform/auth/change-password', { email: email(id), currentPassword: temp[id], newPassword: NEW(id) }, X());
    assert.equal(r.status, 200, id + ': ' + JSON.stringify(r.data));
  }
  const ret = ws(await login('retailer', NEW('retailer')), 'business').token;
  const man = ws(await login('manufacturer', NEW('manufacturer')), 'supplier').token;
  assert.equal((await s.get('/api/vendor/me', X(bearer(ret)))).status, 401, 'retailer token is not a supplier session');
  assert.equal((await s.get('/api/b2b/me', X(bearer(man)))).status, 401, 'supplier token is not a business session');
  assert.equal((await s.get('/api/erp/core/me', X(bearer(ret)))).status, 401, 'retailer token is not a staff session');
  const wh = ws(await login('warehouse', NEW('warehouse')), 'admin').erpToken;
  assert.equal((await s.get('/api/erp/core/staff', X(bearer(wh)))).status, 403, 'warehouse staff cannot list staff');
  assert.equal((await s.get('/api/sales/me', X(bearer(wh)))).status, 403, 'warehouse staff is not a salesman');
  const qc = ws(await login('quality', NEW('quality')), 'admin').erpToken;
  assert.equal((await s.get('/api/erp/core/staff', X(bearer(qc)))).status, 403, 'quality control cannot list staff');
  const sup = ws(await login('support', NEW('support')), 'admin').token;
  assert.equal((await s.post('/api/admin/staff', { name: 'x', email: 'x@y.z', phone: '9000000099', role: 'admin', password: 'Abcdefgh-12345' }, X(bearer(sup)))).status, 403, 'support staff cannot create staff');
  const nav = await s.get('/api/platform/nav', X({ 'X-ERP-Token': qc }));
  const items = nav.data.groups.flatMap(g => g.items).map(i => i.id);
  assert.ok(!items.includes('erp-staff') && !items.includes('erp-finance'), 'QC sidebar holds no staff or finance screens: ' + items.join(','));
});
