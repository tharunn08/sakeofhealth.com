/**
 * Phase 8: field sales (salesman app API).
 *
 * A salesman is an ERP staff member with the salesman role and a b2b_salesmen row.
 * They work only with retailers in their territory scope.
 *
 * Ordering on behalf of a retailer:
 *   1. salesman sends product ids + quantities → priced by the EXISTING B2B pricing
 *      engine (orders.quote), stock reserved by the existing inventory code, order
 *      stored as 'pending_otp' (the B2B state machine has no edges from it, so nothing
 *      else can move it) with a hold expiry;
 *   2. a one-time code goes to the RETAILER's registered mobile (SMS queue);
 *   3. the salesman types the code the retailer reads out → the order continues exactly
 *      like a portal order (credit check, approval rules, assignment, notifications).
 *   Without the code: an override request goes to an approver (never automatic).
 *   Expired holds release the stock (background job).
 *
 * The OTP rules (length, expiry, attempts, resends, hold) are a PENDING business
 * decision (sales.otp). Until it is approved, salesman ordering is switched off.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const b2bSettings = require('../../b2b/lib/settings.js');
const b2bMoney = require('../../b2b/lib/money.js');
const orders = require('../../b2b/orders/service.js');
const inventory = require('../../b2b/inventory/service.js');
const payments = require('../../b2b/payments/service.js');
const notifications = require('../../b2b/notifications/service.js');
const invoices = require('../../b2b/invoices/service.js');
const security = require('../core/security.js');
const config = require('../config.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const settings = require('../core/settings.js');
const monitor = require('../core/monitor.js');
const seq = require('../lib/seq.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }

/** Middleware: an active salesman record for the signed-in staff member. */
function requireSalesman(req, res, next) {
  db.queryOne('SELECT * FROM b2b_salesmen WHERE staff_id = ? AND is_active = 1', [req.erp.id]).then(function (sm) {
    if (!sm) return res.status(403).json({ error: 'You are not set up as a salesman', code: 'not_salesman' });
    req.salesman = sm; next();
  }).catch(next);
}

function territories(principal, sm) {
  const s = principal.scopes.territory;
  if (s === 'all') return null;
  const ids = Array.isArray(s) ? s.slice() : [];
  if (sm.home_territory_id && ids.indexOf(Number(sm.home_territory_id)) === -1) ids.push(Number(sm.home_territory_id));
  return ids;
}
async function retailerInScope(q, principal, sm, accountId, lock) {
  const a = await q.queryOne('SELECT a.*, s.name AS state_name FROM b2b_accounts a JOIN b2b_states s ON s.id = a.state_id WHERE a.id = ? AND a.account_type = \'retailer\'' + (lock ? ' FOR UPDATE' : ''), [accountId]);
  const t = territories(principal, sm);
  if (!a || (t && t.indexOf(Number(a.territory_id)) === -1)) throw fail(404, 'Retailer not found');
  return a;
}

async function me(principal, sm) {
  const month = new Date().toISOString().slice(0, 7);
  const today = new Date(Date.now() + 330 * 60000).getUTCDay();
  return {
    salesman: { id: Number(sm.id), employeeCode: sm.employee_code, name: principal.name, homeTerritoryId: sm.home_territory_id, cashLimit: sm.cash_limit },
    beatsToday: await db.query('SELECT b.id, b.name, (SELECT COUNT(*) FROM b2b_beat_stops s WHERE s.beat_id = b.id) AS stops FROM b2b_beats b WHERE b.salesman_id = ? AND b.weekday = ? AND b.is_active = 1', [sm.id, today]),
    targets: await db.query('SELECT metric, target_value FROM b2b_sales_targets WHERE salesman_id = ? AND period_month = ?', [sm.id, month]),
    cashInHand: (await db.queryOne("SELECT COALESCE(SUM(amount), 0) AS n FROM b2b_payments WHERE collected_by_salesman_id = ? AND method = 'cash' AND status = 'pending'", [sm.id])).n,
    otpOrdering: (await settings.get('sales.otp')) ? 'enabled' : 'switched off until the OTP rules are approved (pending decision)',
  };
}

async function retailers(principal, sm, q) {
  const where = ["a.account_type = 'retailer'"], params = [];
  const t = territories(principal, sm);
  if (t) { if (!t.length) where.push('1=0'); else { where.push('a.territory_id IN (' + db.placeholders(t) + ')'); params.push.apply(params, t); } }
  if (q.q) { const s = '%' + String(q.q).replace(/[\\%_]/g, '\\$&').slice(0, 60) + '%'; where.push('(a.business_name LIKE ? OR a.shop_name LIKE ? OR a.mobile LIKE ? OR a.pincode LIKE ?)'); params.push(s, s, s, s); }
  if (q.beatId) { where.push('a.id IN (SELECT account_id FROM b2b_beat_stops WHERE beat_id = ?)'); params.push(posId(q.beatId)); }
  return { items: await db.query('SELECT a.id, a.business_name, a.shop_name, a.contact_person, a.mobile, a.city, a.pincode, a.status, a.latitude, a.longitude, a.territory_id FROM b2b_accounts a WHERE ' +
    where.join(' AND ') + ' ORDER BY a.business_name LIMIT ' + db.int(q.limit, 100, 1, 500), params) };
}

