/**
 * Manufacturing and delivery (migration 020) — database-free checks of the real code: pure
 * functions, and the services with a stand-in transaction that answers by SQL pattern and fails on
 * any statement it does not know. Full flows on MySQL 8: tests/manufacturing-delivery.mysql.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-mfg-'));
process.env.B2B_PRIVATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-mfg-priv-'));
process.env.ERP_JWT_SECRET = 'mfg-test-secret-0123456789abcdefghijklmnopq';
const ROOT = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };

function fakeTx(rules) {
  const log = [];
  function answer(sql, args) {
    log.push([sql, args]);
    for (const r of rules) if (r[0].test(sql)) return r[1](args || [], sql);
    throw new Error('unexpected SQL in test: ' + sql.slice(0, 140));
  }
  return {
    log: log,
    query: async function (sql, args) { const v = answer(sql, args); return v === undefined ? { affectedRows: 1, insertId: 1 } : v; },
    queryOne: async function (sql, args) { const v = answer(sql, args); return Array.isArray(v) ? (v[0] || null) : (v === undefined ? null : v); },
    did: function (re) { return log.filter(function (x) { return re.test(x[0]); }); },
  };
}
const AUDIT = [[/erp_audit_chain/, function () { return [{ next_val: 1 }]; }], [/FROM b2b_audit_logs WHERE row_hash/, function () { return null; }], [/^INSERT INTO b2b_audit_logs/, function () { return { insertId: 9 }; }]];
const SEQ = [[/INSERT IGNORE INTO b2b_sequences/, function () { return { affectedRows: 0 }; }], [/SELECT next_val FROM b2b_sequences WHERE seq_key = \?/, function () { return [{ next_val: 7 }]; }], [/^UPDATE b2b_sequences/, function () { return { affectedRows: 1 }; }]];
/** The ledger's own statements: key check, bucket update, movement row. moves[] records each movement. */
function LEDGER(moves, opts) {
  opts = opts || {};
  return [
    [/SELECT id FROM b2b_stock_movements WHERE idem_key = \?/, function (a) { return opts.posted && opts.posted.indexOf(a[0]) !== -1 ? [{ id: 1 }] : null; }],
    [/^UPDATE b2b_stock SET/, function () { return { affectedRows: opts.short ? 0 : 1 }; }],
    [/^INSERT INTO b2b_stock \(warehouse_id/, function () { return { affectedRows: 1 }; }],
    [/^INSERT INTO b2b_stock_movements/, function (a, sql) {
      const cols = sql.match(/\(([^)]*)\)/)[1].split(',').map(function (s) { return s.trim(); });
      const row = {}; cols.forEach(function (c, i) { row[c] = a[i]; }); moves.push(row); return { insertId: moves.length };
    }],
  ];
}
const STAFF = { type: 'staff', id: 5, label: 'qc@test.local' };
function stub(rel, exports) { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exports }; return p; }
const UUID = '11111111-2222-4333-8444-555555555555';

/* ───────────── manufacturing: arithmetic and validation ───────────── */
test('material requirement = qty per output × planned / output, plus scrap, rounded up', () => {
  const mfg = require('../src/modules/erp/manufacturing/service.js');
  const r = mfg.requirement([{ productId: 1, qty: 2.5, scrapPct: 0 }, { productId: 2, qty: 1, scrapPct: 10 }, { productId: 3, qty: 0.3333, scrapPct: 0 }], 100, 250);
  assert.deepEqual(r, [{ productId: 1, required: 7 }, { productId: 2, required: 3 }, { productId: 3, required: 1 }]);
  assert.deepEqual(mfg.requirement([{ productId: 9, qty: 1, scrapPct: 0 }], 1, 40), [{ productId: 9, required: 40 }], 'exact multiples are not rounded up');
});

test('a batch needs a number, manufacture before expiry, nothing in the future or already expired, and expiry within the product\'s shelf life', () => {
  const mfg = require('../src/modules/erp/manufacturing/service.js');
  const p = { name: 'Jaggery', shelf_life_days: 365 };
  const d = function (n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); };
  const ok = mfg.cleanBatch({ batchNo: 'b-12/26', mfgDate: d(-5), expiryDate: d(300), qty: 40 }, p);
  assert.equal(ok.norm, 'B1226'); assert.equal(ok.qty, 40);
  assert.throws(() => mfg.cleanBatch({ batchNo: '', mfgDate: d(-5), expiryDate: d(300), qty: 1 }, p), /batch number/);
  assert.throws(() => mfg.cleanBatch({ batchNo: 'X', mfgDate: d(10), expiryDate: d(300), qty: 1 }, p), /future/);
  assert.throws(() => mfg.cleanBatch({ batchNo: 'X', mfgDate: d(-5), expiryDate: d(-6), qty: 1 }, p), /after manufacture/);
  assert.throws(() => mfg.cleanBatch({ batchNo: 'X', mfgDate: d(-400), expiryDate: d(-1), qty: 1 }, p), /expired/);
  assert.throws(() => mfg.cleanBatch({ batchNo: 'X', mfgDate: d(-5), expiryDate: d(400), qty: 1 }, p), /shelf life of 365 days/);
  assert.throws(() => mfg.cleanBatch({ batchNo: 'X', mfgDate: d(-5), expiryDate: d(30), qty: 0 }, p), /whole number above 0/);
});

test('bill of materials: no self-reference, no duplicate material; a different person activates it, which archives the previous version', async () => {
  const mfg = require('../src/modules/erp/manufacturing/service.js');
  const prods = { 1: { id: 1, sku: 'FG', name: 'Jaggery 1 kg', item_kind: 'finished' }, 2: { id: 2, sku: 'RM', name: 'Cane juice', item_kind: 'raw_material' }, 3: { id: 3, sku: 'PK', name: 'Pouch', item_kind: 'packaging' } };
  const base = [[/FROM b2b_products WHERE id = \?/, function (a) { return prods[a[0]] ? [prods[a[0]]] : null; }]].concat(AUDIT);
  await assert.rejects(mfg.createBom(fakeTx(base), STAFF, { productId: 1, outputQty: 100, lines: [{ productId: 1, qty: 1 }] }), /material of itself/);
  await assert.rejects(mfg.createBom(fakeTx(base), STAFF, { productId: 1, outputQty: 100, lines: [{ productId: 2, qty: 1 }, { productId: 2, qty: 2 }] }), /twice/);
  await assert.rejects(mfg.createBom(fakeTx(base), STAFF, { productId: 2, outputQty: 100, lines: [{ productId: 3, qty: 1 }] }), /not a finished product/);
  const lines = [];
  const tx = fakeTx(base.concat([[/MAX\(version\)/, function () { return [{ v: 2 }]; }], [/^INSERT INTO b2b_boms/, function (a) { assert.equal(a[1], 3, 'next version'); return { insertId: 44 }; }],
    [/^INSERT INTO b2b_bom_lines/, function (a) { lines.push(a); return { insertId: 1 }; }]]));
  const r = await mfg.createBom(tx, STAFF, { productId: 1, outputQty: 100, lines: [{ productId: 2, qty: 105.5, scrapPct: 2 }, { productId: 3, qty: 100 }] });
  assert.deepEqual(r, { id: 44, version: 3, status: 'draft' });
  assert.deepEqual(lines.map(function (l) { return [l[1], l[2], l[3]]; }), [[2, '105.5000', '2.00'], [3, '100.0000', '0.00']]);
  // activation
  const draft = { id: 44, product_id: 1, status: 'draft', created_by: 5 };
  await assert.rejects(mfg.activateBom(fakeTx([[/FROM b2b_boms WHERE id = \? FOR UPDATE/, function () { return [draft]; }]]), STAFF, 44), function (e) { return e.status === 403 && e.code === 'same_person'; });
  const tx2 = fakeTx([[/FROM b2b_boms WHERE id = \? FOR UPDATE/, function () { return [draft]; }], [/status = 'active' FOR UPDATE/, function () { return [{ id: 40 }]; }],
    [/^UPDATE b2b_boms SET status = 'archived'/, function (a) { assert.equal(a[0], 40); }], [/^UPDATE b2b_boms SET status = 'active'/, function () {}]].concat(AUDIT));
  const act = await mfg.activateBom(tx2, { type: 'staff', id: 6 }, 44);
  assert.deepEqual(act, { id: 44, status: 'active', archived: 40 });
});

