/**
 * Milestone 3b.1 on MySQL 8 (TEST database only; refuses while 013/014 are present).
 * Real server, real schema up to 017: opening balances and adjustments need a second
 * person; keyed movements post once; B2B orders never use event/salesman locations;
 * direct company stock entry is refused; reconciliation stays clean.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, bearer } = require('./helpers/erp.js');
const { gstin } = require('./helpers/db.js');

let c, s, admin;
const S = {};
const stockOf = async (w, p) => c.db.queryOne('SELECT * FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [w, p]);

test.before(async () => {
  c = await setup(); s = c.s;
  admin = bearer((await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token);
  const ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  S.w = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active) VALUES ('BLR1', 'Bengaluru DC', ?, 'Bengaluru', '560001', 10, 1)", [ka])).insertId);
  S.ev = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active, warehouse_type) VALUES ('EVT1', 'Expo stall', ?, 'Bengaluru', '560001', 99, 1, 'event')", [ka])).insertId);
  S.p = Number((await c.db.query("INSERT INTO b2b_products (sku, name, hsn_code, gst_rate, mrp, base_price, retailer_price, distributor_price, moq, case_qty, is_active, avail_b2c, avail_retailer, avail_distributor) " +
    "VALUES ('CUR60', 'Curcumin 60 caps', '21069099', '18.00', '600.00', '300.00', '420.00', '380.00', 1, 1, 1, 0, 1, 1)")).insertId);
  S.v = Number((await c.db.query("INSERT INTO b2b_vendors (legal_name, gstin, pan, status, onboarding, state_id, vendor_code) VALUES ('Test Nutra Pvt Ltd', ?, 'AAACT1234F', 'approved', 'invited', ?, 'V00009')", [gstin('29', 'AAACT1234F'), ka])).insertId);
  S.wm = await c.person('whm', [{ code: 'warehouse_manager', scopeType: 'warehouse', scopeId: S.w }]);
});
test.after(async () => { if (c) await c.stop(); });

test('opening balance: proposed by one person, approved by another, posted once with its lot', async () => {
  const r = await s.post('/api/erp/inventory/adjustments', { kind: 'opening', warehouseId: S.w, productId: S.p, qty: 120, batchNo: 'B-OPEN-1', expiry: '2028-06-30', manufacturerId: S.v, reason: 'Physical count on go-live day' }, S.wm.h);
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal((await stockOf(S.w, S.p)), null, 'nothing posted before approval');
  assert.equal((await s.post('/api/erp/core/approvals/' + r.data.approvalId + '/decide', { decision: 'approved' }, S.wm.h)).status, 403, 'the proposer cannot approve');
  await c.approve(r.data.approvalId);
  assert.equal(Number((await stockOf(S.w, S.p)).qty_available), 120);
  const mv = await c.db.query("SELECT movement_type, qty, idem_key, lot_id FROM b2b_stock_movements WHERE warehouse_id = ? AND product_id = ?", [S.w, S.p]);
  assert.equal(mv.length, 1); assert.equal(mv[0].movement_type, 'opening'); assert.equal(mv[0].idem_key, 'adj:' + r.data.adjustmentId); assert.ok(mv[0].lot_id);
  const again = await s.post('/api/erp/inventory/adjustments', { kind: 'opening', warehouseId: S.w, productId: S.p, qty: 5, batchNo: 'B-OPEN-1', expiry: '2028-06-30', manufacturerId: S.v, reason: 'second try at opening' }, S.wm.h);
  assert.equal(again.status, 400); assert.equal(again.data.code, 'has_history');
});

test('keyed movement: the same key posts once; a replay changes nothing', async () => {
  const ledger = require('../src/modules/erp/inventory/ledger.js');
  const before = await stockOf(S.w, S.p);
  const m = { warehouseId: S.w, productId: S.p, type: 'adjustment', qty: 3, from: 'available', to: 'damaged', refType: 'test', refId: 1, actor: { type: 'system' }, idemKey: 'test:replay:1' };
  await c.db.transaction(function (tx) { return ledger.mustMove(tx, m); });
  await assert.rejects(c.db.transaction(function (tx) { return ledger.mustMove(tx, m); }), function (e) { return e.code === 'duplicate_movement'; });
  const after = await stockOf(S.w, S.p);
  assert.equal(Number(after.qty_available), Number(before.qty_available) - 3);
  assert.equal(Number((await c.db.queryOne("SELECT COUNT(*) AS n FROM b2b_stock_movements WHERE idem_key = 'test:replay:1'")).n), 1);
  // two concurrent posts with one key: exactly one lands
  const m2 = Object.assign({}, m, { idemKey: 'test:race:1', to: 'expired' });
  const res = await Promise.allSettled([1, 2].map(function () { return c.db.transaction(function (tx) { return ledger.mustMove(tx, m2); }); }));
  assert.equal(res.filter(function (x) { return x.status === 'fulfilled'; }).length, 1);
  assert.equal(Number((await stockOf(S.w, S.p)).qty_expired), 3);
});

test('adjustment decrease: refused when the stock is not there; posted after approval', async () => {
  const big = await s.post('/api/erp/inventory/adjustments', { kind: 'adjustment', direction: 'decrease', bucket: 'available', reasonCode: 'loss', warehouseId: S.w, productId: S.p, qty: 100000, reason: 'Missing after audit' }, S.wm.h);
  assert.equal(big.status, 400); assert.equal(big.data.code, 'insufficient_stock');
  const r = await s.post('/api/erp/inventory/adjustments', { kind: 'adjustment', direction: 'decrease', bucket: 'available', reasonCode: 'loss', warehouseId: S.w, productId: S.p, qty: 4, reason: 'Missing after audit' }, S.wm.h);
  assert.equal(r.status, 202);
  const before = Number((await stockOf(S.w, S.p)).qty_available);
  await c.approve(r.data.approvalId);
  assert.equal(Number((await stockOf(S.w, S.p)).qty_available), before - 4);
  const list = await s.get('/api/erp/inventory/adjustments', S.wm.h);
  assert.equal(list.data.items.find(function (a) { return a.id === r.data.adjustmentId; }).status, 'posted');
});

test('decision 5: direct company stock entry is refused while the ERP runs', async () => {
  const r = await s.post('/api/admin/b2b/stock/entry', { warehouse_id: S.w, product_id: S.p, operation: 'purchase', qty: 50, reason: 'bought locally' }, admin);
  assert.equal(r.status, 409); assert.equal(r.data.code, 'use_adjustment');
});

test('B2B orders never take stock from an event location', async () => {
  const ledger = require('../src/modules/erp/inventory/ledger.js');
  await c.db.transaction(function (tx) { return ledger.mustMove(tx, { warehouseId: S.ev, productId: S.p, type: 'transfer_in', qty: 500, to: 'available', actor: { type: 'system' }, idemKey: 'test:event:stock' }); });
  const inv = require('../src/modules/b2b/inventory/service.js');
  const whs = await inv.companyWarehouses();
  assert.ok(whs.every(function (w) { return Number(w.id) !== S.ev; }), 'event location never offered to B2B orders');
});

test('reconciliation stays clean after the opening balance and adjustments', async () => {
  const r = await s.get('/api/erp/inventory/reconciliation', c.maker.h);
  assert.equal(r.status, 200);
  const mine = (r.data.issues || []).filter(function (i) { return Number(i.warehouseId || i.warehouse_id) === S.w; });
  assert.deepEqual(mine, [], JSON.stringify(mine));
});

test('migration 017 again: nothing changes; duplicate shop links are refused before any change', async () => {
  const migrate = require('../src/db/migrate.js');
  const again = await migrate.up();
  assert.equal((again.applied || []).length, 0);
  const m017 = require('../src/db/migrations/017_inventory_ledger.js');
  await c.db.withConnection(async function (conn) { assert.deepEqual(await m017.duplicateShopRefs(conn), []); });
});
