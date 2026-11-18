/**
 * Payments and trade credit.
 *
 * A credit account is the line of credit one party gives another:
 *   creditor 0            → the company (to a distributor, or to a retailer it serves directly)
 *   creditor = account id → a distributor (to one of its retailers)
 *
 * credit_used only moves inside a transaction that holds the credit account
 * row FOR UPDATE, so two simultaneous orders cannot both squeeze under a limit.
 */
const db = require('../../../db/connection.js');
const money = require('../lib/money.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const { AppError, bad, notFound, forbidden, like } = require('../lib/http.js');

const MANUAL_METHODS = ['upi', 'bank_transfer', 'cash', 'cheque', 'adjustment'];

/* ─────────── Credit ─────────── */

async function lockCreditAccount(tx, debtorId, creditorId) {
  creditorId = Number(creditorId) || 0;
  await tx.query('INSERT IGNORE INTO b2b_credit_accounts (debtor_account_id, creditor_account_id, credit_limit) VALUES (?, ?, 0)', [debtorId, creditorId]);
  return tx.queryOne('SELECT * FROM b2b_credit_accounts WHERE debtor_account_id = ? AND creditor_account_id = ? FOR UPDATE', [debtorId, creditorId]);
}

function creditPosition(acc) {
  const limit = money.toPaise(acc.credit_limit), used = money.toPaise(acc.credit_used);
  const overrideLive = acc.override_until && new Date(acc.override_until).getTime() > Date.now();
  const override = overrideLive ? money.toPaise(acc.override_amount) : 0;
  return { limit: limit, used: used, override: override, available: Math.max(0, limit + override - used), active: !!Number(acc.is_active) };
}

function publicCredit(acc) {
  if (!acc) return { credit_limit: '0.00', credit_used: '0.00', available: '0.00', credit_days: 0, override_amount: '0.00', override_until: null };
  const p = creditPosition(acc);
  return {
    credit_limit: money.fromPaise(p.limit), credit_used: money.fromPaise(p.used), available: money.fromPaise(p.available),
    credit_days: Number(acc.credit_days), override_amount: money.fromPaise(p.override), override_until: p.override ? acc.override_until : null,
    is_active: p.active,
  };
}

/** Put an order on credit. Throws 409 CREDIT_LIMIT when it does not fit. */
async function debit(tx, o) {
  const acc = await lockCreditAccount(tx, o.debtorId, o.creditorId);
  const p = creditPosition(acc);
  if (!p.active) throw new AppError(409, 'Credit is not enabled for this account. Choose another payment method.', { code: 'CREDIT_DISABLED' });
  if (o.amount > p.available && !o.force) {
    throw new AppError(409,
      'This order (' + money.inr(o.amount) + ') is above your available credit of ' + money.inr(p.available) + '. Pay the outstanding amount or choose another payment method.',
      { code: 'CREDIT_LIMIT', available: money.fromPaise(p.available), required: money.fromPaise(o.amount) });
  }
  const after = p.used + o.amount;
  await tx.query('UPDATE b2b_credit_accounts SET credit_used = ? WHERE id = ?', [money.fromPaise(after), acc.id]);
  const days = Number(acc.credit_days) || 0;
  await tx.query(
    "INSERT INTO b2b_credit_transactions (credit_account_id, txn_type, amount, balance_after, order_id, due_date, note, actor_label) " +
    "VALUES (?, 'debit', ?, ?, ?, (UTC_DATE() + INTERVAL " + db.int(days, 0, 0, 365) + ' DAY), ?, ?)',
    [acc.id, money.fromPaise(o.amount), money.fromPaise(after), o.orderId || null, o.note || null, (o.actor && o.actor.label) || null]);
  return { usedOverride: o.amount > Math.max(0, p.limit - p.used), creditDays: days };
}

/** Give credit back (payment received, order cancelled, goods returned). Never goes below zero. */
async function release(tx, o) {
  const acc = await lockCreditAccount(tx, o.debtorId, o.creditorId);
  const used = money.toPaise(acc.credit_used);
  const amount = Math.min(used, o.amount);
  if (amount <= 0) return;
  await tx.query('UPDATE b2b_credit_accounts SET credit_used = ? WHERE id = ?', [money.fromPaise(used - amount), acc.id]);
  await tx.query(
    "INSERT INTO b2b_credit_transactions (credit_account_id, txn_type, amount, balance_after, order_id, payment_id, note, actor_label) VALUES (?, 'credit', ?, ?, ?, ?, ?, ?)",
    [acc.id, money.fromPaise(amount), money.fromPaise(used - amount), o.orderId || null, o.paymentId || null, o.note || null, (o.actor && o.actor.label) || null]);
}

async function getCredit(debtorId, creditorId) {
  const acc = await db.queryOne('SELECT * FROM b2b_credit_accounts WHERE debtor_account_id = ? AND creditor_account_id = ?', [debtorId, Number(creditorId) || 0]);
  return publicCredit(acc);
}

/**
 * Change a credit limit / terms. `creditorScope` undefined = admin (any line);
 * a distributor id = that distributor may only edit lines it extends to its own retailers.
 */
async function setCreditTerms(debtorId, creditorId, body, actor, creditorScope) {
  creditorId = Number(creditorId) || 0;
  if (creditorScope !== undefined && Number(creditorScope) !== creditorId) throw forbidden();
  const limit = v.decimal(body.credit_limit, 2, 999999999);
  if (limit == null) throw bad('Enter a valid credit limit');
  const days = body.credit_days === undefined ? null : v.intOrNull(body.credit_days);
  if (days != null && (days < 0 || days > 365)) throw bad('Credit days must be between 0 and 365');
  return db.transaction(async function (tx) {
    const debtor = await tx.queryOne("SELECT id, status FROM b2b_accounts WHERE id = ?", [debtorId]);
    if (!debtor) throw notFound('Account not found');
    if (creditorId) {
      const mapped = await tx.queryOne('SELECT id FROM b2b_retailer_distributor_map WHERE current_retailer_id = ? AND distributor_id = ?', [debtorId, creditorId]);
      if (!mapped) throw forbidden('That retailer is not mapped to this distributor');
    }
    const acc = await lockCreditAccount(tx, debtorId, creditorId);
    const newDays = days == null ? Number(acc.credit_days) : days;
    const active = body.is_active === undefined ? Number(acc.is_active) : (v.bool(body.is_active, true) ? 1 : 0);
    await tx.query('UPDATE b2b_credit_accounts SET credit_limit = ?, credit_days = ?, is_active = ? WHERE id = ?', [limit, newDays, active, acc.id]);
    await tx.query(
      "INSERT INTO b2b_credit_transactions (credit_account_id, txn_type, amount, balance_after, note, actor_label) VALUES (?, 'limit_change', ?, ?, ?, ?)",
      [acc.id, limit, acc.credit_used, 'Limit ' + acc.credit_limit + ' → ' + limit + ', ' + newDays + ' days', actor.label]);
    await audit.log(tx, actor, 'credit.limit_changed', 'credit_account', acc.id,
      { credit_limit: acc.credit_limit, credit_days: acc.credit_days, is_active: acc.is_active },
      { credit_limit: limit, credit_days: newDays, is_active: active, debtor: debtorId, creditor: creditorId });
    return { ok: true };
  });
}

/** Authorised, time-boxed headroom above the limit (permission b2b.credit.override). */
async function setOverride(debtorId, creditorId, body, actor) {
  const amount = v.decimal(body.amount, 2, 999999999);
  const hours = v.posInt(body.hours) || 24;
  const reason = v.text(body.reason, 300);
  if (amount == null) throw bad('Enter the extra amount to allow');
  if (hours > 24 * 30) throw bad('An override can last at most 30 days');
  if (Number(amount) > 0 && reason.length < 3) throw bad('Please give a reason for the override');
  return db.transaction(async function (tx) {
    const acc = await lockCreditAccount(tx, debtorId, Number(creditorId) || 0);
    if (Number(amount) === 0) {
      await tx.query('UPDATE b2b_credit_accounts SET override_amount = 0, override_until = NULL, override_by = NULL WHERE id = ?', [acc.id]);
    } else {
      await tx.query('UPDATE b2b_credit_accounts SET override_amount = ?, override_until = (UTC_TIMESTAMP() + INTERVAL ' + db.int(hours, 24, 1, 720) + ' HOUR), override_by = ? WHERE id = ?',
        [amount, actor.label, acc.id]);
    }
    await audit.log(tx, actor, 'credit.override_' + (Number(amount) === 0 ? 'cleared' : 'granted'), 'credit_account', acc.id,
      { override_amount: acc.override_amount, override_until: acc.override_until }, { override_amount: amount, hours: hours, reason: reason, debtor: debtorId });
    return { ok: true };
  });
}

/* ─────────── Payments ─────────── */

function statusFor(paid, total) {
  if (paid <= 0) return 'pending';
  return paid >= total ? 'paid' : 'partial';
}

/**
 * Apply a received payment to an order (caller holds the order row FOR UPDATE).
 * Returns the payment id. For credit orders the credit line is freed by the same amount.
 */
async function applyToOrder(tx, order, p) {
  const total = money.toPaise(order.grand_total), paid = money.toPaise(order.amount_paid);
  const outstanding = total - paid;
  if (p.amount <= 0) throw bad('Payment amount must be greater than zero');
  if (p.amount > outstanding) throw bad('Payment (' + money.inr(p.amount) + ') is more than the outstanding amount (' + money.inr(outstanding) + ')');
  let paymentId = p.existingPaymentId || null;
  if (paymentId) {
    await tx.query("UPDATE b2b_payments SET status = 'received', gateway_payment_id = ?, received_at = UTC_TIMESTAMP(), recorded_by = ? WHERE id = ?",
      [p.gatewayPaymentId || null, (p.actor && p.actor.label) || null, paymentId]);
  } else {
    const res = await tx.query(
      'INSERT INTO b2b_payments (order_id, payer_account_id, payee_type, payee_account_id, method, amount, reference, gateway, gateway_payment_id, gateway_order_id, status, note, recorded_by) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)",
      [order.id, order.buyer_account_id, order.seller_type, order.seller_account_id, p.method, money.fromPaise(p.amount), p.reference || null,
        p.gateway || null, p.gatewayPaymentId || null, p.gatewayOrderId || null, p.note || null, (p.actor && p.actor.label) || null]);
    paymentId = res.insertId;
  }
  const newPaid = paid + p.amount;
  await tx.query('UPDATE b2b_orders SET amount_paid = ?, payment_status = ? WHERE id = ?', [money.fromPaise(newPaid), statusFor(newPaid, total), order.id]);
  if (order.payment_method === 'credit') {
    await release(tx, { debtorId: order.buyer_account_id, creditorId: order.seller_account_id || 0, amount: p.amount, orderId: order.id,
      paymentId: paymentId, note: 'Payment received', actor: p.actor });
  }
  // N5: the buyer is told once per payment (this is the only place a payment is applied)
  await require('../notifications/service.js').notifyAccount(tx, order.buyer_account_id, { event: 'payment.received',
    title: 'Payment received for order ' + order.order_no,
    lines: ['We received ' + money.inr(p.amount) + (p.method === 'gateway' ? ' online' : ' by ' + String(p.method).replace(/_/g, ' ')) + (p.reference ? ' (reference ' + p.reference + ')' : '') + '.',
      newPaid >= total ? 'The order is now fully paid. Thank you.' : 'Still to pay: ' + money.inr(total - newPaid) + '.'],
    link: '/b2b/orders/' + order.id, refType: 'payment', refId: paymentId });
  return { paymentId: paymentId, amountPaid: money.fromPaise(newPaid), paymentStatus: statusFor(newPaid, total) };
}

/**
 * Record an offline payment (UPI / bank transfer / cash / cheque).
 * scope: { admin: true } or { sellerAccountId } — a distributor can only record payments on orders it sold.
 */
async function recordManual(orderId, body, actor, scope) {
  const method = String(body.method || '');
  if (MANUAL_METHODS.indexOf(method) === -1) throw bad('Choose a payment method');
  let amount;
  try { amount = money.toPaise(v.decimal(body.amount, 2, 999999999)); } catch (e) { amount = 0; }
  if (!amount || amount <= 0) throw bad('Enter a valid amount');
  const reference = v.text(body.reference, 120);
  if (['upi', 'bank_transfer', 'cheque'].indexOf(method) !== -1 && reference.length < 3) throw bad('Enter the transaction / UTR / cheque reference');
  return db.transaction(async function (tx) {
    const order = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) throw notFound('Order not found');
    if (!scope.admin && !(order.seller_type === 'distributor' && Number(order.seller_account_id) === Number(scope.sellerAccountId))) throw notFound('Order not found');
    if (['cancelled', 'rejected', 'refunded'].indexOf(order.status) !== -1) throw bad('This order is ' + order.status + ' — payments cannot be recorded against it');
    if (reference) {
      const dup = await tx.queryOne("SELECT id FROM b2b_payments WHERE order_id = ? AND method = ? AND reference = ? AND status = 'received'", [orderId, method, reference]);
      if (dup) throw new AppError(409, 'A payment with this reference has already been recorded for this order', { code: 'DUPLICATE_PAYMENT' });
    }
    const r = await applyToOrder(tx, order, { amount: amount, method: method, reference: reference, note: v.text(body.note, 300), actor: actor });
    await audit.log(tx, actor, 'payment.recorded', 'order', orderId, { amount_paid: order.amount_paid, payment_status: order.payment_status },
      { amount: money.fromPaise(amount), method: method, reference: reference, amount_paid: r.amountPaid, payment_status: r.paymentStatus });
    return r;
  });
}