test('manufacturing orders: contract needs an approved manufacturer (and a PO with that product, delivering to the same warehouse); in-house needs an active bill of materials', async () => {
  const mfg = require('../src/modules/erp/manufacturing/service.js');
  const common = [[/FROM b2b_products WHERE id = \?/, function () { return [{ id: 1, sku: 'FG', name: 'Jaggery', item_kind: 'finished' }]; }],
    [/FROM b2b_warehouses WHERE id = \?/, function () { return [{ id: 3, warehouse_type: 'company', is_active: 1 }]; }]];
  const notApproved = fakeTx(common.concat([[/FROM b2b_vendors WHERE id = \?/, function () { return [{ id: 8, legal_name: 'Maker', status: 'submitted' }]; }]]));
  await assert.rejects(mfg.createMo(notApproved, STAFF, { mode: 'contract', productId: 1, plannedQty: 100, warehouseId: 3, vendorId: 8 }), function (e) { return e.code === 'vendor_not_approved'; });
  const noCap = fakeTx(common.concat([[/FROM b2b_vendors WHERE id = \?/, function () { return [{ id: 8, legal_name: 'Maker', status: 'approved' }]; }],
    [/FROM b2b_vendor_capabilities WHERE vendor_id = \?/, function () { return [{ capability: 'supplier_wholesaler', status: 'approved' }]; }]]));
  await assert.rejects(mfg.createMo(noCap, STAFF, { mode: 'contract', productId: 1, plannedQty: 100, warehouseId: 3, vendorId: 8 }), function (e) { return e.code === 'not_a_manufacturer'; });
  const maker = [[/FROM b2b_vendors WHERE id = \?/, function () { return [{ id: 8, legal_name: 'Maker', status: 'approved' }]; }],
    [/FROM b2b_vendor_capabilities WHERE vendor_id = \?/, function () { return [{ capability: 'contract_manufacturer', status: 'approved' }]; }]];
  const otherWh = fakeTx(common.concat(maker, [[/FROM b2b_purchase_orders WHERE id = \?/, function () { return [{ id: 9, vendor_id: 8, status: 'sent', ship_to_warehouse_id: 4 }]; }],
    [/FROM b2b_purchase_order_items WHERE po_id = \? AND product_id = \?/, function () { return [{ id: 1 }]; }]]));
  await assert.rejects(mfg.createMo(otherWh, STAFF, { mode: 'contract', productId: 1, plannedQty: 100, warehouseId: 3, vendorId: 8, poId: 9 }), /delivery warehouse/);
  const noBom = fakeTx(common.concat([[/FROM b2b_boms WHERE product_id = \? AND status = 'active'/, function () { return null; }]]));
  await assert.rejects(mfg.createMo(noBom, STAFF, { mode: 'in_house', productId: 1, plannedQty: 100, warehouseId: 3 }), function (e) { return e.code === 'no_active_bom'; });
  let inserted = null;
  const good = fakeTx(common.concat(maker, SEQ, AUDIT, [[/FROM b2b_purchase_orders WHERE id = \?/, function () { return [{ id: 9, vendor_id: 8, status: 'sent', ship_to_warehouse_id: 3 }]; }],
    [/FROM b2b_purchase_order_items WHERE po_id = \? AND product_id = \?/, function () { return [{ id: 1 }]; }],
    [/^INSERT INTO b2b_mfg_orders/, function (a) { inserted = a; return { insertId: 21 }; }], [/^INSERT INTO b2b_mfg_order_events/, function () {}]]));
  const r = await mfg.createMo(good, STAFF, { mode: 'contract', productId: 1, plannedQty: 100, warehouseId: 3, vendorId: 8, poId: 9 });
  assert.equal(r.status, 'draft'); assert.match(r.moNo, /^MO\/\d{4}\/00007$/);
  assert.deepEqual(inserted.slice(1, 9), ['contract', 8, null, 1, null, 9, 3, 100]);
});

/** A stand-in for one manufacturing order and its batch, as the QC and batch code reads them. */
function moRows(over) { return Object.assign({ id: 21, mo_no: 'MO/2627/00007', mode: 'in_house', vendor_id: null, product_id: 1, warehouse_id: 3, planned_qty: 100, produced_qty: 0, status: 'in_production', bom_id: 4 }, over || {}); }

