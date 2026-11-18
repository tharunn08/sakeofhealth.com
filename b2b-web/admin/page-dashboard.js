(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-dashboard', 'B2B Dashboard'))) return;
  var content = document.getElementById('content');
  document.getElementById('topbarActions').innerHTML = '<button class="btn btn-ghost btn-sm" id="refreshBtn">' + A.icon('refresh') + '</button>';

  function stat(label, value, sub, color, href) {
    var inner = '<div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + esc(value) + '</div>' + (sub ? '<div class="stat-sub">' + sub + '</div>' : '');
    return href ? '<a class="stat ' + (color || '') + '" href="' + href + '">' + inner + '</a>' : '<div class="stat ' + (color || '') + '">' + inner + '</div>';
  }
  function bars(title, rows, link) {
    return '<div class="card"><div class="card-head"><h2>' + esc(title) + '</h2><div class="spacer"></div>' + (link ? '<a class="btn btn-ghost btn-sm" href="' + link + '">Report</a>' : '') + '</div><div class="card-body">' +
      A.barList((rows || []).map(function (r) { return { label: r.name || '—', value: Number(r.value), display: B.money0(r.value) + (r.orders ? ' · ' + r.orders : '') }; }), { emptyText: 'No sales in the last 30 days' }) + '</div></div>';
  }

  function render(d) {
    var pipe = {}; d.pipeline.forEach(function (p) { pipe[p.status] = p.count; });
    var exp = d.expiring;
    content.innerHTML =
      (d.pendingApprovals.accounts || d.pendingApprovals.orders
        ? '<div class="alert alert-warn mb-20">' + A.icon('alert') + '<span><strong>Needs your attention:</strong> ' +
          (d.pendingApprovals.accounts ? '<a href="accounts.html?tab=pending" style="text-decoration:underline">' + d.pendingApprovals.accounts + ' registration' + (d.pendingApprovals.accounts === 1 ? '' : 's') + ' to review</a>' : '') +
          (d.pendingApprovals.accounts && d.pendingApprovals.orders ? ' · ' : '') +
          (d.pendingApprovals.orders ? '<a href="orders.html?status=pending_admin_approval" style="text-decoration:underline">' + d.pendingApprovals.orders + ' first order' + (d.pendingApprovals.orders === 1 ? '' : 's') + ' awaiting approval</a>' : '') +
          '</span></div>' : '') +
      '<div class="stat-grid">' +
        stat("Today's orders", d.today.orders, B.money0(d.today.value), 'blue', 'orders.html') +
        stat('This month', B.money0(d.month.value), d.month.orders + ' orders · ' + B.money0(d.month.taxable) + ' ex-GST', '', 'reports.html?type=sales') +
        stat('Average order value', B.money0(d.last30.averageOrderValue), 'last 30 days · ' + d.last30.orders + ' orders', 'violet') +
        stat('Outstanding', B.money0(d.outstanding.amount), d.outstanding.orders + ' unpaid orders', Number(d.outstanding.amount) > 0 ? 'amber' : '', 'finance.html?tab=outstanding') +
      '</div>' +
      '<div class="stat-grid">' +
        stat('Retailers', d.retailers.active, d.retailers.total + ' total · ' + d.retailers.pending + ' pending', 'teal', 'accounts.html?tab=retailers') +
        stat('Distributors', d.distributors.active, d.distributors.total + ' total · ' + d.distributors.pending + ' pending', 'teal', 'accounts.html?tab=distributors') +
        stat('Credit exposure', B.money0(d.credit.exposure), 'of ' + B.money0(d.credit.totalLimit) + ' extended', 'violet', 'finance.html?tab=credit') +
        stat('Fulfilment time', d.fulfilment.averageHours == null ? '—' : d.fulfilment.averageHours + ' h', d.fulfilment.deliveredOrders + ' delivered in 30 days', 'blue') +
      '</div>' +
      '<div class="stat-grid">' +
        stat('Low stock', d.lowStock, 'products at or below threshold', d.lowStock ? 'red' : '', 'inventory.html?tab=stock&low=1') +
        stat('Expiring ≤ 30 days', exp.within30, exp.within60 + ' in 31–60 · ' + exp.within90 + ' in 61–90 days', exp.within30 ? 'amber' : '', 'inventory.html?tab=expiry') +
        stat('Expired on hand', exp.expired, 'batches to write off', exp.expired ? 'red' : '', 'inventory.html?tab=expiry&expired=1') +
        stat('Failed notifications', d.failedNotifications, 'emails / WhatsApp not delivered', d.failedNotifications ? 'amber' : '', 'settings.html?tab=notifications') +
      '</div>' +
      '<div class="card mb-20"><div class="card-head"><h2>Order pipeline</h2></div><div class="card-body"><div class="stat-grid" style="margin:0">' +
        ['pending_admin_approval', 'assigned', 'accepted', 'processing', 'packed', 'dispatched', 'out_for_delivery'].map(function (s) {
          return '<a class="stat" href="orders.html?status=' + s + '" style="padding:14px 16px"><div class="stat-label">' + esc(B.label(s)) + '</div><div class="stat-value" style="font-size:22px">' + (pipe[s] || 0) + '</div></a>';
        }).join('') + '</div></div></div>' +
      '<div class="grid-2 mb-20">' + bars('Top products · 30 days', d.topProducts, 'reports.html?type=products') + bars('Top retailers · 30 days', d.topRetailers, 'reports.html?type=retailers') + '</div>' +
      '<div class="grid-2 mb-20">' + bars('Top distributors (sales to retailers)', d.topDistributors, 'reports.html?type=distributors') + bars('Top distributors (purchases from us)', d.topDistributorBuyers, 'reports.html?type=distributors') + '</div>' +
      '<div class="grid-2">' + bars('Top districts · 30 days', d.topDistricts, 'reports.html?type=geographic') + bars('State-wise sales · 30 days', d.stateSales, 'reports.html?type=geographic&level=state') + '</div>' +
      '<p class="muted small" style="margin-top:14px">Figures as of ' + esc(B.dateTime(d.asOf)) + '. Sales exclude cancelled, rejected and refunded orders.</p>';
  }

  async function load(fresh) {
    try { render(await B.api.get('/dashboard' + (fresh ? '?fresh=1' : ''))); } catch (e) { B.fail(content, e); }
  }
  document.getElementById('refreshBtn').addEventListener('click', function () { load(true); });
  load();
})();
