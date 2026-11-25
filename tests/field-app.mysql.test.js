/**
 * The field app's salesman and delivery screens on MySQL 8 — TEST database only (the runner refuses anything
 * else). Real server, real APIs.
 *
 * Covers: one shop in full (what it owes, what can still be collected, what it usually buys, past orders and
 * visits, whose orders open in full) and the territory rule; the shop list's last order / last visit / due;
 * the salesman's own orders (by group, with the code state) and nobody else's; visits with a long note;
 * collections waiting for handover; the delivery person's finished deliveries (today / last N days) with
 * what the buyer still owes; permissions on every new endpoint.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup } = require('./helpers/erp.js');

let c, s;
const S = {};
const uuid = () => crypto.randomUUID();

/** An order row as the B2B flow leaves it (only the columns these screens read). */
async function order(buyer, o) {
  const id = Number((await c.db.query("INSERT INTO b2b_orders (order_no, buyer_account_id, buyer_type, seller_type, status, payment_method, payment_status, amount_paid, grand_total, taxable_total, tax_total, " +
    "item_count, total_qty, buyer_state_id, ship_name, ship_phone, ship_line1, ship_city, ship_state, ship_pincode, channel, salesman_id, created_at, reservation_expires_at) " +
    "VALUES (?, ?, 'retailer', 'company', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'Shop', '9845011111', 'MG Road', 'Bengaluru', 'Karnataka', '560001', ?, ?, UTC_TIMESTAMP() - INTERVAL ? DAY, ?)",
  [o.no, buyer, o.status, o.method || 'upi', o.paid >= o.total ? 'paid' : o.paid > 0 ? 'partial' : 'pending', o.paid || 0, o.total, (o.total / 1.05).toFixed(2), (o.total - o.total / 1.05).toFixed(2),
    o.qty || 10, S.ka, o.salesman ? 'salesman' : 'portal', o.salesman || null, o.daysAgo || 0, o.status === 'pending_otp' ? new Date(Date.now() + 1800000) : null])).insertId);
  await c.db.query("INSERT INTO b2b_order_items (order_id, product_id, sku, name, gst_rate, unit_price, qty, taxable_amount, line_total, price_source) VALUES (?, ?, 'BS500', 'Organic Brown Sugar 500 g', 5, 74.53, ?, ?, ?, ?)",
    [id, S.p, o.qty || 10, (o.total / 1.05).toFixed(2), o.total, null]);
  if (o.free) await c.db.query("INSERT INTO b2b_order_items (order_id, product_id, sku, name, gst_rate, unit_price, qty, taxable_amount, line_total, price_source) VALUES (?, ?, 'JG1000', 'Jaggery (free: scheme)', 5, 0, 2, 0, 0, 'scheme_free')", [id, S.p2]);
  return id;
}