test('in-house output enters quarantine as a lot of our own plant (keyed), only once the own-plant vendor is decided; over-production and reused batch numbers are refused', async () => {
  const mfg = require('../src/modules/erp/manufacturing/service.js');
  const settings = require('../src/modules/erp/core/settings.js');
  const realGet = settings.get;
  const d = function (n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); };
  const batch = { batchNo: 'IH-01', mfgDate: d(-1), expiryDate: d(200), qty: 60 };
  const base = function (mo, extra) {
    return fakeTx([[/FROM b2b_mfg_orders WHERE id = \? FOR UPDATE/, function () { return [mo]; }], [/FROM b2b_products WHERE id = \?/, function () { return [{ id: 1, name: 'Jaggery', shelf_life_days: 365 }]; }]].concat(extra || []));
  };
  try {
    settings.get = async function () { return undefined; };
    await assert.rejects(mfg.staffBatch(base(moRows()), STAFF, 21, batch), function (e) { return e.code === 'own_maker_undecided'; });
    settings.get = async function (k) { return k === 'manufacturing.own_manufacturer_vendor_id' ? 77 : undefined; };
    await assert.rejects(mfg.staffBatch(base(moRows({ produced_qty: 60 })), STAFF, 21, batch), function (e) { return e.code === 'over_production'; }, '120 > 110 (10% over 100)');
    await assert.rejects(mfg.staffBatch(base(moRows(), [[/FROM b2b_lots WHERE product_id = \? AND manufacturer_vendor_id = \? AND batch_no_norm = \?/, function () { return [{ expiry_date: '2027-01-01', status: 'released' }]; }]]), STAFF, 21, batch),
      function (e) { return e.code === 'batch_exists'; });
    const moves = [];
    const tx = base(moRows(), [[/FROM b2b_lots WHERE product_id = \? AND manufacturer_vendor_id = \? AND batch_no_norm = \?$/, function () { return null; }],
      [/^INSERT INTO b2b_mfg_batches/, function (a) { assert.equal(a[7], null, 'no certificate yet'); assert.equal(a[8], 'staff'); return { insertId: 31 }; }],
      [/FROM b2b_lots WHERE product_id = \? AND manufacturer_vendor_id = \? AND batch_no_norm = \? FOR UPDATE/, function () { return null; }],
      [/^INSERT INTO b2b_lots/, function (a) { assert.equal(a[1], 77, 'manufacturer of record = our own plant'); return { insertId: 51 }; }],
      [/SELECT \* FROM b2b_lots WHERE id = \?/, function () { return [{ id: 51, product_id: 1, batch_no: 'IH-01', mfg_date: d(-1), expiry_date: d(200) }]; }],
      [/FROM b2b_batches WHERE warehouse_id = \? AND product_id = \? AND batch_no = \? FOR UPDATE/, function () { return null; }],
      [/^INSERT INTO b2b_batches/, function () { return { insertId: 61 }; }],
      [/^UPDATE b2b_batches SET qty_quarantine = qty_quarantine \+ \?/, function (a) { assert.deepEqual(a, [60, 61]); }],
      [/^UPDATE b2b_mfg_batches SET lot_id/, function () {}], [/^UPDATE b2b_mfg_orders SET produced_qty/, function () {}],
      [/^INSERT INTO b2b_mfg_order_events/, function () {}]].concat(LEDGER(moves), AUDIT));
    const r = await mfg.staffBatch(tx, STAFF, 21, batch);
    assert.deepEqual(r, { batchId: 31, batchNo: 'IH-01', status: 'submitted' });
    assert.equal(moves.length, 1);
    assert.equal(moves[0].movement_type, 'production'); assert.equal(moves[0].to_status, 'quarantine'); assert.equal(moves[0].from_status, null);
    assert.equal(moves[0].qty, 60); assert.equal(moves[0].idem_key, 'mfgb:31:output');
  } finally { settings.get = realGet; }
});

test('QC: a release needs a certificate, a different person, and released + rejected = the batch; in-house moves quarantine → available / damaged, keyed; contract moves nothing', async () => {
  const mfg = require('../src/modules/erp/manufacturing/service.js');
  const bt = { id: 31, mo_id: 21, product_id: 1, batch_no: 'IH-01', qty: 60, status: 'submitted', created_by_type: 'staff', created_by_id: 5, coa_document_id: null, stock_batch_id: 61, lot_id: 51 };
  const rules = function (b, mo, coa, moves, extra) {
    return [[/FROM b2b_mfg_batches WHERE id = \? FOR UPDATE/, function () { return [b]; }], [/FROM b2b_mfg_orders WHERE id = \? FOR UPDATE/, function () { return [mo]; }],
      [/FROM b2b_mfg_documents WHERE batch_id = \? AND doc_type IN/, function () { return coa ? [{ id: 9 }] : null; }]].concat(moves ? LEDGER(moves) : [], extra || []);
  };
  await assert.rejects(mfg.qcDecide(fakeTx(rules(bt, moRows(), false)), { type: 'staff', id: 6 }, 31, { result: 'pass', note: 'looks fine' }), function (e) { return e.code === 'coa_required'; });
  await assert.rejects(mfg.qcDecide(fakeTx(rules(bt, moRows(), true)), STAFF, 31, { result: 'pass', note: 'looks fine' }), function (e) { return e.status === 403 && e.code === 'same_person'; });
  await assert.rejects(mfg.qcDecide(fakeTx(rules(bt, moRows(), true)), { type: 'staff', id: 6 }, 31, { result: 'partial', releasedQty: 50, rejectedQty: 5, note: 'seal' }), /must equal the batch quantity \(60\)/);
  await assert.rejects(mfg.qcDecide(fakeTx(rules(Object.assign({}, bt, { status: 'released' }), moRows(), true)), { type: 'staff', id: 6 }, 31, { result: 'pass', note: 'x x' }), /already has a QC decision/);
  // a rejection needs no certificate
  const moves0 = [];
  const tx0 = fakeTx(rules(bt, moRows(), false, moves0, [[/^UPDATE b2b_batches SET qty_quarantine = qty_quarantine - \? WHERE/, function () {}], [/^UPDATE b2b_mfg_batches SET status/, function () {}],
    [/^UPDATE b2b_mfg_orders SET released_qty/, function () {}], [/^INSERT INTO b2b_mfg_order_events/, function () {}]].concat(AUDIT)));
  const r0 = await mfg.qcDecide(tx0, { type: 'staff', id: 6 }, 31, { result: 'fail', note: 'mould found' });
  assert.equal(r0.status, 'rejected');
  assert.deepEqual(moves0.map(function (m) { return [m.movement_type, m.from_status, m.to_status, m.qty, m.idem_key]; }), [['damage', 'quarantine', 'damaged', 60, 'mfgb:31:rejected']]);
  // partial: both moves, keyed separately; batch figures follow
  const moves = [], batchUpd = [];
  const tx = fakeTx(rules(bt, moRows(), true, moves, [[/^UPDATE b2b_batches SET qty_quarantine = qty_quarantine - \?, qty_on_hand = qty_on_hand \+ \?/, function (a) { batchUpd.push(['rel', a]); }],
    [/^UPDATE b2b_batches SET qty_quarantine = qty_quarantine - \? WHERE/, function (a) { batchUpd.push(['rej', a]); }], [/^UPDATE b2b_mfg_batches SET status/, function (a) { assert.deepEqual(a.slice(0, 3), ['released', 55, 5]); }],
    [/^UPDATE b2b_mfg_orders SET released_qty/, function (a) { assert.deepEqual(a, [55, 5, 21]); }], [/^INSERT INTO b2b_mfg_order_events/, function () {}]].concat(AUDIT)));
  const r = await mfg.qcDecide(tx, { type: 'staff', id: 6 }, 31, { result: 'partial', releasedQty: 55, rejectedQty: 5, note: 'five pouches torn' });
  assert.deepEqual(r, { batchId: 31, status: 'released', releasedQty: 55, rejectedQty: 5 });
  assert.deepEqual(moves.map(function (m) { return [m.movement_type, m.from_status, m.to_status, m.qty, m.idem_key]; }),
    [['quarantine_out', 'quarantine', 'available', 55, 'mfgb:31:released'], ['damage', 'quarantine', 'damaged', 5, 'mfgb:31:rejected']]);
  assert.deepEqual(batchUpd, [['rel', [55, 55, 61]], ['rej', [5, 61]]]);
  // contract: no stock moves (goods arrive later by goods receipt); the manufacturer is emailed
  const cb = Object.assign({}, bt, { created_by_type: 'vendor', created_by_id: 3, stock_batch_id: null, lot_id: null });
  const notified = [];
  stub('src/modules/b2b/notifications/service.js', { emailHtml: function () { return '<p>'; }, recordWorkflow: async function () { return null; }, enqueue: async function (q, m) { notified.push(m); }, notifyAdmins: async function () {} });
  const moves2 = [];
  const tx2 = fakeTx(rules(cb, moRows({ mode: 'contract', vendor_id: 8 }), true, moves2, [[/^UPDATE b2b_mfg_batches SET status/, function () {}], [/^UPDATE b2b_mfg_orders SET released_qty/, function () {}],
    [/^INSERT INTO b2b_mfg_order_events/, function () {}], [/FROM b2b_vendor_users u JOIN b2b_vendors vd/, function () { return [{ email: 'maker@test.local', legal_name: 'Maker' }]; }]].concat(AUDIT)));
  const r2 = await mfg.qcDecide(tx2, STAFF, 31, { result: 'pass', note: 'CoA matches spec' });
  assert.equal(r2.status, 'released'); assert.equal(moves2.length, 0, 'a contract batch moves no stock at QC');
  assert.equal(notified.length, 1); assert.equal(notified[0].recipient, 'maker@test.local'); assert.match(notified[0].subject, /released for dispatch/);
  delete require.cache[require.resolve(path.join(ROOT, 'src/modules/b2b/notifications/service.js'))];
});

