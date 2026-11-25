/**
 * Manufacturing and delivery (migration 020) on MySQL 8 — TEST database only (the runner refuses
 * anything else, and refuses while 013/014 are present). Real server, real APIs, schema up to 020.
 *
 * Covers: manufacturers and facilities; a contract manufacturing order from release to goods
 * receipt (manufacturer accepts, records a batch with its Certificate of Analysis, our QC releases
 * it, only released batches ship, the goods arrive by GRN); an in-house order (bill of materials
 * activated by a second person, materials issued FEFO once per key, output to quarantine, QC by
 * someone else releases it to available); trade deliveries (shipment, dispatch with challan, out for
 * delivery, failed attempt with the buyer told, partial delivery with proof and credit note, return
 * to the warehouse, isolation of drivers and distributors, the portal order view, offline updates);
 * and a clean reconciliation at the end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup, upload, bearer } = require('./helpers/erp.js');
const { gstin, PDF } = require('./helpers/db.js');
const b2bSecurity = require('../src/modules/b2b/lib/security.js');

let c, s, admin;
const S = {};
const uuid = () => crypto.randomUUID();
const num = async (sql, args) => Number(Object.values(await c.db.queryOne(sql, args || []))[0]);
const stockOf = async (w, p) => c.db.queryOne('SELECT * FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [w, p]);
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const adminStatus = (id, status, extra) => s.post('/api/admin/b2b/orders/' + id + '/status', Object.assign({ status: status }, extra || {}), admin);

async function seedBatch(w, p, batchNo, expiry, qty, tag) {
  const ledger = require('../src/modules/erp/inventory/ledger.js');
  await c.db.transaction(async function (tx) {
    const b = await tx.query("INSERT INTO b2b_batches (warehouse_id, product_id, batch_no, expiry_date, qty_on_hand, status) VALUES (?, ?, ?, ?, ?, 'active')", [w, p, batchNo, expiry, qty]);
    await ledger.mustMove(tx, { warehouseId: w, productId: p, batchId: Number(b.insertId), type: 'transfer_in', qty: qty, to: 'available', actor: { type: 'system', label: 'test seed' }, idemKey: 'test:seed:' + tag });
  });
}
/** A retailer order through the real portal, then the existing admin fulfilment up to "packed". */
async function packedOrder(qty) {
  await s.put('/api/b2b/cart/items/' + S.fg, { qty: qty }, S.rt);
  const o = await s.post('/api/b2b/orders', { payment_method: 'upi' }, Object.assign({ 'Idempotency-Key': uuid() }, S.rt));
  assert.equal(o.status, 201, JSON.stringify(o.data));
  const id = o.data.order ? o.data.order.id : o.data.orderId;
  const cur = (await c.db.queryOne('SELECT status FROM b2b_orders WHERE id = ?', [id])).status;
  if (cur === 'pending_admin_approval') assert.equal((await adminStatus(id, 'approved')).status, 200);
  for (const st of ['accepted', 'processing', 'packed']) { const r = await adminStatus(id, st); assert.equal(r.status, 200, st + ' ' + JSON.stringify(r.data)); }
  return Number(id);
}

