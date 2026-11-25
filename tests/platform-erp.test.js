/**
 * Central Admin Panel (2): the 32 ERP screens inside the one shell, ERP staff
 * through the one sign-in, ERP permissions in the one sidebar.
 * Written BEFORE the implementation. DB-free: the business database is
 * unreachable here, so ERP calls answer 503; everything that needs live ERP
 * staff rows is in tests/erp-federation.mysql.test.js (MySQL, not run here).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, bearer } = require('./helpers/server.js');

const ERP_SECRET = 'unit-test-erp-secret-0123456789abcdef';
process.env.ERP_JWT_SECRET = ERP_SECRET;           // so this process can sign a token the server accepts
const DOWN_DB = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASSWORD: 'x', DB_NAME: 'nothing' };
const ERP_ON = Object.assign({ B2B_ENABLED: 'true', ERP_ENABLED: 'true', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123', ERP_JWT_SECRET: ERP_SECRET }, DOWN_DB);
const ip = () => '10.5.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
const ROOT = path.join(__dirname, '..');

/** The ERP screens as the ERP code itself declares them: [id, label, permission]. */
function erpViewsFromSource() {
  const src = ['app.js', 'modules.js', 'operations.js', 'production.js', 'people.js', 'insights.js', 'home.js', 'enterprise.js'].map(f => fs.readFileSync(path.join(ROOT, 'erp-web/admin', f), 'utf8')).join('\n');
  return [...src.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', perm: '([a-z0-9._]+)', render:/g)].map(m => ({ id: m[1], label: m[2], perm: m[3] }));
}

let reg;
test.before(() => { reg = require('../src/platform/registry.js'); });

/* ── Registry ── */
test('all 32 ERP screens (18 + Notifications + shop stock, events, locations, offline sync, all customers + manufacturers, manufacturing orders, batch quality, bills of materials, trade deliveries + salesmen, delivery dashboard, delivery staff) are in the one registry with exactly the permission the ERP code requires', () => {
  const views = erpViewsFromSource();
  assert.strictEqual(views.length, 37, 'the ERP declares 37 screens (32 + Smart Insights + ERP Home + AI Assistant + Logos & Bills + My Work)');
  const erpPages = reg.PAGES.filter(p => p.module === 'erp');
  assert.strictEqual(erpPages.length, 37);
  erpPages.forEach(p => assert.ok(p.scripts.includes('/admin/erp/people.js'), p.id + ' loads the suppliers, salesmen and delivery screens'));
  erpPages.forEach(p => assert.ok(p.scripts.includes('/admin/erp/operations.js'), p.id + ' loads the operations screens'));
  erpPages.forEach(p => assert.ok(p.scripts.includes('/admin/erp/production.js'), p.id + ' loads the manufacturing and delivery screens'));
  for (const v of views) {
    const p = erpPages.find(x => x.view === v.id);
    assert.ok(p, 'registered: ' + v.id);
    assert.strictEqual(p.perm, v.perm, v.id + ' permission');
    assert.match(p.path, /^\/admin\/[a-z-]+\/[a-z-]+$/);
  }
  assert.strictEqual(new Set(reg.PAGES.map(p => p.path)).size, reg.PAGES.length, 'all addresses unique');
  assert.ok(reg.PAGES.filter(p => p.module === 'erp').every(p => reg.GROUPS.some(g => g.id === p.group)));
});

test('sidebar from ERP permissions: exactly the screens those permissions open', () => {
  const perms = new Set(['vendors.view', 'procurement.pr.view', 'inventory.view', 'core.self.view']);
  const nav = reg.navFor(null, true, { enabled: true, permissions: perms });
  const ids = nav.groups.flatMap(g => g.items).map(i => i.id).sort();
  const expected = reg.PAGES.filter(p => p.module === 'erp' && perms.has(p.perm)).map(p => p.id).sort();
  assert.deepStrictEqual(ids, expected, 'ERP-only staff: only their ERP screens');
  assert.strictEqual(nav.home, nav.groups[0].items[0].path);
  const both = reg.navFor('manager', true, { enabled: true, permissions: perms });
  const bothIds = both.groups.flatMap(g => g.items).map(i => i.id);
  assert.ok(bothIds.includes('orders') && bothIds.includes('erp-vendors'), 'shop + ERP pages in one sidebar');
  const off = reg.navFor('manager', true, { enabled: false, permissions: perms });
  assert.ok(off.groups.flatMap(g => g.items).every(i => i.module !== 'erp'), 'ERP off → no ERP items');
});

/* ── Federated sign-in (orchestration; ERP source as a test double) ── */
const { signIn } = (() => { try { return require('../src/platform/auth.js'); } catch (e) { return {}; } })();
const OK_STAFF = () => ({ ok: true, token: 'staff-token', user: { name: 'M', email: 'm@x.y', role: 'manager' } });
const NO = () => ({ ok: false });
function erpSource(result) {
  const calls = [];
  const fn = async (email, pw, totp, opts) => {
    calls.push({ totp, countFailure: opts.countFailure });
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = calls;
  return fn;
}
const err = (status, code, expose) => Object.assign(new Error(code || 'x'), { status, code, expose: expose !== false });
const input = (extra) => Object.assign({ email: 'm@x.y', password: 'pw-123456789' }, extra || {});

test('sign-in: staff + ERP with the same password → one admin workspace carrying both sessions', async () => {
  const erp = erpSource({ token: 'erp-token', staff: { id: 7, name: 'M', email: 'm@x.y' } });
  const r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.workspaces.length, 1);
  assert.deepStrictEqual([r.body.workspaces[0].type, r.body.workspaces[0].token, r.body.workspaces[0].erpToken], ['admin', 'staff-token', 'erp-token']);
});

test('sign-in: ERP-only staff land in the same admin panel', async () => {
  const r = await signIn(input(), { staff: NO, customer: NO, erp: erpSource({ token: 'erp-token', staff: { id: 7, name: 'Erp Only', email: 'm@x.y' } }) });
  const w = r.body.workspaces[0];
  assert.deepStrictEqual([w.type, w.token, w.erpToken, w.home], ['admin', null, 'erp-token', '/admin']);
  assert.strictEqual(w.user.name, 'Erp Only');
});

test('sign-in: an ERP account with two-factor on asks for the code; the code is passed through', async () => {
  const need = await signIn(input(), { staff: NO, customer: NO, erp: erpSource(err(401, 'mfa_required')) });
  assert.strictEqual(need.status, 401);
  assert.strictEqual(need.body.code, 'mfa_required');
  const erp = erpSource({ token: 'erp-token', staff: { id: 7, name: 'M', email: 'm@x.y' } });
  await signIn(input({ totp: '123456' }), { staff: NO, customer: NO, erp });
  assert.strictEqual(erp.calls[0].totp, '123456');
});

test('sign-in: staff password right but ERP code needed → admin opens now, ERP can be added with the code', async () => {
  const r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: erpSource(err(401, 'mfa_required')) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.erpNeedsCode, true);
  assert.strictEqual(r.body.workspaces[0].erpToken, null);
});