test('materials: only bill-of-materials items, earliest expiry first from available (keyed per batch), more than required needs a reason, a repeated key moves nothing', async () => {
  const mfg = require('../src/modules/erp/manufacturing/service.js');
  const bomRows = [[/FROM b2b_boms b JOIN b2b_products p ON p.id = b.product_id WHERE b.id = \?/, function () { return [{ id: 4, product_id: 1, sku: 'FG', name: 'Jaggery', version: 2, output_qty: 100, status: 'active' }]; }],
    [/FROM b2b_bom_lines l JOIN b2b_products p/, function () { return [{ id: 1, component_product_id: 2, sku: 'RM', name: 'Cane', qty: '110.0000', scrap_pct: '0.00' }]; }]];
  const mo = moRows({ status: 'released' });
  const base = function (issued, extra) {
    return [[/FROM b2b_mfg_orders WHERE id = \? FOR UPDATE/, function () { return [mo]; }], [/WHERE idem_key LIKE \?/, function () { return [{ n: 0 }]; }],
      [/SUM\(CASE WHEN kind = 'issue' THEN qty ELSE -qty END\) AS n FROM b2b_mfg_material_issues WHERE mo_id = \? GROUP BY/, function () { return issued || []; }]].concat(bomRows, extra || []);
  };
  await assert.rejects(mfg.issueMaterials(fakeTx(base()), STAFF, 21, { idempotencyKey: 'nope', lines: [{ productId: 2, qty: 1 }] }), function (e) { return e.code === 'bad_key'; });
  await assert.rejects(mfg.issueMaterials(fakeTx(base()), STAFF, 21, { idempotencyKey: UUID, lines: [{ productId: 9, qty: 1 }] }), /not on the bill of materials/);
  await assert.rejects(mfg.issueMaterials(fakeTx(base([{ product_id: 2, n: 100 }])), STAFF, 21, { idempotencyKey: UUID, lines: [{ productId: 2, qty: 20 }] }), function (e) { return e.code === 'over_issue'; }, 'requirement is 110; 100 + 20 > 110');
  const dup = fakeTx([[/FROM b2b_mfg_orders WHERE id = \? FOR UPDATE/, function () { return [mo]; }], [/WHERE idem_key LIKE \?/, function () { return [{ n: 2 }]; }]]);
  assert.deepEqual(await mfg.issueMaterials(dup, STAFF, 21, { idempotencyKey: UUID, lines: [{ productId: 2, qty: 5 }] }), { id: 21, duplicate: true });
  const moves = [], rows = [];
  const tx = fakeTx(base([], [[/FROM b2b_batches WHERE warehouse_id = \? AND product_id = \? AND status = 'active' AND qty_on_hand > 0/, function () { return [{ id: 71, lot_id: 81, batch_no: 'C1', expiry_date: '2027-01-01', qty_on_hand: 60 }, { id: 72, lot_id: 82, batch_no: 'C2', expiry_date: '2027-05-01', qty_on_hand: 100 }]; }],
    [/^UPDATE b2b_batches SET qty_on_hand = qty_on_hand - \?/, function () {}], [/^INSERT INTO b2b_mfg_material_issues/, function (a) { rows.push(a); }],
    [/^UPDATE b2b_mfg_orders SET status = \?/, function (a) { assert.equal(a[0], 'in_production'); }], [/^INSERT INTO b2b_mfg_order_events/, function () {}]].concat(LEDGER(moves), AUDIT)));
  const r = await mfg.issueMaterials(tx, STAFF, 21, { idempotencyKey: UUID, lines: [{ productId: 2, qty: 110 }] });
  assert.deepEqual(r.issued.map(function (x) { return [x.batchId, x.qty]; }), [[71, 60], [72, 50]]);
  assert.deepEqual(moves.map(function (m) { return [m.movement_type, m.from_status, m.to_status, m.qty, m.idem_key]; }),
    [['production_issue', 'available', null, 60, 'mi:' + UUID + ':2:71'], ['production_issue', 'available', null, 50, 'mi:' + UUID + ':2:72']]);
  assert.equal(rows.length, 2);
});

test('contract dispatch notices: a product made on a manufacturing order for this PO ships only in QC-released batches, up to the released quantity, with the recorded dates', async () => {
  const proc = require('../src/modules/erp/procurement/service.js');
  const po = { id: 9, vendor_id: 8, status: 'accepted' };
  const base = function (batch, shipped, extra) {
    return fakeTx([[/FROM b2b_purchase_orders WHERE id = \? AND vendor_id = \? FOR UPDATE/, function () { return [po]; }],
      [/FROM b2b_purchase_order_items poi JOIN b2b_products p/, function () { return [{ id: 101, po_id: 9, product_id: 1, name: 'Jaggery', qty_ordered: 100, qty_accepted_by_vendor: 100, qty_received: 0, is_batch_tracked: 1 }]; }],
      [/GROUP BY ai.po_item_id/, function () { return []; }], [/^INSERT INTO b2b_asns/, function () { return { insertId: 55 }; }],
      [/FROM b2b_mfg_orders WHERE po_id = \? AND product_id = \?/, function () { return [{ id: 21 }]; }],
      [/FROM b2b_mfg_batches b WHERE b.mo_id IN/, function () { return batch ? [batch] : null; }],
      [/COALESCE\(SUM\(ai.qty\), 0\) AS n FROM b2b_asn_items ai JOIN b2b_asns a/, function () { return [{ n: shipped || 0 }]; }]].concat(extra || [], AUDIT));
  };
  const vendor = { vendorId: 8, userId: 3, role: 'dispatch' };
  const released = { id: 31, batch_no: 'CM-7', status: 'released', released_qty: 50, mfg_date: '2026-11-01', expiry_date: '2027-11-01' };
  await assert.rejects(proc.createAsn(base(null), vendor, { poId: 9, items: [{ poItemId: 101, qty: 10, batchNo: 'CM-9', expiryDate: '2027-11-01' }] }), function (e) { return e.code === 'batch_not_released'; });
  await assert.rejects(proc.createAsn(base(Object.assign({}, released, { status: 'submitted' })), vendor, { poId: 9, items: [{ poItemId: 101, qty: 10, batchNo: 'CM-7', expiryDate: '2027-11-01' }] }), function (e) { return e.code === 'batch_not_released'; });
  await assert.rejects(proc.createAsn(base(released, 45), vendor, { poId: 9, items: [{ poItemId: 101, qty: 10, batchNo: 'CM-7', expiryDate: '2027-11-01' }] }), function (e) { return e.code === 'over_dispatch'; }, '45 sent + 10 > 50 released');
  await assert.rejects(proc.createAsn(base(released), vendor, { poId: 9, items: [{ poItemId: 101, qty: 10, batchNo: 'CM-7', expiryDate: '2028-01-01' }] }), /must match/);
  let item = null;
  const ok = base(released, 0, [[/^INSERT INTO b2b_asn_items/, function (a) { item = a; }]]);
  const r = await proc.createAsn(ok, vendor, { poId: 9, items: [{ poItemId: 101, qty: 50, batchNo: 'cm 7', expiryDate: '2027-11-01' }] });
  assert.equal(r.status, 'dispatched');
  assert.deepEqual(item.slice(1, 5), [101, 'CM-7', '2026-11-01', '2027-11-01'], 'the batch number and dates are the batch record\'s');
});

