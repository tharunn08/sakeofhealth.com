/**
 * 3b.2–3b.6 and N4 — database-free checks of the real code (pure functions, and the services
 * with a stand-in transaction that answers by SQL pattern and fails on any statement it does
 * not know). Full flows on MySQL 8: tests/operations-channels.mysql.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-ops-'));
process.env.ERP_JWT_SECRET = 'ops-test-secret-0123456789abcdefghijklmnopq';
const ROOT = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };
const code = function (s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); };

/** A transaction stand-in: rules = [[regex, fn(args, sql) → result]]; unknown SQL throws. */
function fakeTx(rules) {
  const log = [];
  function answer(sql, args) {
    log.push([sql, args]);
    for (const r of rules) if (r[0].test(sql)) return r[1](args || [], sql);
    throw new Error('unexpected SQL in test: ' + sql.slice(0, 120));
  }
  return {
    log: log,
    query: async function (sql, args) { const v = answer(sql, args); return v === undefined ? { affectedRows: 1, insertId: 1 } : v; },
    queryOne: async function (sql, args) { const v = answer(sql, args); return Array.isArray(v) ? (v[0] || null) : (v === undefined ? null : v); },
    did: function (re) { return log.filter(function (x) { return re.test(x[0]); }); },
  };
}
const AUDIT = [[/b2b_sequences.*erp_audit_chain|erp_audit_chain/, function () { return [{ next_val: 1 }]; }], [/FROM b2b_audit_logs WHERE row_hash/, function () { return null; }], [/^INSERT INTO b2b_audit_logs/, function () { return { insertId: 9 }; }]];
const P = function (perms, id) { return { id: id || 7, permissions: new Set(perms), scopes: { warehouse: 'all' }, mfa: true }; };
function stub(rel, exports) { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exports }; return p; }

/* ── 3b.5: tax arithmetic (MRP is tax-inclusive) ── */
test('GST on a counter line: taxable + tax = what the customer pays; CGST/SGST inside the state, IGST outside', () => {
  const ev = require('../src/modules/erp/events/service.js');
  const a = ev.taxLine(118, 18, false);
  assert.deepEqual(a, { taxable: 100, cgst: 9, sgst: 9, igst: 0 });
  const b = ev.taxLine(118, 18, true);
  assert.deepEqual(b, { taxable: 100, cgst: 0, sgst: 0, igst: 18 });
  const c = ev.taxLine(99.99, 5, false);   // odd paise: the split never loses or adds a paisa
  assert.equal(Math.round((c.taxable + c.cgst + c.sgst) * 100), 9999);
  const z = ev.taxLine(50, 0, false);
  assert.deepEqual(z, { taxable: 50, cgst: 0, sgst: 0, igst: 0 });
});

/* ── Batch picking ── */
test('batches are picked earliest-expiry-first; expired batches never; units in no batch only when they exist outside every batch', async () => {
  const fefo = require('../src/modules/erp/inventory/fefo.js');
  const batches = [{ id: 11, lot_id: 3, batch_no: 'A', expiry_date: '2027-01-31', qty_on_hand: 2 }, { id: 12, lot_id: 4, batch_no: 'B', expiry_date: '2027-06-30', qty_on_hand: 5 }];
  let sql = '';
  const tx = fakeTx([
    [/FROM b2b_batches WHERE warehouse_id = \? AND product_id = \? AND status = 'active' AND qty_on_hand > 0/, function (a, s) { sql = s; return batches; }],
    [/^UPDATE b2b_batches SET qty_on_hand = qty_on_hand - \?/, function () { return { affectedRows: 1 }; }],
    [/^SELECT qty_available, qty_reserved FROM b2b_stock/, function () { return [{ qty_available: 7, qty_reserved: 0 }]; }],
    [/SUM\(qty_on_hand\)/, function () { return [{ n: 0 }]; }],
  ]);
  const p = await fefo.pick(tx, 1, 5, 4);
  assert.match(sql, /expiry_date IS NULL OR expiry_date > UTC_DATE\(\)/, 'expired batches are excluded');
  assert.match(sql, /ORDER BY \(expiry_date IS NULL\), expiry_date, id FOR UPDATE/, 'earliest expiry first, locked');
  assert.deepEqual(p.map(function (x) { return [x.batchId, x.qty]; }), [[11, 2], [12, 2]]);
  // 3 more than the batches hold, and nothing exists outside batches (all 7 are in them) → refused
  const tx2 = fakeTx([
    [/FROM b2b_batches WHERE warehouse_id = \? AND product_id = \? AND status = 'active' AND qty_on_hand > 0/, function () { return [{ id: 11, lot_id: 3, batch_no: 'A', expiry_date: null, qty_on_hand: 2 }]; }],
    [/^UPDATE b2b_batches SET qty_on_hand = qty_on_hand - \?/, function () { return { affectedRows: 1 }; }],
    [/^SELECT qty_available, qty_reserved FROM b2b_stock/, function () { return [{ qty_available: 7, qty_reserved: 0 }]; }],
    [/SUM\(qty_on_hand\)/, function () { return [{ n: 5 }]; }],   // 2 picked already left the sum; 5 sit in an expired batch
  ]);
  await assert.rejects(fefo.pick(tx2, 1, 5, 5), function (e) { return e.status === 409 && e.code === 'insufficient_stock'; }, 'expired units are not sold as "no batch"');
  assert.deepEqual(fefo.takeFrom([{ batchId: 1, qty: 3 }, { batchId: 2, qty: 2 }], 4).map(function (x) { return [x.batchId, x.qty]; }), [[2, 2], [1, 2]]);
});

