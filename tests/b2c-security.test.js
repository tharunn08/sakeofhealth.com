/**
 * Phase 0.5 — B2C security tests (BUG-001 and related).
 * Written BEFORE the fixes; each test names the defect it guards against.
 * Every server here uses a throw-away data folder (tests/helpers/server.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer, bearer } = require('./helpers/server.js');
const { craft, adminRoutes, SECRETS } = require('./helpers/tokens.js');

const decode = t => JSON.parse(Buffer.from(String(t).split('.')[0], 'base64url').toString());
const GOOD = { ADMIN_JWT_SECRET: SECRETS.admin, CUSTOMER_JWT_SECRET: SECRETS.customer };

async function callRoute(s, r, token) {
  const h = bearer(token);
  if (r.method === 'GET') return s.get(r.path, h);
  if (r.method === 'DELETE') return s.del(r.path, h);
  if (r.method === 'POST') return s.post(r.path, {}, h);
  if (r.method === 'PUT') return s.put(r.path, {}, h);
  return s.patch(r.path, {}, h);
}

/* ── Correctly configured server ─────────────────────────────────────── */
test('auth: correctly configured secrets', async (t) => {
  const s = await startServer(GOOD);
  t.after(() => s.stop());

  const su = await s.post('/api/auth/signup', { email: 'shopper@test.local', password: 'shopper-pass-1', name: 'Shopper' });
  assert.strictEqual(su.status, 201, 'customer signup works');
  const customerToken = su.data.token;

  await t.test('customer tokens are typed "customer"', () => {
    assert.strictEqual(decode(customerToken).typ, 'customer');
  });

  await t.test('BUG-001: a customer token is refused (401) on every one of the 39 admin routes', async () => {
    const routes = adminRoutes();
    assert.strictEqual(routes.length, 39);   // 38 + POST /orders/:id/cancel (Phase 0.5.7)
    const leaks = [];
    for (const r of routes) {
      const res = await callRoute(s, r, customerToken);
      if (res.status !== 401) leaks.push(r.method + ' ' + r.path + ' → ' + res.status);
    }
    assert.deepStrictEqual(leaks, []);
  });

  await t.test('BUG-001: a "customer"-typed token signed with the ADMIN secret is refused by the admin API', async () => {
    const forged = craft({ sub: 'x', email: 'a@b.c', role: 'customer', typ: 'customer' }, SECRETS.admin);
    assert.strictEqual((await s.get('/api/admin/orders', bearer(forged))).status, 401);
  });

  await t.test('BUG-001: an untyped 30-day customer-style token signed with the ADMIN secret is refused', async () => {
    const legacyCustomer = craft({ sub: 'x', email: 'a@b.c', role: 'customer' }, SECRETS.admin, 30 * 24 * 3600 * 1000);
    assert.strictEqual((await s.get('/api/admin/orders', bearer(legacyCustomer))).status, 401);
  });

  await t.test('compatibility: an untyped staff token (≤12 h, staff role) issued before the hotfix still works until it expires', async () => {
    const legacyStaff = craft({ sub: 'root', email: 'admin@test.local', name: 'Administrator', role: 'admin' }, SECRETS.admin, 6 * 3600 * 1000);
    assert.strictEqual((await s.get('/api/admin/orders', bearer(legacyStaff))).status, 200);
  });

  await t.test('an untyped token whose lifetime exceeds the 12 h staff session is refused', async () => {
    const tooLong = craft({ sub: 'root', role: 'admin' }, SECRETS.admin, 48 * 3600 * 1000);
    assert.strictEqual((await s.get('/api/admin/orders', bearer(tooLong))).status, 401);
  });

  await t.test('admin login issues "staff"-typed tokens, and they work', async () => {
    const li = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' });
    assert.strictEqual(li.status, 200);
    assert.strictEqual(decode(li.data.token).typ, 'staff');
    assert.strictEqual((await s.get('/api/admin/orders', bearer(li.data.token))).status, 200);
    // ...and a staff token is refused by the customer API
    assert.strictEqual((await s.get('/api/auth/me', bearer(li.data.token))).status, 401);
  });

  await t.test('no fallback: a token signed with ADMIN_PASSWORD is refused', async () => {
    const t2 = craft({ sub: 'root', role: 'admin', typ: 'staff' }, 'Test@12345');
    assert.strictEqual((await s.get('/api/admin/orders', bearer(t2))).status, 401);
  });

  await t.test('compatibility: an untyped customer token signed with the CUSTOMER secret still works', async () => {
    const legacy = craft({ sub: decode(customerToken).sub, email: 'shopper@test.local', role: 'customer' }, SECRETS.customer, 20 * 24 * 3600 * 1000);
    assert.strictEqual((await s.get('/api/auth/me', bearer(legacy))).status, 200);
  });

  await t.test('a token forged with the published constant is refused by the customer API', async () => {
    const forged = craft({ sub: decode(customerToken).sub, role: 'customer' }, 'dev-insecure-secret-change-me-customer');
    assert.strictEqual((await s.get('/api/auth/me', bearer(forged))).status, 401);
  });

  await t.test('the server log contains no login debug output', async () => {
    assert.ok(!/login-debug/.test(s.log()), 'TEMPORARY DEBUG block must be gone (BUG-015)');
  });
});

