/**
 * Phase 3 — products, tax rates, price lists (integration, TEST database).
 * Uses the real "SS Price list 09.10.2026 FMCG.xlsx" as the fixture.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, upload } = require('./helpers/erp.js');

const XLSX = fs.readFileSync(path.join(__dirname, 'fixtures', 'ss-price-list-2026-10-09.xlsx'));
const GOLDEN = require('./fixtures/ss-price-list-golden.json');
let c, s, list;

test.before(async () => { c = await setup(); s = c.s; });
test.after(async () => { if (c) await c.stop(); });

test('import: 235 priced exactly as the sheet, rows 188–189 and 204–206 held and not stored', async () => {
  const sales = await c.person('sam', ['salesman']);
  assert.equal((await upload(s, '/api/erp/catalog/price-lists/imports', { code: 'SST-FMCG', name: 'x' }, { data: XLSX, name: 'a.xlsx' }, sales.h)).status, 403);
  const r = await upload(s, '/api/erp/catalog/price-lists/imports', { code: 'SST-FMCG', name: 'SS Price List revised 9 Oct 2026', brand: 'Sri Sri Tattva', createMissing: 'true' },
    { data: XLSX, name: 'SS Price list 09.10.2026 FMCG.xlsx' }, c.maker.h);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  list = r.data;
  assert.equal(list.version, 1); assert.equal(list.status, 'draft');
  assert.equal(list.report.priced, 235);
  assert.deepEqual(list.report.held.map(function (h) { return h.row; }), [188, 189, 204, 205, 206]);
  assert.equal(list.report.created.length, 235, 'products created for priced rows only');
  assert.equal(list.report.warnings.length, 0);
  // created products are invisible to every channel
  const vis = await c.db.queryOne('SELECT SUM(is_active) a, SUM(avail_b2c) b, SUM(avail_retailer) r, SUM(avail_distributor) d FROM b2b_products');
  assert.deepEqual([Number(vis.a), Number(vis.b), Number(vis.r), Number(vis.d)], [0, 0, 0, 0]);
  // stored prices equal the sheet for every priced row; held SAP codes have no item
  const items = await c.db.query('SELECT i.*, p.sap_code FROM b2b_price_list_items i JOIN b2b_products p ON p.id = i.product_id WHERE i.price_list_id = ?', [list.priceListId]);
  assert.equal(items.length, 235);
  const bySap = {}; items.forEach(function (i) { bySap[i.sap_code] = i; });
  GOLDEN.rows.forEach(function (g) {
    if (g.status === 'held') { assert.ok(!bySap[g.sap] || bySap[g.sap].source_row_no !== g.row, 'held row ' + g.row + ' must not be priced'); return; }
    const it = bySap[g.sap];
    Object.keys(g.expected).forEach(function (k) { assert.equal(Number(it[k]).toFixed(2), Number(g.expected[k]).toFixed(2), 'row ' + g.row + ' ' + k); });
  });
  assert.equal(Number(bySap['14001851'].purchase_cost_ex), 63.4892, 'brown sugar 500 g: PTD ex 69.01 less 8 % scheme');
  const rep = await s.get('/api/erp/catalog/price-lists/' + list.priceListId + '/report', c.maker.h);
  assert.equal(rep.data.report.held.length, 5);
  assert.match(rep.data.report.held[0].reasons.join(' '), /MRP cell is not a number/);
});

test('a second import of the same code is version 2; nothing is published by importing', async () => {
  const r = await upload(s, '/api/erp/catalog/price-lists/imports', { code: 'SST-FMCG', name: 'Re-import' }, { data: XLSX, name: 'b.xlsx' }, c.maker.h);
  assert.equal(r.status, 201); assert.equal(r.data.version, 2);
  assert.equal(r.data.report.created.length, 0, 'second run matches the products by SAP code');
  const p = await c.db.queryOne("SELECT retailer_price, distributor_price FROM b2b_products WHERE sap_code = '14001851'");
  assert.equal(p.retailer_price, null); assert.equal(p.distributor_price, null);
});

test('submit is blocked while products have no approved tax rate (fail closed)', async () => {
  const r = await s.post('/api/erp/catalog/price-lists/' + list.priceListId + '/submit', { reason: 'Brand revision 9 Oct' }, c.maker.h);
  assert.equal(r.status, 409); assert.equal(r.data.code, 'blocked');
  assert.match(r.data.blockers.join(' '), /235 product\(s\) have no approved tax rate/);
  const d = await s.get('/api/erp/catalog/price-lists/' + list.priceListId + '/diff', c.maker.h);
  assert.deepEqual(d.data.tiersWritten, ['retailer', 'distributor'], 'tiers decision pending → existing tiers only');
  const bs = d.data.items.find(function (i) { return i.row === 7; });
  assert.deepEqual(bs.changes.distributor_price, { from: null, to: '69.01' });
  assert.equal(bs.changes.super_stockist_price, undefined, 'no super-stockist price while D5 is pending');
});

test('tax rate: proposal → approval by another person; the product master is not changed by it', async () => {
  const pid = (await c.db.queryOne("SELECT id FROM b2b_products WHERE sap_code = '14001851'")).id;
  assert.equal((await s.post('/api/erp/catalog/tax-rates', { productId: Number(pid), hsnCode: '1701', gstRate: 7, validFrom: '2026-01-01', sourceNote: 'CA review' }, c.maker.h)).status, 400);
  const r = await s.post('/api/erp/catalog/tax-rates', { productId: Number(pid), hsnCode: '17010000', gstRate: 5, validFrom: '2026-01-01', sourceNote: 'CA review Nov 2026 (invoice 4050191465)' }, c.maker.h);
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal((await s.post('/api/erp/core/approvals/' + r.data.approvalId + '/decide', { decision: 'approved' }, c.maker.h)).status, 403, 'maker cannot approve');
  await c.approve(r.data.approvalId);
  const t = await c.db.queryOne('SELECT status FROM b2b_tax_rates WHERE id = ?', [r.data.taxRateId]);
  assert.equal(t.status, 'approved');
  const list2 = await s.get('/api/erp/catalog/products?q=14001851', c.maker.h);
  assert.equal(Number(list2.data.items[0].approved_gst_rate), 5);
});

test('product master edits: prices and HSN refused; allowed fields audited', async () => {
  const pid = Number((await c.db.queryOne("SELECT id FROM b2b_products WHERE sap_code = '14001851'")).id);
  const bad = await s.patch('/api/erp/catalog/products/' + pid, { mrp: 1 }, c.maker.h);
  assert.equal(bad.status, 400); assert.equal(bad.data.code, 'use_price_list');
  const ok = await s.patch('/api/erp/catalog/products/' + pid, { shelf_life_days: 365, reason: 'From the brand spec sheet' }, c.maker.h);
  assert.equal(ok.status, 200);
  const a = await c.db.queryOne("SELECT old_value, new_value FROM b2b_audit_logs WHERE action = 'product.updated' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(pid)]);
  assert.match(a.new_value, /365/);
});

test('publish: approval by someone else, then publish writes PTR/PTD ex-GST; the existing engine uses them', async () => {
  await c.setting('tax.require_approved_rate_for_new_price_lists', false);   // the business decision, approved by two people
  assert.equal((await s.post('/api/erp/catalog/price-lists/' + list.priceListId + '/publish', {}, c.maker.h)).status, 409, 'not approved yet');
  const sub = await s.post('/api/erp/catalog/price-lists/' + list.priceListId + '/submit', { reason: 'Brand revision 9 Oct' }, c.maker.h);
  assert.equal(sub.status, 202, JSON.stringify(sub.data));
  const wh = await c.person('wendy', ['warehouse_manager']);
  assert.equal((await s.post('/api/erp/catalog/price-lists/' + list.priceListId + '/publish', {}, wh.h)).status, 403);
  await c.approve(sub.data.approvalId);
  const pub = await s.post('/api/erp/catalog/price-lists/' + list.priceListId + '/publish', {}, c.maker.h);
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.products, 235);
  const p = await c.db.queryOne("SELECT id, mrp, retailer_price, distributor_price, super_stockist_price, base_price, hsn_code FROM b2b_products WHERE sap_code = '14001851'");
  assert.deepEqual([p.mrp, p.retailer_price, p.distributor_price, p.base_price], ['90.00', '74.53', '69.01', '63.49']);
  assert.equal(p.super_stockist_price, null);
  const sim = await s.post('/api/erp/catalog/pricing/simulate', { productId: Number(p.id), audience: 'distributor', qty: 10 }, c.maker.h);
  assert.equal(sim.data.unitPriceExGst, '69.01'); assert.equal(sim.data.source, 'product');
  const again = await s.post('/api/erp/catalog/price-lists/' + list.priceListId + '/publish', {}, c.maker.h);
  assert.equal(again.status, 409, 'publishing twice is refused');
  const n = await c.db.queryOne("SELECT COUNT(*) n FROM b2b_audit_logs WHERE action = 'product.prices_published'");
  assert.equal(Number(n.n), 235);
});

test('simulate the divide chain; schemes start inactive and need approval; free-quantity refused', async () => {
  const sim = await s.post('/api/erp/catalog/pricing/simulate', { mrp: 90, gstPct: 5, retailerMarginPct: 15, distributorMarginPct: 8, ssMarginPct: 5, schemePct: 8 }, c.maker.h);
  assert.equal(sim.data.ptd_ex, 69.01); assert.equal(sim.data.ptss_ex, 65.72);
  const pid = Number((await c.db.queryOne("SELECT id FROM b2b_products WHERE sap_code = '14001851'")).id);
  assert.equal((await s.post('/api/erp/catalog/schemes', { audience: 'retailer', ruleType: 'free_qty', productId: pid, endsAt: '2027-01-01', reason: 'Buy 10 get 1' }, c.maker.h)).status, 400, 'buyQty/freeQty required');
  const fq = await s.post('/api/erp/catalog/schemes', { audience: 'retailer', ruleType: 'free_qty', buyQty: 10, freeQty: 1, productId: pid, endsAt: '2027-01-31', reason: 'Buy 10 get 1 free' }, c.maker.h);
  assert.equal(fq.status, 202, JSON.stringify(fq.data));
  await c.approve(fq.data.approvalId);
  const sim20 = await s.post('/api/erp/catalog/pricing/simulate', { productId: pid, audience: 'retailer', qty: 25 }, c.maker.h);
  assert.equal(sim20.data.freeQty, 2); assert.equal(sim20.data.unitPriceExGst, '74.53', 'a free-goods rule never changes the price');
  const sc = await s.post('/api/erp/catalog/schemes', { audience: 'retailer', ruleType: 'discount_pct', value: 5, productId: pid, endsAt: '2027-01-31', label: 'Winter 5%', reason: 'Winter promotion' }, c.maker.h);
  assert.equal(sc.status, 202);
  assert.equal(Number((await c.db.queryOne('SELECT is_active FROM b2b_pricing_rules WHERE id = ?', [sc.data.ruleId])).is_active), 0);
  await c.approve(sc.data.approvalId);
  assert.equal(Number((await c.db.queryOne('SELECT is_active FROM b2b_pricing_rules WHERE id = ?', [sc.data.ruleId])).is_active), 1);
  const r = await s.post('/api/erp/catalog/pricing/simulate', { productId: pid, audience: 'retailer', qty: 1 }, c.maker.h);
  assert.equal(r.data.unitPriceExGst, (Math.round(7453 * 0.95) / 100).toFixed(2));
});

test('audit chain still intact after the whole flow', async () => {
  const v = await s.get('/api/erp/core/audit/verify', c.maker.h);
  assert.equal(v.data.ok, true, JSON.stringify(v.data));
});
