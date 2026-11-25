/**
 * The salesman's own screens in the field app (read only): one shop in full — who to ask for, what it
 * owes, its credit, its last orders and visits, what it usually buys — and the salesman's own orders,
 * visits and collections.
 *
 * Every shop is checked against the salesman's territory exactly like the shop list
 * (service.retailerInScope); orders, visits and collections are the salesman's own rows only.
 * Money is the order's own grand total less what was applied to it; collections a salesman made that
 * finance has not confirmed yet are shown apart ("waiting for handover"), never as paid.
 */
'use strict';
const db = require('../../../db/connection.js');
const payments = require('../../b2b/payments/service.js');
const orders = require('../../b2b/orders/service.js');
const sales = require('./service.js');
const { fail, posId } = require('../lib/http.js');

const money = function (x) { return Number(Number(x || 0).toFixed(2)); };
// the same rule as sales.OWED_SQL, on the aliased order table
const OWED = "o.status NOT IN ('cancelled','rejected','refunded','draft','pending_otp','otp_expired') AND o.payment_status IN ('pending','partial')";
const NOT_LIVE = "('pending_otp','otp_expired','cancelled','rejected','draft')";
const IST = 330;
function sinceDays(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}
/** Midnight today in India, as the UTC time the DATETIME columns use. */
function istMidnight() {
  const day = new Date(Date.now() + IST * 60000).toISOString().slice(0, 10);
  return new Date(Date.parse(day + 'T00:00:00Z') - IST * 60000).toISOString().slice(0, 19).replace('T', ' ');
}
function orderOut(o) {
  const total = money(o.grand_total), paid = money(o.amount_paid);
  return {
    id: Number(o.id), orderNo: o.order_no, status: o.status, paymentMethod: o.payment_method, paymentStatus: o.payment_status,
    total: total, paid: paid, due: ['cancelled', 'rejected', 'refunded', 'draft', 'pending_otp', 'otp_expired'].indexOf(o.status) === -1 ? money(Math.max(0, total - paid)) : 0,
    items: Number(o.item_count || 0), units: Number(o.total_qty || 0), at: o.created_at, channel: o.channel || null,
    holdUntil: o.status === 'pending_otp' ? o.reservation_expires_at || null : null,
  };
}

