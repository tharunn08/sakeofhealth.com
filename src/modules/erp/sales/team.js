/**
 * Salesmen — the admin "Salesmen" screen and the salesman's own dashboard.
 *
 * Reads the same tables the field app writes (b2b_salesmen, b2b_orders.salesman_id, b2b_visits,
 * b2b_payments.collected_by_salesman_id, b2b_beats, b2b_sales_targets, b2b_location_pings). Money is
 * reported the way the sales desk reports it: orders the retailer confirmed (not pending/expired/cancelled/
 * rejected), collections confirmed by finance, cash in hand = cash collected and not yet handed over.
 */
'use strict';
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const audit = require('../core/audit.js');
const { fail, posId } = require('../lib/http.js');

const LIVE = "status NOT IN ('pending_otp','otp_expired','cancelled','rejected')";
const IST = 330;   // business day in India time
function istToday() { return new Date(Date.now() + IST * 60000).toISOString().slice(0, 10); }
function istWeekday() { return new Date(Date.now() + IST * 60000).getUTCDay(); }
function monthBounds(month) {
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '')) ? month : istToday().slice(0, 7);
  const to = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return { month: m, from: m + '-01', to: to };
}
const money = function (x) { return Number(Number(x || 0).toFixed(2)); };
// "today" in IST as a UTC range for DATETIME columns stored in UTC
function istDayRange(day) {
  const start = new Date(Date.parse(day + 'T00:00:00Z') - IST * 60000);
  const end = new Date(start.getTime() + 86400000);
  const f = function (d) { return d.toISOString().slice(0, 19).replace('T', ' '); };
  return [f(start), f(end)];
}
async function optional(fn, fallback) {
  try { return await fn(); } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || e.errno === 1054) return fallback; throw e; }
}

async function numbers(sm, month) {
  const b = monthBounds(month), today = istDayRange(istToday());
  const o = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS v FROM b2b_orders WHERE salesman_id = ? AND ' + LIVE + ' AND DATE(created_at) BETWEEN ? AND ?', [sm, b.from, b.to]);
  const ot = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS v FROM b2b_orders WHERE salesman_id = ? AND ' + LIVE + ' AND created_at >= ? AND created_at < ?', [sm, today[0], today[1]]);
  const vt = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_visits WHERE salesman_id = ? AND checked_in_at >= ? AND checked_in_at < ?', [sm, today[0], today[1]]);
  const vm = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_visits WHERE salesman_id = ? AND DATE(checked_in_at) BETWEEN ? AND ?', [sm, b.from, b.to]);
  const ct = await db.queryOne("SELECT COALESCE(SUM(amount), 0) AS v FROM b2b_payments WHERE collected_by_salesman_id = ? AND status IN ('pending','received') AND received_at >= ? AND received_at < ?", [sm, today[0], today[1]]);
  const cm = await db.queryOne("SELECT COALESCE(SUM(amount), 0) AS v FROM b2b_payments WHERE collected_by_salesman_id = ? AND status = 'received' AND DATE(received_at) BETWEEN ? AND ?", [sm, b.from, b.to]);
  const cash = await db.queryOne("SELECT COALESCE(SUM(amount), 0) AS v, COUNT(*) AS n FROM b2b_payments WHERE collected_by_salesman_id = ? AND method = 'cash' AND status = 'pending'", [sm]);
  const t = {}; (await db.query('SELECT metric, target_value FROM b2b_sales_targets WHERE salesman_id = ? AND period_month = ?', [sm, b.month])).forEach(function (x) { t[x.metric] = Number(x.target_value); });
  const actual = { sales_value: money(o.v), orders: Number(o.n), collections: money(cm.v), visits: Number(vm.n) };
  const pct = {}; Object.keys(t).forEach(function (k) { pct[k] = t[k] && actual[k] != null ? Math.round(actual[k] * 1000 / t[k]) / 10 : null; });
  return {
    month: b.month,
    today: { orders: Number(ot.n), value: money(ot.v), visits: Number(vt.n), collected: money(ct.v) },
    monthToDate: actual, target: t, achievementPct: pct,
    cashInHand: money(cash.v), cashReceiptsPending: Number(cash.n),
  };
}

