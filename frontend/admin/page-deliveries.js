(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('deliveries', 'Deliveries')) return;

  var content = document.getElementById('content');
  var state = { data: null, filter: '' };
  // What this role may do here (the server enforces the same rules).
  var role = ((A.Auth.user && A.Auth.user()) || {}).role;
  var isAgent = role === 'delivery';
  var canAssign = !isAgent;
  var canRemove = role === 'admin' || role === 'manager';   // may cancel orders

  var COLUMNS = [
    { id: 'accepted', label: 'Accepted', next: 'prepared', nextLabel: 'Mark Prepared' },
    { id: 'prepared', label: 'Prepared', next: 'out_for_delivery', nextLabel: 'Send Out' },
    { id: 'out_for_delivery', label: 'Out for Delivery', next: 'delivered', nextLabel: 'Mark Delivered' },
  ];

  document.getElementById('topbarActions').innerHTML =
    '<button class="btn btn-ghost btn-sm" id="printAllBtn" title="Print delivery labels for every order on this board">' + A.icon('print') + '<span class="hide-sm">Print labels</span></button>' +
    '<button class="btn btn-ghost btn-sm" id="refreshBtn">' + A.icon('refresh') + '</button>';

  function render(d) {
    content.innerHTML =
      '<div class="stat-grid">' +
        '<div class="stat blue"><div class="stat-label">Accepted</div><div class="stat-value">' + d.counts.accepted + '</div>' +
          '<div class="stat-sub">Awaiting preparation</div></div>' +
        '<div class="stat violet"><div class="stat-label">Prepared</div><div class="stat-value">' + d.counts.prepared + '</div>' +
          '<div class="stat-sub">Ready to dispatch</div></div>' +
        '<div class="stat teal"><div class="stat-label">Out for Delivery</div><div class="stat-value">' + d.counts.out_for_delivery + '</div>' +
          '<div class="stat-sub">On the road</div></div>' +
        '<div class="stat ' + (d.counts.unassigned ? 'amber' : '') + '"><div class="stat-label">Unassigned</div>' +
          '<div class="stat-value">' + d.counts.unassigned + '</div>' +
          '<div class="stat-sub">' + d.agents.length + ' agents available</div></div>' +
      '</div>' +
      (d.agents.length === 0
        ? '<div class="alert alert-warn mb-20">' + A.icon('alert') +
          '<span>No delivery agents yet. Add staff with the <strong>delivery</strong> role to assign orders.</span></div>'
        : '') +
      '<div class="grid-3">' + COLUMNS.map(function (col) {
        var items = d.deliveries.filter(function (x) { return x.status === col.id; });
        return '<div class="card"><div class="card-head"><h2>' + A.esc(col.label) + '</h2>' +
          '<div class="spacer"></div><span class="badge badge-neutral no-dot">' + items.length + '</span></div>' +
          '<div class="card-body" style="max-height:calc(100vh - 340px);overflow-y:auto">' +
          (items.length ? items.map(function (o) { return card(o, col, d.agents); }).join('')
            : '<div class="empty" style="padding:28px 12px"><p>Nothing here right now</p></div>') +
          '</div></div>';
      }).join('') + '</div>';

    wire();
  }

  function card(o, col, agents) {
    var addr = o.address || {};
    var addrText = [addr.line1, addr.line2, addr.city, addr.pincode].filter(Boolean).join(', ');
    return '<div class="card mb-16" style="box-shadow:none;border-color:var(--line-2)"><div class="card-body" style="padding:14px">' +
      '<div class="flex items-center gap-8 mb-16">' +
        '<a href="orders.html?open=' + A.esc(o.id) + '" class="td-mono td-strong" style="font-size:12.5px">' +
        A.esc(o.orderId) + '</a>' +
        '<div class="spacer" style="flex:1"></div>' +
        '<span class="badge badge-paid">Paid ' + A.fmt.money(o.total) + '</span>' +
      '</div>' +
      '<div class="td-strong">' + A.esc(o.customer.name) + '</div>' +
      '<div class="td-muted mb-16" style="line-height:1.5">' +
        '<a href="tel:+91' + A.esc(o.customer.phone) + '">' + A.esc(A.fmt.phone(o.customer.phone)) + '</a><br/>' +
        A.esc(addrText) + '</div>' +
      (o.assignedTo
        ? '<div class="info-box mb-16" style="padding:9px 11px;font-size:12.5px">' +
          '<strong style="margin:0">' + A.esc(o.assignedTo.name) + '</strong>' +
          A.esc(A.fmt.phone(o.assignedTo.phone || '')) + '</div>'
        : (canAssign && agents.length
          ? '<select class="select mb-16" data-assign="' + A.esc(o.id) + '" style="font-size:12.5px;padding:7px 10px">' +
            '<option value="">Assign agent…</option>' +
            agents.map(function (a) { return '<option value="' + A.esc(a.id) + '">' + A.esc(a.name) + '</option>'; }).join('') +
            '</select>'
          : '')) +
      '<div class="flex gap-8" style="flex-wrap:wrap">' +
        (!isAgent || col.next === 'delivered'
          ? '<button class="btn btn-primary btn-sm" data-next="' + A.esc(o.id) + '" data-status="' + col.next + '">' +
            A.esc(col.nextLabel) + '</button>'
          : '') +
        (o.location && o.location.lat
          ? '<a class="btn btn-ghost btn-icon" target="_blank" rel="noopener" title="Get directions" ' +
            'href="https://www.google.com/maps/dir/?api=1&destination=' + o.location.lat + ',' + o.location.lng + '">' +
            A.icon('map') + '</a>'
          : '<a class="btn btn-ghost btn-icon" target="_blank" rel="noopener" title="Find address" ' +
            'href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addrText) + '">' +
            A.icon('map') + '</a>') +
        '<a class="btn btn-ghost btn-icon" target="_blank" rel="noopener" title="Print delivery label" ' +
          'href="print.html?src=b2c&doc=label&ids=' + encodeURIComponent(o.id) + '">' + A.icon('print') + '</a>' +
        (canRemove
          ? '<button class="btn btn-danger-ghost btn-icon" data-cancel="' + A.esc(o.id) + '" data-oid="' + A.esc(o.orderId) + '" data-paid="' + (o.payment && o.payment.status === 'paid' ? '1' : '') + '" title="Cancel order">' +
            A.icon('close') + '</button>'
          : '') +
      '</div></div></div>';
  }

  function wire() {
    document.querySelectorAll('[data-next]').forEach(function (b) {
      b.addEventListener('click', async function () {
        b.disabled = true;
        b.innerHTML = '<span class="spinner"></span>';
        try {
          await A.api.patch('/orders/' + b.dataset.next + '/status', { status: b.dataset.status });
          A.toast('Status updated — customer notified', 'success');
          load(); A.loadBadges();
        } catch (e) {
          A.toast(e.message, 'error');
          b.disabled = false;
        }
      });
    });
    document.querySelectorAll('[data-assign]').forEach(function (sel) {
      sel.addEventListener('change', async function () {
        if (!sel.value) return;
        sel.disabled = true;
        try {
          await A.api.post('/deliveries/' + sel.dataset.assign + '/assign', { agentId: sel.value });
          A.toast('Delivery assigned — agent notified', 'success');
          load();
        } catch (e) {
          A.toast(e.message, 'error');
          sel.disabled = false;
        }
      });
    });
    // Orders are cancelled with a reason, never deleted (Phase 0.5.7, D10).
    document.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', async function () {
        var msg = 'Cancel order ' + b.dataset.oid + '?\n\nThe order is kept on record and the customer is notified.' +
          (b.dataset.paid ? '\nIt was paid online, so you will need to refund it in Razorpay.' : '') +
          '\n\nReason for cancelling (required):';
        var reason;
        for (;;) {
          reason = window.prompt(msg, '');
          if (reason === null) return;
          reason = reason.trim();
          if (reason.length >= 3) break;
          msg = 'Please type a reason of at least 3 characters (or press Cancel to keep the order):';
        }
        b.disabled = true;
        b.innerHTML = '<span class="spinner dark"></span>';
        try {
          var r = await A.api.post('/orders/' + b.dataset.cancel + '/cancel', { reason: reason.slice(0, 500) });
          A.toast(r && r.refundRequired ? 'Order cancelled — refund the payment in Razorpay' : 'Order cancelled — customer notified', 'success');
          load(); A.loadBadges();
        } catch (e) {
          A.toast(e.message, 'error');
          b.disabled = false;
          b.innerHTML = A.icon('close');
        }
      });
    });
  }

  async function load() {
    if (!state.data) content.innerHTML = A.loadingState();
    try {
      state.data = await A.api.get('/deliveries');
      render(state.data);
    } catch (e) {
      content.innerHTML = '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  document.getElementById('printAllBtn').addEventListener('click', function () {
    var ids = ((state.data && state.data.deliveries) || []).map(function (o) { return o.id; });
    if (!ids.length) { A.toast('Nothing on the board to print', 'error'); return; }
    window.open('print.html?src=b2c&doc=label&ids=' + encodeURIComponent(ids.join(',')), '_blank', 'noopener');
  });
  document.getElementById('refreshBtn').addEventListener('click', load);
  load();
  setInterval(function () { if (!document.hidden) load(); }, 45000);
})();