test.before(async () => {
  c = await setup(); s = c.s;
  S.ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  S.t1 = Number((await c.db.query("INSERT INTO b2b_territories (code, name, level, state_id, is_active, created_by) VALUES ('KRM', 'Koramangala', 'area', ?, 1, ?)", [S.ka, c.maker.id])).insertId);
  S.t2 = Number((await c.db.query("INSERT INTO b2b_territories (code, name, level, state_id, is_active, created_by) VALUES ('MYS', 'Mysuru', 'area', ?, 1, ?)", [S.ka, c.maker.id])).insertId);
  const shop = async (name, mobile, terr) => Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, shop_name, contact_person, mobile, address_line1, city, pincode, state_id, district_name, territory_id, approved_at) " +
    "VALUES ('retailer', 'approved', ?, ?, 'Owner', ?, 'MG Road', 'Bengaluru', '560034', ?, 'Bengaluru Urban', ?, UTC_TIMESTAMP())", [name, name, mobile, S.ka, terr])).insertId);
  S.r1 = await shop('Ganesh Stores', '9845011111', S.t1);
  S.r2 = await shop('Mysuru Mart', '9845022222', S.t2);
  S.p = Number((await c.db.query("INSERT INTO b2b_products (sku, name, hsn_code, gst_rate, mrp, base_price, retailer_price, distributor_price, moq, case_qty, is_active, avail_b2c, avail_retailer, avail_distributor) " +
    "VALUES ('BS500', 'Organic Brown Sugar 500 g', '17010000', '5.00', '90.00', '63.49', '74.53', '69.01', 1, 1, 1, 0, 1, 1)")).insertId);
  S.p2 = Number((await c.db.query("INSERT INTO b2b_products (sku, name, hsn_code, gst_rate, mrp, base_price, retailer_price, distributor_price, moq, case_qty, is_active, avail_b2c, avail_retailer, avail_distributor) " +
    "VALUES ('JG1000', 'Jaggery 1 kg', '17011310', '5.00', '240.00', '150.00', '180.00', '170.00', 1, 1, 1, 0, 1, 1)")).insertId);
  S.sm = await c.person('ravi', [{ code: 'salesman', scopeType: 'territory', scopeId: S.t1 }]);
  S.sm2 = await c.person('kiran', [{ code: 'salesman', scopeType: 'territory', scopeId: S.t1 }]);
  S.drv = await c.person('suresh', ['delivery_staff']);
  S.smId = Number((await c.db.query('INSERT INTO b2b_salesmen (staff_id, employee_code, home_territory_id, cash_limit, is_active) VALUES (?, ?, ?, 20000, 1)', [S.sm.id, 'SM-01', S.t1])).insertId);
  S.sm2Id = Number((await c.db.query('INSERT INTO b2b_salesmen (staff_id, employee_code, home_territory_id, cash_limit, is_active) VALUES (?, ?, ?, 20000, 1)', [S.sm2.id, 'SM-02', S.t1])).insertId);
  // Ganesh Stores: a delivered order of Ravi's not paid yet (part of it collected, waiting for handover), one paid portal order, one waiting for its code, one of Kiran's
  S.o1 = await order(S.r1, { no: 'B2B2611-000901', status: 'delivered', total: 3150, paid: 0, salesman: S.smId, daysAgo: 12, qty: 40, free: true });
  S.o2 = await order(S.r1, { no: 'B2B2611-000902', status: 'delivered', total: 1050, paid: 1050, daysAgo: 30, qty: 10 });
  S.o3 = await order(S.r1, { no: 'B2B2611-000903', status: 'pending_otp', total: 780, paid: 0, salesman: S.smId, qty: 10 });
  S.o4 = await order(S.r1, { no: 'B2B2611-000904', status: 'processing', total: 500, paid: 0, salesman: S.sm2Id, qty: 6, method: 'credit' });
  await c.db.query("INSERT INTO b2b_payments (receipt_no, order_id, payer_account_id, method, amount, status, collected_by_salesman_id, received_at) VALUES ('RC-F-1', ?, ?, 'cash', 1000.00, 'pending', ?, UTC_TIMESTAMP())", [S.o1, S.r1, S.smId]);
  await c.db.query("INSERT INTO b2b_payments (receipt_no, order_id, payer_account_id, method, amount, status, collected_by_salesman_id, received_at) VALUES ('RC-F-2', ?, ?, 'upi', 1050.00, 'received', ?, UTC_TIMESTAMP() - INTERVAL 2 DAY)", [S.o2, S.r1, S.smId]);
});
test.after(async () => { if (c) await c.stop(); });

test('a visit with a long note (what the shop needs) is saved whole up to 500 characters and shows on the shop', async () => {
  const note = 'Needs: ' + 'twenty packs of jaggery powder and brown sugar before Friday; '.repeat(9);
  const v = await s.post('/api/sales/visits', { retailerId: S.r1, clientUuid: uuid(), outcome: 'no_order', note: note }, S.sm.h);
  assert.equal(v.status, 201, JSON.stringify(v.data));
  const row = await c.db.queryOne('SELECT note, outcome FROM b2b_visits WHERE id = ?', [v.data.visitId]);
  assert.equal(row.note.length, 500); assert.equal(row.outcome, 'no_order');
  assert.equal((await s.post('/api/sales/visits', { retailerId: S.r2, clientUuid: uuid(), outcome: 'no_order' }, S.sm.h)).status, 404, 'a shop outside the territory');
});

