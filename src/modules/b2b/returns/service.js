/**
 * Returns: request → approval → pickup → inspection → resolution
 * (credit note / refund / replacement).
 *
 * Money and stock only move at two points: inspection (accepted units go
 * back into stock by condition) and completion (a credit note is issued and
 * settled against what the buyer owes).
 */
const db = require('../../../db/connection.js');
const money = require('../lib/money.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const settings = require('../lib/settings.js');
const inventory = require('../inventory/service.js');
const invoices = require('../invoices/service.js');
const notifications = require('../notifications/service.js');
const { bad, notFound, like } = require('../lib/http.js');

const FLOW = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['pickup_scheduled', 'received', 'cancelled'],
  pickup_scheduled: ['received', 'cancelled'],
  received: ['completed'],
  rejected: [], completed: [], cancelled: [],
};
const OPEN = ['requested', 'approved', 'pickup_scheduled', 'received'];

function scopeWhere(scope, where, params) {
  if (scope.buyerAccountId != null) { where.push('r.buyer_account_id = ?'); params.push(scope.buyerAccountId); }
  if (scope.sellerAccountId != null) { where.push("r.seller_type = 'distributor' AND r.seller_account_id = ?"); params.push(scope.sellerAccountId); }
}

async function lockReturn(tx, id, scope) {
  const where = ['r.id = ?'], params = [id];
  scopeWhere(scope, where, params);
  const r = await tx.queryOne('SELECT r.* FROM b2b_returns r WHERE ' + where.join(' AND ') + ' FOR UPDATE', params);
  if (!r) throw notFound('Return not found');
  return r;
}

/** Buyer raises a return against a delivered order. */
async function create(account, orderId, body, actor) {
  const reason = v.text(body.reason, 500);
  if (reason.length < 5) throw bad('Please describe the reason for the return');
  const wanted = (Array.isArray(body.items) ? body.items : []).map(function (i) { return { id: Number(i.order_item_id), qty: Number(i.qty) }; })
    .filter(function (i) { return Number.isInteger(i.id) && Number.isInteger(i.qty) && i.qty > 0; });
  if (!wanted.length) throw bad('Choose at least one item and quantity to return');
  const windowDays = Number(await settings.get('returns.window_days')) || 0;
  return db.transaction(async function (tx) {
    const order = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? AND buyer_account_id = ? FOR UPDATE', [orderId, account.id]);
    if (!order) throw notFound('Order not found');
    if (['delivered', 'partially_delivered'].indexOf(order.status) === -1) throw bad('Only delivered orders can be returned');
    if (windowDays > 0 && order.delivered_at && Date.now() - new Date(order.delivered_at).getTime() > windowDays * 86400000) {
      throw bad('The ' + windowDays + '-day return window for this order has closed');
    }
    const items = await tx.query('SELECT * FROM b2b_order_items WHERE order_id = ?', [orderId]);
    const pending = await tx.query(
      'SELECT ri.order_item_id, SUM(ri.qty) AS qty FROM b2b_return_items ri JOIN b2b_returns r ON r.id = ri.return_id ' +
      'WHERE r.order_id = ? AND r.status IN (' + db.placeholders(OPEN) + ') GROUP BY ri.order_item_id', [orderId].concat(OPEN));
    const inFlight = {}; pending.forEach(function (p) { inFlight[p.order_item_id] = Number(p.qty); });
    const rows = wanted.map(function (w) {
      const it = items.find(function (i) { return Number(i.id) === w.id; });
      if (!it) throw bad('Order line not found');
      const delivered = it.qty_delivered == null ? Number(it.qty) : Number(it.qty_delivered);
      const max = delivered - Number(it.qty_returned) - (inFlight[it.id] || 0);
      if (w.qty > max) throw bad('You can return at most ' + Math.max(0, max) + ' of ' + it.sku);
      return [w.id, w.qty];
    });
    const res = await tx.query(
      "INSERT INTO b2b_returns (order_id, buyer_account_id, seller_type, seller_account_id, status, reason) VALUES (?, ?, ?, ?, 'requested', ?)",
      [orderId, account.id, order.seller_type, order.seller_account_id, reason]);
    const returnNo = 'RET-' + String(res.insertId).padStart(6, '0');
    await tx.query('UPDATE b2b_returns SET return_no = ? WHERE id = ?', [returnNo, res.insertId]);
    await tx.bulk('INSERT INTO b2b_return_items (return_id, order_item_id, qty) VALUES ?', rows.map(function (r) { return [res.insertId, r[0], r[1]]; }));
    await audit.log(tx, actor, 'return.requested', 'return', res.insertId, null, { return_no: returnNo, order_no: order.order_no, reason: reason, lines: rows.length });
    const msg = { title: 'Return requested for order ' + order.order_no, lines: [order.ship_name + ': ' + reason], refType: 'return', refId: res.insertId };
    if (order.seller_type === 'distributor') await notifications.notifyAccount(tx, order.seller_account_id, Object.assign({ link: '/b2b/returns' }, msg));
    else await notifications.notifyAdmins(tx, Object.assign({ link: '/admin/b2b/orders.html?tab=returns' }, msg));
    return { id: res.insertId, return_no: returnNo };
  });
}

