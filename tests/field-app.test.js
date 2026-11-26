/**
 * The field app: salesman screens (one shop in full, my orders / visits / collections, the shop list's
 * extra columns, visit notes) and the delivery screens (finished deliveries, what the buyer still owes).
 *
 * DB-free: the services run against a scripted database (every statement is recorded and answered by the
 * test); the phone app is checked as the server sends it. The same flows on MySQL 8 are in
 * tests/field-app.mysql.test.js (needs the test database).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.ERP_JWT_SECRET = process.env.ERP_JWT_SECRET || 'test-erp-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const db = require('../src/db/connection.js');
const field = require('../src/modules/erp/sales/field.js');
const sales = require('../src/modules/erp/sales/service.js');
const orders = require('../src/modules/b2b/orders/service.js');
const payments = require('../src/modules/b2b/payments/service.js');

const SM = { id: 4, cash_limit: '20000.00', home_territory_id: 7 };
const P = { id: 9, name: 'Ravi', scopes: { territory: [7] }, permissions: new Set(['sales.self.view']) };
const SHOP = { id: 11, account_type: 'retailer', business_name: 'Ganesh Stores Pvt', shop_name: 'Ganesh Stores', contact_person: 'Ganesh', mobile: '9845011111', territory_id: 7, status: 'approved',
  address_line1: '14, 5th Cross', address_line2: null, landmark: 'Forum', city: 'Bengaluru', district_name: 'Bengaluru Urban', state_name: 'Karnataka', pincode: '560034', latitude: '12.9300000', longitude: '77.6100000' };

/** Replace db.query / db.queryOne with answers by pattern; records every statement. */
function script(answers) {
  const calls = [], realQ = db.query, realO = db.queryOne;
  const run = (kind) => async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params: params || [], kind });
    for (const a of answers) if (a[0].test(s)) return typeof a[1] === 'function' ? a[1](params || [], s) : a[1];
    return kind === 'one' ? null : [];
  };
  db.query = run('all'); db.queryOne = run('one');
  return { calls, find: (re) => calls.filter((c) => re.test(c.sql)), restore: () => { db.query = realQ; db.queryOne = realO; } };
}