/* ───────────── delivery ───────────── */
test('shipment details: vehicle numbers, phones, e-way bills and modes are checked; readiness lists what is missing before dispatch', () => {
  const dl = require('../src/modules/erp/delivery/service.js');
  assert.equal(dl.vehicleNo('ka 01 ab 1234'), 'KA01AB1234');
  assert.equal(dl.vehicleNo('DL1CAB1234'), 'DL1CAB1234');
  assert.equal(dl.vehicleNo('22 BH 1234 AB'), '22BH1234AB');
  assert.throws(() => dl.vehicleNo('KA-1234'), /Vehicle number/);
  assert.throws(() => dl.clean({ mode: 'drone' }), /mode must be/);
  assert.throws(() => dl.clean({ mode: 'courier', driverPhone: '12345' }), /10-digit/);
  assert.throws(() => dl.clean({ mode: 'courier', ewayBillNo: '1234' }), /12 digits/);
  const c = dl.clean({ mode: 'own_vehicle', driverPhone: '+91 98450 12345', ewayBillNo: '1234 5678 9012', packages: '3', weightKg: '12.5' });
  assert.equal(c.driver_phone, '9845012345'); assert.equal(c.eway_bill_no, '123456789012'); assert.equal(c.packages, 3); assert.equal(c.weight_kg, '12.50');
  assert.deepEqual(dl.readiness({ mode: 'courier' }), ['the courier name', 'the tracking or LR number']);
  assert.deepEqual(dl.readiness({ mode: 'own_vehicle', vehicle_no: 'KA01AB1234' }), ['the driver or a delivery staff member']);
  assert.deepEqual(dl.readiness({ mode: 'own_vehicle', vehicle_no: 'KA01AB1234', delivery_staff_id: 4 }), []);
  assert.deepEqual(dl.readiness({ mode: 'pickup' }), []);
});

test('who sees a shipment: all with deliveries.view; delivery staff only theirs; a distributor only its own orders', () => {
  const dl = require('../src/modules/erp/delivery/service.js');
  const s = { seller_type: 'company', seller_account_id: null, delivery_staff_id: 4 };
  const staff = function (perms, id) { return { staff: { id: id || 4, permissions: new Set(perms) } }; };
  assert.equal(dl.canSee(s, staff(['deliveries.view'], 9)), true);
  assert.equal(dl.canSee(s, staff(['deliveries.update'], 4)), true);
  assert.equal(dl.canSee(s, staff(['deliveries.update'], 5)), false, 'another driver\'s shipment');
  assert.equal(dl.canSee(s, { sellerAccountId: 12 }), false, 'a company shipment is not a distributor\'s');
  assert.equal(dl.canSee({ seller_type: 'distributor', seller_account_id: 12 }, { sellerAccountId: 12 }), true);
  assert.equal(dl.canSee({ seller_type: 'distributor', seller_account_id: 12 }, { sellerAccountId: 13 }), false);
});

test('creating a shipment: only for a packed (or already moving) order, once per order; a moving order gets its challan at once', async () => {
  const dl = require('../src/modules/erp/delivery/service.js');
  const mgr = { staff: { id: 9, permissions: new Set(['deliveries.manage']) } };
  const order = function (status) { return { id: 30, status: status, seller_type: 'company', seller_account_id: null, warehouse_id: 3, dispatched_at: null, out_for_delivery_at: null }; };
  await assert.rejects(dl.create(fakeTx([[/FROM b2b_orders WHERE id = \? FOR UPDATE/, function () { return [order('processing')]; }]]), STAFF, mgr, { orderId: 30, mode: 'pickup' }), function (e) { return e.code === 'order_not_packed'; });
  await assert.rejects(dl.create(fakeTx([[/FROM b2b_orders WHERE id = \? FOR UPDATE/, function () { return [order('packed')]; }], [/SELECT id FROM b2b_shipments WHERE order_id = \?/, function () { return [{ id: 2 }]; }]]), STAFF, mgr, { orderId: 30, mode: 'pickup' }),
    function (e) { return e.status === 409 && e.code === 'shipment_exists'; });
  await assert.rejects(dl.create(fakeTx([]), STAFF, { staff: { id: 4, permissions: new Set(['deliveries.update']) } }, { orderId: 30, mode: 'pickup' }), /cannot create/);
  await assert.rejects(dl.create(fakeTx([[/FROM b2b_orders WHERE id = \? FOR UPDATE/, function () { return [order('packed')]; }]]), STAFF, { sellerAccountId: 12 }, { orderId: 30, mode: 'pickup' }), /Order not found/, 'a distributor cannot ship a company order');
  let row = null, challans = 0;
  const tx = fakeTx([[/FROM b2b_orders WHERE id = \? FOR UPDATE/, function () { return [order('dispatched')]; }], [/SELECT id FROM b2b_shipments WHERE order_id = \?/, function () { return null; }],
    [/^INSERT INTO b2b_shipments/, function (a) { row = a; return { insertId: 70 }; }], [/^INSERT INTO b2b_shipment_events/, function () {}],
    [/SELECT id, challan_no FROM b2b_delivery_challans WHERE shipment_id = \?/, function () { return null; }], [/SELECT \* FROM b2b_shipments WHERE id = \?/, function () { return [{ id: 70, order_id: 30 }]; }],
    [/FROM b2b_order_items i WHERE i.order_id = \?/, function () { return [{ id: 1, product_id: 1, sku: 'FG', name: 'Jaggery', hsn_code: '1701', qty: 10, unit_price: '100.00', gst_rate: '5.00', line_total: '1050.00' }]; }],
    [/FROM b2b_order_item_allocations a LEFT JOIN b2b_batches b/, function () { return [{ order_item_id: 1, qty: 6, batch_no: 'A', mfg_date: null, expiry_date: new Date('2027-01-31') }, { order_item_id: 1, qty: 4, batch_no: 'B', mfg_date: null, expiry_date: null }]; }],
    [/^INSERT INTO b2b_delivery_challans/, function (a) { challans++; const lines = JSON.parse(a[3]); assert.deepEqual(lines[0].batches.map(function (b) { return [b.batchNo, b.qty]; }), [['A', 6], ['B', 4]]); assert.equal(a[4], '1050.00'); }]].concat(SEQ, AUDIT));
  const r = await dl.create(tx, STAFF, mgr, { orderId: 30, mode: 'own_vehicle', vehicleNo: 'KA01AB1234', driverName: 'Ravi' });
  assert.equal(r.status, 'dispatched'); assert.equal(row[16], 'dispatched'); assert.equal(challans, 1);
});