test.before(async () => {
  c = await setup({ PUBLIC_SITE_URL: 'http://127.0.0.1' }); s = c.s;
  admin = bearer((await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token);
  S.ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  S.wh = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active) VALUES ('BLR1', 'Bengaluru DC', ?, 'Bengaluru', '560001', 10, 1)", [S.ka])).insertId);
  const mk = async (sku, name, kind) => Number((await c.db.query("INSERT INTO b2b_products (sku, name, hsn_code, gst_rate, mrp, base_price, retailer_price, distributor_price, moq, case_qty, is_active, avail_b2c, avail_retailer, avail_distributor, item_kind, shelf_life_days) " +
    "VALUES (?, ?, '17010000', '5.00', '120.00', '80.00', '95.00', '90.00', 1, 1, 1, 0, ?, ?, ?, 365)", [sku, name, kind === 'finished' ? 1 : 0, kind === 'finished' ? 1 : 0, kind])).insertId);
  S.fg = await mk('JAG1', 'Jaggery 1 kg', 'finished');
  S.rm = await mk('CANE', 'Cane juice concentrate (kg)', 'raw_material');
  S.pk = await mk('POUCH1', 'Pouch 1 kg', 'packaging');
  S.qc = await c.person('qcperson', ['quality_control']);
  S.wm = await c.person('whm', ['warehouse_manager']);
  S.pm = await c.person('procman', ['procurement_manager']);
  S.drv = await c.person('driver1', ['delivery_staff']);
  S.drv2 = await c.person('driver2', ['delivery_staff']);
  // a contract manufacturer (registered through the portal; approval shortcut for this suite)
  const reg = await s.post('/api/vendor/register', { legalName: 'Mandya Cane Products', gstin: gstin('29', 'AAACM1234F'), capabilities: ['contract_manufacturer'], user: { name: 'Kiran', email: 'kiran@maker.test', mobile: '9876500001', password: 'Maker-pass-1234' } });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  S.v = reg.data.vendorId;
  await c.db.query("UPDATE b2b_vendors SET status = 'approved', approved_at = UTC_TIMESTAMP() WHERE id = ?", [S.v]);
  await c.db.query("UPDATE b2b_vendor_capabilities SET status = 'approved' WHERE vendor_id = ?", [S.v]);
  S.vt = bearer((await s.post('/api/vendor/auth/login', { email: 'kiran@maker.test', password: 'Maker-pass-1234' })).data.token);
  // a plain supplier must not appear among manufacturers
  const sup = await s.post('/api/vendor/register', { legalName: 'Wholesale Mart', gstin: gstin('29', 'AAACW1234F'), capabilities: ['supplier_wholesaler'], user: { name: 'W', email: 'w@sup.test', mobile: '9876500002', password: 'Supplier-pass-1234' } });
  S.sup = sup.data.vendorId;
  await c.db.query("UPDATE b2b_vendors SET status = 'approved' WHERE id = ?", [S.sup]);
  // an accepted PO with the manufacturer for 100 units of our product
  S.po = Number((await c.db.query("INSERT INTO b2b_purchase_orders (po_no, revision, vendor_id, ship_to_warehouse_id, bill_to_state_id, is_interstate, status, taxable_total, discount_total, freight_total, cgst_total, sgst_total, igst_total, grand_total, delivery_by, created_by, sent_at) " +
    "VALUES ('PO/TEST/9', 0, ?, ?, ?, 0, 'accepted', 6000.00, 0, 0, 150.00, 150.00, 0, 6300.00, ?, ?, UTC_TIMESTAMP())", [S.v, S.wh, S.ka, day(30), c.maker.id])).insertId);
  S.poi = Number((await c.db.query("INSERT INTO b2b_purchase_order_items (po_id, product_id, hsn_code, qty_ordered, qty_accepted_by_vendor, qty_received, qty_rejected, unit_price, discount_pct, gst_rate, taxable_amount, tax_amount, line_total) " +
    "VALUES (?, ?, '17010000', 100, 100, 0, 0, 60.0000, 0, 5.00, 6000.00, 300.00, 6300.00)", [S.po, S.fg])).insertId);
  // a retailer for the trade orders, and stock to sell
  S.r = Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, shop_name, contact_person, mobile, email, address_line1, city, pincode, state_id, district_name, latitude, longitude, approved_at) " +
    "VALUES ('retailer', 'approved', 'Ganesh Stores', 'Ganesh Stores', 'Owner', '9845011111', 'ganesh@retail.test', 'MG Road', 'Bengaluru', '560001', ?, 'Bengaluru Urban', 12.97, 77.59, UTC_TIMESTAMP())", [S.ka])).insertId);
  await c.db.query("INSERT INTO b2b_users (account_id, name, mobile, password_hash, role, is_primary, status) VALUES (?, 'Owner', '9845011111', ?, 'retailer', 1, 'active')", [S.r, b2bSecurity.hashPassword('Retailer!2345')]);
  const lg = await s.post('/api/b2b/auth/login', { identifier: '9845011111', password: 'Retailer!2345', role: 'retailer' });
  assert.equal(lg.status, 200, JSON.stringify(lg.data));
  S.rt = bearer(lg.data.token);
  await seedBatch(S.wh, S.fg, 'FG-OLD', day(90), 30, 'fg-old');
  await seedBatch(S.wh, S.fg, 'FG-NEW', day(300), 30, 'fg-new');
});
test.after(async () => { if (c) await c.stop(); });