/* ── 3b.5: a counter sale with a stand-in database ── */
function saleRules(state) {
  return AUDIT.concat([
    [/^SELECT id FROM b2b_counter_sales WHERE idempotency_key = \?/, function () { return state.existing || null; }],
    [/^SELECT \* FROM b2b_events WHERE id = \? FOR UPDATE/, function () { return [state.event]; }],
    [/^SELECT event_id FROM b2b_event_staff WHERE staff_id = \?/, function () { return state.assigned.map(function (e) { return { event_id: e }; }); }],
    [/FROM b2b_products WHERE id IN/, function () { return state.products; }],
    [/^SELECT qty_available FROM b2b_stock WHERE warehouse_id = \? AND product_id = \? FOR UPDATE/, function (a) { return [{ qty_available: state.stock[a[1]] || 0 }]; }],
    [/FROM b2b_batches WHERE warehouse_id = \? AND product_id = \? AND status = 'active' AND qty_on_hand > 0/, function (a) { return state.batches[a[1]] || []; }],
    [/^UPDATE b2b_batches SET qty_on_hand = qty_on_hand - \?/, function () { return { affectedRows: 1 }; }],
    [/^INSERT IGNORE INTO b2b_sequences|^SELECT next_val FROM b2b_sequences|^UPDATE b2b_sequences/, function (a, s) { return /SELECT/.test(s) ? [{ next_val: 1 }] : { affectedRows: 1 }; }],
    [/^INSERT INTO b2b_counter_sales /, function (a) { state.sale = a; return { insertId: 501 }; }],
    [/^INSERT INTO b2b_counter_sale_items /, function (a) { state.items.push(a); return { insertId: 600 + state.items.length }; }],
    [/^SELECT id FROM b2b_stock_movements WHERE idem_key = \?/, function () { return null; }],
    [/^UPDATE b2b_stock SET qty_available = qty_available - \?/, function () { return { affectedRows: 1 }; }],
    [/^INSERT INTO b2b_stock_movements /, function (a) { state.moves.push(a); return { insertId: 1 }; }],
    [/^INSERT INTO b2b_counter_payments /, function (a) { state.pays.push(a); return { insertId: 1 }; }],
    [/^UPDATE b2b_counter_sales SET customer_id/, function () { return { affectedRows: 1 }; }],
    // the answer the service reads back
    [/^SELECT cs\.\*, e\.code AS event_code/, function () { return [{ id: 501, invoice_no: 'EV/2627/00001', event_id: 3, event_code: 'BLR', event_name: 'Bengaluru expo', seller_name: 'Asha', status: 'completed', sold_at: '2026-11-16 10:00:00', customer_id: null,
      is_interstate: state.sale[8], offline: 0, subtotal: state.sale[11], discount_total: state.sale[12], taxable_total: state.sale[13], cgst_total: state.sale[14], sgst_total: state.sale[15], igst_total: state.sale[16],
      round_off: state.sale[17], grand_total: state.sale[18], amount_paid: state.sale[19], payment_status: state.sale[20] }]; }],
    [/^SELECT \* FROM b2b_counter_sale_items WHERE sale_id = \? ORDER BY id/, function () { return []; }],
    [/FROM b2b_counter_payments p JOIN b2b_staff/, function () { return []; }],
    [/^SELECT \* FROM b2b_counter_returns WHERE sale_id/, function () { return []; }],
  ]);
}
function saleState() {
  return { event: { id: 3, code: 'BLR', status: 'open', warehouse_id: 40, state_id: 29, invoice_prefix: 'EV' }, assigned: [3],
    products: [{ id: 5, sku: 'JAG-1', name: 'Jaggery 1 kg', hsn_code: '1701', gst_rate: '5.00', mrp: '120.00' }],
    stock: { 5: 10 }, batches: { 5: [{ id: 11, lot_id: 3, batch_no: 'A1', expiry_date: '2027-01-31', qty_on_hand: 2 }, { id: 12, lot_id: 4, batch_no: 'B2', expiry_date: '2027-06-30', qty_on_hand: 8 }] },
    items: [], moves: [], pays: [], sale: null, existing: null };
}
function withSaleStubs(fn) {
  const linked = [];
  const a = stub('src/modules/b2b/invoices/service.js', { sellerCard: async function () { return { stateId: 29, name: 'Sake of Health', gstin: '29ABCDE1234F1Z5' }; } });
  const b = stub('src/modules/b2b/notifications/service.js', { enqueue: async function () { return 77; }, emailHtml: function () { return '<p>x</p>'; } });
  const c = stub('src/modules/erp/customers/service.js', { link: async function (tx, who, src, ref) { linked.push([src, ref, who.mobile]); return null; }, recordOrder: async function () {} });
  delete require.cache[require.resolve('../src/modules/erp/events/service.js')];
  return Promise.resolve(fn(require('../src/modules/erp/events/service.js'), linked)).finally(function () {
    [a, b, c].forEach(function (p) { delete require.cache[p]; });
    delete require.cache[require.resolve('../src/modules/erp/events/service.js')];
  });
}
const KEY = '4d7c1a2b-3e4f-4a5b-9c6d-7e8f9a0b1c2d';