test('dispatch drives the existing order transition, refuses an incomplete shipment, and applies the e-way bill decision (refuse above the decided value; warn above ₹50,000 while undecided)', async () => {
  const dl = require('../src/modules/erp/delivery/service.js');
  const db = require('../src/db/connection.js');
  const settings = require('../src/modules/erp/core/settings.js');
  const realQ = db.queryOne, realT = db.transaction, realGet = settings.get;
  const calls = [];
  const ordersPath = stub('src/modules/b2b/orders/service.js', { transition: async function (id, to, scope, actor, opts) { calls.push([id, to, scope, opts.note]); return { status: to, invoiceNo: 'INV-1' }; } });
  const mgr = { staff: { id: 9, permissions: new Set(['deliveries.manage']) } };
  let ship = { id: 70, shipment_no: 'SHP/2627/00001', order_id: 30, status: 'ready', mode: 'courier', carrier: 'BlueDart', tracking_no: null, lr_no: null, eway_bill_no: null, seller_type: 'company' };
  let value = '60000.00';
  try {
    db.queryOne = async function (sql) { if (/FROM b2b_shipments WHERE id = \?/.test(sql)) return ship; if (/FROM b2b_orders WHERE id = \?/.test(sql)) return { grand_total: value, status: 'packed' }; throw new Error(sql); };
    await assert.rejects(dl.dispatch(STAFF, mgr, 70), function (e) { return e.code === 'shipment_incomplete' && /tracking or LR/.test(e.message); });
    ship = Object.assign({}, ship, { tracking_no: 'BD123' });
    settings.get = async function (k) { return k === 'delivery.eway_bill_required_above' ? 50000 : undefined; };
    await assert.rejects(dl.dispatch(STAFF, mgr, 70), function (e) { return e.code === 'eway_bill_required'; });
    assert.equal(calls.length, 0, 'nothing moved before the checks pass');
    settings.get = async function () { return undefined; };
    let upd = 0, challan = 0;
    db.transaction = async function (fn) {
      return fn(fakeTx([[/FROM b2b_shipments WHERE id = \? FOR UPDATE/, function () { return [ship]; }], [/^UPDATE b2b_shipments SET status = 'dispatched'/, function () { upd++; }], [/^INSERT INTO b2b_shipment_events/, function () {}],
        [/SELECT id, challan_no FROM b2b_delivery_challans/, function () { return challan ? [{ id: 1, challan_no: 'DC/2627/00007' }] : null; }], [/SELECT \* FROM b2b_shipments WHERE id = \?$/, function () { return [ship]; }],
        [/FROM b2b_order_items i WHERE/, function () { return []; }], [/FROM b2b_order_item_allocations a LEFT JOIN/, function () { return []; }], [/^INSERT INTO b2b_delivery_challans/, function () { challan++; }]].concat(SEQ, AUDIT)));
    };
    const r = await dl.dispatch(STAFF, mgr, 70);
    assert.deepEqual(calls, [[30, 'dispatched', { admin: true, permissions: ['b2b.orders.fulfil'] }, 'Shipment SHP/2627/00001']]);
    assert.equal(r.status, 'dispatched'); assert.equal(r.invoiceNo, 'INV-1'); assert.equal(upd, 1); assert.equal(challan, 1);
    assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /e-way bill/);
    // a distributor dispatches as the seller, not as an administrator
    calls.length = 0; ship = Object.assign({}, ship, { seller_type: 'distributor', seller_account_id: 12 }); value = '100.00';
    await dl.dispatch({ type: 'business', id: 2 }, { sellerAccountId: 12 }, 70);
    assert.deepEqual(calls[0].slice(0, 3), [30, 'dispatched', { sellerAccountId: 12 }]);
  } finally { db.queryOne = realQ; db.transaction = realT; settings.get = realGet; delete require.cache[ordersPath]; }
});

test('delivered needs who received it; back-to-warehouse needs a reason and goes through the order flow as "returned" with the condition', async () => {
  const dl = require('../src/modules/erp/delivery/service.js');
  const db = require('../src/db/connection.js');
  const realQ = db.queryOne, realT = db.transaction;
  const calls = [];
  const ordersPath = stub('src/modules/b2b/orders/service.js', { transition: async function (id, to, scope, actor, opts) { calls.push([to, opts]); return { status: to === 'delivered' && opts.delivered && opts.delivered[1] < 10 ? 'partially_delivered' : to, invoiceNo: 'INV-2', creditNote: null }; } });
  const mgr = { staff: { id: 9, permissions: new Set(['deliveries.manage']) } };
  const ship = { id: 70, shipment_no: 'SHP/2627/00001', order_id: 30, status: 'out_for_delivery', seller_type: 'company' };
  try {
    db.queryOne = async function (sql) { if (/FROM b2b_shipments WHERE id = \?/.test(sql)) return ship; if (/FROM b2b_orders WHERE id = \?/.test(sql)) return { status: 'out_for_delivery' }; throw new Error(sql); };
    let final = null;
    db.transaction = async function (fn) { return fn(fakeTx([[/FOR UPDATE/, function () { return [ship]; }], [/^UPDATE b2b_shipments SET status = \?, delivered_at/, function (a) { final = a; }], [/^UPDATE b2b_shipments SET status = 'returned'/, function () {}], [/^INSERT INTO b2b_shipment_events/, function () {}]].concat(AUDIT))); };
    await assert.rejects(dl.deliver(STAFF, mgr, 70, { receivedBy: '' }), /who received/);
    await assert.rejects(dl.deliver(STAFF, mgr, 70, { receivedBy: 'Meena', receiverPhone: '123' }), /10-digit/);
    const r = await dl.deliver(STAFF, mgr, 70, { receivedBy: 'Meena', receiverPhone: '9845011111', delivered: { 1: 8 } });
    assert.equal(r.status, 'partially_delivered'); assert.equal(final[0], 'partially_delivered'); assert.equal(final[1], 'Meena');
    assert.equal(calls[0][0], 'delivered'); assert.deepEqual(calls[0][1].delivered, { 1: 8 });
    await assert.rejects(dl.returnToWarehouse(STAFF, mgr, 70, { reason: 'no' }), /at least 5 characters/);
    await assert.rejects(dl.returnToWarehouse(STAFF, { staff: { id: 4, permissions: new Set(['deliveries.update']) } }, 70, { reason: 'shop closed for good' }), /Shipment not found|warehouse/);
    calls.length = 0;
    await dl.returnToWarehouse(STAFF, mgr, 70, { reason: 'refused by the buyer', condition: 'damaged' });
    assert.deepEqual(calls[0], ['returned', { note: 'refused by the buyer', condition: 'damaged' }]);
  } finally { db.queryOne = realQ; db.transaction = realT; delete require.cache[ordersPath]; }
});