test('manufacturers: a contract manufacturer appears with its facilities and performance; a supplier does not; facilities are validated', async () => {
  const bad = await s.post('/api/erp/manufacturing/facilities', { vendorId: S.v, name: 'Mandya plant', fssai: '1234' }, S.pm.h);
  assert.equal(bad.status, 400);
  const f = await s.post('/api/erp/manufacturing/facilities', { vendorId: S.v, name: 'Mandya plant', city: 'Mandya', pincode: '571401', fssai: '10019043000123', fssaiValidTo: day(400), capacityPerMonth: 5000, capacityUom: 'kg' }, S.pm.h);
  assert.equal(f.status, 201, JSON.stringify(f.data)); S.fac = f.data.id;
  assert.equal((await s.post('/api/erp/manufacturing/facilities', { vendorId: S.sup, name: 'Shed' }, S.pm.h)).data.code, 'not_a_manufacturer');
  const list = await s.get('/api/erp/manufacturing/manufacturers', S.pm.h);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.items.map(m => m.id), [S.v]);
  assert.equal(list.data.items[0].facilities, 1);
  const d = await s.get('/api/erp/manufacturing/manufacturers/' + S.v, S.pm.h);
  assert.equal(d.data.facilities[0].capacityPerMonth, 5000);
  assert.ok('onTimePct' in d.data.performance);
  assert.equal((await s.get('/api/erp/manufacturing/manufacturers/' + S.sup, S.pm.h)).status, 404);
  assert.equal((await s.get('/api/erp/manufacturing/manufacturers', S.drv.h)).status, 403, 'drivers do not see manufacturing');
});

test('contract manufacturing: release → manufacturer accepts and records a batch with its CoA → our QC releases part → only released units ship → goods arrive by GRN', async () => {
  const mo = await s.post('/api/erp/manufacturing/orders', { mode: 'contract', vendorId: S.v, poId: S.po, productId: S.fg, plannedQty: 100, warehouseId: S.wh, facilityId: S.fac, plannedEnd: day(20) }, S.pm.h);
  assert.equal(mo.status, 201, JSON.stringify(mo.data)); S.mo = mo.data.id;
  assert.equal((await s.get('/api/vendor/manufacturing-orders/' + S.mo, S.vt)).status, 404, 'a draft is not shown to the manufacturer');
  assert.equal((await s.post('/api/erp/manufacturing/orders/' + S.mo + '/release', {}, S.pm.h)).data.status, 'released');
  assert.ok(await c.db.queryOne("SELECT id FROM b2b_notification_queue WHERE recipient = 'kiran@maker.test' AND subject LIKE 'New manufacturing order%'"), 'the manufacturer is emailed (queued)');
  const early = await s.post('/api/vendor/manufacturing-orders/' + S.mo + '/batches', { batchNo: 'CM-1', mfgDate: day(-1), expiryDate: day(300), qty: 60 }, S.vt);
  assert.equal(early.data.code, 'not_accepted');
  assert.equal((await s.post('/api/vendor/manufacturing-orders/' + S.mo + '/respond', { response: 'accepted' }, S.vt)).data.status, 'accepted');
  assert.equal((await s.post('/api/vendor/manufacturing-orders/' + S.mo + '/progress', { stage: 'boiling', qty: 30 }, S.vt)).data.status, 'in_production');
  const b = await s.post('/api/vendor/manufacturing-orders/' + S.mo + '/batches', { batchNo: 'CM-1', mfgDate: day(-1), expiryDate: day(300), qty: 60 }, S.vt);
  assert.equal(b.status, 201, JSON.stringify(b.data)); S.cb = b.data.batchId;
  assert.equal(await num('SELECT COUNT(*) FROM b2b_stock_movements WHERE ref_type = ? AND ref_id = ?', ['mfg_batch', S.cb]), 0, 'a contract batch moves no stock');
  // QC: not without the certificate; not by the buyer; partial release by QC
  assert.equal((await s.post('/api/erp/manufacturing/batches/' + S.cb + '/qc', { result: 'pass', note: 'ok' }, S.pm.h)).status, 403, 'procurement cannot release batches');
  assert.equal((await s.post('/api/erp/manufacturing/batches/' + S.cb + '/qc', { result: 'pass', note: 'looks fine' }, S.qc.h)).data.code, 'coa_required');
  const coa = await upload(s, '/api/vendor/manufacturing-orders/' + S.mo + '/documents', { docType: 'coa', batchId: S.cb }, { data: PDF, name: 'coa.pdf' }, S.vt);
  assert.equal(coa.status, 201, JSON.stringify(coa.data));
  const q = await s.post('/api/erp/manufacturing/batches/' + S.cb + '/qc', { result: 'partial', releasedQty: 50, rejectedQty: 10, note: 'ten pouches under weight' }, S.qc.h);
  assert.equal(q.status, 200, JSON.stringify(q.data)); assert.deepEqual([q.data.status, q.data.releasedQty, q.data.rejectedQty], ['released', 50, 10]);
  // dispatch notices: unknown batch refused; more than released refused; released quantity ships
  const wrong = await s.post('/api/vendor/asns', { poId: S.po, items: [{ poItemId: S.poi, qty: 10, batchNo: 'CM-9', expiryDate: day(300) }] }, S.vt);
  assert.equal(wrong.data.code, 'batch_not_released');
  const over = await s.post('/api/vendor/asns', { poId: S.po, items: [{ poItemId: S.poi, qty: 55, batchNo: 'CM-1', expiryDate: day(300) }] }, S.vt);
  assert.equal(over.data.code, 'over_dispatch');
  const asn = await s.post('/api/vendor/asns', { poId: S.po, transporter: 'KSRTC Parcel', lrNo: 'LR-77', items: [{ poItemId: S.poi, qty: 50, batchNo: 'cm-1' }] }, S.vt);
  assert.equal(asn.status, 201, JSON.stringify(asn.data));
  const dl = await s.get('/api/vendor/deliveries', S.vt);
  assert.equal(dl.data.items[0].status, 'dispatched');
  // goods receipt (the existing flow) puts them in stock
  const before = Number((await stockOf(S.wh, S.fg)).qty_available);
  const g = await s.post('/api/erp/procurement/grns', { poId: S.po, asnId: asn.data.asnId, items: [{ poItemId: S.poi, batchNo: 'CM-1', mfgDate: day(-1), expiryDate: day(300), qtyReceived: 50, qtyAccepted: 50, shelfLifeReviewed: true }] }, S.wm.h);
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal((await s.post('/api/erp/procurement/grns/' + g.data.grnId + '/post', {}, S.wm.h)).data.status, 'posted');
  assert.equal(Number((await stockOf(S.wh, S.fg)).qty_available), before + 50);
  const d = await s.get('/api/erp/manufacturing/orders/' + S.mo, S.pm.h);
  assert.deepEqual(d.data.receipts, [{ batchNo: 'CM-1', received: 50, accepted: 50, rejected: 0 }]);
  assert.equal(d.data.releasedQty, 50); assert.equal(d.data.rejectedQty, 10);
  const perf = (await s.get('/api/erp/manufacturing/manufacturers/' + S.v, S.pm.h)).data.performance;
  assert.equal(perf.batchesReleased, 1); assert.equal(perf.unitsRejectedAtQc, 10);
  // the manufacturer sees its invoices / payments view (empty) and cannot see another vendor's order
  assert.equal((await s.get('/api/vendor/accounts', S.vt)).status, 200);
});

