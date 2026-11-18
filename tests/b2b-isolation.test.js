/**
 * Isolation suite — proves the customer website does not depend on the B2B
 * platform or on MySQL:
 *   1. B2B_ENABLED=false  → every B2B surface is absent, B2C works.
 *   2. B2B_ENABLED=true with an unreachable database → B2C still works,
 *      B2B answers a clean 503 with no internals leaked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server.js');

async function b2cWorks(s) {
  for (const p of ['/', '/account.html', '/checkout/', '/admin/', '/config.js']) {
    assert.equal((await s.get(p)).status, 200, p);
  }
  const products = await s.get('/api/shop/products');
  assert.equal(products.status, 200);
  const list = Array.isArray(products.data) ? products.data : products.data.products;
  assert.ok(list.length >= 1, 'catalogue is served from the JSON store');
  const login = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' });
  assert.equal(login.status, 200);
  assert.ok(login.data.token);
  const orders = await s.get('/api/admin/orders', { Authorization: 'Bearer ' + login.data.token });
  assert.equal(orders.status, 200);
  return login.data.token;
}

test('B2B disabled: no portal, no API, customer site unaffected', async () => {
  // Deliberately broken DB settings: with the flag off they must never be used.
  const s = await startServer({ B2B_ENABLED: 'false', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASSWORD: 'x', DB_NAME: 'nothing' });
  try {
    const token = await b2cWorks(s);
    for (const p of ['/api/b2b/auth/login', '/api/b2b/meta/states', '/api/admin/b2b/dashboard']) {
      const r = await s.get(p, { Authorization: 'Bearer ' + token });
      assert.equal(r.status, 404, p + ' must not exist when B2B is off');
    }
    assert.equal((await s.post('/api/b2b/auth/login', { identifier: 'a@b.c', password: 'x', role: 'retailer' })).status, 404);
    for (const p of ['/b2b', '/b2b/login', '/b2b/register', '/admin/b2b/dashboard.html']) {
      // Unknown paths fall through to the storefront's existing catch-all (home page).
      const page = await s.get(p);
      assert.doesNotMatch(String(page.data), /<title>(Business Login|Register your business)|\/b2b\/(auth|app)\.js/i, p + ' must not serve the business portal when B2B is off');
    }
    const health = await s.get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal(health.data.b2b.enabled, false);
    const cfg = await s.get('/config.js');
    assert.match(cfg.data, /"b2bEnabled":false/);
    assert.doesNotMatch(s.log(), /ECONNREFUSED|mysql/i, 'no database connection is attempted');
  } finally { await s.stop(); }
});

test('B2B enabled but database down: customer site works, B2B answers 503 cleanly', async () => {
  const s = await startServer({ B2B_ENABLED: 'true', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASSWORD: 'secret-pw-should-never-leak', DB_NAME: 'nothing', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123' });
  try {
    const token = await b2cWorks(s);
    const login = await s.post('/api/b2b/auth/login', { identifier: 'a@b.c', password: 'Whatever1', role: 'retailer' });
    assert.equal(login.status, 503);
    const body = JSON.stringify(login.data);
    assert.doesNotMatch(body, /ECONNREFUSED|secret-pw|127\.0\.0\.1|at .*\.js|SELECT/i, 'no internals in the error');
    const admin = await s.get('/api/admin/b2b/dashboard', { Authorization: 'Bearer ' + token });
    assert.equal(admin.status, 503);
    const health = await s.get('/api/health');
    assert.equal(health.status, 200, 'health stays 200 so Hostinger keeps the app up');
    assert.equal(health.data.b2b.enabled, true);
    assert.equal(health.data.b2b.database, 'down');
    assert.doesNotMatch(JSON.stringify(health.data), /secret-pw|nobody/);
  } finally { await s.stop(); }
});

test('production without a signing secret: business logins are refused, customer site works', async () => {
  const s = await startServer({ NODE_ENV: 'production', B2B_ENABLED: 'true', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASSWORD: 'x', DB_NAME: 'nothing',
    B2B_JWT_SECRET: '', JWT_SECRET: '', ADMIN_JWT_SECRET: 'short' });
  try {
    assert.equal((await s.get('/')).status, 200);
    assert.equal((await s.get('/api/shop/products')).status, 200);
    const login = await s.post('/api/b2b/auth/login', { identifier: 'a@b.c', password: 'Whatever1', role: 'retailer' });
    assert.equal(login.status, 503);
    assert.equal(login.data.code, 'NOT_CONFIGURED');
  } finally { await s.stop(); }
});

/**
 * First deploy: B2B switched on against a brand-new, empty database. Only run
 * when a scratch database is provided (TEST_FRESH_DB_NAME) — it must be empty.
 */
test('first deploy: empty database → status shows pending → admin runs migrations → portal works', { skip: !process.env.TEST_FRESH_DB_NAME }, async () => {
  const env = { B2B_ENABLED: 'true', DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT || '3306',
    DB_USER: process.env.TEST_DB_USER || 'root', DB_PASSWORD: process.env.TEST_DB_PASSWORD || '', DB_NAME: process.env.TEST_FRESH_DB_NAME,
    DB_AUTO_MIGRATE: 'false', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123' };
  const s = await startServer(env);
  try {
    const token = await b2cWorks(s);
    const auth = { Authorization: 'Bearer ' + token };
    // Nothing was created on start-up.
    assert.equal((await s.get('/api/b2b/geo/states')).status, 503, 'portal waits for the schema');
    const before = await s.get('/api/admin/b2b/system/status', auth);
    assert.equal(before.status, 200);
    assert.equal(before.data.database.connected, true);
    assert.ok(before.data.migrations.pending >= 1, 'migrations are pending, not auto-applied');
    const run = await s.post('/api/admin/b2b/system/migrate', {}, auth);
    assert.equal(run.status, 200, JSON.stringify(run.data));
    const after = await s.get('/api/admin/b2b/system/status', auth);
    assert.equal(after.data.migrations.pending, 0);
    assert.equal(after.data.schema.ok, true);
    const states = await s.get('/api/b2b/geo/states');
    assert.equal(states.status, 200);
    assert.ok(states.data.states.length >= 1);
    // Running again is harmless.
    assert.equal((await s.post('/api/admin/b2b/system/migrate', {}, auth)).status, 200);
  } finally { await s.stop(); }
});