test('counter sale: all stock checked first, units leave earliest-expiry-first with one keyed ledger row per batch, totals and payments recorded', () => withSaleStubs(async function (ev, linked) {
  const st = saleState(), tx = fakeTx(saleRules(st));
  const r = await ev.sell(tx, { type: 'staff', id: 7, label: 'asha@x' }, P(['events.sell']),
    { idempotencyKey: KEY, eventId: 3, items: [{ productId: 5, qty: 3, discount: 10 }], customer: { name: 'Ravi', mobile: '98450 11111' }, payments: [{ method: 'upi', amount: 350 }] });
  assert.equal(r.invoiceNo, 'EV/2627/00001');
  // 3 × 120 = 360, less 10 = 350 paid in full; inside Karnataka → CGST + SGST
  assert.equal(st.sale[11], '360.00'); assert.equal(st.sale[12], '10.00'); assert.equal(st.sale[18], '350.00'); assert.equal(st.sale[19], '350.00'); assert.equal(st.sale[20], 'paid'); assert.equal(st.sale[8], 0);
  assert.equal(Math.round(Number(st.sale[13]) * 100) + Math.round(Number(st.sale[14]) * 100) + Math.round(Number(st.sale[15]) * 100), 35000, 'taxable + tax = the bill, to the paisa');
  assert.deepEqual(st.items.map(function (i) { return [i[5], i[9]]; }), [[11, 2], [12, 1]], 'one invoice row per batch, earliest expiry first');
  assert.deepEqual(st.moves.map(function (m) { return [m[2], m[4], m[5], m[13]]; }), [[11, 'counter_sale', 2, 'cs:' + KEY + ':5:11'], [12, 'counter_sale', 1, 'cs:' + KEY + ':5:12']]);
  assert.equal(st.pays.length, 1); assert.equal(st.pays[0][1], 'upi');
  assert.deepEqual(linked, [['event_sale', 501, '98450 11111']], 'the buyer is linked to one customer record (N4)');
  assert.ok(tx.did(/^INSERT INTO b2b_audit_logs/).length >= 1, 'audited');
}));

test('counter sale: a repeated key returns the first sale and moves nothing; short stock refuses everything; staff only sell at their events; closed events refuse', () => withSaleStubs(async function (ev) {
  const actor = { type: 'staff', id: 7 };
  let st = saleState(); st.existing = [{ id: 501 }];
  let tx = fakeTx(saleRules(st));
  st.sale = [null, null, null, null, null, null, null, null, 0, null, null, '1', '0', '1', '0', '0', '0', '0', '1', '0', 'unpaid'];
  const again = await ev.sell(tx, actor, P(['events.sell']), { idempotencyKey: KEY, eventId: 3, items: [{ productId: 5, qty: 3 }] });
  assert.equal(again.duplicate, true);
  assert.equal(tx.did(/^INSERT|^UPDATE/).length, 0, 'nothing written for a repeat');
  st = saleState(); st.stock[5] = 2; tx = fakeTx(saleRules(st));
  await assert.rejects(ev.sell(tx, actor, P(['events.sell']), { idempotencyKey: KEY, eventId: 3, items: [{ productId: 5, qty: 3 }] }),
    function (e) { return e.status === 409 && e.code === 'insufficient_stock' && e.extra.short[0].available === 2; });
  assert.equal(tx.did(/^INSERT|^UPDATE b2b_batches/).length, 0, 'nothing half-sold');
  st = saleState(); st.assigned = []; tx = fakeTx(saleRules(st));
  await assert.rejects(ev.sell(tx, actor, P(['events.sell']), { idempotencyKey: KEY, eventId: 3, items: [{ productId: 5, qty: 1 }] }), function (e) { return e.code === 'event_forbidden'; });
  st = saleState(); st.event.status = 'closed'; tx = fakeTx(saleRules(st));
  await assert.rejects(ev.sell(tx, actor, P(['events.sell', 'events.manage']), { idempotencyKey: KEY, eventId: 3, items: [{ productId: 5, qty: 1 }] }), function (e) { return e.code === 'event_not_open'; });
  st = saleState(); tx = fakeTx(saleRules(st));
  await assert.rejects(ev.sell(tx, actor, P(['events.sell']), { idempotencyKey: KEY, eventId: 3, items: [{ productId: 5, qty: 1 }], payments: [{ method: 'cash', amount: 500 }] }), function (e) { return e.code === 'overpaid'; });
  await assert.rejects(ev.sell(fakeTx(saleRules(saleState())), actor, P(['events.sell']), { idempotencyKey: 'not-a-uuid', eventId: 3, items: [] }), function (e) { return e.code === 'idempotency_key'; });
}));