test('one shop in full: what it owes, what can still be collected, usual items, own orders open in full, visits by "you", credit', async () => {
  const realSeller = orders.sellerFor, realCredit = payments.getCredit;
  orders.sellerFor = async () => ({ type: 'company', accountId: null });
  payments.getCredit = async (debtor, creditor) => { assert.deepEqual([debtor, creditor], [11, 0]); return { credit_limit: '25000.00', credit_used: '4520.00', available: '20480.00', credit_days: 15, is_active: true }; };
  const sc = script([
    [/FROM b2b_accounts a JOIN b2b_states/, SHOP],
    [/AS overdue/, { n: 2, due: '3650.00', overdue: '500.00', oldest_due: '2026-11-10' }],
    [/FROM b2b_payments WHERE payer_account_id/, { n: 1, v: '1000.00' }],
    [/FROM b2b_orders o WHERE o.buyer_account_id = \? ORDER BY o.id DESC LIMIT 10/, [
      { id: 3, order_no: 'B3', status: 'pending_otp', grand_total: '780.00', amount_paid: '0.00', item_count: 1, total_qty: 10, created_at: '2026-11-25T10:00:00Z', reservation_expires_at: '2026-11-25T10:30:00Z', salesman_id: 4 },
      { id: 2, order_no: 'B2', status: 'delivered', grand_total: '1050.00', amount_paid: '1050.00', item_count: 1, total_qty: 10, created_at: '2026-10-25T10:00:00Z', salesman_id: null, channel: 'portal' },
      { id: 1, order_no: 'B1', status: 'delivered', grand_total: '3150.00', amount_paid: '0.00', item_count: 1, total_qty: 40, created_at: '2026-11-13T10:00:00Z', salesman_id: 4 }]],
    [/AS waiting FROM b2b_orders o/, [{ id: 1, order_no: 'B1', status: 'delivered', grand_total: '3150.00', amount_paid: '0.00', created_at: 'x', waiting: '1000.00' }, { id: 5, order_no: 'B5', status: 'processing', grand_total: '500.00', amount_paid: '600.00', waiting: '0.00' }]],
    [/FROM b2b_visits v JOIN b2b_salesmen/, [{ id: 8, checked_in_at: 'today', outcome: 'no_order', note: 'Needs: jaggery', distance_m: 20, salesman: 'Ravi', salesman_id: 4 }, { id: 7, checked_in_at: 'before', outcome: 'order', note: null, distance_m: null, salesman: 'Kiran', salesman_id: 5 }]],
    [/FROM b2b_order_items oi JOIN b2b_orders x/, [{ product_id: 3, name: 'Brown Sugar', times: 3, qty: '56', last_at: 'x' }]],
    [/FROM b2b_beat_stops s JOIN b2b_beats b/, [{ id: 2, name: 'Koramangala', weekday: 2 }]],
  ]);
  try {
    const d = await field.retailer(P, SM, 11);
    assert.equal(d.shop.name, 'Ganesh Stores'); assert.equal(d.shop.businessName, 'Ganesh Stores Pvt'); assert.equal(d.shop.lat, 12.93); assert.equal(d.shop.address, '14, 5th Cross');
    assert.deepEqual(d.money, { due: 3650, overdue: 500, openOrders: 2, oldestDueDate: '2026-11-10', waitingHandover: 1000, waitingReceipts: 1 });
    assert.deepEqual(d.dueOrders.map((o) => [o.id, o.due, o.waiting, o.collectable]), [[1, 3150, 1000, 2150], [5, 0, 0, 0]], 'never negative; waiting cash is not collected twice');
    assert.deepEqual(d.orders.map((o) => [o.id, o.mine, o.due]), [[3, true, 0], [2, false, 0], [1, true, 3150]], 'an order waiting for its code owes nothing yet');
    assert.equal(d.orders[0].holdUntil, '2026-11-25T10:30:00Z');
    assert.equal(d.lastOrderAt, '2026-10-25T10:00:00Z', 'the code-pending order is not a real order yet');
    assert.deepEqual(d.visits.map((v) => v.by), ['you', 'Kiran']);
    assert.deepEqual(d.usual, [{ productId: 3, name: 'Brown Sugar', times: 3, qty: 56, usualQty: 19, lastAt: 'x' }]);
    assert.deepEqual(d.credit, { limit: 25000, used: 4520, available: 20480, days: 15, active: true, seller: 'company', sellerName: null });
    assert.deepEqual(d.beats, [{ id: 2, name: 'Koramangala', weekday: 2 }]);
    // the queries: owed = the B2B outstanding rule on this shop; free scheme lines are not "usual"; beats are this salesman's
    const owed = sc.find(/AS overdue/)[0];
    assert.match(owed.sql, /o\.status NOT IN \('cancelled','rejected','refunded','draft','pending_otp','otp_expired'\) AND o\.payment_status IN \('pending','partial'\)/);
    assert.deepEqual(owed.params, [11]);
    assert.match(sc.find(/FROM b2b_order_items oi/)[0].sql, /oi\.price_source <> 'scheme_free'/);
    assert.deepEqual(sc.find(/FROM b2b_beat_stops/)[0].params, [11, 4]);
    // the shop page still opens when credit cannot be read
    payments.getCredit = async () => { throw new Error('no credit table'); };
    assert.equal((await field.retailer(P, SM, 11)).credit, null);
  } finally { sc.restore(); orders.sellerFor = realSeller; payments.getCredit = realCredit; }
});

