/**
 * Smart Insights — reads the business database (read only: SELECTs only, nothing is written) and
 * hands the figures to engine.js. No outside service is called.
 *
 * Sales that count as demand on company stock:
 *   • trade orders sold by the company (not cancelled, rejected or draft),
 *   • event and counter sales (completed, minus returns),
 *   • online-shop orders, only where the read-only shop feed has posted them (b2c.feed.enabled).
 * The online shop's own files are never read here.
 */
'use strict';
const db = require('../../../db/connection.js');
const E = require('./engine.js');

const WEEKS = 26;                      // half a year of weekly history for forecasts
const DEFAULT_LEAD_DAYS = 14;          // when no approved supplier product states a lead time
const COVER_DAYS = 30;                 // stock to hold after a delivery arrives
const CACHE_MS = 60000;
const cache = new Map();

function fail(status, msg) { return Object.assign(new Error(msg), { status: status, expose: true }); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

/** Insights cover the whole business, so they need a role whose scope is the whole business. */
function assertWholeBusiness(principal) {
  const s = (principal && principal.scopes) || {};
  const limited = Object.keys(s).some(function (k) { return s[k] !== 'all'; });
  if (limited) throw fail(403, 'Smart Insights cover the whole business. They need a role with access to all territories and warehouses.');
}

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value: value });
  return value;
}

async function optional(sql, params) {
  try { return { ok: true, rows: await db.query(sql, params) }; } catch (e) { return { ok: false, rows: [] }; }
}

/** Daily quantity and value per product, from every source that is available. */
async function salesLines(days) {
  const since = E.addDays(todayStr(), -days);
  const sources = [];
  const trade = await optional(
    'SELECT DATE_FORMAT(o.created_at, \'%Y-%m-%d\') AS day, oi.product_id, SUM(CAST(oi.qty AS SIGNED) - CAST(oi.qty_returned AS SIGNED)) AS qty, SUM(oi.line_total) AS value ' +
    "FROM b2b_order_items oi JOIN b2b_orders o ON o.id = oi.order_id WHERE o.created_at >= ? AND o.seller_type = 'company' " +
    "AND o.status NOT IN ('draft','cancelled','rejected') GROUP BY day, oi.product_id", [since]);
  sources.push({ name: 'Trade orders', included: trade.ok });
  const counter = await optional(
    'SELECT DATE_FORMAT(cs.sold_at, \'%Y-%m-%d\') AS day, ci.product_id, SUM(CAST(ci.qty AS SIGNED) - CAST(ci.returned_qty AS SIGNED)) AS qty, SUM(ci.line_total) AS value ' +
    "FROM b2b_counter_sale_items ci JOIN b2b_counter_sales cs ON cs.id = ci.sale_id WHERE cs.sold_at >= ? AND cs.status = 'completed' " +
    'GROUP BY day, ci.product_id', [since]);
  sources.push({ name: 'Event and counter sales', included: counter.ok });
  const shop = await optional(
    "SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, product_id, SUM(CASE WHEN posting = 'reversed' THEN -CAST(qty AS SIGNED) ELSE CAST(qty AS SIGNED) END) AS qty, 0 AS value " +
    "FROM b2b_b2c_order_postings WHERE created_at >= ? AND product_id IS NOT NULL AND posting IN ('posted','reversed') GROUP BY day, product_id", [since]);
  sources.push({ name: 'Online shop (through the shop feed)', included: shop.ok && shop.rows.length > 0,
    note: shop.ok && shop.rows.length ? null : 'No shop orders have been posted by the shop feed, so online-shop demand is not included.' });
  return { rows: trade.rows.concat(counter.rows, shop.rows), sources: sources };
}

async function products() {
  return db.query('SELECT id, sku, name, case_qty, moq, low_stock_threshold FROM b2b_products WHERE is_active = 1 ORDER BY name LIMIT 5000');
}