test('order flow: undelivered goods can go back from dispatched / out for delivery (seller or fulfilment only), and come back to stock once per allocation', async () => {
  const sm = require('../src/modules/b2b/orders/stateMachine.js');
  const admin = { kind: 'admin', permissions: ['b2b.orders.fulfil'] };
  assert.equal(sm.allowed('dispatched', 'returned', admin), true);
  assert.equal(sm.allowed('out_for_delivery', 'returned', { kind: 'seller' }), true);
  assert.equal(sm.allowed('out_for_delivery', 'returned', { kind: 'buyer' }), false);
  assert.equal(sm.allowed('delivered', 'returned', admin), false, 'returns after delivery still go through the returns workflow');
  assert.equal(sm.allowed('packed', 'returned', admin), false);
  const inv = require('../src/modules/b2b/inventory/service.js');
  const moves = [], batchUpd = [];
  const tx = fakeTx([[/FROM b2b_order_item_allocations a JOIN b2b_order_items i/, function () { return [{ id: 1, batch_id: 61, qty: 6, product_id: 1 }, { id: 2, batch_id: 62, qty: 4, product_id: 1 }]; }],
    [/^UPDATE b2b_batches SET qty_on_hand = qty_on_hand \+ \?/, function (a) { batchUpd.push(a); }]].concat(LEDGER(moves, { posted: ['order:30:undelivered:2'] })));
  await inv.returnUndelivered(tx, { id: 30, stock_reserved: 1, warehouse_id: 3 }, { type: 'system' }, 'good', 'refused');
  assert.deepEqual(moves.map(function (m) { return [m.movement_type, m.from_status, m.to_status, m.qty, m.idem_key]; }), [['return', 'in_transit', 'available', 6, 'order:30:undelivered:1']]);
  assert.deepEqual(batchUpd, [[6, 61]], 'the second allocation was already posted: its batch is not counted twice');
  const moves2 = [];
  const tx2 = fakeTx([[/FROM b2b_order_item_allocations a JOIN b2b_order_items i/, function () { return [{ id: 1, batch_id: 61, qty: 6, product_id: 1 }]; }]].concat(LEDGER(moves2)));
  await inv.returnUndelivered(tx2, { id: 30, stock_reserved: 1, warehouse_id: 3 }, { type: 'system' }, 'damaged', 'crushed');
  assert.equal(moves2[0].to_status, 'damaged');
});

test('the shipment follows the order wherever it was moved; the challan is issued once it has left', async () => {
  const dl = require('../src/modules/erp/delivery/service.js');
  const db = require('../src/db/connection.js');
  const realT = db.transaction;
  let ship = { id: 70, order_id: 30, status: 'ready' }, orderStatus = 'dispatched', updates = [], challans = 0;
  try {
    db.transaction = async function (fn) {
      return fn(fakeTx([[/FROM b2b_shipments WHERE order_id = \? FOR UPDATE/, function () { return [ship]; }], [/FROM b2b_orders WHERE id = \?/, function () { return [{ status: orderStatus }]; }],
        [/^UPDATE b2b_shipments SET status = \?/, function (a) { updates.push(a[0]); ship = Object.assign({}, ship, { status: a[0] }); }], [/^INSERT INTO b2b_shipment_events/, function () {}],
        [/SELECT id, challan_no FROM b2b_delivery_challans/, function () { return challans ? [{ id: 1, challan_no: 'DC' }] : null; }], [/SELECT \* FROM b2b_shipments WHERE id = \?$/, function () { return [ship]; }],
        [/FROM b2b_order_items i WHERE/, function () { return []; }], [/FROM b2b_order_item_allocations a LEFT JOIN/, function () { return []; }], [/^INSERT INTO b2b_delivery_challans/, function () { challans++; }]].concat(SEQ)));
    };
    assert.deepEqual(await dl.followOrder(30), { followed: true, status: 'dispatched' });
    orderStatus = 'delivered';
    assert.deepEqual(await dl.followOrder(30), { followed: true, status: 'delivered' });
    orderStatus = 'out_for_delivery';
    assert.deepEqual(await dl.followOrder(30), { followed: false }, 'never moves backwards');
    assert.deepEqual(updates, ['dispatched', 'delivered']); assert.equal(challans, 1);
    // a failed attempt is not reset to "dispatched" by an order that has not moved since
    ship = { id: 71, order_id: 31, status: 'attempt_failed' }; orderStatus = 'dispatched';
    assert.deepEqual(await dl.followOrder(31), { followed: false });
    assert.deepEqual(updates, ['dispatched', 'delivered']);
  } finally { db.transaction = realT; }
});

test('an offline delivery update needs the delivery permission and runs the same online step', async () => {
  const off = require('../src/modules/erp/offline/service.js');
  assert.ok(off.KINDS.indexOf('delivery') !== -1);
  const src = read('src/modules/erp/offline/service.js');
  assert.match(src, /kind === 'delivery'[\s\S]{0,400}deliveries\.update[\s\S]{0,800}d\.outForDelivery[\s\S]{0,200}d\.location[\s\S]{0,200}d\.attemptFailed[\s\S]{0,200}d\.deliver/);
  assert.match(read('src/db/migrations/020_manufacturing_delivery.js'), /"b2b_offline_ops", "column": "kind", "def": "ENUM\('event_sale','event_payment','field_order','visit','location','delivery'\) NOT NULL"/);
});

test('manufacturer profile: only the vendor\'s own business details change; legal identity (name, GSTIN, PAN, FSSAI) cannot be edited from the portal', async () => {
  const vs = require('../src/modules/erp/vendors/service.js');
  const vendor = { vendorId: 8, userId: 3, role: 'owner' };
  await assert.rejects(vs.updateProfile(fakeTx([]), vendor, { legalName: 'New Name', gstin: '29AAAAA0000A1Z5', pan: 'AAAAA0000A' }), /Nothing to change/);
  await assert.rejects(vs.updateProfile(fakeTx([]), vendor, { website: 'javascript:alert(1)' }), /http/);
  await assert.rejects(vs.updateProfile(fakeTx([]), vendor, { defaultLeadDays: 999 }), /0–365/);
  await assert.rejects(vs.updateProfile(fakeTx([]), vendor, { contactMobile: '12345' }), /10-digit/);
  let vendorSet = null, userSet = null;
  const tx = fakeTx([[/FROM b2b_vendors WHERE id = \? FOR UPDATE/, function () { return [{ trade_name: null }]; }], [/^UPDATE b2b_vendors SET/, function (a, sql) { vendorSet = [sql, a]; }],
    [/^UPDATE b2b_vendor_users SET/, function (a, sql) { userSet = [sql, a]; }]].concat(AUDIT));
  const r = await vs.updateProfile(tx, vendor, { tradeName: 'Mandya Cane', website: 'https://mandya.example', defaultLeadDays: '12', contactMobile: '+91 98450 00001', gstin: 'IGNORED', legalName: 'IGNORED' });
  assert.deepEqual(r.changed.sort(), ['default_lead_days', 'mobile', 'trade_name', 'website']);
  assert.doesNotMatch(vendorSet[0], /gstin|legal_name|pan|fssai/);
  assert.deepEqual(userSet[1], ['9845000001', 3, 8], 'only the signed-in user of this vendor');
});