/** A retailer registered by a salesman: pending, reviewed by the same B2B admin approval as self-registration. */
async function registerRetailer(tx, actor, principal, sm, b) {
  const name = v.text(b.businessName, 200), contact = v.text(b.contactPerson, 120), mobile = v.mobile(b.mobile);
  need(name && contact, 'Business and contact names are required'); need(mobile, 'A valid 10-digit mobile is required');
  const stateId = posId(b.stateId); need(await tx.queryOne('SELECT id FROM b2b_states WHERE id = ?', [stateId]), 'Choose a state');
  const district = await tx.queryOne('SELECT id, name FROM b2b_districts WHERE id = ? AND state_id = ?', [posId(b.districtId), stateId]);
  need(district, 'Choose a district in the selected state');
  const address = v.text(b.address, 200), city = v.text(b.city, 80); need(address && city, 'Shop address and city are required');
  const pincode = String(b.pincode || ''); need(v.isPincode(pincode), 'Enter a valid pincode');
  const gstin = b.gstin ? v.upper(b.gstin, 15) : null; if (gstin) need(v.isGstin(gstin), 'GSTIN is not valid');
  need(b.locationConsent === true || (b.latitude == null && b.longitude == null), 'Ask the retailer for consent before saving the shop location (locationConsent: true)');
  const lat = v.lat(b.latitude), lng = v.lng(b.longitude);
  const dup = await tx.queryOne("SELECT id FROM b2b_accounts WHERE mobile = ? OR (gstin IS NOT NULL AND gstin = ?)", [mobile, gstin || '-']);
  if (dup) throw fail(409, 'This retailer is already registered', 'duplicate_retailer');
  const flags = ['registered_by_salesman', 'documents_to_collect'];
  const r = await tx.query("INSERT INTO b2b_accounts (account_type, status, business_name, shop_name, contact_person, mobile, email, gstin, pan, address_line1, city, pincode, state_id, district_id, district_name, latitude, longitude, " +
    "risk_flags, registered_by_staff_id, territory_id, location_consent_at) VALUES ('retailer', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " + (lat ? 'UTC_TIMESTAMP()' : 'NULL') + ')',
    [name, v.text(b.shopName, 200) || name, contact, mobile, b.email ? v.email(b.email) : null, gstin, gstin ? gstin.slice(2, 12) : null, address,
      city, pincode, stateId, district.id, district.name, lat, lng, JSON.stringify(flags), principal.id, sm.home_territory_id || null]);
  // The retailer cannot log in until an admin approves the account and sets/sends a password.
  await tx.query("INSERT INTO b2b_users (account_id, name, email, mobile, password_hash, role, is_primary, status) VALUES (?, ?, ?, ?, ?, 'retailer', 1, 'active')",
    [r.insertId, contact, b.email ? v.email(b.email) : null, mobile, security.hashPassword(crypto.randomBytes(24).toString('base64'))]);
  await tx.query("INSERT INTO b2b_account_status_history (account_id, from_status, to_status, reason, actor_type, actor_label) VALUES (?, NULL, 'pending', 'Registered by salesman', 'admin', ?)", [r.insertId, 'erp-staff:' + principal.id]);
  if (lat) await tx.query("INSERT INTO b2b_geo_corrections (account_id, new_lat, new_lng, source, accuracy_m, consent_given, reason, actor_type, actor_id) VALUES (?, ?, ?, 'salesman_gps', ?, 1, 'registration', 'staff', ?)",
    [r.insertId, lat, lng, posId(b.accuracyM) || null, principal.id]);
  await audit.write(tx, actor, { module: 'sales', action: 'retailer.registered', entity: 'account', entityId: r.insertId, new: { name: name, mobile: mobile, pincode: pincode, gstin: gstin } });
  return { accountId: Number(r.insertId), status: 'pending', note: 'An admin reviews and approves the retailer (existing B2B approval) before orders can be placed.' };
}

async function catalogue(principal, sm, q) {
  const retailer = await retailerInScope(db, principal, sm, posId(q.retailerId));
  const where = ['p.is_active = 1', 'p.avail_retailer = 1'], params = [];
  if (q.q) { const s = '%' + String(q.q).replace(/[\\%_]/g, '\\$&').slice(0, 60) + '%'; where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ?)'); params.push(s, s, s); }
  const products = await db.query('SELECT p.* FROM b2b_products p WHERE ' + where.join(' AND ') + ' ORDER BY p.name LIMIT ' + db.int(q.limit, 50, 1, 200), params);
  if (!products.length) return { items: [] };
  const seller = await orders.sellerFor(retailer);
  const qd = await orders.quote(retailer, products.map(function (p) { return { product: p, qty: Math.max(1, Number(p.moq) || 1) }; }), seller);
  const avail = seller.type === 'company' ? await inventory.availability(products.map(function (p) { return Number(p.id); }), (await inventory.companyWarehouses()).map(function (w) { return Number(w.id); })) : null;
  return { seller: seller.type, items: qd.lines.map(function (l) {
    return { productId: Number(l.product.id), sku: l.product.sku, name: l.product.name, mrp: l.product.mrp, moq: l.product.moq, caseQty: l.product.case_qty,
      unitPriceExGst: b2bMoney.fromPaise(l.price.unitPrice), gstRate: l.product.gst_rate, available: avail ? (avail[l.product.id] || 0) : null, problem: l.problem };
  }) };
}

