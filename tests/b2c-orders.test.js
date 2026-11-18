/**
 * Phase 0.5.6–0.5.7 — order lifecycle (BUG-012, BUG-013, D10).
 * Written BEFORE the fixes. Uses a throw-away DATA_DIR; legacy-style orders
 * are written into that temporary folder only to reproduce old data.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, bearer } = require('./helpers/server.js');

let s, admin, staff, product;
/* The real order rate limit (10/minute per IP) stays on; each request uses its own address. */
function spread(srv) {
  for (const m of ['post', 'patch', 'get', 'del']) {
    const f = srv[m];
    srv[m] = m === 'get' || m === 'del'
      ? (u, h) => f(u, Object.assign({ 'X-Forwarded-For': ip() }, h || {}))
      : (u, b, h) => f(u, b, Object.assign({ 'X-Forwarded-For': ip() }, h || {}));
  }
  return srv;
}
const ip = () => '10.8.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
const customer = { name: 'Order Tester', email: 'orders@test.local', phone: '9876500000' };
const address = { line1: 'MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };

function today() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
const ordersFile = () => path.join(s.dataDir, 'orders.json');
const readOrders = () => JSON.parse(fs.readFileSync(ordersFile(), 'utf8'));
function injectOrder(fields) {
  const list = fs.existsSync(ordersFile()) ? readOrders() : [];
  const o = Object.assign({
    id: 'inj-' + Math.random().toString(36).slice(2, 10),
    items: [{ id: product.id, name: product.name, price: product.price, qty: 1, image: '' }],
    subtotal: product.price, discount: 0, shipping: 0, total: product.price, currency: 'INR',
    customer, address, payment: { method: 'online', status: 'pending', gateway: null, paymentId: null },
    status: 'pending', timeline: [{ status: 'pending', at: new Date().toISOString(), by: 'system' }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), assignedTo: null,
  }, fields);
  list.push(o);
  fs.writeFileSync(ordersFile(), JSON.stringify(list, null, 2));
  return o;
}
async function place() {
  const r = await s.post('/api/shop/orders', { items: [{ id: product.id, qty: 1 }], customer, address });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test.before(async () => {
  s = spread(await startServer());
  admin = (await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token;
  await s.post('/api/admin/staff', { name: 'Desk', email: 'desk@orders.test', phone: '9000000001', role: 'staff', password: 'desk-pass-123' }, bearer(admin));
  staff = (await s.post('/api/admin/login', { email: 'desk@orders.test', password: 'desk-pass-123' })).data.token;
  product = (await s.get('/api/shop/products')).data.products.find(p => !p.upcoming);
});
test.after(() => s && s.stop());

/* ── BUG-012 ── */
test('BUG-012: marking an order delivered does not mark an unpaid order as paid', async () => {
  const o = injectOrder({ orderId: 'LEGACY-UNPAID-1', status: 'out_for_delivery' });
  const r = await s.patch('/api/admin/orders/' + o.id + '/status', { status: 'delivered' }, bearer(admin));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.status, 'delivered');
  assert.strictEqual(r.data.payment.status, 'pending', 'payment status unchanged by delivery');
});

/* ── BUG-013 numbering ── */
test('BUG-013: a new order number is never a duplicate, even after a gap in the day', async () => {
  const p = 'SOH-' + today() + '-';
  injectOrder({ orderId: p + '0001' });
  injectOrder({ orderId: p + '0003' });          // 0002 was removed in the past → count is 2
  const o = await place();
  const all = readOrders().map(x => x.orderId);
  assert.strictEqual(all.filter(x => x === o.orderId).length, 1, 'unique: ' + o.orderId);
  assert.ok(o.orderId > p + '0003', 'after the highest of the day: ' + o.orderId);
});

test('BUG-013: order numbers keep increasing across many orders', async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await place()).orderId);
  assert.deepStrictEqual([...ids].sort(), ids);
  assert.strictEqual(new Set(ids).size, ids.length);
});