/** Every salesman with this month's numbers (admin list). */
async function list(q) {
  q = q || {};
  const where = ['1=1'], params = [];
  if (q.active === '1') where.push('sm.is_active = 1');
  if (q.active === '0') where.push('sm.is_active = 0');
  if (q.q) { const t = '%' + String(q.q).replace(/[\\%_]/g, '\\$&').slice(0, 60) + '%'; where.push('(st.name LIKE ? OR st.email LIKE ? OR st.mobile LIKE ? OR sm.employee_code LIKE ?)'); params.push(t, t, t, t); }
  const rows = await db.query('SELECT sm.*, st.name, st.email, st.mobile, st.status AS staff_status, t.name AS territory, w.name AS warehouse FROM b2b_salesmen sm JOIN b2b_staff st ON st.id = sm.staff_id ' +
    'LEFT JOIN b2b_territories t ON t.id = sm.home_territory_id LEFT JOIN b2b_warehouses w ON w.id = sm.default_warehouse_id WHERE ' + where.join(' AND ') + ' ORDER BY sm.is_active DESC, st.name LIMIT 500', params);
  const items = [];
  for (const r of rows) {
    const n = await numbers(r.id, q.month);
    const last = await optional(function () { return db.queryOne("SELECT captured_at, lat, lng FROM b2b_location_pings WHERE subject_type = 'salesman' AND subject_id = ? ORDER BY captured_at DESC LIMIT 1", [r.id]); }, null);
    const lastVisit = await db.queryOne('SELECT v.checked_in_at, a.business_name, a.shop_name FROM b2b_visits v JOIN b2b_accounts a ON a.id = v.account_id WHERE v.salesman_id = ? ORDER BY v.checked_in_at DESC LIMIT 1', [r.id]);
    items.push({
      id: Number(r.id), staffId: Number(r.staff_id), name: r.name, email: r.email, mobile: r.mobile, employeeCode: r.employee_code, active: Number(r.is_active) === 1, staffStatus: r.staff_status,
      territoryId: r.home_territory_id == null ? null : Number(r.home_territory_id), territory: r.territory, warehouseId: r.default_warehouse_id == null ? null : Number(r.default_warehouse_id), warehouse: r.warehouse,
      cashLimit: money(r.cash_limit), numbers: n,
      lastLocationAt: last ? last.captured_at : null, lastVisit: lastVisit ? { at: lastVisit.checked_in_at, shop: lastVisit.shop_name || lastVisit.business_name } : null,
    });
  }
  const totals = items.filter(function (i) { return i.active; }).reduce(function (a, i) {
    a.salesmen += 1; a.todayOrders += i.numbers.today.orders; a.todayValue = money(a.todayValue + i.numbers.today.value); a.todayVisits += i.numbers.today.visits;
    a.monthValue = money(a.monthValue + i.numbers.monthToDate.sales_value); a.cashInHand = money(a.cashInHand + i.numbers.cashInHand);
    if (i.numbers.cashInHand > i.cashLimit && i.cashLimit > 0) a.overCashLimit += 1;
    return a;
  }, { salesmen: 0, todayOrders: 0, todayValue: 0, todayVisits: 0, monthValue: 0, cashInHand: 0, overCashLimit: 0 });
  return { month: monthBounds(q.month).month, items: items, totals: totals };
}

