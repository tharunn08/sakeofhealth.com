/**
 * Phase 5: procure-to-pay.
 *
 *   requisition → (approval) → RFQ to approved vendors → vendor quotes → comparison
 *   → award (MFA) → purchase order → (approval by value) → sent → vendor acknowledgement
 *   → dispatch notice (ASN, batch + expiry per line) → GRN with quality decision per line
 *   → post (lots, batches, stock: accepted → available, quarantined → quarantine)
 *   → supplier invoice → three-way match (PO price × GRN accepted qty × invoice)
 *   → supplier payment (approval) → marked paid with the bank reference.
 *
 * No bank or GST-portal integration exists: payments are recorded, not executed.
 * Pending decisions, while unset: shelf-life rule at GRN (receiver must confirm each
 * line), ASN quantity variance (any difference needs approval), match tolerance (zero),
 * PO and payment approval bands (Super Admin, one step).
 */
'use strict';
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const settings = require('../core/settings.js');
const seq = require('../lib/seq.js');
const M = require('../lib/money.js');
const ledger = require('../inventory/ledger.js');
const lots = require('../inventory/lots.js');
const { fail, posId } = require('../lib/http.js');

const R = M.rupees;
const today = function () { return new Date().toISOString().slice(0, 10); };
const toMs = function (d) { return d instanceof Date ? d.getTime() : Date.parse(String(d).replace(' ', 'T') + 'Z'); };
function items(list, min) {
  if (!Array.isArray(list) || list.length < (min || 1)) throw fail(400, 'Add at least one item');
  if (list.length > 500) throw fail(400, 'At most 500 items');
  return list;
}
function qtyOf(x, name) { const n = Number(x); if (!Number.isInteger(n) || n < 0 || n > 10000000) throw fail(400, (name || 'qty') + ' must be a whole number'); return n; }
function need(cond, msg, code) { if (!cond) throw fail(400, msg, code); }

async function warehouse(q, id) {
  const w = await q.queryOne('SELECT id, state_id, owner_account_id, is_active FROM b2b_warehouses WHERE id = ?', [id]);
  if (!w || w.owner_account_id != null || !Number(w.is_active)) throw fail(400, 'Choose an active company warehouse');
  return w;
}
/** Warehouse-scoped staff may only act on their warehouses. */
function assertWarehouseScope(principal, warehouseId) {
  const s = principal && principal.scopes.warehouse;
  if (s === 'all' || (Array.isArray(s) && s.indexOf(Number(warehouseId)) !== -1)) return;
  throw fail(403, 'This warehouse is outside your scope', 'out_of_scope');
}
async function product(q, id) {
  const p = await q.queryOne('SELECT id, sku, name, hsn_code, gst_rate, is_batch_tracked, shelf_life_days, manufacturer_vendor_id FROM b2b_products WHERE id = ?', [id]);
  if (!p) throw fail(400, 'Unknown product ' + id);
  return p;
}

// ── requisitions ──
async function createRequisition(tx, actor, principal, b) {
  const wid = posId(b.warehouseId); await warehouse(tx, wid); assertWarehouseScope(principal, wid);
  const source = b.source || 'manual';
  need(['manual', 'reorder_level', 'sales_forecast', 'open_orders', 'expiry_replacement'].indexOf(source) !== -1, 'Unknown source');
  const list = items(b.items);
  const no = await seq.next(tx, 'PR');
  const r = await tx.query("INSERT INTO b2b_purchase_requisitions (pr_no, source, warehouse_id, needed_by, status, note, created_by) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
    [no, source, wid, b.neededBy ? v.date(b.neededBy) : null, v.text(b.note, 500) || null, actor.id]);
  const seen = {};
  for (const it of list) {
    const pid = posId(it.productId); await product(tx, pid);
    need(!seen[pid], 'A product appears twice'); seen[pid] = 1;
    const q = qtyOf(it.qty); need(q > 0, 'qty must be at least 1');
    await tx.query('INSERT INTO b2b_purchase_requisition_items (pr_id, product_id, qty, suggested_qty, reason_json) VALUES (?, ?, ?, ?, ?)',
      [r.insertId, pid, q, it.suggestedQty == null ? null : qtyOf(it.suggestedQty), it.reason ? JSON.stringify(it.reason).slice(0, 500) : null]);
  }
  await audit.write(tx, actor, { module: 'procurement', action: 'pr.created', entity: 'purchase_requisition', entityId: r.insertId, new: { prNo: no, warehouseId: wid, items: list.length } });
  return { prId: Number(r.insertId), prNo: no, status: 'draft' };
}
async function submitRequisition(tx, actor, id, reason) {
  const pr = await tx.queryOne('SELECT * FROM b2b_purchase_requisitions WHERE id = ? FOR UPDATE', [id]);
  if (!pr) throw fail(404, 'Requisition not found');
  if (pr.status !== 'draft') throw fail(409, 'Only a draft can be submitted');
  const a = await approvals.request(tx, actor, { type: 'procurement.pr', entity: 'purchase_requisition', entityId: id, reason: reason || 'Purchase requisition ' + pr.pr_no, payload: { prNo: pr.pr_no } });
  await tx.query("UPDATE b2b_purchase_requisitions SET status = 'submitted', approval_id = ? WHERE id = ?", [a.approvalId, id]);
  return a;
}
approvals.register('procurement.pr', async function (tx, req, actor) {
  await tx.query("UPDATE b2b_purchase_requisitions SET status = 'approved' WHERE id = ? AND status = 'submitted'", [req.entityId]);
  await audit.write(tx, actor, { module: 'procurement', action: 'pr.approved', entity: 'purchase_requisition', entityId: req.entityId, approvalId: req.id });
  return { prId: req.entityId, status: 'approved' };
});

/** Reorder suggestions: on hand + in transit + open PO quantity below the reorder level. Read-only. */
async function reorderSuggestions(q) {
  const params = [];
  let where = '1=1';
  if (q.warehouseId) { where = 'rr.warehouse_id = ?'; params.push(posId(q.warehouseId)); }
  const rows = await db.query(
    'SELECT rr.warehouse_id, rr.product_id, rr.min_qty, rr.reorder_qty, rr.max_qty, rr.preferred_vendor_id, p.sku, p.name, ' +
    'COALESCE(st.qty_available, 0) + COALESCE(st.qty_quarantine, 0) AS on_hand, COALESCE(st.qty_in_transit, 0) AS in_transit, COALESCE(st.qty_reserved, 0) AS reserved, ' +
    "(SELECT COALESCE(SUM(GREATEST(CAST(poi.qty_ordered AS SIGNED) - CAST(poi.qty_received AS SIGNED) - CAST(poi.qty_rejected AS SIGNED), 0)), 0) FROM b2b_purchase_order_items poi JOIN b2b_purchase_orders po ON po.id = poi.po_id " +
    "  WHERE poi.product_id = rr.product_id AND po.ship_to_warehouse_id = rr.warehouse_id AND po.status IN ('approved','sent','accepted','partially_accepted','partially_received')) AS on_order " +
    'FROM b2b_reorder_rules rr JOIN b2b_products p ON p.id = rr.product_id LEFT JOIN b2b_stock st ON st.warehouse_id = rr.warehouse_id AND st.product_id = rr.product_id WHERE ' + where +
    ' ORDER BY rr.warehouse_id, p.name LIMIT 1000', params);
  return { items: rows.map(function (r) {
    const position = Number(r.on_hand) - Number(r.reserved) + Number(r.in_transit) + Number(r.on_order);
    let suggest = 0;
    if (position < Number(r.min_qty)) suggest = r.max_qty != null ? Math.max(Number(r.reorder_qty), Number(r.max_qty) - position) : Number(r.reorder_qty);
    return Object.assign({}, r, { position: position, suggestedQty: suggest });
  }).filter(function (r) { return r.suggestedQty > 0; }) };
}

async function setReorderRule(tx, actor, b) {
  const wid = posId(b.warehouseId); await warehouse(tx, wid);
  const pid = posId(b.productId); await product(tx, pid);
  const min = qtyOf(b.minQty, 'minQty'), re = qtyOf(b.reorderQty, 'reorderQty'); need(re > 0, 'reorderQty must be at least 1');
  const max = b.maxQty == null ? null : qtyOf(b.maxQty, 'maxQty');
  if (max != null) need(max >= min, 'maxQty must be at least minQty');
  await tx.query('INSERT INTO b2b_reorder_rules (warehouse_id, product_id, min_qty, reorder_qty, max_qty, preferred_vendor_id) VALUES (?, ?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE min_qty = VALUES(min_qty), reorder_qty = VALUES(reorder_qty), max_qty = VALUES(max_qty), preferred_vendor_id = VALUES(preferred_vendor_id)',
    [wid, pid, min, re, max, posId(b.preferredVendorId) || null]);
  await audit.write(tx, actor, { module: 'procurement', action: 'reorder_rule.set', entity: 'product', entityId: pid, new: { warehouseId: wid, min: min, reorder: re, max: max } });
  return { ok: true };
}

