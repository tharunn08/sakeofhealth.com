/**
 * Phase 0.5.2 — B2C admin role matrix, enforced on the SERVER (BUG-005).
 * Source of truth: ARCHITECTURE-CONFIRMATION §11.3 (approved).
 *   A = admin, M = manager, S = staff (support), D = delivery
 * Written before the fix. Allowed = anything but 401/403; forbidden = 403.
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer, bearer } = require('./helpers/server.js');
const { adminRoutes } = require('./helpers/tokens.js');

const AMSD = 'AMSD', AMS = 'AMS', AM = 'AM', A = 'A';
// key: "METHOD /path" with :params as in src/routes/admin.js; value: roles allowed
const MATRIX = {
  'GET /me': AMSD,
  'GET /dashboard': AMS,
  'GET /orders': AMS,
  'GET /orders/:id': AMS,                // D: only own assigned orders (tested below)
  'PATCH /orders/:id/status': AMS,       // D: only own, only out_for_delivery → delivered (below)
  'PATCH /orders/:id': AMS,              // S: notes / assignment only (below)
  'POST /orders/:id/resend-notification': AMS,
  'DELETE /orders/:id': AM,             // answers 410: orders are cancelled, not deleted (D10)
  'POST /orders/:id/cancel': AM,
  'GET /products': AMS, 'POST /products': AM, 'PATCH /products/:id': AM, 'DELETE /products/:id': AM,
  'GET /coupons': AMS, 'POST /coupons': AM, 'PATCH /coupons/:id': AM, 'DELETE /coupons/:id': AM,
  'GET /customers': AMS, 'GET /customers/:id': AMS, 'PATCH /customers/:id': AM,
  'GET /reviews': AMS, 'PATCH /reviews/:id': AMS, 'DELETE /reviews/:id': AM,
  'GET /staff': AM, 'POST /staff': AM, 'PATCH /staff/:id': AM, 'DELETE /staff/:id': A,
  'GET /deliveries': AMSD,               // D: list filtered to own (below)
  'POST /deliveries/:orderId/assign': AMS,
  'GET /analytics': AMS,
  'GET /reports/:type.csv': AM,
  'GET /settings': AM, 'PUT /settings': AM,
  'GET /notify-emails': AM, 'PUT /notify-emails': AM,
  'GET /print-settings': AMSD, 'PUT /print-settings': AM,
  'GET /email-status': AM,
  'POST /test-notification': AM,
};

let s;
const tok = {};
const ROLE = { A: 'admin', M: 'manager', S: 'staff', D: 'delivery' };

test.before(async () => {
  s = await startServer();
  const li = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' });
  tok.A = li.data.token;
  for (const k of ['M', 'S', 'D']) {
    const email = ROLE[k] + '@perm.test';
    const c = await s.post('/api/admin/staff', { name: 'T ' + ROLE[k], email, phone: '9000000000', role: ROLE[k], password: 'perm-pass-123' }, bearer(tok.A));
    assert.ok(c.status === 201 || c.status === 200, 'create ' + ROLE[k] + ': ' + c.status + ' ' + JSON.stringify(c.data));
    const l = await s.post('/api/admin/login', { email, password: 'perm-pass-123' });
    assert.strictEqual(l.status, 200);
    tok[k] = l.data.token;
  }
});
test.after(() => s && s.stop());

function call(r, token, body) {
  const h = bearer(token);
  if (r.method === 'GET') return s.get(r.path, h);
  if (r.method === 'DELETE') return s.del(r.path, h);
  if (r.method === 'POST') return s.post(r.path, body || {}, h);
  if (r.method === 'PUT') return s.put(r.path, body || {}, h);
  return s.patch(r.path, body || {}, h);
}

test('BUG-005: every admin route is covered by the approved matrix', () => {
  const routes = adminRoutes().map(r => r.method + ' ' + r.path.replace('/api/admin', '').replace(/x-(\w+)/g, ':$1'));
  assert.deepStrictEqual(routes.filter(k => !(k in MATRIX)), [], 'routes missing from the matrix');
  assert.strictEqual(routes.length, Object.keys(MATRIX).length);
});

test('every route in routes/admin.js has a rule in the permission middleware', () => {
  const { RULES } = require('../src/middleware/b2cPermissions.js');
  const missing = adminRoutes().filter(r => {
    const rel = r.path.replace('/api/admin', '');
    return !RULES.some(x => x[0] === r.method && x[1].test(rel));
  }).map(r => r.method + ' ' + r.path);
  assert.deepStrictEqual(missing, []);
});

test('BUG-005: role × route matrix is enforced on the server (4 roles × 39 routes)', async () => {
  const wrong = [];
  for (const r of adminRoutes()) {
    const key = r.method + ' ' + r.path.replace('/api/admin', '').replace(/x-(\w+)/g, ':$1');
    for (const k of ['M', 'S', 'D']) {           // admin checked separately: never 403
      const res = await call(r, tok[k]);
      const allowed = MATRIX[key].includes(k);
      const got403 = res.status === 403;
      if (res.status === 401) wrong.push(k + ' ' + key + ' → 401');
      else if (allowed && got403) wrong.push(k + ' ' + key + ' → 403 (should be allowed)');
      else if (!allowed && !got403) wrong.push(k + ' ' + key + ' → ' + res.status + ' (should be 403)');
    }
    const ra = await call(r, tok.A);
    if (ra.status === 401 || ra.status === 403) wrong.push('A ' + key + ' → ' + ra.status);
  }
  assert.deepStrictEqual(wrong, []);
});

test('BUG-005: delivery agents see and update only their own assigned orders', async () => {
  // Two orders, moved to "out for delivery"; one assigned to the agent.
  const prods = (await s.get('/api/shop/products')).data.products.filter(p => !p.upcoming);
  const mk = async () => (await s.post('/api/shop/orders', {
    items: [{ id: prods[0].id, qty: 1 }],
    customer: { name: 'Buyer', email: 'b@perm.test', phone: '9876543210' },
    address: { line1: 'MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
  })).data;
  const mine = await mk(), other = await mk();
  const agents = (await s.get('/api/admin/deliveries', bearer(tok.A))).data.agents;
  const agent = agents.find(a => a.email === 'delivery@perm.test');
  assert.ok(agent);
  for (const o of [mine, other]) {
    for (const st of ['accepted', 'prepared', 'out_for_delivery']) {
      const u = await s.patch('/api/admin/orders/' + o.id + '/status', { status: st }, bearer(tok.A));
      assert.strictEqual(u.status, 200, st + ' ' + JSON.stringify(u.data));
    }
  }
  assert.strictEqual((await s.post('/api/admin/deliveries/' + mine.id + '/assign', { agentId: agent.id }, bearer(tok.A))).status, 200);

  const board = await s.get('/api/admin/deliveries', bearer(tok.D));
  assert.strictEqual(board.status, 200);
  const ids = board.data.deliveries.map(d => d.id);
  assert.ok(ids.includes(mine.id), 'own order is on the agent\'s board');
  assert.ok(!ids.includes(other.id), 'someone else\'s order is NOT on the agent\'s board');

  assert.strictEqual((await s.get('/api/admin/orders/' + mine.id, bearer(tok.D))).status, 200);
  assert.strictEqual((await s.get('/api/admin/orders/' + other.id, bearer(tok.D))).status, 403);

  // Only out_for_delivery → delivered, and only on the agent's own order
  assert.strictEqual((await s.patch('/api/admin/orders/' + mine.id + '/status', { status: 'cancelled' }, bearer(tok.D))).status, 403);
  assert.strictEqual((await s.patch('/api/admin/orders/' + other.id + '/status', { status: 'delivered' }, bearer(tok.D))).status, 403);
  const done = await s.patch('/api/admin/orders/' + mine.id + '/status', { status: 'delivered' }, bearer(tok.D));
  assert.strictEqual(done.status, 200, JSON.stringify(done.data));
  assert.strictEqual(done.data.status, 'delivered');
});

test('BUG-005: support staff may add notes but not change payment or address', async () => {
  const list = (await s.get('/api/admin/orders', bearer(tok.A))).data.orders;
  const id = list[0].id;
  assert.strictEqual((await s.patch('/api/admin/orders/' + id, { notes: 'Called the customer' }, bearer(tok.S))).status, 200);
  assert.strictEqual((await s.patch('/api/admin/orders/' + id, { payment: { status: 'paid' } }, bearer(tok.S))).status, 403);
  assert.strictEqual((await s.patch('/api/admin/orders/' + id, { address: { line1: 'x' } }, bearer(tok.S))).status, 403);
  assert.strictEqual((await s.patch('/api/admin/orders/' + id, { notes: 'ok' }, bearer(tok.M))).status, 200);
});

test('BUG-005: unknown or business-only roles get no shop-admin access', async () => {
  const c = await s.post('/api/admin/staff', { name: 'B2B only', email: 'fin@perm.test', phone: '9000000001', role: 'finance', password: 'perm-pass-123' }, bearer(tok.A));
  if (c.status !== 201 && c.status !== 200) return; // role not creatable in this build: nothing to test
  const l = await s.post('/api/admin/login', { email: 'fin@perm.test', password: 'perm-pass-123' });
  assert.strictEqual((await s.get('/api/admin/customers', bearer(l.data.token))).status, 403);
  assert.strictEqual((await s.get('/api/admin/me', bearer(l.data.token))).status, 200);
});