/** One salesman: numbers, recent orders, visits, cash waiting for handover, beats with stops, targets, last positions. */
async function detail(id, q) {
  const r = await db.queryOne('SELECT sm.*, st.name, st.email, st.mobile, st.status AS staff_status, t.name AS territory, w.name AS warehouse FROM b2b_salesmen sm JOIN b2b_staff st ON st.id = sm.staff_id ' +
    'LEFT JOIN b2b_territories t ON t.id = sm.home_territory_id LEFT JOIN b2b_warehouses w ON w.id = sm.default_warehouse_id WHERE sm.id = ?', [id]);
  if (!r) throw fail(404, 'Salesman not found');
  const beats = await db.query('SELECT b.id, b.name, b.weekday, b.is_active, t.name AS territory FROM b2b_beats b LEFT JOIN b2b_territories t ON t.id = b.territory_id WHERE b.salesman_id = ? ORDER BY b.weekday, b.name', [id]);
  for (const b of beats) {
    b.stops = await db.query('SELECT s.seq, a.id AS account_id, a.business_name, a.shop_name, a.city FROM b2b_beat_stops s JOIN b2b_accounts a ON a.id = s.account_id WHERE s.beat_id = ? ORDER BY s.seq', [b.id]);
  }
  return {
    salesman: { id: Number(r.id), staffId: Number(r.staff_id), name: r.name, email: r.email, mobile: r.mobile, employeeCode: r.employee_code, active: Number(r.is_active) === 1, staffStatus: r.staff_status,
      territoryId: r.home_territory_id == null ? null : Number(r.home_territory_id), territory: r.territory, warehouseId: r.default_warehouse_id == null ? null : Number(r.default_warehouse_id), warehouse: r.warehouse,
      cashLimit: money(r.cash_limit), since: r.created_at },
    numbers: await numbers(id, q && q.month),
    orders: await db.query('SELECT o.id, o.order_no, o.status, o.grand_total, o.created_at, a.business_name, a.shop_name FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id WHERE o.salesman_id = ? ORDER BY o.id DESC LIMIT 50', [id]),
    visits: await db.query('SELECT v.id, v.checked_in_at, v.outcome, v.note, v.distance_m, a.business_name, a.shop_name, a.city FROM b2b_visits v JOIN b2b_accounts a ON a.id = v.account_id WHERE v.salesman_id = ? ORDER BY v.checked_in_at DESC LIMIT 50', [id]),
    collectionsPending: await db.query("SELECT p.id, p.receipt_no, p.method, p.amount, p.reference, p.received_at, o.order_no FROM b2b_payments p LEFT JOIN b2b_orders o ON o.id = p.order_id WHERE p.collected_by_salesman_id = ? AND p.status = 'pending' ORDER BY p.id", [id]),
    beats: beats,
    targets: await db.query('SELECT period_month, metric, target_value FROM b2b_sales_targets WHERE salesman_id = ? ORDER BY period_month DESC, metric LIMIT 60', [id]),
    retailersRegistered: Number((await db.queryOne('SELECT COUNT(*) AS n FROM b2b_accounts WHERE registered_by_staff_id = ?', [r.staff_id])).n),
    locations: await optional(function () {
      return db.query("SELECT lat, lng, accuracy_m, purpose, note, captured_at FROM b2b_location_pings WHERE subject_type = 'salesman' AND subject_id = ? ORDER BY captured_at DESC LIMIT 30", [id]);
    }, []),
  };
}

/** Change territory, warehouse, cash limit, employee code, or switch a salesman off/on. */
async function update(tx, actor, id, b) {
  const old = await tx.queryOne('SELECT * FROM b2b_salesmen WHERE id = ? FOR UPDATE', [id]);
  if (!old) throw fail(404, 'Salesman not found');
  const set = {};
  if (b.employeeCode !== undefined) set.employee_code = v.text(b.employeeCode, 30) || null;
  if (b.homeTerritoryId !== undefined) {
    const t = posId(b.homeTerritoryId);
    if (t && !(await tx.queryOne('SELECT id FROM b2b_territories WHERE id = ?', [t]))) throw fail(400, 'Unknown territory');
    set.home_territory_id = t || null;
  }
  if (b.defaultWarehouseId !== undefined) {
    const w = posId(b.defaultWarehouseId);
    if (w && !(await tx.queryOne('SELECT id FROM b2b_warehouses WHERE id = ?', [w]))) throw fail(400, 'Unknown warehouse');
    set.default_warehouse_id = w || null;
  }
  if (b.cashLimit !== undefined) {
    const n = Number(b.cashLimit);
    if (!(n >= 0 && n <= 9999999)) throw fail(400, 'Cash limit must be between 0 and 99,99,999');
    set.cash_limit = n.toFixed(2);
  }
  if (b.active !== undefined) {
    const on = b.active === true || b.active === 1 || b.active === '1';
    if (!on) {
      const cash = await tx.queryOne("SELECT COALESCE(SUM(amount), 0) AS v FROM b2b_payments WHERE collected_by_salesman_id = ? AND method = 'cash' AND status = 'pending'", [id]);
      if (Number(cash.v) > 0 && b.force !== true) throw fail(409, 'This salesman still holds ₹' + Number(cash.v).toFixed(2) + ' in cash that has not been handed over. Confirm the handover first.', 'cash_in_hand');
    }
    set.is_active = on ? 1 : 0;
  }
  if (!Object.keys(set).length) throw fail(400, 'Nothing to change');
  try {
    await tx.query('UPDATE b2b_salesmen SET ' + Object.keys(set).map(function (k) { return k + ' = ?'; }).join(', ') + ' WHERE id = ?', Object.values(set).concat([id]));
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'This employee code is already in use'); throw e; }
  const before = {}; Object.keys(set).forEach(function (k) { before[k] = old[k]; });
  await audit.write(tx, actor, { module: 'sales', action: 'salesman.updated', entity: 'salesman', entityId: id, old: before, new: set, reason: b.reason || null });
  return { salesmanId: id, changed: Object.keys(set) };
}

