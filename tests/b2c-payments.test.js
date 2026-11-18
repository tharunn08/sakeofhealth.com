/**
 * Phase 0.5.3–0.5.5 — checkout pricing and payment binding
 * (BUG-002, BUG-003, BUG-004, BUG-006 minimal, BUG-021, BUG-028).
 * Written BEFORE the fixes. Razorpay is a local stub (tests/helpers/
 * razorpay-stub.js): test keys only, no network, no money.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('crypto');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers/server.js');
const { startRazorpayStub } = require('./helpers/razorpay-stub.js');

const KEY_ID = 'rzp_test_STUBKEY', KEY_SECRET = 'stub-key-secret-for-tests', WEBHOOK_SECRET = 'stub-webhook-secret-for-tests';
const sig = (o, p) => createHmac('sha256', KEY_SECRET).update(o + '|' + p).digest('hex');
const customer = { name: 'Pay Tester', email: 'pay@test.local', phone: '9876543210' };
const address = { doorNo: '1', line1: 'MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };

let rz, s, products;
/* The real rate limits stay on (10 orders / 20 payment starts per minute per IP);
   each test request comes from its own address (the app trusts one proxy hop). */
function spread(srv) {
  const post = srv.post;
  srv.post = (u, b, h) => post(u, b, Object.assign({ 'X-Forwarded-For': '10.9.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) }, h || {}));
  return srv;
}
const live = () => products.find(p => p.slug === 'multivitamin') || products.find(p => !p.upcoming);
const upcoming = () => products.find(p => p.upcoming);

test.before(async () => {
  rz = await startRazorpayStub(KEY_ID, KEY_SECRET);
  s = spread(await startServer({
    PAYMENT_MOCK: 'false', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, RAZORPAY_API_BASE: rz.base,
  }));
  products = (await s.get('/api/shop/products')).data.products;
});
test.after(async () => { if (s) await s.stop(); if (rz) await rz.stop(); });

async function startCheckout(items, extra) {
  return s.post('/api/checkout/order', Object.assign({ items, customer, address, couponCode: null }, extra || {}), { 'Idempotency-Key': 'k-' + Math.random() });
}

/* ── Quote ─────────────────────────────────────────────────────────── */
test('BUG-028: /api/shop/quote prices the cart from the catalogue, ignoring client prices', async () => {
  const p = live();
  const q = await s.post('/api/shop/quote', { items: [{ id: p.id, qty: 2, price: 1 }] });
  assert.strictEqual(q.status, 200, JSON.stringify(q.data));
  assert.strictEqual(q.data.lines[0].price, p.price);
  assert.strictEqual(q.data.subtotal, p.price * 2);
  assert.strictEqual(q.data.total, q.data.subtotal - q.data.discount + q.data.shipping);
  assert.strictEqual(q.data.lines[0].priceChanged, true, 'tells the page the price differs from what it showed');
});

test('BUG-004/006: quote refuses unknown, coming-soon and over-stock items', async () => {
  assert.strictEqual((await s.post('/api/shop/quote', { items: [{ id: 'does-not-exist', qty: 1, price: 1 }] })).status, 400);
  assert.strictEqual((await s.post('/api/shop/quote', { items: [{ id: upcoming().id, qty: 1 }] })).status, 400);
  assert.strictEqual((await s.post('/api/shop/quote', { items: [{ id: live().id, qty: 100000 }] })).status, 400);
});

/* ── Gateway order ─────────────────────────────────────────────────── */
test('BUG-002: the gateway order is created for the SERVER total; a client "amount" is ignored', async () => {
  const p = live();
  const r = await startCheckout([{ id: p.id, qty: 2, price: 1 }], { amount: 1 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.gateway, 'razorpay');
  const q = (await s.post('/api/shop/quote', { items: [{ id: p.id, qty: 2 }] })).data;
  assert.strictEqual(rz.orders[r.data.id].amount, Math.round(q.total * 100), 'stub received the server total in paise');
  assert.strictEqual(r.data.amountPaise, Math.round(q.total * 100));
});

test('BUG-002: starting a payment without cart items is refused (no amount-only gateway orders)', async () => {
  const r = await s.post('/api/checkout/order', { amount: 1127 }, { 'Idempotency-Key': 'k-amount-only' });
  assert.strictEqual(r.status, 400);
});

/* ── Order placement with payment binding ──────────────────────────── */
let paidOrder, paidCheckout;
test('BUG-002: a verified payment creates the order from the server-priced checkout (client items ignored)', async () => {
  const p = live();
  const co = (await startCheckout([{ id: p.id, qty: 2 }])).data;
  rz.pay(co.id, 'pay_GOOD1');
  const r = await s.post('/api/shop/orders', {
    items: [{ id: p.id, qty: 50, price: 1 }], customer, address,
    payment: { gateway: 'razorpay', gatewayOrderId: co.id, paymentId: 'pay_GOOD1', signature: sig(co.id, 'pay_GOOD1') },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  assert.strictEqual(r.data.total * 100, co.amountPaise, 'order total equals the amount paid');
  paidOrder = r.data; paidCheckout = co;
});

test('BUG-002: the same payment id cannot be attached to a second order', async () => {
  const p = live();
  const co2 = (await startCheckout([{ id: p.id, qty: 1 }])).data;
  const r = await s.post('/api/shop/orders', {
    items: [{ id: p.id, qty: 1 }], customer, address,
    payment: { gateway: 'razorpay', gatewayOrderId: co2.id, paymentId: 'pay_GOOD1', signature: sig(co2.id, 'pay_GOOD1') },
  });
  assert.ok(r.status === 409 || r.status === 400, 'refused: ' + r.status);
});

test('repeating the browser confirmation for the same payment returns the same order (no duplicate)', async () => {
  const p = live();
  const r = await s.post('/api/shop/orders', {
    items: [{ id: p.id, qty: 2 }], customer, address,
    payment: { gateway: 'razorpay', gatewayOrderId: paidCheckout.id, paymentId: 'pay_GOOD1', signature: sig(paidCheckout.id, 'pay_GOOD1') },
  });
  assert.ok(r.status === 200 || r.status === 201, String(r.status));
  assert.strictEqual(r.data.orderId, paidOrder.orderId);
});

test('BUG-002: under-paid, wrong-currency, failed, mismatched or unsigned payments are refused', async () => {
  const p = live();
  const cases = [
    ['under-paid', { amount: 100 }],
    ['wrong currency', { currency: 'USD' }],
    ['failed', { status: 'failed' }],
    ['for another gateway order', { order_id: 'order_SOMEOTHER' }],
  ];
  for (const [label, override] of cases) {
    const co = (await startCheckout([{ id: p.id, qty: 1 }])).data;
    const pid = 'pay_' + label.replace(/\W/g, '');
    rz.pay(co.id, pid, override);
    const r = await s.post('/api/shop/orders', { items: [{ id: p.id, qty: 1 }], customer, address,
      payment: { gateway: 'razorpay', gatewayOrderId: co.id, paymentId: pid, signature: sig(co.id, pid) } });
    assert.strictEqual(r.status, 400, label + ' → ' + r.status + ' ' + JSON.stringify(r.data));
  }
  const co = (await startCheckout([{ id: p.id, qty: 1 }])).data;
  rz.pay(co.id, 'pay_BADSIG');
  const bad = await s.post('/api/shop/orders', { items: [{ id: p.id, qty: 1 }], customer, address,
    payment: { gateway: 'razorpay', gatewayOrderId: co.id, paymentId: 'pay_BADSIG', signature: 'forged' } });
  assert.strictEqual(bad.status, 400);
  const none = await s.post('/api/shop/orders', { items: [{ id: p.id, qty: 1 }], customer, address });
  assert.strictEqual(none.status, 400, 'no payment → refused');
});

test('quote = gateway amount = order total, for every orderable SKU, with and without each coupon', async () => {
  const skus = products.filter(p => !p.upcoming && p.inStock !== false);
  assert.ok(skus.length > 0);
  let checked = 0, discounted = 0;
  for (const p of skus) {
    for (const coupon of [null, 'WELCOME10', 'FLAT100', 'FREESHIP']) {
      const items = [{ id: p.id, qty: 2 }];
      const q = (await s.post('/api/shop/quote', { items, couponCode: coupon })).data;
      const co = (await startCheckout(items, { couponCode: coupon })).data;
      assert.strictEqual(co.amountPaise, Math.round(q.total * 100), p.slug + ' ' + coupon + ': quote vs checkout');
      assert.strictEqual(rz.orders[co.id].amount, co.amountPaise, p.slug + ' ' + coupon + ': gateway amount');
      const pid = 'pay_SKU_' + p.id + '_' + (coupon || 'none');
      rz.pay(co.id, pid);
      const o = await s.post('/api/shop/orders', { items, customer, address, couponCode: coupon,
        payment: { gateway: 'razorpay', gatewayOrderId: co.id, paymentId: pid, signature: sig(co.id, pid) } });
      assert.strictEqual(o.status, 201, p.slug + ' ' + coupon + ': ' + JSON.stringify(o.data));
      assert.strictEqual(Math.round(o.data.total * 100), co.amountPaise, p.slug + ' ' + coupon + ': order total');
      checked++; if (q.discount > 0 || (coupon === 'FREESHIP' && q.shipping === 0)) discounted++;
    }
  }
  assert.ok(discounted > 0, 'at least one coupon actually applied');
  console.log('# SKU/coupon combinations checked: ' + checked + ' (' + skus.length + ' SKUs), coupon applied in ' + discounted);
});

/* ── Webhook ───────────────────────────────────────────────────────── */
function hook(payload, secret, eventId) {
  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', secret || WEBHOOK_SECRET).update(raw).digest('hex');
  return fetch(s.base + '/api/shop/webhooks/razorpay', { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId || ('evt_' + Math.random()) } });
}
const captured = (pay) => ({ event: 'payment.captured', payload: { payment: { entity: pay } } });

test('webhook: a bad signature is refused', async () => {
  const r = await hook(captured({ id: 'x' }), 'wrong-secret');
  assert.strictEqual(r.status, 400);
});

test('webhook: a captured payment whose browser callback was lost creates the order exactly once', async () => {
  const p = live();
  const co = (await startCheckout([{ id: p.id, qty: 3 }])).data;
  const pay = rz.pay(co.id, 'pay_LOSTCB');
  const before = (await s.get('/api/shop/products')).status; // keep server warm
  assert.strictEqual(before, 200);
  assert.strictEqual((await hook(captured(pay), null, 'evt_lost_1')).status, 200);
  assert.strictEqual((await hook(captured(pay), null, 'evt_lost_1')).status, 200, 'replayed event is acknowledged');
  assert.strictEqual((await hook(captured(pay), null, 'evt_lost_2')).status, 200, 'a second event for the same payment is acknowledged');
  const orders = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'orders.json'), 'utf8')).filter(o => o.payment && o.payment.paymentId === 'pay_LOSTCB');
  assert.strictEqual(orders.length, 1, 'exactly one order');
  assert.strictEqual(orders[0].total * 100, co.amountPaise);
  // a late browser confirmation returns the same order
  const late = await s.post('/api/shop/orders', { items: [{ id: p.id, qty: 3 }], customer, address,
    payment: { gateway: 'razorpay', gatewayOrderId: co.id, paymentId: 'pay_LOSTCB', signature: sig(co.id, 'pay_LOSTCB') } });
  assert.strictEqual(late.data.orderId, orders[0].orderId);
});

test('webhook: an amount that does not match the checkout creates no order', async () => {
  const p = live();
  const co = (await startCheckout([{ id: p.id, qty: 1 }])).data;
  const pay = rz.pay(co.id, 'pay_HOOKMISMATCH', { amount: 100 });
  assert.strictEqual((await hook(captured(pay))).status, 200);
  const orders = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'orders.json'), 'utf8')).filter(o => o.payment && o.payment.paymentId === 'pay_HOOKMISMATCH');
  assert.strictEqual(orders.length, 0);
});