/** One shop in full, for the salesman standing in front of it. */
async function retailer(principal, sm, id) {
  const a = await sales.retailerInScope(db, principal, sm, id);
  const owed = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(o.grand_total - o.amount_paid), 0) AS due, ' +
    'COALESCE(SUM(CASE WHEN i.due_date IS NOT NULL AND i.due_date < UTC_DATE() THEN o.grand_total - o.amount_paid ELSE 0 END), 0) AS overdue, MIN(i.due_date) AS oldest_due ' +
    'FROM b2b_orders o LEFT JOIN b2b_invoices i ON i.live_order_id = o.id WHERE o.buyer_account_id = ? AND ' + OWED, [a.id]);
  const waiting = await db.queryOne("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS v FROM b2b_payments WHERE payer_account_id = ? AND status = 'pending'", [a.id]);
  const recent = await db.query('SELECT o.id, o.order_no, o.status, o.channel, o.payment_method, o.payment_status, o.grand_total, o.amount_paid, o.item_count, o.total_qty, o.created_at, o.reservation_expires_at, o.salesman_id ' +
    'FROM b2b_orders o WHERE o.buyer_account_id = ? ORDER BY o.id DESC LIMIT 10', [a.id]);
  // orders money can be collected on now: what is due less collections still waiting for handover
  const dueOrders = (await db.query('SELECT o.id, o.order_no, o.status, o.grand_total, o.amount_paid, o.created_at, ' +
    "(SELECT COALESCE(SUM(p.amount), 0) FROM b2b_payments p WHERE p.order_id = o.id AND p.status = 'pending') AS waiting " +
    'FROM b2b_orders o WHERE o.buyer_account_id = ? AND ' + OWED + ' ORDER BY o.created_at, o.id LIMIT 30', [a.id]))
    .map(function (o) {
      const due = Math.max(0, money(o.grand_total) - money(o.amount_paid));
      return { id: Number(o.id), orderNo: o.order_no, status: o.status, at: o.created_at, total: money(o.grand_total), due: money(due), waiting: money(o.waiting), collectable: money(Math.max(0, due - money(o.waiting))) };
    });
  const visits = (await db.query('SELECT v.id, v.checked_in_at, v.outcome, v.note, v.distance_m, st.name AS salesman, v.salesman_id FROM b2b_visits v ' +
    'JOIN b2b_salesmen s ON s.id = v.salesman_id JOIN b2b_staff st ON st.id = s.staff_id WHERE v.account_id = ? ORDER BY v.checked_in_at DESC, v.id DESC LIMIT 10', [a.id]))
    .map(function (v) { return { id: Number(v.id), at: v.checked_in_at, outcome: v.outcome, note: v.note, distanceM: v.distance_m == null ? null : Number(v.distance_m), by: Number(v.salesman_id) === Number(sm.id) ? 'you' : v.salesman }; });
  // what this shop usually buys (paid lines of the last 180 days): the quick way to repeat an order
  const usual = (await db.query('SELECT oi.product_id, MAX(oi.name) AS name, COUNT(DISTINCT oi.order_id) AS times, SUM(oi.qty) AS qty, MAX(x.created_at) AS last_at ' +
    'FROM b2b_order_items oi JOIN b2b_orders x ON x.id = oi.order_id WHERE x.buyer_account_id = ? AND x.status NOT IN ' + NOT_LIVE +
    " AND x.created_at >= ? AND (oi.price_source IS NULL OR oi.price_source <> 'scheme_free') GROUP BY oi.product_id ORDER BY times DESC, qty DESC LIMIT 12", [a.id, sinceDays(180)]))
    .map(function (r) { const times = Number(r.times); return { productId: Number(r.product_id), name: r.name, times: times, qty: Number(r.qty), usualQty: Math.max(1, Math.round(Number(r.qty) / Math.max(1, times))), lastAt: r.last_at }; });
  const beats = await db.query('SELECT b.id, b.name, b.weekday FROM b2b_beat_stops s JOIN b2b_beats b ON b.id = s.beat_id WHERE s.account_id = ? AND b.salesman_id = ? AND b.is_active = 1 ORDER BY b.weekday', [a.id, sm.id]);
  let credit = null;
  try {
    const seller = await orders.sellerFor(a);
    credit = await payments.getCredit(a.id, seller.type === 'company' ? 0 : seller.accountId);
    credit = { limit: money(credit.credit_limit), used: money(credit.credit_used), available: money(credit.available), days: Number(credit.credit_days || 0), active: credit.is_active !== false && Number(credit.credit_limit) > 0, seller: seller.type, sellerName: seller.name || null };
  } catch (e) { credit = null; }   // credit is extra information; the rest of the shop page still opens
  const live = recent.filter(function (o) { return ['pending_otp', 'otp_expired', 'cancelled', 'rejected', 'draft'].indexOf(o.status) === -1; });
  return {
    shop: {
      id: Number(a.id), name: a.shop_name || a.business_name, businessName: a.business_name, contact: a.contact_person, mobile: a.mobile, email: a.email || null, gstin: a.gstin || null,
      address: [a.address_line1, a.address_line2].filter(Boolean).join(', '), landmark: a.landmark || null, city: a.city, district: a.district_name || null, state: a.state_name || null, pincode: a.pincode,
      lat: a.latitude == null ? null : Number(a.latitude), lng: a.longitude == null ? null : Number(a.longitude), status: a.status, since: a.approved_at || a.created_at || null,
    },
    money: { due: money(owed.due), overdue: money(owed.overdue), openOrders: Number(owed.n), oldestDueDate: owed.oldest_due || null, waitingHandover: money(waiting.v), waitingReceipts: Number(waiting.n) },
    credit: credit,
    lastOrderAt: live.length ? live[0].created_at : null,
    lastVisitAt: visits.length ? visits[0].at : null,
    // "mine": the salesman's own orders open in full in the app (others only as a line here)
    orders: recent.map(function (o) { return Object.assign(orderOut(o), { mine: o.salesman_id != null && Number(o.salesman_id) === Number(sm.id) }); }),
    dueOrders: dueOrders,
    visits: visits,
    usual: usual,
    beats: beats.map(function (b) { return { id: Number(b.id), name: b.name, weekday: Number(b.weekday) }; }),
  };
}