test('one shop in full: money owed, what can still be collected, usual items, orders (own ones open in full), visits, credit', async () => {
  const r = await s.get('/api/sales/retailers/' + S.r1, S.sm.h);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data;
  assert.equal(d.shop.name, 'Ganesh Stores'); assert.equal(d.shop.mobile, '9845011111'); assert.equal(d.shop.status, 'approved');
  assert.equal(d.money.due, 3650, 'delivered 3150 + processing 500; the code-pending and paid orders owe nothing');
  assert.equal(d.money.openOrders, 2);
  assert.equal(d.money.waitingHandover, 1000); assert.equal(d.money.waitingReceipts, 1);
  const o1 = d.dueOrders.find((o) => o.id === S.o1);
  assert.deepEqual([o1.due, o1.waiting, o1.collectable], [3150, 1000, 2150], 'collected cash waiting for handover is not collected twice');
  assert.ok(!d.dueOrders.some((o) => o.id === S.o3), 'an order waiting for its code is not owed');
  assert.deepEqual(d.orders.map((o) => o.id), [S.o4, S.o3, S.o2, S.o1]);
  assert.deepEqual(d.orders.map((o) => o.mine), [false, true, false, true], 'only the salesman\'s own orders open in full');
  assert.equal(d.orders.find((o) => o.id === S.o3).due, 0);
  assert.equal(d.usual.length, 1, 'free scheme lines are not "usual items"');
  assert.equal(d.usual[0].productId, S.p); assert.equal(d.usual[0].times, 3, 'the code-pending order is not history'); assert.equal(d.usual[0].usualQty, 19);
  assert.equal(d.visits[0].by, 'you'); assert.equal(d.visits[0].outcome, 'no_order');
  assert.ok(d.lastOrderAt && d.lastVisitAt);
  assert.ok(d.credit === null || typeof d.credit.available === 'number');
  assert.equal((await s.get('/api/sales/retailers/' + S.r2, S.sm.h)).status, 404, 'outside the territory');
  assert.equal((await s.get('/api/sales/retailers/' + S.r1, S.drv.h)).status, 403, 'delivery staff are not salesmen');
});

test('the shop list carries last order, last visit and what each shop owes', async () => {
  const r = await s.get('/api/sales/retailers', S.sm.h);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items.map((a) => a.id), [S.r1]);
  const a = r.data.items[0];
  assert.equal(a.due, 3650); assert.ok(a.last_order_at); assert.ok(a.last_visit_at);
});

test('my orders: by group with counts, the code state on one order, and never another salesman\'s', async () => {
  const all = await s.get('/api/sales/orders', S.sm.h);
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.deepEqual(all.data.items.map((o) => o.id), [S.o3, S.o1]);
  assert.equal(all.data.counts.code, 1); assert.equal(all.data.counts.delivered, 1); assert.equal(all.data.counts.due, 1);
  const code = await s.get('/api/sales/orders?filter=code', S.sm.h);
  assert.deepEqual(code.data.items.map((o) => o.id), [S.o3]);
  assert.ok(code.data.items[0].holdUntil);
  const bogus = await s.get('/api/sales/orders?filter=' + encodeURIComponent("code' OR 1=1 -- "), S.sm.h);
  assert.equal(bogus.status, 200); assert.equal(bogus.data.items.length, 2, 'an unknown group is ignored');
  const one = await s.get('/api/sales/orders/' + S.o1, S.sm.h);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.equal(one.data.lines.length, 2); assert.equal(one.data.payments.length, 1); assert.equal(one.data.due, 3150); assert.equal(one.data.code, null);
  assert.equal((await s.get('/api/sales/orders/' + S.o4, S.sm.h)).status, 404, 'Kiran\'s order');
  assert.deepEqual((await s.get('/api/sales/orders', S.sm2.h)).data.items.map((o) => o.id), [S.o4]);
});

