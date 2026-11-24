/**
 * Smart Insights — the calculations, with no database and no outside service (pure functions,
 * unit-tested in tests/insights.test.js). Everything is statistics on the business's own sales,
 * stock and purchase data; nothing is sent anywhere and nothing costs money.
 *
 *   forecastProduct   demand for the next N days from weekly sales (Holt's trend smoothing
 *                     blended with the recent average, with an 80% range and a confidence label)
 *   stockOutlook      days of stock left and the expected stock-out date
 *   reorderAdvice     how much to order now: demand over lead time + cover days + safety stock,
 *                     minus stock already held or on order, rounded up to whole cases / MOQ
 *   customerSegments  recency / frequency / value segments and a churn-risk score per account
 *   dailyAnomalies    days whose sales are far outside the normal range (robust z-score)
 *   orderAnomalies    single orders that look wrong (far larger than usual, sold below cost)
 *   basket            products bought together (support, confidence, lift)
 *   suggestFor        what an account is likely to want next, from what similar baskets contain
 *   summarize         the week in plain sentences
 */
'use strict';

const DAY = 86400000;

function round(n, d) { const f = Math.pow(10, d || 0); return Math.round((Number(n) || 0) * f) / f; }
function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; }
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
}
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort(function (x, y) { return x - y; });
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}
function toDay(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10); }
function dayNum(v) { return Math.floor(Date.parse(toDay(v) + 'T00:00:00Z') / DAY); }
function addDays(day, n) { return new Date((dayNum(day) + n) * DAY).toISOString().slice(0, 10); }

/** rows [{day, qty}] → `weeks` weekly totals, oldest first; the last week ends on `today`. */
function weeklySeries(rows, weeks, today) {
  const end = dayNum(today), out = new Array(weeks).fill(0);
  rows.forEach(function (r) {
    const ago = end - dayNum(r.day);
    if (ago < 0) return;
    const w = Math.floor(ago / 7);
    if (w < weeks) out[weeks - 1 - w] += Number(r.qty) || 0;
  });
  return out;
}

/** rows [{day, value}] → one value per day for the `days` days ending on `today`, oldest first. */
function dailySeries(rows, days, today) {
  const end = dayNum(today), out = new Array(days).fill(0);
  rows.forEach(function (r) {
    const ago = end - dayNum(r.day);
    if (ago >= 0 && ago < days) out[days - 1 - ago] += Number(r.value) || 0;
  });
  return out;
}

