(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('reports', 'Reports')) return;

  var content = document.getElementById('content');
  var today = new Date().toISOString().slice(0, 10);
  var monthAgo = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);

  // Each report; dated reports use the shared From/To range.
  var REPORTS = [
    { type: 'orders', title: 'Orders Report', dated: true, statusFilter: true,
      desc: 'Every order with customer details, items, payment status, delivery address and GPS coordinates.' },
    { type: 'sales', title: 'Sales Report', dated: true, statusFilter: false,
      desc: 'Revenue-focused: subtotals, discounts, coupons, shipping, totals and payment references (excludes cancelled).' },
    { type: 'deliveries', title: 'Deliveries Report', dated: true, statusFilter: false,
      desc: 'Delivery-focused: door number, full address, landmark, GPS map link and the assigned agent.' },
    { type: 'customers', title: 'Customers Report', dated: false, statusFilter: false,
      desc: 'Names, contact details, order counts, lifetime value and city.' },
    { type: 'products', title: 'Products Report', dated: false, statusFilter: false,
      desc: 'Catalogue with stock levels, units sold and revenue per product.' },
  ];

  content.innerHTML =
    '<div class="card mb-20"><div class="card-head"><h2>Date Range</h2>' +
      '<div class="spacer"></div>' +
      '<span class="text-muted" style="font-size:12.5px">Applies to Orders, Sales &amp; Deliveries</span></div>' +
      '<div class="card-body"><div class="field-row">' +
        '<div class="field"><label for="from">From</label>' +
          '<input class="input" type="date" id="from" value="' + monthAgo + '" max="' + today + '"/></div>' +
        '<div class="field"><label for="to">To</label>' +
          '<input class="input" type="date" id="to" value="' + today + '" max="' + today + '"/></div>' +
        '<div class="field"><label for="status">Order status (Orders report)</label>' +
          '<select class="select" id="status"><option value="">All statuses</option>' +
          ['pending', 'accepted', 'prepared', 'out_for_delivery', 'delivered', 'cancelled'].map(function (s) {
            return '<option value="' + s + '">' + A.esc(A.STATUS[s].label) + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<div class="flex gap-8 mt-16" style="flex-wrap:wrap">' +
        '<button class="btn btn-ghost btn-sm" data-quick="7">Last 7 days</button>' +
        '<button class="btn btn-ghost btn-sm" data-quick="30">Last 30 days</button>' +
        '<button class="btn btn-ghost btn-sm" data-quick="90">Last 90 days</button>' +
        '<button class="btn btn-ghost btn-sm" data-quick="365">Last year</button>' +
      '</div></div></div>' +

    '<div class="grid-2" id="reportCards">' +
      REPORTS.map(function (r) {
        return '<div class="card"><div class="card-head"><h2>' + A.esc(r.title) + '</h2>' +
          (r.dated ? '<span class="badge badge-paid" style="margin-left:8px">Date range</span>' : '') +
          '</div><div class="card-body">' +
          '<p class="text-muted mb-20" style="line-height:1.6">' + A.esc(r.desc) + '</p>' +
          '<button class="btn btn-primary btn-block" data-report="' + r.type + '" data-dated="' + r.dated +
          '" data-status="' + r.statusFilter + '">' +
          A.icon('download') + 'Download ' + A.esc(r.title.replace(' Report', '')) + ' CSV</button>' +
        '</div></div>';
      }).join('') +
    '</div>' +

    '<div class="alert alert-info mt-20 mb-0">' + A.icon('alert') +
      '<span>CSV files open directly in Excel, Google Sheets and Tally. Dates use your selected range above.</span></div>' +

    '<div class="card mt-20"><div class="card-head"><h2>Quick Summary</h2>' +
      '<div class="spacer"></div>' +
      '<button class="btn btn-ghost btn-sm" onclick="window.print()">Print this page</button></div>' +
      '<div class="card-body" id="summary">' + A.loadingState() + '</div></div>';

  /** Download a CSV with the login token in a header, never in the address (Phase 0.5.9, BUG-016). */
  async function downloadCsv(url, fallbackName) {
    try {
      var res = await fetch(url, { headers: { Authorization: 'Bearer ' + A.Auth.token() } });
      if (res.status === 401) { A.Auth.logout(); return; }
      if (!res.ok) {
        var err = 'Download failed';
        try { err = (await res.json()).error || err; } catch (e) { /* not JSON */ }
        throw new Error(err);
      }
      var m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
      var blob = await res.blob();
      var href = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = href; a.download = m ? m[1] : fallbackName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
    } catch (e) { A.toast(e.message || 'Download failed', 'error'); }
  }
  function download(url) { return downloadCsv(url, 'report.csv'); }

  document.querySelectorAll('[data-quick]').forEach(function (b) {
    b.addEventListener('click', function () {
      var days = Number(b.dataset.quick);
      document.getElementById('from').value = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      document.getElementById('to').value = today;
    });
  });

  document.querySelectorAll('[data-report]').forEach(function (b) {
    b.addEventListener('click', function () {
      var p = new URLSearchParams();
      if (b.dataset.dated === 'true') {
        var from = document.getElementById('from').value;
        var to = document.getElementById('to').value;
        if (from) p.set('from', from);
        if (to) p.set('to', to);
      }
      if (b.dataset.status === 'true') {
        var st = document.getElementById('status').value;
        if (st) p.set('status', st);
      }
      var qs = p.toString();
      download('/api/admin/reports/' + b.dataset.report + '.csv' + (qs ? '?' + qs : ''));
    });
  });

  (async function summary() {
    try {
      var d = await A.api.get('/analytics?days=30');
      var rev = d.series.reduce(function (s, x) { return s + x.revenue; }, 0);
      var ord = d.series.reduce(function (s, x) { return s + x.orders; }, 0);
      document.getElementById('summary').innerHTML =
        '<div class="grid-2">' +
        '<dl><div class="detail-title">Last 30 Days</div>' +
          '<div class="detail-row"><dt>Revenue</dt><dd class="td-strong">' + A.fmt.money(rev) + '</dd></div>' +
          '<div class="detail-row"><dt>Orders</dt><dd class="td-strong">' + A.fmt.num(ord) + '</dd></div>' +
          '<div class="detail-row"><dt>Average order value</dt><dd>' +
            A.fmt.money(ord ? Math.round(rev / ord) : 0) + '</dd></div>' +
          '<div class="detail-row"><dt>Units sold</dt><dd>' +
            A.fmt.num(d.series.reduce(function (s, x) { return s + x.units; }, 0)) + '</dd></div>' +
        '</dl>' +
        '<dl><div class="detail-title">Customers &amp; Fulfilment</div>' +
          '<div class="detail-row"><dt>Total customers</dt><dd class="td-strong">' + A.fmt.num(d.customers.total) + '</dd></div>' +
          '<div class="detail-row"><dt>Repeat customers</dt><dd>' + d.customers.repeat + ' (' + d.customers.repeatRate + '%)</dd></div>' +
          '<div class="detail-row"><dt>Orders delivered</dt><dd>' + A.fmt.num(d.fulfilment.delivered) + '</dd></div>' +
          '<div class="detail-row"><dt>Avg delivery time</dt><dd>' +
            (d.fulfilment.avgHours ? d.fulfilment.avgHours + ' hours' : '—') + '</dd></div>' +
        '</dl></div>' +
        '<div class="detail-title mt-24">Top Products (30 days)</div>' +
        A.barList(d.topProducts.slice(0, 5).map(function (p) {
          return { label: p.name, value: p.revenue, display: A.fmt.money(p.revenue) };
        }), { emptyText: 'No sales in this period' });
    } catch (e) {
      document.getElementById('summary').innerHTML =
        '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  })();
})();