/** Online payment step 1: create a gateway order for the exact outstanding amount (server-decided). */
/**
 * The shop's payment helper falls back to a MOCK gateway whenever RAZORPAY_KEY_ID is missing, and the mock
 * accepts any signature. For B2B money that is never acceptable by accident: the mock is allowed only when
 * PAYMENT_MOCK=true is set explicitly AND NODE_ENV is not production. Otherwise online payment is refused.
 */
function mockAllowed() { return process.env.PAYMENT_MOCK === 'true' && process.env.NODE_ENV !== 'production'; }
function realGatewayConfigured() { return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) && process.env.PAYMENT_MOCK !== 'true'; }
function assertGatewayUsable() {
  if (!realGatewayConfigured() && !mockAllowed()) throw bad('Online payment is not available right now. Please pay by UPI or bank transfer.');
}

async function gatewayInitiate(orderId, buyerAccountId) {
  const gateway = require('../../../services/payments.js');
  assertGatewayUsable();
  const order = await db.queryOne('SELECT * FROM b2b_orders WHERE id = ? AND buyer_account_id = ?', [orderId, buyerAccountId]);
  if (!order) throw notFound('Order not found');
  if (order.seller_type !== 'company') throw bad('Online payment is available for orders supplied by ' + (process.env.BRAND_NAME || 'Sake of Health') + '. Please pay your distributor directly.');
  if (['cancelled', 'rejected', 'refunded'].indexOf(order.status) !== -1) throw bad('This order is ' + order.status);
  const outstanding = money.toPaise(order.grand_total) - money.toPaise(order.amount_paid);
  if (outstanding <= 0) throw bad('This order is already paid');
  const rupees = Math.round(outstanding / 100);
  const key = 'b2b-' + order.id + '-' + Date.now();
  const g = await gateway.createOrder({ amount: rupees, currency: 'INR', receipt: order.order_no, idempotencyKey: key });
  await db.query(
    'INSERT INTO b2b_payments (order_id, payer_account_id, payee_type, payee_account_id, method, amount, gateway, gateway_order_id, status) ' +
    "VALUES (?, ?, 'company', NULL, 'gateway', ?, ?, ?, 'pending')",
    [order.id, order.buyer_account_id, money.fromPaise(rupees * 100), g.gateway || 'razorpay', g.id]);
  return { gateway: g.gateway, gatewayOrderId: g.id, amount: rupees, currency: 'INR', key: g.key || '', orderNo: order.order_no, mock: g.gateway === 'mock' };
}