// ── OTP ──
function otpRules(s) {
  need(s && Number.isInteger(s.length), 'Salesman ordering is switched off until the OTP rules (sales.otp) are approved', 'otp_rules_pending');
  return s;
}
function otpHash(challengeId, code) { return crypto.createHmac('sha256', config.tokenSecret()).update('otp:' + challengeId + ':' + code).digest('hex'); }
function newCode(len) { let c = ''; while (c.length < len) c += crypto.randomInt(0, 10); return c; }

/**
 * How the code reaches the retailer:
 *   1. SMS through MSG91 (DLT template MSG91_TEMPLATE_ORDER_OTP, variables otp / order / amount) when configured;
 *   2. otherwise WhatsApp through the existing sender (Meta Cloud API or Twilio) when configured;
 *   3. otherwise it is NOT sent (and not stored in plain text): the salesman uses the approver override.
 * The plain code sits in the queue only until the gateway accepts it; the worker then erases it.
 */
function whatsappConfigured() {
  return !!((process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) || (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN));
}
function otpChannel() {
  if (require('../../b2b/lib/sms-msg91.js').configured('order_otp')) return 'sms';
  if (whatsappConfigured()) return 'whatsapp';
  return null;
}
async function sendCode(tx, challengeId, mobile, len, orderNo, total) {
  const code = newCode(len);
  await tx.query('UPDATE b2b_otp_challenges SET code_hash = ?, last_sent_at = UTC_TIMESTAMP() WHERE id = ?', [otpHash(challengeId, code), challengeId]);
  const channel = otpChannel();
  if (!channel) {
    await tx.query("UPDATE b2b_otp_challenges SET delivery_status = 'failed' WHERE id = ?", [challengeId]);
    await monitor.event('otp', 'warning', 'otp_no_provider', 'Order code for ' + orderNo + ' could not be sent: no SMS (MSG91) or WhatsApp sender configured', { refType: 'otp', refId: challengeId });
    return 'not_sent_no_provider';
  }
  // One outbox path for codes too (N5): a "queued" history row and a record in the notification
  // history without the code; codes are never resent (the outbox and the center both refuse).
  if (channel === 'sms') {
    await notifications.queueCode(tx, { channel: 'sms', mobile: mobile, orderNo: orderNo, challengeId: challengeId, body: '[order code — template order_otp]',
      templateName: 'order_otp', templateParams: { otp: code, order: orderNo, amount: String(total) } });
  } else {
    // Sent as the approved WhatsApp authentication template (WHATSAPP_TEMPLATE_WHATSAPP_OTP): its one parameter is the code.
    await notifications.queueCode(tx, { channel: 'whatsapp', mobile: mobile, orderNo: orderNo, challengeId: challengeId,
      body: 'Your code ' + code + ' confirms order ' + orderNo + ' for Rs ' + total + '. Share it only with our salesman at your shop.', templateName: 'whatsapp_otp', templateParams: [code] });
  }
  await tx.query("UPDATE b2b_otp_challenges SET channel = ?, delivery_status = 'queued' WHERE id = ?", [channel, challengeId]);
  return 'queued';
}

/**
 * Prices (existing engine), inserts and reserves an order in 'pending_otp' — shared by salesman orders
 * (which then wait for the retailer's code) and office orders (which continue at once).
 */
