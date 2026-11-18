(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('dashboard', 'Dashboard')) return;

  var content = document.getElementById('content');
  document.getElementById('topbarActions').innerHTML =
    '<button class="btn btn-ghost btn-sm" id="refreshBtn">' + A.icon('refresh') + '<span class="hide-sm">Refresh</span></button>';

  function deltaHTML(value, label) {
    var cls = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
    var arrow = value > 0 ? '↑' : value < 0 ? '↓' : '→';
    return '<span class="delta ' + cls + '">' + arrow + ' ' + Math.abs(value) + '%</span> ' + label;
  }

  function statCard(opts) {
    return '<div class="stat ' + (opts.tone || '') + '">' +
      '<div class="stat-label">' + A.esc(opts.label) + '</div>' +
      '<div class="stat-value">' + opts.value + '</div>' +
      (opts.sub ? '<div class="stat-sub">' + opts.sub + '</div>' : '') +
      '</div>';
  }

  function render(d) {
    var statusChips = Object.keys(d.byStatus).filter(function (s) { return d.byStatus[s] > 0; })
      .map(function (s) {
        return '<a href="orders.html?status=' + s + '" style="text-decoration:none">' +
          A.statusBadge(s).replace('</span>', ' · ' + d.byStatus[s] + '</span>') + '</a>';
      }).join(' ');

    content.innerHTML =
      /* ── Today / yesterday headline ── */
      '<div class="stat-grid">' +
        statCard({
          label: "Today's Orders", tone: '',
          value: A.fmt.num(d.today.orders),
          sub: deltaHTML(d.deltas.orders, 'vs yesterday'),
        }) +
        statCard({
          label: "Today's Revenue", tone: 'blue',
          value: A.fmt.money(d.today.revenue),
          sub: deltaHTML(d.deltas.revenue, 'vs yesterday'),
        }) +
        statCard({
          label: "Yesterday's Orders", tone: 'violet',
          value: A.fmt.num(d.yesterday.orders),
          sub: A.fmt.money(d.yesterday.revenue) + ' revenue',
        }) +
        statCard({
          label: 'Needs Action', tone: d.pendingAction > 0 ? 'amber' : 'teal',
          value: A.fmt.num(d.pendingAction),
          sub: d.pendingAction > 0
            ? '<a href="orders.html?status=pending" style="color:var(--amber);font-weight:600">Review orders →</a>'
            : 'All caught up',
        }) +
      '</div>' +

      /* ── Lifetime totals ── */
      '<div class="stat-grid">' +
        statCard({ label: 'Total Orders', tone: 'teal', value: A.fmt.num(d.totals.orders),
          sub: A.fmt.num(d.week.orders) + ' in the last 7 days' }) +
        statCard({ label: 'Total Revenue', tone: 'teal', value: A.fmt.money(d.totals.revenue),
          sub: A.fmt.money(d.month.revenue) + ' in the last 30 days' }) +
        statCard({ label: 'Customers', tone: 'violet', value: A.fmt.num(d.totals.customers),
          sub: 'Avg order ' + A.fmt.money(d.totals.avgOrderValue) }) +
        statCard({ label: 'Live Products', tone: 'blue', value: A.fmt.num(d.totals.products),
          sub: '<a href="products.html" style="color:var(--blue);font-weight:600">Manage catalogue →</a>' }) +
      '</div>' +

      /* ── Status overview ── */
      '<div class="card mb-20"><div class="card-head"><h2>Order Pipeline</h2>' +
        '<div class="spacer"></div>' +
        '<a href="orders.html" class="btn btn-ghost btn-sm">View all orders</a></div>' +
        '<div class="card-body"><div class="flex items-center gap-8" style="flex-wrap:wrap">' +
        (statusChips || '<span class="text-muted">No orders yet</span>') +
        '</div></div></div>' +

      /* ── Recent orders ── */
      '<div class="card"><div class="card-head"><h2>Recent Orders</h2>' +
        '<div class="spacer"></div>' +
        '<a href="orders.html" class="btn btn-ghost btn-sm">See all</a></div>' +
        '<div class="card-body tight">' + recentTable(d.recentOrders) + '</div></div>';

    document.querySelectorAll('tr[data-order]').forEach(function (row) {
      row.addEventListener('click', function () {
        location.href = 'orders.html?open=' + row.dataset.order;
      });
    });
  }

  function recentTable(orders) {
    if (!orders.length) {
      return A.emptyState('inbox', 'No orders yet',
        'Orders placed on your storefront will appear here in real time.');
    }
    return '<div class="table-wrap"><table><thead><tr>' +
      '<th>Order</th><th>Customer</th><th class="hide-sm">Location</th>' +
      '<th class="hide-xs">Items</th><th class="td-right">Total</th>' +
      '<th>Status</th><th class="hide-sm">Placed</th>' +
      '</tr></thead><tbody>' +
      orders.map(function (o) {
        return '<tr class="clickable" data-order="' + A.esc(o.id) + '">' +
          '<td class="td-mono td-strong">' + A.esc(o.orderId) + '</td>' +
          '<td><div class="td-strong">' + A.esc(o.customer) + '</div>' +
            '<div class="td-muted">' + A.esc(A.fmt.phone(o.phone)) + '</div></td>' +
          '<td class="hide-sm td-muted">' + A.esc(o.city || '—') + '</td>' +
          '<td class="hide-xs">' + o.items + '</td>' +
          '<td class="td-right td-strong">' + A.fmt.money(o.total) + '</td>' +
          '<td>' + A.statusBadge(o.status) + '</td>' +
          '<td class="hide-sm td-muted td-nowrap">' + A.esc(A.fmt.relative(o.createdAt)) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  async function load() {
    content.innerHTML = A.loadingState();
    try {
      render(await A.api.get('/dashboard'));
    } catch (e) {
      content.innerHTML = '<div class="alert alert-error">' + A.icon('alert') +
        '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  document.getElementById('refreshBtn').addEventListener('click', function () {
    load(); A.loadBadges();
  });

  load();
  setInterval(function () {
    if (!document.hidden) load();
  }, 60000);
})();