/** Per product: forecast plus stock position across company-owned warehouses. */
async function productOutlook() {
  const today = todayStr();
  const sales = await salesLines(WEEKS * 7);
  const prods = await products();
  const stock = await db.query(
    'SELECT st.product_id, SUM(st.qty_available) AS available, SUM(st.qty_reserved) AS reserved, SUM(st.qty_in_transit) AS in_transit ' +
    'FROM b2b_stock st JOIN b2b_warehouses w ON w.id = st.warehouse_id WHERE w.owner_account_id IS NULL AND w.is_active = 1 GROUP BY st.product_id');
  const onOrder = await db.query(
    'SELECT poi.product_id, SUM(GREATEST(CAST(poi.qty_ordered AS SIGNED) - CAST(poi.qty_received AS SIGNED) - CAST(poi.qty_rejected AS SIGNED), 0)) AS qty ' +
    'FROM b2b_purchase_order_items poi JOIN b2b_purchase_orders po ON po.id = poi.po_id ' +
    "WHERE po.status IN ('approved','sent','accepted','partially_accepted','partially_received') GROUP BY poi.product_id");
  const lead = (await optional("SELECT product_id, MIN(lead_days) AS lead_days FROM b2b_vendor_products WHERE status = 'approved' AND product_id IS NOT NULL AND lead_days > 0 GROUP BY product_id")).rows;
  const by = function (rows, key) { const m = new Map(); rows.forEach(function (r) { m.set(Number(r[key]), r); }); return m; };
  const stockBy = by(stock, 'product_id'), orderBy = by(onOrder, 'product_id'), leadBy = by(lead, 'product_id');
  const perProduct = new Map();
  sales.rows.forEach(function (r) { const k = Number(r.product_id); (perProduct.get(k) || perProduct.set(k, []).get(k)).push({ day: r.day, qty: Number(r.qty) || 0 }); });
  const items = prods.map(function (p) {
    const weekly = E.weeklySeries(perProduct.get(Number(p.id)) || [], WEEKS, today);
    const f = E.forecastProduct(weekly, { horizonDays: 30 });
    const st = stockBy.get(Number(p.id)) || {};
    const available = Math.max(0, Number(st.available || 0) - Number(st.reserved || 0));
    const leadDays = leadBy.has(Number(p.id)) ? Number(leadBy.get(Number(p.id)).lead_days) : DEFAULT_LEAD_DAYS;
    const position = available + Number(st.in_transit || 0) + Number((orderBy.get(Number(p.id)) || {}).qty || 0);
    const outlook = E.stockOutlook({ available: available, dailyRate: f.dailyRate, leadDays: leadDays, today: today });
    const advice = E.reorderAdvice({ position: position, dailyRate: f.dailyRate, dailySd: f.dailySd, leadDays: leadDays, coverDays: COVER_DAYS, caseQty: p.case_qty, moq: p.moq });
    return {
      productId: Number(p.id), sku: p.sku, name: p.name, sold26Weeks: weekly.reduce(function (s, x) { return s + x; }, 0), lastWeeks: weekly.slice(-8),
      forecast30: f.forecast, forecastLow: f.low, forecastHigh: f.high, perWeek: f.weeklyRate, confidence: f.confidence, trend: f.trend, changePct: f.changePct,
      available: available, inTransit: Number(st.in_transit || 0), onOrder: Number((orderBy.get(Number(p.id)) || {}).qty || 0),
      leadDays: leadDays, leadDaysAssumed: !leadBy.has(Number(p.id)), daysOfCover: outlook.daysOfCover, stockOutDate: outlook.stockOutDate, status: outlook.status,
      orderQty: advice.qty, reorderPoint: advice.reorderPoint, safetyStock: advice.safetyStock,
    };
  });
  return { today: today, sources: sales.sources, defaults: { leadDays: DEFAULT_LEAD_DAYS, coverDays: COVER_DAYS, weeksOfHistory: WEEKS }, items: items };
}

async function forecast() {
  return cached('outlook', productOutlook).then(function (o) {
    const items = o.items.filter(function (x) { return x.sold26Weeks > 0; }).sort(function (a, b) { return b.forecast30 - a.forecast30; });
    return { today: o.today, sources: o.sources, defaults: o.defaults, items: items, notSelling: o.items.length - items.length };
  });
}