/**
 * Online payment step 2 (browser callback OR gateway webhook — both may arrive,
 * in any order, more than once). Exactly one payment is ever applied:
 * the pending row is locked, and (gateway, gateway_payment_id) is unique.
 */
async function gatewayConfirm(o) {
  const gateway = require('../../../services/payments.js');
  // A "mock" gateway confirmation is only ever accepted in an explicit, non-production test setup.
  if ((o.gateway === 'mock' || /^mock_/.test(String(o.gatewayOrderId || ''))) && !mockAllowed()) throw bad('Payment verification failed');
  if (!o.trusted) {
    assertGatewayUsable();
    const valid = await gateway.verifySignature(o.gateway || 'razorpay', { orderId: o.gatewayOrderId, paymentId: o.gatewayPaymentId, signature: o.signature });
    if (!valid) throw bad('Payment verification failed');
  }
  if (!o.gatewayOrderId || !o.gatewayPaymentId) throw bad('Payment details are missing');
  return db.transaction(async function (tx) {
    const pending = await tx.queryOne('SELECT * FROM b2b_payments WHERE gateway_order_id = ? ORDER BY id LIMIT 1 FOR UPDATE', [String(o.gatewayOrderId)]);
    if (!pending) throw notFound('Payment not found');
    if (o.buyerAccountId != null && Number(pending.payer_account_id) !== Number(o.buyerAccountId)) throw notFound('Payment not found');
    if (pending.status === 'received') return { duplicate: true, paymentId: Number(pending.id) };
    const already = await tx.queryOne('SELECT id FROM b2b_payments WHERE gateway = ? AND gateway_payment_id = ?', [pending.gateway, String(o.gatewayPaymentId)]);
    if (already) return { duplicate: true, paymentId: Number(already.id) };
    const order = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [pending.order_id]);
    const outstanding = money.toPaise(order.grand_total) - money.toPaise(order.amount_paid);
    const amount = Math.min(money.toPaise(pending.amount), outstanding);
    if (amount <= 0) {
      await tx.query("UPDATE b2b_payments SET status = 'failed', note = 'Order was already settled' WHERE id = ?", [pending.id]);
      return { duplicate: true, paymentId: Number(pending.id) };
    }
    const actor = { type: 'system', label: 'payment-gateway' };
    const r = await applyToOrder(tx, order, { amount: amount, method: 'gateway', existingPaymentId: pending.id, gatewayPaymentId: String(o.gatewayPaymentId), actor: actor });
    await audit.log(tx, actor, 'payment.gateway_received', 'order', order.id, { amount_paid: order.amount_paid },
      { amount: money.fromPaise(amount), gateway_payment_id: String(o.gatewayPaymentId), amount_paid: r.amountPaid });
    return Object.assign({ duplicate: false }, r);
  });
}