async function buildOrder(tx, actor, account, b, o) {
  const list = Array.isArray(b.items) ? b.items : [];
  need(list.length && list.length <= 300, 'Add 1–300 items');
  const ids = list.map(function (i) { return posId(i.productId); });
  need(ids.every(Boolean) && new Set(ids).size === ids.length, 'Each product once, with a valid id');
  const prods = await tx.query('SELECT * FROM b2b_products WHERE id IN (' + db.placeholders(ids) + ')', ids);
  need(prods.length === ids.length, 'Unknown product');
  const rows = list.map(function (i) { return { product: prods.find(function (p) { return Number(p.id) === posId(i.productId); }), qty: Number(i.qty) }; });
  const seller = await orders.sellerFor(account, tx);
  const qd = await orders.quote(account, rows, seller, tx);
  const bad = qd.lines.filter(function (l) { return l.problem; });
  if (bad.length) throw fail(400, 'Some items need attention', 'items_invalid', { items: bad.map(function (l) { return { productId: Number(l.product.id), error: l.problem }; }) });
  const t = qd.totals;
  const cfg = await b2bSettings.all();
  if (t.grand < b2bMoney.toPaise(cfg['orders.min_order_value'])) throw fail(400, 'The minimum order value is ' + b2bMoney.inr(b2bMoney.toPaise(cfg['orders.min_order_value'])));
  need(t.grand > 0, 'Order total must be greater than zero');
  const ins = await tx.query(
    'INSERT INTO b2b_orders (buyer_account_id, buyer_type, seller_type, seller_account_id, status, is_first_order, payment_method, item_count, total_qty, subtotal, discount_total, taxable_total, ' +
    'cgst_total, sgst_total, igst_total, tax_total, round_off, grand_total, cost_total, seller_state_id, buyer_state_id, buyer_gstin, ship_name, ship_contact, ship_phone, ship_line1, ship_line2, ' +
    "ship_landmark, ship_city, ship_district, ship_state, ship_pincode, ship_lat, ship_lng, buyer_notes, idempotency_key, channel, salesman_id, reservation_expires_at) VALUES (?, ?, ?, ?, 'pending_otp', ?, ?, " +
    "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)",
    [account.id, account.account_type, seller.type, seller.accountId, Number(account.first_order_done) ? 0 : 1, o.method, qd.lines.length, t.qty, b2bMoney.fromPaise(t.subtotal), b2bMoney.fromPaise(t.discount),
      b2bMoney.fromPaise(t.taxable), b2bMoney.fromPaise(t.cgst), b2bMoney.fromPaise(t.sgst), b2bMoney.fromPaise(t.igst), b2bMoney.fromPaise(t.tax), b2bMoney.fromPaise(t.roundOff),
      b2bMoney.fromPaise(t.grand), b2bMoney.fromPaise(t.cost), qd.sellerStateId, account.state_id, account.gstin, account.shop_name || account.business_name, account.contact_person,
      account.mobile, account.address_line1, account.address_line2, account.landmark, account.city, account.district_name, account.state_name, account.pincode, account.latitude,
      account.longitude, v.text(b.notes, 500) || null, o.key.slice(0, 64), o.channel, o.salesmanId || null, o.holdMinutes]);
  const orderId = Number(ins.insertId);
  const d = invoices.istDate();
  const orderNo = 'B2B' + d.slice(2, 4) + d.slice(5, 7) + '-' + String(orderId).padStart(6, '0');   // same format as portal orders
  await tx.bulk('INSERT INTO b2b_order_items (order_id, product_id, sku, name, hsn_code, pack_size, gst_rate, mrp, base_price, list_price, unit_price, price_source, price_rule_id, ' +
    'qty, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, line_total) VALUES ?', qd.lines.map(function (l) {
    const p = l.product, a = l.amounts;
    return [orderId, p.id, p.sku, p.name, p.hsn_code, p.pack_size, p.gst_rate, p.mrp, p.base_price, b2bMoney.fromPaise(l.price.listPrice), b2bMoney.fromPaise(l.price.unitPrice),
      l.price.source, l.price.ruleId, l.qty, b2bMoney.fromPaise(a.discount), b2bMoney.fromPaise(a.taxable), b2bMoney.fromPaise(a.cgst), b2bMoney.fromPaise(a.sgst), b2bMoney.fromPaise(a.igst), b2bMoney.fromPaise(a.total)];
  }));
  await orders.insertFreeLines(tx, orderId, qd.lines);   // buy-N-get-M schemes, same as portal orders
  // Stock is held now (paid + free units; released again if the code is not confirmed in time).
  let wh = null, reserved = false;
  if (seller.type === 'company') { wh = await inventory.reserveForOrder(tx, orderId, orders.reservationLines(qd.lines), await inventory.companyWarehouses(tx), actor); reserved = true; }
  else if (cfg['inventory.track_distributor_stock']) { wh = await inventory.reserveForOrder(tx, orderId, orders.reservationLines(qd.lines), await inventory.distributorWarehouses(seller.accountId, tx), actor); reserved = true; }
  await tx.query('UPDATE b2b_orders SET order_no = ?, warehouse_id = ?, stock_reserved = ? WHERE id = ?', [orderNo, wh, reserved ? 1 : 0, orderId]);
  await orders.history(tx, orderId, null, 'pending_otp', o.historyNote, { type: 'admin', label: o.actorLabel });
  return { orderId: orderId, orderNo: orderNo, totals: t, qd: qd };
}