/** Pickers for the Salesmen screen: staff who could become salesmen, territories, warehouses. */
async function lookups() {
  const staff = await db.query("SELECT st.id, st.name, st.email, st.mobile, " +
    "EXISTS (SELECT 1 FROM b2b_staff_roles sr JOIN b2b_roles r ON r.id = sr.role_id WHERE sr.staff_id = st.id AND sr.revoked_at IS NULL AND r.code = 'salesman') AS has_role " +
    "FROM b2b_staff st WHERE st.status = 'active' AND NOT EXISTS (SELECT 1 FROM b2b_salesmen sm WHERE sm.staff_id = st.id) ORDER BY has_role DESC, st.name LIMIT 500");
  return {
    staff: staff.map(function (s) { return { id: Number(s.id), name: s.name, email: s.email, mobile: s.mobile, hasSalesmanRole: Number(s.has_role) === 1 }; }),
    territories: await db.query('SELECT id, code, name, level FROM b2b_territories ORDER BY level, name LIMIT 1000'),
    warehouses: await db.query('SELECT id, code, name FROM b2b_warehouses WHERE owner_account_id IS NULL ORDER BY name LIMIT 200'),
  };
}

/** The salesman's own dashboard in the field app. */
async function dashboard(sm) {
  const n = await numbers(sm.id);
  const today = istDayRange(istToday());
  const beats = await db.query('SELECT b.id, b.name FROM b2b_beats b WHERE b.salesman_id = ? AND b.weekday = ? AND b.is_active = 1 ORDER BY b.name', [sm.id, istWeekday()]);
  for (const b of beats) {
    b.stops = (await db.query('SELECT s.seq, a.id AS account_id, a.business_name, a.shop_name, a.city, a.mobile, ' +
      '(SELECT MAX(v.checked_in_at) FROM b2b_visits v WHERE v.salesman_id = ? AND v.account_id = a.id AND v.checked_in_at >= ? AND v.checked_in_at < ?) AS visited_at ' +
      'FROM b2b_beat_stops s JOIN b2b_accounts a ON a.id = s.account_id WHERE s.beat_id = ? ORDER BY s.seq', [sm.id, today[0], today[1], b.id]))
      .map(function (x) { return { seq: x.seq, accountId: Number(x.account_id), shop: x.shop_name || x.business_name, city: x.city, mobile: x.mobile, visitedAt: x.visited_at }; });
    b.done = b.stops.filter(function (x) { return x.visitedAt; }).length;
  }
  const recent = await db.query('SELECT o.id, o.order_no, o.status, o.grand_total, o.created_at, a.business_name, a.shop_name FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id WHERE o.salesman_id = ? ORDER BY o.id DESC LIMIT 10', [sm.id]);
  return {
    month: n.month, today: n.today, monthToDate: n.monthToDate, target: n.target, achievementPct: n.achievementPct,
    cashInHand: n.cashInHand, cashLimit: money(sm.cash_limit), overCashLimit: Number(sm.cash_limit) > 0 && n.cashInHand > Number(sm.cash_limit),
    beatsToday: beats,
    recentOrders: recent.map(function (o) { return { id: Number(o.id), orderNo: o.order_no, status: o.status, value: money(o.grand_total), at: o.created_at, shop: o.shop_name || o.business_name }; }),
  };
}

module.exports = { list, detail, update, lookups, dashboard, numbers };
