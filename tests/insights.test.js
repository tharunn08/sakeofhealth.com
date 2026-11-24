/**
 * Smart Insights: the calculations (engine.js) on known numbers, the service on a stand-in database
 * (read only: SELECT only), and the wiring (routes, permissions, menu page, screen).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const E = require('../src/modules/erp/insights/engine.js');

test('weekly and daily series: buckets end on today, oldest first; future rows ignored', () => {
  const rows = [{ day: '2026-11-24', qty: 2 }, { day: '2026-11-18', qty: 3 }, { day: '2026-11-17', qty: 5 }, { day: '2026-11-25', qty: 99 }];
  assert.deepEqual(E.weeklySeries(rows, 3, '2026-11-24'), [0, 5, 5]);
  assert.deepEqual(E.dailySeries([{ day: '2026-11-24', value: 10 }, { day: '2026-11-22', value: 4 }], 3, '2026-11-24'), [4, 0, 10]);
  assert.equal(E.addDays('2026-11-24', 7), '2026-12-01');
});

test('forecast: steady demand → about the same per week, tight range, high confidence; growth → rising', () => {
  const steady = E.forecastProduct([10, 10, 11, 9, 10, 10, 11, 9, 10, 10], { horizonDays: 28 });
  assert.ok(Math.abs(steady.weeklyRate - 10) < 1, 'about 10 a week: ' + steady.weeklyRate);
  assert.ok(steady.forecast >= 36 && steady.forecast <= 44, '4 weeks ≈ 40: ' + steady.forecast);
  assert.ok(steady.low <= steady.forecast && steady.high >= steady.forecast);
  assert.equal(steady.confidence, 'high');
  assert.equal(steady.trend, 'steady');
  const rising = E.forecastProduct([2, 3, 4, 5, 6, 8, 10, 12, 14, 16], { horizonDays: 7 });
  assert.equal(rising.trend, 'rising');
  assert.ok(rising.weeklyRate > 12, 'follows the trend: ' + rising.weeklyRate);
  const launched = E.forecastProduct([0, 0, 0, 0, 0, 0, 4, 6], { horizonDays: 7 });
  assert.equal(launched.weeksOfHistory, 2, 'weeks before the first sale are ignored');
  assert.equal(launched.trend, 'new');
  assert.equal(launched.weeklyRate, 5);
  assert.equal(E.forecastProduct([0, 0, 0]).confidence, 'none');
  assert.ok(E.forecastProduct([0, 30, 0, 0, 25, 0, 0, 40]).confidence !== 'high', 'lumpy sales are not high confidence');
});

test('stock outlook: days of cover, stock-out date and what to do', () => {
  assert.deepEqual(E.stockOutlook({ available: 50, dailyRate: 2, leadDays: 14, today: '2026-11-24' }), { daysOfCover: 25, stockOutDate: '2026-12-19', status: 'order_soon' });
  assert.equal(E.stockOutlook({ available: 20, dailyRate: 2, leadDays: 14, today: '2026-11-24' }).status, 'order_now');
  assert.equal(E.stockOutlook({ available: 100, dailyRate: 2, leadDays: 14, today: '2026-11-24' }).status, 'ok');
  assert.equal(E.stockOutlook({ available: 0, dailyRate: 2, leadDays: 14, today: '2026-11-24' }).status, 'out_of_stock');
  assert.equal(E.stockOutlook({ available: 10, dailyRate: 0, leadDays: 14, today: '2026-11-24' }).status, 'no_recent_sales');
});

test('reorder advice: lead time + cover + safety stock − what is held, whole cases, MOQ; nothing above the reorder point', () => {
  const a = E.reorderAdvice({ position: 10, dailyRate: 2, dailySd: 0, leadDays: 10, coverDays: 30, caseQty: 12, moq: 0 });
  assert.equal(a.reorderPoint, 20); assert.equal(a.targetStock, 80);
  assert.equal(a.qty, 72, '80 − 10 = 70 → 6 cases of 12');
  assert.equal(E.reorderAdvice({ position: 25, dailyRate: 2, dailySd: 0, leadDays: 10, coverDays: 30, caseQty: 1 }).qty, 0, 'above the reorder point: wait');
  assert.equal(E.reorderAdvice({ position: 0, dailyRate: 0.1, dailySd: 0, leadDays: 10, coverDays: 30, caseQty: 1, moq: 50 }).qty, 50, 'minimum order quantity');
  const safe = E.reorderAdvice({ position: 0, dailyRate: 2, dailySd: 1, leadDays: 9, coverDays: 0, caseQty: 1 });
  assert.equal(safe.safetyStock, 5, '1.65 × 1 × √9 ≈ 5');
  assert.equal(E.reorderAdvice({ position: 0, dailyRate: 0, leadDays: 10 }).qty, 0, 'no demand: no order');
});

test('customer segments and churn risk', () => {
  const o = (days, v) => days.map((d) => ({ day: E.addDays('2026-11-24', -d), value: v }));
  const rows = E.customerSegments([
    { id: 1, name: 'Weekly big', type: 'retailer', orders: o([2, 9, 16, 23, 30, 37], 10000) },
    { id: 2, name: 'Overdue', type: 'retailer', orders: o([40, 50, 60, 70], 2000) },
    { id: 3, name: 'Gone', type: 'distributor', orders: o([120, 130, 140], 3000) },
    { id: 4, name: 'First order', type: 'retailer', orders: o([5], 1500) },
    { id: 5, name: 'Monthly', type: 'retailer', orders: o([10, 40, 70, 100], 1000) },
    { id: 6, name: 'No orders', type: 'retailer', orders: [] },
  ], '2026-11-24');
  const seg = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(rows.length, 5, 'accounts without orders are left out');
  assert.equal(seg['Weekly big'].segment, 'Champion');
  assert.equal(seg['Overdue'].segment, 'At risk'); assert.ok(seg['Overdue'].churnRisk >= 50);
  assert.equal(seg['Gone'].segment, 'Lost'); assert.equal(seg['Gone'].churnRisk, 100);
  assert.equal(seg['First order'].segment, 'New');
  assert.equal(seg['Monthly'].segment, 'Loyal'); assert.equal(seg['Monthly'].churnRisk, 0);
  assert.equal(seg['Weekly big'].usualGapDays, 7);
});

test('anomalies: odd days stand out against a robust baseline; odd orders are flagged', () => {
  const v = new Array(70).fill(0).map((_, i) => 1000 + (i % 7) * 20);
  v[66] = 9000; v[68] = 0;
  const found = E.dailyAnomalies(v, { recentDays: 14, baseDays: 56 });
  assert.deepEqual(found.map((f) => [f.index, f.kind]), [[66, 'spike'], [68, 'drop']]);
  assert.deepEqual(E.dailyAnomalies(new Array(70).fill(500)), [], 'flat sales: nothing flagged');
  const orders = [
    { id: 1, accountId: 7, accountName: 'A', day: '2026-08-01', total: 1000, taxable: 900, cost: 600 },
    { id: 2, accountId: 7, accountName: 'A', day: '2026-09-01', total: 1200, taxable: 1000, cost: 700 },
    { id: 3, accountId: 7, accountName: 'A', day: '2026-10-01', total: 900, taxable: 800, cost: 500 },
    { id: 4, accountId: 7, accountName: 'A', day: '2026-11-20', orderNo: 'SO-4', total: 5000, taxable: 4200, cost: 2500 },
    { id: 5, accountId: 8, accountName: 'B', day: '2026-11-21', orderNo: 'SO-5', total: 1180, taxable: 1000, cost: 1100 },
  ];
  const flagged = E.orderAnomalies(orders, '2026-11-24', { recentDays: 30 });
  assert.deepEqual(flagged.map((f) => [f.orderNo, f.kind]), [['SO-4', 'unusually_large'], ['SO-5', 'below_cost']]);
});

test('products bought together and suggestions for an account', () => {
  const orders = [[1, 2], [1, 2], [1, 2, 3], [3, 4], [3, 4], [5], [5], [5]].map((p, i) => ({ orderId: i, accountId: i, productIds: p }));
  const b = E.basket(orders, { minCount: 2 });
  const p12 = b.pairs.find((p) => p.a === 1 && p.b === 2);
  assert.equal(p12.together, 3); assert.equal(p12.confidenceAB, 1); assert.ok(p12.lift > 1);
  assert.ok(!b.pairs.some((p) => p.a === 1 && p.b === 3), 'once together is not a pattern');
  const s = E.suggestFor(new Set([1]), b.pairs, 3);
  assert.equal(s[0].productId, 2); assert.equal(s[0].because, 1);
  assert.deepEqual(E.suggestFor(new Set([1, 2]), b.pairs, 3).map((x) => x.productId).includes(1), false, 'never suggests what they already buy');
});

test('the week in sentences', () => {
  const lines = E.summarize({ revenue7: 120000, revenuePrev7: 100000, orders7: 12, rising: [{ name: 'Iron', changePct: 40 }], falling: [], orderNow: 2, atRisk: 1, alerts: 0 });
  assert.match(lines[0], /₹1,20,000 \(up 20% on the 7 days before\) from 12 orders/);
  assert.match(lines[1], /Selling faster: Iron \(\+40%\)/);
  assert.ok(lines.some((l) => /2 products will run out before new stock can arrive/.test(l)));
  assert.ok(lines.some((l) => /1 business customer has not ordered/.test(l)));
  assert.ok(lines.some((l) => /Nothing unusual/.test(l)));
});

test('service: read only (SELECT only), sources reported, whole-business scope required', async (t) => {
  const db = require('../src/db/connection.js');
  const svc = require('../src/modules/erp/insights/service.js');
  const saved = db.query;
  const seen = [];
  const today = new Date().toISOString().slice(0, 10);
  db.query = async function (sql) {
    seen.push(sql);
    if (/FROM b2b_order_items oi JOIN b2b_orders o ON o.id = oi.order_id WHERE o.created_at >= \? AND o.seller_type/.test(sql)) {
      return [0, 7, 14, 21, 28, 35, 42, 49].map((d) => ({ day: E.addDays(today, -d), product_id: 1, qty: 14, value: 7000 }));
    }
    if (/FROM b2b_counter_sale_items/.test(sql)) return [];
    if (/FROM b2b_b2c_order_postings/.test(sql)) throw new Error("Table 'b2b_b2c_order_postings' doesn't exist");
    if (/FROM b2b_products/.test(sql)) return [{ id: 1, sku: 'SOH-IRON', name: 'Iron', case_qty: 10, moq: 0 }, { id: 2, sku: 'SOH-X', name: 'Unsold', case_qty: 1, moq: 0 }];
    if (/FROM b2b_stock st/.test(sql)) return [{ product_id: 1, available: 10, reserved: 2, in_transit: 0 }];
    if (/FROM b2b_purchase_order_items/.test(sql)) return [];
    if (/FROM b2b_vendor_products/.test(sql)) return [{ product_id: 1, lead_days: 7 }];
    return [];
  };
  t.after(() => { db.query = saved; svc.clearCache(); });
  svc.clearCache();
  const st = await svc.stock();
  const iron = st.items.find((x) => x.productId === 1);
  assert.equal(iron.available, 8, 'available minus reserved');
  assert.equal(iron.leadDays, 7); assert.equal(iron.leadDaysAssumed, false);
  assert.equal(iron.status, 'order_now', '8 units at 2 a day < 7 days lead time');
  assert.equal(iron.orderQty, 70, '2/day × (7 + 30) = 74 − 8 = 66 → 7 cases of 10');
  assert.equal(st.items.find((x) => x.productId === 2).leadDaysAssumed, true);
  const shop = st.sources.find((s) => /Online shop/.test(s.name));
  assert.equal(shop.included, false); assert.match(shop.note, /not included/);
  const f = await svc.forecast();
  assert.deepEqual(f.items.map((x) => x.productId), [1], 'only products that sold'); assert.equal(f.notSelling, 1);
  assert.ok(seen.length > 0);
  seen.forEach((sql) => assert.match(sql.trim(), /^SELECT /i, 'read only: ' + sql.slice(0, 60)));

  assert.doesNotThrow(() => svc.assertWholeBusiness({ scopes: { territory: 'all', warehouse: 'all', state: 'all' } }));
  assert.throws(() => svc.assertWholeBusiness({ scopes: { territory: [3] } }), /whole business/);
});

test('wiring: routes, permissions, menu page and screen', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'src/modules/erp/routes/insights.js'), 'utf8');
  assert.match(routes, /r\.use\(can\('reports\.export'\)\)/);
  for (const [p, perm] of [['forecast', 'sales.reports.view'], ['stock', 'inventory.view'], ['customers', 'customers.view'], ['alerts', 'sales.reports.view'], ['recommendations', 'sales.reports.view']]) {
    assert.match(routes, new RegExp("r\\.get\\('/" + p + "', can\\('" + perm.replace(/\./g, '\\.') + "'\\)"), p);
  }
  assert.doesNotMatch(routes, /r\.(post|put|patch|delete)\(/, 'read only');
  assert.match(fs.readFileSync(path.join(ROOT, 'src/modules/erp/index.js'), 'utf8'), /api\.use\('\/insights', require\('\.\/routes\/insights\.js'\)\)/);
  const reg = require('../src/platform/registry.js');
  const page = reg.PAGES.find((p) => p.id === 'erp-insights');
  assert.equal(page.path, '/admin/overview/insights'); assert.equal(page.perm, 'reports.export');
  reg.PAGES.filter((p) => p.module === 'erp').forEach((p) => assert.ok(p.scripts.includes('/admin/erp/insights.js'), p.id));
  const ref = require('../src/modules/erp/catalog/reference-data.json');
  const codes = new Set(ref.permissions.map((p) => p.code || p));
  ['reports.export', 'sales.reports.view', 'inventory.view', 'customers.view'].forEach((c) => assert.ok(codes.has(c), c + ' exists — no new permission, no migration'));
  const screen = fs.readFileSync(path.join(ROOT, 'erp-web/admin/insights.js'), 'utf8');
  assert.match(screen, /window\.ERP_VIEWS\.push\(\{ id: 'insights', label: 'Smart Insights', perm: 'reports\.export', render: render \}\)/);
  assert.doesNotMatch(screen, /innerHTML/, 'text via textContent only');
  assert.match(fs.readFileSync(path.join(ROOT, 'erp-web/admin/index.html'), 'utf8'), /\/admin\/erp\/insights\.js/);
});
