/**
 * Shared identity, increment 1 — DB-free parts:
 *  - the 15 initial role accounts (plan, passwords, refusals, report);
 *  - one sign-in for all five account stores (orchestration; MySQL stores as test doubles);
 *  - forced password change for shop/trade staff, end to end on a real server.
 * The MySQL parts (seeding into a database, portal/supplier/ERP enforcement)
 * are in tests/identity-seed.mysql.test.js (needs MySQL 8; not run here).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer, bearer } = require('./helpers/server.js');
const seed = require('../scripts/seed-accounts.js');
const { signIn, newPasswordProblem } = require('../src/platform/auth.js');
const ROOT = path.join(__dirname, '..');

/* ── The 15 accounts ── */
test('15 role accounts, one each, with distinct e-mail-style logins mapped to existing roles', () => {
  assert.strictEqual(seed.PLAN.length, 15);
  const want = ['Super Admin', 'Admin', 'Manager', 'Finance', 'Inventory Manager', 'Procurement Manager', 'Support Staff', 'Sales Manager',
    'Salesman', 'Manufacturer', 'Supplier', 'Distributor', 'Retailer', 'Quality Control Staff', 'Warehouse Staff'];
  assert.deepStrictEqual(seed.PLAN.map(p => p.role), want);
  const emails = seed.PLAN.map(seed.emailOf);
  assert.strictEqual(new Set(emails).size, 15);
  emails.forEach(e => assert.match(e, /^[a-z.]+@sakeofhealth\.local$/));
  const ref = require('../src/modules/erp/catalog/reference-data.json');
  const roles = new Set(ref.roles.map(r => r.code)), perms = new Set(ref.permissions.map(p => p.code));
  seed.PLAN.filter(p => p.erp).forEach(p => assert.ok(roles.has(p.erp), 'ERP role exists: ' + p.erp));
  ref.roles.find(r => r.code === 'quality_control').permissions.forEach(c => assert.ok(perms.has(c), 'QC uses existing permission ' + c));
  const shopRoles = fs.readFileSync(path.join(ROOT, 'src/routes/admin.js'), 'utf8').match(/const STAFF_ROLES = \[([^\]]+)\]/)[1];
  seed.PLAN.filter(p => p.shop).forEach(p => assert.ok(shopRoles.includes("'" + p.shop + "'"), 'shop role exists: ' + p.shop));
  seed.PLAN.forEach(p => assert.ok(p.shop || p.erp || p.vendor || p.business, p.role + ' opens something'));
});