test('a shop outside the salesman\'s territory is not found (same rule as the list)', async () => {
  const sc = script([[/FROM b2b_accounts a JOIN b2b_states/, Object.assign({}, SHOP, { territory_id: 8 })]]);
  try {
    await assert.rejects(field.retailer(P, SM, 11), (e) => e.status === 404);
    assert.equal(sc.find(/FROM b2b_orders/).length, 0, 'nothing else is read');
  } finally { sc.restore(); }
});

test('my orders: a known group only (the request never reaches the SQL), my own rows, counts per group; one order with the masked code state', async () => {
  const sc = script([[/COUNT\(\*\) AS n FROM b2b_orders o WHERE o.salesman_id/, { n: 2 }], [/FROM b2b_orders o JOIN b2b_accounts a/, [
    { id: 3, order_no: 'B3', status: 'pending_otp', grand_total: '780.00', amount_paid: '0.00', item_count: 1, total_qty: 10, created_at: 'x', reservation_expires_at: 'y', account_id: 11, shop_name: 'Ganesh Stores', city: 'Bengaluru' }]]]);
  try {
    const r = await field.myOrders(P, SM, { filter: 'code' });
    const main = sc.find(/FROM b2b_orders o JOIN b2b_accounts a/)[0];
    assert.match(main.sql, /WHERE o\.salesman_id = \? AND o\.status = 'pending_otp' ORDER BY o\.id DESC LIMIT 100/);
    assert.deepEqual(main.params, [4]);
    assert.deepEqual(Object.keys(r.counts), ['code', 'open', 'delivered', 'due', 'closed']);
    assert.deepEqual(r.items[0], { id: 3, orderNo: 'B3', status: 'pending_otp', paymentMethod: undefined, paymentStatus: undefined, total: 780, paid: 0, due: 0, items: 1, units: 10, at: 'x', channel: null, holdUntil: 'y', shopId: 11, shop: 'Ganesh Stores', city: 'Bengaluru' });
    sc.calls.length = 0;
    await field.myOrders(P, SM, { filter: "code' OR 1=1 --", retailerId: '11' });
    const any = sc.find(/FROM b2b_orders o JOIN b2b_accounts a/)[0];
    assert.doesNotMatch(any.sql, /OR 1=1/); assert.match(any.sql, /WHERE o\.salesman_id = \? AND o\.buyer_account_id = \? ORDER BY/); assert.deepEqual(any.params, [4, 11]);
  } finally { sc.restore(); }

  const sc2 = script([
    [/FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id WHERE o.id = \? AND o.salesman_id = \?/, (p) => (p[1] === 4 ? { id: 3, order_no: 'B3', status: 'pending_otp', grand_total: '780.00', amount_paid: '0.00', taxable_total: '742.86', tax_total: '37.14', buyer_account_id: 11, shop_name: 'Ganesh Stores', buyer_notes: 'Before 11' } : null)],
    [/FROM b2b_order_items WHERE order_id/, [{ id: 1, product_id: 3, sku: 'BS500', name: 'Brown Sugar', qty: 10, unit_price: '74.29', gst_rate: '5.00', line_total: '780.00' }]],
    [/FROM b2b_otp_challenges/, { status: 'pending', expires_at: 'z', attempts: 1, resends: 0, delivery_status: 'queued', mobile: '9845011111' }],
  ]);
  try {
    const o = await field.myOrder(P, SM, 3);
    assert.deepEqual(o.code, { status: 'pending', expiresAt: 'z', attempts: 1, resends: 0, sent: 'queued', sentTo: 'XXXXXX1111' }, 'the full mobile number is never sent to the app');
    assert.deepEqual(o.lines, [{ id: 1, productId: 3, sku: 'BS500', name: 'Brown Sugar', qty: 10, unitPrice: 74.29, gstRate: 5, total: 780 }]);
    assert.equal(o.notes, 'Before 11'); assert.equal(o.subtotal, 742.86); assert.equal(o.shipment, null);
    await assert.rejects(field.myOrder(P, Object.assign({}, SM, { id: 5 }), 3), (e) => e.status === 404, 'another salesman\'s order');
  } finally { sc2.restore(); }
});

