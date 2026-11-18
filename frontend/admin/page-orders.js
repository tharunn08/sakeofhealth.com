(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('orders', 'Orders')) return;
  A.ensureOverlay();
  // Cancelling is for managers and admins (the server enforces the same rule).
  var role = ((A.Auth.user && A.Auth.user()) || {}).role;
  var canCancel = role === 'admin' || role === 'manager';

  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var state = {
    status: params.get('status') || '',
    range: params.get('range') || '',
    from: '',
    to: '',
    search: '',
    page: 1,
    data: null,
  };

  document.getElementById('topbarActions').innerHTML =
    '<button class="btn btn-ghost btn-sm" id="printPageBtn" title="Print delivery labels for the orders listed below">' + A.icon('print') + '<span class="hide-sm">Print labels</span></button>' +
    '<button class="btn btn-ghost btn-sm" id="exportBtn">' + A.icon('download') + '<span class="hide-sm">Export CSV</span></button>' +
    '<button class="btn btn-ghost btn-sm" id="refreshBtn">' + A.icon('refresh') + '</button>';

  var STATUS_TABS = [
    { id: '', label: 'All' },
    { id: 'pending', label: 'Pending' },
    { id: 'accepted', label: 'Accepted' },
    { id: 'prepared', label: 'Prepared' },
    { id: 'out_for_delivery', label: 'Out for Delivery' },
    { id: 'delivered', label: 'Delivered' },
    { id: 'cancelled', label: 'Cancelled' },
  ];
  var RANGE_TABS = [
    { id: '', label: 'All time' },
    { id: 'today', label: 'Today' },
    { id: 'yesterday', label: 'Yesterday' },
    { id: 'week', label: 'This week' },
    { id: 'custom', label: 'Custom dates' },
  ];

  function shell() {
    content.innerHTML =
      '<div class="toolbar">' +
        '<div class="search-box">' + A.icon('search') +
          '<input class="input" id="search" placeholder="Search order ID, name, phone or email…" ' +
          'value="' + A.esc(state.search) + '"/></div>' +
        '<div class="tabs" id="rangeTabs">' + RANGE_TABS.map(function (t) {
          return '<button class="tab' + (state.range === t.id ? ' active' : '') +
            '" data-range="' + t.id + '">' + A.esc(t.label) + '</button>';
        }).join('') + '</div>' +
      '</div>' +
      (state.range === 'custom'
        ? '<div class="card mb-16"><div class="card-body" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">' +
          '<div class="field" style="margin:0"><label for="fromDate">From</label>' +
            '<input class="input" type="date" id="fromDate" value="' + A.esc(state.from) + '"/></div>' +
          '<div class="field" style="margin:0"><label for="toDate">To</label>' +
            '<input class="input" type="date" id="toDate" value="' + A.esc(state.to) + '"/></div>' +
          '<button class="btn btn-primary btn-sm" id="applyDates">Apply</button>' +
          '</div></div>'
        : '') +
      '<div class="tabs mb-16" id="statusTabs" style="overflow-x:auto">' + STATUS_TABS.map(function (t) {
        return '<button class="tab' + (state.status === t.id ? ' active' : '') +
          '" data-status="' + t.id + '">' + A.esc(t.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="card"><div class="card-body tight" id="tableHost">' + A.loadingState() + '</div></div>' +
      drawerHTML();

    document.getElementById('statusTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-status]'); if (!b) return;
      state.status = b.dataset.status; state.page = 1; syncURL(); shell(); load();
    });
    document.getElementById('rangeTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-range]'); if (!b) return;
      state.range = b.dataset.range; state.page = 1; syncURL(); shell(); load();
    });
    var applyBtn = document.getElementById('applyDates');
    if (applyBtn) applyBtn.addEventListener('click', function () {
      state.from = document.getElementById('fromDate').value;
      state.to = document.getElementById('toDate').value;
      state.page = 1; load();
    });

    var searchEl = document.getElementById('search');
    var timer;
    searchEl.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { state.search = searchEl.value.trim(); state.page = 1; load(); }, 320);
    });

    document.getElementById('drawerClose').addEventListener('click', function () { A.closePanel(); });
  }

  function syncURL() {
    var p = new URLSearchParams();
    if (state.status) p.set('status', state.status);
    if (state.range) p.set('range', state.range);
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
  }

  function drawerHTML() {
    return '<aside class="drawer" id="orderDrawer">' +
      '<div class="drawer-head"><h2 id="drawerTitle">Order</h2><div class="spacer"></div>' +
      '<button class="close-btn" id="drawerClose">' + A.icon('close') + '</button></div>' +
      '<div class="drawer-body" id="drawerBody"></div></aside>';
  }

  /* ═════════ TABLE ═════════ */

  function renderTable(d) {
    var host = document.getElementById('tableHost');
    if (!d.orders.length) {
      host.innerHTML = A.emptyState('inbox', 'No orders found',
        state.search || state.status || state.range
          ? 'Try adjusting your filters or search term.'
          : 'Orders placed on your storefront will appear here.');
      return;
    }

    host.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Order ID</th><th>Customer</th><th class="hide-sm">Delivery Address</th>' +
      '<th class="hide-xs">Items</th><th class="td-right">Total</th>' +
      '<th class="hide-xs">Payment</th><th>Status</th><th class="hide-sm">Placed</th>' +
      '</tr></thead><tbody>' +
      d.orders.map(function (o) {
        var addr = o.address || {};
        var loc = [addr.city, addr.pincode].filter(Boolean).join(' · ');
        return '<tr class="clickable" data-id="' + A.esc(o.id) + '">' +
          '<td class="td-mono td-strong">' + A.esc(o.orderId) + '</td>' +
          '<td><div class="td-strong">' + A.esc(o.customer.name) + '</div>' +
            '<div class="td-muted">' + A.esc(A.fmt.phone(o.customer.phone)) + '</div></td>' +
          '<td class="hide-sm td-muted" style="max-width:200px">' +
            A.esc(addr.line1 || '—') + '<br/><span style="font-size:11.5px">' + A.esc(loc) + '</span></td>' +
          '<td class="hide-xs">' + o.items.reduce(function (s, i) { return s + i.qty; }, 0) + '</td>' +
          '<td class="td-right td-strong">' + A.fmt.money(o.total) + '</td>' +
          '<td class="hide-xs"><span class="badge ' +
            (o.payment.status === 'paid' ? 'badge-paid' : 'badge-unpaid') + '">' +
            A.esc(o.payment.method === 'cod' ? 'COD' : 'Online') + '</span></td>' +
          '<td>' + A.statusBadge(o.status) + '</td>' +
          '<td class="hide-sm td-muted td-nowrap">' + A.esc(A.fmt.relative(o.createdAt)) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' +
      (d.pages > 1 ? pagination(d) : '');

    host.querySelectorAll('tr[data-id]').forEach(function (row) {
      row.addEventListener('click', function () { openOrder(row.dataset.id); });
    });

    var prev = host.querySelector('#pgPrev'), next = host.querySelector('#pgNext');
    if (prev) prev.addEventListener('click', function () { state.page--; load(); });
    if (next) next.addEventListener('click', function () { state.page++; load(); });
  }

  function pagination(d) {
    return '<div class="pagination">' +
      '<span class="info">Page ' + d.page + ' of ' + d.pages + ' · ' + d.total + ' orders</span>' +
      '<div class="spacer"></div>' +
      '<button class="btn btn-ghost btn-sm" id="pgPrev"' + (d.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button class="btn btn-ghost btn-sm" id="pgNext"' + (d.page >= d.pages ? ' disabled' : '') + '>Next</button>' +
      '</div>';
  }

  /* ═════════ ORDER DETAIL ═════════ */

  async function openOrder(id) {
    var drawer = document.getElementById('orderDrawer');
    var body = document.getElementById('drawerBody');
    body.innerHTML = A.loadingState();
    A.openPanel(drawer);
    try {
      var o = await A.api.get('/orders/' + encodeURIComponent(id));
      document.getElementById('drawerTitle').textContent = o.orderId;
      body.innerHTML = orderDetailHTML(o);
      wireDetail(o);
    } catch (e) {
      body.innerHTML = '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  function orderDetailHTML(o) {
    var addr = o.address || {};
    var addrText = [addr.doorNo, addr.line1, addr.line2, addr.landmark, addr.city, addr.state, addr.pincode]
      .filter(Boolean).join(', ');

    /* Status pipeline buttons */
    var currentIdx = A.STATUS_FLOW.indexOf(o.status);
    var actions = '';
    if (o.status !== 'cancelled' && o.status !== 'delivered') {
      actions = '<div class="status-actions">' +
        A.STATUS_FLOW.slice(1).map(function (s, i) {
          var idx = i + 1;
          var isCurrent = o.status === s;
          var isPast = currentIdx > idx;
          return '<button class="status-btn' + (isCurrent ? ' is-current' : '') + '" ' +
            'data-status="' + s + '"' + (isPast || isCurrent ? ' disabled' : '') + '>' +
            '<span class="sb-num">' + (isPast ? '✓' : idx) + '</span>' +
            A.esc(A.STATUS[s].short) + '</button>';
        }).join('') + '</div>' +
        (canCancel ? '<button class="btn btn-danger-ghost btn-sm mt-16" id="cancelOrderBtn">Cancel this order…</button>' : '');
    } else {
      actions = '<div class="alert alert-' + (o.status === 'delivered' ? 'success' : 'error') + ' mb-0">' +
        A.icon(o.status === 'delivered' ? 'check' : 'alert') +
        '<span>This order is ' + A.esc(A.STATUS[o.status].short.toLowerCase()) + ' and can no longer be updated.' +
        (o.status === 'cancelled' && o.cancelReason
          ? '<br/>Reason: ' + A.esc(o.cancelReason) + (o.cancelledBy ? ' — ' + A.esc(o.cancelledBy) : '') +
            (o.cancelledAt ? ', ' + A.esc(A.fmt.dateTime ? A.fmt.dateTime(o.cancelledAt) : o.cancelledAt) : '')
          : '') +
        (o.status === 'cancelled' && o.refundRequired
          ? '<br/><strong>Refund required:</strong> this order was paid online. Refund payment ' + A.esc((o.payment && o.payment.paymentId) || '') + ' in your Razorpay dashboard.'
          : '') +
        '</span></div>';
    }

    /* Timeline */
    var doneStatuses = (o.timeline || []).map(function (t) { return t.status; });
    var timelineSteps = (o.status === 'cancelled' ? doneStatuses : A.STATUS_FLOW).map(function (s) {
      var entry = (o.timeline || []).filter(function (t) { return t.status === s; }).pop();
      var isDone = !!entry;
      var isCurrent = o.status === s;
      return '<div class="step' + (isDone ? ' done' : ' pending-step') + (isCurrent ? ' current' : '') + '">' +
        '<div class="step-dot">' + (isDone ? A.icon('check', 12) : '') + '</div>' +
        '<div class="step-content"><strong>' + A.esc(A.STATUS[s] ? A.STATUS[s].label : s) + '</strong>' +
        '<span>' + (entry ? A.esc(A.fmt.dateTime(entry.at)) + (entry.by && entry.by !== 'system' ? ' · ' + A.esc(entry.by) : '') : 'Not yet') + '</span>' +
        (entry && entry.note ? '<span>' + A.esc(entry.note) + '</span>' : '') +
        '</div></div>';
    }).join('');

    /* Map */
    var mapHTML = '';
    if (o.location && o.location.lat) {
      var q = o.location.lat + ',' + o.location.lng;
      mapHTML =
        '<div class="detail-section"><div class="detail-title">Customer Location (shared)</div>' +
        '<div class="map-embed"><iframe loading="lazy" referrerpolicy="no-referrer-when-downgrade" ' +
        'src="https://www.openstreetmap.org/export/embed.html?bbox=' +
        (o.location.lng - 0.006) + ',' + (o.location.lat - 0.004) + ',' +
        (o.location.lng + 0.006) + ',' + (o.location.lat + 0.004) +
        '&layer=mapnik&marker=' + o.location.lat + ',' + o.location.lng + '"></iframe></div>' +
        '<div class="flex items-center gap-8 mt-16" style="flex-wrap:wrap">' +
        '<a class="btn btn-primary btn-sm" target="_blank" rel="noopener" ' +
        'href="https://www.google.com/maps/dir/?api=1&destination=' + q + '">' +
        A.icon('map') + 'Get directions</a>' +
        '<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" ' +
        'href="https://www.google.com/maps/search/?api=1&query=' + q + '">' +
        'Open pin in Google Maps</a>' +
        '</div>' +
        '<div class="td-muted td-mono mt-16" style="font-size:11.5px">' + A.esc(q) +
        (o.location.accuracy ? ' · ±' + Math.round(o.location.accuracy) + 'm' : '') +
        ' · ' + A.esc(o.location.source === 'gps' ? 'GPS' : 'Map pin') + '</div>' +
        '</div>';
    } else {
      mapHTML = '<div class="detail-section"><div class="detail-title">Customer Location</div>' +
        '<div class="info-box td-muted">No GPS location was shared for this order. Use the address above.</div></div>';
    }

    return '' +
      /* Status + actions */
      '<div class="detail-section">' +
        '<div class="flex items-center gap-12 mb-16" style="flex-wrap:wrap">' +
          A.statusBadge(o.status) +
          '<span class="td-muted">Placed ' + A.esc(A.fmt.dateTime(o.createdAt)) + '</span>' +
        '</div>' +
        '<div class="detail-title">Update Order Status</div>' + actions +
        '<div id="statusMsg"></div>' +
      '</div>' +

      /* Print: delivery label for the parcel + bill */
      '<div class="detail-section"><div class="detail-title">Print</div>' +
        '<div class="flex gap-8" style="flex-wrap:wrap">' +
        '<a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="print.html?src=b2c&doc=label&ids=' + encodeURIComponent(o.id) + '">' +
          A.icon('print') + 'Delivery label</a>' +
        '<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="print.html?src=b2c&doc=bill&ids=' + encodeURIComponent(o.id) + '">' +
          A.icon('reports') + 'Bill</a>' +
        '</div>' +
        '<div class="td-muted mt-16" style="font-size:12px">The label goes on the parcel: address, phone, items, and a QR code the rider scans for directions.</div>' +
      '</div>' +

      /* Timeline */
      '<div class="detail-section"><div class="detail-title">Progress</div>' +
        '<div class="stepper">' + timelineSteps + '</div></div>' +

      /* Items */
      '<div class="detail-section"><div class="detail-title">Items</div>' +
        o.items.map(function (i) {
          return '<div class="line-item">' +
            (i.image ? '<img src="' + A.esc(i.image) + '" alt="" onerror="this.style.visibility=\'hidden\'"/>' : '<div class="product-thumb"></div>') +
            '<div class="li-info"><strong>' + A.esc(i.name) + '</strong>' +
            '<span>' + A.fmt.money(i.price) + ' × ' + i.qty + '</span></div>' +
            '<div class="li-total">' + A.fmt.money(i.price * i.qty) + '</div></div>';
        }).join('') +
        '<dl style="margin-top:14px;border-top:1px solid var(--line-2);padding-top:12px">' +
          '<div class="detail-row"><dt>Subtotal</dt><dd>' + A.fmt.money(o.subtotal) + '</dd></div>' +
          (o.discount ? '<div class="detail-row"><dt>Discount' +
            (o.couponCode ? ' (' + A.esc(o.couponCode) + ')' : '') + '</dt>' +
            '<dd style="color:var(--brand)">− ' + A.fmt.money(o.discount) + '</dd></div>' : '') +
          '<div class="detail-row"><dt>Delivery</dt><dd>' +
            (o.shipping ? A.fmt.money(o.shipping) : 'Free') + '</dd></div>' +
          '<div class="detail-row" style="border-top:1px solid var(--line-2);margin-top:6px;padding-top:11px">' +
            '<dt style="font-weight:700;color:var(--ink)">Total</dt>' +
            '<dd style="font-size:16px;font-weight:700">' + A.fmt.money(o.total) + '</dd></div>' +
        '</dl></div>' +

      /* Customer */
      '<div class="detail-section"><div class="detail-title">Customer</div>' +
        '<div class="info-box"><strong>' + A.esc(o.customer.name) + '</strong>' +
        '<a href="tel:+91' + A.esc(o.customer.phone) + '">' + A.esc(A.fmt.phone(o.customer.phone)) + '</a><br/>' +
        '<a href="mailto:' + A.esc(o.customer.email) + '">' + A.esc(o.customer.email) + '</a></div></div>' +

      /* Address */
      '<div class="detail-section"><div class="detail-title">Delivery Address</div>' +
        '<div class="info-box">' + A.esc(addrText || 'No address on file') + '</div>' +
        '<div class="flex items-center gap-8 mt-16">' +
        '<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" ' +
        'href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addrText) + '">' +
        A.icon('map') + 'Find address on map</a></div></div>' +

      mapHTML +

      /* Payment */
      '<div class="detail-section"><div class="detail-title">Payment</div>' +
        '<dl>' +
        '<div class="detail-row"><dt>Method</dt><dd>Online payment</dd></div>' +
        '<div class="detail-row"><dt>Status</dt><dd><span class="badge ' +
          (o.payment.status === 'paid' ? 'badge-paid' : 'badge-unpaid') + '">' +
          A.esc(o.payment.status) + '</span></dd></div>' +
        (o.payment.gateway ? '<div class="detail-row"><dt>Gateway</dt><dd>' + A.esc(o.payment.gateway) + '</dd></div>' : '') +
        (o.payment.paymentId ? '<div class="detail-row"><dt>Payment ID</dt><dd class="td-mono" style="font-size:11.5px">' +
          A.esc(o.payment.paymentId) + '</dd></div>' : '') +
        '</dl></div>' +

      /* Assignment */
      (o.assignedTo ? '<div class="detail-section"><div class="detail-title">Delivery Agent</div>' +
        '<div class="info-box"><strong>' + A.esc(o.assignedTo.name) + '</strong>' +
        A.esc(A.fmt.phone(o.assignedTo.phone || '')) + '</div></div>' : '') +

      /* Internal note */
      '<div class="detail-section"><div class="detail-title">Internal Note</div>' +
        '<textarea class="textarea" id="orderNote" placeholder="Add a private note about this order…">' +
        A.esc(o.notes || '') + '</textarea>' +
        '<div class="flex gap-8 mt-16">' +
        '<button class="btn btn-ghost btn-sm" id="saveNote">Save note</button>' +
        '<button class="btn btn-ghost btn-sm" id="resendBtn">Resend notification</button>' +
        '</div></div>' +

      /* Orders are cancelled with a reason, never deleted (Phase 0.5.7, D10). */
      '';
  }

  function wireDetail(o) {
    document.querySelectorAll('[data-status]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var status = btn.dataset.status;

        var all = document.querySelectorAll('[data-status]');
        all.forEach(function (b) { b.disabled = true; });
        btn.innerHTML = '<span class="spinner dark"></span> Updating…';
        try {
          await A.api.patch('/orders/' + o.id + '/status', { status: status });
          A.toast('Status updated — customer notified', 'success');
          openOrder(o.id);
          load();
          A.loadBadges();
        } catch (e) {
          A.toast(e.message, 'error');
          all.forEach(function (b) { b.disabled = false; });
        }
      });
    });

    var saveBtn = document.getElementById('saveNote');
    if (saveBtn) saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      try {
        await A.api.patch('/orders/' + o.id, { notes: document.getElementById('orderNote').value });
        A.toast('Note saved', 'success');
      } catch (e) { A.toast(e.message, 'error'); }
      saveBtn.disabled = false;
    });

    var resend = document.getElementById('resendBtn');
    if (resend) resend.addEventListener('click', async function () {
      resend.disabled = true;
      resend.innerHTML = '<span class="spinner dark"></span> Sending…';
      try {
        await A.api.post('/orders/' + o.id + '/resend-notification', {});
        A.toast('Notification resent', 'success');
      } catch (e) { A.toast(e.message, 'error'); }
      resend.disabled = false;
      resend.textContent = 'Resend notification';
    });

    var cancelBtn = document.getElementById('cancelOrderBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', async function () {
      var reason = askCancelReason(o);
      if (!reason) return;
      cancelBtn.disabled = true;
      cancelBtn.innerHTML = '<span class="spinner dark"></span> Cancelling…';
      try {
        var r = await A.api.post('/orders/' + o.id + '/cancel', { reason: reason });
        A.toast(r && r.refundRequired ? 'Order cancelled — refund the payment in Razorpay' : 'Order cancelled — customer notified', 'success');
        openOrder(o.id);
        load();
        A.loadBadges();
      } catch (e) {
        A.toast(e.message, 'error');
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = 'Cancel this order…';
      }
    });
  }

  /** Ask for the (required) cancellation reason; null when the manager backs out. */
  function askCancelReason(o) {
    var paid = o.payment && o.payment.status === 'paid';
    var msg = 'Cancel order ' + o.orderId + '?\n\nThe order is kept on record and the customer is notified.' +
      (paid ? '\nIt was paid online, so you will need to refund it in Razorpay.' : '') +
      '\n\nReason for cancelling (required):';
    for (;;) {
      var reason = window.prompt(msg, '');
      if (reason === null) return null;
      reason = reason.trim();
      if (reason.length >= 3) return reason.slice(0, 500);
      msg = 'Please type a reason of at least 3 characters (or press Cancel to keep the order):';
    }
  }

  /* ═════════ LOAD ═════════ */

  async function load() {
    var p = new URLSearchParams();
    if (state.status) p.set('status', state.status);
    if (state.range === 'custom') {
      if (state.from) p.set('from', state.from);
      if (state.to) p.set('to', state.to);
    } else if (state.range) {
      p.set('range', state.range);
    }
    if (state.search) p.set('search', state.search);
    p.set('page', state.page);
    p.set('limit', 25);
    try {
      state.data = await A.api.get('/orders?' + p.toString());
      renderTable(state.data);
    } catch (e) {
      document.getElementById('tableHost').innerHTML =
        '<div class="alert alert-error" style="margin:20px">' + A.icon('alert') +
        '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  document.getElementById('refreshBtn').addEventListener('click', function () { load(); A.loadBadges(); });
  document.getElementById('printPageBtn').addEventListener('click', function () {
    var list = (state.data && state.data.orders) || [];
    // Skip orders that are already finished — nobody needs a label for those.
    var ids = list.filter(function (o) { return o.status !== 'cancelled' && o.status !== 'delivered'; }).map(function (o) { return o.id; });
    if (!ids.length) { A.toast('No open orders in this list to print labels for', 'error'); return; }
    window.open('print.html?src=b2c&doc=label&ids=' + encodeURIComponent(ids.join(',')), '_blank', 'noopener');
  });
  document.getElementById('exportBtn').addEventListener('click', function () {
    var p = new URLSearchParams();
    if (state.status) p.set('status', state.status);
    p.set('token', A.Auth.token());
    window.open('/api/admin/reports/orders.csv?' + p.toString(), '_blank');
  });

  shell();
  load();

  var openId = params.get('open');
  if (openId) openOrder(openId);
})();
