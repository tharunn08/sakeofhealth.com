/**
 * Phases 4–5 — vendor portal, onboarding, procure-to-pay (integration, TEST database).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, upload, bearer } = require('./helpers/erp.js');
const { gstin, PDF } = require('./helpers/db.js');

let c, s;
const S = {};
const V = (t) => bearer(t);

async function vendorLogin(email, pw) { const r = await s.post('/api/vendor/auth/login', { email: email, password: pw }); assert.equal(r.status, 200, JSON.stringify(r.data)); return V(r.data.token); }

test.before(async () => {
  c = await setup(); s = c.s;
  const ka = await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'");
  const mh = await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '27'");
  S.ka = Number(ka.id); S.mh = Number(mh.id);
  S.wh = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active) VALUES ('BLR1', 'Bengaluru DC', ?, 'Bengaluru', '560001', 10, 1)", [S.ka])).insertId);
  S.wh2 = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active) VALUES ('MYS1', 'Mysuru DC', ?, 'Mysuru', '570001', 5, 1)", [S.ka])).insertId);
  const mk = async (sku, name, gst, hsn) => Number((await c.db.query('INSERT INTO b2b_products (sku, name, hsn_code, gst_rate, mrp, base_price, is_active, avail_b2c, avail_retailer, avail_distributor) VALUES (?, ?, ?, ?, 90, 60, 1, 0, 1, 1)', [sku, name, hsn, gst])).insertId);
  S.p1 = await mk('BS500', 'Organic Brown Sugar 500 g', '5.00', '17010000');
  S.p2 = await mk('SOAP4', 'Herbal Soap pack of 4', '18.00', '34011190');
  S.pm = await c.person('procman', ['procurement_manager']);
  S.pe = await c.person('procexec', ['procurement_executive']);
  S.wm = await c.person('whman', [{ code: 'warehouse_manager', scopeType: 'warehouse', scopeId: S.wh }]);
  S.wm2 = await c.person('whman2', [{ code: 'warehouse_manager', scopeType: 'warehouse', scopeId: S.wh2 }]);
  S.fm = await c.person('finman', ['finance_manager']);
  S.acc = await c.person('accts', ['accountant']);
});
test.after(async () => { if (c) await c.stop(); });

test('vendor self-registration, login, tenant isolation, token audiences', async () => {
  const g1 = gstin('29', 'AAACS1234F'), g2 = gstin('27', 'AAACT5678K');
  const bad = await s.post('/api/vendor/register', { legalName: 'X', gstin: '29AAACS1234F1Z0', capabilities: ['manufacturer'], user: { name: 'A', email: 'a@v1.test', mobile: '9876543210', password: 'Vendor-pass-1234' } });
  assert.equal(bad.status, 400, 'GSTIN check digit is verified');
  const r1 = await s.post('/api/vendor/register', { legalName: 'Sri Organics Pvt Ltd', gstin: g1, capabilities: ['manufacturer'], user: { name: 'Asha', email: 'asha@v1.test', mobile: '9876543210', password: 'Vendor-pass-1234' } });
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  const dup = await s.post('/api/vendor/register', { legalName: 'Copy', gstin: g1, capabilities: ['manufacturer'], user: { name: 'B', email: 'b@v1.test', mobile: '9876543211', password: 'Vendor-pass-1234' } });
  assert.equal(dup.status, 409); assert.equal(dup.data.code, 'registration_refused');
  const r2 = await s.post('/api/vendor/register', { legalName: 'Mumbai Traders', gstin: g2, capabilities: ['supplier_wholesaler'], user: { name: 'Ravi', email: 'ravi@v2.test', mobile: '9876543212', password: 'Vendor-pass-5678' } });
  assert.equal(r2.status, 201);
  S.v1 = r1.data.vendorId; S.v2 = r2.data.vendorId;
  S.vt1 = await vendorLogin('asha@v1.test', 'Vendor-pass-1234');
  S.vt2 = await vendorLogin('ravi@v2.test', 'Vendor-pass-5678');
  const me = await s.get('/api/vendor/me', S.vt1);
  assert.equal(me.data.vendor.id, S.v1); assert.equal(me.data.vendor.status, 'submitted');
  assert.equal((await s.get('/api/vendor/rfqs', S.vt1)).status, 403, 'not approved yet → no trading');
  assert.equal((await s.get('/api/vendor/me', c.maker.h)).status, 401, 'a staff token is not a vendor token');
  assert.equal((await s.get('/api/erp/vendors', S.vt1)).status, 401, 'a vendor token is not a staff token');
  const doc = await upload(s, '/api/vendor/documents', { docType: 'gst_certificate' }, { data: PDF, name: 'gst.pdf' }, S.vt1);
  assert.equal(doc.status, 201, JSON.stringify(doc.data)); S.doc1 = doc.data.documentId;
  const fake = await upload(s, '/api/vendor/documents', { docType: 'pan' }, { data: Buffer.from('MZ\x90\x00 not a pdf at all'), name: 'pan.pdf' }, S.vt1);
  assert.equal(fake.status, 400, 'content is checked, not the extension');
  // vendor 2 cannot see vendor 1's document through the staff API, nor anything of vendor 1 in its own portal
  assert.equal((await s.get('/api/erp/vendors/' + S.v1 + '/documents/' + S.doc1 + '/file', S.vt2)).status, 401);
  const prod = await s.post('/api/vendor/products', { name: 'Organic Brown Sugar 500g', vendorSku: 'SO-BS-500', hsnCode: '17010000', gstRate: 5, mrp: 90 }, S.vt1);
  assert.equal(prod.status, 201); S.vp1 = prod.data.vendorProductId;
  const steal = await s.post('/api/vendor/price-lists', { vendorProductId: S.vp1, unitPrice: 60, gstRate: 5, validFrom: '2026-11-01' }, S.vt2);
  assert.equal(steal.status, 404, 'another vendor\'s product is invisible');
});

test('onboarding: stages, document review, approval by a second person, vendor code', async () => {
  for (const stage of ['verification', 'procurement', 'finance_compliance']) {
    const r = await s.post('/api/erp/vendors/' + S.v1 + '/verifications', { stage: stage, outcome: 'passed' }, S.pm.h);
    assert.equal(r.status, 200, stage + ' ' + JSON.stringify(r.data));
  }
  const early = await s.post('/api/erp/vendors/' + S.v1 + '/verifications', { stage: 'admin', outcome: 'passed' }, S.pm.h);
  assert.equal(early.status, 409); assert.equal(early.data.code, 'stages_incomplete');
  await s.post('/api/erp/vendors/' + S.v1 + '/verifications', { stage: 'document_review', outcome: 'passed' }, S.pm.h);
  const pending = await s.post('/api/erp/vendors/' + S.v1 + '/verifications', { stage: 'admin', outcome: 'passed' }, S.pm.h);
  assert.equal(pending.data.code, 'documents_pending');
  assert.equal((await s.post('/api/erp/vendors/' + S.v1 + '/documents/' + S.doc1 + '/review', { status: 'accepted' }, S.pm.h)).status, 200);
  const fin = await s.post('/api/erp/vendors/' + S.v1 + '/verifications', { stage: 'admin', outcome: 'passed', note: 'All checks done' }, S.pm.h);
  assert.equal(fin.status, 200, JSON.stringify(fin.data));
  assert.equal(fin.data.approval.ruleConfigured, false);
  assert.equal((await s.post('/api/erp/core/approvals/' + fin.data.approval.approvalId + '/decide', { decision: 'approved' }, S.pm.h)).status, 403, 'procurement manager is not the fail-safe approver');
  await c.approve(fin.data.approval.approvalId);
  const d = await s.get('/api/erp/vendors/' + S.v1, S.pm.h);
  assert.equal(d.data.vendor.status, 'approved'); assert.match(d.data.vendor.vendor_code, /^V\d{5}$/);
  // vendor 2 goes straight through for the RFQ test
  for (const stage of ['verification', 'document_review', 'procurement', 'finance_compliance']) await s.post('/api/erp/vendors/' + S.v2 + '/verifications', { stage: stage, outcome: 'passed' }, S.pm.h);
  await c.approve((await s.post('/api/erp/vendors/' + S.v2 + '/verifications', { stage: 'admin', outcome: 'passed' }, S.pm.h)).data.approval.approvalId);
  // bank account: added by one person, verified by another
  const ba = await s.post('/api/erp/vendors/' + S.v1 + '/bank-accounts', { accountName: 'Sri Organics Pvt Ltd', accountNo: '123456789012', ifsc: 'HDFC0001234' }, S.pm.h);
  assert.equal(ba.status, 201); S.bank = ba.data.bankAccountId;
  assert.equal((await s.post('/api/erp/vendors/' + S.v1 + '/bank-accounts/' + S.bank + '/verify', { status: 'verified' }, S.pm.h)).status, 403);
  assert.equal((await s.post('/api/erp/vendors/' + S.v1 + '/bank-accounts/' + S.bank + '/verify', { status: 'verified' }, c.maker.h)).status, 200);
  const enc = await c.db.queryOne('SELECT account_no_enc, account_last4 FROM b2b_vendor_bank_accounts WHERE id = ?', [S.bank]);
  assert.doesNotMatch(enc.account_no_enc, /123456789012/); assert.equal(enc.account_last4, '9012');
  assert.equal((await s.post('/api/erp/vendor-products/' + S.vp1 + '/decide', { decision: 'approved', productId: S.p1 }, S.pe.h)).status, 403, 'executive cannot approve products');
  assert.equal((await s.post('/api/erp/vendor-products/' + S.vp1 + '/decide', { decision: 'approved', productId: S.p1 }, S.pm.h)).status, 200);
});

test('requisition → RFQ → quotes → comparison → award (reason when not lowest) → PO', async () => {
  const pr = await s.post('/api/erp/procurement/requisitions', { warehouseId: S.wh, items: [{ productId: S.p1, qty: 400 }, { productId: S.p2, qty: 100 }], note: 'Diwali stock' }, S.pe.h);
  assert.equal(pr.status, 201, JSON.stringify(pr.data)); assert.match(pr.data.prNo, /^PR\/\d{4}\/00001$/);
  const sub = await s.post('/api/erp/procurement/requisitions/' + pr.data.prId + '/submit', { reason: 'Festival demand' }, S.pe.h);
  await c.approve(sub.data.approvalId);
  const later = new Date(Date.now() + 3 * 86400000).toISOString();
  const rfq = await s.post('/api/erp/procurement/rfqs', { title: 'Brown sugar and soap', warehouseId: S.wh, respondBy: later, prId: pr.data.prId, vendorIds: [S.v1, S.v2],
    items: [{ productId: S.p1, qty: 400 }, { productId: S.p2, qty: 100 }] }, S.pe.h);
  assert.equal(rfq.status, 201, JSON.stringify(rfq.data)); S.rfq = rfq.data.rfqId;
  const v1r = await s.get('/api/vendor/rfqs/' + S.rfq, S.vt1);
  assert.equal(v1r.status, 200); assert.equal(v1r.data.items.length, 2);
  const [i1, i2] = v1r.data.items.map((i) => i.id);
  const until = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const q1 = await s.post('/api/vendor/rfqs/' + S.rfq + '/responses', { validUntil: until, freightTotal: 500, paymentTermsDays: 30,
    items: [{ rfqItemId: i1, availableQty: 400, unitPrice: '63.4892', gstRate: 5 }, { rfqItemId: i2, availableQty: 100, unitPrice: '150', gstRate: 18 }] }, S.vt1);
  assert.equal(q1.status, 201, JSON.stringify(q1.data));
  const q2 = await s.post('/api/vendor/rfqs/' + S.rfq + '/responses', { validUntil: until, freightTotal: 0,
    items: [{ rfqItemId: i1, availableQty: 400, unitPrice: '62', gstRate: 5 }, { rfqItemId: i2, availableQty: 100, unitPrice: '148', gstRate: 18 }] }, S.vt2);
  assert.equal(q2.status, 201);
  const cmp = await s.get('/api/erp/procurement/rfqs/' + S.rfq + '/comparison', S.pm.h);
  assert.equal(cmp.data.vendorTotals[0].vendorId, S.v2, 'vendor 2 is lowest landed');
  const noReason = await s.post('/api/erp/procurement/rfqs/' + S.rfq + '/award', { responseId: q1.data.responseId }, S.pm.h);
  assert.equal(noReason.status, 400); assert.equal(noReason.data.code, 'reason_required');
  const aw = await s.post('/api/erp/procurement/rfqs/' + S.rfq + '/award', { responseId: q1.data.responseId, reason: 'Manufacturer direct, batch traceability and fresher stock' }, S.pm.h);
  assert.equal(aw.status, 201, JSON.stringify(aw.data)); assert.equal(aw.data.lowest, false);
  S.po = aw.data.poId;
  // intra-state (KA→KA): CGST+SGST; 400 × 63.4892 = 25395.68 taxable + 5 % → 26665.46; 100 × 150 + 18 % = 17700; freight 500
  const po = await s.get('/api/erp/procurement/purchase-orders/' + S.po, S.pm.h);
  assert.equal(po.data.taxable_total, '40395.68'); assert.equal(Number(po.data.igst_total), 0);
  assert.equal(po.data.grand_total, (25395.68 + 1269.78 + 15000 + 2700 + 500).toFixed(2));
  assert.equal((await s.post('/api/vendor/rfqs/' + S.rfq + '/responses', { validUntil: until, items: [{ rfqItemId: i1, availableQty: 1, unitPrice: 1, gstRate: 5 }] }, S.vt2)).status, 409, 'closed after award');
});

test('PO approval, send, vendor sees only its own POs, acknowledges, dispatches with batches', async () => {
  const sub = await s.post('/api/erp/procurement/purchase-orders/' + S.po + '/submit', {}, S.pm.h);
  assert.equal(sub.status, 202);
  assert.equal((await s.post('/api/erp/procurement/purchase-orders/' + S.po + '/send', {}, S.pm.h)).status, 409, 'not approved yet');
  await c.approve(sub.data.approvalId);
  assert.equal((await s.get('/api/vendor/purchase-orders/' + S.po, S.vt1)).status, 404, 'not visible before it is sent');
  assert.equal((await s.post('/api/erp/procurement/purchase-orders/' + S.po + '/send', {}, S.pm.h)).status, 200);
  assert.equal((await s.get('/api/vendor/purchase-orders/' + S.po, S.vt2)).status, 404, 'another vendor cannot see it');
  const vpo = await s.get('/api/vendor/purchase-orders/' + S.po, S.vt1);
  assert.equal(vpo.status, 200);
  S.poi = {}; vpo.data.items.forEach((i) => { S.poi[i.product_id] = i.id; });
  assert.equal((await s.post('/api/vendor/asns', { poId: S.po, items: [{ poItemId: S.poi[S.p1], qty: 1, batchNo: 'X', expiryDate: '2027-12-31' }] }, S.vt1)).status, 400, 'dispatch before acceptance refused');
  assert.equal((await s.post('/api/vendor/purchase-orders/' + S.po + '/acknowledge', { response: 'accepted' }, S.vt1)).status, 200);
  const over = await s.post('/api/vendor/asns', { poId: S.po, items: [{ poItemId: S.poi[S.p1], qty: 401, batchNo: 'B-12/26', mfgDate: '2026-10-01', expiryDate: '2027-09-30' }] }, S.vt1);
  assert.equal(over.data.code, 'over_dispatch');
  const asn = await s.post('/api/vendor/asns', { poId: S.po, vendorInvoiceNo: 'SO/26-27/0042', items: [
    { poItemId: S.poi[S.p1], qty: 400, batchNo: 'B-12/26', mfgDate: '2026-10-01', expiryDate: '2027-09-30', mrp: 90 },
    { poItemId: S.poi[S.p2], qty: 100, batchNo: 'SP-77', mfgDate: '2026-09-01', expiryDate: '2028-08-31', mrp: 225 }] }, S.vt1);
  assert.equal(asn.status, 201, JSON.stringify(asn.data)); S.asn = asn.data.asnId;
});

test('GRN: warehouse scope, shelf-life review (pending decision), over-receipt refused, variance needs approval, posting moves stock into lots', async () => {
  const lines = (over) => [
    Object.assign({ poItemId: S.poi[S.p1], batchNo: 'b 12 26', mfgDate: '2026-10-01', expiryDate: '2027-09-30', mrp: 90, qtyReceived: 400, qtyAccepted: 390, qtyQuarantined: 10, shelfLifeReviewed: true,
      qc: { result: 'partial', note: '10 bags damp' } }, over || {}),
    { poItemId: S.poi[S.p2], batchNo: 'SP-77', mfgDate: '2026-09-01', expiryDate: '2028-08-31', mrp: 225, qtyReceived: 98, qtyAccepted: 98, shelfLifeReviewed: true }];
  assert.equal((await s.post('/api/erp/procurement/grns', { poId: S.po, asnId: S.asn, items: lines() }, S.wm2.h)).data.code, 'out_of_scope');
  const noReview = await s.post('/api/erp/procurement/grns', { poId: S.po, asnId: S.asn, items: [Object.assign(lines()[0], { shelfLifeReviewed: false })] }, S.wm.h);
  assert.equal(noReview.data.code, 'shelf_life_review_required');
  const over = await s.post('/api/erp/procurement/grns', { poId: S.po, asnId: S.asn, items: [Object.assign(lines()[0], { qtyReceived: 410, qtyAccepted: 410, qtyQuarantined: 0 })] }, S.wm.h);
  assert.equal(over.data.code, 'over_receipt');
  const g = await s.post('/api/erp/procurement/grns', { poId: S.po, asnId: S.asn, vendorInvoiceNo: 'SO/26-27/0042', items: lines() }, S.wm.h);
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal(g.data.needsApproval, true, 'soap: 98 received vs 100 dispatched');
  const post = await s.post('/api/erp/procurement/grns/' + g.data.grnId + '/post', { reason: '2 soap packs short in the truck' }, S.wm.h);
  assert.equal(post.data.status, 'pending_approval');
  assert.equal(Number((await c.db.queryOne('SELECT COUNT(*) n FROM b2b_stock WHERE warehouse_id = ?', [S.wh])).n), 0, 'no stock before approval');
  await c.approve(post.data.approvalId);
  const st = await c.db.queryOne('SELECT qty_available, qty_quarantine FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.wh, S.p1]);
  assert.deepEqual([Number(st.qty_available), Number(st.qty_quarantine)], [390, 10]);
  const lot = await c.db.queryOne('SELECT * FROM b2b_lots WHERE product_id = ?', [S.p1]);
  assert.equal(lot.batch_no_norm, 'B1226'); assert.equal(Number(lot.manufacturer_vendor_id), S.v1);
  const b = await c.db.queryOne('SELECT qty_on_hand, qty_quarantine, lot_id FROM b2b_batches WHERE warehouse_id = ? AND product_id = ?', [S.wh, S.p1]);
  assert.deepEqual([Number(b.qty_on_hand), Number(b.qty_quarantine), Number(b.lot_id)], [390, 10, Number(lot.id)]);
  const mv = await c.db.query("SELECT movement_type, qty, lot_id FROM b2b_stock_movements WHERE ref_type = 'grn' ORDER BY id");
  assert.deepEqual(mv.map((m) => m.movement_type + ':' + m.qty), ['grn:390', 'quarantine_in:10', 'grn:98']);
  assert.ok(mv.every((m) => m.lot_id));
  const po = await s.get('/api/erp/procurement/purchase-orders/' + S.po, S.pm.h);
  assert.equal(po.data.status, 'partially_received');
  assert.equal(Number((await c.db.queryOne("SELECT COUNT(*) n FROM b2b_quality_inspections WHERE ref_type = 'grn_item'")).n), 1);
});

test('supplier invoice: GSTIN check, total check, three-way match, dispute → resolution', async () => {
  const items = [{ poItemId: S.poi[S.p1], description: 'Organic Brown Sugar 500g', qty: 400, rate: '63.4892', gstRate: 5, hsnCode: '17010000', batchNo: 'B-12/26' },
    { poItemId: S.poi[S.p2], description: 'Herbal soap x4', qty: 98, rate: '150', gstRate: 18 }];
  const wrongTotal = await s.post('/api/erp/procurement/supplier-invoices', { vendorId: S.v1, poId: S.po, invoiceNo: 'SO/26-27/0042', invoiceDate: '2026-11-05', items: items, grandTotal: '1.00' }, S.acc.h);
  assert.equal(wrongTotal.data.code, 'total_mismatch');
  const other = gstin('29', 'AAACZ9999Q');
  assert.equal((await s.post('/api/erp/procurement/supplier-invoices', { vendorId: S.v1, poId: S.po, invoiceNo: 'X1', invoiceDate: '2026-11-05', supplierGstin: other, items: items }, S.acc.h)).data.code, 'gstin_mismatch');
  const inv = await s.post('/api/erp/procurement/supplier-invoices', { vendorId: S.v1, poId: S.po, invoiceNo: 'SO/26-27/0042', invoiceDate: '2026-11-05', items: items }, S.acc.h);
  assert.equal(inv.status, 201, JSON.stringify(inv.data)); S.inv = inv.data.supplierInvoiceId;
  assert.equal(inv.data.isInterstate, false);
  assert.equal((await s.post('/api/erp/procurement/supplier-invoices', { vendorId: S.v1, invoiceNo: 'SO/26-27/0042', invoiceDate: '2026-11-05', items: items }, S.acc.h)).data.code, 'duplicate_invoice');
  const m = await s.post('/api/erp/procurement/supplier-invoices/' + S.inv + '/match', {}, S.acc.h);
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(m.data.status, 'disputed', 'billed 400 bags, only 390 accepted (10 quarantined) → zero tolerance');
  assert.equal(m.data.lines[0].result, 'qty_mismatch'); assert.equal(m.data.lines[1].result, 'matched');
  const pay = await s.post('/api/erp/procurement/supplier-payments', { vendorId: S.v1, bankAccountId: S.bank, method: 'neft', allocations: [{ supplierInvoiceId: S.inv, amount: '100' }] }, S.acc.h);
  assert.equal(pay.data.code, 'not_matched', 'disputed invoices cannot be paid');
  const mr = await c.db.queryOne("SELECT id FROM b2b_match_results WHERE supplier_invoice_id = ? AND resolution = 'open'", [S.inv]);
  assert.equal((await s.post('/api/erp/procurement/supplier-invoices/' + S.inv + '/match-results/' + mr.id + '/resolve', { resolution: 'debit_note', reason: '10 damp bags' }, S.acc.h)).status, 403);
  const res = await s.post('/api/erp/procurement/supplier-invoices/' + S.inv + '/match-results/' + mr.id + '/resolve', { resolution: 'debit_note', reason: '10 damp bags go back to the vendor' }, S.fm.h);
  assert.equal(res.status, 200); assert.equal(res.data.invoiceMatched, true);
});

test('supplier payment: verified bank only, approval, maker cannot confirm paid, no over-payment', async () => {
  const inv = await c.db.queryOne('SELECT grand_total FROM b2b_supplier_invoices WHERE id = ?', [S.inv]);
  const tooMuch = await s.post('/api/erp/procurement/supplier-payments', { vendorId: S.v1, bankAccountId: S.bank, method: 'neft', allocations: [{ supplierInvoiceId: S.inv, amount: (Number(inv.grand_total) + 1).toFixed(2) }] }, S.acc.h);
  assert.equal(tooMuch.data.code, 'over_payment');
  const p = await s.post('/api/erp/procurement/supplier-payments', { vendorId: S.v1, bankAccountId: S.bank, method: 'neft', allocations: [{ supplierInvoiceId: S.inv, amount: inv.grand_total }], reason: 'Bill SO/0042' }, S.acc.h);
  assert.equal(p.status, 202, JSON.stringify(p.data));
  assert.equal((await s.post('/api/erp/procurement/supplier-payments/' + p.data.supplierPaymentId + '/mark-paid', { reference: 'UTR123456' }, S.fm.h)).status, 409, 'not approved');
  await c.approve(p.data.approvalId);
  const paid = await s.post('/api/erp/procurement/supplier-payments/' + p.data.supplierPaymentId + '/mark-paid', { reference: 'HDFCN52026110512345' }, S.fm.h);
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal((await c.db.queryOne('SELECT status FROM b2b_supplier_invoices WHERE id = ?', [S.inv])).status, 'paid');
  const second = await s.post('/api/erp/procurement/supplier-payments', { vendorId: S.v1, bankAccountId: S.bank, method: 'neft', allocations: [{ supplierInvoiceId: S.inv, amount: '1' }] }, S.acc.h);
  assert.equal(second.status, 400, 'nothing left to pay');
});

test('purchase return of the 10 quarantined bags: approval issues a debit note, dispatch moves stock, vendor acknowledges, settled', async () => {
  const lot = await c.db.queryOne('SELECT id FROM b2b_lots WHERE product_id = ?', [S.p1]);
  const over = await s.post('/api/erp/procurement/purchase-returns', { vendorId: S.v1, warehouseId: S.wh, source: 'damage', items: [{ lotId: lot.id, qty: 11, reason: 'damp bags' }] }, S.pm.h);
  assert.equal(over.data.code, 'not_in_quarantine');
  const d = await s.post('/api/erp/inventory/dispositions', { warehouseId: S.wh, lotId: lot.id, qty: 10, decision: 'return_to_vendor', reason: 'damp bags' }, S.wm.h);
  assert.equal(d.data.code, 'use_purchase_return');
  const pr = await s.post('/api/erp/procurement/purchase-returns', { vendorId: S.v1, warehouseId: S.wh, source: 'damage', items: [{ lotId: lot.id, qty: 10, reason: 'Damp bags found at receipt' }] }, S.pm.h);
  assert.equal(pr.status, 201, JSON.stringify(pr.data));
  assert.equal(pr.data.grandTotal, '666.63', '10 × 63.4892 = 634.89 + 5 % GST 31.74');
  assert.equal((await s.get('/api/vendor/purchase-returns', S.vt1)).data.items.length, 0, 'vendor does not see drafts');
  const sub = await s.post('/api/erp/procurement/purchase-returns/' + pr.data.purchaseReturnId + '/submit', { reason: 'Return damp stock' }, S.pm.h);
  const ap = await c.approve(sub.data.approvalId);
  assert.match(ap.result.debitNoteNo, /^DN\/\d{4}\/00001$/);
  assert.equal((await s.post('/api/vendor/purchase-returns/' + pr.data.purchaseReturnId + '/acknowledge', {}, S.vt1)).status, 409, 'not dispatched yet');
  assert.equal((await s.post('/api/erp/procurement/purchase-returns/' + pr.data.purchaseReturnId + '/dispatch', {}, S.wm2.h)).data.code, 'out_of_scope');
  assert.equal((await s.post('/api/erp/procurement/purchase-returns/' + pr.data.purchaseReturnId + '/dispatch', { transporter: 'VRL' }, S.wm.h)).status, 200);
  const st = await c.db.queryOne('SELECT qty_quarantine FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.wh, S.p1]);
  assert.equal(Number(st.qty_quarantine), 0);
  const age = await s.get('/api/erp/finance/ageing?side=payables', S.fm.h);
  assert.equal(age.data.parties.find((p) => p.partyId === S.v1).debitNotesPending, pr.data.grandTotal);
  assert.equal((await s.get('/api/vendor/purchase-returns/' + pr.data.purchaseReturnId, S.vt2)).status, 404, 'other vendor cannot see it');
  assert.equal((await s.post('/api/vendor/purchase-returns/' + pr.data.purchaseReturnId + '/acknowledge', { note: 'Received 10 bags' }, S.vt1)).status, 200);
  const settled = await s.post('/api/erp/procurement/purchase-returns/' + pr.data.purchaseReturnId + '/settle', { refundReference: 'NEFT-REF-778899' }, S.fm.h);
  assert.equal(settled.status, 200, JSON.stringify(settled.data));
  assert.equal((await s.get('/api/erp/inventory/reconciliation', c.maker.h)).data.ok, true);
});

test('approval thresholds: an approved value-band decision becomes the engine\'s rules (2 steps above ₹1 lakh)', async () => {
  await c.setting('approvals.po.value_bands', [{ min_amount: 0, steps: 1, permission: 'procurement.rfq.award' }, { min_amount: 100000, steps: 2, permission: 'core.approvals.decide' }]);
  const rules = await c.db.query("SELECT min_amount, steps_required, approver_permission FROM b2b_approval_rules WHERE approval_type = 'procurement.po' AND is_active = 1 ORDER BY min_amount");
  assert.deepEqual(rules.map((r) => Number(r.min_amount) + ':' + r.steps_required + ':' + r.approver_permission), ['0:1:procurement.rfq.award', '100000:2:core.approvals.decide']);
  const po = await s.post('/api/erp/procurement/purchase-orders', { vendorId: S.v1, warehouseId: S.wh, items: [{ productId: S.p1, qty: 2000, unitPrice: '63.4892', gstRate: 5 }] }, S.pm.h);
  assert.equal(po.status, 201, JSON.stringify(po.data));
  const sub = await s.post('/api/erp/procurement/purchase-orders/' + po.data.poId + '/submit', {}, S.pm.h);
  assert.equal(sub.data.stepsRequired, 2); assert.equal(sub.data.ruleConfigured, true);
  const one = await c.approve(sub.data.approvalId, S.fm);
  assert.equal(one.status, 'pending', 'first of two steps');
  assert.equal((await s.post('/api/erp/core/approvals/' + sub.data.approvalId + '/decide', { decision: 'approved' }, S.fm.h)).data.code, 'already_decided', 'the same person cannot give both steps');
  const two = await c.approve(sub.data.approvalId);
  assert.equal(two.status, 'approved');
});

test('suspending a vendor ends portal sessions; audit chain intact', async () => {
  assert.equal((await s.post('/api/erp/vendors/' + S.v2 + '/suspend', { reason: 'Quality complaint under review' }, S.pm.h)).status, 200);
  assert.equal((await s.get('/api/vendor/me', S.vt2)).status, 401);
  assert.equal((await s.post('/api/vendor/auth/login', { email: 'ravi@v2.test', password: 'Vendor-pass-5678' })).status, 401);
  assert.equal((await s.get('/api/erp/core/audit/verify', c.maker.h)).data.ok, true);
});