async function createOrder(tx, actor, principal, sm, b) {
  const rules = otpRules(await settings.get('sales.otp'));
  const clientUuid = String(b.clientUuid || '');
  need(/^[0-9a-f-]{36}$/i.test(clientUuid), 'clientUuid (a UUID made by the app) is required so a retry never makes a second order');
  const method = String(b.paymentMethod || '');
  need(['upi', 'bank_transfer', 'credit'].indexOf(method) !== -1, 'paymentMethod must be upi, bank_transfer or credit');
  const account = await retailerInScope(tx, principal, sm, posId(b.retailerId), true);
  if (account.status !== 'approved') throw fail(409, 'This retailer is not approved yet', 'retailer_not_approved');
  const key = 'sm-' + clientUuid.toLowerCase();
  const dup = await tx.queryOne('SELECT id, order_no, status, grand_total FROM b2b_orders WHERE buyer_account_id = ? AND idempotency_key = ?', [account.id, key.slice(0, 64)]);
  if (dup) return { orderId: Number(dup.id), orderNo: dup.order_no, status: dup.status, duplicate: true };
  const open = await tx.queryOne("SELECT id FROM b2b_orders WHERE buyer_account_id = ? AND status = 'pending_otp'", [account.id]);
  if (open) throw fail(409, 'This retailer already has an order waiting for its code', 'otp_order_open');
  const built = await buildOrder(tx, actor, account, b, { key: key, method: method, channel: 'salesman', salesmanId: sm.id, holdMinutes: Number(rules.stock_hold_min),
    historyNote: 'Created by salesman; waiting for the retailer\'s code', actorLabel: 'erp-staff:' + principal.id });
  const orderId = built.orderId, orderNo = built.orderNo, t = built.totals, qd = built.qd;
  const ch = await tx.query("INSERT INTO b2b_otp_challenges (purpose, order_id, account_id, mobile, code_hash, expires_at, attempts, resends, last_sent_at, channel, delivery_status, status, requested_by_staff, open_order_id) " +
    "VALUES ('order_confirm', ?, ?, ?, '-', UTC_TIMESTAMP() + INTERVAL ? MINUTE, 0, 0, UTC_TIMESTAMP(), 'sms', 'queued', 'pending', ?, ?)",
    [orderId, account.id, account.mobile, Number(rules.expiry_min), principal.id, orderId]);
  const delivery = await sendCode(tx, ch.insertId, account.mobile, Number(rules.length), orderNo, b2bMoney.fromPaise(t.grand));
  await audit.write(tx, actor, { module: 'sales', action: 'order.created_pending_otp', entity: 'order', entityId: orderId, new: { orderNo: orderNo, retailerId: Number(account.id), grandTotal: b2bMoney.fromPaise(t.grand), lines: qd.lines.length } });
  return { orderId: orderId, orderNo: orderNo, status: 'pending_otp', grandTotal: b2bMoney.fromPaise(t.grand), codeSentTo: 'XXXXXX' + String(account.mobile).slice(-4), delivery: delivery, expiresInMinutes: Number(rules.expiry_min),
    note: delivery === 'queued' ? undefined : 'No SMS (MSG91) or WhatsApp sender is configured, so the code was not sent. Ask an approver for an override.' };
}

async function challengeFor(tx, principal, sm, orderId) {
  const o = await tx.queryOne("SELECT * FROM b2b_orders WHERE id = ? AND salesman_id = ? FOR UPDATE", [orderId, sm.id]);
  if (!o) throw fail(404, 'Order not found');
  await retailerInScope(tx, principal, sm, o.buyer_account_id);
  const ch = await tx.queryOne("SELECT * FROM b2b_otp_challenges WHERE order_id = ? AND purpose = 'order_confirm' ORDER BY id DESC LIMIT 1 FOR UPDATE", [orderId]);
  return { order: o, ch: ch };
}

async function resend(tx, actor, principal, sm, orderId) {
  const rules = otpRules(await settings.get('sales.otp'));
  const { order, ch } = await challengeFor(tx, principal, sm, orderId);
  if (order.status !== 'pending_otp' || !ch || ch.status !== 'pending') throw fail(409, 'This order is not waiting for a code');
  if (Number(ch.resends) >= Number(rules.max_resends)) throw fail(429, 'No more resends allowed for this order', 'max_resends');
  const since = (Date.now() - new Date(ch.last_sent_at).getTime()) / 1000;
  if (since < Number(rules.resend_cooldown_s)) throw fail(429, 'Wait ' + Math.ceil(Number(rules.resend_cooldown_s) - since) + ' s before resending', 'cooldown');
  await tx.query('UPDATE b2b_otp_challenges SET resends = resends + 1, attempts = 0, expires_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id = ?', [Number(rules.expiry_min), ch.id]);
  const delivery = await sendCode(tx, ch.id, ch.mobile, Number(rules.length), order.order_no, order.grand_total);
  return { orderId: orderId, resent: delivery === 'queued', delivery: delivery, resendsLeft: Number(rules.max_resends) - Number(ch.resends) - 1 };
}