// ── RFQs ──
async function createRfq(tx, actor, b) {
  const wid = posId(b.warehouseId); await warehouse(tx, wid);
  const title = v.text(b.title, 200); need(title, 'Title is required');
  const respondBy = new Date(b.respondBy); need(!isNaN(respondBy) && respondBy.getTime() > Date.now(), 'respondBy must be a future date-time');
  const vendors = Array.from(new Set((b.vendorIds || []).map(posId).filter(Boolean)));
  need(vendors.length, 'Invite at least one vendor');
  const ok = await tx.query("SELECT id FROM b2b_vendors WHERE status = 'approved' AND id IN (" + db.placeholders(vendors) + ')', vendors);
  need(ok.length === vendors.length, 'Only approved vendors can be invited');
  let prId = null;
  if (b.prId) {
    const pr = await tx.queryOne('SELECT id, status FROM b2b_purchase_requisitions WHERE id = ? FOR UPDATE', [posId(b.prId)]);
    need(pr && pr.status === 'approved', 'The requisition must be approved first');
    prId = Number(pr.id);
  }
  const list = items(b.items);
  const no = await seq.next(tx, 'RFQ');
  const r = await tx.query("INSERT INTO b2b_rfqs (rfq_no, pr_id, title, delivery_warehouse_id, respond_by, status, terms_note, created_by) VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)",
    [no, prId, title, wid, respondBy.toISOString().slice(0, 19).replace('T', ' '), v.text(b.terms, 500) || null, actor.id]);
  for (const it of list) {
    const pid = posId(it.productId); await product(tx, pid);
    const q = qtyOf(it.qty); need(q > 0, 'qty must be at least 1');
    try { await tx.query('INSERT INTO b2b_rfq_items (rfq_id, product_id, qty, min_shelf_life_pct) VALUES (?, ?, ?, ?)', [r.insertId, pid, q, it.minShelfLifePct == null ? null : qtyOf(it.minShelfLifePct)]); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(400, 'A product appears twice'); throw e; }
  }
  for (const vid of vendors) await tx.query('INSERT INTO b2b_rfq_vendors (rfq_id, vendor_id) VALUES (?, ?)', [r.insertId, vid]);
  if (prId) await tx.query("UPDATE b2b_purchase_requisitions SET status = 'converted' WHERE id = ?", [prId]);
  await audit.write(tx, actor, { module: 'procurement', action: 'rfq.sent', entity: 'rfq', entityId: r.insertId, new: { rfqNo: no, vendors: vendors, items: list.length } });
  return { rfqId: Number(r.insertId), rfqNo: no, status: 'sent' };
}

// vendor side — every query carries vendor_id from the session
async function vendorRfqs(vendor) {
  return { items: await db.query('SELECT r.id, r.rfq_no, r.title, r.respond_by, r.status, r.terms_note, rv.viewed_at, ' +
    '(SELECT MAX(revision) FROM b2b_rfq_responses x WHERE x.rfq_id = r.id AND x.vendor_id = rv.vendor_id) AS my_revision ' +
    "FROM b2b_rfq_vendors rv JOIN b2b_rfqs r ON r.id = rv.rfq_id WHERE rv.vendor_id = ? AND r.status IN ('sent','closed','awarded') ORDER BY r.id DESC LIMIT 200", [vendor.vendorId]) };
}
async function vendorRfq(vendor, rfqId) {
  const r = await db.queryOne('SELECT r.id, r.rfq_no, r.title, r.respond_by, r.status, r.terms_note FROM b2b_rfq_vendors rv JOIN b2b_rfqs r ON r.id = rv.rfq_id WHERE rv.vendor_id = ? AND r.id = ?', [vendor.vendorId, rfqId]);
  if (!r) throw fail(404, 'Not found');
  await db.query('UPDATE b2b_rfq_vendors SET viewed_at = COALESCE(viewed_at, UTC_TIMESTAMP()) WHERE rfq_id = ? AND vendor_id = ?', [rfqId, vendor.vendorId]);
  r.items = await db.query('SELECT ri.id, ri.product_id, p.name, p.sku, ri.qty, ri.min_shelf_life_pct FROM b2b_rfq_items ri JOIN b2b_products p ON p.id = ri.product_id WHERE ri.rfq_id = ?', [rfqId]);
  return r;
}
async function submitResponse(tx, vendor, rfqId, b) {
  const rfq = await tx.queryOne('SELECT r.* FROM b2b_rfq_vendors rv JOIN b2b_rfqs r ON r.id = rv.rfq_id WHERE rv.vendor_id = ? AND r.id = ? FOR UPDATE', [vendor.vendorId, rfqId]);
  if (!rfq) throw fail(404, 'Not found');
  if (rfq.status !== 'sent' || toMs(rfq.respond_by) < Date.now()) throw fail(409, 'This RFQ is closed for quotes', 'rfq_closed');
  const rfqItems = await tx.query('SELECT id, qty FROM b2b_rfq_items WHERE rfq_id = ?', [rfqId]);
  const byId = {}; rfqItems.forEach(function (i) { byId[i.id] = i; });
  const list = items(b.items);
  const validUntil = v.date(b.validUntil); need(validUntil && validUntil >= today(), 'validUntil must be today or later');
  const prev = await tx.queryOne('SELECT COALESCE(MAX(revision), 0) AS r FROM b2b_rfq_responses WHERE rfq_id = ? AND vendor_id = ?', [rfqId, vendor.vendorId]);
  await tx.query("UPDATE b2b_rfq_responses SET status = 'withdrawn' WHERE rfq_id = ? AND vendor_id = ? AND status = 'submitted'", [rfqId, vendor.vendorId]);
  const freight = M.paise(b.freightTotal || 0); need(freight >= 0, 'freight cannot be negative');
  const r = await tx.query("INSERT INTO b2b_rfq_responses (rfq_id, vendor_id, revision, valid_until, payment_terms_days, freight_total, note, status, submitted_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)",
    [rfqId, vendor.vendorId, Number(prev.r) + 1, validUntil, posId(b.paymentTermsDays) || null, R(freight), v.text(b.note, 500) || null, vendor.userId]);
  // landed unit cost = net unit price + this line's share of freight (by value)
  const lines = list.map(function (it) {
    const ri = byId[posId(it.rfqItemId)]; need(ri, 'Unknown RFQ line ' + it.rfqItemId);
    const avail = qtyOf(it.availableQty, 'availableQty');
    const price = M.p4(it.unitPrice); need(price > 0, 'unitPrice must be positive');
    const disc = Number(it.discountPct || 0); need(disc >= 0 && disc < 100, 'Invalid discount');
    const gst = Number(it.gstRate); need([0, 0.25, 3, 5, 12, 18, 28, 40].indexOf(gst) !== -1, 'gstRate is not a GST slab');
    const net = M.mulDiv(price, Math.round((100 - disc) * 100), 10000);   // 1/10000 rupee
    return { ri: ri, avail: avail, price: it.unitPrice, disc: disc, gst: gst, net: net, value: net * Math.min(avail, Number(ri.qty)), it: it };
  });
  const totalValue = lines.reduce(function (s, l) { return s + l.value; }, 0);
  const seen = {};
  for (const l of lines) {
    need(!seen[l.ri.id], 'A line appears twice'); seen[l.ri.id] = 1;
    const q = Math.min(l.avail, Number(l.ri.qty));
    const share = totalValue && q ? M.mulDiv(freight * 100, l.value, totalValue) / q : 0;   // 1/10000 rupee per unit
    const landed = (l.net + share) / 10000;
    await tx.query('INSERT INTO b2b_rfq_response_items (response_id, rfq_item_id, available_qty, unit_price, gst_rate, discount_pct, moq, lead_days, batch_expiry_from, landed_unit_cost) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [r.insertId, l.ri.id, l.avail, (M.p4(l.price) / 10000).toFixed(4), l.gst.toFixed(2), l.disc.toFixed(4), posId(l.it.moq) || null, posId(l.it.leadDays) || null,
        l.it.batchExpiryFrom ? v.date(l.it.batchExpiryFrom) : null, landed.toFixed(4)]);
  }
  await audit.write(tx, { type: 'vendor', id: vendor.userId, label: 'vendor-user:' + vendor.userId, role: 'vendor_' + vendor.role }, { module: 'procurement', action: 'rfq.response', entity: 'rfq', entityId: rfqId,
    new: { vendorId: vendor.vendorId, revision: Number(prev.r) + 1, lines: lines.length } });
  return { responseId: Number(r.insertId), revision: Number(prev.r) + 1 };
}

