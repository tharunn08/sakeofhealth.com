/**
 * Central Admin Panel — shared shell, single registry, one sidebar, one login.
 * Written BEFORE the implementation. DB-free: B2B pages are exercised with
 * B2B enabled and the database unreachable (their APIs answer 503 on their own).
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer, bearer } = require('./helpers/server.js');

const ip = () => '10.6.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
function spread(srv) {
  for (const m of ['post', 'patch', 'put']) { const f = srv[m]; srv[m] = (u, b, h) => f(u, b, Object.assign({ 'X-Forwarded-For': ip() }, h || {})); }
  for (const m of ['get', 'del']) { const f = srv[m]; srv[m] = (u, h) => f(u, Object.assign({ 'X-Forwarded-For': ip() }, h || {})); }
  return srv;
}
const DOWN_DB = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASSWORD: 'x', DB_NAME: 'nothing' };
const ROLES = ['admin', 'manager', 'staff', 'delivery', 'sales', 'finance'];

let s; const tok = {}; let reg;
test.before(async () => {
  s = spread(await startServer(Object.assign({ B2B_ENABLED: 'true', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123' }, DOWN_DB)));
  tok.admin = (await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token;
  for (const role of ROLES.slice(1)) {
    const c = await s.post('/api/admin/staff', { name: 'Shell ' + role, email: role + '@shell.test', phone: '9000000010', role, password: 'shell-pass-123' }, bearer(tok.admin));
    assert.ok(c.status === 201 || c.status === 200, role + ': ' + JSON.stringify(c.data));
    tok[role] = (await s.post('/api/admin/login', { email: role + '@shell.test', password: 'shell-pass-123' })).data.token;
  }
  reg = require('../src/platform/registry.js');
});
test.after(() => s && s.stop());

/* ── One registry, one URL scheme ── */
test('every existing B2C and B2B admin page is in the one registry, at /admin/<group>/<page>', () => {
  const ids = reg.PAGES.map(p => p.id);
  for (const id of ['dashboard', 'analytics', 'orders', 'deliveries', 'products', 'coupons', 'reviews', 'customers', 'staff', 'reports', 'settings',
    'b2b-dashboard', 'b2b-accounts', 'b2b-orders', 'b2b-catalogue', 'b2b-pricing', 'b2b-import', 'b2b-network', 'b2b-inventory', 'b2b-finance', 'b2b-reports', 'b2b-settings']) {
    assert.ok(ids.includes(id), 'registered: ' + id);
  }
  assert.strictEqual(new Set(reg.PAGES.map(p => p.path)).size, reg.PAGES.length, 'paths unique');
  reg.PAGES.forEach(p => assert.match(p.path, /^\/admin\/[a-z-]+\/[a-z-]+$/, p.path));
});