/** Reverse everything paid on an order (refund after cancellation / rejection / return). */
async function refundOrder(tx, order, actor, note) {
  const paid = money.toPaise(order.amount_paid);
  if (paid <= 0) return 0;
  await tx.query(
    'INSERT INTO b2b_payments (order_id, payer_account_id, payee_type, payee_account_id, method, amount, status, note, recorded_by) ' +
    "VALUES (?, ?, ?, ?, 'adjustment', ?, 'reversed', ?, ?)",
    [order.id, order.buyer_account_id, order.seller_type, order.seller_account_id, money.fromPaise(paid), note || 'Refund', actor.label || null]);
  await tx.query("UPDATE b2b_orders SET amount_paid = 0, payment_status = 'refunded' WHERE id = ?", [order.id]);
  return paid;
}

/* ─────────── Read models ─────────── */

function orderScope(scope, alias, where, params) {
  if (scope.buyerAccountId != null) { where.push(alias + '.buyer_account_id = ?'); params.push(scope.buyerAccountId); }
  if (scope.sellerAccountId != null) { where.push(alias + ".seller_type = 'distributor' AND " + alias + '.seller_account_id = ?'); params.push(scope.sellerAccountId); }
}

async function listPayments(scope, f, pg) {
  const where = ["p.status IN ('received','reversed')"], params = [];
  orderScope(scope, 'o', where, params);
  if (f.method) { where.push('p.method = ?'); params.push(String(f.method)); }
  if (f.from) { where.push('p.received_at >= ?'); params.push(f.from + ' 00:00:00'); }
  if (f.to) { where.push('p.received_at <= ?'); params.push(f.to + ' 23:59:59'); }
  if (f.q) { const t = v.text(f.q, 80); where.push('(o.order_no LIKE ? OR p.reference LIKE ? OR a.business_name LIKE ?)'); params.push(like(t, 'prefix'), like(t, 'prefix'), like(t)); }
  const sql = ' FROM b2b_payments p JOIN b2b_orders o ON o.id = p.order_id JOIN b2b_accounts a ON a.id = p.payer_account_id WHERE ' + where.join(' AND ');
  const total = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN p.status = \'received\' THEN p.amount ELSE -p.amount END), 0) AS amount' + sql, params);
  const rows = await db.query(
    'SELECT p.id, p.order_id, o.order_no, p.payer_account_id, a.business_name AS payer_name, p.payee_type, p.method, p.amount, p.reference, p.gateway, ' +
    'p.gateway_payment_id, p.status, p.note, p.recorded_by, p.received_at' + sql + ' ORDER BY p.id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows, total: Number(total.n), amount: total.amount };
}