/** approve | reject | schedule_pickup | cancel */
async function act(returnId, action, body, scope, actor) {
  const target = { approve: 'approved', reject: 'rejected', schedule_pickup: 'pickup_scheduled', cancel: 'cancelled' }[action];
  if (!target) throw bad('Unknown action');
  const note = v.text(body && body.note, 500);
  if (action === 'reject' && note.length < 3) throw bad('Please give a reason for rejecting the return');
  return db.transaction(async function (tx) {
    const r = await lockReturn(tx, returnId, scope);
    if (action === 'cancel' ? !(scope.buyerAccountId != null || scope.admin) : scope.buyerAccountId != null) throw bad('You cannot perform this action on the return');
    if ((FLOW[r.status] || []).indexOf(target) === -1) throw bad('A return that is ' + r.status.replace('_', ' ') + ' cannot be ' + target.replace('_', ' '));
    await tx.query('UPDATE b2b_returns SET status = ?' + (note ? ', inspection_note = ?' : '') + ' WHERE id = ?', note ? [target, note, returnId] : [target, returnId]);
    await audit.log(tx, actor, 'return.' + target, 'return', returnId, { status: r.status }, { status: target, note: note || null });
    const copy = { approved: 'approved', rejected: 'not approved', pickup_scheduled: 'scheduled for pickup', cancelled: 'cancelled' }[target];
    await notifications.notifyAccount(tx, r.buyer_account_id, { title: 'Return ' + r.return_no + ' ' + copy, lines: note ? [note] : [], link: '/b2b/returns', refType: 'return', refId: returnId });
    return { status: target };
  });
}

