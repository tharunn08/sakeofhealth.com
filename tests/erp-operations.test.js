/**
 * Phases 6–10 — inventory, network, salesman OTP ordering, returns, recalls, finance
 * (integration, TEST database). One story: stock is received, moved, sold by a salesman
 * with the retailer's code, shipped through the existing B2B order flow, traced,
 * returned, recalled, counted, collected and reconciled.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup, upload, bearer } = require('./helpers/erp.js');
const { gstin } = require('./helpers/db.js');
const b2bSecurity = require('../src/modules/b2b/lib/security.js');

let c, s, admin;
const S = {};
const uuid = () => crypto.randomUUID();
const OTP = { length: 6, expiry_min: 10, max_attempts: 3, resend_cooldown_s: 30, max_resends: 2, stock_hold_min: 30 };
const adminStatus = (id, status, extra) => s.post('/api/admin/b2b/orders/' + id + '/status', Object.assign({ status: status }, extra || {}), admin);

function crackOtp(challengeId, hash) {
  for (let i = 0; i < 1000000; i++) {
    const code = String(i).padStart(6, '0');
    if (crypto.createHmac('sha256', process.env.ERP_JWT_SECRET).update('otp:' + challengeId + ':' + code).digest('hex') === hash) return code;
  }
  throw new Error('code not found');
}

test.before(async () => {
  c = await setup(); s = c.s;
  admin = bearer((await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token);
  const ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  S.ka = ka;
  S.w1 = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active) VALUES ('BLR1', 'Bengaluru DC', ?, 'Bengaluru', '560001', 10, 1)", [ka])).insertId);
  S.w2 = Number((await c.db.query("INSERT INTO b2b_warehouses (code, name, state_id, city, pincode, priority, is_active) VALUES ('MYS1', 'Mysuru DC', ?, 'Mysuru', '570001', 1, 1)", [ka])).insertId);
  S.p = Number((await c.db.query("INSERT INTO b2b_products (sku, name, hsn_code, gst_rate, mrp, base_price, retailer_price, distributor_price, moq, case_qty, is_active, avail_b2c, avail_retailer, avail_distributor) " +
    "VALUES ('BS500', 'Organic Brown Sugar 500 g', '17010000', '5.00', '90.00', '63.49', '74.53', '69.01', 1, 1, 1, 0, 1, 1)")).insertId);
  S.v = Number((await c.db.query("INSERT INTO b2b_vendors (legal_name, gstin, pan, status, onboarding, state_id, vendor_code) VALUES ('Sri Organics Pvt Ltd', ?, 'AAACS1234F', 'approved', 'invited', ?, 'V00001')", [gstin('29', 'AAACS1234F'), ka])).insertId);
  S.t1 = Number((await c.db.query("INSERT INTO b2b_territories (code, name, level, state_id, is_active, created_by) VALUES ('BLR-N', 'Bengaluru North', 'area', ?, 1, ?)", [ka, c.maker.id])).insertId);
  S.t2 = Number((await c.db.query("INSERT INTO b2b_territories (code, name, level, state_id, is_active, created_by) VALUES ('MYS', 'Mysuru', 'area', ?, 1, ?)", [ka, c.maker.id])).insertId);
  const mkRetailer = async (name, mobile, terr, lat, lng) => {
    const id = Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, shop_name, contact_person, mobile, address_line1, city, pincode, state_id, district_name, latitude, longitude, territory_id, approved_at) " +
      "VALUES ('retailer', 'approved', ?, ?, 'Owner', ?, 'MG Road', 'Bengaluru', '560001', ?, 'Bengaluru Urban', ?, ?, ?, UTC_TIMESTAMP())", [name, name, mobile, ka, lat, lng, terr])).insertId);
    await c.db.query("INSERT INTO b2b_users (account_id, name, mobile, password_hash, role, is_primary, status) VALUES (?, 'Owner', ?, ?, 'retailer', 1, 'active')", [id, mobile, b2bSecurity.hashPassword('Retailer!2345')]);
    return id;
  };
  S.r1 = await mkRetailer('Ganesh Stores', '9845011111', S.t1, 13.0350, 77.5970);
  S.r2 = await mkRetailer('Mysuru Mart', '9845022222', S.t2, 12.2958, 76.6394);
  S.wm = await c.person('whm', [{ code: 'warehouse_manager', scopeType: 'warehouse', scopeId: S.w1 }, { code: 'warehouse_manager', scopeType: 'warehouse', scopeId: S.w2 }]);
  S.inv = await c.person('invexec', [{ code: 'inventory_executive', scopeType: 'warehouse', scopeId: S.w2 }]);
  S.sm = await c.person('salesguy', [{ code: 'salesman', scopeType: 'territory', scopeId: S.t1 }]);
  S.fm = await c.person('finman', ['finance_manager']);
  S.dm = await c.person('distman', ['distributor_manager']);
  await c.db.query('INSERT INTO b2b_salesmen (staff_id, employee_code, home_territory_id, cash_limit, is_active) VALUES (?, ?, ?, 5000, 1)', [S.sm.id, 'SM001', S.t1]);
  // an accepted PO to receive against
  S.po = Number((await c.db.query("INSERT INTO b2b_purchase_orders (po_no, revision, vendor_id, ship_to_warehouse_id, bill_to_state_id, is_interstate, status, taxable_total, discount_total, freight_total, cgst_total, sgst_total, igst_total, grand_total, created_by, sent_at) " +
    "VALUES ('PO/TEST/1', 0, ?, ?, ?, 0, 'accepted', 6349.00, 0, 0, 158.73, 158.72, 0, 6666.45, ?, UTC_TIMESTAMP())", [S.v, S.w1, ka, c.maker.id])).insertId);
  S.poi = Number((await c.db.query("INSERT INTO b2b_purchase_order_items (po_id, product_id, hsn_code, qty_ordered, qty_accepted_by_vendor, qty_received, qty_rejected, unit_price, discount_pct, gst_rate, taxable_amount, tax_amount, line_total) " +
    "VALUES (?, ?, '17010000', 100, 100, 0, 0, 63.4900, 0, 5.00, 6349.00, 317.45, 6666.45)", [S.po, S.p])).insertId);
});
test.after(async () => { if (c) await c.stop(); });

test('inventory: receive into a lot; scoped stock view; reconciliation clean', async () => {
  const g = await s.post('/api/erp/procurement/grns', { poId: S.po, items: [{ poItemId: S.poi, batchNo: 'L-26/01', mfgDate: '2026-10-01', expiryDate: '2028-03-31', qtyReceived: 100, qtyAccepted: 100, shelfLifeReviewed: true }] }, S.wm.h);
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal((await s.post('/api/erp/procurement/grns/' + g.data.grnId + '/post', {}, S.wm.h)).data.status, 'posted');
  S.lot = Number((await c.db.queryOne('SELECT id FROM b2b_lots WHERE product_id = ?', [S.p])).id);
  const st = await s.get('/api/erp/inventory/stock', S.inv.h);
  assert.equal(st.data.items.length, 0, 'inventory executive scoped to Mysuru sees no Bengaluru stock');
  const st2 = await s.get('/api/erp/inventory/stock', S.wm.h);
  assert.equal(st2.data.items[0].qty_available, 100);
  assert.match(st2.data.note, /not included or synchronised/);
  const lots = await s.get('/api/erp/inventory/lots?productId=' + S.p, S.wm.h);
  assert.equal(Number(lots.data.items[0].on_hand), 100);
  const rec = await s.get('/api/erp/inventory/reconciliation', c.maker.h);
  assert.equal(rec.data.ok, true, JSON.stringify(rec.data.issues));
});

test('transfer: dispatch moves to in-transit, a short receipt is recorded, ledger stays consistent', async () => {
  assert.equal((await s.post('/api/erp/inventory/transfers', { fromWarehouseId: S.w1, toWarehouseId: S.w2, items: [{ lotId: S.lot, qty: 10 }] }, S.inv.h)).data.code, 'out_of_scope');
  const t = await s.post('/api/erp/inventory/transfers', { fromWarehouseId: S.w1, toWarehouseId: S.w2, items: [{ lotId: S.lot, qty: 10 }], reason: 'Stock for Mysuru' }, S.wm.h);
  assert.equal(t.status, 201, JSON.stringify(t.data));
  assert.equal((await s.post('/api/erp/inventory/transfers/' + t.data.transferId + '/dispatch', {}, S.wm.h)).status, 200);
  const mid = await c.db.queryOne('SELECT qty_available, qty_in_transit FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w1, S.p]);
  assert.deepEqual([Number(mid.qty_available), Number(mid.qty_in_transit)], [90, 10]);
  const rcv = await s.post('/api/erp/inventory/transfers/' + t.data.transferId + '/receive', { items: [{ lotId: S.lot, qtyReceived: 9 }] }, S.inv.h);
  assert.equal(rcv.status, 200, JSON.stringify(rcv.data)); assert.equal(rcv.data.shortages.length, 1);
  const w2 = await c.db.queryOne('SELECT qty_available FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w2, S.p]);
  assert.equal(Number(w2.qty_available), 9);
  assert.equal((await s.get('/api/erp/inventory/reconciliation', c.maker.h)).data.ok, true);
});

test('network: territory boundary, account assignment preview/apply, map features, GSTIN checks', async () => {
  const square = { type: 'Polygon', coordinates: [[[77.5, 12.9], [77.7, 12.9], [77.7, 13.1], [77.5, 13.1], [77.5, 12.9]]] };
  const bad = await s.post('/api/erp/network/territories', { code: 'X', name: 'Bad', level: 'area', boundary: { type: 'Polygon', coordinates: [[[77.5, 12.9], [77.7, 12.9], [77.7, 13.1]]] } }, S.dm.h);
  assert.equal(bad.status, 400);
  const t = await s.post('/api/erp/network/territories', { code: 'BLR-C', name: 'Bengaluru Central', level: 'area', stateId: S.ka, boundary: square }, S.dm.h);
  assert.equal(t.status, 201, JSON.stringify(t.data));
  const pv = await s.post('/api/erp/network/territories/' + t.data.territoryId + '/assign-accounts', {}, S.dm.h);
  assert.equal(pv.data.preview, true); assert.equal(pv.data.inside, 1); assert.equal(pv.data.alreadyInOtherTerritory.length, 1);
  assert.equal((await s.post('/api/erp/network/territories/' + t.data.territoryId + '/assign-accounts', { preview: false }, S.dm.h)).data.code, 'territory_conflict');
  // keep r1 in BLR-N for the salesman tests: do not apply
  const map = await s.get('/api/erp/network/map?type=retailer', S.dm.h);
  assert.equal(map.data.type, 'FeatureCollection'); assert.equal(map.data.features.length, 2);
  const g = await s.post('/api/erp/network/gst-verifications', { partyType: 'vendor', partyId: S.v }, S.dm.h);
  assert.equal(g.data.result, 'format_ok');
  const manualNoEvidence = await s.post('/api/erp/network/gst-verifications', { partyType: 'vendor', partyId: S.v, source: 'manual', result: 'active' }, S.dm.h);
  assert.equal(manualNoEvidence.status, 400);
});

test('salesman: OTP ordering is off until the rules are approved; then code-confirmed order uses existing pricing and stock', async () => {
  const off = await s.post('/api/sales/orders', { retailerId: S.r1, paymentMethod: 'upi', clientUuid: uuid(), items: [{ productId: S.p, qty: 20 }] }, S.sm.h);
  assert.equal(off.data.code, 'otp_rules_pending');
  await c.setting('sales.otp', OTP);
  assert.equal((await s.get('/api/sales/me', c.maker.h)).data.code, 'not_salesman');
  const rs = await s.get('/api/sales/retailers', S.sm.h);
  assert.deepEqual(rs.data.items.map((r) => r.id), [S.r1], 'only retailers in the salesman\'s territory');
  assert.equal((await s.get('/api/sales/catalogue?retailerId=' + S.r2, S.sm.h)).status, 404);
  const cat = await s.get('/api/sales/catalogue?retailerId=' + S.r1, S.sm.h);
  assert.equal(cat.data.items[0].unitPriceExGst, '74.53', 'existing pricing engine: product retailer price');
  const cu = uuid();
  const o = await s.post('/api/sales/orders', { retailerId: S.r1, paymentMethod: 'upi', clientUuid: cu, items: [{ productId: S.p, qty: 20 }], unitPrice: 1 }, S.sm.h);
  assert.equal(o.status, 201, JSON.stringify(o.data)); S.order = o.data.orderId;
  assert.equal(o.data.status, 'pending_otp'); assert.equal(o.data.codeSentTo, 'XXXXXX1111');
  assert.equal(o.data.grandTotal, (Math.round(74.53 * 20 * 1.05)).toFixed(2), 'price from the server, never from the request');
  assert.equal((await s.post('/api/sales/orders', { retailerId: S.r1, paymentMethod: 'upi', clientUuid: cu, items: [{ productId: S.p, qty: 20 }] }, S.sm.h)).data.duplicate, true);
  const st = await c.db.queryOne('SELECT qty_available, qty_reserved FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w1, S.p]);
  assert.deepEqual([Number(st.qty_available), Number(st.qty_reserved)], [70, 20], 'stock held while waiting for the code');
  const q = await c.db.queryOne("SELECT id, code_hash FROM b2b_otp_challenges WHERE order_id = ?", [S.order]);
  assert.equal(o.data.delivery, 'not_sent_no_provider', 'no WhatsApp sender in the test: the code is not sent and not queued');
  assert.equal(await c.db.queryOne("SELECT id FROM b2b_notification_queue WHERE ref_type = 'otp'"), null, 'no plaintext code in the queue');
  assert.ok(await c.db.queryOne("SELECT id FROM b2b_monitor_events WHERE code = 'otp_no_provider'"));
  const code = crackOtp(q.id, q.code_hash);   // the test reads the code from its hash (only possible with the server secret)
  const wrong = await s.post('/api/sales/orders/' + S.order + '/otp/verify', { code: code === '000000' ? '111111' : '000000' }, S.sm.h);
  assert.equal(wrong.status, 409); assert.equal(wrong.data.code, 'otp_wrong'); assert.equal(wrong.data.attemptsLeft, 2);
  const ok = await s.post('/api/sales/orders/' + S.order + '/otp/verify', { code: code }, S.sm.h);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'pending_admin_approval', 'first order rule of the existing B2B applies');
  assert.equal((await s.post('/api/sales/orders/' + S.order + '/otp/verify', { code: code }, S.sm.h)).data.code, 'not_pending');
});

test('salesman: a second order whose code is never given expires and releases the stock', async () => {
  const o = await s.post('/api/sales/orders', { retailerId: S.r1, paymentMethod: 'upi', clientUuid: uuid(), items: [{ productId: S.p, qty: 5 }] }, S.sm.h);
  assert.equal(o.status, 201);
  await c.db.query('UPDATE b2b_orders SET reservation_expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [o.data.orderId]);
  const jobs = require('../src/modules/erp/sales/service.js');
  assert.equal((await jobs.expireHolds()).expired, 1);
  const st = await c.db.queryOne('SELECT qty_available, qty_reserved FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w1, S.p]);
  assert.deepEqual([Number(st.qty_available), Number(st.qty_reserved)], [70, 20]);
  assert.equal((await c.db.queryOne('SELECT status FROM b2b_orders WHERE id = ?', [o.data.orderId])).status, 'otp_expired');
});

test('salesman: without a code an approver can override (never the salesman); cancelling releases the stock', async () => {
  const o = await s.post('/api/sales/orders', { retailerId: S.r1, paymentMethod: 'upi', clientUuid: uuid(), items: [{ productId: S.p, qty: 3 }] }, S.sm.h);
  assert.equal(o.status, 201);
  assert.equal((await s.post('/api/sales/orders/' + o.data.orderId + '/otp-override', { reason: 'short' }, S.sm.h)).status, 400);
  const ov = await s.post('/api/sales/orders/' + o.data.orderId + '/otp-override', { reason: 'Retailer phone not working; owner signed the order copy' }, S.sm.h);
  assert.equal(ov.status, 202, JSON.stringify(ov.data));
  assert.equal((await s.post('/api/erp/core/approvals/' + ov.data.approvalId + '/decide', { decision: 'approved' }, S.sm.h)).status, 403);
  const d = await c.approve(ov.data.approvalId);
  assert.equal(d.result.status, 'pending_admin_approval');
  assert.ok(Number((await c.db.queryOne('SELECT otp_override_approval_id FROM b2b_orders WHERE id = ?', [o.data.orderId])).otp_override_approval_id));
  const cn = await adminStatus(o.data.orderId, 'cancelled', { note: 'Test clean-up' });
  assert.equal(cn.status, 200, JSON.stringify(cn.data));
  const st = await c.db.queryOne('SELECT qty_available, qty_reserved FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w1, S.p]);
  assert.deepEqual([Number(st.qty_available), Number(st.qty_reserved)], [70, 20]);
});

test('existing B2B fulfilment ships the order; the lot trace shows where every unit went', async () => {
  for (const st of ['approved', 'accepted', 'processing', 'packed', 'dispatched', 'delivered']) {
    const r = await adminStatus(S.order, st);
    if (st === 'approved') { assert.equal(r.status, 200, JSON.stringify(r.data)); continue; }
    assert.equal(r.status, 200, st + ' ' + JSON.stringify(r.data));
  }
  const tr = await s.get('/api/erp/inventory/lots/' + S.lot + '/trace', S.wm.h);
  assert.equal(tr.status, 200);
  assert.equal(tr.data.forward.length, 1); assert.equal(Number(tr.data.forward[0].qty), 20); assert.equal(Number(tr.data.forward[0].buyer_account_id), S.r1);
  assert.equal(tr.data.backward[0].po_no, 'PO/TEST/1');
  assert.equal(tr.data.balance.unexplained, 1, 'the one unit lost in transfer shows up as unexplained');
});

test('collections: salesman collects cash; finance (not the collector) confirms; cash limit enforced', async () => {
  const over = await s.post('/api/sales/collections', { orderId: S.order, method: 'cash', amount: 6000, clientUuid: uuid() }, S.sm.h);
  assert.equal(over.status, 400);
  const k = uuid();
  const col = await s.post('/api/sales/collections', { orderId: S.order, method: 'cash', amount: 500, clientUuid: k }, S.sm.h);
  assert.equal(col.status, 201, JSON.stringify(col.data)); assert.match(col.data.receiptNo, /^RCPT\//);
  assert.equal((await s.post('/api/sales/collections', { orderId: S.order, method: 'cash', amount: 500, clientUuid: k }, S.sm.h)).data.duplicate, true);
  const before = await c.db.queryOne('SELECT amount_paid FROM b2b_orders WHERE id = ?', [S.order]);
  assert.equal(Number(before.amount_paid), 0, 'not applied before handover');
  const conf = await s.post('/api/erp/sales/collections/' + col.data.paymentId + '/confirm', {}, S.fm.h);
  assert.equal(conf.status, 200, JSON.stringify(conf.data));
  assert.equal(Number((await c.db.queryOne('SELECT amount_paid FROM b2b_orders WHERE id = ?', [S.order])).amount_paid), 500);
  S.payment = col.data.paymentId;
});

test('finance: allocate the receipt to the invoice; ageing; bank statement import, suggestion and match', async () => {
  const inv = await c.db.queryOne('SELECT id, grand_total FROM b2b_invoices WHERE order_id = ?', [S.order]);
  assert.ok(inv, 'invoice raised by the existing B2B flow at dispatch');
  assert.equal((await s.post('/api/erp/finance/payments/' + S.payment + '/allocations', { allocations: [{ invoiceId: inv.id, amount: '600' }] }, S.fm.h)).data.code, 'over_allocation');
  const al = await s.post('/api/erp/finance/payments/' + S.payment + '/allocations', { allocations: [{ invoiceId: inv.id, amount: '500' }] }, S.fm.h);
  assert.equal(al.status, 200, JSON.stringify(al.data)); assert.equal(al.data.unallocated, '0.00');
  const age = await s.get('/api/erp/finance/ageing', S.fm.h);
  assert.equal(age.data.totals.total, (Number(inv.grand_total) - 500).toFixed(2));
  // a UPI payment recorded by the B2B admin, then seen on the bank statement
  const pay = await s.post('/api/admin/b2b/orders/' + S.order + '/payments', { method: 'upi', amount: '100', reference: 'UPI998877' }, admin);
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  const ba = await s.post('/api/erp/finance/bank-accounts', { bankName: 'HDFC Bank', accountLast4: '4321', ifsc: 'HDFC0000001' }, S.fm.h);
  const csv = 'Date,Narration,Ref No,Debit,Credit,Balance\n05/11/2026,"UPI/UPI998877/GANESH STORES",UPI998877,,100.00,10100.00\n05/11/2026,Bank charges,,59.00,,10041.00\n';
  const imp = await upload(s, '/api/erp/finance/bank-statements', { bankAccountId: ba.data.bankAccountId }, { data: Buffer.from(csv), name: 'stmt.csv' }, S.fm.h);
  assert.equal(imp.status, 201, JSON.stringify(imp.data)); assert.equal(imp.data.added, 2); assert.equal(imp.data.suggested, 1);
  const again = await upload(s, '/api/erp/finance/bank-statements', { bankAccountId: ba.data.bankAccountId }, { data: Buffer.from(csv), name: 'stmt.csv' }, S.fm.h);
  assert.equal(again.data.duplicatesSkipped, 2, 'the same statement twice adds nothing');
  const lines = await s.get('/api/erp/finance/bank-lines?status=suggested', S.fm.h);
  const m = await s.post('/api/erp/finance/bank-lines/' + lines.data.items[0].id + '/match', {}, S.fm.h);
  assert.equal(m.status, 200, JSON.stringify(m.data)); assert.equal(m.data.status, 'matched');
});

test('customer debit note (after approval) raises the invoice balance; distributor settlement needs approval and a second person to close', async () => {
  const inv = await c.db.queryOne('SELECT id FROM b2b_invoices WHERE order_id = ?', [S.order]);
  const it = await c.db.queryOne('SELECT id FROM b2b_invoice_items WHERE invoice_id = ?', [inv.id]);
  const before = (await s.get('/api/erp/finance/ageing', S.fm.h)).data.totals.total;
  const dn = await s.post('/api/erp/finance/debit-notes', { invoiceId: inv.id, reason: 'Freight agreed after delivery', lines: [{ invoiceItemId: it.id, extraTaxable: '100' }] }, S.fm.h);
  assert.equal(dn.status, 202, JSON.stringify(dn.data)); assert.equal(dn.data.grandTotal, '105.00');
  assert.equal((await s.get('/api/erp/finance/ageing', S.fm.h)).data.totals.total, before, 'nothing changes before approval');
  const ap = await c.approve(dn.data.approvalId);
  assert.match(ap.result.debitNoteNo, /^DBN\//);
  assert.equal((await s.get('/api/erp/finance/ageing', S.fm.h)).data.totals.total, (Number(before) + 105).toFixed(2));
  const dist = Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, contact_person, mobile, address_line1, city, pincode, state_id, district_name) VALUES ('distributor', 'approved', 'Dist One', 'D', '9845099999', 'Road', 'Bengaluru', '560001', ?, 'Bengaluru Urban')", [S.ka])).insertId);
  const st = await s.post('/api/erp/finance/settlements', { distributorId: dist, periodFrom: '2026-10-01', periodTo: '2026-10-31', otherAdjustments: '250', reason: 'Display rent for October (agreed)' }, S.fm.h);
  assert.equal(st.status, 201, JSON.stringify(st.data)); assert.equal(st.data.netAmount, '250.00');
  assert.equal((await s.post('/api/erp/finance/settlements', { distributorId: dist, periodFrom: '2026-10-15', periodTo: '2026-11-15' }, S.fm.h)).data.code, 'overlap');
  const sub = await s.post('/api/erp/finance/settlements/' + st.data.settlementId + '/submit', {}, S.fm.h);
  await c.approve(sub.data.approvalId);
  assert.equal((await s.post('/api/erp/finance/settlements/' + st.data.settlementId + '/mark-settled', { reference: 'UTR-1234' }, S.fm.h)).data.code, 'maker_cannot_check');
  assert.equal((await s.post('/api/erp/finance/settlements/' + st.data.settlementId + '/mark-settled', { reference: 'UTR-1234' }, c.maker.h)).status, 200);
});

test('sales desk: beats, targets and achievement; office orders need approval; super stockists only when that tier is decided', async () => {
  const sm = await c.db.queryOne('SELECT id FROM b2b_salesmen WHERE staff_id = ?', [S.sm.id]);
  const mgr = await c.person('salesmgr', ['sales_manager']);
  assert.equal((await s.post('/api/erp/sales/beats', { salesmanId: sm.id, name: 'Mon North', weekday: 1, stops: [S.r2] }, mgr.h)).data.code, 'outside_territory');
  const beat = await s.post('/api/erp/sales/beats', { salesmanId: sm.id, name: 'Mon North', weekday: 1, stops: [S.r1] }, mgr.h);
  assert.equal(beat.status, 201, JSON.stringify(beat.data));
  assert.equal((await s.put('/api/erp/sales/targets', { salesmanId: sm.id, month: new Date().toISOString().slice(0, 7), metric: 'orders', value: 4 }, mgr.h)).status, 200);
  const perf = await s.get('/api/erp/sales/performance', mgr.h);
  const me = perf.data.items.find((x) => x.salesmanId === Number(sm.id));
  assert.equal(me.actual.orders, 1, 'the code-confirmed order; expired and cancelled ones do not count');
  assert.equal(me.target.orders, 4);
  // office order for the retailer (existing tiers): approval first, then it continues like any order
  const dist = await c.person('deskuser', ['business_admin']);
  const oo = await s.post('/api/erp/sales/office-orders', { accountId: S.r1, paymentMethod: 'bank_transfer', items: [{ productId: S.p, qty: 2 }], reason: 'Owner phoned the office on 10 Nov' }, dist.h);
  assert.equal(oo.status, 202, JSON.stringify(oo.data));
  const ok = await c.approve(oo.data.approvalId);
  assert.equal(ok.result.status, 'assigned');
  // super stockists are refused until the tiers decision includes them
  const ssBody = { accountType: 'super_stockist', businessName: 'Karnataka SS Pvt Ltd', contactPerson: 'Mr K', mobile: '9845077777', gstin: require('./helpers/db.js').gstin('29', 'AAACK1111K'), districtId: 1, address: 'Peenya', city: 'Bengaluru', pincode: '560058', reason: 'Appointed SS for Karnataka' };
  assert.equal((await s.post('/api/erp/sales/accounts', ssBody, dist.h)).data.code, 'tier_not_enabled');
  await c.setting('pricing.tiers_enabled', ['retailer', 'distributor', 'super_stockist']);
  const ss = await s.post('/api/erp/sales/accounts', ssBody, dist.h);
  assert.equal(ss.status, 202, JSON.stringify(ss.data));
  await c.approve(ss.data.approvalId);
  const noPrice = await s.post('/api/erp/sales/office-orders', { accountId: ss.data.accountId, paymentMethod: 'bank_transfer', items: [{ productId: S.p, qty: 2 }], reason: 'SS opening order by phone' }, dist.h);
  assert.equal(noPrice.data.code, 'no_ss_price', 'never priced from a default margin');
  await c.db.query('UPDATE b2b_products SET super_stockist_price = 65.72, avail_super_stockist = 1 WHERE id = ?', [S.p]);   // what publishing a list does when the tier is enabled
  const so = await s.post('/api/erp/sales/office-orders', { accountId: ss.data.accountId, paymentMethod: 'bank_transfer', items: [{ productId: S.p, qty: 2 }], reason: 'SS opening order by phone' }, dist.h);
  assert.equal(so.status, 202, JSON.stringify(so.data));
  assert.equal(so.data.grandTotal, (Math.round(65.72 * 2 * 1.05)).toFixed(2));
  await c.approve(so.data.approvalId);
  assert.equal((await c.db.queryOne('SELECT buyer_type FROM b2b_orders WHERE id = ?', [so.data.orderId])).buyer_type, 'super_stockist');
  for (const id of [oo.data.orderId, so.data.orderId]) assert.equal((await adminStatus(id, 'cancelled', { note: 'test clean-up' })).status, 200);
});

test('return: lot must match what was shipped; accepted units go to quarantine; disposition needs approval', async () => {
  const login = await s.post('/api/b2b/auth/login', { identifier: '9845011111', password: 'Retailer!2345', role: 'retailer' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const rt = bearer(login.data.token);
  const item = await c.db.queryOne('SELECT id FROM b2b_order_items WHERE order_id = ?', [S.order]);
  const r = await s.post('/api/b2b/orders/' + S.order + '/returns', { reason: 'Five packs torn', items: [{ order_item_id: item.id, qty: 5 }] }, rt);
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.ret = r.data.id;
  assert.equal((await s.post('/api/admin/b2b/returns/' + S.ret + '/approve', {}, admin)).status, 200);
  const ri = await c.db.queryOne('SELECT id FROM b2b_return_items WHERE return_id = ?', [S.ret]);
  const otherLot = Number((await c.db.query("INSERT INTO b2b_lots (product_id, manufacturer_vendor_id, batch_no, batch_no_norm, status) VALUES (?, ?, 'FAKE-1', 'FAKE1', 'released')", [S.p, S.v])).insertId);
  const fake = await s.post('/api/erp/returns/' + S.ret + '/inspect', { items: [{ returnItemId: ri.id, condition: 'damaged', qtyAccepted: 5, lotId: otherLot, note: 'torn' }] }, S.wm.h);
  assert.equal(fake.data.code, 'lot_not_on_order');
  const ok = await s.post('/api/erp/returns/' + S.ret + '/inspect', { items: [{ returnItemId: ri.id, condition: 'damaged', qtyAccepted: 5, lotId: S.lot, note: 'outer pack torn, seal intact' }] }, S.wm.h);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const st = await c.db.queryOne('SELECT qty_available, qty_quarantine FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w1, S.p]);
  assert.deepEqual([Number(st.qty_available), Number(st.qty_quarantine)], [70, 5]);
  assert.equal((await s.post('/api/admin/b2b/returns/' + S.ret + '/complete', { resolution: 'credit_note' }, admin)).status, 200, 'the existing B2B completion (credit note) still works');
  const d = await s.post('/api/erp/inventory/dispositions', { warehouseId: S.w1, lotId: S.lot, qty: 5, decision: 'return_to_saleable', sourceType: 'return', sourceId: S.ret, reason: 'Repacked; seal intact' }, S.wm.h);
  assert.equal(d.status, 202, JSON.stringify(d.data));
  await c.approve(d.data.approvalId);
  const st2 = await c.db.queryOne('SELECT qty_available, qty_quarantine FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w1, S.p]);
  assert.deepEqual([Number(st2.qty_available), Number(st2.qty_quarantine)], [75, 0]);
  assert.equal((await s.get('/api/erp/inventory/reconciliation', c.maker.h)).data.ok, true);
});

test('recall: activation blocks the lot everywhere and lists the customer; closing needs reconciliation and a second person', async () => {
  const rc = await s.post('/api/erp/recalls', { initiatedBy: 'manufacturer', severity: 'class_2', reason: 'Possible moisture contamination in batch L-26/01', lotIds: [S.lot] }, c.maker.h);
  assert.equal(rc.status, 201, JSON.stringify(rc.data)); S.rc = rc.data.recallId;
  const act = await s.post('/api/erp/recalls/' + S.rc + '/activate', {}, c.maker.h);
  assert.equal(act.status, 200, JSON.stringify(act.data));
  assert.equal(act.data.partiesNotified, 1);
  assert.equal((await c.db.queryOne('SELECT status FROM b2b_lots WHERE id = ?', [S.lot])).status, 'recalled');
  const w1 = await c.db.queryOne('SELECT qty_available, qty_quarantine FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w1, S.p]);
  assert.deepEqual([Number(w1.qty_available), Number(w1.qty_quarantine)], [0, 75]);
  const note = await c.db.queryOne("SELECT title FROM b2b_notifications WHERE account_id = ? ORDER BY id DESC LIMIT 1", [S.r1]);
  assert.match(note.title, /PRODUCT RECALL/);
  // receiving the recalled batch again is refused
  const po2 = Number((await c.db.query("INSERT INTO b2b_purchase_orders (po_no, revision, vendor_id, ship_to_warehouse_id, bill_to_state_id, is_interstate, status, taxable_total, discount_total, freight_total, cgst_total, sgst_total, igst_total, grand_total, created_by) VALUES ('PO/TEST/2', 0, ?, ?, ?, 0, 'accepted', 0,0,0,0,0,0,0, ?)", [S.v, S.w1, S.ka, c.maker.id])).insertId);
  const poi2 = Number((await c.db.query("INSERT INTO b2b_purchase_order_items (po_id, product_id, qty_ordered, qty_accepted_by_vendor, qty_received, qty_rejected, unit_price, discount_pct, gst_rate, taxable_amount, tax_amount, line_total) VALUES (?, ?, 5, 5, 0, 0, 1, 0, 5, 5, 0.25, 5.25)", [po2, S.p])).insertId);
  const g = await s.post('/api/erp/procurement/grns', { poId: po2, items: [{ poItemId: poi2, batchNo: 'L 26 01', mfgDate: '2026-10-01', expiryDate: '2028-03-31', qtyReceived: 5, qtyAccepted: 5, shelfLifeReviewed: true }] }, S.wm.h);
  assert.equal((await s.post('/api/erp/procurement/grns/' + g.data.grnId + '/post', {}, S.wm.h)).data.code, 'lot_recalled');
  const early = await s.post('/api/erp/recalls/' + S.rc + '/close', { reason: 'All units back with the company' }, c.maker.h);
  assert.equal(early.data.code, 'not_reconciled');
  const rec = await s.get('/api/erp/recalls/' + S.rc + '/reconciliation', c.maker.h);
  const party = rec.data.parties[0];
  assert.equal(Number(party.qty_supplied), 15, '20 shipped, 5 already came back through the inspected return');
  assert.equal((await s.post('/api/erp/recalls/' + S.rc + '/receipts', { partyId: party.id, warehouseId: S.w1, qty: 16 }, S.wm.h)).data.code, 'over_return');
  assert.equal((await s.post('/api/erp/recalls/' + S.rc + '/receipts', { partyId: party.id, warehouseId: S.w1, qty: 10 }, S.wm.h)).status, 201);
  assert.equal((await s.post('/api/erp/recalls/' + S.rc + '/parties/' + party.id, { status: 'complete', qtyDeclaredSold: 4, note: 'Owner says 4 sold' }, c.maker.h)).data.code, 'not_balanced');
  assert.equal((await s.post('/api/erp/recalls/' + S.rc + '/parties/' + party.id, { status: 'complete', qtyDeclaredSold: 5, note: 'Owner Ramesh: 5 sold before notice' }, c.maker.h)).status, 200);
  const close = await s.post('/api/erp/recalls/' + S.rc + '/close', { reason: 'All customers resolved; stock quarantined' }, c.maker.h);
  assert.equal(close.status, 202, JSON.stringify(close.data));
  await c.approve(close.data.approvalId);
  assert.equal((await c.db.queryOne('SELECT status FROM b2b_recalls WHERE id = ?', [S.rc])).status, 'closed');
});

test('count: variance needs another person\'s approval, then the ledger is adjusted', async () => {
  const cnt = await s.post('/api/erp/inventory/counts', { warehouseId: S.w2, countType: 'cycle' }, S.inv.h);
  assert.equal(cnt.status, 201, JSON.stringify(cnt.data));
  const sheet = await c.db.query('SELECT lot_id, bucket, system_qty FROM b2b_stock_count_items WHERE count_id = ?', [cnt.data.countId]);
  assert.deepEqual(sheet.map((x) => x.bucket + ':' + x.system_qty).sort(), ['available:0', 'quarantine:9'], 'Mysuru holds the 9 recalled units in quarantine');
  assert.equal((await s.post('/api/erp/inventory/counts/' + cnt.data.countId + '/submit', {}, S.inv.h)).status, 409, 'record the count first');
  assert.equal((await s.put('/api/erp/inventory/counts/' + cnt.data.countId, { items: [{ lotId: S.lot, bucket: 'quarantine', countedQty: 8 }, { lotId: S.lot, bucket: 'available', countedQty: 0 }] }, S.inv.h)).status, 200);
  const sub = await s.post('/api/erp/inventory/counts/' + cnt.data.countId + '/submit', { reason: 'One pack missing' }, S.inv.h);
  assert.equal(sub.data.status, 'pending_approval');
  await c.approve(sub.data.approvalId);
  const w2 = await c.db.queryOne('SELECT qty_quarantine FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [S.w2, S.p]);
  assert.equal(Number(w2.qty_quarantine), 8);
  const rec = await s.get('/api/erp/inventory/reconciliation', c.maker.h);
  assert.equal(rec.data.ok, true, JSON.stringify(rec.data.issues));
  assert.equal((await s.get('/api/erp/core/audit/verify', c.maker.h)).data.ok, true);
});