/** The checks run, then the order continues like a portal order. */
async function verify(tx, actor, principal, sm, orderId, code) {
  const rules = otpRules(await settings.get('sales.otp'));
  const { order, ch } = await challengeFor(tx, principal, sm, orderId);
  if (order.status !== 'pending_otp' || !ch) throw fail(409, 'This order is not waiting for a code', 'not_pending');
  const log = function (outcome) { return tx.query('INSERT INTO b2b_otp_attempts (challenge_id, outcome, ip) VALUES (?, ?, ?)', [ch.id, outcome, actor.ip || null]); };
  if (ch.status !== 'pending') { await log('locked'); throw fail(409, 'This code can no longer be used (' + ch.status + ')', 'otp_' + ch.status); }
  if (new Date(ch.expires_at).getTime() < Date.now()) { await log('expired'); throw fail(400, 'The code has expired. Resend a new one.', 'otp_expired'); }
  const ok = /^\d+$/.test(String(code || '')) && crypto.timingSafeEqual(Buffer.from(otpHash(ch.id, String(code))), Buffer.from(ch.code_hash.length === 64 ? ch.code_hash : '0'.repeat(64)));
  if (!ok) {
    const attempts = Number(ch.attempts) + 1;
    const locked = attempts >= Number(rules.max_attempts);
    await tx.query('UPDATE b2b_otp_challenges SET attempts = ?, status = ? WHERE id = ?', [attempts, locked ? 'locked' : 'pending', ch.id]);
    await log(locked ? 'locked' : 'wrong');
    await monitor.event('otp', locked ? 'warning' : 'info', locked ? 'otp_locked' : 'otp_wrong', 'Wrong order code for order ' + order.order_no, { actorType: 'staff', actorId: principal.id, refType: 'order', refId: orderId });
    // Throwing would roll back the attempt counter, so the failure is returned, not thrown.
    return { ok: false, status: 409, error: locked ? 'Too many wrong codes. Ask for an override or create the order again.' : 'Wrong code', code: locked ? 'otp_locked' : 'otp_wrong', attemptsLeft: Math.max(0, Number(rules.max_attempts) - attempts) };
  }
  await tx.query("UPDATE b2b_otp_challenges SET status = 'verified', verified_at = UTC_TIMESTAMP(), open_order_id = NULL WHERE id = ?", [ch.id]);
  await log('ok');
  const r = await continueOrder(tx, actor, order, 'Retailer confirmed with one-time code');
  await tx.query('UPDATE b2b_orders SET otp_verified_at = UTC_TIMESTAMP() WHERE id = ?', [orderId]);
  return Object.assign({ ok: true }, r);
}

/** Same steps placeOrder runs after the insert: credit, approval rule, assignment, notifications. */
async function continueOrder(tx, actor, order, note) {
  const account = await tx.queryOne('SELECT * FROM b2b_accounts WHERE id = ? FOR UPDATE', [order.buyer_account_id]);
  if (account.status !== 'approved') throw fail(409, 'The customer is no longer approved');
  const cfg = await b2bSettings.all();
  const label = { type: 'admin', label: actor.label || 'erp' };
  if (order.payment_method === 'credit') {
    await payments.debit(tx, { debtorId: account.id, creditorId: order.seller_account_id || 0, amount: b2bMoney.toPaise(order.grand_total), orderId: order.id, note: 'Order ' + order.order_no, actor: label });
  }
  const firstOrder = !Number(account.first_order_done);
  const needsApproval = firstOrder && !!cfg['orders.first_order_approval'];
  let status = order.status || 'pending_otp';
  const hop = async function (to, n) { await orders.history(tx, order.id, status, to, n, label); status = to; };
  await hop('submitted', note);
  if (needsApproval) await hop('pending_admin_approval', 'First order — needs admin approval');
  else { await hop('approved', 'Auto-approved'); await hop('assigned', order.seller_type === 'distributor' ? 'Assigned to mapped distributor' : 'Assigned to company fulfilment'); }
  await tx.query('UPDATE b2b_orders SET status = ?, submitted_at = UTC_TIMESTAMP(), reservation_expires_at = NULL' + (needsApproval ? '' : ', approved_at = UTC_TIMESTAMP(), assigned_at = UTC_TIMESTAMP()') + ' WHERE id = ?', [status, order.id]);
  if (!needsApproval && firstOrder) await tx.query('UPDATE b2b_accounts SET first_order_done = 1 WHERE id = ?', [account.id]);
  await notifications.notifyAccount(tx, account.id, { title: 'Order ' + order.order_no + ' confirmed', lines: ['You confirmed the order taken by our salesman for ' + b2bMoney.inr(b2bMoney.toPaise(order.grand_total)) + '.'], link: '/b2b/orders/' + order.id, refType: 'order', refId: order.id });
  if (order.seller_type === 'distributor' && !needsApproval) {
    await notifications.notifyAccount(tx, order.seller_account_id, { title: 'New retailer order ' + order.order_no, lines: [(account.shop_name || account.business_name) + ' · ' + account.city, 'Taken by our salesman and confirmed by the retailer.'], link: '/b2b/retailer-orders/' + order.id, refType: 'order', refId: order.id });
  }
  await audit.write(tx, actor, { module: 'sales', action: 'order.confirmed', entity: 'order', entityId: order.id, new: { status: status }, reason: note });
  return { orderId: Number(order.id), orderNo: order.order_no, status: status };
}