/* ── Shipped .env state: neither secret set ──────────────────────────── */
test('auth: neither secret configured (the state of the shipped .env)', async (t) => {
  const s = await startServer({ ADMIN_JWT_SECRET: '', CUSTOMER_JWT_SECRET: '' });
  t.after(() => s.stop());

  await t.test('BUG-001: admin login refuses (503) instead of signing with the password', async () => {
    const li = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' });
    assert.strictEqual(li.status, 503);
    assert.ok(!li.data.token);
  });

  await t.test('BUG-001: customer sign-up and log-in refuse (503) instead of signing with a public constant', async () => {
    assert.strictEqual((await s.post('/api/auth/signup', { email: 'z@test.local', password: 'zzzzzzzz1' })).status, 503);
    assert.strictEqual((await s.post('/api/auth/login', { email: 'z@test.local', password: 'zzzzzzzz1' })).status, 503);
  });

  await t.test('BUG-001: a token forged with the published constant is not accepted (accounts answer 503 until configured)', async () => {
    const forged = craft({ sub: 'any', role: 'customer' }, 'dev-insecure-secret-change-me-customer');
    assert.strictEqual((await s.get('/api/auth/me', bearer(forged))).status, 503);
    assert.strictEqual((await s.get('/api/auth/orders', bearer(forged))).status, 503);
  });

  await t.test('the shop itself keeps working: products and guest checkout', async () => {
    const p = await s.get('/api/shop/products');
    assert.strictEqual(p.status, 200);
    const live = p.data.products.find(x => !x.upcoming && x.inStock !== false);
    assert.ok(live, 'a purchasable product exists in the seeded catalogue');
    const o = await s.post('/api/shop/orders', {
      items: [{ id: live.id, qty: 1 }],
      customer: { name: 'Guest', phone: '9876543210', email: 'guest@test.local' },
      address: { line1: '1 Street', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
      payment: { method: 'online' },
    });
    assert.strictEqual(o.status, 201, JSON.stringify(o.data));
  });
});

/* ── The configuration that was reproduced: admin secret set, customer not ── */
test('auth: admin secret set, customer secret missing', async (t) => {
  const s = await startServer({ ADMIN_JWT_SECRET: SECRETS.admin, CUSTOMER_JWT_SECRET: '' });
  t.after(() => s.stop());

  await t.test('BUG-001: no customer token can be obtained, so none can reach the admin API', async () => {
    const su = await s.post('/api/auth/signup', { email: 'y@test.local', password: 'yyyyyyyy1' });
    assert.strictEqual(su.status, 503);
    // Whatever a customer may still hold, the admin API refuses it:
    const legacy = craft({ sub: 'y', role: 'customer' }, SECRETS.admin, 30 * 24 * 3600 * 1000);
    assert.strictEqual((await s.get('/api/admin/customers', bearer(legacy))).status, 401);
  });

  await t.test('admin login still works', async () => {
    assert.strictEqual((await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).status, 200);
  });
});

/* ── Weak or reused secrets ──────────────────────────────────────────── */
test('auth: secrets shorter than 48 characters, or reused, are refused', async (t) => {
  const short = await startServer({ ADMIN_JWT_SECRET: 'x'.repeat(47), CUSTOMER_JWT_SECRET: 'y'.repeat(47) });
  t.after(() => short.stop());
  assert.strictEqual((await short.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).status, 503);
  assert.strictEqual((await short.post('/api/auth/signup', { email: 'w@test.local', password: 'wwwwwwww1' })).status, 503);

  const same = await startServer({ ADMIN_JWT_SECRET: SECRETS.admin, CUSTOMER_JWT_SECRET: SECRETS.admin });
  t.after(() => same.stop());
  assert.strictEqual((await same.post('/api/auth/signup', { email: 'v@test.local', password: 'vvvvvvvv1' })).status, 503, 'customer secret equal to the admin secret is treated as not configured');
  assert.strictEqual((await same.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).status, 200, 'admin is unaffected');
});