test('invoice numbers fit GST (at most 16 characters); invoice pages escape everything and show a void across the top', () => {
  assert.ok('ABCDE/2627/00001'.length <= 16);
  assert.match(read('src/modules/erp/events/service.js'), /\^\[A-Z\]\[A-Z0-9\]\{0,4\}\$/, 'prefix at most 5 characters');
  const inv = require('../src/modules/erp/events/invoice.js');
  const sale = { invoiceNo: 'EV/2627/00009', soldAt: '2026-11-16T10:00:00Z', event: { code: 'BLR', name: '<b>Expo</b>' }, interstate: false, voided: { at: '2026-11-16T11:00:00Z', reason: 'test <script>' },
    customer: { name: 'A & B', mobile: '9845011111' }, totals: { taxable: 100, cgst: 9, sgst: 9, igst: 0, discount: 0, roundOff: 0, grand: 118, paid: 118 },
    items: [{ name: 'Jaggery "1kg"', sku: 'J1', hsn: '1701', batchNo: 'A1', expiry: '2027-01-31', qty: 1, unitPrice: 118, discount: 0, taxable: 100, gstRate: 18, cgst: 9, sgst: 9, igst: 0, total: 118 }], payments: [], returns: [] };
  const html = inv.render(sale, { name: 'Sake of Health', gstin: '29ABCDE1234F1Z5', state: 'Karnataka' });
  assert.match(html, /VOID — cancelled/); assert.match(html, /test &lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;b&gt;Expo&lt;\/b&gt;/); assert.match(html, /Jaggery &quot;1kg&quot;/); assert.match(html, /<th>CGST<\/th><th>SGST<\/th>/);
  const ev = require('../src/modules/erp/events/service.js');
  const t = ev.invoiceToken(42);
  assert.equal(ev.readInvoiceToken(t), 42);
  assert.equal(ev.readInvoiceToken(t.slice(0, -2) + 'xx'), null, 'a changed link is refused');
  assert.equal(ev.readInvoiceToken(Buffer.from(JSON.stringify({ s: 43 })).toString('base64url') + '.' + t.split('.')[1]), null, 'a signature does not carry to another invoice');
});

/* ── 3b.3 / 3b.4: shop stock ── */
function shopRules(state) {
  return [
    [/FROM b2b_products WHERE b2c_ref IN/, function () { return state.products; }],
    [/^INSERT INTO b2b_b2c_discrepancies/, function (a) { state.disc.push(a); return { affectedRows: 1 }; }],
    [/^SELECT qty_available FROM b2b_stock WHERE warehouse_id = \? AND product_id = \?/, function (a) { return [{ qty_available: state.stock[a[1]] || 0 }]; }],
    [/FROM b2b_stock_reservations WHERE channel = 'b2c' AND mode = \? AND product_id = \? AND status = 'held'/, function (a) { return [{ n: state.held[a[1]] || 0 }]; }],
    [/FROM b2b_b2c_order_stock WHERE mode = 'shadow' AND product_id = \? AND stage IN/, function () { return [{ n: 0 }]; }],
    [/^INSERT INTO b2b_stock_reservations/, function (a) { state.holds.push(a); return { affectedRows: 1 }; }],
  ];
}
function withDb(rules, fn) {
  const db = require('../src/db/connection.js');
  const saved = { transaction: db.transaction, query: db.query, queryOne: db.queryOne };
  const tx = fakeTx(rules);
  db.transaction = async function (f) { return f(tx); };
  db.query = tx.query; db.queryOne = tx.queryOne;
  return Promise.resolve(fn(tx)).finally(function () { Object.assign(db, saved); });
}

test('hold at Pay: enforce refuses with the shop\'s own words and holds nothing; shadow never refuses but records what enforcement would do', async () => {
  const svc = require('../src/modules/erp/shopstock/service.js');
  const base = function () { return { products: [{ id: 5, b2c_ref: 'p-jag', name: 'Jaggery 1 kg' }, { id: 6, b2c_ref: 'p-sug', name: 'Brown sugar' }], stock: { 5: 3, 6: 0 }, held: { 5: 1 }, disc: [], holds: [] }; };
  let st = base();
  await withDb(shopRules(st), async function () {
    const r = await svc.hold('idem:k1', [{ id: 'p-jag', qty: 3 }, { id: 'p-sug', qty: 1 }, { id: 'p-unknown', qty: 1 }], { mode: 'enforce', warehouseId: 9, holdMinutes: 30 });
    assert.equal(r.ok, false);
    assert.equal(r.message, 'Only 2 of "Jaggery 1 kg" left in stock. "Brown sugar" is out of stock.', 'the shop\'s own texts; another checkout\'s hold counts against it');
    assert.equal(st.holds.length, 0, 'nothing held when anything is short');
    assert.ok(st.disc.some(function (d) { return d[0] === 'unmapped_product' && d[1] === 'p-unknown'; }), 'an unmapped shop product is recorded');
  });
  st = base();
  await withDb(shopRules(st), async function () {
    const r = await svc.hold('idem:k2', [{ id: 'p-jag', qty: 3 }], { mode: 'shadow', warehouseId: 9, holdMinutes: 30 });
    assert.equal(r.ok, true);
    assert.equal(st.holds.length, 1); assert.equal(st.holds[0][3], 'shadow', 'a shadow hold, never a live one');
    assert.ok(st.disc.some(function (d) { return d[0] === 'would_refuse'; }));
  });
  st = base();
  await withDb(shopRules(st), async function () {
    const r = await svc.hold('idem:k3', [{ id: 'p-jag', qty: 2 }], { mode: 'enforce', warehouseId: 9, holdMinutes: 30 });
    assert.equal(r.ok, true); assert.equal(st.holds[0][3], 'live'); assert.equal(st.holds[0][5], 30, 'held for the configured minutes');
  });
});

function fakeRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = function (c) { r.statusCode = c; return r; };
  r.json = function (b) { r.body = b; return r; };
  r.setHeader = function () {};
  return r;
}
test('front layer: off = untouched; MySQL down: as today unless enforcement was on, then "temporarily unavailable" before any charge; short = refused; after payment a database error never blocks the order', async () => {
  const svc = require('../src/modules/erp/shopstock/service.js');
  const front = require('../src/modules/erp/shopstock/front.js');
  const saved = { config: svc.config, hold: svc.hold, bind: svc.bind, release: svc.release, commitAtPlace: svc.commitAtPlace };
  try {
    let nexts = 0; const next = function () { nexts++; };
    svc.config = async function () { return { mode: 'off' }; }; front.reset();
    let res = fakeRes(); await front.onPay({ body: { items: [{ id: 'x', qty: 1 }] }, headers: {} }, res, next);
    assert.equal(nexts, 1); assert.equal(res.body, null, 'off: the shop answers as before');
    // MySQL down and enforcement never seen (unset, off, or a cold start): the shop works as today
    const down = async function () { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); };
    svc.config = down; front.reset(true);
    res = fakeRes(); await front.onPay({ body: { items: [{ id: 'x', qty: 1 }] }, headers: {} }, res, next);
    assert.equal(nexts, 2); assert.equal(res.body, null, 'never enforced: a database outage does not stop the shop');
    // MySQL down after this process read "enforce": fail closed before any charge
    svc.config = async function () { return { mode: 'enforce', warehouseId: 9, holdMinutes: 30 }; }; front.reset(true);
    svc.hold = async function () { return { ok: false, message: 'x' }; };
    await front.onPay({ body: { items: [{ id: 'x', qty: 1 }] }, headers: {} }, fakeRes(), next);
    svc.config = down; front.reset();
    res = fakeRes(); await front.onPay({ body: { items: [{ id: 'x', qty: 1 }] }, headers: {} }, res, next);
    assert.equal(res.statusCode, 503); assert.equal(res.body.error, front.UNAVAILABLE); assert.equal(nexts, 2, 'the shop handler (and so the gateway) never ran');
    // and a real config read that fails is an error, not "off" (the service no longer swallows it)
    const settings = require('../src/modules/erp/core/settings.js'); const realGet = settings.get;
    settings.get = async function () { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); };
    try { await assert.rejects(saved.config(), /down/); } finally { settings.get = realGet; }
    settings.get = async function () { return undefined; };
    try { assert.equal((await saved.config()).mode, 'off', 'unset settings are off'); } finally { settings.get = realGet; }
    nexts = 1;
    svc.config = async function () { return { mode: 'enforce', warehouseId: 9, holdMinutes: 30 }; }; front.reset();
    svc.hold = async function () { return { ok: false, message: '"Brown sugar" is out of stock.' }; };
    res = fakeRes(); await front.onPay({ body: { items: [{ id: 'x', qty: 1 }] }, headers: { 'idempotency-key': 'abc' } }, res, next);
    assert.equal(res.statusCode, 409); assert.equal(res.body.error, '"Brown sugar" is out of stock.'); assert.equal(nexts, 1);
    const bound = [];
    svc.hold = async function (k) { return { ok: true, key: k }; }; svc.bind = async function (k, gw) { bound.push([k, gw]); }; svc.release = async function (k) { bound.push([k, 'released']); };
    res = fakeRes(); await front.onPay({ body: { items: [{ id: 'x', qty: 1 }] }, headers: { 'idempotency-key': 'abc' } }, res, next);
    assert.equal(nexts, 2, 'held: the shop handler runs');
    res.json({ id: 'order_GW1', gateway: 'razorpay' });
    await new Promise(function (r) { setImmediate(r); });
    assert.deepEqual(bound, [['idem:abc', 'order_GW1']], 'the holds now belong to the gateway order');
    assert.deepEqual(res.body, { id: 'order_GW1', gateway: 'razorpay' }, 'the shop\'s answer passes through unchanged');
    // after payment
    svc.commitAtPlace = async function () { return { short: [{ productId: 5 }] }; };
    res = fakeRes(); await front.onPlace({ body: { payment: { gatewayOrderId: 'order_GW1', paymentId: 'pay_1' } } }, res, next);
    assert.equal(res.statusCode, 409); assert.match(res.body.error, /refunded in full/); assert.equal(nexts, 2, 'no order for a paid-but-short checkout');
    svc.commitAtPlace = async function () { throw new Error('db down'); };
    res = fakeRes(); await front.onPlace({ body: { payment: { gatewayOrderId: 'order_GW2', paymentId: 'pay_2' } } }, res, next);
    assert.equal(nexts, 3, 'paid: a database error does not block the order (the catch-up job reconciles it)');
    svc.config = async function () { return { mode: 'shadow', warehouseId: 9, holdMinutes: 30 }; }; front.reset();
    res = fakeRes(); await front.onPlace({ body: { payment: { gatewayOrderId: 'order_GW3' } } }, res, next);
    assert.equal(nexts, 4, 'shadow never stops an order');
  } finally { Object.assign(svc, saved); front.reset(true); }
});