async function requestOverride(tx, actor, principal, sm, orderId, reason) {
  const { order } = await challengeFor(tx, principal, sm, orderId);
  if (order.status !== 'pending_otp') throw fail(409, 'This order is not waiting for a code');
  need(reason && String(reason).trim().length >= 10, 'Explain why the retailer cannot give the code (10+ characters)');
  const a = await approvals.request(tx, actor, { type: 'sales.otp_override', entity: 'order', entityId: orderId, amount: order.grand_total, reason: reason, payload: { orderNo: order.order_no } });
  await audit.write(tx, actor, { module: 'sales', action: 'otp.override_requested', entity: 'order', entityId: orderId, reason: reason, approvalId: a.approvalId });
  return a;
}
approvals.register('sales.otp_override', async function (tx, req, actor) {
  const o = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!o || o.status !== 'pending_otp') throw fail(409, 'The order is no longer waiting for a code');
  await tx.query("UPDATE b2b_otp_challenges SET status = 'cancelled', open_order_id = NULL WHERE order_id = ? AND status IN ('pending','locked')", [o.id]);
  await tx.query('UPDATE b2b_orders SET otp_override_approval_id = ? WHERE id = ?', [req.id, o.id]);
  return continueOrder(tx, actor, o, 'Confirmed by approver override #' + req.id);
});

/** Background job: release stock held by orders whose code was never confirmed. */
async function expireHolds() {
  const due = await db.query("SELECT id FROM b2b_orders WHERE status = 'pending_otp' AND reservation_expires_at < UTC_TIMESTAMP() LIMIT 100");
  let n = 0;
  for (const d of due) {
    await db.transaction(async function (tx) {
      const o = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [d.id]);
      if (!o || o.status !== 'pending_otp') return;
      const items = await tx.query('SELECT * FROM b2b_order_items WHERE order_id = ?', [o.id]);
      await inventory.releaseForOrder(tx, o, items, { type: 'system', label: 'otp-expiry' }, 'Retailer code not confirmed in time');
      await tx.query("UPDATE b2b_orders SET status = 'otp_expired', stock_reserved = 0, cancelled_at = UTC_TIMESTAMP(), cancel_reason = 'Code not confirmed in time' WHERE id = ?", [o.id]);
      await tx.query("UPDATE b2b_otp_challenges SET status = 'expired', open_order_id = NULL WHERE order_id = ? AND status IN ('pending','locked')", [o.id]);
      await orders.history(tx, o.id, 'pending_otp', 'otp_expired', 'Stock hold released', { type: 'system', label: 'system' });
      await audit.write(tx, audit.SYSTEM, { module: 'sales', action: 'order.otp_expired', entity: 'order', entityId: o.id });
      n++;
    });
  }
  return { expired: n };
}

// ── visits and collections ──
async function checkIn(tx, actor, principal, sm, b) {
  const uuid = String(b.clientUuid || ''); need(/^[0-9a-f-]{36}$/i.test(uuid), 'clientUuid is required');
  const dup = await tx.queryOne('SELECT id FROM b2b_visits WHERE client_uuid = ?', [uuid]);
  if (dup) return { visitId: Number(dup.id), duplicate: true };
  const a = await retailerInScope(tx, principal, sm, posId(b.retailerId));
  const lat = v.lat(b.latitude), lng = v.lng(b.longitude);
  let dist = null;
  if (lat && lng && a.latitude != null) dist = Math.round(require('../../b2b/mappings/service.js').haversineKm(Number(lat), Number(lng), Number(a.latitude), Number(a.longitude)) * 1000);
  const outcome = b.outcome && ['order', 'no_order', 'shop_closed', 'collection_only', 'new_registration'].indexOf(b.outcome) !== -1 ? b.outcome : null;
  const r = await tx.query('INSERT INTO b2b_visits (salesman_id, account_id, beat_id, checked_in_at, lat, lng, distance_m, outcome, note, client_uuid) VALUES (?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?)',
    [sm.id, a.id, posId(b.beatId) || null, lat, lng, dist, outcome, v.text(b.note, 255) || null, uuid]);
  return { visitId: Number(r.insertId), distanceFromShopM: dist, flagged: dist != null && dist > 300 ? 'more than 300 m from the saved shop location' : null };
}