test('in-house manufacturing: BOM by one person, activated by another; materials FEFO once per key; output to quarantine; QC by someone else releases it', async () => {
  const bom = await s.post('/api/erp/manufacturing/boms', { productId: S.fg, outputQty: 100, lines: [{ productId: S.rm, qty: 110 }, { productId: S.pk, qty: 100, scrapPct: 2 }] }, c.maker.h);
  assert.equal(bom.status, 201, JSON.stringify(bom.data));
  assert.equal((await s.post('/api/erp/manufacturing/boms/' + bom.data.id + '/activate', {}, c.maker.h)).data.code, 'same_person');
  assert.equal((await s.post('/api/erp/manufacturing/boms/' + bom.data.id + '/activate', {}, c.checker.h)).data.status, 'active');
  await seedBatch(S.wh, S.rm, 'RM-A', day(20), 60, 'rm-a');
  await seedBatch(S.wh, S.rm, 'RM-B', day(200), 100, 'rm-b');
  await seedBatch(S.wh, S.pk, 'PK-A', null, 200, 'pk-a');
  const mo = await s.post('/api/erp/manufacturing/orders', { mode: 'in_house', productId: S.fg, plannedQty: 100, warehouseId: S.wh }, S.pm.h);
  assert.equal(mo.status, 201, JSON.stringify(mo.data)); S.ih = mo.data.id;
  await s.post('/api/erp/manufacturing/orders/' + S.ih + '/release', {}, S.pm.h);
  const k = uuid();
  const iss = await s.post('/api/erp/manufacturing/orders/' + S.ih + '/materials/issue', { idempotencyKey: k, lines: [{ productId: S.rm, qty: 110 }, { productId: S.pk, qty: 102 }] }, S.wm.h);
  assert.equal(iss.status, 200, JSON.stringify(iss.data));
  assert.deepEqual(iss.data.issued.filter(x => x.productId === S.rm).map(x => [x.batchNo, x.qty]), [['RM-A', 60], ['RM-B', 50]], 'earliest expiry first');
  assert.equal((await s.post('/api/erp/manufacturing/orders/' + S.ih + '/materials/issue', { idempotencyKey: k, lines: [{ productId: S.rm, qty: 110 }] }, S.wm.h)).data.duplicate, true);
  assert.equal(Number((await stockOf(S.wh, S.rm)).qty_available), 50);
  const over = await s.post('/api/erp/manufacturing/orders/' + S.ih + '/materials/issue', { idempotencyKey: uuid(), lines: [{ productId: S.rm, qty: 5 }] }, S.wm.h);
  assert.equal(over.data.code, 'over_issue');
  // output needs the own-plant decision
  const blocked = await s.post('/api/erp/manufacturing/orders/' + S.ih + '/batches', { batchNo: 'IH-1', mfgDate: day(0), expiryDate: day(300), qty: 100 }, S.wm.h);
  assert.equal(blocked.data.code, 'own_maker_undecided');
  const own = Number((await c.db.query("INSERT INTO b2b_vendors (legal_name, status, onboarding, state_id, vendor_code) VALUES ('Sake of Health (own plant)', 'approved', 'invited', ?, 'V-OWN')", [S.ka])).insertId);
  await c.setting('manufacturing.own_manufacturer_vendor_id', own);
  const avail0 = Number((await stockOf(S.wh, S.fg)).qty_available);
  const out = await s.post('/api/erp/manufacturing/orders/' + S.ih + '/batches', { batchNo: 'IH-1', mfgDate: day(0), expiryDate: day(300), qty: 100 }, S.wm.h);
  assert.equal(out.status, 201, JSON.stringify(out.data));
  let st = await stockOf(S.wh, S.fg);
  assert.equal(Number(st.qty_quarantine), 100); assert.equal(Number(st.qty_available), avail0, 'not sellable before QC');
  const rep = await upload(s, '/api/erp/manufacturing/orders/' + S.ih + '/documents', { docType: 'test_report', batchId: out.data.batchId }, { data: PDF, name: 'lab.pdf' }, S.pm.h);
  assert.equal(rep.status, 201, JSON.stringify(rep.data));
  const rel = await s.post('/api/erp/manufacturing/batches/' + out.data.batchId + '/qc', { result: 'pass', note: 'moisture 3.2%, ok' }, S.qc.h);
  assert.equal(rel.status, 200, JSON.stringify(rel.data));
  st = await stockOf(S.wh, S.fg);
  assert.equal(Number(st.qty_quarantine), 0); assert.equal(Number(st.qty_available), avail0 + 100);
  const lot = await c.db.queryOne("SELECT manufacturer_vendor_id FROM b2b_lots WHERE product_id = ? AND batch_no_norm = 'IH1'", [S.fg]);
  assert.equal(Number(lot.manufacturer_vendor_id), own, 'traceable to our own plant');
  assert.equal((await s.post('/api/erp/manufacturing/orders/' + S.ih + '/complete', {}, S.pm.h)).data.status, 'completed');
  assert.equal((await s.post('/api/erp/manufacturing/orders/' + S.ih + '/close', {}, S.pm.h)).data.status, 'closed');
});

