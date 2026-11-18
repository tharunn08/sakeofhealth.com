(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('analytics', 'Analytics')) return;

  var content = document.getElementById('content');
  var state = { days: 30, metric: 'revenue', data: null };

  document.getElementById('topbarActions').innerHTML =
    '<div class="tabs" id="rangeTabs">' +
    [7, 30, 90].map(function (d) {
      return '<button class="tab' + (state.days === d ? ' active' : '') + '" data-days="' + d + '">' + d + 'd</button>';
    }).join('') + '</div>';

  document.getElementById('rangeTabs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-days]'); if (!b) return;
    state.days = Number(b.dataset.days);
    document.querySelectorAll('[data-days]').forEach(function (x) { x.classList.toggle('active', x === b); });
    load();
  });

  function render(d) {
    var totalRev = d.series.reduce(function (s, x) { return s + x.revenue; }, 0);
    var totalOrders = d.series.reduce(function (s, x) { return s + x.orders; }, 0);
    var totalUnits = d.series.reduce(function (s, x) { return s + x.units; }, 0);
    var aov = totalOrders ? Math.round(totalRev / totalOrders) : 0;

    content.innerHTML =
      '<div class="stat-grid">' +
        stat('Revenue', A.fmt.money(totalRev), 'Last ' + state.days + ' days', '') +
        stat('Orders', A.fmt.num(totalOrders), A.fmt.num(totalUnits) + ' units sold', 'blue') +
        stat('Avg Order Value', A.fmt.money(aov), 'Per completed order', 'violet') +
        stat('Repeat Rate', d.customers.repeatRate + '%', d.customers.repeat + ' of ' + d.customers.total + ' customers', 'teal') +
      '</div>' +

      '<div class="card mb-20"><div class="card-head"><h2>Revenue Over Time</h2>' +
        '<div class="spacer"></div>' +
        '<div class="tabs" id="metricTabs">' +
          '<button class="tab' + (state.metric === 'revenue' ? ' active' : '') + '" data-metric="revenue">Revenue</button>' +
          '<button class="tab' + (state.metric === 'orders' ? ' active' : '') + '" data-metric="orders">Orders</button>' +
        '</div></div>' +
        '<div class="card-body">' +
        A.lineChart(d.series, { key: state.metric, money: state.metric === 'revenue', height: 250 }) +
        '</div></div>' +

      '<div class="grid-2 mb-20">' +
        '<div class="card"><div class="card-head"><h2>Top Products</h2></div><div class="card-body">' +
          A.barList(d.topProducts.map(function (p) {
            return { label: p.name, value: p.revenue, display: A.fmt.money(p.revenue) + ' · ' + p.units + 'u' };
          }), { emptyText: 'No sales data yet' }) + '</div></div>' +

        '<div class="card"><div class="card-head"><h2>Top Locations</h2></div><div class="card-body">' +
          A.barList(d.topCities.map(function (c) {
            return { label: c.city, value: c.revenue, display: A.fmt.money(c.revenue) + ' · ' + c.orders + ' orders' };
          }), { color: 'blue', emptyText: 'No location data yet' }) + '</div></div>' +
      '</div>' +

      '<div class="grid-2">' +
        '<div class="card"><div class="card-head"><h2>Coupon Performance</h2></div><div class="card-body">' +
          A.barList(d.coupons.map(function (c) {
            return { label: c.code, value: c.uses, display: c.uses + ' uses · ' + A.fmt.money(c.discount) + ' given' };
          }), { color: 'violet', emptyText: 'No coupons redeemed yet' }) + '</div></div>' +

        '<div class="card"><div class="card-head"><h2>Fulfilment</h2></div><div class="card-body">' +
          '<dl>' +
          '<div class="detail-row"><dt>Orders delivered</dt><dd class="td-strong">' + A.fmt.num(d.fulfilment.delivered) + '</dd></div>' +
          '<div class="detail-row"><dt>Average time to deliver</dt><dd class="td-strong">' +
            (d.fulfilment.avgHours ? d.fulfilment.avgHours + ' hours' : '—') + '</dd></div>' +
          (d.fulfilment.fastest != null ? '<div class="detail-row"><dt>Fastest</dt><dd>' + d.fulfilment.fastest + ' hours</dd></div>' : '') +
          (d.fulfilment.slowest != null ? '<div class="detail-row"><dt>Slowest</dt><dd>' + d.fulfilment.slowest + ' hours</dd></div>' : '') +
          '<div class="detail-row" style="border-top:1px solid var(--line-2);margin-top:8px;padding-top:12px">' +
            '<dt>New customers (30d)</dt><dd class="td-strong">' + A.fmt.num(d.customers.new) + '</dd></div>' +
          '</dl>' +
          '<div class="detail-title mt-24">Payment Methods</div>' +
          A.barList(Object.keys(d.paymentSplit).map(function (k) {
            return { label: k === 'cod' ? 'Cash on Delivery' : 'Online payment', value: d.paymentSplit[k], display: d.paymentSplit[k] };
          }), { emptyText: 'No payment data' }) +
        '</div></div>' +
      '</div>';

    document.getElementById('metricTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-metric]'); if (!b) return;
      state.metric = b.dataset.metric;
      render(state.data);
    });
  }

  function stat(label, value, sub, tone) {
    return '<div class="stat ' + tone + '"><div class="stat-label">' + A.esc(label) + '</div>' +
      '<div class="stat-value">' + value + '</div>' +
      '<div class="stat-sub">' + A.esc(sub) + '</div></div>';
  }

  async function load() {
    content.innerHTML = A.loadingState();
    try {
      state.data = await A.api.get('/analytics?days=' + state.days);
      render(state.data);
    } catch (e) {
      content.innerHTML = '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  load();
})();