/** Goods received and inspected. items = [{ return_item_id, qty_accepted, condition }] */
async function inspect(returnId, body, scope, actor) {
  if (scope.buyerAccountId != null) throw bad('You cannot perform this action on the return');
  const note = v.text(body.note, 500);
  return db.transaction(async function (tx) {
    const r = await lockReturn(tx, returnId, scope);
    if ((FLOW[r.status] || []).indexOf('received') === -1) throw bad('This return cannot be received in its current state');
    const order = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [r.order_id]);
    const lines = await tx.query('SELECT ri.*, oi.product_id, oi.sku FROM b2b_return_items ri JOIN b2b_order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = ?', [returnId]);
    const input = {};
    (Array.isArray(body.items) ? body.items : []).forEach(function (i) { input[Number(i.return_item_id)] = i; });
    for (const l of lines) {
      const given = input[l.id] || {};
      const accepted = given.qty_accepted == null ? Number(l.qty) : Number(given.qty_accepted);
      const condition = ['good', 'damaged', 'expired'].indexOf(given.condition) !== -1 ? given.condition : 'good';
      if (!Number.isInteger(accepted) || accepted < 0 || accepted > Number(l.qty)) throw bad('Accepted quantity for ' + l.sku + ' must be between 0 and ' + l.qty);
      await tx.query('UPDATE b2b_return_items SET qty_accepted = ?, item_condition = ? WHERE id = ?', [accepted, condition, l.id]);
      if (accepted > 0) {
        await tx.query('UPDATE b2b_order_items SET qty_returned = qty_returned + ? WHERE id = ?', [accepted, l.order_item_id]);
        if (Number(order.stock_reserved) && order.warehouse_id) await inventory.receiveReturn(tx, order.warehouse_id, l.product_id, accepted, condition, returnId, actor);
        if (order.buyer_type === 'distributor') {
          // The units leave the distributor's own stock point (best effort — they may already have sold them on).
          const whs = await inventory.distributorWarehouses(order.buyer_account_id, tx);
          if (whs.length) {
            const moved = await inventory.move(tx, { warehouse_id: whs[0].id, product_id: l.product_id, type: 'transfer_out', qty: accepted, from: 'available',
              ref_type: 'return', ref_id: returnId, reason: 'returned to supplier', actor: actor });
            // Not silent any more (3b.1): when their books do not hold the units, the return still goes
            // through, and the gap is recorded for reconciliation instead of drifting unnoticed.
            if (!moved) await audit.log(tx, actor, 'return.distributor_stock_short', 'return', returnId, null,
              { warehouseId: whs[0].id, productId: l.product_id, qty: accepted, note: 'distributor stock did not hold these units; not deducted' });
          }
        }
      }
    }
    await tx.query("UPDATE b2b_returns SET status = 'received', inspection_note = ? WHERE id = ?", [note || null, returnId]);
    await audit.log(tx, actor, 'return.received', 'return', returnId, { status: r.status }, { status: 'received', note: note || null });
    return { status: 'received' };
  });
}

/** Close the return with a resolution. A credit note is raised for the accepted units. */
async function complete(returnId, body, scope, actor) {
  if (scope.buyerAccountId != null) throw bad('You cannot perform this action on the return');
  const resolution = String(body.resolution || '');
  if (['refund', 'replacement', 'credit_note'].indexOf(resolution) === -1) throw bad('Choose how the return is resolved');
  const orders = require('../orders/service.js');
  return db.transaction(async function (tx) {
    const r = await lockReturn(tx, returnId, scope);
    if (r.status !== 'received') throw bad('Inspect the returned goods before completing the return');
    const order = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [r.order_id]);
    const lines = await tx.query(
      'SELECT ri.qty_accepted, oi.* FROM b2b_return_items ri JOIN b2b_order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = ? AND ri.qty_accepted > 0', [returnId]);
    let result = { creditNoteNo: null, applied: '0.00', refund: '0.00' };
    let creditNoteId = null;
    if (lines.length) {
      const invoice = await invoices.liveInvoiceFor(order.id, tx);
      if (!invoice) throw bad('This order has no invoice to raise a credit note against');
      const cn = await invoices.createCreditNote(tx, invoice, lines.map(function (l) { return { item: l, qty: Number(l.qty_accepted) }; }),
        { reason: 'Return ' + r.return_no + ': ' + r.reason, returnId: returnId, actor: actor });
      const s = await orders.settleCreditNote(tx, order, cn, actor);
      creditNoteId = cn.id;
      result = { creditNoteNo: cn.creditNoteNo, applied: money.fromPaise(s.applied), refund: money.fromPaise(s.refund) };
    }
    await tx.query("UPDATE b2b_returns SET status = 'completed', resolution = ?, credit_note_id = ? WHERE id = ?", [resolution, creditNoteId, returnId]);
    // Whole order sent back → the order itself becomes "returned".
    const left = await tx.queryOne('SELECT COALESCE(SUM(COALESCE(qty_delivered, qty) - qty_returned), 0) AS n FROM b2b_order_items WHERE order_id = ?', [order.id]);
    if (Number(left.n) === 0 && ['delivered', 'partially_delivered'].indexOf(order.status) !== -1) {
      await tx.query("UPDATE b2b_orders SET status = 'returned' WHERE id = ?", [order.id]);
      await orders.history(tx, order.id, order.status, 'returned', 'All delivered items returned (' + r.return_no + ')', audit.SYSTEM);
    }
    await audit.log(tx, actor, 'return.completed', 'return', returnId, { status: 'received' }, Object.assign({ status: 'completed', resolution: resolution }, result));
    const lines2 = [];
    if (result.creditNoteNo) lines2.push('Credit note ' + result.creditNoteNo + ' has been issued.');
    if (Number(result.refund) > 0) lines2.push((resolution === 'refund' ? 'Refund due: ' : 'Balance in your favour: ') + money.inr(money.toPaise(result.refund)) + '.');
    if (resolution === 'replacement') lines2.push('A replacement will be arranged.');
    await notifications.notifyAccount(tx, r.buyer_account_id, { title: 'Return ' + r.return_no + ' completed', lines: lines2, link: '/b2b/returns', refType: 'return', refId: returnId });
    return Object.assign({ status: 'completed', resolution: resolution }, result);
  });
}