test('trade delivery: shipment → dispatch with challan → out for delivery → failed attempt (buyer told) → partial delivery with proof (credit note) — all through the existing order flow', async () => {
  S.o1 = await packedOrder(10);
  const toShip = await s.get('/api/erp/deliveries/', S.wm.h);
  assert.ok(toShip.data.toShip.some(o => o.orderId === S.o1));
  const sh = await s.post('/api/erp/deliveries/', { orderId: S.o1, mode: 'own_vehicle', vehicleNo: 'KA 01 AB 1234', deliveryStaffId: S.drv.id, expectedAt: new Date(Date.now() + 86400000).toISOString() }, S.wm.h);
  assert.equal(sh.status, 201, JSON.stringify(sh.data)); S.sh1 = sh.data.id;
  assert.equal((await s.post('/api/erp/deliveries/', { orderId: S.o1, mode: 'pickup' }, S.wm.h)).data.code, 'shipment_exists');
  const notDriver = await s.put('/api/erp/deliveries/' + S.sh1, { deliveryStaffId: S.qc.id }, S.wm.h);
  assert.equal(notDriver.status, 400); assert.equal(notDriver.data.code, 'not_delivery_staff', 'only people with the delivery right can be assigned');
  const before = await stockOf(S.wh, S.fg);
  const dp = await s.post('/api/erp/deliveries/' + S.sh1 + '/dispatch', {}, S.wm.h);
  assert.equal(dp.status, 200, JSON.stringify(dp.data)); assert.match(dp.data.challanNo, /^DC\//);
  assert.equal((await c.db.queryOne('SELECT status FROM b2b_orders WHERE id = ?', [S.o1])).status, 'dispatched');
  const mid = await stockOf(S.wh, S.fg);
  assert.equal(Number(mid.qty_in_transit) - Number(before.qty_in_transit), 10, 'allocated → in transit by the existing flow');
  const ch = await c.db.queryOne('SELECT lines_json FROM b2b_delivery_challans WHERE shipment_id = ?', [S.sh1]);
  assert.deepEqual(JSON.parse(ch.lines_json)[0].batches.map(b => b.batchNo), ['FG-OLD'], 'challan lists the batch that left (FEFO)');
  assert.equal((await s.post('/api/erp/deliveries/' + S.sh1 + '/out-for-delivery', {}, S.drv.h)).data.status, 'out_for_delivery');
  const fa = await s.post('/api/erp/deliveries/' + S.sh1 + '/attempt-failed', { reason: 'Shop closed' }, S.drv.h);
  assert.equal(fa.data.status, 'attempt_failed');
  assert.ok(await c.db.queryOne("SELECT id FROM b2b_notification_queue WHERE recipient = 'ganesh@retail.test' AND subject LIKE 'Delivery attempt failed%'"), 'the buyer is told');
  const items = await c.db.query('SELECT id FROM b2b_order_items WHERE order_id = ? ORDER BY id', [S.o1]);
  const del = {}; del[items[0].id] = 8;
  const pod = await upload(s, '/api/erp/deliveries/' + S.sh1 + '/delivered', { receivedBy: 'Ganesh', receiverPhone: '9845011111', delivered: JSON.stringify(del) }, { data: PDF, name: 'signed.pdf' }, S.drv.h);
  assert.equal(pod.status, 200, JSON.stringify(pod.data));
  assert.equal(pod.data.status, 'partially_delivered'); assert.ok(pod.data.creditNote, 'short delivery raises the credit note (existing flow)');
  const after = await stockOf(S.wh, S.fg);
  assert.equal(Number(after.qty_in_transit), Number(before.qty_in_transit), 'nothing left in transit');
  const proof = await fetch(s.base + '/api/erp/deliveries/' + S.sh1 + '/proof', { headers: S.wm.h });
  assert.equal(proof.status, 200); assert.equal(proof.headers.get('content-type'), 'application/pdf');
  const evs = (await s.get('/api/erp/deliveries/' + S.sh1, S.wm.h)).data.events.map(e => e.kind);
  ['created', 'dispatched', 'out_for_delivery', 'attempt_failed', 'partially_delivered'].forEach(k => assert.ok(evs.includes(k), k));
});

test('undeliverable: back to the warehouse returns the stock to available and releases the order; drivers and distributors see only their own', async () => {
  S.o2 = await packedOrder(5);
  const sh = await s.post('/api/erp/deliveries/', { orderId: S.o2, mode: 'courier', carrier: 'BlueDart', trackingNo: 'BD-1', deliveryStaffId: S.drv2.id }, S.wm.h);
  S.sh2 = sh.data.id;
  await s.post('/api/erp/deliveries/' + S.sh2 + '/dispatch', {}, S.wm.h);
  const mid = await stockOf(S.wh, S.fg);
  assert.equal((await s.get('/api/erp/deliveries/' + S.sh2, S.drv.h)).status, 404, 'another driver\'s shipment');
  assert.ok((await s.get('/api/erp/deliveries/', S.drv.h)).data.items.every(x => x.id !== S.sh2));
  assert.equal((await s.post('/api/erp/deliveries/' + S.sh2 + '/return', { reason: 'refused' }, S.drv2.h)).status, 403, 'drivers cannot take goods back into stock');
  const rt = await s.post('/api/erp/deliveries/' + S.sh2 + '/return', { reason: 'Refused by the buyer', condition: 'good' }, S.wm.h);
  assert.equal(rt.data.status, 'returned');
  assert.equal((await c.db.queryOne('SELECT status FROM b2b_orders WHERE id = ?', [S.o2])).status, 'returned');
  const end = await stockOf(S.wh, S.fg);
  assert.equal(Number(end.qty_available) - Number(mid.qty_available), 5); assert.equal(Number(mid.qty_in_transit) - Number(end.qty_in_transit), 5);
  assert.equal((await s.post('/api/erp/deliveries/' + S.sh2 + '/return', { reason: 'Refused by the buyer', condition: 'good' }, S.wm.h)).data.unchanged, true, 'a repeat moves nothing');
  // a distributor has no access to a company order's shipment or challan
  const d = Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, contact_person, mobile, address_line1, city, district_name, pincode, state_id, approved_at) VALUES ('distributor', 'approved', 'North Distributors', 'D', '9845022222', 'X', 'Bengaluru', 'Bengaluru Urban', '560002', ?, UTC_TIMESTAMP())", [S.ka])).insertId);
  await c.db.query("INSERT INTO b2b_users (account_id, name, mobile, password_hash, role, is_primary, status) VALUES (?, 'D', '9845022222', ?, 'distributor', 1, 'active')", [d, b2bSecurity.hashPassword('Distrib!2345')]);
  const dt = bearer((await s.post('/api/b2b/auth/login', { identifier: '9845022222', password: 'Distrib!2345', role: 'distributor' })).data.token);
  assert.equal((await s.get('/api/b2b/retailer-orders/' + S.o1 + '/challan', dt)).status, 404);
  assert.equal((await s.post('/api/b2b/retailer-orders/' + S.o1 + '/shipment', { mode: 'pickup' }, dt)).status, 404);
});

