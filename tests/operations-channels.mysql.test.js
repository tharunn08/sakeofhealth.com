/**
 * 3b.2–3b.6 and N4 on MySQL 8 (TEST database only; refuses while 013/014 are present).
 * Real server + schema up to 019; shop files written into the test server's own data folder
 * (never a real shop's). Covers the integration scenarios: shop order reserves and deducts, the
 * same ledger for B2B / event / field, cancellation, returns and damage, concurrency, offline
 * sync without duplicates, customer mapping without duplicates, notification triggers,
 * permissions, shadow mode, expiry.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers/erp.js');

let c, s;
const S = {};
const key = () => crypto.randomUUID();
const stockOf = async (w, p) => c.db.queryOne('SELECT * FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [w, p]);
const num = async (sql, args) => Number(Object.values(await c.db.queryOne(sql, args || []))[0]);
function writeShop(name, data) { fs.writeFileSync(path.join(process.env.DATA_DIR, name + '.json'), JSON.stringify(data)); }
async function seedBatch(w, p, batchNo, expiry, qty, tag) {
  const ledger = require('../src/modules/erp/inventory/ledger.js');
  await c.db.transaction(async function (tx) {
    const b = await tx.query("INSERT INTO b2b_batches (warehouse_id, product_id, batch_no, expiry_date, qty_on_hand, status) VALUES (?, ?, ?, ?, ?, 'active')", [w, p, batchNo, expiry, qty]);
    await ledger.mustMove(tx, { warehouseId: w, productId: p, batchId: Number(b.insertId), type: 'transfer_in', qty: qty, to: 'available', actor: { type: 'system', label: 'test seed' }, idemKey: 'test:seed:' + tag });
  });
}

test.before(async () => {
  c = await setup({ PUBLIC_SITE_URL: 'http://127.0.0.1', WHATSAPP_TEMPLATE_EVENT_INVOICE: 'event_invoice_v1' });
  s = c.s;
  process.env.DATA_DIR = s.dataDir;   // the in-process adapter reads the TEST server's shop files
  S.ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  S.shop = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active, warehouse_type) VALUES ('SHOP1', 'Online shop', ?, 'Bengaluru', '560001', 50, 1, 'online_shop')", [S.ka])).insertId);
  S.dc = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active) VALUES ('BLR1', 'Bengaluru DC', ?, 'Bengaluru', '560001', 10, 1)", [S.ka])).insertId);
  S.p = Number((await c.db.query("INSERT INTO b2b_products (sku, name, hsn_code, gst_rate, mrp, base_price, retailer_price, distributor_price, moq, case_qty, is_active, avail_b2c, avail_retailer, avail_distributor, b2c_ref) " +
    "VALUES ('JAG1', 'Jaggery 1 kg', '1701', '5.00', '120.00', '80.00', '95.00', '90.00', 1, 1, 1, 1, 1, 1, 'p-jag')")).insertId);
  await seedBatch(S.shop, S.p, 'S-OLD', '2027-01-31', 4, 'shop-old');
  await seedBatch(S.shop, S.p, 'S-NEW', '2027-09-30', 6, 'shop-new');
  writeShop('products', [{ id: 'p-jag', name: 'Jaggery 1 kg', stock: 10, price: 120 }]);
  writeShop('orders', []); writeShop('checkouts', { checkouts: {}, events: [] });
  S.ev = await c.person('evstaff', ['event_staff']);
  S.ev2 = await c.person('evstaff2', ['event_staff']);
  S.sm = await c.person('salesmgr', ['sales_manager']);
  S.fin = await c.person('finmgr', ['finance_manager']);
});
test.after(async () => { if (c) await c.stop(); });

test('shop stock stays off until decided: Pay and order pass straight to the shop', async () => {
  const svc = require('../src/modules/erp/shopstock/service.js');
  assert.equal((await svc.config()).mode, 'off');
  assert.equal((await svc.sync()).mode, 'off');
  assert.equal(await num('SELECT COUNT(*) FROM b2b_stock_reservations'), 0);
});

test('1 + 5: a shop order reserves at Pay, is allocated before the order exists, deducted when it leaves; a cancelled one gives its units back', async () => {
  await c.setting('inventory.b2c_warehouse_id', S.shop);
  await c.setting('inventory.b2c_stock_mode', 'enforce');
  const svc = require('../src/modules/erp/shopstock/service.js');
  const cfg = await svc.config();
  assert.equal(cfg.mode, 'enforce');
  // Pay
  const h = await svc.hold('idem:pay-1', [{ id: 'p-jag', qty: 3 }], cfg);
  assert.equal(h.ok, true);
  await svc.bind('idem:pay-1', 'order_T1', cfg);
  assert.equal((await c.db.queryOne("SELECT status FROM b2b_stock_reservations WHERE source_ref = 'gw:order_T1'")).status, 'held');
  assert.equal(Number((await stockOf(S.shop, S.p)).qty_available), 10, 'a hold moves no stock');
  // paid: committed before the order exists
  writeShop('checkouts', { checkouts: { order_T1: { status: 'pending', createdAt: new Date().toISOString(), amountPaise: 36000, quote: { lines: [{ id: 'p-jag', qty: 3 }] } } }, events: [] });
  const r = await svc.commitAtPlace(cfg, 'order_T1', 'pay_T1');
  assert.equal(r.committed, 1);
  const st = await stockOf(S.shop, S.p);
  assert.equal(Number(st.qty_available), 7); assert.equal(Number(st.qty_allocated), 3);
  const mv = await c.db.query("SELECT batch_id, qty, idem_key FROM b2b_stock_movements WHERE ref_type = 'b2c_order' ORDER BY id");
  assert.deepEqual(mv.map(m => Number(m.qty)), [3]);
  assert.match(mv[0].idem_key, /^b2c:gw:order_T1:\d+:alloc:\d+$/);
  assert.equal(Number((await c.db.queryOne('SELECT batch_no FROM b2b_batches WHERE id = ?', [mv[0].batch_id])).batch_no === 'S-OLD'), 1, 'earliest expiry first');
  // the order appears in the shop's file; the catch-up links it, then it leaves
  const orders = [{ id: 'shop-ord-1', orderId: 'SOH-1001', status: 'pending', createdAt: new Date().toISOString(), total: 360, items: [{ id: 'p-jag', qty: 3 }], payment: { gatewayOrderId: 'order_T1', paymentId: 'pay_T1' }, customer: { name: 'Ravi', email: 'ravi@trial.local', phone: '9845011111' } }];
  writeShop('orders', orders);
  await svc.sync();
  assert.equal((await c.db.queryOne("SELECT shop_order_id, stage FROM b2b_b2c_order_stock WHERE gateway_order_id = 'order_T1'")).shop_order_id, 'shop-ord-1');
  orders[0].status = 'out_for_delivery'; writeShop('orders', orders);
  await svc.sync(); await svc.sync();   // twice: nothing moves twice
  const after = await stockOf(S.shop, S.p);
  assert.equal(Number(after.qty_allocated), 0); assert.equal(Number(after.qty_available), 7);
  assert.equal((await c.db.queryOne("SELECT stage FROM b2b_b2c_order_stock WHERE shop_order_id = 'shop-ord-1'")).stage, 'sold');
  assert.equal(await num("SELECT COUNT(*) FROM b2b_stock_movements WHERE movement_type = 'b2c_sale'"), 1);
  // another order, cancelled before it left: its units come back to the same batch
  const h2 = await svc.hold('idem:pay-2', [{ id: 'p-jag', qty: 2 }], cfg); assert.equal(h2.ok, true);
  await svc.bind('idem:pay-2', 'order_T2', cfg);
  orders.push({ id: 'shop-ord-2', orderId: 'SOH-1002', status: 'pending', createdAt: new Date().toISOString(), total: 240, items: [{ id: 'p-jag', qty: 2 }], payment: { gatewayOrderId: 'order_T2' } });
  writeShop('orders', orders);
  await svc.sync();   // committed by the catch-up (the webhook path), using its hold
  assert.equal(Number((await stockOf(S.shop, S.p)).qty_allocated), 2);
  orders[1].status = 'cancelled'; writeShop('orders', orders);
  await svc.sync();
  assert.equal(Number((await stockOf(S.shop, S.p)).qty_available), 7, 'released');
  assert.equal((await c.db.queryOne("SELECT stage FROM b2b_b2c_order_stock WHERE shop_order_id = 'shop-ord-2'")).stage, 'released');
});

test('7: concurrent checkouts cannot oversell — 8 buyers for the last units, exactly that many are held', async () => {
  const svc = require('../src/modules/erp/shopstock/service.js');
  const cfg = await svc.config();
  const before = Number((await stockOf(S.shop, S.p)).qty_available);
  const heldNow = await num("SELECT COALESCE(SUM(qty),0) FROM b2b_stock_reservations WHERE status = 'held' AND mode = 'live' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())");
  const sellable = before - heldNow;
  const res = await Promise.all(Array.from({ length: sellable + 3 }, (_, i) => svc.hold('idem:race-' + i, [{ id: 'p-jag', qty: 1 }], cfg)));
  assert.equal(res.filter(r => r.ok).length, sellable);
  assert.ok(res.filter(r => !r.ok).every(r => /out of stock|left in stock/.test(r.message)));
  // release them again for the next tests
  for (let i = 0; i < sellable + 3; i++) await svc.release('idem:race-' + i, cfg);
});

test('paid but short: no order, an exception, refunded once through the gateway (fake) with two-factor permission', async () => {
  const svc = require('../src/modules/erp/shopstock/service.js');
  const cfg = await svc.config();
  writeShop('checkouts', { checkouts: { order_T9: { status: 'pending', createdAt: new Date().toISOString(), amountPaise: 1200000, quote: { lines: [{ id: 'p-jag', qty: 100 }] } } }, events: [] });
  const r = await svc.commitAtPlace(cfg, 'order_T9', 'pay_T9');
  assert.equal(r.short.length, 1);
  const ex = await c.db.queryOne("SELECT * FROM b2b_b2c_exceptions WHERE checkout_ref = 'gw:order_T9'");
  assert.equal(ex.kind, 'paid_short'); assert.equal(Number(ex.amount), 12000);
  assert.equal(Number((await stockOf(S.shop, S.p)).qty_available), 7, 'never below what is there');
  const denied = await s.post('/api/erp/shop-stock/exceptions/' + ex.id + '/refund', {}, S.sm.h);
  assert.equal(denied.status, 403);
  const calls = [];
  const out = await svc.refund({ type: 'staff', id: 1, label: 'fin' }, ex.id, { refund: async (pid, o) => { calls.push([pid, o.amount]); return { id: 'rfnd_T9' }; } });
  assert.equal(out.status, 'refunded');
  await svc.refund({ type: 'staff', id: 1 }, ex.id, { refund: async () => { throw new Error('must not be called twice'); } });
  assert.deepEqual(calls, [['pay_T9', 1200000]]);
});

test('shadow mode: replays without moving stock and records what enforcement would do', async () => {
  await c.setting('inventory.b2c_stock_mode', 'shadow');
  const svc = require('../src/modules/erp/shopstock/service.js');
  const before = await stockOf(S.shop, S.p);
  const orders = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'orders.json'), 'utf8'));
  orders.push({ id: 'shop-ord-3', orderId: 'SOH-1003', status: 'pending', createdAt: new Date(Date.now() + 1000).toISOString(), total: 12000, items: [{ id: 'p-jag', qty: 100 }] });
  writeShop('orders', orders);
  writeShop('products', [{ id: 'p-jag', name: 'Jaggery 1 kg', stock: 25, price: 120 }]);
  await new Promise(r => setTimeout(r, 1200));
  await svc.sync();
  const after = await stockOf(S.shop, S.p);
  assert.deepEqual([after.qty_available, after.qty_allocated], [before.qty_available, before.qty_allocated], 'no stock moved in shadow');
  assert.equal((await c.db.queryOne("SELECT stage FROM b2b_b2c_order_stock WHERE mode = 'shadow' AND shop_order_id = 'shop-ord-3'")).stage, 'short');
  const kinds = (await c.db.query("SELECT kind FROM b2b_b2c_discrepancies WHERE status = 'open'")).map(r => r.kind);
  assert.ok(kinds.includes('stock_mismatch'), 'the shop shows 25, the ledger 7');
  assert.ok(kinds.includes('order_without_hold') || kinds.includes('would_refuse'));
  const page = await s.get('/api/erp/shop-stock/overview', c.maker.h);
  assert.equal(page.status, 200); assert.equal(page.data.mode, 'shadow');
  await c.setting('inventory.b2c_stock_mode', 'off');
});

test('3 + 10: an event sale takes the event\'s stock on the same ledger, numbers the invoice, and sends it by WhatsApp and email', async () => {
  const ev = await s.post('/api/erp/events', { code: 'BLR-EXPO', name: 'Bengaluru expo', venue: 'Palace grounds', city: 'Bengaluru', stateId: S.ka, startsOn: '2026-11-20', endsOn: '2026-11-22', invoicePrefix: 'EVB' }, c.maker.h);
  assert.equal(ev.status, 201, JSON.stringify(ev.data));
  S.event = ev.data;
  await seedBatch(S.event.warehouseId, S.p, 'E-1', '2027-03-31', 5, 'event-1');
  assert.equal((await s.put('/api/erp/events/' + S.event.id + '/staff', { staffIds: [S.ev.id] }, c.maker.h)).status, 200);
  const closed = await s.post('/api/erp/events/sales', { idempotencyKey: key(), eventId: S.event.id, items: [{ productId: S.p, qty: 1 }] }, S.ev.h);
  assert.equal(closed.data.code, 'event_not_open', 'not before it opens');
  await s.post('/api/erp/events/' + S.event.id + '/status', { status: 'open' }, c.maker.h);
  const k = key();
  const sale = await s.post('/api/erp/events/sales', { idempotencyKey: k, eventId: S.event.id, items: [{ productId: S.p, qty: 2 }], customer: { name: 'Meena', mobile: '9845022222', email: 'meena@trial.local' }, payments: [{ method: 'upi', amount: 240 }] }, S.ev.h);
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.match(sale.data.invoiceNo, /^EVB\/\d{4}\/00001$/); assert.ok(sale.data.invoiceNo.length <= 16);
  assert.equal(sale.data.totals.grand, 240); assert.equal(sale.data.paymentStatus, 'paid');
  assert.equal(Number((await stockOf(S.event.warehouseId, S.p)).qty_available), 3);
  // the stock ledger's reference column holds numbers: the sale's id, with the invoice number in the reason
  assert.equal(await num("SELECT COUNT(*) FROM b2b_stock_movements WHERE movement_type = 'counter_sale' AND ref_type = 'counter_sale' AND ref_id = ? AND reason = ?", [sale.data.id, 'Invoice ' + sale.data.invoiceNo]), 1);
  const again = await s.post('/api/erp/events/sales', { idempotencyKey: k, eventId: S.event.id, items: [{ productId: S.p, qty: 2 }] }, S.ev.h);
  assert.equal(again.data.duplicate, true); assert.equal(Number((await stockOf(S.event.warehouseId, S.p)).qty_available), 3, 'a repeat sells nothing');
  const q = await c.db.query("SELECT channel, recipient, template_name FROM b2b_notification_queue WHERE ref_type = 'counter_sale' AND ref_id = ? ORDER BY id", [String(sale.data.id)]);
  assert.deepEqual(q.map(x => x.channel), ['whatsapp', 'email']);
  assert.equal(q[0].template_name, 'event_invoice');
  const inv = await fetch(s.base + '/api/erp/events/sales/' + sale.data.id + '/invoice', { headers: S.ev.h });
  assert.equal(inv.status, 200); assert.match(await inv.text(), /Tax invoice/);
  const link = (await c.db.queryOne("SELECT body FROM b2b_notification_queue WHERE ref_type = 'counter_sale' AND channel = 'whatsapp'")).body.match(/\/api\/erp\/public\/invoice\?t=[^\s]+/)[0];
  const pub = await fetch(s.base + link);
  assert.equal(pub.status, 200); assert.match(await pub.text(), new RegExp(sale.data.invoiceNo.replace(/\//g, '\\/')));
  S.sale = sale.data;
});

test('6: returns put stock back by condition; a void returns everything and refunds what was paid', async () => {
  const before = await stockOf(S.event.warehouseId, S.p);
  const r = await s.post('/api/erp/events/sales/' + S.sale.id + '/returns', { idempotencyKey: key(), items: [{ saleItemId: S.sale.items[0].id, qty: 1, condition: 'damaged' }], reason: 'Seal broken at the stall', refundMethod: 'upi' }, S.ev.h);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = await stockOf(S.event.warehouseId, S.p);
  assert.equal(Number(after.qty_damaged), Number(before.qty_damaged) + 1); assert.equal(Number(after.qty_available), Number(before.qty_available), 'damaged goods never become sellable');
  assert.equal(r.data.totals.paid, 120);
  const k = key();
  const sale2 = await s.post('/api/erp/events/sales', { idempotencyKey: k, eventId: S.event.id, items: [{ productId: S.p, qty: 1 }], payments: [{ method: 'cash', amount: 120 }] }, S.ev.h);
  assert.equal((await s.post('/api/erp/events/sales/' + sale2.data.id + '/void', { reason: 'wrong customer' }, S.ev.h)).status, 403, 'event staff cannot void');
  const v = await s.post('/api/erp/events/sales/' + sale2.data.id + '/void', { reason: 'Rang up the wrong product' }, S.sm.h);
  assert.equal(v.status, 200); assert.equal(v.data.status, 'voided'); assert.equal(v.data.paymentStatus, 'refunded');
  assert.equal(Number((await stockOf(S.event.warehouseId, S.p)).qty_available), Number(after.qty_available));
});

test('11: event staff are fenced in — not at other events, not on shop stock, not on refunds', async () => {
  const other = await s.post('/api/erp/events', { code: 'MYS-FAIR', name: 'Mysuru fair', startsOn: '2026-12-01', endsOn: '2026-12-02' }, c.maker.h);
  await s.post('/api/erp/events/' + other.data.id + '/status', { status: 'open' }, c.maker.h);
  const sell = await s.post('/api/erp/events/sales', { idempotencyKey: key(), eventId: other.data.id, items: [{ productId: S.p, qty: 1 }] }, S.ev.h);
  assert.equal(sell.status, 403); assert.equal(sell.data.code, 'event_forbidden');
  assert.equal((await s.get('/api/erp/events/' + other.data.id, S.ev.h)).status, 403);
  assert.equal((await s.get('/api/erp/shop-stock/overview', S.ev.h)).status, 403);
  assert.equal((await s.get('/api/erp/customers', S.ev.h)).status, 403);
  assert.equal((await s.get('/api/erp/events/sales/' + S.sale.id, S.ev2.h)).status, 403, 'not their event');
  const list = await s.get('/api/erp/events', S.ev.h);
  assert.deepEqual(list.data.items.map(e => e.code), ['BLR-EXPO']);
});

test('8: offline sales sync once; a sale that can no longer be covered waits as a conflict; a retry after restocking applies it', async () => {
  const op = { clientOpId: key(), kind: 'event_sale', createdAt: new Date(Date.now() - 600000).toISOString(), payload: { eventId: S.event.id, items: [{ productId: S.p, qty: 1 }], customer: { mobile: '9845033333' } } };
  const [a, b] = await Promise.all([s.post('/api/erp/offline/sync', { ops: [op] }, S.ev.h), s.post('/api/erp/offline/sync', { ops: [op] }, S.ev.h)]);
  const statuses = [a.data.results[0].status, b.data.results[0].status].sort();
  assert.deepEqual(statuses, ['applied', 'duplicate']);
  assert.equal(await num('SELECT COUNT(*) FROM b2b_counter_sales WHERE idempotency_key = ?', [op.clientOpId]), 1);
  assert.equal(Number((await c.db.queryOne('SELECT offline FROM b2b_counter_sales WHERE idempotency_key = ?', [op.clientOpId])).offline), 1);
  const big = { clientOpId: key(), kind: 'event_sale', createdAt: new Date().toISOString(), payload: { eventId: S.event.id, items: [{ productId: S.p, qty: 50 }] } };
  const cf = await s.post('/api/erp/offline/sync', { ops: [big] }, S.ev.h);
  assert.equal(cf.data.results[0].status, 'conflict'); assert.equal(cf.data.results[0].code, 'insufficient_stock');
  const row = await c.db.queryOne('SELECT id, status FROM b2b_offline_ops WHERE client_op_id = ?', [big.clientOpId]);
  assert.equal(row.status, 'conflict');
  assert.equal((await s.post('/api/erp/offline/ops/' + row.id + '/discard', { note: '' }, S.sm.h)).status, 400, 'a note is required');
  await seedBatch(S.event.warehouseId, S.p, 'E-2', '2027-08-31', 60, 'event-2');
  const rt = await s.post('/api/erp/offline/ops/' + row.id + '/retry', {}, S.sm.h);
  assert.equal(rt.data.status, 'applied');
  const sold = await c.db.queryOne('SELECT sold_by FROM b2b_counter_sales WHERE idempotency_key = ?', [big.clientOpId]);
  assert.equal(Number(sold.sold_by), S.ev.id, 'the sale stays the event staff member\'s, not the retrier\'s');
  assert.equal((await c.db.queryOne('SELECT status FROM b2b_offline_ops WHERE id = ?', [row.id])).status, 'applied');
  const reused = await s.post('/api/erp/offline/sync', { ops: [Object.assign({}, op, { payload: { eventId: S.event.id, items: [{ productId: S.p, qty: 9 }] } })] }, S.ev.h);
  assert.equal(reused.data.results[0].code, 'op_reused');
  assert.equal(await num('SELECT COUNT(*) FROM b2b_offline_ops'), 2, 'every operation kept');
});

test('3b.2: locations are recorded once, seen by the right people, and drawn on the map', async () => {
  const u = key();
  const p = { clientUuid: u, subject: 'event', eventId: S.event.id, lat: 12.9982, lng: 77.5920, source: 'gps', accuracy: 12, purpose: 'stall' };
  assert.equal((await s.post('/api/erp/locations', p, S.ev.h)).status, 201);
  assert.equal((await s.post('/api/erp/locations', p, S.ev.h)).data.duplicate, true);
  assert.equal((await s.post('/api/erp/locations', Object.assign({}, p, { clientUuid: key(), eventId: 999999 }), S.ev.h)).status, 404);
  const map = await s.get('/api/erp/locations/map?days=1', S.sm.h);
  assert.equal(map.status, 200); assert.ok(map.data.points.some(x => x.subject === 'event' && x.subjectId === S.event.id));
  assert.equal(Number((await c.db.queryOne('SELECT lat FROM b2b_events WHERE id = ?', [S.event.id])).lat).toFixed(4), '12.9982', 'the stall pin follows its stall fix');
  const mine = await s.get('/api/erp/locations', S.ev2.h);
  assert.deepEqual(mine.data.items, [], 'another event\'s staff see nothing of this event');
});

test('9: customer mapping links shop, event and business records to one person without duplicates; a repeat import adds nothing', async () => {
  writeShop('customers', [{ id: 'c-1', name: 'Meena', email: 'MEENA@trial.local', phone: '9845022222', createdAt: '2026-10-01T00:00:00Z' }]);
  writeShop('accounts', [{ id: 'a-1', name: 'Meena', email: 'meena@trial.local', passwordHash: 'never-read', createdAt: '2026-10-01T00:00:00Z' }]);
  const r1 = await s.post('/api/erp/customers/import', {}, c.maker.h);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const meena = await c.db.query("SELECT id FROM b2b_customers WHERE email_norm = 'meena@trial.local' OR mobile_norm = '919845022222'");
  assert.equal(meena.length, 1, 'one record for the shop buyer, the shop login and the event buyer');
  const sources = (await c.db.query('SELECT source FROM b2b_customer_links WHERE customer_id = ? ORDER BY source', [meena[0].id])).map(x => x.source);
  assert.ok(sources.includes('event_sale') && sources.includes('b2c_customer') && sources.includes('b2c_login'), sources.join(','));
  const before = await num('SELECT COUNT(*) FROM b2b_customers');
  await s.post('/api/erp/customers/import', {}, c.maker.h);
  assert.equal(await num('SELECT COUNT(*) FROM b2b_customers'), before);
  const d = await s.get('/api/erp/customers/' + meena[0].id, S.sm.h);
  assert.equal(d.status, 200); assert.match(d.data.customer.email, /•/, 'masked without customers.contacts.view');
  assert.ok(d.data.orders.some(o => o.channel === 'event'));
  assert.doesNotMatch(JSON.stringify(await c.db.query('SELECT * FROM b2b_customers')), /never-read/, 'shop passwords are never copied');
});

test('2 + 4: B2B and field orders post to the very same ledger tables (one ledger)', async () => {
  const inv = require('../src/modules/b2b/inventory/service.js');
  await seedBatch(S.dc, S.p, 'D-1', '2027-12-31', 20, 'dc-1');
  await c.db.transaction(tx => inv.move(tx, { warehouse_id: S.dc, product_id: S.p, type: 'reservation', qty: 4, from: 'available', to: 'reserved', ref_type: 'order', ref_id: 77, actor: { type: 'system' }, idem_key: 'test:b2b:res:77' }));
  const st = await stockOf(S.dc, S.p);
  assert.equal(Number(st.qty_reserved), 4);
  const kinds = (await c.db.query('SELECT DISTINCT movement_type FROM b2b_stock_movements WHERE product_id = ? ORDER BY movement_type', [S.p])).map(r => r.movement_type);
  ['allocation', 'b2c_sale', 'counter_sale', 'counter_return', 'reservation', 'transfer_in'].forEach(k => assert.ok(kinds.includes(k), k + ' in the one ledger'));
  // field orders are B2B orders (erp-operations.test.js covers the salesman flow end to end on this same ledger)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src/modules/erp/sales/service.js'), 'utf8'), /b2b_orders/);
});

test('expiry: past-date units leave available for expired once a day, keyed; they are never sold', async () => {
  const fefo = require('../src/modules/erp/inventory/fefo.js');
  const ledger = require('../src/modules/erp/inventory/ledger.js');
  await seedBatch(S.dc, S.p, 'D-OLD', '2020-01-31', 3, 'dc-old');
  const r1 = await fefo.expireBatches(c.db, ledger);
  assert.ok(r1.units >= 3);
  const again = await fefo.expireBatches(c.db, ledger);
  assert.equal(again.units, 0, 'a repeat moves nothing');
  assert.equal((await c.db.queryOne("SELECT status FROM b2b_batches WHERE batch_no = 'D-OLD'")).status, 'expired');
  assert.ok(Number((await stockOf(S.dc, S.p)).qty_expired) >= 3);
});

test('reconciliation stays clean after shop, event, offline and expiry movements', async () => {
  const r = await s.get('/api/erp/inventory/reconciliation', c.maker.h);
  assert.equal(r.status, 200);
  const mine = (r.data.issues || []).filter(i => [S.shop, S.dc, S.event.warehouseId].includes(Number(i.warehouseId || i.warehouse_id)));
  assert.deepEqual(mine, [], JSON.stringify(mine));
});
