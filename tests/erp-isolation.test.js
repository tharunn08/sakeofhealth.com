/**
 * ERP isolation — no MySQL needed. Proves:
 *  1. ERP_ENABLED=false (B2B on or off): no ERP surface exists; the shop works.
 *  2. ERP on with the database DOWN: the shop still works, ERP answers 503 cleanly,
 *     webhooks refuse unsigned/unauthorised calls.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, prodEnv } = require('./helpers/server.js');

const DOWN_DB = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASSWORD: 'secret-pw-should-never-leak', DB_NAME: 'nothing' };

async function shopWorks(s) {
  for (const p of ['/', '/account.html', '/checkout/', '/admin/', '/track.html', '/config.js']) assert.equal((await s.get(p)).status, 200, p);
  const products = await s.get('/api/shop/products');
  assert.equal(products.status, 200);
  const login = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' });
  assert.equal(login.status, 200);
  assert.equal((await s.get('/api/admin/orders', { Authorization: 'Bearer ' + login.data.token })).status, 200);
}

test('ERP disabled: no ERP API, page or webhook exists; shop unaffected', async () => {
  for (const b2b of ['false', 'true']) {
    const s = await startServer(Object.assign({ B2B_ENABLED: b2b, ERP_ENABLED: 'false', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123' }, DOWN_DB));
    try {
      await shopWorks(s);
      assert.equal((await s.post('/api/erp/core/login', { email: 'a@b.c', password: 'x' })).status, 404, 'login with B2B=' + b2b);
      assert.equal((await s.get('/api/erp/core/me')).status, 404);
      assert.equal((await s.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status === 200 &&
        (await s.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).data === '1', false, 'no webhook handshake');
      const page = await s.get('/admin/erp');
      assert.doesNotMatch(String(page.data), /Business platform sign-in|\/admin\/erp\/app\.js/);
      for (const p of ['/vendor-portal', '/sales-app']) assert.doesNotMatch(String((await s.get(p)).data), /vendor-portal\/app\.js|sales-app\/app\.js/, p);
      assert.equal((await s.post('/api/vendor/auth/login', { email: 'a@b.c', password: 'x' })).status, 404);
      assert.equal((await s.get('/api/sales/me')).status, 404);
    } finally { await s.stop(); }
  }
});

test('ERP enabled, database down: shop works, ERP answers 503 without internals, webhooks refuse', async () => {
  const s = await startServer(Object.assign({ B2B_ENABLED: 'true', ERP_ENABLED: 'true', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123',
    ERP_JWT_SECRET: 'test-erp-secret-not-for-production-0123456789', WHATSAPP_APP_SECRET: 'whatsapp-app-secret-1234567890', WHATSAPP_VERIFY_TOKEN: 'verify-me' }, DOWN_DB));
  try {
    await shopWorks(s);
    const r = await s.post('/api/erp/core/login', { email: 'someone@test.local', password: 'whatever-password' });
    assert.equal(r.status, 503);
    assert.doesNotMatch(JSON.stringify(r.data), /ECONNREFUSED|secret-pw|127\.0\.0\.1|SELECT|at .*\.js/i);
    assert.equal((await s.get('/api/erp/core/me')).status, 401, 'no token → 401 before any database work');
    assert.equal((await s.get('/api/erp/core/me', { Authorization: 'Bearer forged.token' })).status, 401);
    // the admin page is served (static), the API is what is guarded
    assert.match(String((await s.get('/admin/erp')).data), /\/admin\/erp\/app\.js/);
    // handshake: right token echoes the challenge, wrong token is refused
    assert.equal((await s.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=4242')).data, '4242');
    assert.equal((await s.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242')).status, 403);
    // unsigned POST is refused before any status is processed (DB down → the refusal is still 401/500, never 200)
    const res = await fetch(s.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"entry":[]}' });
    assert.notEqual(res.status, 200);
    const body = Buffer.from('{"entry":[]}');
    const signed = await fetch(s.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', 'whatsapp-app-secret-1234567890').update(body).digest('hex') }, body: body });
    assert.equal(signed.status, 200, 'a correctly signed event with no statuses is acknowledged');
  } finally { await s.stop(); }
});

test('ERP in production without a strong secret: refuses with 503, shop works', async () => {
  // CONFIG_STRICT=false: start despite the weak secret (refused at start-up otherwise — tests/env-config.test.js)
  // to prove the ERP itself still refuses (defence in depth).
  const s = await startServer(prodEnv(Object.assign({ CONFIG_STRICT: 'false', B2B_ENABLED: 'true', ERP_ENABLED: 'true', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123', ERP_JWT_SECRET: 'short' }, DOWN_DB)));
  try {
    assert.equal((await s.get('/')).status, 200);
    const r = await s.post('/api/erp/core/login', { email: 'a@b.c', password: 'whatever-password' });
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'NOT_CONFIGURED');
  } finally { await s.stop(); }
});