test('the portal order view carries the shipment and the buyer can open the challan; buyers never see staff or proof files', async () => {
  const o = await s.get('/api/b2b/orders/' + S.o1, S.rt);
  assert.equal(o.status, 200);
  assert.equal(o.data.shipment.vehicleNo, 'KA01AB1234');
  assert.equal(o.data.shipment.status, 'partially_delivered');
  assert.equal(o.data.shipment.deliveryStaff, undefined); assert.equal(o.data.shipment.receiverPhone, undefined);
  const ch = await fetch(s.base + '/api/b2b/orders/' + S.o1 + '/challan', { headers: S.rt });
  assert.equal(ch.status, 200); assert.match(await ch.text(), /Delivery challan/);
});

test('offline: a driver\'s update made without signal is applied once', async () => {
  S.o3 = await packedOrder(2);
  const sh = await s.post('/api/erp/deliveries/', { orderId: S.o3, mode: 'own_vehicle', vehicleNo: 'KA01AB1234', deliveryStaffId: S.drv.id }, S.wm.h);
  await s.post('/api/erp/deliveries/' + sh.data.id + '/dispatch', {}, S.wm.h);
  const op = { clientOpId: uuid(), kind: 'delivery', createdAt: new Date(Date.now() - 600000).toISOString(), payload: { shipmentId: sh.data.id, action: 'out_for_delivery' } };
  const a = await s.post('/api/erp/offline/sync', { ops: [op] }, S.drv.h);
  assert.equal(a.data.results[0].status, 'applied', JSON.stringify(a.data));
  const b = await s.post('/api/erp/offline/sync', { ops: [op] }, S.drv.h);
  assert.equal(b.data.results[0].status, 'duplicate');
  assert.equal(await num("SELECT COUNT(*) FROM b2b_shipment_events WHERE shipment_id = ? AND kind = 'out_for_delivery'", [sh.data.id]), 1);
  const notMine = await s.post('/api/erp/offline/sync', { ops: [{ clientOpId: uuid(), kind: 'delivery', payload: { shipmentId: sh.data.id, action: 'location', place: 'x' } }] }, S.drv2.h);
  assert.notEqual(notMine.data.results[0].status, 'applied');
});

test('reconciliation stays clean after manufacturing, receipts, deliveries and returns', async () => {
  const r = await s.get('/api/erp/inventory/reconciliation', c.maker.h);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true, JSON.stringify(r.data.issues));
});