/** Side-by-side quotes: latest submitted revision per vendor; lowest landed cost per line flagged. */
async function comparison(rfqId) {
  const rfq = await db.queryOne('SELECT * FROM b2b_rfqs WHERE id = ?', [rfqId]);
  if (!rfq) throw fail(404, 'RFQ not found');
  const rows = await db.query(
    'SELECT ri.id AS rfq_item_id, ri.product_id, p.name, ri.qty, rr.id AS response_id, rr.vendor_id, vd.legal_name, rr.revision, rr.valid_until, rr.payment_terms_days, ' +
    'x.available_qty, x.unit_price, x.discount_pct, x.gst_rate, x.lead_days, x.landed_unit_cost FROM b2b_rfq_items ri JOIN b2b_products p ON p.id = ri.product_id ' +
    "LEFT JOIN b2b_rfq_response_items x ON x.rfq_item_id = ri.id LEFT JOIN b2b_rfq_responses rr ON rr.id = x.response_id AND rr.status IN ('submitted','shortlisted','awarded','not_awarded') " +
    'LEFT JOIN b2b_vendors vd ON vd.id = rr.vendor_id WHERE ri.rfq_id = ? ORDER BY ri.id, x.landed_unit_cost', [rfqId]);
  const lines = {};
  rows.forEach(function (r) {
    const l = lines[r.rfq_item_id] = lines[r.rfq_item_id] || { rfqItemId: Number(r.rfq_item_id), productId: Number(r.product_id), name: r.name, qty: Number(r.qty), quotes: [] };
    if (r.response_id) l.quotes.push({ responseId: Number(r.response_id), vendorId: Number(r.vendor_id), vendor: r.legal_name, revision: r.revision, availableQty: Number(r.available_qty),
      unitPrice: r.unit_price, discountPct: r.discount_pct, gstRate: r.gst_rate, leadDays: r.lead_days, landedUnitCost: r.landed_unit_cost, validUntil: r.valid_until, coversQty: Number(r.available_qty) >= Number(r.qty) });
  });
  Object.values(lines).forEach(function (l) { if (l.quotes.length) l.quotes[0].lowest = true; });
  const vendorTotals = {};
  Object.values(lines).forEach(function (l) { l.quotes.forEach(function (q) {
    const t = vendorTotals[q.responseId] = vendorTotals[q.responseId] || { responseId: q.responseId, vendorId: q.vendorId, vendor: q.vendor, landedTotal: 0, linesQuoted: 0, linesCovered: 0 };
    t.landedTotal += Number(q.landedUnitCost) * Math.min(q.availableQty, l.qty); t.linesQuoted++; if (q.coversQty) t.linesCovered++;
  }); });
  const totals = Object.values(vendorTotals).map(function (t) { return Object.assign(t, { landedTotal: t.landedTotal.toFixed(2) }); }).sort(function (a, b) { return a.landedTotal - b.landedTotal; });
  return { rfq: { id: Number(rfq.id), rfqNo: rfq.rfq_no, status: rfq.status, respondBy: rfq.respond_by }, lines: Object.values(lines), vendorTotals: totals };
}

/** Award to one vendor's quote → a draft PO for the quoted lines. A non-lowest award needs a written reason. */
async function award(tx, actor, rfqId, b) {
  const rfq = await tx.queryOne('SELECT * FROM b2b_rfqs WHERE id = ? FOR UPDATE', [rfqId]);
  if (!rfq) throw fail(404, 'RFQ not found');
  if (['sent', 'closed'].indexOf(rfq.status) === -1) throw fail(409, 'RFQ is ' + rfq.status);
  const resp = await tx.queryOne("SELECT * FROM b2b_rfq_responses WHERE id = ? AND rfq_id = ? AND status = 'submitted'", [posId(b.responseId), rfqId]);
  if (!resp) throw fail(400, 'Choose a current quote (responseId)');
  if (lots.fmt(resp.valid_until) < today()) throw fail(409, 'This quote has expired');
  const cmp = await comparison(rfqId);
  const cheapest = cmp.vendorTotals.filter(function (t) { return t.linesQuoted === Math.max.apply(null, cmp.vendorTotals.map(function (x) { return x.linesQuoted; })); })[0];
  const isLowest = cheapest && cheapest.responseId === Number(resp.id);
  if (!isLowest && (!b.reason || String(b.reason).trim().length < 10)) throw fail(400, 'This is not the lowest landed cost: give the award reason (10+ characters)', 'reason_required');
  const lines = await tx.query('SELECT x.*, ri.product_id, ri.qty AS rfq_qty FROM b2b_rfq_response_items x JOIN b2b_rfq_items ri ON ri.id = x.rfq_item_id WHERE x.response_id = ? AND x.available_qty > 0', [resp.id]);
  need(lines.length, 'The quote has no available lines');
  const po = await createPo(tx, actor, { vendorId: Number(resp.vendor_id), warehouseId: Number(rfq.delivery_warehouse_id), rfqId: rfqId, awardReason: b.reason || 'Lowest landed cost',
    paymentTermsDays: resp.payment_terms_days, freight: resp.freight_total,
    items: lines.map(function (l) { return { productId: Number(l.product_id), qty: Math.min(Number(l.available_qty), Number(l.rfq_qty)), unitPrice: l.unit_price, discountPct: Number(l.discount_pct), gstRate: Number(l.gst_rate) }; }) });
  await tx.query("UPDATE b2b_rfq_responses SET status = IF(id = ?, 'awarded', 'not_awarded') WHERE rfq_id = ? AND status = 'submitted'", [resp.id, rfqId]);
  await tx.query("UPDATE b2b_rfqs SET status = 'awarded' WHERE id = ?", [rfqId]);
  await audit.write(tx, actor, { module: 'procurement', action: 'rfq.awarded', entity: 'rfq', entityId: rfqId, new: { responseId: Number(resp.id), vendorId: Number(resp.vendor_id), lowest: isLowest, poId: po.poId }, reason: b.reason });
  return Object.assign({ awarded: Number(resp.id), lowest: isLowest }, po);
}

