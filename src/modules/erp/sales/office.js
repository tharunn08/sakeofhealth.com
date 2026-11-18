/**
 * Office sales desk and salesman management:
 *   - office orders: staff place an order for an approved customer (retailer, distributor, or super
 *     stockist when that tier is enabled). Same pricing, stock and approval rules as portal orders.
 *     The order value must be approved by a second person first (it skips the customer's own login).
 *   - super-stockist accounts: created from the office only when the "pricing.tiers_enabled" decision
 *     includes super_stockist; activation needs a second person.
 *   - beats (routes with ordered stops), monthly targets, and achievement against them.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const settings = require('../core/settings.js');
const sales = require('./service.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }
async function tiers() { const t = await settings.get('pricing.tiers_enabled'); return Array.isArray(t) && t.length ? t : ['retailer', 'distributor']; }

// ── office orders ──
async function requestOfficeOrder(tx, actor, b) {
  const account = await tx.queryOne("SELECT a.*, s.name AS state_name FROM b2b_accounts a JOIN b2b_states s ON s.id = a.state_id WHERE a.id = ? FOR UPDATE", [posId(b.accountId)]);
  need(account, 'Unknown customer');
  need(account.status === 'approved', 'The customer is not approved', 'not_approved');
  const enabled = await tiers();
  need(enabled.indexOf(account.account_type) !== -1, 'Selling to ' + account.account_type.replace('_', ' ') + 's is not enabled (business decision: pricing tiers)', 'tier_not_enabled');
  const method = String(b.paymentMethod || ''); need(['upi', 'bank_transfer', 'credit'].indexOf(method) !== -1, 'paymentMethod must be upi, bank_transfer or credit');
  need(b.reason && String(b.reason).trim().length >= 10, 'Say who asked for this order and how (10+ characters)');
  const key = 'office-' + (b.clientUuid && /^[0-9a-f-]{36}$/i.test(b.clientUuid) ? b.clientUuid.toLowerCase() : crypto.randomUUID());
  const dup = await tx.queryOne('SELECT id, order_no, status FROM b2b_orders WHERE buyer_account_id = ? AND idempotency_key = ?', [account.id, key.slice(0, 64)]);
  if (dup) return { orderId: Number(dup.id), orderNo: dup.order_no, status: dup.status, duplicate: true };
  if (account.account_type === 'super_stockist') {
    // never priced from a default margin: every product needs its published super-stockist price
    const ids = (b.items || []).map(function (i) { return posId(i.productId); }).filter(Boolean);
    need(ids.length, 'Add at least one item');
    const missing = await tx.query('SELECT id, sku FROM b2b_products WHERE id IN (' + db.placeholders(ids) + ') AND (super_stockist_price IS NULL OR avail_super_stockist = 0)', ids);
    need(!missing.length, 'No published super-stockist price for: ' + missing.map(function (m) { return m.sku; }).join(', '), 'no_ss_price');
  }
  const built = await sales.buildOrder(tx, actor, account, b, { key: key, method: method, channel: 'admin', salesmanId: null, holdMinutes: 60 * 24,
    historyNote: 'Office order by staff #' + actor.id + ' — waiting for approval', actorLabel: 'erp-staff:' + actor.id });
  const a = await approvals.request(tx, actor, { type: 'sales.office_order', entity: 'order', entityId: built.orderId, amount: (built.totals.grand / 100).toFixed(2), reason: b.reason, payload: { orderNo: built.orderNo } });
  await audit.write(tx, actor, { module: 'sales', action: 'office_order.requested', entity: 'order', entityId: built.orderId, new: { orderNo: built.orderNo, accountId: Number(account.id) }, reason: b.reason, approvalId: a.approvalId });
  return Object.assign({}, a, { orderId: built.orderId, orderNo: built.orderNo, grandTotal: (built.totals.grand / 100).toFixed(2), status: 'pending_approval',
    note: 'Stock is held for 24 hours while the order waits for approval.' });
}
approvals.register('sales.office_order', async function (tx, req, actor) {
  const o = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!o || o.status !== 'pending_otp') throw fail(409, 'The order is no longer waiting (' + (o && o.status) + ')');
  return sales.continueOrder(tx, actor, o, 'Office order approved (#' + req.id + ')');
});

// ── super stockist accounts ──
async function createAccount(tx, actor, b) {
  need(b.accountType === 'super_stockist', 'Only super-stockist accounts are created here; retailers and distributors register themselves or via a salesman');
  need((await tiers()).indexOf('super_stockist') !== -1, 'The super-stockist tier is not enabled (business decision: pricing tiers)', 'tier_not_enabled');
  const name = v.text(b.businessName, 160), contact = v.text(b.contactPerson, 120), mobile = v.mobile(b.mobile);
  need(name && contact && mobile, 'Business name, contact person and mobile are required');
  const gstin = v.upper(b.gstin, 15); need(v.isGstin(gstin), 'A valid GSTIN is required for a super stockist');
  const state = await tx.queryOne('SELECT id FROM b2b_states WHERE gst_code = ?', [gstin.slice(0, 2)]); need(state, 'Unknown GST state');
  const district = await tx.queryOne('SELECT id, name FROM b2b_districts WHERE id = ? AND state_id = ?', [posId(b.districtId), state.id]); need(district, 'Choose a district in the GSTIN\'s state');
  const address = v.text(b.address, 200), city = v.text(b.city, 80), pincode = String(b.pincode || '');
  need(address && city && v.isPincode(pincode), 'Address, city and pincode are required');
  if (await tx.queryOne('SELECT id FROM b2b_accounts WHERE gstin = ? OR mobile = ?', [gstin, mobile])) throw fail(409, 'An account with this GSTIN or mobile exists', 'duplicate_account');
  const r = await tx.query("INSERT INTO b2b_accounts (account_type, status, business_name, contact_person, mobile, email, gstin, pan, address_line1, city, pincode, state_id, district_id, district_name, risk_flags, registered_by_staff_id) " +
    "VALUES ('super_stockist', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[\"created_by_office\"]', ?)",
    [name, contact, mobile, b.email ? v.email(b.email) : null, gstin, gstin.slice(2, 12), address, city, pincode, state.id, district.id, district.name, actor.id]);
  await tx.query("INSERT INTO b2b_account_status_history (account_id, from_status, to_status, reason, actor_type, actor_label) VALUES (?, NULL, 'pending', 'Created by office', 'admin', ?)", [r.insertId, 'erp-staff:' + actor.id]);
  const a = await approvals.request(tx, actor, { type: 'network.account_activate', entity: 'account', entityId: r.insertId, reason: b.reason || 'New super stockist ' + name, payload: { name: name, gstin: gstin } });
  await audit.write(tx, actor, { module: 'network', action: 'account.created', entity: 'account', entityId: r.insertId, new: { type: 'super_stockist', name: name, gstin: gstin }, approvalId: a.approvalId });
  return Object.assign({}, a, { accountId: Number(r.insertId), status: 'pending' });
}
approvals.register('network.account_activate', async function (tx, req, actor) {
  const a = await tx.queryOne('SELECT id, status FROM b2b_accounts WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!a || a.status !== 'pending') throw fail(409, 'Account is no longer pending');
  await tx.query("UPDATE b2b_accounts SET status = 'approved', approved_at = UTC_TIMESTAMP(), approved_by = ? WHERE id = ?", ['erp-approval:' + req.id, a.id]);
  await tx.query("INSERT INTO b2b_account_status_history (account_id, from_status, to_status, reason, actor_type, actor_label) VALUES (?, 'pending', 'approved', 'Approved', 'admin', ?)", [a.id, 'erp-approval:' + req.id]);
  await audit.write(tx, actor, { module: 'network', action: 'account.approved', entity: 'account', entityId: a.id, approvalId: req.id });
  return { accountId: Number(a.id), status: 'approved' };
});

// ── beats and targets ──
async function salesmanRow(q, id) { const s = await q.queryOne('SELECT * FROM b2b_salesmen WHERE id = ?', [posId(id)]); need(s, 'Unknown salesman'); return s; }

async function saveBeat(tx, actor, b, beatId) {
  const sm = await salesmanRow(tx, b.salesmanId);
  const name = v.text(b.name, 120); need(name, 'Beat name is required');
  const day = Number(b.weekday); need(Number.isInteger(day) && day >= 0 && day <= 6, 'weekday: 0 = Sunday … 6 = Saturday');
  const stops = Array.from(new Set((b.stops || []).map(posId).filter(Boolean))); need(stops.length <= 200, 'At most 200 stops');
  if (stops.length) {
    const rows = await tx.query("SELECT id, account_type, territory_id FROM b2b_accounts WHERE id IN (" + db.placeholders(stops) + ')', stops);
    need(rows.length === stops.length && rows.every(function (r) { return r.account_type === 'retailer'; }), 'Stops must be retailers');
    const terr = posId(b.territoryId) || sm.home_territory_id;
    if (terr) need(rows.every(function (r) { return Number(r.territory_id) === Number(terr); }), 'Every stop must be in the beat\'s territory', 'outside_territory');
  }
  let id = beatId;
  if (id) {
    const ex = await tx.queryOne('SELECT id FROM b2b_beats WHERE id = ? FOR UPDATE', [id]); need(ex, 'Unknown beat');
    await tx.query('UPDATE b2b_beats SET salesman_id = ?, name = ?, weekday = ?, territory_id = ?, is_active = ? WHERE id = ?', [sm.id, name, day, posId(b.territoryId) || sm.home_territory_id || null, b.isActive === false ? 0 : 1, id]);
    await tx.query('DELETE FROM b2b_beat_stops WHERE beat_id = ?', [id]);   // the stop list is replaced as a whole (plan data, audited below)
  } else {
    id = Number((await tx.query('INSERT INTO b2b_beats (salesman_id, name, weekday, territory_id, is_active) VALUES (?, ?, ?, ?, 1)', [sm.id, name, day, posId(b.territoryId) || sm.home_territory_id || null])).insertId);
  }
  for (let i = 0; i < stops.length; i++) await tx.query('INSERT INTO b2b_beat_stops (beat_id, account_id, seq) VALUES (?, ?, ?)', [id, stops[i], i + 1]);
  await audit.write(tx, actor, { module: 'sales', action: beatId ? 'beat.updated' : 'beat.created', entity: 'beat', entityId: id, new: { salesmanId: Number(sm.id), name: name, weekday: day, stops: stops } });
  return { beatId: id, stops: stops.length };
}
async function listBeats(q) {
  const where = ['1=1'], params = [];
  if (q.salesmanId) { where.push('b.salesman_id = ?'); params.push(posId(q.salesmanId)); }
  return { items: await db.query('SELECT b.*, (SELECT COUNT(*) FROM b2b_beat_stops s WHERE s.beat_id = b.id) AS stops FROM b2b_beats b WHERE ' + where.join(' AND ') + ' ORDER BY b.salesman_id, b.weekday LIMIT 500', params) };
}

const METRICS = ['sales_value', 'orders', 'new_retailers', 'collections', 'visits'];
async function setTarget(tx, actor, b) {
  const sm = await salesmanRow(tx, b.salesmanId);
  need(/^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.month || '')), 'month must be YYYY-MM');
  need(METRICS.indexOf(b.metric) !== -1, 'metric must be one of ' + METRICS.join(', '));
  const val = Number(b.value); need(val >= 0 && val < 1e10, 'value must be a positive number');
  await tx.query('INSERT INTO b2b_sales_targets (salesman_id, period_month, metric, target_value, set_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE target_value = VALUES(target_value), set_by = VALUES(set_by)',
    [sm.id, b.month, b.metric, val.toFixed(2), actor.id]);
  await audit.write(tx, actor, { module: 'sales', action: 'target.set', entity: 'salesman', entityId: sm.id, new: { month: b.month, metric: b.metric, value: val } });
  return { ok: true };
}

/** Achievement per salesman for a month (IST month boundaries approximated by UTC dates). */
async function performance(q) {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.month || '')) ? q.month : new Date().toISOString().slice(0, 7);
  const from = month + '-01';
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const men = await db.query('SELECT sm.id, sm.employee_code, st.name, sm.staff_id FROM b2b_salesmen sm JOIN b2b_staff st ON st.id = sm.staff_id WHERE sm.is_active = 1 ORDER BY st.name');
  const out = [];
  for (const m of men) {
    const o = await db.queryOne("SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS v FROM b2b_orders WHERE salesman_id = ? AND status NOT IN ('pending_otp','otp_expired','cancelled','rejected') AND DATE(created_at) BETWEEN ? AND ?", [m.id, from, to]);
    const r = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_accounts WHERE registered_by_staff_id = ? AND DATE(created_at) BETWEEN ? AND ?', [m.staff_id, from, to]);
    const c = await db.queryOne("SELECT COALESCE(SUM(amount), 0) AS v FROM b2b_payments WHERE collected_by_salesman_id = ? AND status = 'received' AND DATE(received_at) BETWEEN ? AND ?", [m.id, from, to]);
    const vis = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_visits WHERE salesman_id = ? AND DATE(checked_in_at) BETWEEN ? AND ?', [m.id, from, to]);
    const t = {}; (await db.query('SELECT metric, target_value FROM b2b_sales_targets WHERE salesman_id = ? AND period_month = ?', [m.id, month])).forEach(function (x) { t[x.metric] = Number(x.target_value); });
    const actual = { sales_value: Number(Number(o.v).toFixed(2)), orders: Number(o.n), new_retailers: Number(r.n), collections: Number(Number(c.v).toFixed(2)), visits: Number(vis.n) };
    const pct = {}; METRICS.forEach(function (k) { pct[k] = t[k] ? Math.round(actual[k] * 1000 / t[k]) / 10 : null; });
    out.push({ salesmanId: Number(m.id), name: m.name, employeeCode: m.employee_code, actual: actual, target: t, achievementPct: pct });
  }
  return { month: month, items: out, basis: 'Orders confirmed by the retailer (not expired/cancelled), accounts the salesman registered, collections confirmed by finance, visits checked in.' };
}

module.exports = { requestOfficeOrder, createAccount, saveBeat, listBeats, setTarget, performance };