test('sign-in: a password accepted elsewhere is not counted as a failed ERP attempt; a wrong-everywhere one is', async () => {
  const e1 = erpSource(err(401, 'bad_credentials'));
  await signIn(input(), { staff: OK_STAFF, customer: NO, erp: e1 });
  assert.deepStrictEqual(e1.calls.map(c => c.countFailure), [false], 'accepted elsewhere: checked once, never counted');
  const e2 = erpSource(err(401, 'bad_credentials'));
  const r = await signIn(input(), { staff: NO, customer: NO, erp: e2 });
  assert.deepStrictEqual(e2.calls.map(c => c.countFailure), [false, true], 'wrong everywhere: re-checked with counting');
  assert.strictEqual(r.status, 401);
  assert.deepStrictEqual(r.body, { error: 'Incorrect e-mail or password.' });
});

test('sign-in: business database down → ERP skipped, shop sign-in still works; all down → 503', async () => {
  const down = () => erpSource(Object.assign(new Error('connect ECONNREFUSED'), { status: undefined }));
  const r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: down() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.erpUnavailable, true);
  const r2 = await signIn(input(), { staff: () => ({ ok: false, unavailable: true }), customer: () => ({ ok: false, unavailable: true }), erp: down() });
  assert.strictEqual(r2.status, 503);
});