const FILTERS = {
  code: "o.status = 'pending_otp'",
  open: "o.status NOT IN ('pending_otp','otp_expired','cancelled','rejected','draft','delivered','partially_delivered','returned','refunded')",
  delivered: "o.status IN ('delivered','partially_delivered')",
  due: OWED,
  closed: "o.status IN ('otp_expired','cancelled','rejected','returned','refunded')",
};

/** The salesman's own orders, newest first, with how many sit in each group. */
async function myOrders(principal, sm, q) {
  q = q || {};
  const where = ['o.salesman_id = ?'], params = [sm.id];
  if (FILTERS[q.filter]) where.push(FILTERS[q.filter]);
  if (posId(q.retailerId)) { where.push('o.buyer_account_id = ?'); params.push(posId(q.retailerId)); }
  const rows = await db.query('SELECT o.id, o.order_no, o.status, o.channel, o.payment_method, o.payment_status, o.grand_total, o.amount_paid, o.item_count, o.total_qty, o.created_at, o.reservation_expires_at, ' +
    'a.id AS account_id, a.business_name, a.shop_name, a.city FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id WHERE ' + where.join(' AND ') + ' ORDER BY o.id DESC LIMIT ' + db.int(q.limit, 100, 1, 300), params);
  const counts = {};
  for (const k of Object.keys(FILTERS)) counts[k] = Number((await db.queryOne('SELECT COUNT(*) AS n FROM b2b_orders o WHERE o.salesman_id = ? AND ' + FILTERS[k], [sm.id])).n);
  return { counts: counts, items: rows.map(function (o) { return Object.assign(orderOut(o), { shopId: Number(o.account_id), shop: o.shop_name || o.business_name, city: o.city }); }) };
}

/** One of the salesman's orders: lines, the code's state, delivery, payments and history. */
async function myOrder(principal, sm, id) {
  const o = await db.queryOne('SELECT o.*, a.business_name, a.shop_name, a.city, a.mobile FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id WHERE o.id = ? AND o.salesman_id = ?', [id, sm.id]);
  if (!o) throw fail(404, 'Order not found');
  const items = (await db.query('SELECT id, product_id, sku, name, qty, unit_price, gst_rate, line_total FROM b2b_order_items WHERE order_id = ? ORDER BY id', [id]))
    .map(function (i) { return { id: Number(i.id), productId: Number(i.product_id), sku: i.sku, name: i.name, qty: Number(i.qty), unitPrice: money(i.unit_price), gstRate: Number(i.gst_rate), total: money(i.line_total) }; });
  const ch = await db.queryOne("SELECT status, expires_at, attempts, resends, delivery_status, mobile FROM b2b_otp_challenges WHERE order_id = ? AND purpose = 'order_confirm' ORDER BY id DESC LIMIT 1", [id]);
  const pays = (await db.query('SELECT receipt_no, method, amount, status, received_at FROM b2b_payments WHERE order_id = ? ORDER BY id', [id]))
    .map(function (p) { return { receiptNo: p.receipt_no, method: p.method, amount: money(p.amount), status: p.status, at: p.received_at }; });
  const history = (await db.query('SELECT from_status, to_status, note, created_at FROM b2b_order_status_history WHERE order_id = ? ORDER BY id', [id]))
    .map(function (h) { return { from: h.from_status, to: h.to_status, note: h.note, at: h.created_at }; });
  let shipment = null;
  try {
    const s = await db.queryOne('SELECT shipment_no, status, mode, expected_at, delivered_at, pod_received_by FROM b2b_shipments WHERE order_id = ?', [id]);
    if (s) shipment = { shipmentNo: s.shipment_no, status: s.status, mode: s.mode, expectedAt: s.expected_at, deliveredAt: s.delivered_at, receivedBy: s.pod_received_by };
  } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE' && e.errno !== 1146) throw e; }
  return Object.assign(orderOut(o), {
    shopId: Number(o.buyer_account_id), shop: o.shop_name || o.business_name, city: o.city, notes: o.buyer_notes || null,
    subtotal: money(o.taxable_total), tax: money(o.tax_total),
    lines: items, payments: pays, history: history, shipment: shipment,
    code: ch ? { status: ch.status, expiresAt: ch.expires_at, attempts: Number(ch.attempts), resends: Number(ch.resends), sent: ch.delivery_status, sentTo: 'XXXXXX' + String(ch.mobile || '').slice(-4) } : null,
  });
}

