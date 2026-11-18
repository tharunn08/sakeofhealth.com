/**
 * Purchase returns to vendors, with a debit note.
 *
 *   grn_reject                 goods refused at receipt (never entered stock) — quantity from the GRN line
 *   expiry / damage / recall / other   goods in QUARANTINE at a warehouse — leave stock when dispatched
 *
 *   draft → (approval, by value) → approved [debit note number issued] → dispatched (stock out)
 *   → acknowledged by the vendor in the portal → settled (adjusted against a bill, or refunded by the vendor)
 *
 * Prices: the PO price of the line the goods came in on (net of the PO discount), GST as on the PO.
 */
'use strict';
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const seq = require('../lib/seq.js');
const M = require('../lib/money.js');
const ledger = require('../inventory/ledger.js');
const lots = require('../inventory/lots.js');
const inv = require('../inventory/service.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }
const R = M.rupees;

async function create(tx, actor, principal, b) {
  const vendor = await tx.queryOne('SELECT id, state_id FROM b2b_vendors WHERE id = ?', [posId(b.vendorId)]);
  need(vendor, 'Unknown vendor');
  const wid = posId(b.warehouseId); inv.assertWh(principal, wid);
  const wh = await tx.queryOne('SELECT id, state_id FROM b2b_warehouses WHERE id = ? AND owner_account_id IS NULL', [wid]); need(wh, 'Unknown company warehouse');
  const source = ['grn_reject', 'expiry', 'damage', 'recall', 'other'].indexOf(b.source) === -1 ? null : b.source; need(source, 'source must be grn_reject, expiry, damage, recall or other');
  const list = Array.isArray(b.items) ? b.items : []; need(list.length && list.length <= 200, 'Add 1–200 lines');
  const inter = Number(vendor.state_id) !== Number(wh.state_id);
  const no = await seq.next(tx, 'PRET');
  const r = await tx.query("INSERT INTO b2b_purchase_returns (return_no, vendor_id, source, warehouse_id, status, created_by) VALUES (?, ?, ?, ?, 'draft', ?)", [no, vendor.id, source, wid, actor.id]);
  let taxable = 0, tax = 0;
  for (const it of list) {
    const q = Number(it.qty); need(Number.isInteger(q) && q > 0, 'qty must be a positive whole number');
    const reason = v.text(it.reason, 255); need(reason.length >= 3, 'Give a reason for each line');
    let lotId, price, disc, gst;
    if (source === 'grn_reject') {
      const gi = await tx.queryOne("SELECT gi.*, g.status AS grn_status, g.warehouse_id, po.vendor_id, poi.unit_price, poi.discount_pct, poi.gst_rate, p.manufacturer_vendor_id FROM b2b_grn_items gi JOIN b2b_grns g ON g.id = gi.grn_id " +
        'JOIN b2b_purchase_orders po ON po.id = g.po_id JOIN b2b_purchase_order_items poi ON poi.id = gi.po_item_id JOIN b2b_products p ON p.id = gi.product_id WHERE gi.id = ? FOR UPDATE', [posId(it.grnItemId)]);
      need(gi && gi.grn_status === 'posted', 'Unknown or unposted GRN line');
      need(Number(gi.vendor_id) === Number(vendor.id) && Number(gi.warehouse_id) === wid, 'The GRN line belongs to another vendor or warehouse');
      const done = await tx.queryOne("SELECT COALESCE(SUM(i.qty), 0) AS q FROM b2b_purchase_return_items i JOIN b2b_purchase_returns pr ON pr.id = i.purchase_return_id " +
        "WHERE pr.source = 'grn_reject' AND pr.status <> 'cancelled' AND i.reason LIKE ?", ['grn_item:' + gi.id + ':%']);
      need(q + Number(done.q) <= Number(gi.qty_rejected), 'Only ' + (Number(gi.qty_rejected) - Number(done.q)) + ' rejected unit(s) left to return on that GRN line', 'over_return');
      // rejected goods still need a lot record (identity for the debit note); it never holds stock
      const lot = await lots.upsert(tx, { productId: gi.product_id, manufacturerId: gi.manufacturer_vendor_id || vendor.id, batchNo: gi.batch_no, mfg: lots.fmt(gi.mfg_date), expiry: lots.fmt(gi.expiry_date), mrp: gi.mrp, grnId: gi.grn_id });
      lotId = lot.id; price = gi.unit_price; disc = Number(gi.discount_pct); gst = Number(gi.gst_rate);
      it._reason = 'grn_item:' + gi.id + ': ' + reason;
    } else {
      const lot = await tx.queryOne('SELECT l.*, b.qty_quarantine FROM b2b_lots l JOIN b2b_batches b ON b.lot_id = l.id AND b.warehouse_id = ? WHERE l.id = ?', [wid, posId(it.lotId)]);
      need(lot, 'That batch is not at this warehouse');
      const held = await tx.queryOne("SELECT COALESCE(SUM(i.qty), 0) AS q FROM b2b_purchase_return_items i JOIN b2b_purchase_returns pr ON pr.id = i.purchase_return_id WHERE i.lot_id = ? AND pr.warehouse_id = ? AND pr.status IN ('draft','approved') AND pr.source <> 'grn_reject'", [lot.id, wid]);
      need(q + Number(held.q) <= Number(lot.qty_quarantine), 'Only quarantined units can go back (' + (Number(lot.qty_quarantine) - Number(held.q)) + ' free in quarantine)', 'not_in_quarantine');
      const po = await tx.queryOne("SELECT poi.unit_price, poi.discount_pct, poi.gst_rate FROM b2b_grn_items gi JOIN b2b_grns g ON g.id = gi.grn_id AND g.status = 'posted' JOIN b2b_purchase_orders o ON o.id = g.po_id " +
        'JOIN b2b_purchase_order_items poi ON poi.id = gi.po_item_id WHERE gi.lot_id = ? AND o.vendor_id = ? ORDER BY gi.id DESC LIMIT 1', [lot.id, vendor.id]);
      need(po, 'This batch was not bought from this vendor', 'not_from_vendor');
      lotId = lot.id; price = po.unit_price; disc = Number(po.discount_pct); gst = Number(po.gst_rate);
      it._reason = reason;
    }
    const L = M.line(q, price, disc, gst, inter);
    await tx.query('INSERT INTO b2b_purchase_return_items (purchase_return_id, lot_id, qty, unit_price, gst_rate, reason) VALUES (?, ?, ?, ?, ?, ?)',
      [r.insertId, lotId, q, (M.mulDiv(M.p4(price), Math.round((100 - disc) * 100), 10000) / 10000).toFixed(4), gst.toFixed(2), it._reason.slice(0, 255)]);
    taxable += L.taxable; tax += L.tax;
  }
  await tx.query('UPDATE b2b_purchase_returns SET taxable_total = ?, tax_total = ?, grand_total = ? WHERE id = ?', [R(taxable), R(tax), R(taxable + tax), r.insertId]);
  await audit.write(tx, actor, { module: 'procurement', action: 'purchase_return.created', entity: 'purchase_return', entityId: r.insertId, new: { returnNo: no, vendorId: Number(vendor.id), source: source, total: R(taxable + tax) }, reason: b.reason });
  return { purchaseReturnId: Number(r.insertId), returnNo: no, status: 'draft', grandTotal: R(taxable + tax) };
}

async function submit(tx, actor, id, reason) {
  const pr = await tx.queryOne('SELECT * FROM b2b_purchase_returns WHERE id = ? FOR UPDATE', [id]);
  if (!pr) throw fail(404, 'Purchase return not found');
  if (pr.status !== 'draft') throw fail(409, 'Only a draft can be submitted');
  const a = await approvals.request(tx, actor, { type: 'procurement.purchase_return', entity: 'purchase_return', entityId: id, amount: pr.grand_total, reason: reason || 'Return to vendor ' + pr.return_no, payload: { returnNo: pr.return_no } });
  await tx.query('UPDATE b2b_purchase_returns SET approval_id = ? WHERE id = ?', [a.approvalId, id]);
  return a;
}
approvals.register('procurement.purchase_return', async function (tx, req, actor) {
  const pr = await tx.queryOne('SELECT * FROM b2b_purchase_returns WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!pr || pr.status !== 'draft') throw fail(409, 'Purchase return is no longer a draft');
  const dn = await seq.next(tx, 'DN');
  await tx.query("UPDATE b2b_purchase_returns SET status = 'approved', debit_note_no = ? WHERE id = ?", [dn, pr.id]);
  await audit.write(tx, actor, { module: 'procurement', action: 'purchase_return.approved', entity: 'purchase_return', entityId: pr.id, approvalId: req.id, new: { debitNoteNo: dn } });
  return { purchaseReturnId: Number(pr.id), status: 'approved', debitNoteNo: dn };
});

async function dispatch(tx, actor, principal, id, b) {
  const pr = await tx.queryOne('SELECT * FROM b2b_purchase_returns WHERE id = ? FOR UPDATE', [id]);
  if (!pr) throw fail(404, 'Purchase return not found');
  inv.assertWh(principal, pr.warehouse_id);
  if (pr.status !== 'approved') throw fail(409, 'Only an approved return can be dispatched');
  if (pr.source !== 'grn_reject') {
    const items = await tx.query('SELECT i.*, l.product_id FROM b2b_purchase_return_items i JOIN b2b_lots l ON l.id = i.lot_id WHERE i.purchase_return_id = ? ORDER BY l.product_id', [id]);
    for (const it of items) {
      const bt = await tx.queryOne('SELECT id, qty_quarantine FROM b2b_batches WHERE warehouse_id = ? AND lot_id = ? FOR UPDATE', [pr.warehouse_id, it.lot_id]);
      need(bt && Number(bt.qty_quarantine) >= Number(it.qty), 'Not enough of batch ' + it.lot_id + ' in quarantine any more', 'insufficient_stock');
      await ledger.mustMove(tx, { warehouseId: pr.warehouse_id, productId: it.product_id, batchId: bt.id, lotId: it.lot_id, type: 'purchase_return', qty: Number(it.qty), from: 'quarantine', refType: 'purchase_return', refId: id, reason: 'returned to vendor', actor: actor });
      await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine - ? WHERE id = ?', [it.qty, bt.id]);
    }
  }
  await tx.query("UPDATE b2b_purchase_returns SET status = 'dispatched' WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'procurement', action: 'purchase_return.dispatched', entity: 'purchase_return', entityId: id, new: { transporter: b && b.transporter, lrNo: b && b.lrNo } });
  return { purchaseReturnId: id, status: 'dispatched' };
}

// vendor portal
async function vendorList(vendor) {
  return { items: await db.query("SELECT id, return_no, debit_note_no, source, status, taxable_total, tax_total, grand_total, created_at FROM b2b_purchase_returns WHERE vendor_id = ? AND status IN ('approved','dispatched','acknowledged','settled') ORDER BY id DESC LIMIT 200", [vendor.vendorId]) };
}
async function vendorDetail(vendor, id) {
  const pr = await db.queryOne("SELECT id, return_no, debit_note_no, source, status, taxable_total, tax_total, grand_total FROM b2b_purchase_returns WHERE id = ? AND vendor_id = ? AND status IN ('approved','dispatched','acknowledged','settled')", [id, vendor.vendorId]);
  if (!pr) throw fail(404, 'Not found');
  pr.items = await db.query('SELECT i.qty, i.unit_price, i.gst_rate, l.batch_no, p.name FROM b2b_purchase_return_items i JOIN b2b_lots l ON l.id = i.lot_id JOIN b2b_products p ON p.id = l.product_id WHERE i.purchase_return_id = ?', [id]);
  return pr;
}
async function vendorAcknowledge(tx, vendor, id, note) {
  const pr = await tx.queryOne('SELECT * FROM b2b_purchase_returns WHERE id = ? AND vendor_id = ? FOR UPDATE', [id, vendor.vendorId]);
  if (!pr || ['approved', 'dispatched', 'acknowledged', 'settled'].indexOf(pr.status) === -1) throw fail(404, 'Not found');
  if (pr.status !== 'dispatched') throw fail(409, 'Only a dispatched return can be acknowledged (' + pr.status + ')');
  await tx.query("UPDATE b2b_purchase_returns SET status = 'acknowledged' WHERE id = ?", [id]);
  await audit.write(tx, { type: 'vendor', id: vendor.userId, label: 'vendor-user:' + vendor.userId, role: 'vendor_' + vendor.role }, { module: 'procurement', action: 'purchase_return.acknowledged', entity: 'purchase_return', entityId: id, reason: v.text(note, 300) || null });
  return { purchaseReturnId: id, status: 'acknowledged' };
}

/**
 * Settle: either adjust against one of the vendor's matched bills (recorded as an "adjustment"
 * supplier payment — no money moves) or record the vendor's refund reference.
 */
async function settle(tx, actor, id, b) {
  const pr = await tx.queryOne('SELECT * FROM b2b_purchase_returns WHERE id = ? FOR UPDATE', [id]);
  if (!pr) throw fail(404, 'Purchase return not found');
  if (['dispatched', 'acknowledged'].indexOf(pr.status) === -1) throw fail(409, 'Settle after dispatch (status: ' + pr.status + ')');
  const out = { purchaseReturnId: id, status: 'settled' };
  if (b.supplierInvoiceId) {
    const si = await tx.queryOne('SELECT id, vendor_id, status FROM b2b_supplier_invoices WHERE id = ? FOR UPDATE', [posId(b.supplierInvoiceId)]);
    need(si && Number(si.vendor_id) === Number(pr.vendor_id), 'Bill of another vendor');
    need(['matched', 'approved_for_payment', 'partly_paid'].indexOf(si.status) !== -1, 'Adjust only against a matched, unpaid bill');
    const open = await tx.queryOne("SELECT si.grand_total - COALESCE((SELECT SUM(a.amount) FROM b2b_supplier_payment_allocations a JOIN b2b_supplier_payments p ON p.id = a.supplier_payment_id " +
      "WHERE a.supplier_invoice_id = si.id AND p.status IN ('pending_approval','approved','paid')), 0) AS open FROM b2b_supplier_invoices si WHERE si.id = ?", [si.id]);
    need(M.paise(open.open) >= M.paise(pr.grand_total), 'The bill has less open (' + open.open + ') than the debit note', 'over_adjustment');
    const bank = await tx.queryOne("SELECT id FROM b2b_vendor_bank_accounts WHERE vendor_id = ? ORDER BY status = 'verified' DESC, id LIMIT 1", [pr.vendor_id]);
    need(bank, 'The vendor has no bank account on record (needed to file the adjustment)');
    const no = await seq.next(tx, 'SPAY');
    const p = await tx.query("INSERT INTO b2b_supplier_payments (payment_no, vendor_id, bank_account_id, method, amount, tds_amount, reference, status, paid_at, created_by) VALUES (?, ?, ?, 'adjustment', ?, 0, ?, 'paid', UTC_TIMESTAMP(), ?)",
      [no, pr.vendor_id, bank.id, pr.grand_total, 'Debit note ' + pr.debit_note_no, actor.id]);
    await tx.query('INSERT INTO b2b_supplier_payment_allocations (supplier_payment_id, supplier_invoice_id, amount) VALUES (?, ?, ?)', [p.insertId, si.id, pr.grand_total]);
    const paid = await tx.queryOne("SELECT si.grand_total, COALESCE((SELECT SUM(x.amount) FROM b2b_supplier_payment_allocations x JOIN b2b_supplier_payments y ON y.id = x.supplier_payment_id WHERE x.supplier_invoice_id = si.id AND y.status = 'paid'), 0) AS paid FROM b2b_supplier_invoices si WHERE si.id = ?", [si.id]);
    await tx.query('UPDATE b2b_supplier_invoices SET status = ? WHERE id = ?', [M.paise(paid.paid) >= M.paise(paid.grand_total) ? 'paid' : 'partly_paid', si.id]);
    out.adjustedAgainst = Number(si.id); out.adjustmentPaymentNo = no;
  } else {
    const ref = v.text(b.refundReference, 120); need(ref.length >= 4, 'Give the bill to adjust against (supplierInvoiceId) or the vendor\'s refund reference');
    out.refundReference = ref;
  }
  await tx.query("UPDATE b2b_purchase_returns SET status = 'settled' WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'finance', action: 'purchase_return.settled', entity: 'purchase_return', entityId: id, new: out });
  return out;
}

async function list(q) {
  const where = ['1=1'], params = [];
  if (q.vendorId) { where.push('pr.vendor_id = ?'); params.push(posId(q.vendorId)); }
  if (q.status) { where.push('pr.status = ?'); params.push(String(q.status).slice(0, 20)); }
  return { items: await db.query('SELECT pr.*, vd.legal_name FROM b2b_purchase_returns pr JOIN b2b_vendors vd ON vd.id = pr.vendor_id WHERE ' + where.join(' AND ') + ' ORDER BY pr.id DESC LIMIT 200', params) };
}

module.exports = { create, submit, dispatch, vendorList, vendorDetail, vendorAcknowledge, settle, list };
