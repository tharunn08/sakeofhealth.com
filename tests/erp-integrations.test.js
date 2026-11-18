/**
 * Integrations and hardening (TEST database + a local fake MSG91 server):
 *  - salesman order codes go by SMS through MSG91 (DLT template), the code is erased from the queue once sent,
 *    delivery reports need the secret token, replays are refused;
 *  - SMS without a gateway is never reported as "sent" (it used to be);
 *  - B2B online payment refuses the mock gateway unless explicitly in test mode.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { setup } = require('./helpers/erp.js');

const TOKEN = 'msg91-webhook-token-0123456789abcdef';
let c, s, fake, fakeUrl;
const sent = [];
const S = {};

test.before(async () => {
  fake = http.createServer(function (req, res) {
    let b = ''; req.on('data', function (d) { b += d; }); req.on('end', function () {
      const j = JSON.parse(b || '{}');
      sent.push({ path: req.url, authkey: req.headers.authkey, body: j });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'success', message: 'req-' + sent.length }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = 'http://127.0.0.1:' + fake.address().port;
  const env = { MSG91_AUTH_KEY: 'test-auth-key', MSG91_TEMPLATE_ORDER_OTP: 'tmpl-otp-1', MSG91_BASE_URL: fakeUrl, MSG91_WEBHOOK_TOKEN: TOKEN };
  Object.assign(process.env, env);
  c = await setup(env); s = c.s;
  const ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  S.w = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, priority, is_active) VALUES ('W', 'Main', ?, 1, 1)", [ka])).insertId);
  S.p = Number((await c.db.query("INSERT INTO b2b_products (sku, name, gst_rate, mrp, base_price, retailer_price, moq, case_qty, is_active, avail_retailer) VALUES ('P1', 'Product', 5, 90, 60, 74.53, 1, 1, 1, 1)")).insertId);
  await c.db.query('INSERT INTO b2b_stock (warehouse_id, product_id, qty_available) VALUES (?, ?, 100)', [S.w, S.p]);
  S.t = Number((await c.db.query("INSERT INTO b2b_territories (code, name, level, is_active, created_by) VALUES ('T', 'T', 'area', 1, ?)", [c.maker.id])).insertId);
  S.r = Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, contact_person, mobile, address_line1, city, pincode, state_id, district_name, territory_id, first_order_done) " +
    "VALUES ('retailer', 'approved', 'Shop', 'Owner', '9845033333', 'Road', 'Bengaluru', '560001', ?, 'Bengaluru Urban', ?, 1)", [ka, S.t])).insertId);
  S.sm = await c.person('sm', [{ code: 'salesman', scopeType: 'territory', scopeId: S.t }]);
  await c.db.query('INSERT INTO b2b_salesmen (staff_id, home_territory_id, cash_limit, is_active) VALUES (?, ?, 1000, 1)', [S.sm.id, S.t]);
  await c.setting('sales.otp', { length: 6, expiry_min: 10, max_attempts: 3, resend_cooldown_s: 30, max_resends: 2, stock_hold_min: 30 });
});
test.after(async () => { if (c) await c.stop(); if (fake) fake.close(); });

test('order code by MSG91 SMS: DLT template, code erased after sending, verify works', async () => {
  const o = await s.post('/api/sales/orders', { retailerId: S.r, paymentMethod: 'upi', clientUuid: crypto.randomUUID(), items: [{ productId: S.p, qty: 2 }] }, S.sm.h);
  assert.equal(o.status, 201, JSON.stringify(o.data)); assert.equal(o.data.delivery, 'queued');
  S.order = o.data.orderId;
  const q = await c.db.queryOne("SELECT * FROM b2b_notification_queue WHERE ref_type = 'otp'");
  assert.equal(q.channel, 'sms'); assert.equal(q.template_name, 'order_otp');
  const notify = require('../src/modules/b2b/notifications/service.js');
  await notify.processDue(10);
  const call = sent.find((x) => x.body.template_id === 'tmpl-otp-1');
  assert.ok(call, 'MSG91 flow API called'); assert.equal(call.path, '/api/v5/flow/'); assert.equal(call.authkey, 'test-auth-key');
  assert.equal(call.body.recipients[0].mobiles, '919845033333');
  const code = call.body.recipients[0].otp;
  assert.match(code, /^\d{6}$/);
  const after = await c.db.queryOne('SELECT status, body, template_params_json, provider_message_id, delivery_status FROM b2b_notification_queue WHERE id = ?', [q.id]);
  assert.equal(after.status, 'sent'); assert.equal(after.template_params_json, null); assert.doesNotMatch(after.body, /\d{6}/);
  S.req = after.provider_message_id; assert.ok(S.req);
  const ok = await s.post('/api/sales/orders/' + S.order + '/otp/verify', { code: code }, S.sm.h);
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.status, 'assigned');
});

test('MSG91 delivery reports: secret token, replay refused, status never goes backwards', async () => {
  const post = (tok, body) => fetch(s.base + '/api/webhooks/msg91?token=' + encodeURIComponent(tok), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
  assert.equal(await post('wrong-token-wrong-token-wrong', [{ requestId: S.req, status: 'Delivered' }]), 401);
  assert.equal(await post(TOKEN, [{ requestId: S.req, status: 'Delivered' }]), 200);
  assert.equal(await post(TOKEN, [{ requestId: S.req, status: 'Delivered' }]), 200);
  assert.equal(await post(TOKEN, { data: [{ requestId: S.req, status: '8' }] }), 200);
  const q = await c.db.queryOne('SELECT delivery_status FROM b2b_notification_queue WHERE provider_message_id = ?', [S.req]);
  assert.equal(q.delivery_status, 'delivered');
  const ch = await c.db.queryOne('SELECT delivery_status FROM b2b_otp_challenges WHERE order_id = ?', [S.order]);
  assert.equal(ch.delivery_status, 'delivered');
  const ev = await c.db.query("SELECT outcome FROM b2b_webhook_events WHERE provider = 'msg91' ORDER BY id");
  assert.deepEqual(ev.map((e) => e.outcome), ['processed', 'stale']);
});

test('SMS without a gateway is never marked sent', async () => {
  await c.db.query("INSERT INTO b2b_notification_queue (channel, recipient, body, template_name) VALUES ('sms', '9845044444', 'hello', 'no_such_template')");
  await c.db.query("INSERT INTO b2b_notification_queue (channel, recipient, body) VALUES ('sms', '9845044444', 'hello no template')");
  await require('../src/modules/b2b/notifications/service.js').processDue(10);
  const rows = await c.db.query("SELECT status FROM b2b_notification_queue WHERE recipient = '9845044444'");
  assert.deepEqual(rows.map((r) => r.status), ['skipped_no_provider', 'skipped_no_provider']);
});

test('shop feed: off until decided; then reads shop orders read-only, records lines once, reversals, never touches stock or the shop file', async () => {
  const fs = require('fs'), path = require('path');
  const file = path.join(s.dataDir, 'orders.json');
  await c.db.query("UPDATE b2b_products SET b2c_ref = 'shop-p1' WHERE id = ?", [S.p]);
  const now = new Date().toISOString();
  const orders = [{ _id: 'o1', orderId: 'SOH-1', createdAt: now, status: 'pending', items: [{ id: 'shop-p1', qty: 3 }, { id: 'unknown-x', qty: 1 }] },
    { _id: 'o2', orderId: 'SOH-2', createdAt: now, status: 'cancelled', items: [{ id: 'shop-p1', qty: 2 }] }];
  const prev = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.writeFileSync(file, JSON.stringify(orders));
  const before = fs.readFileSync(file, 'utf8');
  const stockBefore = await c.db.queryOne('SELECT qty_available, qty_reserved FROM b2b_stock WHERE product_id = ?', [S.p]);
  const wm = await c.person('feedwm', ['warehouse_manager']);
  assert.equal((await s.post('/api/erp/inventory/b2c-feed/run', {}, wm.h)).data.code, 'feed_off');
  await c.setting('b2c.feed.enabled', true);
  const r1 = await s.post('/api/erp/inventory/b2c-feed/run', {}, wm.h);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.deepEqual([r1.data.posted, r1.data.unmapped, r1.data.reversed], [2, 1, 1]);
  const r2 = await s.post('/api/erp/inventory/b2c-feed/run', {}, wm.h);
  assert.deepEqual([r2.data.posted, r2.data.unmapped, r2.data.reversed], [0, 0, 0], 'each line is recorded once');
  const rep = await s.get('/api/erp/inventory/b2c-feed', wm.h);
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  assert.equal(Number(rep.data.items[0].shop_units), 3, '3 + 2 sold, 2 cancelled');
  assert.match(rep.data.warning, /cannot prevent shop overselling/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'shop file untouched');
  assert.deepEqual(await c.db.queryOne('SELECT qty_available, qty_reserved FROM b2b_stock WHERE product_id = ?', [S.p]), stockBefore, 'stock untouched');
  if (prev) fs.writeFileSync(file, prev); else fs.unlinkSync(file);
});

test('B2B online payment: the mock gateway is refused unless explicitly in non-production test mode', async () => {
  const pay = require('../src/modules/b2b/payments/service.js');
  const save = { NODE_ENV: process.env.NODE_ENV, PAYMENT_MOCK: process.env.PAYMENT_MOCK, RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID };
  try {
    process.env.NODE_ENV = 'production'; delete process.env.PAYMENT_MOCK; delete process.env.RAZORPAY_KEY_ID;
    await assert.rejects(pay.gatewayInitiate(1, 1), /not available/);
    await assert.rejects(pay.gatewayConfirm({ gateway: 'mock', gatewayOrderId: 'mock_x', gatewayPaymentId: 'p', signature: 'anything' }), /verification failed/);
    process.env.PAYMENT_MOCK = 'true';   // still production → refused
    await assert.rejects(pay.gatewayConfirm({ gateway: 'mock', gatewayOrderId: 'mock_x', gatewayPaymentId: 'p', signature: 'x' }), /verification failed/);
  } finally {
    Object.keys(save).forEach((k) => { if (save[k] == null) delete process.env[k]; else process.env[k] = save[k]; });
  }
});