test('temporary passwords: 20 characters, all four character kinds, all different, never weak', () => {
  const pws = Object.values(seed.passwordsFor(seed.PLAN));
  assert.strictEqual(new Set(pws).size, 15);
  pws.forEach(pw => {
    assert.strictEqual(pw.length, 20);
    assert.match(pw, /[A-Z]/); assert.match(pw, /[a-z]/); assert.match(pw, /[2-9]/); assert.match(pw, /[!@#%*\-_=+?]/);
    assert.doesNotMatch(pw, /[O0Il1]/, 'no look-alike characters');
    assert.doesNotMatch(pw.toLowerCase(), /admin|password|123|sake/);
  });
  const many = new Set(); for (let i = 0; i < 2000; i++) many.add(seed.newPassword());
  assert.strictEqual(many.size, 2000, 'no repeats in 2000 draws');
  // a repeated draw is redrawn: this generator repeats the first password once, then varies
  // (one password takes 39 random draws; the first two passwords come out identical, the third differs)
  let calls = 0;
  const pw = seed.passwordsFor(seed.PLAN.slice(0, 2), n => (calls++ < 78 ? 0 : calls % n));
  assert.ok(calls > 78, 'the duplicate was drawn and rejected');
  assert.notStrictEqual(pw.superadmin, pw.admin, 'a repeated password is redrawn');
  // a broken random source that always repeats stops with an error instead of looping or reusing
  assert.throws(() => seed.passwordsFor(seed.PLAN.slice(0, 2), () => 0), /keeps repeating/);
});

const OK_ENV = { DB_NAME: 'sakeofhealth_local', DB_USER: 'soh_local', DATA_DIR: '/x/trial', B2B_ENABLED: 'true', ERP_ENABLED: 'true' };
const CLEAN = ['001_core_schema.sql', '012_finance.js', '015_identity_bootstrap.js'];
const EMPTY_DIR = { isDefault: false, orders: 0, customers: 0 };
test('seeding refuses production, live data, non-trial databases, root, and 013/014', () => {
  assert.deepStrictEqual(seed.preflight(OK_ENV, CLEAN, EMPTY_DIR), []);
  const bad = (env, files, dir, re) => assert.match(seed.preflight(Object.assign({}, OK_ENV, env), files || CLEAN, dir || EMPTY_DIR).join(' | '), re);
  bad({ NODE_ENV: 'production' }, null, null, /production/);
  for (const n of ['sakeofhealth', 'sakeofhealth_dev', 'sakeofhealth_test', 'sakeofhealth_local_copy', '']) bad({ DB_NAME: n }, null, null, /_local/);
  bad({ DB_USER: 'root' }, null, null, /not root/);
  bad({}, CLEAN.concat(['013_erp_governance.js']), null, /D5/);
  bad({ DATA_DIR: '' }, null, null, /trial data folder/);
  bad({}, null, { isDefault: true, orders: 0, customers: 0 }, /default live-data folder/);
  bad({}, null, { isDefault: false, orders: 3, customers: 1 }, /3 order\(s\) and 1 customer/);
  bad({ ERP_ENABLED: 'false' }, null, null, /ERP_ENABLED/);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-'));
  fs.writeFileSync(path.join(d, 'orders.json'), JSON.stringify([{ id: 1 }, { id: 2 }]));
  assert.deepStrictEqual(seed.inspectDataDir(d), { isDefault: false, orders: 2, customers: 0 });
  assert.strictEqual(seed.inspectDataDir(path.join(os.homedir(), 'sakeofhealth-data')).isDefault, true);
});

test('credentials report: every role, temporary password or "exists — unchanged", and no mailbox claimed', () => {
  const rows = seed.PLAN.map(p => ({ n: p.n, role: p.role, email: seed.emailOf(p), password: p.n === 2 ? null : 'Pw-' + p.n + '-xxxxxxxxxxxxx', opens: seed.opensFor(p) }));
  const t = seed.reportText(rows, { db: 'sakeofhealth_local', dataDir: '/x/trial', at: 'now', port: 3000 });
  seed.PLAN.forEach(p => assert.ok(t.includes(seed.emailOf(p)) && t.includes(p.role)));
  assert.match(t, /admin@sakeofhealth\.local\s+\(exists — unchanged\)/);
  assert.match(t, /no e-mail inbox exists/);
  assert.match(t, /must choose a new password at its first sign-in/);
  assert.match(seed.opensFor(seed.PLAN[8]), /Field sales app/);
});

test('credentials never land in the project: default folder outside it, report files ignored by git', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/seed-accounts.js'), 'utf8');
  assert.match(src, /path\.join\(os\.homedir\(\), 'sakeofhealth-private'\)/);
  assert.match(src, /CREDENTIALS_DIR must be outside the project folder/);
  assert.ok(seed.insideProject(ROOT, ROOT) && seed.insideProject(path.join(ROOT, 'private'), ROOT), 'project folder and its subfolders refused');
  assert.ok(!seed.insideProject(path.join(os.homedir(), 'sakeofhealth-private'), ROOT) && !seed.insideProject(ROOT + '-private', ROOT));
  assert.ok(seed.insideProject('C:\\Users\\T\\SOH\\Private', 'c:\\users\\t\\soh', 'win32'), 'Windows paths compared case-insensitively');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^local-credentials-\*\.txt$/m);
  assert.doesNotMatch(src, /password\s*[:=]\s*['"][A-Za-z0-9!@#%*\-_=+?]{12,}['"]/, 'no hard-coded password');
  const doc = fs.readFileSync(path.join(ROOT, 'docs/phase-1/LOCAL-TRIAL-ON-WINDOWS.txt'), 'utf8');
  assert.doesNotMatch(doc, /ON \*\.\*/, 'trial account gets no global rights');
  assert.match(doc, /GRANT ALL PRIVILEGES ON sakeofhealth_local\.\* TO 'soh_local'@'127\.0\.0\.1';/);
  assert.match(doc, /no inbox exists/);
});

/* ── One sign-in, five stores (MySQL stores as doubles) ── */
const NO = () => ({ ok: false });
const fail = (status, code) => async () => { throw Object.assign(new Error(code || 'x'), { status, code, expose: true }); };
function rec(result) { const calls = []; const f = async (...a) => { calls.push(a[a.length - 1].countFailure); if (result instanceof Error) throw result; return result; }; f.calls = calls; return f; }
const input = { email: 'p@x.y', password: 'pw-1234567890' };

test('sign-in: retailer, supplier and salesman workspaces, each stored where its app expects it', async () => {
  const r = await signIn(input, {
    staff: NO, customer: NO,
    erp: async () => ({ token: 'e', staff: { id: 1, name: 'S', email: 'p@x.y' }, isSalesman: true }),
    business: async () => ({ token: 'b', user: { id: 2, name: 'R', email: 'p@x.y', role: 'retailer' } }),
    supplier: async () => ({ token: 'v', user: { id: 3, name: 'V', email: 'p@x.y' } }),
  });
  assert.deepStrictEqual(r.body.workspaces.map(w => [w.type, w.home]),
    [['admin', '/admin'], ['sales', '/sales-app/'], ['business', '/b2b/dashboard'], ['supplier', '/vendor-portal/']]);
});

test('sign-in: a temporary password on any opened account → mustChangePassword', async () => {
  const r = await signIn(input, { staff: NO, customer: NO, business: async () => ({ token: 'b', user: { role: 'distributor' }, mustChangePassword: true }) });
  assert.strictEqual(r.body.mustChangePassword, true);
  assert.strictEqual(r.body.workspaces[0].mustChangePassword, true);
  const s = await signIn(input, { staff: () => ({ ok: true, token: 't', user: { role: 'admin' }, mustChangePassword: true }), customer: NO });
  assert.strictEqual(s.body.mustChangePassword, true);
});

test('sign-in lockout rule across three MySQL stores: accepted anywhere → none counted; wrong everywhere → each counted once', async () => {
  const e = rec(Object.assign(new Error('bad'), { status: 401, expose: true })), b = rec(Object.assign(new Error('bad'), { status: 401 }));
  const v = rec({ token: 'v', user: {} });
  await signIn(input, { staff: NO, customer: NO, erp: (em, pw, t, o) => e(o), business: (em, pw, o) => b(o), supplier: (em, pw, o) => v(o) });
  assert.deepStrictEqual([e.calls, b.calls, v.calls], [[false], [false], [false]]);
  const e2 = rec(Object.assign(new Error('bad'), { status: 401 })), b2 = rec(Object.assign(new Error('bad'), { status: 401 })), v2 = rec(Object.assign(new Error('bad'), { status: 401 }));
  const r = await signIn(input, { staff: NO, customer: NO, erp: (em, pw, t, o) => e2(o), business: (em, pw, o) => b2(o), supplier: (em, pw, o) => v2(o) });
  assert.deepStrictEqual([e2.calls, b2.calls, v2.calls], [[false, true], [false, true], [false, true]]);
  assert.strictEqual(r.status, 401);
});

test('sign-in: a disabled or locked business login is reported only when nothing else opened', async () => {
  assert.strictEqual((await signIn(input, { staff: NO, customer: NO, business: fail(403) })).status, 403);
  assert.strictEqual((await signIn(input, { staff: NO, customer: NO, business: fail(429) })).status, 423);
  assert.strictEqual((await signIn(input, { staff: () => ({ ok: true, token: 't', user: {} }), customer: NO, business: fail(429) })).status, 200);
});

test('new password rule: 12+ characters, letters and a number, not the temporary one', () => {
  assert.match(newPasswordProblem('Old-temporary-1', 'short1'), /12/);
  assert.match(newPasswordProblem('Old-temporary-1', 'Old-temporary-1'), /different/);
  assert.match(newPasswordProblem('x', 'onlyletterspassword'), /number/);
  assert.strictEqual(newPasswordProblem('Old-temporary-1', 'My-own-garden-2027'), null);
});

/* ── Forced change for shop/trade staff, on a real server ── */
const ip = () => '10.4.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
const X = () => ({ 'X-Forwarded-For': ip() });
test('shop/trade staff with a temporary password: every admin API refuses until it is changed at /login', async (t) => {
  const DOWN_DB = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASSWORD: 'x', DB_NAME: 'nothing' };
  const s = await startServer(Object.assign({ B2B_ENABLED: 'true', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123' }, DOWN_DB));
  t.after(() => s.stop());
  const root = (await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' }, X())).data.token;
  const TEMP = 'Temp-Pw-Abc-23456!';
  const c = await s.post('/api/admin/staff', { name: 'Seeded Manager', email: 'mgr@trial.local', phone: '9000000030', role: 'manager', password: TEMP }, Object.assign(bearer(root), X()));
  // what scripts/seed-accounts.js writes: the same record with mustChangePassword: true
  const file = path.join(s.dataDir, 'staff.json');
  fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).map(x => x.id === c.data.id ? Object.assign(x, { mustChangePassword: true }) : x)));

  const li = await s.post('/api/platform/auth/login', { email: 'mgr@trial.local', password: TEMP }, X());
  assert.strictEqual(li.status, 200);
  assert.strictEqual(li.data.mustChangePassword, true);
  const tok = li.data.workspaces[0].token;
  const blocked = await s.get('/api/admin/orders', Object.assign(bearer(tok), X()));
  assert.deepStrictEqual([blocked.status, blocked.data.code], [403, 'password_change_required']);
  const trade = await s.get('/api/admin/b2b/dashboard', Object.assign(bearer(tok), X()));
  assert.deepStrictEqual([trade.status, trade.data.code], [403, 'password_change_required'], 'trade admin API blocked too');
  assert.strictEqual((await s.get('/api/admin/orders', Object.assign(bearer(root), X()))).status, 200, 'root admin unaffected');

  assert.strictEqual((await s.post('/api/platform/auth/change-password', { email: 'mgr@trial.local', currentPassword: 'wrong-wrong-1', newPassword: 'My-own-garden-2027' }, X())).status, 401);
  assert.strictEqual((await s.post('/api/platform/auth/change-password', { email: 'mgr@trial.local', currentPassword: TEMP, newPassword: 'short1' }, X())).status, 400);
  const ch = await s.post('/api/platform/auth/change-password', { email: 'mgr@trial.local', currentPassword: TEMP, newPassword: 'My-own-garden-2027' }, X());
  assert.strictEqual(ch.status, 200, JSON.stringify(ch.data));
  assert.deepStrictEqual(ch.data.changed, ['staff']);
  assert.strictEqual(ch.data.mustChangePassword, undefined);
  assert.strictEqual((await s.get('/api/admin/orders', Object.assign(bearer(ch.data.workspaces[0].token), X()))).status, 200, 'works after the change');
  assert.strictEqual((await s.post('/api/platform/auth/login', { email: 'mgr@trial.local', password: TEMP }, X())).status, 401, 'temporary password no longer works');
  const rec2 = JSON.parse(fs.readFileSync(file, 'utf8')).find(x => x.id === c.data.id);
  assert.strictEqual(rec2.mustChangePassword, false);
  assert.ok(rec2.passwordChangedAt);
});