/** Holt's linear exponential smoothing: next-period forecast, plus the one-step-ahead errors. */
function holt(series, alpha, beta) {
  alpha = alpha == null ? 0.5 : alpha; beta = beta == null ? 0.3 : beta;
  if (!series.length) return { forecast: 0, level: 0, trend: 0, residuals: [] };
  let level = series[0], trend = 0;
  const residuals = [];
  for (let i = 1; i < series.length; i++) {
    residuals.push(series[i] - (level + trend));
    const prev = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return { forecast: Math.max(0, level + trend), level: level, trend: trend, residuals: residuals };
}

/**
 * Demand for the next `horizonDays` from weekly sales (oldest first). Weeks before the first sale are
 * ignored (a product launched later is not "zero demand" for those weeks).
 */
function forecastProduct(weekly, opts) {
  const horizonDays = (opts && opts.horizonDays) || 30;
  const first = weekly.findIndex(function (x) { return x > 0; });
  if (first === -1) {
    return { weeklyRate: 0, dailyRate: 0, dailySd: 0, forecast: 0, low: 0, high: 0, confidence: 'none', trend: 'no sales', changePct: 0, weeksOfHistory: 0 };
  }
  const s = weekly.slice(first);
  const h = holt(s);
  const recent = mean(s.slice(-4));
  // Few weeks: the recent average. Enough weeks: mostly the trend model, steadied by the average.
  const weeklyRate = s.length >= 6 ? 0.7 * h.forecast + 0.3 * recent : recent;
  const resid = h.residuals.length >= 3 ? stdev(h.residuals) : stdev(s);
  const weeksAhead = horizonDays / 7;
  const forecast = weeklyRate * weeksAhead;
  const band = 1.28 * resid * Math.sqrt(weeksAhead);                    // ≈ 80% range
  const active = s.filter(function (x) { return x > 0; }).length;
  const cv = weeklyRate > 0 ? resid / weeklyRate : Infinity;
  const confidence = s.length >= 8 && active >= 6 && cv < 0.5 ? 'high' : (s.length >= 4 && active >= 3 && cv < 1 ? 'medium' : 'low');
  const prev = mean(s.slice(-8, -4)), last = mean(s.slice(-4));
  const change = prev > 0 ? (last - prev) / prev : (last > 0 ? 1 : 0);
  const trend = s.length < 5 ? 'new' : change > 0.15 ? 'rising' : change < -0.15 ? 'falling' : 'steady';
  return {
    weeklyRate: round(weeklyRate, 2), dailyRate: round(weeklyRate / 7, 3), dailySd: round(resid / Math.sqrt(7), 3),
    forecast: Math.round(forecast), low: Math.max(0, Math.round(forecast - band)), high: Math.round(forecast + band),
    confidence: confidence, trend: trend, changePct: s.length < 5 ? null : round(change * 100, 0), weeksOfHistory: s.length,
  };
}

/** p: {available, dailyRate, leadDays, today} → days of cover, stock-out date and what to do. */
function stockOutlook(p) {
  const avail = Math.max(0, Number(p.available) || 0);
  if (!(p.dailyRate > 0)) {
    return { daysOfCover: null, stockOutDate: null, status: avail > 0 ? 'no_recent_sales' : 'no_stock_no_sales' };
  }
  const days = avail / p.dailyRate;
  const status = avail <= 0 ? 'out_of_stock' : days < p.leadDays ? 'order_now' : days < p.leadDays + 14 ? 'order_soon' : 'ok';
  return { daysOfCover: round(days, 1), stockOutDate: avail <= 0 ? toDay(p.today) : addDays(p.today, Math.floor(days)), status: status };
}

/**
 * p: {position (available − reserved + in transit + on order), dailyRate, dailySd, leadDays,
 *     coverDays, caseQty, moq} → quantity to order now (0 = nothing yet).
 * Safety stock covers ~95% of demand swings during the lead time.
 */
function reorderAdvice(p) {
  const lead = Math.max(1, Number(p.leadDays) || 1), cover = Math.max(0, Number(p.coverDays) || 30);
  const rate = Math.max(0, Number(p.dailyRate) || 0);
  const safety = 1.65 * Math.max(0, Number(p.dailySd) || 0) * Math.sqrt(lead);
  const target = rate * (lead + cover) + safety;
  const reorderPoint = rate * lead + safety;
  const position = Number(p.position) || 0;
  if (rate <= 0 || position > reorderPoint) {
    return { qty: 0, reorderPoint: Math.ceil(reorderPoint), targetStock: Math.ceil(target), safetyStock: Math.ceil(safety) };
  }
  let qty = Math.max(0, Math.ceil(target - position));
  const cs = Math.max(1, Number(p.caseQty) || 1);
  qty = Math.ceil(qty / cs) * cs;
  if (p.moq && qty > 0 && qty < Number(p.moq)) qty = Number(p.moq);
  return { qty: qty, reorderPoint: Math.ceil(reorderPoint), targetStock: Math.ceil(target), safetyStock: Math.ceil(safety) };
}

/**
 * accounts: [{id, name, type, orders: [{day, value}]}] (any order) → one row per account that has
 * ordered: segment, churn risk (0–100), usual gap between orders, value in the last 90 days and the
 * 90 days before.
 */
function customerSegments(accounts, today) {
  const t = dayNum(today);
  const rows = accounts.filter(function (a) { return a.orders && a.orders.length; }).map(function (a) {
    const days = a.orders.map(function (o) { return dayNum(o.day); }).sort(function (x, y) { return x - y; });
    const gaps = [];
    for (let i = 1; i < days.length; i++) if (days[i] > days[i - 1]) gaps.push(days[i] - days[i - 1]);
    const usualGap = gaps.length ? Math.max(7, median(gaps)) : 30;
    const recency = t - days[days.length - 1];
    const sumIn = function (from, to) {
      return a.orders.reduce(function (s, o) { const ago = t - dayNum(o.day); return ago >= from && ago < to ? s + (Number(o.value) || 0) : s; }, 0);
    };
    const last90 = sumIn(0, 90), prev90 = sumIn(90, 180);
    const orders180 = a.orders.filter(function (o) { return t - dayNum(o.day) < 180; }).length;
    const ratio = recency / usualGap;
    return { id: a.id, name: a.name, type: a.type, orders: a.orders.length, orders180: orders180, lastOrder: toDay(new Date(days[days.length - 1] * DAY)),
      daysSinceLastOrder: recency, usualGapDays: round(usualGap, 0), value90: round(last90, 2), valuePrev90: round(prev90, 2),
      churnRisk: Math.max(0, Math.min(100, Math.round((ratio - 1) * 50))), _ratio: ratio };
  });
  const values = rows.map(function (r) { return r.value90; }).filter(function (v) { return v > 0; }).sort(function (x, y) { return x - y; });
  const topCut = values.length ? values[Math.floor(values.length * 0.75)] : Infinity;
  rows.forEach(function (r) {
    if (r.orders === 1 && r.daysSinceLastOrder <= 45) r.segment = 'New';
    else if (r._ratio > 3 && r.daysSinceLastOrder > 60) r.segment = 'Lost';
    else if (r._ratio > 1.5) r.segment = 'At risk';
    else if (r.orders180 >= 4 && r.value90 >= topCut) r.segment = 'Champion';
    else if (r.orders180 >= 3) r.segment = 'Loyal';
    else r.segment = 'Occasional';
    r.valueTrendPct = r.valuePrev90 > 0 ? round((r.value90 - r.valuePrev90) / r.valuePrev90 * 100, 0) : null;
    delete r._ratio;
  });
  return rows;
}

/**
 * values: one number per day (oldest first). Flags the last `recentDays` days whose value is far
 * from the median of the days before them (robust z-score ≥ 3.5, MAD-based, so one odd day does not
 * hide another).
 */
function dailyAnomalies(values, opts) {
  const recentDays = (opts && opts.recentDays) || 14, baseDays = (opts && opts.baseDays) || 56, minDiff = (opts && opts.minDiff) || 0;
  const out = [];
  for (let i = Math.max(baseDays, values.length - recentDays); i < values.length; i++) {
    const base = values.slice(i - baseDays, i);
    const med = median(base);
    const mad = median(base.map(function (x) { return Math.abs(x - med); }));
    const spread = mad > 0 ? mad / 0.6745 : (stdev(base) || 0);
    if (!(spread > 0)) continue;
    const z = (values[i] - med) / spread;
    if (Math.abs(values[i] - med) < minDiff) continue;
    if (z >= 3.5) out.push({ index: i, value: values[i], normal: round(med, 2), z: round(z, 1), kind: 'spike' });
    else if (z <= -3.5 && med > 0) out.push({ index: i, value: values[i], normal: round(med, 2), z: round(z, 1), kind: 'drop' });
  }
  return out;
}

/**
 * orders: [{id, orderNo, accountId, accountName, day, total, taxable, cost}] (oldest first). Flags
 * orders in the last `recentDays`: far larger than that account's usual order (≥ 3 earlier orders,
 * ≥ 3 × their median), or sold for less than it cost.
 */
function orderAnomalies(orders, today, opts) {
  const recentDays = (opts && opts.recentDays) || 30, t = dayNum(today);
  const history = {};
  const out = [];
  orders.forEach(function (o) {
    const h = history[o.accountId] || (history[o.accountId] = []);
    if (t - dayNum(o.day) < recentDays) {
      if (h.length >= 3) {
        const usual = median(h);
        if (usual > 0 && o.total >= 3 * usual) out.push({ orderId: o.id, orderNo: o.orderNo, accountName: o.accountName, day: toDay(o.day), kind: 'unusually_large', total: o.total, usual: round(usual, 2) });
      }
      if (Number(o.cost) > 0 && Number(o.taxable) > 0 && Number(o.cost) > Number(o.taxable)) {
        out.push({ orderId: o.id, orderNo: o.orderNo, accountName: o.accountName, day: toDay(o.day), kind: 'below_cost', total: o.total, cost: round(o.cost, 2), taxable: round(o.taxable, 2) });
      }
    }
    h.push(Number(o.total) || 0);
  });
  return out;
}

/** orders: [{orderId, accountId, productIds}] → pairs bought together, strongest first. */
function basket(orders, opts) {
  const minCount = (opts && opts.minCount) || 2, limit = (opts && opts.limit) || 50;
  const n = orders.length, single = {}, pair = {};
  orders.forEach(function (o) {
    const ids = Array.from(new Set(o.productIds.map(Number))).sort(function (x, y) { return x - y; });
    ids.forEach(function (a) { single[a] = (single[a] || 0) + 1; });
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const k = ids[i] + ':' + ids[j]; pair[k] = (pair[k] || 0) + 1; }
  });
  const pairs = [];
  Object.keys(pair).forEach(function (k) {
    const c = pair[k];
    if (c < minCount) return;
    const ab = k.split(':').map(Number), a = ab[0], b = ab[1];
    const lift = (c / n) / ((single[a] / n) * (single[b] / n));
    if (lift <= 1) return;
    pairs.push({ a: a, b: b, together: c, support: round(c / n, 3), confidenceAB: round(c / single[a], 2), confidenceBA: round(c / single[b], 2), lift: round(lift, 2) });
  });
  pairs.sort(function (x, y) { return (y.lift * y.together) - (x.lift * x.together); });
  return { orders: n, pairs: pairs.slice(0, limit) };
}