test('each registered page is served by the one shell with its page script', async () => {
  for (const p of reg.available(true, false)) {          // ERP screens: tests/platform-erp.test.js
    const r = await s.get(p.path);
    assert.strictEqual(r.status, 200, p.path);
    assert.match(r.data, /<script src="\/admin\/admin\.js/, p.path + ' uses the shared shell');
    p.scripts.forEach(src => assert.ok(r.data.includes(src), p.path + ' loads ' + src));
    assert.match(r.data, /<base href="\/admin\//, p.path + ' keeps relative links working');
  }
  assert.strictEqual((await s.get('/admin/orders/nope')).status, 404);
  assert.strictEqual((await s.get('/admin/nope/nope')).status, 404);
});

test('/admin opens the shell home; old page addresses keep working', async () => {
  const r = await fetch(s.base + '/admin', { redirect: 'manual' });
  assert.ok(r.status === 302 || r.status === 200);
  for (const old of ['/admin/orders.html', '/admin/dashboard.html', '/admin/b2b/orders.html']) {
    assert.strictEqual((await s.get(old)).status, 200, old);
  }
});

/* ── One sidebar, filtered on the server ── */
async function nav(role) {
  const r = await s.get('/api/platform/nav', bearer(tok[role]));
  assert.strictEqual(r.status, 200, role + ' nav: ' + JSON.stringify(r.data));
  return r.data;
}
const items = n => n.groups.flatMap(g => g.items);

test('the sidebar needs a login', async () => {
  assert.strictEqual((await s.get('/api/platform/nav')).status, 401);
});

test('admin sees every module in one sidebar, grouped', async () => {
  const n = await nav('admin');
  const ids = items(n).map(i => i.id);
  assert.strictEqual(ids.length, reg.available(true, false).length, 'all shop + trade pages (ERP is off in this server)');
  assert.ok(n.groups.length >= 6, 'grouped');
  assert.strictEqual(n.home, items(n)[0].path);
  assert.ok(n.groups.every(g => g.items.length > 0), 'no empty groups');
});

test('for every role, the sidebar shows exactly the pages whose data the server lets them open', async () => {
  const { allows } = require('../src/middleware/b2cPermissions.js');
  const rbac = require('../src/modules/b2b/rbac.js');
  for (const role of ROLES) {
    const shown = new Set(items(await nav(role)).map(i => i.id));
    for (const p of reg.available(true, false)) {        // ERP is off in this server
      const permitted = p.module === 'b2c'
        ? allows(role, p.api[0], p.api[1])
        : (p.perms.length ? p.perms.some(x => rbac.has(role, x)) : rbac.permissionsFor(role).length > 0);
      assert.strictEqual(shown.has(p.id), permitted, role + ' / ' + p.id + (permitted ? ' should be shown' : ' should be hidden'));
      if (p.module === 'b2c') {
        const r = await s.get(p.api[1].replace(/^/, '/api/admin'), bearer(tok[role]));
        assert.strictEqual(r.status === 403, !permitted, role + ' ' + p.api[1] + ' → ' + r.status);
      }
    }
  }
});

test('delivery agents get only their board; business-only roles get no shop pages', async () => {
  assert.deepStrictEqual(items(await nav('delivery')).map(i => i.id), ['deliveries']);
  const sales = items(await nav('sales'));
  assert.ok(sales.length > 0 && sales.every(i => i.module === 'b2b'), 'sales role: trade pages only');
});

test('with the business platform off, its pages are neither listed nor served', async (t) => {
  const off = spread(await startServer());
  t.after(() => off.stop());
  const a = (await off.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token;
  const n = (await off.get('/api/platform/nav', bearer(a))).data;
  assert.ok(items(n).length > 0 && items(n).every(i => i.module === 'b2c'));
  const b2bPage = reg.PAGES.find(p => p.module === 'b2b');
  assert.strictEqual((await off.get(b2bPage.path)).status, 404);
});

/* ── One login ── */
test('/login is one sign-in page for staff and shop customers', async () => {
  const r = await s.get('/login');
  assert.strictEqual(r.status, 200);
  assert.match(r.data, /<form/);
  assert.match(r.data, /\/api\/platform\/auth\/login/);
});

test('staff sign in at /login and land in the admin panel', async () => {
  const r = await s.post('/api/platform/auth/login', { email: 'manager@shell.test', password: 'shell-pass-123' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.workspaces.length, 1);
  const w = r.data.workspaces[0];
  assert.strictEqual(w.type, 'admin');
  assert.ok(w.token && w.user && w.user.role === 'manager');
  assert.strictEqual(w.home, '/admin');
  assert.strictEqual((await s.get('/api/platform/nav', bearer(w.token))).status, 200, 'the token works in the shell');
});

test('shop customers sign in at /login and land in their account', async () => {
  const su = await s.post('/api/auth/signup', { name: 'Shell Shopper', email: 'shopper@shell.test', phone: '9000000011', password: 'shopper-pass-1' });
  assert.ok(su.data && su.data.token, JSON.stringify(su.data));
  const r = await s.post('/api/platform/auth/login', { email: 'shopper@shell.test', password: 'shopper-pass-1' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.workspaces.map(w => [w.type, w.home]), [['customer', '/account.html']]);
  const tokenOk = await s.get('/api/auth/me', bearer(r.data.workspaces[0].token));
  assert.strictEqual(tokenOk.status, 200);
  assert.strictEqual((await s.get('/api/platform/nav', bearer(r.data.workspaces[0].token))).status, 401, 'a customer token never opens the admin panel');
});

test('someone who is both staff and a customer (same e-mail and password) chooses where to go', async () => {
  await s.post('/api/admin/staff', { name: 'Both', email: 'both@shell.test', phone: '9000000012', role: 'staff', password: 'both-pass-123' }, bearer(tok.admin));
  await s.post('/api/auth/signup', { name: 'Both', email: 'both@shell.test', phone: '9000000013', password: 'both-pass-123' });
  const r = await s.post('/api/platform/auth/login', { email: 'both@shell.test', password: 'both-pass-123' });
  assert.deepStrictEqual(r.data.workspaces.map(w => w.type).sort(), ['admin', 'customer']);
});

test('a wrong password gets one generic answer, whatever the account type', async () => {
  const a = await s.post('/api/platform/auth/login', { email: 'manager@shell.test', password: 'wrong-password' });
  const b = await s.post('/api/platform/auth/login', { email: 'nobody@shell.test', password: 'wrong-password' });
  assert.strictEqual(a.status, 401); assert.strictEqual(b.status, 401);
  assert.deepStrictEqual(a.data, b.data, 'no hint whether the e-mail exists');
});

test('/login is rate-limited like the admin login', async () => {
  const fixed = { 'X-Forwarded-For': '10.99.99.99' };
  let last;
  for (let i = 0; i < 12; i++) last = await fetch(s.base + '/api/platform/auth/login', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, fixed), body: JSON.stringify({ email: 'x@y.z', password: 'bad-pass' }) });
  assert.strictEqual(last.status, 429);
});

test('the old admin sign-in address now goes to /login', async () => {
  const r = await fetch(s.base + '/admin/index.html', { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/login');
});