/* ───────────── wiring, permissions, schema ───────────── */
test('every business decision accepts its own proposed value; the online-shop stock decisions can actually be set (regression)', () => {
  const settings = require('../src/modules/erp/core/settings.js');
  const cat = require('../src/modules/erp/core/settings-catalog.json');
  const bad = cat.settings.filter(function (e) { return e.proposal != null; }).filter(function (e) { try { settings.validate(e.key, e.proposal); return false; } catch (x) { return true; } });
  assert.deepEqual(bad.map(function (e) { return e.key; }), []);
  assert.equal(settings.validate('inventory.b2c_stock_mode', 'shadow'), 'shadow');
  assert.throws(() => settings.validate('inventory.b2c_stock_mode', 'on'));
  assert.equal(settings.validate('inventory.b2c_warehouse_id', 9), 9);
  assert.throws(() => settings.validate('inventory.b2c_warehouse_id', 0));
  assert.equal(settings.validate('inventory.b2c_hold_minutes', 30), 30);
  assert.throws(() => settings.validate('inventory.b2c_hold_minutes', 2));
  assert.equal(settings.validate('delivery.max_attempts', 3), 3);
  assert.throws(() => settings.validate('delivery.max_attempts', 11));
  assert.equal(settings.validate('manufacturing.own_manufacturer_vendor_id', 77), 77);
});

test('permissions: manufacturing and delivery rights exist, activating a bill of materials needs two-factor sign-in, and delivery staff get only their own deliveries', () => {
  const ref = require('../src/modules/erp/catalog/reference-data.json');
  const identity = require('../src/modules/erp/core/identity.js');
  const codes = ref.permissions.map(function (p) { return p.code; });
  ['manufacturing.view', 'manufacturing.manage', 'manufacturing.bom.approve', 'manufacturing.issue', 'manufacturing.qc.release', 'deliveries.view', 'deliveries.manage', 'deliveries.update'].forEach(function (c) { assert.ok(codes.indexOf(c) !== -1, c); });
  assert.equal(ref.permissions.filter(function (p) { return p.code === 'manufacturing.bom.approve'; })[0].is_sensitive, true);
  assert.equal(identity.needsMfa('manufacturing.bom.approve'), true);
  const role = function (c) { return ref.roles.filter(function (r) { return r.code === c; })[0]; };
  assert.deepEqual(role('delivery_staff').permissions.sort(), ['core.self.view', 'deliveries.update']);
  assert.ok(role('quality_control').permissions.indexOf('manufacturing.qc.release') !== -1);
  assert.ok(role('procurement_manager').permissions.indexOf('manufacturing.qc.release') === -1, 'buyers do not release their own batches');
  assert.ok(role('warehouse_manager').permissions.indexOf('deliveries.manage') !== -1);
  ref.roles.forEach(function (r) { r.permissions.forEach(function (p) { assert.ok(codes.indexOf(p) !== -1, r.code + ' grants unknown ' + p); }); });
});

test('migration 020: only new tables (pinned), one shipment and one challan per order, keyed material issues, batch numbers unique per order; enum extensions keep every existing value first', () => {
  const sql = read('src/db/migrations/sql/020_manufacturing_delivery.sql');
  const m = require('../src/db/migrations/020_manufacturing_delivery.js');
  const crypto = require('crypto');
  assert.match(read('src/db/migrations/020_manufacturing_delivery.js'), new RegExp(crypto.createHash('sha256').update(sql).digest('hex')));
  const body = sql.split('\n').filter(function (l) { return !/^\s*--/.test(l); }).join('\n');
  body.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (s) { assert.match(s, /^CREATE TABLE IF NOT EXISTS b2b_\w+ \(/); });
  ['UNIQUE KEY uq_b2b_ship_order (order_id)', 'UNIQUE KEY uq_b2b_dc_ship (shipment_id)', 'UNIQUE KEY uq_b2b_mmi_key (idem_key)', 'UNIQUE KEY uq_b2b_mfgb_batch (mo_id, batch_no_norm)', 'UNIQUE KEY uq_b2b_shipe_client (client_uuid)', 'UNIQUE KEY uq_b2b_bom_version (product_id, version)']
    .forEach(function (k) { assert.ok(sql.indexOf(k) !== -1, k); });
  const enumOf = function (def) { return def.match(/ENUM\(([^)]*)\)/)[1].split(',').map(function (s) { return s.trim().replace(/'/g, ''); }); };
  const before = { movement_type: enumOf(require('../src/db/migrations/017_inventory_ledger.js').OPS.filter(function (o) { return o.column === 'movement_type'; }).slice(-1)[0].def), capability: ['manufacturer', 'authorised_distributor', 'supplier_wholesaler'],
    kind: ['event_sale', 'event_payment', 'field_order', 'visit', 'location'] };
  m.OPS.filter(function (o) { return o.op === 'extendEnum'; }).forEach(function (o) {
    const now = enumOf(o.def), old = before[o.column];
    assert.deepEqual(now.slice(0, old.length), old, o.table + '.' + o.column + ' keeps its values first');
  });
  assert.ok(m.OPS.every(function (o) { return ['addColumn', 'extendEnum'].indexOf(o.op) !== -1; }));
});

test('screens and routes: five new admin screens in the one sidebar; the manufacturer portal is fenced to the signed-in vendor; the order view carries the shipment', () => {
  const reg = require('../src/platform/registry.js');
  const pages = reg.PAGES.filter(function (p) { return p.module === 'erp'; });
  const want = { manufacturers: 'manufacturing.view', manufacturing: 'manufacturing.view', quality: 'manufacturing.view', boms: 'manufacturing.view', deliveries: 'deliveries.view' };
  Object.keys(want).forEach(function (v) { const p = pages.filter(function (x) { return x.view === v; })[0]; assert.ok(p, v); assert.equal(p.perm, want[v]); });
  assert.ok(reg.GROUPS.some(function (g) { return g.id === 'manufacturing'; }));
  const vp = read('src/modules/erp/routes/vendor-portal.js');
  assert.match(vp, /manufacturing-orders[\s\S]*req\.vendor\.vendorId/);
  const svc = read('src/modules/erp/manufacturing/service.js');
  assert.match(svc, /async function vendorMo\(tx, vendor, id\) \{\s*const m = await lockMo\(tx, id\);\s*if \(Number\(m\.vendor_id\) !== Number\(vendor\.vendorId\) \|\| m\.status === 'draft'\) throw fail\(404/);
  assert.match(read('src/modules/erp/index.js'), /api\.use\('\/manufacturing', require\('\.\/routes\/manufacturing\.js'\)\);\s*api\.use\('\/deliveries', require\('\.\/routes\/deliveries\.js'\)\);/);
  assert.match(read('src/modules/erp/index.js'), /require\('\.\/delivery\/service\.js'\)\.attach\(\);/);
  const orders = require('../src/modules/b2b/orders/service.js');
  assert.equal(typeof orders.onTransition, 'function'); assert.equal(typeof orders.extendDetail, 'function');
  assert.match(read('erp-web/admin/production.js'), /window\.ERP_VIEWS\.push\(/);
  assert.match(read('erp-web/sales/app.js'), /sendOrQueue\('delivery'/);
  assert.match(read('b2b-web/portal/app.js'), /\/retailer-orders\/' \+ id \+ '\/shipment'/);
});
