/**
 * Phase 6: inventory views, lot traceability, transfers, dispositions, cycle counts
 * and ledger reconciliation — on the existing B2B stock tables.
 *
 * Every write goes through ledger.move (guarded UPDATE + append-only movement row).
 * Warehouse-scoped staff only see and touch their warehouses.
 *
 * NOT real-time with the online shop: B2C stock lives in the shop's own store and is
 * not deducted here (see docs: B2C inventory limitation).
 */
'use strict';
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const settings = require('../core/settings.js');
const seq = require('../lib/seq.js');
const ledger = require('./ledger.js');
const lots = require('./lots.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }
function scopeIds(principal) { const s = principal.scopes.warehouse; return s === 'all' ? null : (Array.isArray(s) ? s : []); }
function assertWh(principal, wid) { const ids = scopeIds(principal); if (ids && ids.indexOf(Number(wid)) === -1) throw fail(403, 'This warehouse is outside your scope', 'out_of_scope'); }
function whFilter(principal, col, where, params) {
  const ids = scopeIds(principal);
  if (!ids) return;
  if (!ids.length) { where.push('1=0'); return; }
  where.push(col + ' IN (' + db.placeholders(ids) + ')'); params.push.apply(params, ids);
}

async function stock(principal, q) {
  const where = ['1=1'], params = [];
  whFilter(principal, 'st.warehouse_id', where, params);
  if (q.warehouseId) { where.push('st.warehouse_id = ?'); params.push(posId(q.warehouseId)); }
  if (q.productId) { where.push('st.product_id = ?'); params.push(posId(q.productId)); }
  const rows = await db.query('SELECT st.warehouse_id, w.code AS warehouse, st.product_id, p.sku, p.name, st.qty_available, st.qty_reserved, st.qty_allocated, st.qty_in_transit, ' +
    'st.qty_quarantine, st.qty_damaged, st.qty_expired, st.updated_at FROM b2b_stock st JOIN b2b_warehouses w ON w.id = st.warehouse_id JOIN b2b_products p ON p.id = st.product_id ' +
    'WHERE ' + where.join(' AND ') + ' ORDER BY w.code, p.name LIMIT ' + db.int(q.limit, 200, 1, 2000), params);
  return { items: rows, note: 'Company and distributor warehouses only. Online-shop (B2C) stock is kept separately and is not included or synchronised.' };
}

async function listLots(principal, q) {
  const where = ['1=1'], params = [];
  if (q.productId) { where.push('l.product_id = ?'); params.push(posId(q.productId)); }
  if (q.status) { where.push('l.status = ?'); params.push(String(q.status).slice(0, 20)); }
  if (q.batch) { where.push('l.batch_no_norm = ?'); params.push(lots.normBatch(q.batch)); }
  if (q.expiringWithinDays) { where.push('l.expiry_date IS NOT NULL AND l.expiry_date <= DATE(UTC_TIMESTAMP()) + INTERVAL ? DAY'); params.push(db.int(q.expiringWithinDays, 90, 0, 3650)); }
  const bw = [], bp = [];
  whFilter(principal, 'b.warehouse_id', bw, bp);
  const rows = await db.query('SELECT l.id, l.product_id, p.sku, p.name, l.manufacturer_vendor_id, vd.legal_name AS manufacturer, l.batch_no, l.mfg_date, l.expiry_date, l.mrp, l.status, l.hold_reason, ' +
    'DATEDIFF(l.expiry_date, DATE(UTC_TIMESTAMP())) AS days_to_expiry, ' +
    '(SELECT COALESCE(SUM(b.qty_on_hand), 0) FROM b2b_batches b WHERE b.lot_id = l.id' + (bw.length ? ' AND ' + bw.join(' AND ') : '') + ') AS on_hand, ' +
    '(SELECT COALESCE(SUM(b.qty_quarantine), 0) FROM b2b_batches b WHERE b.lot_id = l.id' + (bw.length ? ' AND ' + bw.join(' AND ') : '') + ') AS quarantine ' +
    'FROM b2b_lots l JOIN b2b_products p ON p.id = l.product_id JOIN b2b_vendors vd ON vd.id = l.manufacturer_vendor_id WHERE ' + where.join(' AND ') +
    ' ORDER BY l.expiry_date IS NULL, l.expiry_date, l.id LIMIT ' + db.int(q.limit, 200, 1, 2000), bp.concat(bp).concat(params));
  const pct = await settings.get('inventory.near_expiry_pct');
  return { items: rows, nearExpiryRule: pct === undefined ? 'pending decision: listed by days to expiry only' : pct + '% of shelf life left' };
}

/** Backward (where it came from) and forward (where every unit went) for one lot. */
async function trace(lotId) {
  const lot = await db.queryOne('SELECT l.*, p.sku, p.name, vd.legal_name AS manufacturer FROM b2b_lots l JOIN b2b_products p ON p.id = l.product_id JOIN b2b_vendors vd ON vd.id = l.manufacturer_vendor_id WHERE l.id = ?', [lotId]);
  if (!lot) throw fail(404, 'Lot not found');
  const receipts = await db.query('SELECT g.id AS grn_id, g.grn_no, g.posted_at, g.warehouse_id, po.id AS po_id, po.po_no, po.vendor_id, vd.legal_name AS supplier, gi.qty_received, gi.qty_accepted, gi.qty_quarantined, gi.qty_rejected ' +
    "FROM b2b_grn_items gi JOIN b2b_grns g ON g.id = gi.grn_id AND g.status = 'posted' JOIN b2b_purchase_orders po ON po.id = g.po_id JOIN b2b_vendors vd ON vd.id = po.vendor_id WHERE gi.lot_id = ? ORDER BY g.id", [lotId]);
  const holdings = await db.query('SELECT b.id AS batch_id, b.warehouse_id, w.code, w.owner_account_id, b.qty_on_hand, b.qty_quarantine FROM b2b_batches b JOIN b2b_warehouses w ON w.id = b.warehouse_id WHERE b.lot_id = ?', [lotId]);
  // Outbound: B2B order allocations record the batch; the batch carries the lot.
  const shipped = await db.query('SELECT o.id AS order_id, o.order_no, o.status, o.buyer_account_id, a.business_name, a.mobile, o.seller_type, o.seller_account_id, SUM(al.qty) AS qty, MAX(o.dispatched_at) AS dispatched_at ' +
    'FROM b2b_order_item_allocations al JOIN b2b_batches b ON b.id = al.batch_id JOIN b2b_orders o ON o.id = al.order_id JOIN b2b_accounts a ON a.id = o.buyer_account_id ' +
    'WHERE b.lot_id = ? GROUP BY o.id, o.order_no, o.status, o.buyer_account_id, a.business_name, a.mobile, o.seller_type, o.seller_account_id ORDER BY o.id', [lotId]);
  const movements = await db.query('SELECT m.movement_type, m.qty, m.warehouse_id, m.from_status, m.to_status, m.ref_type, m.ref_id, m.created_at FROM b2b_stock_movements m WHERE m.lot_id = ? OR m.batch_id IN (SELECT id FROM b2b_batches WHERE lot_id = ?) ORDER BY m.id LIMIT 2000', [lotId, lotId]);
  const received = receipts.reduce(function (s, r) { return s + Number(r.qty_accepted) + Number(r.qty_quarantined); }, 0);
  const onHand = holdings.reduce(function (s, h) { return s + Number(h.qty_on_hand) + Number(h.qty_quarantine); }, 0);
  const out = shipped.reduce(function (s, x) { return s + Number(x.qty); }, 0);
  return { lot: lot, backward: receipts, holdings: holdings, forward: shipped, movements: movements,
    balance: { received: received, onHand: onHand, allocatedOrShipped: out, unexplained: received - onHand - out },
    limits: 'Stock received before lots existed, or sold through the online shop, has no lot link and cannot be traced here.' };
}

// ── transfers ──
async function createTransfer(tx, actor, principal, b) {
  const from = posId(b.fromWarehouseId), to = posId(b.toWarehouseId);
  need(from && to && from !== to, 'Choose two different warehouses');
  assertWh(principal, from);
  for (const w of [from, to]) need(await tx.queryOne('SELECT id FROM b2b_warehouses WHERE id = ? AND is_active = 1 AND owner_account_id IS NULL', [w]), 'Unknown company warehouse');
  const list = Array.isArray(b.items) ? b.items : [];
  need(list.length && list.length <= 300, 'Add 1–300 lines');
  const no = await seq.next(tx, 'TRF');
  const r = await tx.query("INSERT INTO b2b_stock_transfers (transfer_no, from_warehouse_id, to_warehouse_id, status, reason, created_by) VALUES (?, ?, ?, 'draft', ?, ?)",
    [no, from, to, v.text(b.reason, 255) || null, actor.id]);
  for (const it of list) {
    const lot = await tx.queryOne("SELECT id, status FROM b2b_lots WHERE id = ?", [posId(it.lotId)]);
    need(lot, 'Unknown lot'); need(lot.status === 'released', 'Lot ' + lot.id + ' is ' + lot.status + ' and cannot move');
    const q = Number(it.qty); need(Number.isInteger(q) && q > 0, 'qty must be a positive whole number');
    await tx.query('INSERT INTO b2b_stock_transfer_items (transfer_id, lot_id, qty_sent) VALUES (?, ?, ?)', [r.insertId, lot.id, q]);
  }
  await audit.write(tx, actor, { module: 'inventory', action: 'transfer.created', entity: 'stock_transfer', entityId: r.insertId, new: { transferNo: no, from: from, to: to, lines: list.length } });
  return { transferId: Number(r.insertId), transferNo: no, status: 'draft' };
}

async function dispatchTransfer(tx, actor, principal, id) {
  const t = await tx.queryOne('SELECT * FROM b2b_stock_transfers WHERE id = ? FOR UPDATE', [id]);
  if (!t) throw fail(404, 'Transfer not found');
  assertWh(principal, t.from_warehouse_id);
  if (t.status !== 'draft') throw fail(409, 'Transfer is ' + t.status);
  const its = await tx.query('SELECT ti.*, l.product_id, l.batch_no, l.status AS lot_status FROM b2b_stock_transfer_items ti JOIN b2b_lots l ON l.id = ti.lot_id WHERE ti.transfer_id = ? ORDER BY l.product_id', [id]);
  for (const it of its) {
    need(it.lot_status === 'released', 'Lot ' + it.lot_id + ' is ' + it.lot_status);
    const b = await tx.queryOne('SELECT id, qty_on_hand FROM b2b_batches WHERE warehouse_id = ? AND lot_id = ? FOR UPDATE', [t.from_warehouse_id, it.lot_id]);
    need(b && Number(b.qty_on_hand) >= Number(it.qty_sent), 'Not enough of batch ' + it.batch_no + ' at the source', 'insufficient_stock');
    await ledger.mustMove(tx, { warehouseId: t.from_warehouse_id, productId: it.product_id, batchId: b.id, lotId: it.lot_id, type: 'transfer_out', qty: it.qty_sent, from: 'available', to: 'in_transit', refType: 'stock_transfer', refId: id, actor: actor, idemKey: 'trf:' + id + ':' + it.lot_id + ':dispatched' });
    await tx.query('UPDATE b2b_batches SET qty_on_hand = qty_on_hand - ? WHERE id = ?', [it.qty_sent, b.id]);
  }
  await tx.query("UPDATE b2b_stock_transfers SET status = 'dispatched', dispatched_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'inventory', action: 'transfer.dispatched', entity: 'stock_transfer', entityId: id });
  return { transferId: id, status: 'dispatched' };
}

async function receiveTransfer(tx, actor, principal, id, b) {
  const t = await tx.queryOne('SELECT * FROM b2b_stock_transfers WHERE id = ? FOR UPDATE', [id]);
  if (!t) throw fail(404, 'Transfer not found');
  assertWh(principal, t.to_warehouse_id);
  if (t.status !== 'dispatched') throw fail(409, 'Transfer is ' + t.status);
  const got = {}; ((b && b.items) || []).forEach(function (x) { got[posId(x.lotId)] = Number(x.qtyReceived); });
  const its = await tx.query('SELECT ti.*, l.product_id, l.batch_no, l.mfg_date, l.expiry_date FROM b2b_stock_transfer_items ti JOIN b2b_lots l ON l.id = ti.lot_id WHERE ti.transfer_id = ? ORDER BY l.product_id', [id]);
  const short = [];
  for (const it of its) {
    const q = got[it.lot_id] == null ? Number(it.qty_sent) : got[it.lot_id];
    need(Number.isInteger(q) && q >= 0 && q <= Number(it.qty_sent), 'Received quantity must be 0–sent for lot ' + it.lot_id);
    // leave the source's in-transit bucket for everything that was sent
    await ledger.mustMove(tx, { warehouseId: t.from_warehouse_id, productId: it.product_id, lotId: it.lot_id, type: 'transfer_out', qty: it.qty_sent, from: 'in_transit', refType: 'stock_transfer', refId: id, reason: 'left source', actor: actor, idemKey: 'trf:' + id + ':' + it.lot_id + ':left' });
    if (q > 0) {
      const batchId = await ledger.batchFor(tx, t.to_warehouse_id, { id: it.lot_id, product_id: it.product_id, batch_no: it.batch_no, mfg_date: it.mfg_date, expiry_date: it.expiry_date });
      await ledger.mustMove(tx, { warehouseId: t.to_warehouse_id, productId: it.product_id, batchId: batchId, lotId: it.lot_id, type: 'transfer_in', qty: q, to: 'available', refType: 'stock_transfer', refId: id, actor: actor, idemKey: 'trf:' + id + ':' + it.lot_id + ':received' });
      await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand + ?, status = 'active' WHERE id = ?", [q, batchId]);
    }
    if (q < Number(it.qty_sent)) short.push({ lotId: Number(it.lot_id), sent: Number(it.qty_sent), received: q });
    await tx.query('UPDATE b2b_stock_transfer_items SET qty_received = ? WHERE id = ?', [q, it.id]);
  }
  await tx.query("UPDATE b2b_stock_transfers SET status = 'received', received_at = UTC_TIMESTAMP(), received_by = ? WHERE id = ?", [actor.id, id]);
  await audit.write(tx, actor, { module: 'inventory', action: 'transfer.received', entity: 'stock_transfer', entityId: id, new: { shortages: short } });
  return { transferId: id, status: 'received', shortages: short, note: short.length ? 'Shortages are recorded as transit loss in the ledger and audit log.' : undefined };
}

// ── dispositions (what to do with quarantined/damaged/expired stock) ──
const DECISIONS = ['return_to_saleable', 'return_to_vendor', 'destroy', 'donate', 'rework'];
async function proposeDisposition(tx, actor, principal, b) {
  const wid = posId(b.warehouseId); assertWh(principal, wid);
  const lot = await tx.queryOne('SELECT id, status FROM b2b_lots WHERE id = ?', [posId(b.lotId)]);
  need(lot, 'Unknown lot');
  need(DECISIONS.indexOf(b.decision) !== -1, 'decision must be one of ' + DECISIONS.join(', '));
  need(b.decision !== 'return_to_vendor', 'Goods going back to the vendor need a purchase return (with a debit note): /api/erp/procurement/purchase-returns', 'use_purchase_return');
  if (b.decision === 'return_to_saleable') need(lot.status === 'released', 'A ' + lot.status + ' lot cannot go back to saleable stock');
  const src = String(b.sourceType || 'grn'); need(['return', 'grn', 'recall', 'count', 'expiry'].indexOf(src) !== -1, 'Unknown source');
  const q = Number(b.qty); need(Number.isInteger(q) && q > 0, 'qty must be a positive whole number');
  const bt = await tx.queryOne('SELECT qty_quarantine FROM b2b_batches WHERE warehouse_id = ? AND lot_id = ?', [wid, lot.id]);
  need(bt && Number(bt.qty_quarantine) >= q, 'Only quarantined stock can be disposed (' + (bt ? bt.qty_quarantine : 0) + ' in quarantine)');
  need(b.reason && String(b.reason).trim().length >= 5, 'A reason is required');
  const r = await tx.query("INSERT INTO b2b_dispositions (warehouse_id, lot_id, qty, decision, source_type, source_id, status, evidence_json, proposed_by) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)",
    [wid, lot.id, q, b.decision, src, posId(b.sourceId) || null, b.evidence ? JSON.stringify(b.evidence).slice(0, 5000) : null, actor.id]);
  const a = await approvals.request(tx, actor, { type: 'inventory.disposition', entity: 'disposition', entityId: r.insertId, reason: b.reason, payload: { decision: b.decision, qty: q, lotId: Number(lot.id) } });
  await tx.query('UPDATE b2b_dispositions SET approval_id = ? WHERE id = ?', [a.approvalId, r.insertId]);
  await audit.write(tx, actor, { module: 'inventory', action: 'disposition.proposed', entity: 'disposition', entityId: r.insertId, new: { decision: b.decision, qty: q, lotId: Number(lot.id), warehouseId: wid }, reason: b.reason, approvalId: a.approvalId });
  return Object.assign({}, a, { dispositionId: Number(r.insertId) });
}
approvals.register('inventory.disposition', async function (tx, req, actor) {
  const d = await tx.queryOne('SELECT d.*, l.product_id, l.status AS lot_status FROM b2b_dispositions d JOIN b2b_lots l ON l.id = d.lot_id WHERE d.id = ? FOR UPDATE', [req.entityId]);
  if (!d || d.status !== 'proposed') throw fail(409, 'Disposition is no longer proposed');
  const b = await tx.queryOne('SELECT id, qty_quarantine FROM b2b_batches WHERE warehouse_id = ? AND lot_id = ? FOR UPDATE', [d.warehouse_id, d.lot_id]);
  if (!b || Number(b.qty_quarantine) < Number(d.qty)) throw fail(409, 'Not enough in quarantine any more');
  if (d.decision === 'return_to_saleable') {
    if (d.lot_status !== 'released') throw fail(409, 'Lot is ' + d.lot_status);
    await ledger.mustMove(tx, { warehouseId: d.warehouse_id, productId: d.product_id, batchId: b.id, lotId: d.lot_id, type: 'quarantine_out', qty: d.qty, from: 'quarantine', to: 'available', refType: 'disposition', refId: d.id, actor: actor, idemKey: 'disp:' + d.id });
    await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine - ?, qty_on_hand = qty_on_hand + ? WHERE id = ?', [d.qty, d.qty, b.id]);
  } else {
    // leaves stock: destroy / donate / rework / return to vendor (the purchase return document follows)
    await ledger.mustMove(tx, { warehouseId: d.warehouse_id, productId: d.product_id, batchId: b.id, lotId: d.lot_id, type: d.decision === 'return_to_vendor' ? 'purchase_return' : 'write_off', qty: d.qty, from: 'quarantine', refType: 'disposition', refId: d.id, reason: d.decision, actor: actor, idemKey: 'disp:' + d.id });
    await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine - ? WHERE id = ?', [d.qty, b.id]);
  }
  await tx.query("UPDATE b2b_dispositions SET status = 'executed', executed_at = UTC_TIMESTAMP() WHERE id = ?", [d.id]);
  await audit.write(tx, actor, { module: 'inventory', action: 'disposition.executed', entity: 'disposition', entityId: d.id, approvalId: req.id, new: { decision: d.decision, qty: Number(d.qty) } });
  return { dispositionId: Number(d.id), status: 'executed' };
});

// ── stock adjustments and opening balances (owner decision 5, Milestone 3b.1) ──
// Company stock is added only through a GRN, or through an adjustment / opening balance that one
// person proposes and a second person approves. Posting carries the key 'adj:<id>', so an approval
// replayed or retried can never post twice.
const ADJ_REASONS = { increase: ['found', 'correction'], decrease: ['damage', 'expiry', 'loss', 'theft', 'correction'] };
async function proposeAdjustment(tx, actor, principal, b) {
  const kind = b.kind === 'opening' ? 'opening' : 'adjustment';
  const wid = posId(b.warehouseId); assertWh(principal, wid);
  const wh = await tx.queryOne('SELECT id, owner_account_id, is_active FROM b2b_warehouses WHERE id = ?', [wid]);
  need(wh && Number(wh.is_active), 'Unknown or inactive warehouse');
  need(wh.owner_account_id == null, 'A distributor\'s own stock point is not adjusted here');
  const product = await tx.queryOne('SELECT id, sku FROM b2b_products WHERE id = ?', [posId(b.productId)]);
  need(product, 'Unknown product');
  const qty = Number(b.qty); need(Number.isInteger(qty) && qty > 0 && qty <= 10000000, 'qty must be a positive whole number');
  const reason = String(b.reason || '').trim(); need(reason.length >= 5, 'A reason of at least 5 characters is required', 'reason_required');
  let direction, bucket, reasonCode, lotId = null, openKey = null;
  if (kind === 'opening') {
    direction = 'increase'; bucket = b.bucket === 'quarantine' ? 'quarantine' : 'available'; reasonCode = 'opening_balance';
    const used = await tx.queryOne('SELECT COUNT(*) AS n FROM b2b_stock_movements WHERE warehouse_id = ? AND product_id = ?', [wid, product.id]);
    need(Number(used.n) === 0, 'This product already has stock history at this warehouse; use an adjustment instead of an opening balance', 'has_history');
    openKey = 'opening:' + wid + ':' + product.id;
    const prior = await tx.queryOne("SELECT a.id, a.status, r.status AS approval_status FROM b2b_stock_adjustments a LEFT JOIN b2b_approval_requests r ON r.id = a.approval_id WHERE a.open_key = ? FOR UPDATE", [openKey]);
    if (prior) {
      // a rejected or withdrawn opening balance may be proposed again; anything else blocks a second one
      need(prior.status === 'proposed' && (prior.approval_status === 'rejected' || prior.approval_status === 'withdrawn'), 'An opening balance for this product at this warehouse already exists', 'opening_exists');
      await tx.query("UPDATE b2b_stock_adjustments SET status = ?, open_key = NULL WHERE id = ?", [prior.approval_status, prior.id]);
    }
  } else {
    direction = b.direction === 'decrease' ? 'decrease' : (b.direction === 'increase' ? 'increase' : null);
    need(direction, 'direction must be increase or decrease');
    reasonCode = String(b.reasonCode || '');
    need(ADJ_REASONS[direction].indexOf(reasonCode) !== -1, 'reasonCode for an ' + direction + ' must be one of ' + ADJ_REASONS[direction].join(', '));
    bucket = String(b.bucket || 'available');
    need(['available', 'damaged', 'expired', 'quarantine'].indexOf(bucket) !== -1, 'bucket must be available, damaged, expired or quarantine');
    if (direction === 'increase') need(bucket === 'available' || bucket === 'quarantine', 'Found stock goes to available or quarantine');
    if (reasonCode === 'damage' || reasonCode === 'expiry') need(bucket === 'available', 'Damage and expiry move units out of available stock');
  }
  // the lot: required whenever units enter stock, so every unit stays traceable
  if (b.lotId) {
    const lot = await tx.queryOne('SELECT id, product_id, status FROM b2b_lots WHERE id = ?', [posId(b.lotId)]);
    need(lot && Number(lot.product_id) === Number(product.id), 'That lot is not for this product');
    if (direction === 'increase') need(lot.status !== 'recalled', 'A recalled lot cannot be added to stock');
    lotId = Number(lot.id);
  } else if (direction === 'increase') {
    need(b.batchNo && b.expiry && b.manufacturerId, 'Stock coming in needs its lot: batchNo, expiry and manufacturerId (or an existing lotId)', 'lot_required');
    const vend = await tx.queryOne('SELECT id FROM b2b_vendors WHERE id = ?', [posId(b.manufacturerId)]);
    need(vend, 'Unknown manufacturer');
    const lot = await lots.upsert(tx, { productId: product.id, manufacturerId: Number(vend.id), batchNo: b.batchNo, mfg: v.date(b.mfg) || null, expiry: v.date(b.expiry) || null });
    lotId = Number(lot.id);
  }
  if (direction === 'decrease') {
    const st = await tx.queryOne('SELECT qty_' + bucket + ' AS q FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [wid, product.id]);
    need(st && Number(st.q) >= qty, 'Only ' + (st ? st.q : 0) + ' in ' + bucket + ' at this warehouse', 'insufficient_stock');
  }
  const no = await seq.next(tx, kind === 'opening' ? 'OPN' : 'ADJ');
  const r = await tx.query('INSERT INTO b2b_stock_adjustments (adj_no, kind, direction, warehouse_id, product_id, lot_id, bucket, qty, reason_code, reason, proposed_by, open_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [no, kind, direction, wid, product.id, lotId, bucket, qty, reasonCode, reason.slice(0, 300), actor.id, openKey]);
  const a = await approvals.request(tx, actor, { type: 'inventory.adjustment', entity: 'stock_adjustment', entityId: r.insertId, reason: reason,
    payload: { kind: kind, direction: direction, bucket: bucket, qty: qty, sku: product.sku, warehouseId: wid } });
  await tx.query('UPDATE b2b_stock_adjustments SET approval_id = ? WHERE id = ?', [a.approvalId, r.insertId]);
  await audit.write(tx, actor, { module: 'inventory', action: kind + '.proposed', entity: 'stock_adjustment', entityId: r.insertId,
    new: { adjNo: no, kind: kind, direction: direction, bucket: bucket, qty: qty, productId: Number(product.id), warehouseId: wid, lotId: lotId, reasonCode: reasonCode }, reason: reason, approvalId: a.approvalId });
  return Object.assign({}, a, { adjustmentId: Number(r.insertId), adjNo: no });
}
approvals.register('inventory.adjustment', async function (tx, req, actor) {
  const d = await tx.queryOne('SELECT * FROM b2b_stock_adjustments WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!d || d.status !== 'proposed') throw fail(409, 'This adjustment is no longer proposed');
  const qty = Number(d.qty), key = 'adj:' + d.id;
  let batch = null;
  if (d.lot_id) {
    const lot = await tx.queryOne('SELECT * FROM b2b_lots WHERE id = ?', [d.lot_id]);
    batch = await ledger.batchFor(tx, d.warehouse_id, lot);
  }
  const base = { warehouseId: d.warehouse_id, productId: d.product_id, batchId: batch, lotId: d.lot_id, qty: qty, refType: 'stock_adjustment', refId: d.id, reason: d.reason_code + ': ' + d.reason, actor: actor, idemKey: key };
  if (d.direction === 'increase') {
    await ledger.mustMove(tx, Object.assign(base, { type: d.kind === 'opening' ? 'opening' : 'adjustment', to: d.bucket }));
    if (batch) await tx.query('UPDATE b2b_batches SET ' + (d.bucket === 'quarantine' ? 'qty_quarantine = qty_quarantine + ?' : "qty_on_hand = qty_on_hand + ?, status = 'active'") + ' WHERE id = ?', [qty, batch]);
  } else {
    const to = d.reason_code === 'damage' ? 'damaged' : (d.reason_code === 'expiry' ? 'expired' : null);
    await ledger.mustMove(tx, Object.assign(base, { type: to ? d.reason_code : 'adjustment', from: d.bucket, to: to }));
    if (batch && (d.bucket === 'available' || d.bucket === 'quarantine')) {
      const col = d.bucket === 'quarantine' ? 'qty_quarantine' : 'qty_on_hand';
      const u = await tx.query('UPDATE b2b_batches SET ' + col + ' = ' + col + ' - ? WHERE id = ? AND ' + col + ' >= ?', [qty, batch, qty]);
      if (!u.affectedRows) throw fail(409, 'That lot does not hold ' + qty + ' units in ' + d.bucket + ' at this warehouse any more', 'insufficient_stock');
    }
  }
  await tx.query("UPDATE b2b_stock_adjustments SET status = 'posted', posted_at = UTC_TIMESTAMP() WHERE id = ?", [d.id]);
  await audit.write(tx, actor, { module: 'inventory', action: d.kind + '.posted', entity: 'stock_adjustment', entityId: d.id, approvalId: req.id,
    new: { adjNo: d.adj_no, direction: d.direction, bucket: d.bucket, qty: qty } });
  return { adjustmentId: Number(d.id), status: 'posted' };
});
async function listAdjustments(principal, q) {
  const where = [], params = [];
  whFilter(principal, 'a.warehouse_id', where, params);
  if (q.status) { where.push('a.status = ?'); params.push(String(q.status)); }
  if (q.kind) { where.push('a.kind = ?'); params.push(String(q.kind)); }
  return db.query('SELECT a.id, a.adj_no, a.kind, a.direction, a.warehouse_id, w.name AS warehouse, a.product_id, p.sku, p.name AS product, a.lot_id, l.batch_no, a.bucket, a.qty, a.reason_code, a.reason, ' +
    'a.status, r.status AS approval_status, a.approval_id, a.created_at, a.posted_at FROM b2b_stock_adjustments a JOIN b2b_warehouses w ON w.id = a.warehouse_id JOIN b2b_products p ON p.id = a.product_id ' +
    'LEFT JOIN b2b_lots l ON l.id = a.lot_id LEFT JOIN b2b_approval_requests r ON r.id = a.approval_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY a.id DESC LIMIT 200', params);
}

// ── stock counts ──
async function openCount(tx, actor, principal, b) {
  const wid = posId(b.warehouseId); assertWh(principal, wid);
  need(await tx.queryOne('SELECT id FROM b2b_warehouses WHERE id = ?', [wid]), 'Unknown warehouse');
  const type = ['cycle', 'full', 'spot'].indexOf(b.countType) === -1 ? 'cycle' : b.countType;
  const no = await seq.next(tx, 'CNT');
  const r = await tx.query("INSERT INTO b2b_stock_counts (count_no, warehouse_id, count_type, status, created_by) VALUES (?, ?, ?, 'open', ?)", [no, wid, type, actor.id]);
  const where = ['b.warehouse_id = ?', 'b.lot_id IS NOT NULL'], params = [wid];
  if (Array.isArray(b.productIds) && b.productIds.length) { const ids = b.productIds.map(posId).filter(Boolean); where.push('b.product_id IN (' + db.placeholders(ids) + ')'); params.push.apply(params, ids); }
  const batches = await tx.query('SELECT b.lot_id, b.qty_on_hand, b.qty_quarantine FROM b2b_batches b WHERE ' + where.join(' AND ') + ' LIMIT 5000', params);
  for (const bt of batches) {
    await tx.query("INSERT INTO b2b_stock_count_items (count_id, lot_id, bucket, system_qty) VALUES (?, ?, 'available', ?)", [r.insertId, bt.lot_id, bt.qty_on_hand]);
    if (Number(bt.qty_quarantine)) await tx.query("INSERT INTO b2b_stock_count_items (count_id, lot_id, bucket, system_qty) VALUES (?, ?, 'quarantine', ?)", [r.insertId, bt.lot_id, bt.qty_quarantine]);
  }
  await audit.write(tx, actor, { module: 'inventory', action: 'count.opened', entity: 'stock_count', entityId: r.insertId, new: { countNo: no, warehouseId: wid, lines: batches.length } });
  return { countId: Number(r.insertId), countNo: no, lines: batches.length };
}
async function recordCount(tx, actor, principal, id, b) {
  const c = await tx.queryOne('SELECT * FROM b2b_stock_counts WHERE id = ? FOR UPDATE', [id]);
  if (!c) throw fail(404, 'Count not found');
  assertWh(principal, c.warehouse_id);
  if (['open', 'counted'].indexOf(c.status) === -1) throw fail(409, 'Count is ' + c.status);
  for (const it of (b.items || [])) {
    const q = Number(it.countedQty); need(Number.isInteger(q) && q >= 0, 'countedQty must be a whole number');
    const r = await tx.query('UPDATE b2b_stock_count_items SET counted_qty = ?, counted_by = ?, counted_at = UTC_TIMESTAMP() WHERE count_id = ? AND lot_id = ? AND bucket = ?',
      [q, actor.id, id, posId(it.lotId), it.bucket || 'available']);
    need(r.affectedRows === 1, 'Lot ' + it.lotId + ' is not on this count sheet');
  }
  await tx.query("UPDATE b2b_stock_counts SET status = 'counted' WHERE id = ?", [id]);
  return { countId: id, status: 'counted' };
}
async function submitCount(tx, actor, principal, id, reason) {
  const c = await tx.queryOne('SELECT * FROM b2b_stock_counts WHERE id = ? FOR UPDATE', [id]);
  if (!c) throw fail(404, 'Count not found');
  assertWh(principal, c.warehouse_id);
  if (c.status !== 'counted') throw fail(409, 'Record the counted quantities first');
  const missing = await tx.queryOne('SELECT COUNT(*) AS n FROM b2b_stock_count_items WHERE count_id = ? AND counted_qty IS NULL', [id]);
  need(!Number(missing.n), Number(missing.n) + ' line(s) not counted yet');
  const diff = await tx.query('SELECT lot_id, bucket, system_qty, counted_qty FROM b2b_stock_count_items WHERE count_id = ? AND counted_qty <> system_qty', [id]);
  if (!diff.length) {
    await tx.query("UPDATE b2b_stock_counts SET status = 'posted', posted_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
    await audit.write(tx, actor, { module: 'inventory', action: 'count.posted', entity: 'stock_count', entityId: id, new: { variances: 0 } });
    return { countId: id, status: 'posted', variances: 0 };
  }
  // A person who counted cannot approve their own adjustment (the approval engine enforces maker ≠ checker).
  const a = await approvals.request(tx, actor, { type: 'inventory.count_adjust', entity: 'stock_count', entityId: id, reason: reason || 'Stock count variance', payload: { variances: diff.length } });
  await tx.query("UPDATE b2b_stock_counts SET status = 'pending_approval', approval_id = ? WHERE id = ?", [a.approvalId, id]);
  return Object.assign({}, a, { countId: id, status: 'pending_approval', variances: diff });
}
approvals.register('inventory.count_adjust', async function (tx, req, actor) {
  const c = await tx.queryOne('SELECT * FROM b2b_stock_counts WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!c || c.status !== 'pending_approval') throw fail(409, 'Count is no longer awaiting approval');
  const diff = await tx.query('SELECT ci.*, l.product_id FROM b2b_stock_count_items ci JOIN b2b_lots l ON l.id = ci.lot_id WHERE ci.count_id = ? AND ci.counted_qty <> ci.system_qty ORDER BY l.product_id', [c.id]);
  for (const d of diff) {
    const b = await tx.queryOne('SELECT id, qty_on_hand, qty_quarantine FROM b2b_batches WHERE warehouse_id = ? AND lot_id = ? FOR UPDATE', [c.warehouse_id, d.lot_id]);
    const col = d.bucket === 'quarantine' ? 'qty_quarantine' : 'qty_on_hand';
    const now = Number(b[col]);
    if (now !== Number(d.system_qty)) throw fail(409, 'Stock of lot ' + d.lot_id + ' changed since the count was opened; recount it', 'stale_count');
    const delta = Number(d.counted_qty) - Number(d.system_qty);
    const bucket = d.bucket === 'quarantine' ? 'quarantine' : 'available';
    if (delta > 0) await ledger.mustMove(tx, { warehouseId: c.warehouse_id, productId: d.product_id, batchId: b.id, lotId: d.lot_id, type: 'adjustment', qty: delta, to: bucket, refType: 'stock_count', refId: c.id, reason: 'count gain', actor: actor });
    else await ledger.mustMove(tx, { warehouseId: c.warehouse_id, productId: d.product_id, batchId: b.id, lotId: d.lot_id, type: 'adjustment', qty: -delta, from: bucket, refType: 'stock_count', refId: c.id, reason: 'count loss', actor: actor });
    await tx.query('UPDATE b2b_batches SET ' + col + ' = ? WHERE id = ?', [d.counted_qty, b.id]);
  }
  await tx.query("UPDATE b2b_stock_counts SET status = 'posted', posted_at = UTC_TIMESTAMP() WHERE id = ?", [c.id]);
  await audit.write(tx, actor, { module: 'inventory', action: 'count.posted', entity: 'stock_count', entityId: c.id, approvalId: req.id, new: { variances: diff.length } });
  return { countId: Number(c.id), status: 'posted', adjusted: diff.length };
});

/**
 * Reconciliation (read-only): for each warehouse + product,
 *   1. balance = sum of ledger movements into/out of each bucket (from the first movement on)
 *   2. batches = sum of batch quantities vs available (+allocated pick) and quarantine
 * Differences are reported, never auto-corrected.
 */
async function reconciliation(principal, q) {
  const where = ['1=1'], params = [];
  whFilter(principal, 'st.warehouse_id', where, params);
  if (q.warehouseId) { where.push('st.warehouse_id = ?'); params.push(posId(q.warehouseId)); }
  const rows = await db.query('SELECT st.warehouse_id, st.product_id, st.qty_available, st.qty_reserved, st.qty_allocated, st.qty_in_transit, st.qty_quarantine, st.qty_damaged, st.qty_expired, ' +
    '(SELECT COALESCE(SUM(b.qty_on_hand), 0) FROM b2b_batches b WHERE b.warehouse_id = st.warehouse_id AND b.product_id = st.product_id) AS batch_on_hand, ' +
    '(SELECT COALESCE(SUM(b.qty_quarantine), 0) FROM b2b_batches b WHERE b.warehouse_id = st.warehouse_id AND b.product_id = st.product_id) AS batch_quarantine, ' +
    '(SELECT COUNT(*) FROM b2b_batches b WHERE b.warehouse_id = st.warehouse_id AND b.product_id = st.product_id) AS batch_rows ' +
    'FROM b2b_stock st WHERE ' + where.join(' AND ') + ' LIMIT 5000', params);
  const issues = [];
  for (const r of rows) {
    const mv = await db.query('SELECT from_status, to_status, SUM(qty) AS q FROM b2b_stock_movements WHERE warehouse_id = ? AND product_id = ? GROUP BY from_status, to_status', [r.warehouse_id, r.product_id]);
    const bal = { available: 0, reserved: 0, allocated: 0, in_transit: 0, quarantine: 0, damaged: 0, expired: 0 };
    mv.forEach(function (m) { if (m.to_status && bal[m.to_status] != null) bal[m.to_status] += Number(m.q); if (m.from_status && bal[m.from_status] != null) bal[m.from_status] -= Number(m.q); });
    const diffs = {};
    Object.keys(bal).forEach(function (k) { if (bal[k] !== Number(r['qty_' + k])) diffs[k] = { ledger: bal[k], balance: Number(r['qty_' + k]) }; });
    // batches hold available + reserved stock (picking moves units out of the batch at packing)
    if (Number(r.batch_rows) && Number(r.batch_on_hand) !== Number(r.qty_available) + Number(r.qty_reserved)) diffs.batches = { batchOnHand: Number(r.batch_on_hand), availablePlusReserved: Number(r.qty_available) + Number(r.qty_reserved) };
    if (Number(r.batch_quarantine) !== Number(r.qty_quarantine)) diffs.batchQuarantine = { batches: Number(r.batch_quarantine), balance: Number(r.qty_quarantine) };
    if (Object.keys(diffs).length) issues.push({ warehouseId: Number(r.warehouse_id), productId: Number(r.product_id), differences: diffs });
  }
  return { checked: rows.length, issues: issues, ok: !issues.length,
    note: 'Stock received without batch details, or entered before the ledger existed, can show as a batch difference. B2C stock is not part of this check.' };
}

module.exports = { stock, listLots, trace, createTransfer, dispatchTransfer, receiveTransfer, proposeDisposition, proposeAdjustment, listAdjustments, openCount, recordCount, submitCount, reconciliation, assertWh, scopeIds };