async function stock() {
  return cached('outlook', productOutlook).then(function (o) {
    const rank = { out_of_stock: 0, order_now: 1, order_soon: 2, ok: 3, no_recent_sales: 4, no_stock_no_sales: 5 };
    const items = o.items.slice().sort(function (a, b) { return (rank[a.status] - rank[b.status]) || ((a.daysOfCover == null ? 1e9 : a.daysOfCover) - (b.daysOfCover == null ? 1e9 : b.daysOfCover)); });
    const count = function (s) { return items.filter(function (x) { return x.status === s; }).length; };
    return { today: o.today, sources: o.sources, defaults: o.defaults, counts: { outOfStock: count('out_of_stock'), orderNow: count('order_now'), orderSoon: count('order_soon'), ok: count('ok'), slowOrNoSales: count('no_recent_sales') + count('no_stock_no_sales') },
      items: items, toOrder: items.filter(function (x) { return x.orderQty > 0; }) };
  });
}

/** Trade orders of the last year, oldest first (customers, alerts, baskets share them). */
async function tradeOrders() {
  return db.query(
    'SELECT o.id, o.order_no, o.buyer_account_id, a.business_name, a.account_type, DATE_FORMAT(o.created_at, \'%Y-%m-%d\') AS day, o.grand_total, o.taxable_total, o.cost_total ' +
    'FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id ' +
    "WHERE o.created_at >= ? AND o.status NOT IN ('draft','cancelled','rejected') ORDER BY o.created_at, o.id LIMIT 50000", [E.addDays(todayStr(), -365)]);
}

async function customers() {
  return cached('customers', async function () {
    const today = todayStr();
    const accounts = new Map();
    (await tradeOrders()).forEach(function (o) {
      const k = Number(o.buyer_account_id);
      if (!accounts.has(k)) accounts.set(k, { id: k, name: o.business_name, type: o.account_type, orders: [] });
      accounts.get(k).orders.push({ day: o.day, value: Number(o.grand_total) || 0 });
    });
    const rows = E.customerSegments(Array.from(accounts.values()), today).sort(function (a, b) { return b.churnRisk - a.churnRisk || b.value90 - a.value90; });
    const segments = {};
    rows.forEach(function (r) { segments[r.segment] = (segments[r.segment] || 0) + 1; });
    return { today: today, segments: segments, items: rows };
  });
}

async function alerts() {
  return cached('alerts', async function () {
    const today = todayStr();
    const sales = await salesLines(90);
    const byDay = new Map();
    sales.rows.forEach(function (r) { const d = E.toDay(r.day); byDay.set(d, (byDay.get(d) || 0) + (Number(r.value) || 0)); });
    const values = E.dailySeries(Array.from(byDay, function (e) { return { day: e[0], value: e[1] }; }), 90, today);
    const days = E.dailyAnomalies(values, { recentDays: 14, baseDays: 56, minDiff: 500 }).map(function (a) {
      return Object.assign({ day: E.addDays(today, a.index - 89) }, a);
    });
    const orders = (await tradeOrders()).map(function (o) {
      return { id: Number(o.id), orderNo: o.order_no, accountId: Number(o.buyer_account_id), accountName: o.business_name, day: o.day,
        total: Number(o.grand_total) || 0, taxable: Number(o.taxable_total) || 0, cost: Number(o.cost_total) || 0 };
    });
    const orderAlerts = E.orderAnomalies(orders, today, { recentDays: 30 });
    return { today: today, days: days, orders: orderAlerts, total: days.length + orderAlerts.length };
  });
}