const OWED = "o.status NOT IN ('cancelled','rejected','refunded','draft') AND o.payment_status IN ('pending','partial')";

/** Outstanding per buyer, with ageing from the invoice due date. */
async function listOutstanding(scope, f, pg) {
  const where = [OWED], params = [];
  orderScope(scope, 'o', where, params);
  if (f.q) { const t = v.text(f.q, 80); where.push('(a.business_name LIKE ? OR a.shop_name LIKE ? OR a.mobile LIKE ?)'); params.push(like(t), like(t), like(t, 'prefix')); }
  if (f.type) { where.push('a.account_type = ?'); params.push(String(f.type)); }
  // The account table is only joined while aggregating when a filter needs it;
  // names are fetched afterwards for just the buyers on this page.
  const joinA = f.q || f.type ? ' JOIN b2b_accounts a ON a.id = o.buyer_account_id' : '';
  const cond = ' WHERE ' + where.join(' AND ');
  const total = await db.queryOne('SELECT COUNT(DISTINCT o.buyer_account_id) AS n, COALESCE(SUM(o.grand_total - o.amount_paid), 0) AS amount FROM b2b_orders o' + joinA + cond, params);
  const page = await db.query(
    'SELECT o.buyer_account_id AS account_id, COUNT(*) AS open_orders, SUM(o.grand_total - o.amount_paid) AS outstanding, ' +
    'SUM(CASE WHEN i.due_date IS NOT NULL AND i.due_date < UTC_DATE() THEN o.grand_total - o.amount_paid ELSE 0 END) AS overdue, ' +
    'MIN(i.due_date) AS oldest_due_date, MAX(o.created_at) AS last_order_at FROM b2b_orders o' + joinA + ' LEFT JOIN b2b_invoices i ON i.live_order_id = o.id' + cond +
    ' GROUP BY o.buyer_account_id ORDER BY outstanding DESC, o.buyer_account_id LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  let rows = [];
  if (page.length) {
    const ids = page.map(function (r) { return r.account_id; });
    const names = await db.query('SELECT id, business_name, shop_name, account_type, mobile, city FROM b2b_accounts WHERE id IN (' + db.placeholders(ids) + ')', ids);
    const byId = {};
    names.forEach(function (n) { byId[n.id] = n; });
    rows = page.map(function (r) {
      const n = byId[r.account_id] || {};
      return { account_id: r.account_id, business_name: n.business_name, shop_name: n.shop_name, account_type: n.account_type, mobile: n.mobile, city: n.city,
        open_orders: r.open_orders, outstanding: r.outstanding, overdue: r.overdue, oldest_due_date: r.oldest_due_date, last_order_at: r.last_order_at };
    });
  }
  return { rows: rows, total: Number(total.n), amount: total.amount };
}

async function outstandingTotal(scope) {
  const where = [OWED], params = [];
  orderScope(scope, 'o', where, params);
  const r = await db.queryOne('SELECT COALESCE(SUM(o.grand_total - o.amount_paid), 0) AS amount, COUNT(*) AS orders FROM b2b_orders o WHERE ' + where.join(' AND '), params);
  return { amount: r.amount, orders: Number(r.orders) };
}

async function listCreditAccounts(f, pg) {
  const where = [], params = [];
  if (f.creditor_id !== undefined) { where.push('c.creditor_account_id = ?'); params.push(Number(f.creditor_id) || 0); }
  if (f.q) { const t = v.text(f.q, 80); where.push('(a.business_name LIKE ? OR a.mobile LIKE ?)'); params.push(like(t), like(t, 'prefix')); }
  if (f.used) where.push('c.credit_used > 0');
  const sql = ' FROM b2b_credit_accounts c JOIN b2b_accounts a ON a.id = c.debtor_account_id LEFT JOIN b2b_accounts cr ON cr.id = c.creditor_account_id' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const total = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(c.credit_limit), 0) AS total_limit, COALESCE(SUM(c.credit_used), 0) AS total_used' + sql, params);
  const rows = await db.query(
    'SELECT c.*, a.business_name, a.account_type, a.mobile, a.city, cr.business_name AS creditor_name' + sql +
    ' ORDER BY c.credit_used DESC, c.credit_limit DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return {
    rows: rows.map(function (r) { return Object.assign({ id: r.id, debtor_account_id: r.debtor_account_id, creditor_account_id: r.creditor_account_id,
      business_name: r.business_name, account_type: r.account_type, mobile: r.mobile, city: r.city, creditor_name: r.creditor_name || 'Company' }, publicCredit(r)); }),
    total: Number(total.n), totalLimit: total.total_limit, totalUsed: total.total_used,
  };
}

async function creditHistory(debtorId, creditorId, pg) {
  const acc = await db.queryOne('SELECT id FROM b2b_credit_accounts WHERE debtor_account_id = ? AND creditor_account_id = ?', [debtorId, Number(creditorId) || 0]);
  if (!acc) return [];
  return db.query(
    'SELECT t.id, t.txn_type, t.amount, t.balance_after, t.order_id, o.order_no, t.due_date, t.note, t.actor_label, t.created_at ' +
    'FROM b2b_credit_transactions t LEFT JOIN b2b_orders o ON o.id = t.order_id WHERE t.credit_account_id = ? ORDER BY t.id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, [acc.id]);
}

module.exports = {
  MANUAL_METHODS, lockCreditAccount, creditPosition, publicCredit, debit, release, getCredit, setCreditTerms, setOverride,
  applyToOrder, recordManual, gatewayInitiate, gatewayConfirm, refundOrder,
  listPayments, listOutstanding, outstandingTotal, listCreditAccounts, creditHistory,
};