/* ── Fail-closed configuration ─────────────────────────────────────── */
test('BUG-003: production never uses mock payments, even with PAYMENT_MOCK=true and no keys', async (t) => {
  // Production never seeds (BUG-008), so give it a copy of the test catalogue.
  const prodData = fs.mkdtempSync(path.join(require('os').tmpdir(), 'soh-test-prod-'));
  fs.copyFileSync(path.join(s.dataDir, 'products.json'), path.join(prodData, 'products.json'));
  const prod = spread(await startServer({ NODE_ENV: 'production', PAYMENT_MOCK: 'true', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', DATA_DIR: prodData }));
  t.after(() => prod.stop());
  const p = (await prod.get('/api/shop/products')).data.products.find(x => !x.upcoming);
  const co = await prod.post('/api/checkout/order', { items: [{ id: p.id, qty: 1 }], customer, address }, { 'Idempotency-Key': 'k-prod' });
  assert.strictEqual(co.status, 503, 'payment unavailable, not mock: ' + JSON.stringify(co.data));
  const o = await prod.post('/api/shop/orders', { items: [{ id: p.id, qty: 1 }], customer, address, payment: { gateway: 'mock' } });
  assert.strictEqual(o.status, 503);
});

test('BUG-003: PAYMENT_MOCK left unset with keys present means live verification, not mock', async (t) => {
  const srv = spread(await startServer({ PAYMENT_MOCK: '', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_API_BASE: rz.base }));
  t.after(() => srv.stop());
  const p = (await srv.get('/api/shop/products')).data.products.find(x => !x.upcoming);
  const o = await srv.post('/api/shop/orders', { items: [{ id: p.id, qty: 1 }], customer, address, payment: { gateway: 'mock', paymentId: 'mock_pay_1' } });
  assert.strictEqual(o.status, 400, 'an unpaid order is refused: ' + JSON.stringify(o.data));
});

test('BUG-004/006: in test (mock) mode, order lines are still validated', async (t) => {
  const mock = spread(await startServer());
  t.after(() => mock.stop());
  const ps = (await mock.get('/api/shop/products')).data.products;
  const lv = ps.find(x => !x.upcoming), up = ps.find(x => x.upcoming);
  const place = items => mock.post('/api/shop/orders', { items, customer, address });
  assert.strictEqual((await place([{ id: 'does-not-exist', name: 'X', price: 1, qty: 10 }])).status, 400, 'unknown id');
  if (up) assert.strictEqual((await place([{ id: up.id, qty: 1 }])).status, 400, 'coming soon');
  assert.strictEqual((await place([{ id: lv.id, qty: 100000 }])).status, 400, 'more than in stock');
  const ok = await place([{ id: lv.id, qty: 1, price: 1 }]);
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.data.total, lv.price + (lv.price >= 499 ? 0 : 49), 'catalogue price, not the client price');
});

test('BUG-021: the Cashfree fallback (hard-coded sandbox URL) is removed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'payments.js'), 'utf8');
  assert.ok(!/cashfree/i.test(src), 'no Cashfree code path remains');
});

/* ── Contract used by the business (B2B) module — grandfathered coupling ── */
test('B2B contract: payments.createOrder() and verifySignature() still work for the business module (fail-closed)', async () => {
  const { execFile } = require('child_process');
  const run = (env, code) => new Promise(resolve => execFile(process.execPath, ['-e', code],
    { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { DATA_DIR: fs.mkdtempSync(path.join(require('os').tmpdir(), 'soh-b2bc-')) }, env) },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout.trim(), err: stderr })));
  const live = { NODE_ENV: 'test', PAYMENT_MOCK: '', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_API_BASE: rz.base };
  const r = await run(live, `
    const p = require('./src/services/payments.js');
    p.createOrder({ amount: 1234, currency: 'INR', receipt: 'B2B-ORD-1', idempotencyKey: 'b2b-1' })
      .then(g => console.log(JSON.stringify(g))).catch(e => { console.error(e.message); process.exit(2); });`);
  assert.strictEqual(r.code, 0, r.err);
  const g = JSON.parse(r.out);
  assert.strictEqual(g.gateway, 'razorpay');
  assert.strictEqual(g.key, KEY_ID);
  assert.strictEqual(rz.orders[g.id].amount, 123400, 'rupees converted to paise');
  const v = await run(live, `
    const p = require('./src/services/payments.js');
    Promise.all([p.verifySignature('razorpay', { orderId: 'order_X', paymentId: 'pay_Y', signature: ${JSON.stringify(sig('order_X', 'pay_Y'))} }),
                 p.verifySignature('razorpay', { orderId: 'order_X', paymentId: 'pay_Y', signature: 'forged' })]).then(r => console.log(JSON.stringify(r)));`);
  assert.deepStrictEqual(JSON.parse(v.out), [true, false]);
  const mock = await run({ NODE_ENV: 'test', PAYMENT_MOCK: 'true', RAZORPAY_KEY_ID: '' }, `
    require('./src/services/payments.js').createOrder({ amount: 10, idempotencyKey: 'k' }).then(g => console.log(g.gateway));`);
  assert.strictEqual(mock.out, 'mock', 'explicit test mode still gives the mock gateway');
  const prod = await run({ NODE_ENV: 'production', PAYMENT_MOCK: 'true', RAZORPAY_KEY_ID: '' }, `
    require('./src/services/payments.js').createOrder({ amount: 10, idempotencyKey: 'k' })
      .then(g => console.log('created ' + g.gateway)).catch(e => console.log('refused'));`);
  assert.strictEqual(prod.out, 'refused', 'production without keys never mocks');
});