async function recommendations() {
  return cached('basket', async function () {
    const rows = await db.query(
      'SELECT oi.order_id, o.buyer_account_id, oi.product_id FROM b2b_order_items oi JOIN b2b_orders o ON o.id = oi.order_id ' +
      "WHERE o.created_at >= ? AND o.status NOT IN ('draft','cancelled','rejected') LIMIT 200000", [E.addDays(todayStr(), -365)]);
    const orders = new Map(), accountHas = new Map();
    rows.forEach(function (r) {
      const k = Number(r.order_id);
      if (!orders.has(k)) orders.set(k, { orderId: k, accountId: Number(r.buyer_account_id), productIds: [] });
      orders.get(k).productIds.push(Number(r.product_id));
      const a = Number(r.buyer_account_id);
      (accountHas.get(a) || accountHas.set(a, new Set()).get(a)).add(Number(r.product_id));
    });
    const b = E.basket(Array.from(orders.values()), { minCount: 2, limit: 50 });
    const names = new Map((await products()).map(function (p) { return [Number(p.id), p.name]; }));
    const acct = new Map((await optional('SELECT id, business_name FROM b2b_accounts')).rows.map(function (a) { return [Number(a.id), a.business_name]; }));
    const name = function (id) { return names.get(Number(id)) || ('Product #' + id); };
    const pairs = b.pairs.map(function (p) { return Object.assign({ aName: name(p.a), bName: name(p.b) }, p); });
    const perAccount = [];
    accountHas.forEach(function (has, a) {
      const s = E.suggestFor(has, b.pairs, 3);
      if (s.length) perAccount.push({ accountId: a, accountName: acct.get(a) || ('Account #' + a), suggestions: s.map(function (x) { return { productId: x.productId, name: name(x.productId), because: name(x.because), score: x.score }; }) });
    });
    perAccount.sort(function (x, y) { return y.suggestions[0].score - x.suggestions[0].score; });
    return { orders: b.orders, pairs: pairs, accounts: perAccount.slice(0, 100) };
  });
}

/** The one-screen overview: the week in sentences plus the headline counts. Sections the person's
 *  role cannot see are left out (perms: Set of permission codes). */
async function summary(perms) {
  const today = todayStr();
  const f = {};
  const out = { today: today, sections: {} };
  if (perms.has('sales.reports.view')) {
    const sales = await salesLines(14);
    const t = Math.floor(Date.parse(today + 'T00:00:00Z') / 86400000);
    let r7 = 0, p7 = 0;
    sales.rows.forEach(function (r) { const ago = t - Math.floor(Date.parse(E.toDay(r.day) + 'T00:00:00Z') / 86400000); if (ago < 7) r7 += Number(r.value) || 0; else if (ago < 14) p7 += Number(r.value) || 0; });
    const o7 = await optional("SELECT COUNT(*) AS n FROM b2b_orders WHERE created_at >= ? AND seller_type = 'company' AND status NOT IN ('draft','cancelled','rejected')", [E.addDays(today, -6)]);
    const c7 = await optional("SELECT COUNT(*) AS n FROM b2b_counter_sales WHERE sold_at >= ? AND status = 'completed'", [E.addDays(today, -6)]);
    f.revenue7 = r7; f.revenuePrev7 = p7; f.orders7 = Number((o7.rows[0] || {}).n || 0) + Number((c7.rows[0] || {}).n || 0);
    const fc = await forecast();
    f.rising = fc.items.filter(function (x) { return x.trend === 'rising'; }).sort(function (a, b) { return b.changePct - a.changePct; });
    f.falling = fc.items.filter(function (x) { return x.trend === 'falling'; }).sort(function (a, b) { return a.changePct - b.changePct; });
    const al = await alerts();
    f.alerts = al.total;
    out.sections.sales = { revenue7: E.round(r7, 2), revenuePrev7: E.round(p7, 2), orders7: f.orders7, alerts: al.total, sources: sales.sources };
  }
  if (perms.has('inventory.view')) {
    const st = await stock();
    f.orderNow = st.counts.outOfStock + st.counts.orderNow;
    out.sections.stock = st.counts;
  }
  if (perms.has('customers.view')) {
    const cu = await customers();
    f.atRisk = (cu.segments['At risk'] || 0);
    out.sections.customers = cu.segments;
  }
  out.sentences = E.summarize(f);
  return out;
}

/** For tests. */
function clearCache() { cache.clear(); }

module.exports = { assertWholeBusiness, summary, forecast, stock, customers, alerts, recommendations, clearCache, DEFAULT_LEAD_DAYS, COVER_DAYS };