async function collect(tx, actor, principal, sm, b) {
  const uuid = String(b.clientUuid || ''); need(/^[0-9a-f-]{36}$/i.test(uuid), 'clientUuid is required');
  const dup = await tx.queryOne('SELECT id, receipt_no FROM b2b_payments WHERE client_uuid = ?', [uuid]);
  if (dup) return { paymentId: Number(dup.id), receiptNo: dup.receipt_no, duplicate: true };
  const order = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [posId(b.orderId)]);
  if (!order) throw fail(404, 'Order not found');
  await retailerInScope(tx, principal, sm, order.buyer_account_id);
  need(['cancelled', 'rejected', 'refunded', 'pending_otp', 'otp_expired'].indexOf(order.status) === -1, 'Payments cannot be collected for this order (' + order.status + ')');
  const method = ['cash', 'upi', 'cheque'].indexOf(b.method) === -1 ? null : b.method; need(method, 'method must be cash, upi or cheque');
  const amt = b2bMoney.toPaise(v.decimal(b.amount, 2, 99999999) || 0); need(amt > 0, 'Enter the amount');
  const pendingOnOrder = await tx.queryOne("SELECT COALESCE(SUM(amount), 0) AS n FROM b2b_payments WHERE order_id = ? AND status = 'pending'", [order.id]);
  const outstanding = b2bMoney.toPaise(order.grand_total) - b2bMoney.toPaise(order.amount_paid) - b2bMoney.toPaise(pendingOnOrder.n);
  need(amt <= outstanding, 'More than the amount still due (' + b2bMoney.fromPaise(outstanding) + ')', 'over_collection');
  if (method === 'cash') {
    const held = await tx.queryOne("SELECT COALESCE(SUM(amount), 0) AS n FROM b2b_payments WHERE collected_by_salesman_id = ? AND method = 'cash' AND status = 'pending'", [sm.id]);
    need(b2bMoney.toPaise(held.n) + amt <= b2bMoney.toPaise(sm.cash_limit), 'Your cash limit would be exceeded; hand over cash first', 'cash_limit');
  }
  if (method !== 'cash') need(v.text(b.reference, 120).length >= 4, 'Enter the UPI / cheque reference');
  const receipt = await seq.next(tx, 'RCPT');
  const r = await tx.query("INSERT INTO b2b_payments (order_id, payer_account_id, payee_type, payee_account_id, method, amount, reference, status, note, recorded_by, received_at, receipt_no, client_uuid, collected_by_salesman_id) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'Collected by salesman; applied when the handover is confirmed', ?, UTC_TIMESTAMP(), ?, ?, ?)",
    [order.id, order.buyer_account_id, order.seller_type, order.seller_account_id, method, b2bMoney.fromPaise(amt), v.text(b.reference, 120) || null, 'erp-staff:' + principal.id, receipt.slice(0, 24), uuid, sm.id]);
  await audit.write(tx, actor, { module: 'sales', action: 'collection.recorded', entity: 'order', entityId: order.id, new: { paymentId: Number(r.insertId), receipt: receipt, method: method, amount: b2bMoney.fromPaise(amt) } });
  return { paymentId: Number(r.insertId), receiptNo: receipt, status: 'pending_handover' };
}

/** Finance confirms the cash/UPI reached the company; only then is it applied to the order (existing payment code). */
async function confirmHandover(tx, actor, paymentId) {
  const p = await tx.queryOne("SELECT * FROM b2b_payments WHERE id = ? AND collected_by_salesman_id IS NOT NULL FOR UPDATE", [paymentId]);
  if (!p) throw fail(404, 'Collection not found');
  if (p.status !== 'pending') throw fail(409, 'Already ' + p.status);
  const sm = await tx.queryOne('SELECT staff_id FROM b2b_salesmen WHERE id = ?', [p.collected_by_salesman_id]);
  if (Number(sm.staff_id) === Number(actor.id)) throw fail(403, 'The collector cannot confirm their own handover', 'maker_cannot_check');
  const order = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [p.order_id]);
  await payments.applyToOrder(tx, order, { amount: b2bMoney.toPaise(p.amount), method: p.method, existingPaymentId: p.id, actor: { type: 'admin', label: 'erp-staff:' + actor.id } });
  await tx.query('UPDATE b2b_payments SET handover_confirmed_by = ?, handover_confirmed_at = UTC_TIMESTAMP() WHERE id = ?', [actor.id, p.id]);
  await audit.write(tx, actor, { module: 'sales', action: 'collection.confirmed', entity: 'order', entityId: p.order_id, new: { paymentId: paymentId, amount: p.amount } });
  return { paymentId: paymentId, status: 'received' };
}

async function addSalesman(tx, actor, b) {
  const s = await tx.queryOne("SELECT id FROM b2b_staff WHERE id = ? AND status = 'active'", [posId(b.staffId)]);
  need(s, 'Unknown staff member');
  const limit = b2bMoney.toPaise(v.decimal(b.cashLimit, 2, 9999999) || 0);
  try {
    const r = await tx.query('INSERT INTO b2b_salesmen (staff_id, employee_code, home_territory_id, default_warehouse_id, cash_limit, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [s.id, v.text(b.employeeCode, 30) || null, posId(b.homeTerritoryId) || null, posId(b.defaultWarehouseId) || null, b2bMoney.fromPaise(limit)]);
    await audit.write(tx, actor, { module: 'sales', action: 'salesman.created', entity: 'staff', entityId: s.id, new: b });
    return { salesmanId: Number(r.insertId) };
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'Already a salesman or employee code in use'); throw e; }
}

module.exports = { buildOrder, continueOrder, requireSalesman, me, retailers, registerRetailer, catalogue, createOrder, resend, verify, requestOverride, expireHolds, checkIn, collect, confirmHandover, addSalesman, otpHash };