/** What an account (has: product ids it already buys) is likely to want next, from the basket pairs. */
function suggestFor(has, pairs, limit) {
  const own = new Set(Array.from(has).map(Number)), score = {}, because = {};
  pairs.forEach(function (p) {
    [[p.a, p.b, p.confidenceAB], [p.b, p.a, p.confidenceBA]].forEach(function (x) {
      if (own.has(x[0]) && !own.has(x[1])) {
        score[x[1]] = (score[x[1]] || 0) + x[2] * p.lift;
        if (!because[x[1]] || x[2] > because[x[1]].c) because[x[1]] = { id: x[0], c: x[2] };
      }
    });
  });
  return Object.keys(score).map(function (k) { return { productId: Number(k), score: round(score[k], 2), because: because[k].id }; })
    .sort(function (x, y) { return y.score - x.score; }).slice(0, limit || 3);
}

/** The week in plain sentences, from the figures the other functions produced. */
function summarize(f) {
  const lines = [];
  const money = function (v) { return '₹' + Math.round(v).toLocaleString('en-IN'); };
  if (f.revenue7 != null) {
    const ch = f.revenuePrev7 > 0 ? Math.round((f.revenue7 - f.revenuePrev7) / f.revenuePrev7 * 100) : null;
    lines.push('Sales in the last 7 days: ' + money(f.revenue7) + (ch == null ? '' : ' (' + (ch >= 0 ? 'up ' : 'down ') + Math.abs(ch) + '% on the 7 days before)') + ' from ' + f.orders7 + ' order' + (f.orders7 === 1 ? '' : 's') + '.');
  }
  if (f.rising && f.rising.length) lines.push('Selling faster: ' + f.rising.slice(0, 3).map(function (r) { return r.name + ' (+' + r.changePct + '%)'; }).join(', ') + '.');
  if (f.falling && f.falling.length) lines.push('Selling slower: ' + f.falling.slice(0, 3).map(function (r) { return r.name + ' (' + r.changePct + '%)'; }).join(', ') + '.');
  if (f.orderNow != null) lines.push(f.orderNow ? f.orderNow + ' product' + (f.orderNow === 1 ? '' : 's') + ' will run out before new stock can arrive: order now.' : 'No product is expected to run out before new stock can arrive.');
  if (f.atRisk != null) lines.push(f.atRisk ? f.atRisk + ' business customer' + (f.atRisk === 1 ? ' has' : 's have') + ' not ordered for much longer than usual.' : 'No business customer is overdue for an order.');
  if (f.alerts != null) lines.push(f.alerts ? f.alerts + ' unusual sale' + (f.alerts === 1 ? '' : 's') + ' or order' + (f.alerts === 1 ? '' : 's') + ' to check under Alerts.' : 'Nothing unusual in recent sales.');
  return lines;
}

module.exports = {
  round, mean, stdev, median, toDay, addDays, weeklySeries, dailySeries, holt, forecastProduct, stockOutlook, reorderAdvice,
  customerSegments, dailyAnomalies, orderAnomalies, basket, suggestFor, summarize,
};
