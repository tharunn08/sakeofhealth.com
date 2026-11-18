(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('customers', 'Customers')) return;
  A.ensureOverlay();

  var content = document.getElementById('content');
  var state = { search: '', sort: 'recent', customers: [] };

  document.getElementById('topbarActions').innerHTML =
    '<button class="btn btn-ghost btn-sm" id="exportBtn">' + A.icon('download') + '<span class="hide-sm">Export CSV</span></button>';

  function shell() {
    content.innerHTML =
      '<div class="toolbar">' +
        '<div class="search-box">' + A.icon('search') +
          '<input class="input" id="search" placeholder="Search name, email or phone…" value="' + A.esc(state.search) + '"/></div>' +
        '<div class="tabs" id="sortTabs">' +
          '<button class="tab' + (state.sort === 'recent' ? ' active' : '') + '" data-sort="recent">Recent</button>' +
          '<button class="tab' + (state.sort === 'spent' ? ' active' : '') + '" data-sort="spent">Top spenders</button>' +
          '<button class="tab' + (state.sort === 'orders' ? ' active' : '') + '" data-sort="orders">Most orders</button>' +
        '</div></div>' +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>' +
      '<aside class="drawer" id="custDrawer">' +
        '<div class="drawer-head"><h2 id="drawerTitle">Customer</h2><div class="spacer"></div>' +
        '<button class="close-btn" id="drawerClose">' + A.icon('close') + '</button></div>' +
        '<div class="drawer-body" id="drawerBody"></div></aside>';

    document.getElementById('sortTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-sort]'); if (!b) return;
      state.sort = b.dataset.sort; shell(); load();
    });
    var searchEl = document.getElementById('search'), timer;
    searchEl.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { state.search = searchEl.value.trim(); load(); }, 300);
    });
    document.getElementById('drawerClose').addEventListener('click', function () { A.closePanel(); });
  }

  function render() {
    var host = document.getElementById('host');
    if (!state.customers.length) {
      host.innerHTML = A.emptyState('customers', 'No customers found',
        state.search ? 'Try a different search term.' : 'Customers appear here after their first order.');
      return;
    }
    host.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Customer</th><th class="hide-sm">Contact</th><th class="hide-xs">Location</th>' +
      '<th class="td-right">Orders</th><th class="td-right">Total Spent</th>' +
      '<th class="hide-sm">Last Order</th></tr></thead><tbody>' +
      state.customers.map(function (c) {
        return '<tr class="clickable" data-id="' + A.esc(c.id) + '">' +
          '<td><div class="flex items-center gap-12">' +
            '<div class="sb-avatar">' + A.esc(A.fmt.initials(c.name)) + '</div>' +
            '<div><div class="td-strong">' + A.esc(c.name || 'Guest') + '</div>' +
            (c.orderCount > 1 ? '<div class="td-muted">Repeat customer</div>' : '') +
            '</div></div></td>' +
          '<td class="hide-sm"><div>' + A.esc(A.fmt.phone(c.phone)) + '</div>' +
            '<div class="td-muted" style="font-size:11.5px">' + A.esc(c.email || '') + '</div></td>' +
          '<td class="hide-xs td-muted">' + A.esc((c.lastAddress && c.lastAddress.city) || '—') + '</td>' +
          '<td class="td-right td-strong">' + (c.orderCount || 0) + '</td>' +
          '<td class="td-right td-strong">' + A.fmt.money(c.totalSpent) + '</td>' +
          '<td class="hide-sm td-muted td-nowrap">' + A.esc(A.fmt.relative(c.lastOrderAt)) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';

    host.querySelectorAll('tr[data-id]').forEach(function (r) {
      r.addEventListener('click', function () { openCustomer(r.dataset.id); });
    });
  }

  async function openCustomer(id) {
    var drawer = document.getElementById('custDrawer');
    var body = document.getElementById('drawerBody');
    body.innerHTML = A.loadingState();
    A.openPanel(drawer);
    try {
      var d = await A.api.get('/customers/' + id);
      var c = d.customer, orders = d.orders;
      document.getElementById('drawerTitle').textContent = c.name || 'Customer';
      var addr = c.lastAddress || {};

      body.innerHTML =
        '<div class="detail-section"><div class="stat-grid" style="margin:0">' +
          '<div class="stat"><div class="stat-label">Orders</div><div class="stat-value">' + (c.orderCount || 0) + '</div></div>' +
          '<div class="stat blue"><div class="stat-label">Lifetime Value</div><div class="stat-value">' + A.fmt.money(c.totalSpent) + '</div></div>' +
        '</div></div>' +

        '<div class="detail-section"><div class="detail-title">Contact</div>' +
          '<div class="info-box"><strong>' + A.esc(c.name || '—') + '</strong>' +
          '<a href="tel:+91' + A.esc(c.phone) + '">' + A.esc(A.fmt.phone(c.phone)) + '</a><br/>' +
          '<a href="mailto:' + A.esc(c.email) + '">' + A.esc(c.email || '—') + '</a></div></div>' +

        '<div class="detail-section"><div class="detail-title">Last Known Address</div>' +
          '<div class="info-box">' +
          A.esc([addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ') || 'No address on file') +
          '</div>' +
          (c.lastLocation && c.lastLocation.lat
            ? '<a class="btn btn-ghost btn-sm mt-16" target="_blank" rel="noopener" ' +
              'href="https://www.google.com/maps/search/?api=1&query=' + c.lastLocation.lat + ',' + c.lastLocation.lng + '">' +
              A.icon('map') + 'View on map</a>'
            : '') +
        '</div>' +

        '<div class="detail-section"><div class="detail-title">Order History (' + orders.length + ')</div>' +
          (orders.length ? orders.map(function (o) {
            return '<a href="orders.html?open=' + A.esc(o.id) + '" class="line-item" style="text-decoration:none">' +
              '<div class="li-info"><strong class="td-mono">' + A.esc(o.orderId) + '</strong>' +
              '<span>' + A.esc(A.fmt.dateTime(o.createdAt)) + ' · ' +
              o.items.reduce(function (s, i) { return s + i.qty; }, 0) + ' items</span></div>' +
              '<div style="text-align:right"><div class="li-total">' + A.fmt.money(o.total) + '</div>' +
              '<div style="margin-top:4px">' + A.statusBadge(o.status) + '</div></div></a>';
          }).join('') : '<div class="info-box">No orders yet</div>') +
        '</div>' +

        '<div class="detail-section"><div class="detail-title">Internal Notes</div>' +
          '<textarea class="textarea" id="custNote" placeholder="Private notes about this customer…">' +
          A.esc(c.notes || '') + '</textarea>' +
          '<button class="btn btn-ghost btn-sm mt-16" id="saveNote">Save note</button></div>';

      document.getElementById('saveNote').addEventListener('click', async function () {
        try {
          await A.api.patch('/customers/' + c.id, { notes: document.getElementById('custNote').value });
          A.toast('Note saved', 'success');
        } catch (e) { A.toast(e.message, 'error'); }
      });
    } catch (e) {
      body.innerHTML = '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  async function load() {
    try {
      var p = new URLSearchParams({ sort: state.sort });
      if (state.search) p.set('search', state.search);
      var d = await A.api.get('/customers?' + p);
      state.customers = d.customers;
      render();
    } catch (e) {
      document.getElementById('host').innerHTML =
        '<div class="alert alert-error" style="margin:20px">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

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

  document.getElementById('exportBtn').addEventListener('click', function () {
    downloadCsv('/api/admin/reports/customers.csv', 'customers.csv');
  });

  shell();
  load();
})();