test('front layer is registered before the shop\'s own checkout routes, without touching them', () => {
  const server = read('src/server.js');
  assert.ok(server.indexOf('b2b.mount(app);') !== -1 && server.indexOf('b2b.mount(app);') < server.indexOf("app.use('/api/checkout', checkoutLimit, checkoutRouter);"), 'the business hooks mount first');
  assert.ok(server.indexOf('b2b.mount(app);') < server.indexOf("app.use('/api/shop',     apiLimit,      shopRouter);"));
  const erp = read('src/modules/erp/index.js');
  assert.ok(erp.indexOf("require('./shopstock/front.js').mount(app);") > erp.indexOf('function mount(app)') && erp.indexOf("require('./shopstock/front.js').mount(app);") < erp.indexOf("api.use('/core'"));
  const front = code(read('src/modules/erp/shopstock/front.js'));
  assert.match(front, /app\.post\('\/api\/checkout\/order'/); assert.match(front, /app\.post\('\/api\/shop\/orders'/);
  assert.doesNotMatch(front, /require\(['"][^'"]*services\//, 'no shop code is loaded');
});

test('shop stock keys: every ledger row of a shop order line is keyed, so browser, webhook and catch-up move it once', () => {
  const src = code(read('src/modules/erp/shopstock/service.js'));
  assert.match(src, /idemKey: 'b2c:' \+ o\.orderKey \+ ':' \+ l\.productId \+ ':alloc:'/);
  assert.match(src, /const key = 'b2c:line:' \+ row\.id;/);
  assert.match(read('src/db/migrations/sql/019_operations_channels.sql'), /UNIQUE KEY uq_b2b_bos_line \(mode, shop_order_id, product_id\)/);
  assert.doesNotMatch(src, /b2b_b2c_stock_publish/, 'nothing is written back to the shop');
  assert.doesNotMatch(read('src/db/migrations/sql/019_operations_channels.sql'), /b2b_b2c_stock_publish/);
});

test('one ledger: the new modules never write stock tables directly (only ledger.move does)', () => {
  ['src/modules/erp/shopstock/service.js', 'src/modules/erp/events/service.js', 'src/modules/erp/offline/service.js', 'src/modules/erp/customers/service.js', 'src/modules/erp/field/locations.js', 'src/modules/erp/inventory/fefo.js'].forEach(function (f) {
    const s = code(read(f));
    assert.doesNotMatch(s, /(INSERT INTO|UPDATE)\s+b2b_stock(_movements)?\b/, f + ' writes stock only through the ledger');
  });
  assert.match(code(read('src/modules/erp/inventory/fefo.js')), /UPDATE b2b_batches/, 'batch figures follow the picks');
});

test('refunds move money: a separate permission that needs two-factor sign-in; the gateway is called once per exception', async () => {
  const identity = require('../src/modules/erp/core/identity.js');
  assert.equal(identity.needsMfa('shop_stock.refund.pay'), true);
  const ref = JSON.parse(read('src/modules/erp/catalog/reference-data.json'));
  const holders = ref.roles.filter(function (r) { return r.permissions.indexOf('shop_stock.refund.pay') !== -1; }).map(function (r) { return r.code; }).sort();
  assert.deepEqual(holders, ['business_admin', 'finance_manager', 'super_admin']);
  assert.match(read('src/modules/erp/routes/shop-stock.js'), /r\.post\('\/exceptions\/:id\/refund', can\('shop_stock\.refund\.pay'\)/);
  const svc = require('../src/modules/erp/shopstock/service.js');
  const rows = { ex: { id: 4, status: 'open', payment_id: 'pay_9', amount: '250.00', checkout_ref: 'gw:o1' } };
  const calls = [];
  await withDb(AUDIT.concat([
    [/^SELECT \* FROM b2b_b2c_exceptions WHERE id = \?/, function () { return [rows.ex]; }],
    [/^UPDATE b2b_b2c_exceptions SET status = 'refund_requested'/, function () { rows.ex.status = 'refund_requested'; return { affectedRows: 1 }; }],
    [/^UPDATE b2b_b2c_exceptions SET status = 'refunded'/, function (a) { rows.ex.status = 'refunded'; rows.ex.refund_ref = a[0]; return { affectedRows: 1 }; }],
  ]), async function () {
    const gw = { refund: async function (pid, o) { calls.push([pid, o.amount]); return { id: 'rfnd_1' }; } };
    const r = await svc.refund({ type: 'staff', id: 1 }, 4, gw);
    assert.deepEqual(r, { id: 4, status: 'refunded', refundRef: 'rfnd_1' });
    const again = await svc.refund({ type: 'staff', id: 1 }, 4, gw);
    assert.equal(again.duplicate, true);
    assert.deepEqual(calls, [['pay_9', 25000]], 'one gateway call, in paise');
  });
});

/* ── 3b.6: offline queue ── */
test('offline: how failures end — conflicts wait for staff, refusals are kept, temporary problems are retried by the device', () => {
  const off = require('../src/modules/erp/offline/service.js');
  assert.equal(off.classify({ status: 409, code: 'insufficient_stock', expose: true }), 'conflict');
  assert.equal(off.classify({ status: 409, code: 'event_not_open', expose: true }), 'conflict');
  assert.equal(off.classify({ status: 400, code: 'bad_gstin', expose: true }), 'failed');
  assert.equal(off.classify({ status: 403, code: 'event_forbidden', expose: true }), 'failed');
  assert.equal(off.classify({ code: 'ER_LOCK_WAIT_TIMEOUT' }), 'retry');
  assert.equal(off.classify(new Error('socket hang up')), 'retry');
  assert.deepEqual(off.KINDS, ['event_sale', 'event_payment', 'field_order', 'visit', 'location', 'delivery']);
  const src = code(read('src/modules/erp/offline/service.js'));
  assert.doesNotMatch(src, /DELETE FROM b2b_offline_ops/, 'never deleted');
  assert.match(read('src/db/migrations/sql/019_operations_channels.sql'), /UNIQUE KEY uq_b2b_oo_client \(client_op_id\)/);
});

test('offline: a repeated operation returns the stored result; the same id with different content, or someone else\'s id, is refused', async () => {
  const off = require('../src/modules/erp/offline/service.js');
  const crypto = require('crypto');
  const payload = { eventId: 3, items: [{ productId: 5, qty: 1 }] };
  const digest = crypto.createHash('sha256').update(JSON.stringify({ kind: 'event_sale', payload: payload })).digest('hex');
  const id = '6a1b2c3d-4e5f-4a1b-8c2d-3e4f5a6b7c8d';
  const row = { id: 1, staff_id: 7, payload_sha256: digest, status: 'applied', result_json: JSON.stringify({ saleId: 501, invoiceNo: 'EV/2627/00001' }) };
  await withDb([[/^SELECT \* FROM b2b_offline_ops WHERE client_op_id = \?/, function () { return [row]; }]], async function (tx) {
    const p = P(['events.sell'], 7);
    const r = await off.apply(p, {}, { clientOpId: id, kind: 'event_sale', payload: payload });
    assert.deepEqual(r, { clientOpId: id, status: 'duplicate', result: { saleId: 501, invoiceNo: 'EV/2627/00001' } });
    const changed = await off.apply(p, {}, { clientOpId: id, kind: 'event_sale', payload: { eventId: 3, items: [{ productId: 5, qty: 9 }] } });
    assert.equal(changed.code, 'op_reused');
    const other = await off.apply(P(['events.sell'], 8), {}, { clientOpId: id, kind: 'event_sale', payload: payload });
    assert.equal(other.code, 'op_not_yours');
    assert.equal(tx.did(/^INSERT|^UPDATE/).length, 0);
  });
  const bad = await off.apply(P([], 7), {}, { clientOpId: 'nope', kind: 'event_sale', payload: {} });
  assert.equal(bad.code, 'client_op_id');
  await assert.rejects(off.sync(P([], 7), {}, new Array(51).fill({})), function (e) { return e.code === 'too_many'; });
});

test('device queue: one id per operation for every retry; network errors keep it; conflicts stay visible until the person hides them', () => {
  const q = read('erp-web/sales/queue.js'), app = read('erp-web/sales/app.js');
  assert.match(q, /clientOpId: o\.clientOpId, kind: o\.kind, payload: o\.payload/);
  assert.match(q, /if \(x\.status === 'applied' \|\| x\.status === 'duplicate'\)[^\n]*return del\(o\.clientOpId\)/);
  assert.match(q, /o\.status = x\.status; o\.error = x\.error;/, 'conflict / failed are kept on the device');
  assert.match(q, /window\.addEventListener\('online'/);
  assert.match(app, /sendOrQueue\('event_sale', '\/api\/erp\/events\/sales', body, [^,]+, key,/, 'the sale\'s own idempotency key is the queue id');
  assert.match(app, /sendOrQueue\('field_order', '\/api\/sales\/orders', body, [^,]+, key,/);
  assert.match(app, /if \(window\.confirm\('Hide this from the phone\? It stays recorded in the office\.'\)\)/);
});

/* ── 3b.2: locations ── */
test('locations: coordinates are validated, device time is used only when believable, and a repeat id never records twice', () => {
  const loc = require('../src/modules/erp/field/locations.js');
  assert.deepEqual(loc.coords('12.97160', '77.59460'), { lat: 12.9716, lng: 77.5946 });
  assert.equal(loc.coords(0, 0), null); assert.equal(loc.coords(91, 10), null); assert.equal(loc.coords('x', 1), null);
  const now = Date.now();
  assert.ok(Math.abs(Date.parse(loc.capturedAt(new Date(now + 86400000).toISOString()) + 'Z') - now) < 5000, 'a future time becomes now');
  assert.ok(Math.abs(Date.parse(loc.capturedAt('2020-01-01T00:00:00Z') + 'Z') - now) < 5000, 'a very old time becomes now');
  const tenMin = new Date(now - 600000).toISOString();
  assert.equal(loc.capturedAt(tenMin), tenMin.replace('T', ' ').replace('Z', ''));
  const src = code(read('src/modules/erp/field/locations.js'));
  assert.match(src, /SELECT id FROM b2b_location_pings WHERE client_uuid = \?/);
  assert.match(src, /if \(vis === 'all'\) return;/, 'only locations.view sees everyone');
  assert.doesNotMatch(src, /setInterval|watchPosition/, 'nothing tracks anyone in the background');
});

/* ── N4: customers ── */
test('customers: matched on a normalised email, then mobile; a conflicting pair is flagged for review, never merged', async () => {
  const c = require('../src/modules/erp/customers/service.js');
  assert.equal(c.normEmail('  Ravi@Shop.IN '), 'ravi@shop.in'); assert.equal(c.normMobile('+91 98450-11111'), '919845011111'); assert.equal(c.normMobile('123'), null);
  const st = { links: [] };
  const rules = [
    [/^SELECT customer_id FROM b2b_customer_links WHERE source = \? AND source_ref = \?/, function () { return null; }],
    [/^SELECT id FROM b2b_customers WHERE email_norm = \? FOR UPDATE/, function () { return [{ id: 1 }]; }],
    [/^SELECT id FROM b2b_customers WHERE mobile_norm = \? FOR UPDATE/, function () { return [{ id: 2 }]; }],
    [/^SELECT display_name, email_norm, mobile_norm, first_seen_at, last_seen_at FROM b2b_customers WHERE id = \? FOR UPDATE/, function () { return [{ display_name: 'Ravi', email_norm: 'ravi@shop.in', mobile_norm: '919845099999', first_seen_at: null, last_seen_at: null }]; }],
    [/^UPDATE b2b_customers SET/, function () { return { affectedRows: 1 }; }],
    [/^INSERT IGNORE INTO b2b_customer_links/, function (a) { st.links.push(a); return { affectedRows: 1 }; }],
  ];
  const tx = fakeTx(rules);
  const r = await c.link(tx, { name: 'Ravi', email: 'RAVI@shop.in', mobile: '9845011111' }, 'event_sale', 77);
  assert.deepEqual(r, { customerId: 1, created: false, review: true });
  assert.deepEqual(st.links[0].slice(0, 5), [1, 'event_sale', '77', 'email', 1]);
  assert.match(st.links[0][5], /Mobile also belongs to customer #2/);
  assert.equal(tx.did(/^INSERT INTO b2b_customers/).length, 0, 'no duplicate record created');
  assert.equal(await c.link(fakeTx([[/^SELECT customer_id FROM b2b_customer_links/, function () { return null; }]]), { name: 'Walk-in' }, 'event_sale', 78), null, 'no contact → no record');
  const imp = code(read('src/modules/erp/customers/service.js'));
  assert.doesNotMatch(imp.slice(imp.indexOf('async function importAll')), /password/i, 'login passwords are never taken from the shop');
  assert.match(imp, /adapter\.readShop\('customers'\)/, 'shop data only through the read-only adapter');
});

test('settings: every new switch is a business decision; while unset the shop behaves exactly as today', () => {
  const cat = JSON.parse(read('src/modules/erp/core/settings-catalog.json'));
  const by = {}; cat.settings.forEach(function (s) { by[s.key] = s; });
  assert.match(by['inventory.b2c_stock_mode'].while_unset, /^off: the online shop behaves exactly as today/);
  assert.ok(by['inventory.b2c_warehouse_id'] && by['inventory.b2c_hold_minutes'] && by['inventory.b2c_auto_refund'] && by['customers.import.enabled']);
  const svc = code(read('src/modules/erp/shopstock/service.js'));
  assert.match(svc, /const m = MODES\.indexOf\(mode\) !== -1 && warehouseId \? mode : 'off';/, 'anything missing = off');
});

test('admin and field screens: every new screen is in the one registry and calls real endpoints', () => {
  const ops = read('erp-web/admin/operations.js');
  ['/shop-stock/overview', '/events/sales', '/locations/map', '/offline/ops', '/customers/import'].forEach(function (p) { assert.ok(ops.indexOf(p) !== -1, p); });
  const reg = require('../src/platform/registry.js');
  ['erp-shopstock', 'erp-events', 'erp-locations', 'erp-offline', 'erp-customers'].forEach(function (id) { assert.ok(reg.PAGES.some(function (p) { return p.id === id; }), id); });
  const routes = ['shop-stock', 'events', 'locations', 'offline', 'customers'].map(function (f) { return read('src/modules/erp/routes/' + f + '.js'); }).join('\n');
  assert.equal((routes.match(/r\.use\(identity\.requireStaff\)/g) || []).length, 5, 'every new route file needs a signed-in staff member');
});