// ── purchase orders ──
async function createPo(tx, actor, b) {
  const vendor = await tx.queryOne("SELECT id, status, state_id, gstin, payment_terms_days FROM b2b_vendors WHERE id = ?", [posId(b.vendorId)]);
  if (!vendor || vendor.status !== 'approved') throw fail(400, 'Choose an approved vendor');
  const wh = await warehouse(tx, posId(b.warehouseId));
  need(vendor.state_id && wh.state_id, 'Vendor and warehouse need a state for GST');
  const inter = Number(vendor.state_id) !== Number(wh.state_id);
  const list = items(b.items);
  const no = await seq.next(tx, 'PO');
  const minLife = await settings.get('inventory.grn.min_shelf_life_pct');
  const r = await tx.query("INSERT INTO b2b_purchase_orders (po_no, revision, vendor_id, rfq_id, award_reason, ship_to_warehouse_id, bill_to_state_id, is_interstate, status, delivery_by, payment_terms_days, min_shelf_life_pct, quality_terms, created_by) " +
    "VALUES (?, 0, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)",
    [no, vendor.id, b.rfqId || null, b.awardReason ? String(b.awardReason).slice(0, 255) : null, wh.id, wh.state_id, inter ? 1 : 0, b.deliveryBy ? v.date(b.deliveryBy) : null,
      b.paymentTermsDays != null ? posId(b.paymentTermsDays) || null : vendor.payment_terms_days, minLife === undefined ? null : minLife, v.text(b.qualityTerms, 255) || null, actor.id]);
  const t = { taxable: 0, discount: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
  const seen = {};
  for (const it of list) {
    const p = await product(tx, posId(it.productId));
    need(!seen[p.id], 'A product appears twice'); seen[p.id] = 1;
    const q = qtyOf(it.qty); need(q > 0, 'qty must be at least 1');
    const gst = Number(it.gstRate == null ? p.gst_rate : it.gstRate);
    need([0, 0.25, 3, 5, 12, 18, 28, 40].indexOf(gst) !== -1, 'gstRate is not a GST slab');
    const disc = Number(it.discountPct || 0); need(disc >= 0 && disc < 100, 'Invalid discount');
    const L = M.line(q, it.unitPrice, disc, gst, inter);
    need(L.taxable > 0, 'Line value must be positive');
    await tx.query('INSERT INTO b2b_purchase_order_items (po_id, product_id, hsn_code, qty_ordered, unit_price, discount_pct, gst_rate, taxable_amount, tax_amount, line_total) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [r.insertId, p.id, p.hsn_code, q, (M.p4(it.unitPrice) / 10000).toFixed(4), disc.toFixed(4), gst.toFixed(2), R(L.taxable), R(L.tax), R(L.total)]);
    t.taxable += L.taxable; t.discount += L.discount; t.cgst += L.cgst; t.sgst += L.sgst; t.igst += L.igst; t.total += L.total;
  }
  const freight = M.paise(b.freight || 0);
  await tx.query('UPDATE b2b_purchase_orders SET taxable_total = ?, discount_total = ?, freight_total = ?, cgst_total = ?, sgst_total = ?, igst_total = ?, grand_total = ? WHERE id = ?',
    [R(t.taxable), R(t.discount), R(freight), R(t.cgst), R(t.sgst), R(t.igst), R(t.total + freight), r.insertId]);
  await audit.write(tx, actor, { module: 'procurement', action: 'po.created', entity: 'purchase_order', entityId: r.insertId, new: { poNo: no, vendorId: Number(vendor.id), grandTotal: R(t.total + freight), lines: list.length } });
  return { poId: Number(r.insertId), poNo: no, status: 'draft', grandTotal: R(t.total + freight) };
}

async function getPo(q, id, lock) {
  const po = await q.queryOne('SELECT * FROM b2b_purchase_orders WHERE id = ?' + (lock ? ' FOR UPDATE' : ''), [id]);
  if (!po) throw fail(404, 'Purchase order not found');
  return po;
}
async function poDetail(id) {
  const po = await getPo(db, id);
  po.items = await db.query('SELECT poi.*, p.sku, p.name FROM b2b_purchase_order_items poi JOIN b2b_products p ON p.id = poi.product_id WHERE poi.po_id = ? ORDER BY poi.id', [id]);
  po.acknowledgements = await db.query('SELECT response, changes_json, note, created_at FROM b2b_po_acknowledgements WHERE po_id = ? ORDER BY id', [id]);
  return po;
}
async function listPos(q) {
  const where = ['1=1'], params = [];
  if (q.status) { where.push('po.status = ?'); params.push(String(q.status).slice(0, 30)); }
  if (q.vendorId) { where.push('po.vendor_id = ?'); params.push(posId(q.vendorId)); }
  return { items: await db.query('SELECT po.id, po.po_no, po.status, po.vendor_id, vd.legal_name, po.ship_to_warehouse_id, po.grand_total, po.delivery_by, po.created_at FROM b2b_purchase_orders po ' +
    'JOIN b2b_vendors vd ON vd.id = po.vendor_id WHERE ' + where.join(' AND ') + ' ORDER BY po.id DESC LIMIT ' + db.int(q.limit, 50, 1, 200), params) };
}
async function submitPo(tx, actor, id, reason) {
  const po = await getPo(tx, id, true);
  if (po.status !== 'draft') throw fail(409, 'Only a draft can be submitted');
  const a = await approvals.request(tx, actor, { type: 'procurement.po', entity: 'purchase_order', entityId: id, amount: po.grand_total, reason: reason || 'Purchase order ' + po.po_no, payload: { poNo: po.po_no } });
  await tx.query("UPDATE b2b_purchase_orders SET status = 'pending_approval', approval_id = ? WHERE id = ?", [a.approvalId, id]);
  return a;
}
approvals.register('procurement.po', async function (tx, req, actor) {
  const po = await getPo(tx, req.entityId, true);
  if (po.status !== 'pending_approval') throw fail(409, 'PO is ' + po.status);
  await tx.query("UPDATE b2b_purchase_orders SET status = 'approved' WHERE id = ?", [po.id]);
  await audit.write(tx, actor, { module: 'procurement', action: 'po.approved', entity: 'purchase_order', entityId: po.id, approvalId: req.id });
  return { poId: Number(po.id), status: 'approved' };
});
async function sendPo(tx, actor, id) {
  const po = await getPo(tx, id, true);
  if (po.status !== 'approved') throw fail(409, 'Only an approved PO can be sent');
  await tx.query("UPDATE b2b_purchase_orders SET status = 'sent', sent_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'procurement', action: 'po.sent', entity: 'purchase_order', entityId: id });
  return { poId: Number(id), status: 'sent', note: 'Visible in the vendor portal now. No e-mail/WhatsApp is sent unless a provider is configured.' };
}
async function cancelPo(tx, actor, id, reason) {
  const po = await getPo(tx, id, true);
  if (['draft', 'pending_approval', 'approved', 'sent', 'change_requested', 'rejected_by_vendor'].indexOf(po.status) === -1) throw fail(409, 'A PO with receipts cannot be cancelled; close it instead');
  need(reason && String(reason).trim().length >= 5, 'A reason is required');
  await tx.query("UPDATE b2b_purchase_orders SET status = 'cancelled' WHERE id = ?", [id]);
  if (po.approval_id) await tx.query("UPDATE b2b_approval_requests SET status = 'withdrawn', open_key = NULL, decided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'", [po.approval_id]);
  await audit.write(tx, actor, { module: 'procurement', action: 'po.cancelled', entity: 'purchase_order', entityId: id, old: { status: po.status }, reason: reason });
  return { poId: Number(id), status: 'cancelled' };
}

// vendor side
const VENDOR_PO_STATES = ['sent', 'accepted', 'partially_accepted', 'change_requested', 'rejected_by_vendor', 'partially_received', 'received', 'closed', 'cancelled'];
async function vendorPos(vendor) {
  return { items: await db.query('SELECT id, po_no, status, grand_total, delivery_by, sent_at FROM b2b_purchase_orders WHERE vendor_id = ? AND status IN (' + db.placeholders(VENDOR_PO_STATES) + ') AND sent_at IS NOT NULL ORDER BY id DESC LIMIT 200',
    [vendor.vendorId].concat(VENDOR_PO_STATES)) };
}
async function vendorPo(vendor, id) {
  const po = await db.queryOne('SELECT * FROM b2b_purchase_orders WHERE id = ? AND vendor_id = ? AND sent_at IS NOT NULL', [id, vendor.vendorId]);
  if (!po) throw fail(404, 'Not found');
  po.items = await db.query('SELECT poi.id, poi.product_id, p.name, p.sku, poi.hsn_code, poi.qty_ordered, poi.qty_accepted_by_vendor, poi.qty_received, poi.unit_price, poi.discount_pct, poi.gst_rate, poi.line_total ' +
    'FROM b2b_purchase_order_items poi JOIN b2b_products p ON p.id = poi.product_id WHERE poi.po_id = ?', [id]);
  return po;
}
async function acknowledge(tx, vendor, id, b) {
  const po = await tx.queryOne('SELECT * FROM b2b_purchase_orders WHERE id = ? AND vendor_id = ? FOR UPDATE', [id, vendor.vendorId]);
  if (!po || !po.sent_at) throw fail(404, 'Not found');
  if (po.status !== 'sent') throw fail(409, 'This PO was already answered (' + po.status + ')');
  const resp = String(b.response || '');
  need(['accepted', 'partially_accepted', 'change_requested', 'rejected'].indexOf(resp) !== -1, 'response must be accepted, partially_accepted, change_requested or rejected');
  const its = await tx.query('SELECT id, qty_ordered FROM b2b_purchase_order_items WHERE po_id = ?', [id]);
  if (resp === 'partially_accepted') {
    const qmap = {}; (b.items || []).forEach(function (x) { qmap[posId(x.poItemId)] = qtyOf(x.qty); });
    for (const it of its) {
      const q = qmap[it.id] == null ? Number(it.qty_ordered) : qmap[it.id];
      need(q <= Number(it.qty_ordered), 'Cannot accept more than ordered');
      await tx.query('UPDATE b2b_purchase_order_items SET qty_accepted_by_vendor = ? WHERE id = ?', [q, it.id]);
    }
  } else if (resp === 'accepted') {
    await tx.query('UPDATE b2b_purchase_order_items SET qty_accepted_by_vendor = qty_ordered WHERE po_id = ?', [id]);
  }
  if (resp !== 'accepted') need(b.note && String(b.note).trim().length >= 3, 'Add a note for the buyer');
  const status = { accepted: 'accepted', partially_accepted: 'partially_accepted', change_requested: 'change_requested', rejected: 'rejected_by_vendor' }[resp];
  await tx.query('INSERT INTO b2b_po_acknowledgements (po_id, response, changes_json, note, vendor_user_id) VALUES (?, ?, ?, ?, ?)',
    [id, resp, b.items ? JSON.stringify(b.items).slice(0, 5000) : null, v.text(b.note, 500) || null, vendor.userId]);
  await tx.query('UPDATE b2b_purchase_orders SET status = ? WHERE id = ?', [status, id]);
  await audit.write(tx, { type: 'vendor', id: vendor.userId, label: 'vendor-user:' + vendor.userId, role: 'vendor_' + vendor.role }, { module: 'procurement', action: 'po.' + resp, entity: 'purchase_order', entityId: id, reason: b.note });
  return { poId: id, status: status };
}

async function createAsn(tx, vendor, b) {
  const po = await tx.queryOne('SELECT * FROM b2b_purchase_orders WHERE id = ? AND vendor_id = ? FOR UPDATE', [posId(b.poId), vendor.vendorId]);
  if (!po) throw fail(404, 'Not found');
  need(['accepted', 'partially_accepted', 'partially_received'].indexOf(po.status) !== -1, 'The PO must be accepted before dispatch');
  const its = await tx.query('SELECT poi.*, p.is_batch_tracked FROM b2b_purchase_order_items poi JOIN b2b_products p ON p.id = poi.product_id WHERE poi.po_id = ?', [po.id]);
  const byId = {}; its.forEach(function (i) { byId[i.id] = i; });
  const open = await tx.query("SELECT ai.po_item_id, SUM(ai.qty) AS q FROM b2b_asn_items ai JOIN b2b_asns a ON a.id = ai.asn_id WHERE a.po_id = ? AND a.status IN ('dispatched','arrived') GROUP BY ai.po_item_id", [po.id]);
  const inFlight = {}; open.forEach(function (o) { inFlight[o.po_item_id] = Number(o.q); });
  const list = items(b.items);
  const r = await tx.query("INSERT INTO b2b_asns (po_id, vendor_id, delivery_note_no, vendor_invoice_no, eway_bill_no, transporter, lr_no, dispatched_at, expected_at, status, created_by_vendor_user) VALUES (?,?,?,?,?,?,?, UTC_TIMESTAMP(), ?, 'dispatched', ?)",
    [po.id, vendor.vendorId, v.text(b.deliveryNoteNo, 60) || null, v.text(b.vendorInvoiceNo, 60) || null, v.text(b.ewayBillNo, 20) || null, v.text(b.transporter, 120) || null,
      v.text(b.lrNo, 60) || null, b.expectedAt ? new Date(b.expectedAt).toISOString().slice(0, 19).replace('T', ' ') : null, vendor.userId]);
  const sent = {};
  for (const it of list) {
    const pi = byId[posId(it.poItemId)]; need(pi, 'Unknown PO line');
    const q = qtyOf(it.qty); need(q > 0, 'qty must be at least 1');
    sent[pi.id] = (sent[pi.id] || 0) + q;
    const cap = Number(pi.qty_accepted_by_vendor == null ? pi.qty_ordered : pi.qty_accepted_by_vendor) - Number(pi.qty_received) - (inFlight[pi.id] || 0);
    need(sent[pi.id] <= cap, 'Dispatch quantity exceeds what is still open on the PO for line ' + pi.id, 'over_dispatch');
    const batch = v.text(it.batchNo, 60);
    if (Number(pi.is_batch_tracked)) need(batch && v.date(it.expiryDate), 'Batch number and expiry date are required for every line');
    const mfg = it.mfgDate ? v.date(it.mfgDate) : null, exp = it.expiryDate ? v.date(it.expiryDate) : null;
    if (mfg && exp) need(exp > mfg, 'Expiry must be after manufacture');
    await tx.query('INSERT INTO b2b_asn_items (asn_id, po_item_id, batch_no, mfg_date, expiry_date, mrp, qty) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [r.insertId, pi.id, batch || 'NA', mfg, exp, it.mrp == null ? null : R(M.paise(it.mrp)), q]);
  }
  await audit.write(tx, { type: 'vendor', id: vendor.userId, label: 'vendor-user:' + vendor.userId, role: 'vendor_' + vendor.role }, { module: 'procurement', action: 'asn.dispatched', entity: 'purchase_order', entityId: po.id, new: { asnId: Number(r.insertId), lines: list.length } });
  return { asnId: Number(r.insertId), status: 'dispatched' };
}

// ── goods receipt ──
function lifeLeftPct(mfg, exp, on) {
  if (!exp) return null;
  const e = Date.parse(exp), t = Date.parse(on || today());
  if (!mfg) return null;
  const m = Date.parse(mfg);
  if (!(e > m)) return null;
  return Math.max(0, Math.min(100, Math.round(((e - t) / (e - m)) * 10000) / 100));
}

async function createGrn(tx, actor, principal, b) {
  const po = await getPo(tx, posId(b.poId), true);
  need(['accepted', 'partially_accepted', 'partially_received'].indexOf(po.status) !== -1, 'Goods can only be received against an accepted PO', 'po_not_open');
  assertWarehouseScope(principal, po.ship_to_warehouse_id);
  let asn = null;
  if (b.asnId) {
    asn = await tx.queryOne("SELECT * FROM b2b_asns WHERE id = ? AND po_id = ? AND status IN ('dispatched','arrived') FOR UPDATE", [posId(b.asnId), po.id]);
    need(asn, 'Unknown or already received dispatch notice');
  }
  const its = await tx.query('SELECT poi.*, p.is_batch_tracked, p.manufacturer_vendor_id FROM b2b_purchase_order_items poi JOIN b2b_products p ON p.id = poi.product_id WHERE poi.po_id = ?', [po.id]);
  const byId = {}; its.forEach(function (i) { byId[i.id] = i; });
  const asnQty = {};
  if (asn) (await tx.query('SELECT po_item_id, batch_no, qty FROM b2b_asn_items WHERE asn_id = ?', [asn.id])).forEach(function (a) { const k = a.po_item_id + '|' + lots.normBatch(a.batch_no); asnQty[k] = (asnQty[k] || 0) + Number(a.qty); });
  const minLife = await settings.get('inventory.grn.min_shelf_life_pct');
  const variancePct = await settings.get('procurement.grn.qty_variance_pct');
  const list = items(b.items);
  const no = await seq.next(tx, 'GRN');
  const r = await tx.query("INSERT INTO b2b_grns (grn_no, po_id, asn_id, warehouse_id, vendor_invoice_no, status, received_at, received_by, note) VALUES (?, ?, ?, ?, ?, 'draft', UTC_TIMESTAMP(), ?, ?)",
    [no, po.id, asn ? asn.id : null, po.ship_to_warehouse_id, v.text(b.vendorInvoiceNo, 60) || null, actor.id, v.text(b.note, 500) || null]);
  const variances = [], seenAsn = {}, perItem = {};
  for (const it of list) {
    const pi = byId[posId(it.poItemId)]; need(pi, 'Unknown PO line');
    const rec = qtyOf(it.qtyReceived, 'qtyReceived'), acc = qtyOf(it.qtyAccepted || 0, 'qtyAccepted'), rej = qtyOf(it.qtyRejected || 0, 'qtyRejected'), qua = qtyOf(it.qtyQuarantined || 0, 'qtyQuarantined');
    need(rec > 0 && acc + rej + qua === rec, 'For each line: accepted + rejected + quarantined must equal received');
    if (rej) need(['damaged', 'short_expiry', 'wrong_item', 'quality_fail', 'excess', 'other'].indexOf(it.rejectReason) !== -1, 'Give a reject reason');
    perItem[pi.id] = (perItem[pi.id] || 0) + acc + qua;
    const open = Number(pi.qty_ordered) - Number(pi.qty_received);
    need(perItem[pi.id] <= open, 'More than the open PO quantity cannot be accepted (line ' + pi.id + '); reject the excess with reason "excess"', 'over_receipt');
    const batch = v.text(it.batchNo, 60);
    const mfg = it.mfgDate ? v.date(it.mfgDate) : null, exp = it.expiryDate ? v.date(it.expiryDate) : null;
    if (Number(pi.is_batch_tracked)) need(batch && exp, 'Batch number and expiry date are required (batch-tracked product)');
    if (exp && acc) need(exp > today(), 'Expired goods cannot be accepted');
    const life = lifeLeftPct(mfg, exp);
    if (acc > 0 && exp) {
      if (minLife !== undefined) {
        need(life != null && life >= minLife, 'Shelf life left ' + (life == null ? 'unknown' : life + '%') + ' is below the approved minimum ' + minLife + '%: reject or quarantine', 'short_shelf_life');
      } else {
        need(it.shelfLifeReviewed === true, 'The shelf-life rule is a pending business decision: confirm you reviewed the shelf life of each accepted line (shelfLifeReviewed: true)', 'shelf_life_review_required');
      }
    }
    if (asn) {
      const k = pi.id + '|' + lots.normBatch(batch); seenAsn[k] = (seenAsn[k] || 0) + rec;
    }
    await tx.query('INSERT INTO b2b_grn_items (grn_id, po_item_id, product_id, batch_no, mfg_date, expiry_date, mrp, qty_received, qty_accepted, qty_rejected, qty_quarantined, reject_reason, shelf_life_left_pct) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [r.insertId, pi.id, pi.product_id, batch || 'NA', mfg, exp, it.mrp == null ? null : R(M.paise(it.mrp)), rec, acc, rej, qua, rej ? it.rejectReason : null, life == null ? null : life.toFixed(2)]);
    if (it.qc) {
      need(['pass', 'fail', 'partial'].indexOf(it.qc.result) !== -1, 'qc.result must be pass, fail or partial');
      const gi = await tx.queryOne('SELECT id FROM b2b_grn_items WHERE grn_id = ? ORDER BY id DESC LIMIT 1', [r.insertId]);
      await tx.query("INSERT INTO b2b_quality_inspections (ref_type, ref_id, result, checklist_json, note, inspected_by, inspected_at) VALUES ('grn_item', ?, ?, ?, ?, ?, UTC_TIMESTAMP())",
        [gi.id, it.qc.result, it.qc.checklist ? JSON.stringify(it.qc.checklist).slice(0, 5000) : null, v.text(it.qc.note, 500) || null, actor.id]);
    }
  }
  if (asn) {
    Object.keys(Object.assign({}, asnQty, seenAsn)).forEach(function (k) {
      const a = asnQty[k] || 0, g = seenAsn[k] || 0;
      if (a === g) return;
      const pct = a ? Math.abs(g - a) * 100 / a : 100;
      if (variancePct === undefined || pct > Number(variancePct)) variances.push({ line: k, asnQty: a, receivedQty: g });
    });
  }
  await audit.write(tx, actor, { module: 'procurement', action: 'grn.created', entity: 'grn', entityId: r.insertId, new: { grnNo: no, poId: Number(po.id), lines: list.length, variances: variances } });
  return { grnId: Number(r.insertId), grnNo: no, status: 'draft', variances: variances, needsApproval: variances.length > 0 };
}

async function postGrn(tx, actor, principal, id, reason) {
  const g = await tx.queryOne('SELECT * FROM b2b_grns WHERE id = ? FOR UPDATE', [id]);
  if (!g) throw fail(404, 'GRN not found');
  if (principal) assertWarehouseScope(principal, g.warehouse_id);
  if (g.status !== 'draft') throw fail(409, 'GRN is ' + g.status);
  const created = await tx.queryOne("SELECT new_value FROM b2b_audit_logs WHERE action = 'grn.created' AND entity = 'grn' AND entity_id = ? ORDER BY id LIMIT 1", [String(id)]);
  const variances = created ? (JSON.parse(created.new_value).variances || []) : [];
  if (variances.length) {
    const a = await approvals.request(tx, actor, { type: 'procurement.grn_variance', entity: 'grn', entityId: id, reason: reason || 'Received quantity differs from the dispatch notice', payload: { variances: variances } });
    await tx.query("UPDATE b2b_grns SET status = 'pending_approval', approval_id = ? WHERE id = ?", [a.approvalId, id]);
    return Object.assign({}, a, { grnId: Number(id), status: 'pending_approval' });
  }
  return applyGrn(tx, actor, g);
}
approvals.register('procurement.grn_variance', async function (tx, req, actor) {
  const g = await tx.queryOne('SELECT * FROM b2b_grns WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!g || g.status !== 'pending_approval') throw fail(409, 'GRN is no longer awaiting approval');
  return applyGrn(tx, actor, g, req.id);
});

async function applyGrn(tx, actor, g, approvalId) {
  const po = await getPo(tx, g.po_id, true);
  const lines = await tx.query('SELECT gi.*, p.manufacturer_vendor_id FROM b2b_grn_items gi JOIN b2b_products p ON p.id = gi.product_id WHERE gi.grn_id = ? ORDER BY gi.product_id, gi.id', [g.id]);
  for (const l of lines) {
    const keep = Number(l.qty_accepted) + Number(l.qty_quarantined);
    if (keep > 0) {
      const lot = await lots.upsert(tx, { productId: l.product_id, manufacturerId: l.manufacturer_vendor_id || po.vendor_id, batchNo: l.batch_no,
        mfg: lots.fmt(l.mfg_date), expiry: lots.fmt(l.expiry_date), mrp: l.mrp, grnId: g.id });
      const batchId = await ledger.batchFor(tx, g.warehouse_id, lot);
      if (Number(l.qty_accepted)) {
        await ledger.mustMove(tx, { warehouseId: g.warehouse_id, productId: l.product_id, batchId: batchId, lotId: lot.id, type: 'grn', qty: Number(l.qty_accepted), to: 'available', refType: 'grn', refId: g.id, actor: actor, idemKey: 'grn:' + g.id + ':' + (l.id || l.product_id + '/' + l.batch_no) + ':accepted' });
        await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand + ?, status = 'active' WHERE id = ?", [Number(l.qty_accepted), batchId]);
      }
      if (Number(l.qty_quarantined)) {
        await ledger.mustMove(tx, { warehouseId: g.warehouse_id, productId: l.product_id, batchId: batchId, lotId: lot.id, type: 'quarantine_in', qty: Number(l.qty_quarantined), to: 'quarantine', refType: 'grn', refId: g.id, reason: 'held at receipt', actor: actor, idemKey: 'grn:' + g.id + ':' + (l.id || l.product_id + '/' + l.batch_no) + ':quarantined' });
        await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine + ? WHERE id = ?', [Number(l.qty_quarantined), batchId]);
      }
      await tx.query('UPDATE b2b_grn_items SET lot_id = ? WHERE id = ?', [lot.id, l.id]);
    }
    await tx.query('UPDATE b2b_purchase_order_items SET qty_received = qty_received + ?, qty_rejected = qty_rejected + ? WHERE id = ?', [keep, Number(l.qty_rejected), l.po_item_id]);
  }
  const open = await tx.queryOne('SELECT SUM(GREATEST(CAST(COALESCE(qty_accepted_by_vendor, qty_ordered) AS SIGNED) - CAST(qty_received AS SIGNED), 0)) AS open FROM b2b_purchase_order_items WHERE po_id = ?', [po.id]);
  const poStatus = Number(open.open) > 0 ? 'partially_received' : 'received';
  await tx.query('UPDATE b2b_purchase_orders SET status = ? WHERE id = ?', [poStatus, po.id]);
  await tx.query("UPDATE b2b_grns SET status = 'posted', posted_at = UTC_TIMESTAMP(), posted_by = ? WHERE id = ?", [actor.id || null, g.id]);
  if (g.asn_id) await tx.query("UPDATE b2b_asns SET status = 'received' WHERE id = ?", [g.asn_id]);
  await audit.write(tx, actor, { module: 'procurement', action: 'grn.posted', entity: 'grn', entityId: g.id, approvalId: approvalId || null, new: { poStatus: poStatus, lines: lines.length } });
  return { grnId: Number(g.id), status: 'posted', poStatus: poStatus };
}

// ── supplier invoices and three-way match ──
async function companyStateCode() {
  const r = await db.queryOne("SELECT setting_value FROM b2b_settings WHERE setting_key = 'company.state_gst_code'");
  return r ? String(r.setting_value).replace(/"/g, '') : '29';
}

async function enterInvoice(tx, actor, b) {
  const vendor = await tx.queryOne('SELECT id, gstin, status FROM b2b_vendors WHERE id = ?', [posId(b.vendorId)]);
  if (!vendor) throw fail(400, 'Unknown vendor');
  const no = v.text(b.invoiceNo, 60); need(no, 'invoiceNo is required');
  const date = v.date(b.invoiceDate); need(date && date <= today(), 'invoiceDate is required and cannot be in the future');
  const kind = b.kind === 'proforma' ? 'proforma' : 'tax_invoice';
  const supplierGstin = b.supplierGstin ? v.upper(b.supplierGstin, 15) : vendor.gstin;
  if (supplierGstin) need(v.isGstin(supplierGstin), 'Supplier GSTIN is not valid');
  if (vendor.gstin && supplierGstin && supplierGstin !== vendor.gstin) throw fail(400, 'The GSTIN on the invoice does not match the vendor record', 'gstin_mismatch');
  let po = null;
  if (b.poId) { po = await getPo(tx, posId(b.poId)); need(Number(po.vendor_id) === Number(vendor.id), 'The PO belongs to another vendor'); }
  const own = await companyStateCode();
  const inter = supplierGstin ? supplierGstin.slice(0, 2) !== own : (po ? !!Number(po.is_interstate) : false);
  const list = items(b.items);
  let r;
  try {
    r = await tx.query("INSERT INTO b2b_supplier_invoices (vendor_id, invoice_no, invoice_date, invoice_kind, po_id, supplier_gstin, buyer_gstin, is_interstate, status, entered_by, due_date, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total) VALUES (?,?,?,?,?,?,?,?, 'entered', ?, ?, 0, 0, 0, 0, 0, 0)",
      [vendor.id, no, date, kind, po ? po.id : null, supplierGstin || null, b.buyerGstin ? v.upper(b.buyerGstin, 15) : null, inter ? 1 : 0, actor.id, b.dueDate ? v.date(b.dueDate) : null]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'This vendor invoice number is already entered', 'duplicate_invoice'); throw e; }
  const t = { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
  let n = 0;
  for (const it of list) {
    n++;
    const q = Number(it.qty); need(q > 0 && q < 1e7, 'qty must be positive');
    need(Number.isInteger(q), 'qty must be whole units');
    const gst = Number(it.gstRate); need([0, 0.25, 3, 5, 12, 18, 28, 40].indexOf(gst) !== -1, 'gstRate is not a GST slab');
    const L = M.line(q, it.rate, Number(it.discountPct || 0), gst, inter);
    let poItemId = null, productId = posId(it.productId) || null;
    if (it.poItemId) {
      need(po, 'poItemId given without poId');
      const pi = await tx.queryOne('SELECT id, product_id FROM b2b_purchase_order_items WHERE id = ? AND po_id = ?', [posId(it.poItemId), po.id]);
      need(pi, 'Unknown PO line ' + it.poItemId); poItemId = Number(pi.id); productId = Number(pi.product_id);
    }
    await tx.query('INSERT INTO b2b_supplier_invoice_items (supplier_invoice_id, line_no, po_item_id, product_id, description, hsn_code, batch_no, mfg_date, expiry_date, mrp, qty, uom, rate, discount_pct, discount_amount, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [r.insertId, n, poItemId, productId, v.text(it.description, 255) || 'Item ' + n, it.hsnCode ? String(it.hsnCode).replace(/\D/g, '').slice(0, 10) : null, v.text(it.batchNo, 60) || null,
        it.mfgDate ? v.date(it.mfgDate) : null, it.expiryDate ? v.date(it.expiryDate) : null, it.mrp == null ? null : R(M.paise(it.mrp)), q.toFixed(3), v.text(it.uom, 20) || null,
        (M.p4(it.rate) / 10000).toFixed(4), Number(it.discountPct || 0).toFixed(4), R(L.discount), R(L.taxable), gst.toFixed(2), R(L.cgst), R(L.sgst), R(L.igst), R(L.total)]);
    t.taxable += L.taxable; t.cgst += L.cgst; t.sgst += L.sgst; t.igst += L.igst; t.total += L.total;
  }
  const roundOff = b.roundOff == null ? 0 : M.paise(b.roundOff);
  need(Math.abs(roundOff) <= 100, 'Round-off cannot exceed ₹1');
  const grand = t.total + roundOff;
  if (b.grandTotal != null) {
    const typed = M.paise(b.grandTotal);
    if (typed !== grand) throw fail(400, 'The invoice total ' + R(typed) + ' does not equal the lines (' + R(grand) + '): check quantities, rates and tax', 'total_mismatch');
  }
  await tx.query('UPDATE b2b_supplier_invoices SET taxable_total = ?, cgst_total = ?, sgst_total = ?, igst_total = ?, round_off = ?, grand_total = ? WHERE id = ?',
    [R(t.taxable), R(t.cgst), R(t.sgst), R(t.igst), R(roundOff), R(grand), r.insertId]);
  await audit.write(tx, actor, { module: 'procurement', action: 'supplier_invoice.entered', entity: 'supplier_invoice', entityId: r.insertId, new: { vendorId: Number(vendor.id), invoiceNo: no, grandTotal: R(grand) } });
  return { supplierInvoiceId: Number(r.insertId), status: 'entered', grandTotal: R(grand), isInterstate: inter };
}

async function tolerance() {
  const t = await settings.get('procurement.match.tolerance');
  return t && typeof t === 'object' ? { qty: Number(t.qty_units || 0), pricePct: Number(t.price_pct || 0), amount: M.paise(t.amount_rupees || 0) } : { qty: 0, pricePct: 0, amount: 0 };
}

async function match(tx, actor, id) {
  const inv = await tx.queryOne('SELECT * FROM b2b_supplier_invoices WHERE id = ? FOR UPDATE', [id]);
  if (!inv) throw fail(404, 'Invoice not found');
  if (['entered', 'disputed', 'matching'].indexOf(inv.status) === -1) throw fail(409, 'Invoice is ' + inv.status);
  if (inv.invoice_kind === 'proforma') throw fail(409, 'A proforma invoice cannot be matched for payment');
  const tol = await tolerance();
  const lines = await tx.query('SELECT * FROM b2b_supplier_invoice_items WHERE supplier_invoice_id = ? ORDER BY line_no', [id]);
  const out = [];
  for (const l of lines) {
    const done = await tx.queryOne('SELECT id, resolution FROM b2b_match_results WHERE supplier_invoice_item_id = ?', [l.id]);
    if (done && done.resolution !== 'open') { out.push({ line: l.line_no, result: 'resolved', resolution: done.resolution }); continue; }
    let result = 'matched', pricePo = null, accepted = 0, variance = 0;
    if (!l.po_item_id) result = 'no_po';
    else {
      const pi = await tx.queryOne('SELECT unit_price, discount_pct, gst_rate FROM b2b_purchase_order_items WHERE id = ?', [l.po_item_id]);
      pricePo = pi.unit_price;
      const g = await tx.queryOne("SELECT COALESCE(SUM(gi.qty_accepted), 0) AS q FROM b2b_grn_items gi JOIN b2b_grns g ON g.id = gi.grn_id WHERE gi.po_item_id = ? AND g.status = 'posted'", [l.po_item_id]);
      const billedElsewhere = await tx.queryOne("SELECT COALESCE(SUM(sii.qty), 0) AS q FROM b2b_supplier_invoice_items sii JOIN b2b_supplier_invoices si ON si.id = sii.supplier_invoice_id " +
        "WHERE sii.po_item_id = ? AND si.id <> ? AND si.status NOT IN ('cancelled')", [l.po_item_id, id]);
      accepted = Math.max(0, Number(g.q) - Number(billedElsewhere.q));
      const qty = Number(l.qty);
      const netPo = M.mulDiv(M.p4(pi.unit_price), Math.round((100 - Number(pi.discount_pct)) * 100), 10000), netInv = M.mulDiv(M.p4(l.rate), Math.round((100 - Number(l.discount_pct)) * 100), 10000);
      const priceDiffPct = netPo ? Math.abs(netInv - netPo) * 100 / netPo : 100;
      if (!Number(g.q)) result = 'no_grn';
      else if (qty - accepted > tol.qty) result = 'qty_mismatch';
      else if (priceDiffPct > tol.pricePct && Math.abs(netInv - netPo) * qty / 100 > tol.amount) result = 'price_mismatch';
      else if (Number(pi.gst_rate) !== Number(l.gst_rate)) result = 'tax_mismatch';
      variance = Math.round((netInv * qty - netPo * Math.min(qty, accepted)) / 100);
    }
    await tx.query("INSERT INTO b2b_match_results (supplier_invoice_id, supplier_invoice_item_id, po_item_id, qty_invoiced, qty_accepted_grn, price_po, price_invoiced, result, variance_amount, resolution) VALUES (?,?,?,?,?,?,?,?,?, ?) " +
      'ON DUPLICATE KEY UPDATE po_item_id = VALUES(po_item_id), qty_invoiced = VALUES(qty_invoiced), qty_accepted_grn = VALUES(qty_accepted_grn), price_po = VALUES(price_po), ' +
      'price_invoiced = VALUES(price_invoiced), result = VALUES(result), variance_amount = VALUES(variance_amount), resolution = VALUES(resolution)',
      [id, l.id, l.po_item_id, l.qty, accepted, pricePo, l.rate, result, R(variance), result === 'matched' ? 'accepted_variance' : 'open']);
    out.push({ line: l.line_no, result: result, qtyInvoiced: Number(l.qty), qtyAccepted: accepted, pricePo: pricePo, priceInvoiced: l.rate, variance: R(variance) });
  }
  const open = await tx.queryOne("SELECT COUNT(*) AS n FROM b2b_match_results WHERE supplier_invoice_id = ? AND resolution = 'open'", [id]);
  const status = Number(open.n) ? 'disputed' : 'matched';
  await tx.query('UPDATE b2b_supplier_invoices SET status = ? WHERE id = ?', [status, id]);
  await audit.write(tx, actor, { module: 'procurement', action: 'supplier_invoice.' + status, entity: 'supplier_invoice', entityId: id, new: { lines: out, tolerance: tol } });
  return { supplierInvoiceId: id, status: status, lines: out, tolerance: tol };
}

/** A person with payables.pay (MFA) can accept a variance or mark it for a debit note; the invoice is matched when nothing is open. */
async function resolveMatch(tx, actor, invoiceId, resultId, b) {
  const m = await tx.queryOne('SELECT * FROM b2b_match_results WHERE id = ? AND supplier_invoice_id = ? FOR UPDATE', [resultId, invoiceId]);
  if (!m) throw fail(404, 'Not found');
  if (m.resolution !== 'open') throw fail(409, 'Already resolved');
  need(['accepted_variance', 'debit_note', 'vendor_credit', 'corrected'].indexOf(b.resolution) !== -1, 'Unknown resolution');
  need(b.reason && String(b.reason).trim().length >= 5, 'A reason is required');
  if (m.result === 'no_grn' && b.resolution === 'accepted_variance') throw fail(409, 'Goods not received cannot be accepted for payment');
  await tx.query('UPDATE b2b_match_results SET resolution = ?, resolved_by = ?, resolved_at = UTC_TIMESTAMP() WHERE id = ?', [b.resolution, actor.id, resultId]);
  const open = await tx.queryOne("SELECT COUNT(*) AS n FROM b2b_match_results WHERE supplier_invoice_id = ? AND resolution = 'open'", [invoiceId]);
  if (!Number(open.n)) await tx.query("UPDATE b2b_supplier_invoices SET status = 'matched' WHERE id = ? AND status = 'disputed'", [invoiceId]);
  await audit.write(tx, actor, { module: 'procurement', action: 'match.resolved', entity: 'supplier_invoice', entityId: invoiceId, new: { resultId: resultId, resolution: b.resolution }, reason: b.reason });
  return { resultId: resultId, resolution: b.resolution, invoiceMatched: !Number(open.n) };
}

async function outstanding(q, invoiceId) {
  const r = await q.queryOne("SELECT si.grand_total - COALESCE((SELECT SUM(a.amount) FROM b2b_supplier_payment_allocations a JOIN b2b_supplier_payments p ON p.id = a.supplier_payment_id " +
    "WHERE a.supplier_invoice_id = si.id AND p.status IN ('pending_approval','approved','paid')), 0) AS open FROM b2b_supplier_invoices si WHERE si.id = ?", [invoiceId]);
  return r ? M.paise(r.open) : 0;
}

async function createPayment(tx, actor, b) {
  const vendor = await tx.queryOne('SELECT id, status FROM b2b_vendors WHERE id = ?', [posId(b.vendorId)]);
  if (!vendor) throw fail(400, 'Unknown vendor');
  const bank = await tx.queryOne("SELECT id FROM b2b_vendor_bank_accounts WHERE id = ? AND vendor_id = ? AND status = 'verified'", [posId(b.bankAccountId), vendor.id]);
  need(bank, 'Pay only to a VERIFIED bank account of this vendor', 'bank_not_verified');
  need(['neft', 'rtgs', 'imps', 'upi', 'cheque', 'adjustment'].indexOf(b.method) !== -1, 'Unknown payment method');
  const allocs = items(b.allocations);
  let total = 0;
  const seen = {};
  for (const a of allocs) {
    const iid = posId(a.supplierInvoiceId);
    need(!seen[iid], 'An invoice appears twice'); seen[iid] = 1;
    const inv = await tx.queryOne('SELECT id, vendor_id, status FROM b2b_supplier_invoices WHERE id = ? FOR UPDATE', [iid]);
    need(inv && Number(inv.vendor_id) === Number(vendor.id), 'Invoice ' + a.supplierInvoiceId + ' is not this vendor\'s');
    need(['matched', 'approved_for_payment', 'partly_paid'].indexOf(inv.status) !== -1, 'Invoice ' + iid + ' is ' + inv.status + ': only matched invoices can be paid', 'not_matched');
    const amt = M.paise(a.amount); need(amt > 0, 'Allocation must be positive');
    need(amt <= await outstanding(tx, iid), 'Allocation exceeds what is outstanding on invoice ' + iid, 'over_payment');
    total += amt;
  }
  const tds = M.paise(b.tdsAmount || 0); need(tds >= 0 && tds < total, 'Invalid TDS');
  const no = await seq.next(tx, 'SPAY');
  const r = await tx.query("INSERT INTO b2b_supplier_payments (payment_no, vendor_id, bank_account_id, method, amount, tds_amount, reference, status, created_by) VALUES (?,?,?,?,?,?,?, 'pending_approval', ?)",
    [no, vendor.id, bank.id, b.method, R(total - tds), R(tds), v.text(b.reference, 120) || null, actor.id]);
  for (const a of allocs) await tx.query('INSERT INTO b2b_supplier_payment_allocations (supplier_payment_id, supplier_invoice_id, amount) VALUES (?, ?, ?)', [r.insertId, posId(a.supplierInvoiceId), R(M.paise(a.amount))]);
  const ap = await approvals.request(tx, actor, { type: 'finance.supplier_payment', entity: 'supplier_payment', entityId: r.insertId, amount: R(total), reason: b.reason || 'Supplier payment ' + no, payload: { paymentNo: no } });
  await tx.query('UPDATE b2b_supplier_payments SET approval_id = ? WHERE id = ?', [ap.approvalId, r.insertId]);
  await audit.write(tx, actor, { module: 'finance', action: 'supplier_payment.created', entity: 'supplier_payment', entityId: r.insertId, new: { paymentNo: no, amount: R(total), tds: R(tds), allocations: allocs } });
  return Object.assign({}, ap, { supplierPaymentId: Number(r.insertId), paymentNo: no, status: 'pending_approval', netAmount: R(total - tds) });
}
approvals.register('finance.supplier_payment', async function (tx, req, actor) {
  const p = await tx.queryOne('SELECT * FROM b2b_supplier_payments WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!p || p.status !== 'pending_approval') throw fail(409, 'Payment is no longer awaiting approval');
  await tx.query("UPDATE b2b_supplier_payments SET status = 'approved' WHERE id = ?", [p.id]);
  await audit.write(tx, actor, { module: 'finance', action: 'supplier_payment.approved', entity: 'supplier_payment', entityId: p.id, approvalId: req.id });
  return { supplierPaymentId: Number(p.id), status: 'approved' };
});

/** Recording that the bank transfer was made (outside this system). The person must not be the one who created the payment. */
async function markPaid(tx, actor, id, b) {
  const p = await tx.queryOne('SELECT * FROM b2b_supplier_payments WHERE id = ? FOR UPDATE', [id]);
  if (!p) throw fail(404, 'Payment not found');
  if (p.status !== 'approved') throw fail(409, 'Only an approved payment can be marked paid');
  if (Number(p.created_by) === Number(actor.id)) throw fail(403, 'The person who created the payment cannot also confirm it was paid', 'maker_cannot_check');
  const ref = v.text(b.reference, 120); need(ref && ref.length >= 4, 'Enter the bank reference (UTR / cheque no.)');
  await tx.query("UPDATE b2b_supplier_payments SET status = 'paid', paid_at = UTC_TIMESTAMP(), reference = ? WHERE id = ?", [ref, id]);
  const allocs = await tx.query('SELECT supplier_invoice_id FROM b2b_supplier_payment_allocations WHERE supplier_payment_id = ?', [id]);
  for (const a of allocs) {
    const paid = await tx.queryOne("SELECT si.grand_total, COALESCE((SELECT SUM(x.amount) FROM b2b_supplier_payment_allocations x JOIN b2b_supplier_payments y ON y.id = x.supplier_payment_id " +
      "WHERE x.supplier_invoice_id = si.id AND y.status = 'paid'), 0) AS paid FROM b2b_supplier_invoices si WHERE si.id = ?", [a.supplier_invoice_id]);
    const st = M.paise(paid.paid) >= M.paise(paid.grand_total) ? 'paid' : 'partly_paid';
    await tx.query('UPDATE b2b_supplier_invoices SET status = ? WHERE id = ?', [st, a.supplier_invoice_id]);
  }
  await audit.write(tx, actor, { module: 'finance', action: 'supplier_payment.paid', entity: 'supplier_payment', entityId: id, new: { reference: ref } });
  return { supplierPaymentId: id, status: 'paid' };
}

async function listInvoices(q) {
  const where = ['1=1'], params = [];
  if (q.vendorId) { where.push('si.vendor_id = ?'); params.push(posId(q.vendorId)); }
  if (q.status) { where.push('si.status = ?'); params.push(String(q.status).slice(0, 30)); }
  return { items: await db.query('SELECT si.id, si.vendor_id, vd.legal_name, si.invoice_no, si.invoice_date, si.po_id, si.grand_total, si.status, si.due_date FROM b2b_supplier_invoices si ' +
    'JOIN b2b_vendors vd ON vd.id = si.vendor_id WHERE ' + where.join(' AND ') + ' ORDER BY si.id DESC LIMIT ' + db.int(q.limit, 50, 1, 200), params) };
}
async function listGrns(q) {
  const where = ['1=1'], params = [];
  if (q.poId) { where.push('g.po_id = ?'); params.push(posId(q.poId)); }
  if (q.status) { where.push('g.status = ?'); params.push(String(q.status).slice(0, 30)); }
  return { items: await db.query('SELECT g.id, g.grn_no, g.po_id, g.warehouse_id, g.status, g.received_at, g.posted_at FROM b2b_grns g WHERE ' + where.join(' AND ') + ' ORDER BY g.id DESC LIMIT ' + db.int(q.limit, 50, 1, 200), params) };
}

module.exports = { createRequisition, submitRequisition, reorderSuggestions, setReorderRule, createRfq, vendorRfqs, vendorRfq, submitResponse, comparison, award,
  createPo, poDetail, listPos, submitPo, sendPo, cancelPo, vendorPos, vendorPo, acknowledge, createAsn, createGrn, postGrn, enterInvoice, match, resolveMatch,
  createPayment, markPaid, listInvoices, listGrns, lifeLeftPct, assertWarehouseScope };