async function list(scope, f, pg) {
  const where = [], params = [];
  scopeWhere(scope, where, params);
  if (f.status) { where.push('r.status = ?'); params.push(String(f.status)); }
  if (f.open) { where.push('r.status IN (' + db.placeholders(OPEN) + ')'); params.push.apply(params, OPEN); }
  if (f.q) { const t = v.text(f.q, 80); where.push('(r.return_no LIKE ? OR o.order_no LIKE ? OR a.business_name LIKE ?)'); params.push(like(t, 'prefix'), like(t, 'prefix'), like(t)); }
  const sql = ' FROM b2b_returns r JOIN b2b_orders o ON o.id = r.order_id JOIN b2b_accounts a ON a.id = r.buyer_account_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const total = await db.queryOne('SELECT COUNT(*) AS n' + sql, params);
  const rows = await db.query(
    'SELECT r.id, r.return_no, r.status, r.resolution, r.reason, r.inspection_note, r.created_at, r.updated_at, r.order_id, o.order_no, r.seller_type, ' +
    'a.business_name AS buyer_name, a.shop_name AS buyer_shop, (SELECT COALESCE(SUM(qty), 0) FROM b2b_return_items ri WHERE ri.return_id = r.id) AS total_qty' + sql +
    ' ORDER BY r.id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows, total: Number(total.n) };
}

async function get(returnId, scope) {
  const where = ['r.id = ?'], params = [returnId];
  scopeWhere(scope, where, params);
  const r = await db.queryOne(
    'SELECT r.*, o.order_no, a.business_name AS buyer_name, a.shop_name AS buyer_shop, a.mobile AS buyer_mobile, c.credit_note_no, c.grand_total AS credit_note_total, c.refund_amount ' +
    'FROM b2b_returns r JOIN b2b_orders o ON o.id = r.order_id JOIN b2b_accounts a ON a.id = r.buyer_account_id LEFT JOIN b2b_credit_notes c ON c.id = r.credit_note_id WHERE ' + where.join(' AND '), params);
  if (!r) throw notFound('Return not found');
  const items = await db.query(
    'SELECT ri.id, ri.order_item_id, ri.qty, ri.qty_accepted, ri.item_condition, oi.sku, oi.name, oi.unit_price, oi.gst_rate FROM b2b_return_items ri ' +
    'JOIN b2b_order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = ? ORDER BY ri.id', [returnId]);
  const canManage = scope.buyerAccountId == null;
  return { ret: r, items: items, next: (FLOW[r.status] || []).filter(function (s) { return canManage ? s !== 'cancelled' || scope.admin : s === 'cancelled'; }) };
}

module.exports = { create, act, inspect, complete, list, get, FLOW, OPEN };
