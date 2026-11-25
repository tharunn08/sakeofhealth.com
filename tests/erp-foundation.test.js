/**
 * ERP foundation — integration tests against a real MySQL 8 TEST database
 * (same rules as the existing B2B suites: the database name must end in _test,
 * _dev or _local and is wiped). Covers migration 004, login, lockout, session
 * revocation, permissions, MFA, maker-checker approvals, business settings,
 * the audit hash chain, background jobs and WhatsApp webhooks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, bearer } = require('./helpers/server.js');
const { TEST_DB, resetDatabase, db } = require('./helpers/db.js');

const ERP_SECRET = 'test-erp-secret-not-for-production-0123456789';
const WA_SECRET = 'whatsapp-app-secret-1234567890';
process.env.ERP_JWT_SECRET = ERP_SECRET;
const security = require('../src/modules/erp/core/security.js');
const loader = require('../src/modules/erp/catalog/load.js');
const jobs = require('../src/modules/erp/core/jobs.js');
const audit = require('../src/modules/erp/core/audit.js');
const migrate = require('../src/db/migrate.js');

let s;
const PW = { a: 'Alpha-super-admin-pw-1', b: 'Bravo-super-admin-pw-2', c: 'Charlie-staff-pw-3' };
const ids = {};

async function addStaff(name, email, pw, role) {
  const r = await db.query('INSERT INTO b2b_staff (name, email, password_hash) VALUES (?, ?, ?)', [name, email, security.hashPassword(pw)]);
  if (role) {
    const ro = await db.queryOne('SELECT id FROM b2b_roles WHERE code = ?', [role]);
    await db.query("INSERT INTO b2b_staff_roles (staff_id, role_id, scope_type) VALUES (?, ?, 'all')", [r.insertId, ro.id]);
  }
  return Number(r.insertId);
}
async function login(email, pw, totp) { return s.post('/api/erp/core/login', { email: email, password: pw, totp: totp }); }
async function secretOf(id) { return security.decrypt((await db.queryOne('SELECT mfa_secret_enc FROM b2b_staff WHERE id = ?', [id])).mfa_secret_enc); }
function nowCode(secret) { return security.totpAt(secret, Math.floor(Date.now() / 30000)); }
async function enableMfa(token, staffId) {
  assert.equal((await s.post('/api/erp/core/me/mfa/setup', {}, bearer(token))).status, 200);
  const r = await s.post('/api/erp/core/me/mfa/enable', { code: nowCode(await secretOf(staffId)) }, bearer(token));
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

test.before(async () => {
  await resetDatabase();                        // drops b2b_* in the TEST database and runs 001–004
  await db.transaction(function (tx) { return loader.apply(tx); });
  ids.a = await addStaff('Alpha Admin', 'alpha@test.local', PW.a, 'super_admin');
  ids.b = await addStaff('Bravo Admin', 'bravo@test.local', PW.b, 'super_admin');
  ids.c = await addStaff('Charlie Staff', 'charlie@test.local', PW.c, null);
  s = await startServer(Object.assign({}, TEST_DB, { B2B_ENABLED: 'true', ERP_ENABLED: 'true', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123',
    ERP_JWT_SECRET: ERP_SECRET, WHATSAPP_APP_SECRET: WA_SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me', ERP_WORKER_INTERVAL_MS: '3600000' }));
});
test.after(async () => { if (s) await s.stop(); await db.close(); });

test('migration 004: tables, added columns, idempotent re-run', async () => {
  const t = await db.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('b2b_staff','b2b_roles','b2b_permissions','b2b_role_permissions','b2b_staff_roles','b2b_approval_requests','b2b_approval_steps','b2b_approval_rules','b2b_jobs','b2b_integration_logs','b2b_monitor_events','b2b_webhook_events')");
  assert.equal(t.length, 12);
  const c = await db.query("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_audit_logs' AND COLUMN_NAME IN ('module','reason','approval_id','prev_hash','row_hash')");
  assert.equal(c.length, 5);
  const e = await db.queryOne("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_notification_queue' AND COLUMN_NAME = 'status'");
  assert.match(e.t, /'pending','sending','sent','failed','skipped_no_provider'/);
  assert.equal((await migrate.up()).applied.length, 0, 'second run applies nothing');
  const m4 = require('../src/db/migrations/004_core_governance.js');
  // Run on its own again, 004 either skips every change or — because migration 016 since added values to an
  // enum it created — refuses to shrink that enum. Either way nothing is changed.
  const before = (await db.queryOne("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_notification_queue' AND COLUMN_NAME = 'status'")).t;
  let again = null, refused = null;
  try { again = await db.withConnection(function (conn) { return m4.up(conn); }); } catch (e) { refused = e; }
  if (refused) assert.match(refused.message, /^Refused: extendEnum b2b_notification_queue\.status/, 'only the enum guard may refuse');
  else assert.equal(again.applied, 0, 'guarded changes are all skipped on a re-run');
  assert.equal((await db.queryOne("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_notification_queue' AND COLUMN_NAME = 'status'")).t, before, 'enum unchanged');
  assert.equal((await migrate.verify()).ok, true);
});

test('login: generic errors, lockout after 5 failures, success', async () => {
  const unknown = await login('nobody@test.local', 'whatever-password');
  const wrong = await login('charlie@test.local', 'wrong-password-123');
  assert.equal(unknown.status, 401); assert.equal(wrong.status, 401);
  assert.equal(unknown.data.error, wrong.data.error, 'same message for unknown e-mail and wrong password');
  const temp = await addStaff('Lock Test', 'lock@test.local', 'Lock-test-password-9', null);
  for (let i = 0; i < 5; i++) await login('lock@test.local', 'nope-nope-nope');
  assert.equal((await login('lock@test.local', 'Lock-test-password-9')).status, 423, 'locked even with the right password');
  const ok = await login('charlie@test.local', PW.c);
  assert.equal(ok.status, 200); assert.ok(ok.data.token);
  const me = await s.get('/api/erp/core/me', bearer(ok.data.token));
  assert.equal(me.status, 200); assert.deepEqual(me.data.roles, []);
  assert.equal((await s.get('/api/erp/core/staff', bearer(ok.data.token))).status, 403, 'no role → no access');
  const ev = await db.queryOne("SELECT COUNT(*) AS n FROM b2b_monitor_events WHERE code = 'erp_login_failed'");
  assert.ok(Number(ev.n) >= 6);
  assert.ok(temp);
});

test('MFA: enrolment ends the session; then the code is required at login', async () => {
  const t = (await login('alpha@test.local', PW.a)).data.token;
  await enableMfa(t, ids.a);
  assert.equal((await s.get('/api/erp/core/me', bearer(t))).status, 401, 'old session ended');
  const noCode = await login('alpha@test.local', PW.a);
  assert.equal(noCode.status, 401); assert.equal(noCode.data.code, 'mfa_required');
  assert.equal((await login('alpha@test.local', PW.a, '000000')).status, 401);
  const ok = await login('alpha@test.local', PW.a, nowCode(await secretOf(ids.a)));
  assert.equal(ok.status, 200);
  ids.tokenA = ok.data.token;
  assert.equal((await s.get('/api/erp/core/me', bearer(ids.tokenA))).data.mfa, true);
});

test('maker-checker: grant a role needs a different approver with MFA; sessions end on grant', async () => {
  // Every role through approval (the policy before 25 Nov 2026; still available as a setting).
  const pol = await s.put('/api/erp/core/security/role-assignment', { mode: 'approval', reason: 'maker-checker test' }, bearer(ids.tokenA));
  assert.equal(pol.status, 200, JSON.stringify(pol.data));
  const charlie = (await login('charlie@test.local', PW.c)).data.token;
  const auditor = await db.queryOne("SELECT id FROM b2b_roles WHERE code = 'auditor'");
  const req = await s.post('/api/erp/core/staff/' + ids.c + '/roles', { roleId: Number(auditor.id), scopeType: 'all', reason: 'New internal auditor' }, bearer(ids.tokenA));
  assert.equal(req.status, 202, JSON.stringify(req.data));
  assert.equal(req.data.ruleConfigured, false, 'no thresholds configured → fail-safe Super Admin approval');
  const dup = await s.post('/api/erp/core/staff/' + ids.c + '/roles', { roleId: Number(auditor.id), reason: 'Second request' }, bearer(ids.tokenA));
  assert.equal(dup.status, 409);
  const id = req.data.approvalId;
  const self = await s.post('/api/erp/core/approvals/' + id + '/decide', { decision: 'approved' }, bearer(ids.tokenA));
  assert.equal(self.status, 403); assert.equal(self.data.code, 'maker_cannot_check');
  assert.equal((await s.get('/api/erp/core/approvals', bearer(ids.tokenA))).data.items.length, 0, 'own requests are not in my queue');
  let tb = (await login('bravo@test.local', PW.b)).data.token;
  const noMfa = await s.post('/api/erp/core/approvals/' + id + '/decide', { decision: 'approved' }, bearer(tb));
  assert.equal(noMfa.status, 403); assert.equal(noMfa.data.code, 'mfa_required');
  await enableMfa(tb, ids.b);
  tb = (await login('bravo@test.local', PW.b, nowCode(await secretOf(ids.b)))).data.token;
  ids.tokenB = tb;
  assert.equal((await s.get('/api/erp/core/approvals', bearer(tb))).data.items.length, 1);
  const ok = await s.post('/api/erp/core/approvals/' + id + '/decide', { decision: 'approved', comment: 'ok' }, bearer(tb));
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.status, 'approved');
  assert.equal((await s.get('/api/erp/core/me', bearer(charlie))).status, 401, 'grant ended Charlie\'s old session');
  const c2 = (await login('charlie@test.local', PW.c)).data.token;
  assert.equal((await s.get('/api/erp/core/audit', bearer(c2))).status, 200, 'auditor can read the audit log');
  assert.equal((await s.post('/api/erp/core/staff', { name: 'X', email: 'x@test.local', password: 'Xxxxxxxxxxxx1' }, bearer(c2))).status, 403, 'auditor cannot create staff');
  const again = await s.post('/api/erp/core/approvals/' + id + '/decide', { decision: 'approved' }, bearer(tb));
  assert.equal(again.status, 409, 'a decided request cannot be decided again');
});

test('disabling a person ends their session immediately; re-enabling needs approval', async () => {
  const tmpId = await addStaff('Temp Person', 'temp@test.local', 'Temp-person-pw-123', 'customer_support');
  const tt = (await login('temp@test.local', 'Temp-person-pw-123')).data.token;
  assert.equal((await s.get('/api/erp/core/me', bearer(tt))).status, 200);
  assert.equal((await s.patch('/api/erp/core/staff/' + tmpId, { status: 'disabled', reason: 'Left the company' }, bearer(ids.tokenA))).status, 200);
  assert.equal((await s.get('/api/erp/core/me', bearer(tt))).status, 401);
  assert.equal((await login('temp@test.local', 'Temp-person-pw-123')).status, 401);
  const re = await s.patch('/api/erp/core/staff/' + tmpId, { status: 'active', reason: 'Came back' }, bearer(ids.tokenA));
  assert.equal(re.status, 200); assert.equal(re.data.status, 'pending');
  assert.equal((await db.queryOne('SELECT status FROM b2b_staff WHERE id = ?', [tmpId])).status, 'disabled', 'still disabled until approved');
});

test('one admin gives an ordinary role at once (direct policy); the Super Admin role still needs approval', async () => {
  const pol = await s.put('/api/erp/core/security/role-assignment', { mode: 'direct', approvalRoles: [], reason: 'owner brief 25 Nov' }, bearer(ids.tokenA));
  assert.equal(pol.status, 200, JSON.stringify(pol.data));
  const did = await addStaff('Dee Direct', 'dee@test.local', 'Dee-direct-password-4', null);
  const support = await db.queryOne("SELECT id FROM b2b_roles WHERE code = 'customer_support'");
  const g = await s.post('/api/erp/core/staff/' + did + '/roles', { roleId: Number(support.id), scopeType: 'all' }, bearer(ids.tokenA));
  assert.equal(g.status, 201, JSON.stringify(g.data)); assert.equal(g.data.status, 'granted');
  const row = await db.queryOne('SELECT granted_by FROM b2b_staff_roles WHERE staff_id = ? AND role_id = ? AND revoked_at IS NULL', [did, support.id]);
  assert.equal(Number(row.granted_by), ids.a);
  const sa = await db.queryOne("SELECT id FROM b2b_roles WHERE code = 'super_admin'");
  const up = await s.post('/api/erp/core/staff/' + did + '/roles', { roleId: Number(sa.id), scopeType: 'all' }, bearer(ids.tokenA));
  assert.equal(up.status, 202, JSON.stringify(up.data)); assert.ok(up.data.approvalId);
  const h = await s.get('/api/erp/core/staff/' + did + '/roles/history', bearer(ids.tokenA));
  assert.equal(h.status, 200); assert.equal(h.data.items[0].role, 'customer_support');
});

test('business decisions: no value until approved by someone else; then stored with who approved', async () => {
  const before = (await s.get('/api/erp/core/settings/pending-decisions', bearer(ids.tokenA))).data.items.find(function (x) { return x.key === 'inventory.grn.min_shelf_life_pct'; });
  assert.equal(before.value, null); assert.equal(before.status, 'pending_business_decision');
  assert.equal((await s.put('/api/erp/core/settings/inventory.grn.min_shelf_life_pct', { value: 150, reason: 'Board decision' }, bearer(ids.tokenA))).status, 400);
  const r = await s.put('/api/erp/core/settings/inventory.grn.min_shelf_life_pct', { value: 60, reason: 'Board decision 6 Nov' }, bearer(ids.tokenA));
  assert.equal(r.status, 202);
  assert.equal(await db.queryOne("SELECT setting_value FROM b2b_settings WHERE setting_key = 'erp.inventory.grn.min_shelf_life_pct'"), null, 'not applied before approval');
  const d = await s.post('/api/erp/core/approvals/' + r.data.approvalId + '/decide', { decision: 'approved' }, bearer(ids.tokenB));
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const row = await db.queryOne("SELECT setting_value, updated_by FROM b2b_settings WHERE setting_key = 'erp.inventory.grn.min_shelf_life_pct'");
  assert.equal(row.setting_value, '60'); assert.match(row.updated_by, /^erp-approval:\d+$/);
});

test('audit chain: intact, detects an edited row, recovers when the row is restored', async () => {
  const ok = await audit.verifyChain();
  assert.equal(ok.ok, true); assert.ok(ok.checked >= 8);
  const victim = await db.queryOne('SELECT id, reason FROM b2b_audit_logs WHERE row_hash IS NOT NULL ORDER BY id LIMIT 1 OFFSET 2');
  await db.query('UPDATE b2b_audit_logs SET reason = ? WHERE id = ?', ['edited by a test', victim.id]);   // simulates tampering (test DB only)
  const broken = await audit.verifyChain();
  assert.equal(broken.ok, false); assert.equal(broken.brokenAt, Number(victim.id));
  await db.query('UPDATE b2b_audit_logs SET reason = ? WHERE id = ?', [victim.reason, victim.id]);
  assert.equal((await audit.verifyChain()).ok, true);
  const api = await s.get('/api/erp/core/audit/verify', bearer(ids.tokenA));
  assert.equal(api.data.ok, true);
});

test('jobs: retries with back-off, then fails and raises a monitoring event; dedupe key', async () => {
  let calls = 0;
  jobs.register('test.flaky', async function () { calls++; throw new Error('boom'); });
  const j = await jobs.enqueue(null, 'test.flaky', {}, { maxAttempts: 2, dedupeKey: 'flaky-1' });
  assert.ok(j.jobId);
  assert.equal((await jobs.enqueue(null, 'test.flaky', {}, { dedupeKey: 'flaky-1' })).duplicate, true);
  // runDue skips while another run in this process is still going (a timer may have started one): retry until it runs.
  const runNow = async function () { for (let i = 0; i < 100; i++) { const r = await jobs.runDue(10); if (!r.skipped) return r; await new Promise((ok) => setTimeout(ok, 50)); } throw new Error('runDue never ran'); };
  const r1 = await runNow();
  await db.query('UPDATE b2b_jobs SET run_after = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ?', [j.jobId]);   // skip the back-off wait
  const r2 = await runNow();
  const row = await db.queryOne('SELECT status, attempts, max_attempts, last_error, run_after, UTC_TIMESTAMP() AS now FROM b2b_jobs WHERE id = ?', [j.jobId]);
  assert.equal(row.status, 'failed', JSON.stringify({ row: row, r1: r1, r2: r2, calls: calls })); assert.equal(Number(row.attempts), 2); assert.equal(calls, 2);
  assert.ok(await db.queryOne("SELECT id FROM b2b_monitor_events WHERE code = 'job_failed' AND ref_id = ?", [String(j.jobId)]));
});

test('WhatsApp webhook: signature, replay refused, status never moves backwards', async () => {
  await db.query("INSERT INTO b2b_notification_queue (channel, recipient, body, status, provider_message_id) VALUES ('whatsapp', '919800000000', 'hi', 'sent', 'wamid.T1')");
  const send = async function (status, ts, secret) {
    const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.T1', status: status, timestamp: String(ts) }] } }] }] }));
    const sig = 'sha256=' + crypto.createHmac('sha256', secret || WA_SECRET).update(body).digest('hex');
    const r = await fetch(s.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: body });
    return r.status;
  };
  const st = async function () { return (await db.queryOne("SELECT delivery_status AS d FROM b2b_notification_queue WHERE provider_message_id = 'wamid.T1'")).d; };
  assert.equal(await send('delivered', 1793900000, 'wrong-secret-xxxxxxxxxxxx'), 401);
  assert.equal(await st(), 'unknown');
  assert.equal(await send('read', 1793900100), 200); assert.equal(await st(), 'read');
  assert.equal(await send('read', 1793900100), 200);
  assert.equal(await send('delivered', 1793900050), 200); assert.equal(await st(), 'read', 'late older status ignored');
  const ev = await db.query("SELECT outcome FROM b2b_webhook_events WHERE provider = 'whatsapp_meta' ORDER BY id");
  assert.deepEqual(ev.map(function (e) { return e.outcome; }), ['bad_signature', 'processed', 'stale']);
  assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM b2b_webhook_events WHERE event_id = 'wamid.T1:read'")).n), 1, 'replay stored once');
});

test('existing B2B keeps working with migration 004 applied', async () => {
  const h = await s.get('/api/health');
  assert.equal(h.data.b2b.database, 'up');
  const admin = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' });
  assert.equal((await s.get('/api/admin/b2b/dashboard', bearer(admin.data.token))).status, 200);
  assert.equal((await s.get('/api/b2b/products')).status, 401, 'portal API alive and still guarded');
});