test('sign-in: a locked ERP account says so only when nothing else accepted the password', async () => {
  const locked = () => erpSource(err(423, 'locked'));
  assert.strictEqual((await signIn(input(), { staff: NO, customer: NO, erp: locked() })).status, 423);
  assert.strictEqual((await signIn(input(), { staff: OK_STAFF, customer: NO, erp: locked() })).status, 200);
});

/* ── Running server: ERP on, business database unreachable ── */
let s, admin, erpToken;
test.after(() => s && s.stop());
test('server: ERP screens are served inside the shell (ERP on) and not at all (ERP off)', async (t) => {
  s = await startServer(ERP_ON);
  admin = (await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' }, { 'X-Forwarded-For': ip() })).data.token;
  erpToken = require('../src/modules/erp/core/security.js').sign({ sid: 1, tv: 0, mfa: false, ses: 'test' });
  for (const p of reg.PAGES.filter(x => x.module === 'erp')) {
    const r = await s.get(p.path);
    assert.strictEqual(r.status, 200, p.path);
    assert.match(r.data, /<script src="\/admin\/admin\.js/);
    assert.ok(r.data.includes('/admin/erp/app.js') && r.data.includes('/admin/erp/modules.js') && r.data.includes('/platform/erp-host.js'), p.path);
    assert.ok(r.data.includes('"view":"' + p.view + '"'), p.path + ' names its screen');
  }
  assert.strictEqual((await s.get('/platform/erp-host.js')).status, 200);
  assert.strictEqual((await s.get('/platform/erp-embed.css')).status, 200);
  const off = await startServer(Object.assign({}, ERP_ON, { ERP_ENABLED: 'false' }));
  t.after(() => off.stop());
  assert.strictEqual((await off.get(reg.PAGES.find(x => x.module === 'erp').path)).status, 404);
});

test('server: sidebar with an ERP session while the database is down → shop pages plus a clear "unavailable" flag', async () => {
  const r = await s.get('/api/platform/nav', Object.assign(bearer(admin), { 'X-ERP-Token': erpToken }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.erp, 'unavailable');
  assert.ok(r.data.groups.flatMap(g => g.items).every(i => i.module !== 'erp'));
  const only = await s.get('/api/platform/nav', { 'X-ERP-Token': erpToken });
  assert.strictEqual(only.status, 503, 'ERP-only session, database down');
  assert.strictEqual((await s.get('/api/platform/nav', { 'X-ERP-Token': 'forged.token' })).status, 401);
});

test('server: /login with ERP on and the database down still signs staff in (ERP skipped)', async () => {
  const r = await s.post('/api/platform/auth/login', { email: 'admin@test.local', password: 'Test@12345' }, { 'X-Forwarded-For': ip() });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.workspaces[0].type, 'admin');
  assert.strictEqual(r.data.workspaces[0].erpToken, null);
  assert.strictEqual(r.data.erpUnavailable, true);
});

test('ERP sign-in accepts "do not count this failure" only from the platform sign-in (signature check)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/modules/erp/core/identity.js'), 'utf8');
  assert.match(src, /async function login\(email, password, totp, ctx, opts\)/);
  assert.match(src, /countFailure/);
});