test('my visits and my collections', async () => {
  const v = await s.get('/api/sales/visits', S.sm.h);
  assert.equal(v.status, 200); assert.equal(v.data.range, 'today'); assert.equal(v.data.items.length, 1); assert.equal(v.data.items[0].shop, 'Ganesh Stores');
  assert.equal((await s.get('/api/sales/visits?range=month', S.sm.h)).data.items.length, 1);
  assert.equal((await s.get('/api/sales/visits', S.sm2.h)).data.items.length, 0);
  const m = await s.get('/api/sales/collections', S.sm.h);
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.deepEqual(m.data.waiting, { cash: 1000, upi: 0, cheque: 0 });
  assert.equal(m.data.confirmed30d, 1050); assert.equal(m.data.cashLimit, 20000);
  assert.deepEqual(m.data.items.map((x) => x.receiptNo), ['RC-F-2', 'RC-F-1']);
  assert.equal((await s.get('/api/sales/collections', S.drv.h)).status, 403);
});

test('deliveries: open ones carry what the buyer still owes; "done" lists the driver\'s finished ones of the last N days', async () => {
  const ship = async (orderId, no, status, extra) => Number((await c.db.query('INSERT INTO b2b_shipments (shipment_no, order_id, seller_type, mode, vehicle_no, delivery_staff_id, status, delivered_at, created_by_type, created_by_id) ' +
    "VALUES (?, ?, 'company', 'own_vehicle', 'KA01AB1234', ?, ?, " + (extra || 'NULL') + ", 'staff', ?)", [no, orderId, S.drv.id, status, c.maker.id])).insertId);
  const oA = await order(S.r1, { no: 'B2B2611-000911', status: 'out_for_delivery', total: 2100, paid: 0, method: 'credit' });
  const oB = await order(S.r1, { no: 'B2B2611-000912', status: 'delivered', total: 400, paid: 400 });
  const oC = await order(S.r1, { no: 'B2B2611-000913', status: 'delivered', total: 300, paid: 0 });
  const a = await ship(oA, 'SH-T-1', 'out_for_delivery');
  const b = await ship(oB, 'SH-T-2', 'delivered', 'UTC_TIMESTAMP()');
  const old = await ship(oC, 'SH-T-3', 'delivered', 'UTC_TIMESTAMP() - INTERVAL 40 DAY');
  await c.db.query('UPDATE b2b_shipments SET updated_at = UTC_TIMESTAMP() - INTERVAL 40 DAY WHERE id = ?', [old]);
  const open = await s.get('/api/erp/deliveries?status=open', S.drv.h);
  assert.equal(open.status, 200, JSON.stringify(open.data));
  const x = open.data.items.find((i) => i.id === a);
  assert.deepEqual(x.payment, { method: 'credit', status: 'pending', paid: 0, due: 2100 });
  assert.equal(x.units, 10);
  const done = await s.get('/api/erp/deliveries?status=done', S.drv.h);
  assert.deepEqual(done.data.items.map((i) => i.id), [b], 'the last 30 days by default');
  assert.deepEqual((await s.get('/api/erp/deliveries?status=done&days=60', S.drv.h)).data.items.map((i) => i.id), [b, old]);
  assert.deepEqual((await s.get('/api/erp/deliveries?status=done&days=1', S.drv.h)).data.items.map((i) => i.id), [b]);
  const other = await c.person('driver2', ['delivery_staff']);
  assert.equal((await s.get('/api/erp/deliveries?status=done&days=60', other.h)).data.items.length, 0, 'only their own');
});