test('my visits (today in India time / 7 / 30 days) and my collections (waiting for handover by method)', async () => {
  const sc = script([[/FROM b2b_visits v JOIN b2b_accounts a/, [{ id: 8, checked_in_at: 'x', outcome: 'order', note: 'n', distance_m: null, account_id: 11, shop_name: null, business_name: 'Ganesh', city: 'B' }]]]);
  try {
    const t = await field.myVisits(P, SM, {});
    assert.equal(t.range, 'today'); assert.equal(t.items[0].shop, 'Ganesh');
    const from = sc.calls[0].params[1];
    assert.match(from, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.match(from, / 18:30:00$/, 'midnight in India is 18:30 UTC the day before');
    await field.myVisits(P, SM, { range: 'week' });
    assert.ok(Math.abs(Date.parse(sc.calls[1].params[1].replace(' ', 'T') + 'Z') - (Date.now() - 7 * 86400000)) < 60000);
    assert.equal((await field.myVisits(P, SM, { range: 'nonsense' })).range, 'today');
  } finally { sc.restore(); }
  const sc2 = script([
    [/FROM b2b_payments p LEFT JOIN b2b_orders o/, [
      { id: 3, receipt_no: 'R3', method: 'cash', amount: '1000.00', status: 'pending', order_id: 1, order_no: 'B1', shop_name: 'G' },
      { id: 2, receipt_no: 'R2', method: 'upi', amount: '250.50', status: 'pending', order_id: null },
      { id: 1, receipt_no: 'R1', method: 'cash', amount: '700.00', status: 'received', order_id: 1 }]],
    [/status = 'received' AND received_at >= \?/, { v: '700.00' }],
  ]);
  try {
    const m = await field.myCollections(P, SM);
    assert.deepEqual(m.waiting, { cash: 1000, upi: 250.5, cheque: 0 });
    assert.equal(m.confirmed30d, 700); assert.equal(m.cashLimit, 20000);
    assert.deepEqual(m.items.map((x) => [x.receiptNo, x.orderId]), [['R3', 1], ['R2', null], ['R1', 1]]);
    assert.deepEqual(sc2.calls[0].params, [4], 'only this salesman\'s collections');
  } finally { sc2.restore(); }
});

test('the shop list carries last order, last visit and what each shop owes (one query each for the page)', async () => {
  const sc = script([
    [/FROM b2b_accounts a WHERE/, [{ id: 11, business_name: 'G', status: 'approved' }, { id: 12, business_name: 'L', status: 'approved' }]],
    [/FROM b2b_orders WHERE buyer_account_id IN/, [{ id: 11, last_order_at: 'o11', due: '4520.50' }]],
    [/FROM b2b_visits WHERE account_id IN/, [{ id: 12, last_visit_at: 'v12' }]],
  ]);
  try {
    const r = await sales.retailers(P, SM, {});
    assert.deepEqual(r.items.map((a) => [a.id, a.last_order_at, a.due, a.last_visit_at]), [[11, 'o11', 4520.5, null], [12, null, 0, 'v12']]);
    assert.equal(sc.calls.length, 3);
    assert.match(sc.find(/FROM b2b_orders WHERE/)[0].sql, /CASE WHEN status NOT IN \('cancelled','rejected','refunded','draft','pending_otp','otp_expired'\) AND payment_status IN \('pending','partial'\) THEN grand_total - amount_paid/);
    assert.deepEqual(sc.find(/FROM b2b_orders WHERE/)[0].params, [11, 12]);
  } finally { sc.restore(); }
});

test('a visit keeps up to 500 characters of notes (what the shop needs and its feedback), the column\'s size', async () => {
  let stored = null;
  const tx = {
    queryOne: async (sql) => (/FROM b2b_accounts a JOIN b2b_states/.test(sql) ? SHOP : null),
    query: async (sql, p) => { if (/^INSERT INTO b2b_visits/.test(sql)) { stored = p; return { insertId: 5 }; } return []; },
  };
  const r = await sales.checkIn(tx, { type: 'staff', id: 9 }, P, SM, { retailerId: 11, clientUuid: '11111111-2222-4333-8444-555555555555', outcome: 'no_order', note: 'x'.repeat(700) });
  assert.equal(r.visitId, 5);
  assert.equal(stored[6], 'no_order'); assert.equal(stored[7].length, 500);
  assert.match(read('src/db/migrations/sql/010_field_sales.sql'), /note\s+VARCHAR\(500\) NULL/);
});

test('deliveries: "done" = the person\'s finished deliveries of the last N days (30 by default, at most 365), newest first; staff see what the buyer still owes', async () => {
  const dl = require('../src/modules/erp/delivery/service.js');
  const row = { id: 31, shipment_no: 'SH1', order_id: 3, order_no: 'B3', status: 'delivered', mode: 'own_vehicle', attempts: 0, grand_total: '2100.00', amount_paid: '600.00', payment_method: 'upi', payment_status: 'partial', total_qty: 36, item_count: 4,
    delivered_at: 'd', pod_received_by: 'Kavya', pod_stored_name: 'p.jpg', buyer_shop: 'Nandini', ship_phone: '9845044444', delivery_staff_id: 5 };
  const sc = script([[/FROM b2b_shipments s JOIN b2b_orders o/, [row]]]);
  const driver = { staff: { id: 5, permissions: new Set(['deliveries.update']) } };
  try {
    const r = await dl.list(driver, { status: 'done' });
    const q = sc.calls[0];
    assert.match(q.sql, /s\.delivery_staff_id = \? AND s\.status IN \('delivered','partially_delivered','returned','cancelled'\) AND COALESCE\(s\.delivered_at, s\.returned_at, s\.updated_at\) >= UTC_TIMESTAMP\(\) - INTERVAL 30 DAY/);
    assert.match(q.sql, /ORDER BY COALESCE\(s\.delivered_at, s\.returned_at, s\.updated_at\) DESC, s\.id DESC LIMIT 300$/);
    assert.deepEqual(q.params, [5]);
    assert.equal(r.toShip, undefined, 'drivers do not get the packing list');
    const s = r.items[0];
    assert.deepEqual(s.payment, { method: 'upi', status: 'partial', paid: 600, due: 1500 });
    assert.equal(s.units, 36); assert.equal(s.lines, 4); assert.equal(s.receivedBy, 'Kavya'); assert.equal(s.hasProof, true);
    sc.calls.length = 0;
    await dl.list(driver, { status: 'done', days: '9999' });
    assert.match(sc.calls[0].sql, /INTERVAL 365 DAY/);
    sc.calls.length = 0;
    await dl.list(driver, { status: 'open' });
    assert.match(sc.calls[0].sql, /ORDER BY FIELD\(s\.status, 'attempt_failed','out_for_delivery','dispatched','ready'\) DESC/, 'open deliveries keep their working order');
  } finally { sc.restore(); }
  // the buyer's own view of a shipment never carries the staff-only fields
  const src = read('src/modules/erp/delivery/service.js');
  const i = src.indexOf('if (!forBuyer) Object.assign(out, {'), j = src.indexOf('payment: s.grand_total == null');
  assert.ok(i > 0 && j > i && j < src.indexOf('return out;', i), 'payment is inside the staff-only block');
});

test('the routes: new read-only screens for salesmen (their own permission), fixed paths before :id', () => {
  const src = read('src/modules/erp/routes/sales.js');
  for (const [m, p, perm] of [['get', '/retailers/:id', 'sales.retailers.view'], ['get', '/orders', 'sales.self.view'], ['get', '/orders/:id', 'sales.self.view'], ['get', '/visits', 'sales.self.view'], ['get', '/collections', 'sales.self.view']]) {
    assert.ok(src.includes("app." + m + "('" + p + "', can('" + perm + "')"), m + ' ' + p);
  }
  assert.ok(src.indexOf("app.get('/retailers',") < src.indexOf("app.get('/retailers/:id',"));
  assert.match(src, /app\.use\(identity\.requireStaff, svc\.requireSalesman\)/, 'salesmen only');
});

test('the phone app: every screen, real endpoints, text only, no prices from the phone, no browser pop-ups for the reasons', () => {
  const app = read('erp-web/sales/app.js');
  for (const r of ['today', 'shops', 'shop\\/(\\d+)', 'shop\\/(\\d+)\\/visit', 'shop\\/(\\d+)\\/order', 'shop\\/(\\d+)\\/pay', 'new-shop', 'orders', 'order\\/(\\d+)', 'money',
    'deliveries', 'delivery\\/(\\d+)', 'delivery\\/(\\d+)\\/pod', 'delivery\\/(\\d+)\\/failed', 'done', 'events', 'counter\\/(\\d+)', 'more']) {
    assert.ok(app.includes('[/^' + r + '$/,'), 'screen ' + r);
  }
  for (const e of ["'/api/sales/retailers/' + id", "'/api/sales/orders/' + id", "'/api/sales/orders?filter=code", "'/api/sales/collections'", "'/api/sales/visits'", "'/api/sales/catalogue?retailerId=' + id",
    "'/api/erp/deliveries?status=done&days=' + d", "'/api/erp/deliveries?status=open'", "'/attempt-failed'", "'/out-for-delivery'", "'/location'", "'/api/erp/deliveries/' + s.id + '/delivered'", "'/proof'", "'/challan'",
    "'/api/b2b/geo/states'", "'/api/sales/retailers', body"]) assert.ok(app.includes(e) || app.includes(e.replace("'/proof'", "'/proof')")) || app.includes(e.replace("'/challan'", "'/challan')")), e);
  assert.doesNotMatch(app, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/, 'text via textContent only');
  assert.doesNotMatch(app, /prompt\('Why\?/, 'the failed-attempt reason is a form, not a browser pop-up');
  assert.match(app, /var body = \{ retailerId: id, paymentMethod: pay, clientUuid: key, items: items, notes: [^}]*\};/, 'the order sends products and quantities; the server prices it');
  assert.match(app, /fd\.append\('file', f\.blob, f\.name\)/, 'the photo goes with the delivery');
  assert.match(app, /function forgetAll\(\)[^\n]*\/\^soh\\\.\/[^\n]*k !== 'soh\.device'/, 'signing out removes the shop and order copies kept on the phone');
  assert.match(app, /function logout\(\) \{\n\s+token = null; forgetAll\(\);/);
  assert.match(app, /function pub\(url\) \{ return fetch\(url\)/, 'the staff token is not sent to the public reference lists');
  assert.match(app, /outcome: 'no_order', note: text/, 'when ordering is off, the list is saved as what the shop needs');
  // the app still works when the order-code rules are not approved yet: it says so instead of failing
  assert.match(app, /Taking orders in the app is switched off until the owner approves the order-code rules/);
  // first sign-in with a temporary password: choose your own in the app, then carry on (not "this account is not set up")
  assert.match(app, /if \(r\.mustChangePassword\) \{ root\.replaceChildren\(newPassword\(mail, p\.value\)\); return; \}/);
  assert.ok(app.includes("api('POST', '/api/erp/core/me/password', { currentPassword: temp, newPassword: n })"));
  assert.match(app, /j\.code === 'password_change_required'/, 'any screen: a temporary password sends the person back to choose their own');
  const css = read('erp-web/sales/app.css');
  assert.match(css, /\.tabs\{position:fixed;/); assert.match(css, /env\(safe-area-inset-bottom\)/);
});
