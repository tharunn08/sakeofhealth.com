/**
 * Phase 9: lot-aware return inspection and product recalls.
 *
 * Inspection (company-supplied orders): each returned line is tied to a lot that was
 * actually shipped on that order; accepted units go to QUARANTINE (never straight back
 * to saleable stock) and a disposition decides what happens next. The return then
 * continues in the existing B2B flow (complete → credit note).
 *
 * Recalls: activation blocks the lots at once (lot status 'recalled'; company stock
 * moved to quarantine; packed-but-not-dispatched orders put on hold) and lists every
 * customer the lots were shipped to. Closing needs every party resolved and a second
 * person's approval.
 *
 * Limit: units a distributor resold from its own stock are not lot-tracked unless the
 * distributor recorded batches; those retailers cannot be listed automatically.
 */
'use strict';
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const notifications = require('../../b2b/notifications/service.js');
const orders = require('../../b2b/orders/service.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const seq = require('../lib/seq.js');
const ledger = require('../inventory/ledger.js');
const inv = require('../inventory/service.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }
const CONDITIONS = ['good', 'damaged', 'expired', 'near_expiry', 'wrong_item', 'tampered'];

async function inspect(tx, actor, principal, returnId, b) {
  const r = await tx.queryOne('SELECT * FROM b2b_returns WHERE id = ? FOR UPDATE', [returnId]);
  if (!r) throw fail(404, 'Return not found');
  if (['approved', 'pickup_scheduled'].indexOf(r.status) === -1) throw fail(409, 'Only an approved return can be inspected (status: ' + r.status + ')');
  const order = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [r.order_id]);
  if (order.seller_type !== 'company' || !Number(order.stock_reserved) || !order.warehouse_id) throw fail(409, 'Lot-level inspection is for company-supplied orders; use the distributor\'s return screen for this one', 'not_company_order');
  inv.assertWh(principal, order.warehouse_id);
  const lines = await tx.query('SELECT ri.*, oi.product_id, oi.sku FROM b2b_return_items ri JOIN b2b_order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = ?', [returnId]);
  const input = {}; (Array.isArray(b.items) ? b.items : []).forEach(function (i) { input[posId(i.returnItemId)] = i; });
  need(Object.keys(input).length === lines.length, 'Inspect every returned line');
  const out = [];
  for (const l of lines) {
    const g = input[l.id];
    const cond = CONDITIONS.indexOf(g.condition) === -1 ? null : g.condition; need(cond, 'condition must be one of ' + CONDITIONS.join(', '));
    const acc = Number(g.qtyAccepted); need(Number.isInteger(acc) && acc >= 0 && acc <= Number(l.qty), 'qtyAccepted for ' + l.sku + ' must be 0–' + l.qty);
    let lotId = posId(g.lotId) || null;
    if (acc > 0) {
      need(lotId, 'Give the batch (lotId) printed on the returned units for ' + l.sku, 'lot_required');
      // the lot must have been shipped on THIS order line — stops returns of goods we never sold them
      const shipped = await tx.queryOne('SELECT COALESCE(SUM(al.qty), 0) AS q FROM b2b_order_item_allocations al JOIN b2b_batches bt ON bt.id = al.batch_id WHERE al.order_item_id = ? AND bt.lot_id = ?', [l.order_item_id, lotId]);
      need(Number(shipped.q) >= acc, 'Batch ' + lotId + ' was not shipped on this order (or not that many units)', 'lot_not_on_order');
    }
    if (cond !== 'good' || g.note) need(g.note && String(g.note).trim().length >= 3, 'Describe the condition (note) for ' + l.sku);
    await tx.query('UPDATE b2b_return_items SET qty_accepted = ?, item_condition = ?, lot_id = ?, inspection_note = ?, photos_json = ?, inspected_by = ?, inspected_at = UTC_TIMESTAMP() WHERE id = ?',
      [acc, cond, lotId, v.text(g.note, 500) || null, Array.isArray(g.photos) ? JSON.stringify(g.photos.slice(0, 10)).slice(0, 2000) : null, actor.id, l.id]);
    if (acc > 0) {
      await tx.query('UPDATE b2b_order_items SET qty_returned = qty_returned + ? WHERE id = ?', [acc, l.order_item_id]);
      const lot = await tx.queryOne('SELECT * FROM b2b_lots WHERE id = ?', [lotId]);
      const batchId = await ledger.batchFor(tx, order.warehouse_id, lot);
      await ledger.mustMove(tx, { warehouseId: order.warehouse_id, productId: l.product_id, batchId: batchId, lotId: lotId, type: 'return', qty: acc, to: 'quarantine', refType: 'return', refId: returnId, reason: 'customer return (' + cond + ')', actor: actor });
      await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine + ? WHERE id = ?', [acc, batchId]);
      await tx.query("INSERT INTO b2b_quality_inspections (ref_type, ref_id, result, note, inspected_by, inspected_at) VALUES ('return_item', ?, ?, ?, ?, UTC_TIMESTAMP())",
        [l.id, cond === 'good' ? 'pass' : 'fail', v.text(g.note, 500) || null, actor.id]);
      // a returned unit of a recalled lot is counted against the recall
      if (lot.status === 'recalled') await recallReceiptFromReturn(tx, actor, lot, r, order, acc);
    }
    out.push({ returnItemId: Number(l.id), accepted: acc, condition: cond, lotId: lotId, to: acc ? 'quarantine' : null });
  }
  await tx.query("UPDATE b2b_returns SET status = 'received', inspection_note = ? WHERE id = ?", [v.text(b.note, 500) || null, returnId]);
  await audit.write(tx, actor, { module: 'returns', action: 'return.inspected', entity: 'return', entityId: returnId, old: { status: r.status }, new: { lines: out } });
  return { returnId: returnId, status: 'received', lines: out, next: 'Complete the return (credit note) in the B2B screen; decide each quarantined batch with a disposition.' };
}

async function recallReceiptFromReturn(tx, actor, lot, ret, order, qty) {
  const party = await tx.queryOne("SELECT rp.* FROM b2b_recall_parties rp JOIN b2b_recalls rc ON rc.id = rp.recall_id WHERE rp.lot_id = ? AND rp.account_id = ? AND rc.status IN ('active','collecting','reconciling') FOR UPDATE", [lot.id, order.buyer_account_id]);
  if (!party) return;
  await tx.query('INSERT INTO b2b_recall_receipts (recall_party_id, warehouse_id, qty, return_id, received_by, received_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())', [party.id, order.warehouse_id, qty, ret.id, actor.id]);
  await tx.query("UPDATE b2b_recall_parties SET qty_returned = qty_returned + ?, status = IF(qty_returned + ? + qty_declared_sold >= qty_supplied, 'complete', 'collecting') WHERE id = ?", [qty, qty, party.id]);
  await tx.query('UPDATE b2b_recall_lots SET qty_returned = qty_returned + ? WHERE recall_id = ? AND lot_id = ?', [qty, party.recall_id, lot.id]);
}

// ── recalls ──
async function createRecall(tx, actor, b) {
  const by = ['manufacturer', 'company', 'regulator'].indexOf(b.initiatedBy) === -1 ? null : b.initiatedBy; need(by, 'initiatedBy must be manufacturer, company or regulator');
  const sev = ['class_1', 'class_2', 'class_3', 'precautionary'].indexOf(b.severity) === -1 ? null : b.severity; need(sev, 'severity must be class_1, class_2, class_3 or precautionary');
  const reason = v.text(b.reason, 500); need(reason.length >= 10, 'Describe the reason (10+ characters)');
  const ids = Array.from(new Set((b.lotIds || []).map(posId).filter(Boolean))); need(ids.length && ids.length <= 200, 'Choose 1–200 lots');
  const lots = await tx.query('SELECT id, status, manufacturer_vendor_id FROM b2b_lots WHERE id IN (' + db.placeholders(ids) + ')', ids);
  need(lots.length === ids.length, 'Unknown lot');
  const no = await seq.next(tx, 'RCL');
  const r = await tx.query("INSERT INTO b2b_recalls (recall_no, initiated_by_party, manufacturer_vendor_id, severity, reason, scope, status, evidence_json, created_by) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
    [no, by, posId(b.manufacturerVendorId) || lots[0].manufacturer_vendor_id, sev, reason, b.scope === 'partial' ? 'partial' : 'full', b.evidence ? JSON.stringify(b.evidence).slice(0, 5000) : null, actor.id]);
  for (const id of ids) await tx.query('INSERT INTO b2b_recall_lots (recall_id, lot_id, qty_received_total, qty_in_company_stock, qty_shipped_out, qty_returned, qty_written_off) VALUES (?, ?, 0, 0, 0, 0, 0)', [r.insertId, id]);
  await audit.write(tx, actor, { module: 'recalls', action: 'recall.created', entity: 'recall', entityId: r.insertId, new: { recallNo: no, severity: sev, lots: ids }, reason: reason });
  return { recallId: Number(r.insertId), recallNo: no, status: 'draft' };
}

async function activate(tx, actor, id) {
  const rc = await tx.queryOne('SELECT * FROM b2b_recalls WHERE id = ? FOR UPDATE', [id]);
  if (!rc) throw fail(404, 'Recall not found');
  if (rc.status !== 'draft') throw fail(409, 'Recall is ' + rc.status);
  const lots = await tx.query('SELECT l.* FROM b2b_recall_lots rl JOIN b2b_lots l ON l.id = rl.lot_id WHERE rl.recall_id = ? ORDER BY l.product_id FOR UPDATE', [id]);
  const held = [], onHold = [], parties = {};
  for (const lot of lots) {
    await tx.query("UPDATE b2b_lots SET status = 'recalled', hold_reason = ? WHERE id = ?", ['Recall ' + rc.recall_no, lot.id]);
    // 1. company stock of the lot → quarantine
    const batches = await tx.query('SELECT b.* FROM b2b_batches b JOIN b2b_warehouses w ON w.id = b.warehouse_id WHERE b.lot_id = ? AND w.owner_account_id IS NULL FOR UPDATE', [lot.id]);
    let inStock = 0;
    for (const bt of batches) {
      const q = Number(bt.qty_on_hand);
      if (q > 0) {
        // Units on the shelf may already be promised to orders (reserved). Move what is truly available;
        // the rest is caught when packing (recalled batches are no longer pickable) — reported below.
        const st = await tx.queryOne('SELECT qty_available FROM b2b_stock WHERE warehouse_id = ? AND product_id = ? FOR UPDATE', [bt.warehouse_id, lot.product_id]);
        const movable = Math.min(q, Number(st ? st.qty_available : 0));
        if (movable > 0) {
          await ledger.mustMove(tx, { warehouseId: bt.warehouse_id, productId: lot.product_id, batchId: bt.id, lotId: lot.id, type: 'recall_hold', qty: movable, from: 'available', to: 'quarantine', refType: 'recall', refId: id, actor: actor });
          await tx.query('UPDATE b2b_batches SET qty_on_hand = qty_on_hand - ?, qty_quarantine = qty_quarantine + ? WHERE id = ?', [movable, movable, bt.id]);
        }
        if (movable < q) {
          // The rest is promised to open orders of this product here: hold those orders so nobody packs them blindly.
          const at = await tx.query("SELECT id FROM b2b_orders o WHERE o.warehouse_id = ? AND o.status IN ('approved','assigned','accepted','processing','pending_admin_approval') " +
            'AND EXISTS (SELECT 1 FROM b2b_order_items i WHERE i.order_id = o.id AND i.product_id = ?) FOR UPDATE', [bt.warehouse_id, lot.product_id]);
          for (const o of at) { await tx.query('UPDATE b2b_orders SET is_on_hold = 1, hold_reason = ? WHERE id = ?', ['Product under recall ' + rc.recall_no + ' — check the batch before packing', o.id]); onHold.push(Number(o.id)); }
          held.push({ lotId: Number(lot.id), warehouseId: Number(bt.warehouse_id), reservedForOrders: q - movable, ordersHeld: at.map(function (o) { return Number(o.id); }) });
        }
      }
      // Existing FEFO picking only takes 'active' batches: a recalled batch is never picked again.
      await tx.query("UPDATE b2b_batches SET status = 'expired' WHERE id = ?", [bt.id]);
      inStock += Number(bt.qty_on_hand) + Number(bt.qty_quarantine);
    }
    // 2. orders that already contain the lot
    const ords = await tx.query('SELECT o.id, o.status, o.buyer_account_id, SUM(al.qty) AS qty FROM b2b_order_item_allocations al JOIN b2b_batches b ON b.id = al.batch_id JOIN b2b_orders o ON o.id = al.order_id ' +
      'WHERE b.lot_id = ? GROUP BY o.id, o.status, o.buyer_account_id', [lot.id]);
    let shipped = 0;
    for (const o of ords) {
      if (['packed', 'processing', 'accepted'].indexOf(o.status) !== -1) {
        await tx.query('UPDATE b2b_orders SET is_on_hold = 1, hold_reason = ? WHERE id = ?', ['Contains recalled batch (' + rc.recall_no + ')', o.id]);
        onHold.push(Number(o.id));
      } else if (['dispatched', 'out_for_delivery', 'delivered', 'partially_delivered'].indexOf(o.status) !== -1) {
        const k = lot.id + ':' + o.buyer_account_id;
        parties[k] = parties[k] || { lotId: Number(lot.id), accountId: Number(o.buyer_account_id), qty: 0 };
        parties[k].qty += Number(o.qty); shipped += Number(o.qty);
      }
    }
    const rec = await tx.queryOne("SELECT COALESCE(SUM(gi.qty_accepted + gi.qty_quarantined), 0) AS q FROM b2b_grn_items gi JOIN b2b_grns g ON g.id = gi.grn_id AND g.status = 'posted' WHERE gi.lot_id = ?", [lot.id]);
    await tx.query('UPDATE b2b_recall_lots SET qty_received_total = ?, qty_in_company_stock = ?, qty_shipped_out = ? WHERE recall_id = ? AND lot_id = ?', [rec.q, inStock, shipped, id, lot.id]);
  }
  for (const p of Object.values(parties)) {
    // units of this lot the customer already sent back through an inspected return do not need recalling again
    const back = await tx.queryOne("SELECT COALESCE(SUM(ri.qty_accepted), 0) AS q FROM b2b_return_items ri JOIN b2b_returns r ON r.id = ri.return_id WHERE ri.lot_id = ? AND r.buyer_account_id = ? AND r.status IN ('received','completed')", [p.lotId, p.accountId]);
    p.qty -= Number(back.q);
    if (p.qty <= 0) continue;
    await tx.query("INSERT INTO b2b_recall_parties (recall_id, lot_id, account_id, qty_supplied, qty_returned, qty_declared_sold, status, notified_at) VALUES (?, ?, ?, ?, 0, 0, 'notified', UTC_TIMESTAMP())", [id, p.lotId, p.accountId, p.qty]);
    const lot = lots.find(function (l) { return Number(l.id) === p.lotId; });
    await notifications.notifyAccount(tx, p.accountId, { title: 'PRODUCT RECALL ' + rc.recall_no + ': stop selling batch ' + lot.batch_no,
      lines: ['Batch ' + lot.batch_no + ' is recalled: ' + rc.reason, 'Please stop selling it, keep the units aside and contact us to return them. You received ' + p.qty + ' unit(s).'],
      link: '/b2b/orders', refType: 'recall', refId: id });
  }
  await tx.query("UPDATE b2b_recalls SET status = 'active', started_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'recalls', action: 'recall.activated', entity: 'recall', entityId: id, new: { lots: lots.length, parties: Object.keys(parties).length, ordersOnHold: onHold, stockStillReserved: held } });
  return { recallId: id, status: 'active', lotsBlocked: lots.length, partiesNotified: Object.keys(parties).length, ordersOnHold: onHold, stockStillReserved: held };
}

async function reconciliation(id) {
  const rc = await db.queryOne('SELECT * FROM b2b_recalls WHERE id = ?', [id]);
  if (!rc) throw fail(404, 'Recall not found');
  const lots = await db.query('SELECT rl.*, l.batch_no, l.product_id, p.name FROM b2b_recall_lots rl JOIN b2b_lots l ON l.id = rl.lot_id JOIN b2b_products p ON p.id = l.product_id WHERE rl.recall_id = ?', [id]);
  const parties = await db.query('SELECT rp.*, a.business_name, a.mobile FROM b2b_recall_parties rp JOIN b2b_accounts a ON a.id = rp.account_id WHERE rp.recall_id = ? ORDER BY rp.status, a.business_name', [id]);
  const now = await db.query('SELECT b.lot_id, SUM(b.qty_on_hand) AS on_hand, SUM(b.qty_quarantine) AS quarantine FROM b2b_batches b JOIN b2b_recall_lots rl ON rl.lot_id = b.lot_id WHERE rl.recall_id = ? GROUP BY b.lot_id', [id]);
  const out = lots.map(function (l) {
    const n = now.find(function (x) { return Number(x.lot_id) === Number(l.lot_id); }) || { on_hand: 0, quarantine: 0 };
    const accounted = Number(l.qty_in_company_stock) + Number(l.qty_shipped_out);
    return Object.assign({}, l, { onHandNow: Number(n.on_hand), quarantineNow: Number(n.quarantine), unaccounted: Number(l.qty_received_total) - accounted,
      outstandingAtCustomers: parties.filter(function (p) { return Number(p.lot_id) === Number(l.lot_id); }).reduce(function (s, p) { return s + Math.max(0, Number(p.qty_supplied) - Number(p.qty_returned) - Number(p.qty_declared_sold)); }, 0) });
  });
  const open = parties.filter(function (p) { return ['complete', 'unreachable'].indexOf(p.status) === -1; });
  return { recall: rc, lots: out, parties: parties, readyToClose: !open.length && out.every(function (l) { return Number(l.onHandNow) === 0; }),
    blockers: [].concat(open.length ? [open.length + ' customer(s) not resolved'] : [], out.filter(function (l) { return Number(l.onHandNow) > 0; }).map(function (l) { return 'Batch ' + l.batch_no + ' still has ' + l.onHandNow + ' saleable unit(s)'; })) };
}

async function updateParty(tx, actor, recallId, partyId, b) {
  const p = await tx.queryOne('SELECT rp.* FROM b2b_recall_parties rp JOIN b2b_recalls rc ON rc.id = rp.recall_id WHERE rp.id = ? AND rp.recall_id = ? AND rc.status IN (\'active\',\'collecting\',\'reconciling\') FOR UPDATE', [partyId, recallId]);
  if (!p) throw fail(404, 'Not found');
  const status = ['acknowledged', 'collecting', 'unreachable', 'complete'].indexOf(b.status) === -1 ? null : b.status; need(status, 'status must be acknowledged, collecting, unreachable or complete');
  const sold = b.qtyDeclaredSold == null ? Number(p.qty_declared_sold) : Number(b.qtyDeclaredSold);
  need(Number.isInteger(sold) && sold >= 0 && sold + Number(p.qty_returned) <= Number(p.qty_supplied), 'Declared sold + returned cannot exceed what was supplied');
  if (status === 'complete') need(sold + Number(p.qty_returned) === Number(p.qty_supplied), 'Complete only when every supplied unit is returned or declared sold', 'not_balanced');
  need(b.note && String(b.note).trim().length >= 3, 'Add a note (who you spoke to, when)');
  await tx.query('UPDATE b2b_recall_parties SET status = ?, qty_declared_sold = ?, acknowledged_at = COALESCE(acknowledged_at, IF(? IN (\'acknowledged\',\'collecting\',\'complete\'), UTC_TIMESTAMP(), NULL)) WHERE id = ?', [status, sold, status, partyId]);
  await tx.query("UPDATE b2b_recalls SET status = 'collecting' WHERE id = ? AND status = 'active'", [recallId]);
  await audit.write(tx, actor, { module: 'recalls', action: 'recall.party_' + status, entity: 'recall', entityId: recallId, new: { partyId: partyId, declaredSold: sold }, reason: b.note });
  return { partyId: partyId, status: status };
}

/** Units brought back outside the returns flow (field collection). They go to quarantine at the warehouse. */
async function receive(tx, actor, principal, recallId, b) {
  const p = await tx.queryOne("SELECT rp.*, l.product_id, l.batch_no, l.mfg_date, l.expiry_date FROM b2b_recall_parties rp JOIN b2b_lots l ON l.id = rp.lot_id JOIN b2b_recalls rc ON rc.id = rp.recall_id " +
    "WHERE rp.id = ? AND rp.recall_id = ? AND rc.status IN ('active','collecting','reconciling') FOR UPDATE", [posId(b.partyId), recallId]);
  if (!p) throw fail(404, 'Not found');
  const wid = posId(b.warehouseId); inv.assertWh(principal, wid);
  const q = Number(b.qty); need(Number.isInteger(q) && q > 0, 'qty must be a positive whole number');
  need(q + Number(p.qty_returned) + Number(p.qty_declared_sold) <= Number(p.qty_supplied), 'More than this customer was supplied', 'over_return');
  const batchId = await ledger.batchFor(tx, wid, { id: p.lot_id, product_id: p.product_id, batch_no: p.batch_no, mfg_date: p.mfg_date, expiry_date: p.expiry_date });
  await ledger.mustMove(tx, { warehouseId: wid, productId: p.product_id, batchId: batchId, lotId: p.lot_id, type: 'return', qty: q, to: 'quarantine', refType: 'recall', refId: recallId, reason: 'recall collection', actor: actor });
  await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine + ? WHERE id = ?', [q, batchId]);
  await tx.query('INSERT INTO b2b_recall_receipts (recall_party_id, warehouse_id, qty, received_by, received_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [p.id, wid, q, actor.id]);
  await tx.query("UPDATE b2b_recall_parties SET qty_returned = qty_returned + ?, status = IF(qty_returned + qty_declared_sold >= qty_supplied, 'complete', 'collecting') WHERE id = ?", [q, p.id]);
  await tx.query('UPDATE b2b_recall_lots SET qty_returned = qty_returned + ? WHERE recall_id = ? AND lot_id = ?', [q, recallId, p.lot_id]);
  await tx.query("UPDATE b2b_recalls SET status = 'collecting' WHERE id = ? AND status = 'active'", [recallId]);
  await audit.write(tx, actor, { module: 'recalls', action: 'recall.units_received', entity: 'recall', entityId: recallId, new: { partyId: Number(p.id), qty: q, warehouseId: wid } });
  return { received: q };
}

async function requestClose(tx, actor, id, reason) {
  const rc = await tx.queryOne('SELECT * FROM b2b_recalls WHERE id = ? FOR UPDATE', [id]);
  if (!rc) throw fail(404, 'Recall not found');
  if (['active', 'collecting', 'reconciling'].indexOf(rc.status) === -1) throw fail(409, 'Recall is ' + rc.status);
  const rec = await reconciliation(id);
  if (!rec.readyToClose) throw fail(409, 'Cannot close yet: ' + rec.blockers.join('; '), 'not_reconciled', { blockers: rec.blockers });
  need(reason && String(reason).trim().length >= 10, 'Closure summary is required (10+ characters)');
  const a = await approvals.request(tx, actor, { type: 'recalls.close', entity: 'recall', entityId: id, reason: reason, payload: { recallNo: rc.recall_no } });
  await tx.query("UPDATE b2b_recalls SET status = 'pending_closure', closure_approval_id = ? WHERE id = ?", [a.approvalId, id]);
  return a;
}
approvals.register('recalls.close', async function (tx, req, actor) {
  const rc = await tx.queryOne('SELECT * FROM b2b_recalls WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!rc || rc.status !== 'pending_closure') throw fail(409, 'Recall is no longer awaiting closure');
  await tx.query("UPDATE b2b_recalls SET status = 'closed', closed_at = UTC_TIMESTAMP() WHERE id = ?", [rc.id]);
  await audit.write(tx, actor, { module: 'recalls', action: 'recall.closed', entity: 'recall', entityId: rc.id, approvalId: req.id });
  return { recallId: Number(rc.id), status: 'closed', note: 'Recalled lots stay blocked; quarantined units are disposed through dispositions.' };
});

async function list() {
  return { items: await db.query('SELECT r.id, r.recall_no, r.severity, r.status, r.reason, r.started_at, r.closed_at, (SELECT COUNT(*) FROM b2b_recall_lots x WHERE x.recall_id = r.id) AS lots, ' +
    "(SELECT COUNT(*) FROM b2b_recall_parties p WHERE p.recall_id = r.id AND p.status NOT IN ('complete','unreachable')) AS open_parties FROM b2b_recalls r ORDER BY r.id DESC LIMIT 200") };
}

module.exports = { inspect, createRecall, activate, reconciliation, updateParty, receive, requestClose, list };