/** The salesman's visits: today, the last 7 days or the last 30 days. */
async function myVisits(principal, sm, q) {
  q = q || {};
  const from = q.range === 'month' ? sinceDays(30) : q.range === 'week' ? sinceDays(7) : istMidnight();
  const rows = await db.query('SELECT v.id, v.checked_in_at, v.outcome, v.note, v.distance_m, a.id AS account_id, a.business_name, a.shop_name, a.city FROM b2b_visits v ' +
    'JOIN b2b_accounts a ON a.id = v.account_id WHERE v.salesman_id = ? AND v.checked_in_at >= ? ORDER BY v.checked_in_at DESC, v.id DESC LIMIT 300', [sm.id, from]);
  return { range: q.range === 'month' || q.range === 'week' ? q.range : 'today', items: rows.map(function (v) {
    return { id: Number(v.id), at: v.checked_in_at, outcome: v.outcome, note: v.note, distanceM: v.distance_m == null ? null : Number(v.distance_m), shopId: Number(v.account_id), shop: v.shop_name || v.business_name, city: v.city };
  }) };
}

/** Money the salesman collected: waiting for handover at the office, and confirmed by finance. */
async function myCollections(principal, sm) {
  const rows = await db.query('SELECT p.id, p.receipt_no, p.method, p.amount, p.reference, p.status, p.received_at, p.handover_confirmed_at, o.id AS order_id, o.order_no, a.business_name, a.shop_name ' +
    'FROM b2b_payments p LEFT JOIN b2b_orders o ON o.id = p.order_id LEFT JOIN b2b_accounts a ON a.id = p.payer_account_id WHERE p.collected_by_salesman_id = ? ORDER BY p.id DESC LIMIT 150', [sm.id]);
  const items = rows.map(function (p) {
    return { id: Number(p.id), receiptNo: p.receipt_no, method: p.method, amount: money(p.amount), reference: p.reference, status: p.status, at: p.received_at, confirmedAt: p.handover_confirmed_at,
      orderId: p.order_id == null ? null : Number(p.order_id), orderNo: p.order_no, shop: p.shop_name || p.business_name || null };
  });
  const waiting = { cash: 0, upi: 0, cheque: 0 };
  items.forEach(function (p) { if (p.status === 'pending' && waiting[p.method] != null) waiting[p.method] = money(waiting[p.method] + p.amount); });
  const month = await db.queryOne("SELECT COALESCE(SUM(amount), 0) AS v FROM b2b_payments WHERE collected_by_salesman_id = ? AND status = 'received' AND received_at >= ?", [sm.id, sinceDays(30)]);
  return { waiting: waiting, cashLimit: money(sm.cash_limit), confirmed30d: money(month.v), items: items };
}

module.exports = { retailer, myOrders, myOrder, myVisits, myCollections, FILTERS };