/* ── D10 cancel instead of delete ── */
test('D10: "delete order" no longer removes the order', async () => {
  const o = await place();
  const r = await s.del('/api/admin/orders/' + o.id, bearer(admin));
  assert.notStrictEqual(r.status, 200, 'delete is not performed');
  assert.ok(readOrders().some(x => x.id === o.id), 'order still on file');
});

test('D10: cancel requires a reason, keeps the order, records who/why/when', async () => {
  const o = await place();
  const noReason = await s.post('/api/admin/orders/' + o.id + '/cancel', {}, bearer(admin));
  assert.strictEqual(noReason.status, 400);
  const r = await s.post('/api/admin/orders/' + o.id + '/cancel', { reason: 'Customer asked to cancel by phone' }, bearer(admin));
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const saved = readOrders().find(x => x.id === o.id);
  assert.strictEqual(saved.status, 'cancelled');
  assert.strictEqual(saved.cancelReason, 'Customer asked to cancel by phone');
  assert.strictEqual(saved.cancelledBy, 'admin@test.local');
  assert.ok(saved.cancelledAt);
  const last = saved.timeline[saved.timeline.length - 1];
  assert.strictEqual(last.status, 'cancelled');
  assert.match(last.note, /Customer asked to cancel/);
  assert.strictEqual(saved.refundRequired, true, 'a paid order that is cancelled is flagged for refund');
  assert.strictEqual((await s.post('/api/admin/orders/' + o.id + '/cancel', { reason: 'again' }, bearer(admin))).status, 409, 'cannot cancel twice');
});

test('D10: a delivered order cannot be cancelled', async () => {
  const o = injectOrder({ orderId: 'LEGACY-DELIVERED-1', status: 'delivered' });
  assert.strictEqual((await s.post('/api/admin/orders/' + o.id + '/cancel', { reason: 'test' }, bearer(admin))).status, 409);
});

test('D10: cancelling updates the customer totals; numbering stays unique after cancel', async () => {
  const o = await place();
  await s.post('/api/admin/orders/' + o.id + '/cancel', { reason: 'Duplicate order' }, bearer(admin));
  const after = (await s.get('/api/admin/customers', bearer(admin))).data;
  const c1 = (after.customers || after).find(c => c.email === customer.email);
  const live = readOrders().filter(x => x.customer && x.customer.email === customer.email && x.status !== 'cancelled');
  assert.strictEqual(c1.orderCount, live.length, 'count = non-cancelled orders on file');
  assert.strictEqual(c1.totalSpent, live.reduce((a, x) => a + x.total, 0), 'spent = their totals');
  assert.ok(!live.some(x => x.id === o.id));
  const next = await place();
  assert.ok(next.orderId > o.orderId);
});

test('roles: support staff cannot cancel, either way', async () => {
  const o = await place();
  assert.strictEqual((await s.post('/api/admin/orders/' + o.id + '/cancel', { reason: 'x' }, bearer(staff))).status, 403);
  assert.strictEqual((await s.patch('/api/admin/orders/' + o.id + '/status', { status: 'cancelled' }, bearer(staff))).status, 403);
  assert.strictEqual(readOrders().find(x => x.id === o.id).status, 'pending');
});

test('D10: cancelling through the status menu also needs a reason and records it', async () => {
  const o = await place();
  assert.strictEqual((await s.patch('/api/admin/orders/' + o.id + '/status', { status: 'cancelled' }, bearer(admin))).status, 400);
  const r = await s.patch('/api/admin/orders/' + o.id + '/status', { status: 'cancelled', note: 'Out of delivery area' }, bearer(admin));
  assert.strictEqual(r.status, 200);
  const saved = readOrders().find(x => x.id === o.id);
  assert.strictEqual(saved.cancelReason, 'Out of delivery area');
  assert.strictEqual(saved.cancelledBy, 'admin@test.local');
});
