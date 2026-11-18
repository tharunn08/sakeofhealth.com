/**
 * One sign-in with real ERP staff rows — MySQL 8 TEST database only (same rules
 * as erp-foundation: the database name must end in _test/_dev/_local and is
 * wiped). NOT runnable without MySQL; refuses while migrations 013/014 are
 * present (D5). Checks what the DB-free tests can only check with a test double.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, bearer } = require('./helpers/server.js');
const { TEST_DB, resetDatabase, db } = require('./helpers/db.js');

const ERP_SECRET = 'test-erp-secret-not-for-production-0123456789';
process.env.ERP_JWT_SECRET = ERP_SECRET;
const security = require('../src/modules/erp/core/security.js');
const loader = require('../src/modules/erp/catalog/load.js');

let s;
async function addStaff(name, email, pw, role) {
  const r = await db.query('INSERT INTO b2b_staff (name, email, password_hash) VALUES (?, ?, ?)', [name, email, security.hashPassword(pw)]);
  if (role) {
    const ro = await db.queryOne('SELECT id FROM b2b_roles WHERE code = ?', [role]);
    await db.query("INSERT INTO b2b_staff_roles (staff_id, role_id, scope_type) VALUES (?, ?, 'all')", [r.insertId, ro.id]);
  }
  return Number(r.insertId);
}
const failedLogins = async (email) => Number((await db.queryOne('SELECT failed_logins FROM b2b_staff WHERE email = ?', [email])).failed_logins);

test.before(async () => {
  await resetDatabase();
  await db.transaction(function (tx) { return loader.apply(tx); });
  await addStaff('Erp Only', 'erponly@test.local', 'Erp-only-password-1', 'super_admin');
  await addStaff('Both Stores', 'admin@test.local', 'A-different-erp-pw-2', 'super_admin');   // same e-mail as the shop admin
  s = await startServer(Object.assign({}, TEST_DB, { B2B_ENABLED: 'true', ERP_ENABLED: 'true', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123', ERP_JWT_SECRET: ERP_SECRET, ERP_WORKER_INTERVAL_MS: '3600000' }));
});
test.after(async () => { if (s) await s.stop(); await db.close(); });

test('ERP-only staff sign in at /login and get their ERP screens in the one sidebar', async () => {
  const r = await s.post('/api/platform/auth/login', { email: 'erponly@test.local', password: 'Erp-only-password-1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const w = r.data.workspaces[0];
  assert.equal(w.token, null);
  assert.ok(w.erpToken);
  const nav = await s.get('/api/platform/nav', { 'X-ERP-Token': w.erpToken });
  assert.equal(nav.status, 200);
  const items = nav.data.groups.flatMap(g => g.items);
  assert.ok(items.length > 0 && items.every(i => i.module === 'erp'));
  assert.ok(items.some(i => i.id === 'erp-vendors'), 'super_admin sees the supplier screen');
  assert.equal((await s.get('/api/erp/core/me', bearer(w.erpToken))).status, 200, 'the token works on the ERP API');
});

test('shop password accepted, ERP password different → no ERP failure counted, no lockout', async () => {
  for (let i = 0; i < 7; i++) {
    const r = await s.post('/api/platform/auth/login', { email: 'admin@test.local', password: 'Test@12345' });
    assert.equal(r.status, 200);
    assert.equal(r.data.workspaces[0].erpToken, null);
  }
  assert.equal(await failedLogins('admin@test.local'), 0);
  const erp = await s.post('/api/erp/core/login', { email: 'admin@test.local', password: 'A-different-erp-pw-2' });
  assert.equal(erp.status, 200, 'ERP account not locked');
});

test('a password wrong everywhere is still counted toward the ERP lockout', async () => {
  await s.post('/api/platform/auth/login', { email: 'erponly@test.local', password: 'wrong-wrong-wrong' });
  assert.equal(await failedLogins('erponly@test.local'), 1);
});
