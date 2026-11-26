/* ═══════════ Sake of Health — Business portal (retailers & distributors) ═══════════
 * A small single-page app. The server decides everything that matters
 * (prices, totals, stock, credit, who can see what) — this file only displays
 * it. Every value placed in the page goes through esc().
 */
(function () {
  'use strict';
  var KEY = 'soh_b2b';
  var main = document.getElementById('main');
  var S = { me: null, cartCount: 0, cats: null };

  /* ─────────── utilities ─────────── */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function money(v, dp) { return '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp }); }
  function date(d) { return d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function dateTime(d) { return d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—'; }
  function ago(d) { var m = Math.floor((Date.now() - new Date(d).getTime()) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; var h = Math.floor(m / 60); if (h < 24) return h + ' h ago'; var dd = Math.floor(h / 24); return dd < 7 ? dd + ' d ago' : date(d); }
  function phone(p) { p = String(p || ''); return p.length === 10 ? p.slice(0, 5) + ' ' + p.slice(5) : p; }
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms || 300); }; }
  function uid() { var a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function qstr(o) { var p = new URLSearchParams(); Object.keys(o).forEach(function (k) { if (o[k] !== '' && o[k] != null && o[k] !== false) p.set(k, o[k] === true ? '1' : o[k]); }); var s = p.toString(); return s ? '?' + s : ''; }

  var LABEL = { pending_admin_approval: 'Awaiting approval', submitted: 'Submitted', approved: 'Approved', assigned: 'Sent to supplier', accepted: 'Accepted', processing: 'Processing', packed: 'Packed',
    dispatched: 'Dispatched', out_for_delivery: 'Out for delivery', delivered: 'Delivered', partially_delivered: 'Partly delivered', cancelled: 'Cancelled', rejected: 'Not approved', returned: 'Returned',
    refunded: 'Refunded', pending: 'Pending', under_review: 'Under review', suspended: 'Suspended', partial: 'Part paid', paid: 'Paid', requested: 'Requested', pickup_scheduled: 'Pickup scheduled',
    received: 'Received', completed: 'Completed', bank_transfer: 'Bank transfer', upi: 'UPI', gateway: 'Online', credit: 'On credit', credit_note: 'Credit note', cash: 'Cash', cheque: 'Cheque', adjustment: 'Adjustment' };
  var TONE = { pending_admin_approval: 'amber', submitted: 'amber', approved: 'blue', assigned: 'blue', accepted: 'violet', processing: 'violet', packed: 'teal', dispatched: 'teal', out_for_delivery: 'teal',
    delivered: 'green', partially_delivered: 'green', cancelled: 'red', rejected: 'red', returned: 'red', pending: 'amber', partial: 'amber', paid: 'green', requested: 'amber', completed: 'green', received: 'blue',
    under_review: 'amber', suspended: 'red' };
  function label(s) { return LABEL[s] || String(s || '').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function badge(s, text) { return '<span class="badge b-' + (TONE[s] || '') + '">' + esc(text || label(s)) + '</span>'; }

  var ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>', box: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>', bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8"/>', rupee: '<path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>', bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>', search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>', more: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>', store: '<path d="M3 9l1-5h16l1 5M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>',
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>', inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  };
  function icon(n) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[n] || '') + '</svg>'; }
  function empty(ic, title, text, action) { return '<div class="empty">' + icon(ic) + '<b>' + esc(title) + '</b><div>' + esc(text || '') + '</div>' + (action || '') + '</div>'; }
  function toast(text, err) { var t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = text; document.body.appendChild(t); setTimeout(function () { t.remove(); }, err ? 4200 : 2600); }

  /* ─────────── session + API ─────────── */
  function session() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function logout(expired) { localStorage.removeItem(KEY); location.replace('/login?to=business' + (expired ? '&expired=1' : '')); }

  async function api(path, opts) {
    opts = opts || {};
    var s = session();
    if (!s || !s.token) { logout(); throw new Error('Please log in'); }
    var headers = Object.assign({ Authorization: 'Bearer ' + s.token }, opts.headers || {});
    var body = opts.body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    var res;
    try { res = await fetch('/api/b2b' + path, { method: opts.method || 'GET', headers: headers, body: body }); }
    catch (e) { throw new Error('No connection. Check your internet and try again.'); }
    if (res.status === 401) { logout(true); throw new Error('Session ended'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) { var err = new Error(data.error || 'Something went wrong. Please try again.'); err.status = res.status; err.data = data; throw err; }
    return data;
  }
  var get = api;
  function post(p, b, h) { return api(p, { method: 'POST', body: b || {}, headers: h }); }
  function put(p, b) { return api(p, { method: 'PUT', body: b || {} }); }
  function del(p) { return api(p, { method: 'DELETE' }); }

  /* ─────────── sheets (modal / bottom sheet) ─────────── */
  function sheet(o) {
    closeSheet();
    var el = document.createElement('div'); el.className = 'scrim'; el.id = 'scrim';
    el.innerHTML = '<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-h"><h2>' + esc(o.title) + '</h2><button class="x" aria-label="Close">×</button></div><div class="sheet-b"><div id="sheetMsg"></div>' + o.body + '</div>' +
      (o.onOk ? '<div class="sheet-f"><button class="btn" data-x>Cancel</button><button class="btn ' + (o.danger ? 'danger' : 'pri') + '" id="sheetOk">' + esc(o.ok || 'Save') + '</button></div>' : '') + '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (e) { if (e.target === el || e.target.closest('.x') || e.target.closest('[data-x]')) closeSheet(); });
    if (o.onOk) $('#sheetOk').addEventListener('click', async function () {
      var b = $('#sheetOk'), old = b.textContent; b.disabled = true; b.textContent = 'Please wait…';
      try { var keep = await o.onOk(); if (keep !== false) closeSheet(); }
      catch (e) { if ($('#sheetMsg')) $('#sheetMsg').innerHTML = '<div class="alert err">' + esc(e.message) + '</div>'; b.disabled = false; b.textContent = old; }
    });
    if (o.after) o.after(el);
  }
  function closeSheet() { var el = $('#scrim'); if (el) el.remove(); }
  function ask(title, text, opts, fn) {
    opts = opts || {};
    sheet({ title: title, ok: opts.ok || 'Confirm', danger: opts.danger, body: (text ? '<p style="margin-bottom:14px">' + esc(text) + '</p>' : '') +
      '<div class="field"><label for="askReason">' + esc(opts.label || 'Reason') + '</label><textarea class="ta" id="askReason" maxlength="300"></textarea></div>', onOk: function () { return fn($('#askReason').value.trim()); } });
  }

  /* ─────────── shell + router ─────────── */
  function isDist() { return S.me.account.account_type === 'distributor'; }
  function approved() { return S.me.account.status === 'approved'; }

  function nav() {
    if (!approved()) return [{ path: 'dashboard', label: 'Status', icon: 'home' }, { path: 'profile', label: 'Profile', icon: 'user' }];
    var n = [{ path: 'dashboard', label: 'Home', icon: 'home', bot: true }];
    if (isDist()) n.push({ sep: 'My retailers' }, { path: 'retailer-orders', label: 'Retailer orders', icon: 'inbox', bot: true, botLabel: 'To fulfil' }, { path: 'retailers', label: 'My retailers', icon: 'users' },
      { path: 'receivables', label: 'Receivables', icon: 'rupee' }, { path: 'stock', label: 'My stock', icon: 'box' }, { sep: 'Buy from Sake of Health' });
    n.push({ path: 'products', label: 'Products', icon: 'box', bot: true }, { path: 'quick-order', label: 'Quick order', icon: 'bolt', bot: !isDist() }, { path: 'cart', label: 'Cart', icon: 'cart', count: 'cart' },
      { path: 'orders', label: isDist() ? 'My purchases' : 'Orders', icon: 'list', bot: true }, { path: 'invoices', label: 'Invoices', icon: 'doc' }, { path: 'payments', label: 'Payments & credit', icon: 'rupee' },
      { path: 'returns', label: 'Returns', icon: 'undo' });
    if (!isDist()) n.push({ path: 'distributor', label: 'My distributor', icon: 'truck' });
    n.push({ path: 'profile', label: 'Profile', icon: 'user', bot: true, botLabel: 'More' });
    return n;
  }

  function renderShell(active, title) {
    var a = S.me.account, items = nav();
    $('#side').innerHTML = '<div class="side-brand"><img class="brand-logo" src="/assets/images/logo-mark.png" alt=""><b>Sake of Health</b><span>Business portal</span></div><nav class="side-nav">' + items.map(function (i) {
      if (i.sep) return '<div class="sep">' + esc(i.sep) + '</div>';
      return '<a href="/b2b/' + i.path + '" data-link class="' + (i.path === active ? 'on' : '') + '">' + icon(i.icon) + '<span>' + esc(i.label) + '</span>' + (i.count === 'cart' && S.cartCount ? '<span class="count">' + S.cartCount + '</span>' : '') + '</a>'; }).join('') +
      '</nav><div class="side-foot"><b>' + esc(a.shop_name || a.business_name) + '</b><span>' + esc(a.account_type) + ' · ' + esc(a.city) + '</span></div>';
    $('#top').innerHTML = '<a class="top-brand" href="/b2b/dashboard" data-link><img class="brand-logo sm" src="/assets/images/logo-mark.png" alt="">Sake of Health<small>' + esc(a.account_type) + ' portal</small></a><div class="top-title">' + esc(title) + '</div>' +
      (approved() ? '<a class="icon-btn" href="/b2b/notifications" data-link aria-label="Notifications">' + icon('bell') + (S.me.unreadNotifications ? '<span class="dot">' + Math.min(99, S.me.unreadNotifications) + '</span>' : '') + '</a>' +
        '<a class="icon-btn" href="/b2b/cart" data-link aria-label="Cart">' + icon('cart') + (S.cartCount ? '<span class="dot">' + S.cartCount + '</span>' : '') + '</a>' : '');
    var bots = items.filter(function (i) { return i.bot; }).slice(0, 5);
    if (!approved()) bots = items;
    $('#bot').innerHTML = bots.map(function (i) { return '<a href="/b2b/' + i.path + '" data-link class="' + (i.path === active ? 'on' : '') + '">' + icon(i.icon) + esc(i.botLabel || i.label) + '</a>'; }).join('');
    document.title = title + ' — Sake of Health Business';
  }
  function head(title, actions) { return '<div class="page-h"><h1 class="dup">' + esc(title) + '</h1>' + (actions || '') + '</div>'; }
  function loading() { main.innerHTML = '<div class="spin"></div>'; }
  function fail(e) { main.innerHTML = '<div class="alert err">' + esc(e.message) + '</div><button class="btn" id="retry">Try again</button>'; $('#retry').addEventListener('click', route); }

  var ROUTES = {};
  function go(path) { history.pushState(null, '', '/b2b/' + path); route(); window.scrollTo(0, 0); }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); closeSheet();
    if (a.getAttribute('href') !== location.pathname + location.search) history.pushState(null, '', a.getAttribute('href'));
    route(); window.scrollTo(0, 0);
  });
  window.addEventListener('popstate', route);

  async function route() {
    var parts = location.pathname.replace(/^\/b2b\/?/, '').split('/').filter(Boolean);
    var name = parts[0] || 'dashboard', id = parts[1];
    if (!approved() && name !== 'profile') name = 'dashboard';
    var view = ROUTES[name] || ROUTES.dashboard;
    var bar = $('#cartbar'); if (bar) bar.remove();
    try { await view(id); } catch (e) { if (e.status === 403 && e.data && e.data.accountStatus) { await loadMe(); ROUTES.dashboard(); } else fail(e); }
  }
  async function loadMe() { S.me = await get('/me'); }
  async function refreshCart() { try { var c = await get('/cart'); S.cartCount = c.items.length; return c; } catch (e) { return null; } }
  function printDoc(src, doc, ids) { window.open('/b2b/print.html?src=' + src + '&doc=' + doc + '&ids=' + encodeURIComponent([].concat(ids).join(',')), '_blank', 'noopener'); }

  /* ═════════════════ Status (not yet approved) ═════════════════ */
  async function statusView() {
    var a = S.me.account;
    renderShell('dashboard', 'Application status');
    var copy = {
      pending: ['Your registration is with our team', 'We are verifying your details and documents. This usually takes one or two working days. You will get an email and a WhatsApp message as soon as it is approved.', 'warn'],
      under_review: ['Your registration is being reviewed', 'A member of our team is checking your documents now. You do not need to do anything.', 'info'],
      rejected: ['Your registration was not approved', (S.me.statusReason ? 'Reason: ' + S.me.statusReason + '. ' : '') + 'If you believe this is a mistake, contact us and we will take another look.', 'err'],
      suspended: ['Your account is suspended', (S.me.statusReason ? 'Reason: ' + S.me.statusReason + '. ' : '') + 'Ordering is paused. Please contact us to reinstate your account.', 'err'],
    }[a.status] || ['Account status: ' + a.status, '', 'info'];
    var docs = await get('/me/documents');
    var steps = ['Registered', 'Under review', 'Approved'], at = a.status === 'pending' ? 0 : a.status === 'under_review' ? 1 : 0;
    main.innerHTML = head('Application status') +
      '<div class="alert ' + copy[2] + '" style="font-size:14.5px"><b>' + esc(copy[0]) + '</b><br/>' + esc(copy[1]) + '</div>' +
      (a.status === 'pending' || a.status === 'under_review' ? '<div class="card"><div class="card-b"><div class="track">' + steps.map(function (s, i) { return '<div class="' + (i <= at ? 'done' : '') + (i === at ? ' now' : '') + '">' + s + '</div>'; }).join('') + '</div></div></div>' : '') +
      '<div class="card"><div class="card-h"><h2>What you submitted</h2></div><div class="card-b"><dl class="kv left">' +
        '<dt>Business</dt><dd>' + esc(a.business_name) + (a.shop_name ? ' · ' + esc(a.shop_name) : '') + '</dd><dt>Type</dt><dd style="text-transform:capitalize">' + esc(a.account_type) + '</dd>' +
        '<dt>Contact</dt><dd>' + esc(a.contact_person) + ' · ' + esc(phone(a.mobile)) + '</dd><dt>GSTIN</dt><dd class="mono">' + esc(a.gstin || '—') + '</dd>' +
        '<dt>Address</dt><dd>' + esc([a.address_line1, a.landmark, a.city, a.district_name, a.state_name, a.pincode].filter(Boolean).join(', ')) + '</dd></dl></div></div>' +
      '<div class="card"><div class="card-h"><h2>Documents</h2></div><div class="list">' + (docs.documents.length ? docs.documents.map(function (d) {
        return '<div><div class="grow"><b>' + esc(docs.labels[d.doc_type] || d.doc_type) + '</b><span>' + esc(d.original_name) + ' · uploaded ' + esc(date(d.created_at)) + '</span></div><span class="badge b-green">Received</span></div>'; }).join('') : '<div class="muted">No documents uploaded yet.</div>') + '</div>' +
        '<div class="card-b" style="border-top:1px solid var(--line-2)"><a class="btn sm" href="/b2b/profile" data-link>Add another document</a></div></div>' +
      '<p class="muted small" style="margin-top:16px;text-align:center">Need help? ' + (window.SOH_CONFIG && SOH_CONFIG.supportPhone ? 'Call ' + esc(SOH_CONFIG.supportPhone) + ' · ' : '') + '<button class="link" id="lo">Log out</button></p>';
    $('#lo').addEventListener('click', function () { logout(); });
  }

  /* ═════════════════ Dashboard ═════════════════ */
  function creditCard(c, title) {
    var limit = Number(c.credit_limit), used = Number(c.credit_used), pct = limit ? Math.min(100, Math.round(used / limit * 100)) : 0;
    if (!limit && !used) return '<div class="stat"><small>' + esc(title || 'Credit') + '</small><b>Not enabled</b><span>Pay by UPI, bank transfer or online</span></div>';
    return '<div class="stat"><small>' + esc(title || 'Credit') + '</small><b>' + money(c.available, 0) + '</b><span>available of ' + money(limit, 0) + ' limit</span><div class="meter"><i class="' + (pct >= 100 ? 'max' : pct >= 80 ? 'hot' : '') + '" style="width:' + pct + '%"></i></div>' +
      '<span>' + money(used, 0) + ' used · ' + esc(c.credit_days) + ' day terms</span></div>';
  }
  function orderRow(o, base) {
    return '<a href="/b2b/' + base + '/' + o.id + '" data-link><div class="grow"><b class="mono">' + esc(o.order_no) + '</b><span>' + (o.ship_name ? esc(o.ship_name) + ' · ' : '') + esc(o.total_qty) + ' units · ' + esc(ago(o.created_at)) + '</span></div>' +
      '<div class="end"><b>' + money(o.grand_total, 0) + '</b>' + badge(o.status) + '</div></a>';
  }
  ROUTES.dashboard = async function () {
    if (!approved()) return statusView();
    renderShell('dashboard', 'Home'); loading();
    var d = await get('/dashboard'), a = S.me.account;
    var html = head('Hello, ' + (a.contact_person || '').split(' ')[0]);
    if (isDist()) {
      var r = d.retailerOrders;
      html += (r.new ? '<a class="alert warn" style="display:block" href="/b2b/retailer-orders?status=assigned" data-link><b>' + r.new + ' new retailer order' + (r.new === 1 ? '' : 's') + '</b> waiting for you to accept →</a>' : '') +
        '<div class="grid g4"><a class="stat hl" href="/b2b/retailer-orders?status=assigned" data-link><small>New orders</small><b>' + r.new + '</b><span>to accept</span></a>' +
        '<a class="stat" href="/b2b/retailer-orders?status=accepted,processing,packed" data-link><small>Processing</small><b>' + ((r.pending - r.new) + r.processing) + '</b><span>accepted · packing</span></a>' +
        '<a class="stat" href="/b2b/retailer-orders?status=dispatched,out_for_delivery" data-link><small>On the way</small><b>' + r.inTransit + '</b><span>dispatched</span></a>' +
        '<a class="stat" href="/b2b/retailer-orders?status=delivered,partially_delivered" data-link><small>Delivered</small><b>' + r.delivered + '</b><span>all time</span></a></div>' +
        '<div class="grid g4" style="margin-top:12px"><a class="stat" href="/b2b/retailers" data-link><small>My retailers</small><b>' + d.retailers + '</b><span>mapped to you</span></a>' +
        '<div class="stat"><small>Sales · 30 days</small><b>' + money(d.sales30.value, 0) + '</b><span>' + d.sales30.orders + ' orders</span></div>' +
        '<a class="stat" href="/b2b/receivables" data-link><small>Retailers owe you</small><b>' + money(d.receivable.amount, 0) + '</b><span>' + d.receivable.orders + ' unpaid orders</span></a>' +
        '<a class="stat" href="/b2b/payments" data-link><small>You owe us</small><b>' + money(d.myOutstanding.amount, 0) + '</b><span>' + d.myOutstanding.orders + ' unpaid orders</span></a></div>' +
        '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin-top:12px">' + creditCard(d.credit, 'Your credit with Sake of Health') +
        '<div class="stat"><small>Stock up</small><b style="font-size:16px;margin:4px 0 8px">Order from Sake of Health</b><div class="btn-row"><a class="btn pri sm" href="/b2b/products" data-link>Browse products</a><a class="btn sm" href="/b2b/quick-order" data-link>Quick order</a></div></div></div>' +
        '<div class="card"><div class="card-h"><h2>Latest retailer orders</h2><span class="sp"></span><a class="link small" href="/b2b/retailer-orders" data-link>See all</a></div><div class="list">' +
        (d.recentRetailerOrders.length ? d.recentRetailerOrders.map(function (o) { return orderRow(o, 'retailer-orders'); }).join('') : empty('inbox', 'No retailer orders yet', 'Orders from retailers mapped to you will appear here.')) + '</div></div>' +
        '<div class="card"><div class="card-h"><h2>Your purchases</h2><span class="sp"></span><a class="link small" href="/b2b/orders" data-link>See all</a></div><div class="list">' +
        (d.myRecentOrders.length ? d.myRecentOrders.map(function (o) { return orderRow(o, 'orders'); }).join('') : empty('box', 'Nothing ordered yet', 'Stock up from the catalogue.')) + '</div></div>';
    } else {
      html += '<div class="grid g4"><a class="stat hl" href="/b2b/orders" data-link><small>Open orders</small><b>' + d.orders.open + '</b><span>in progress</span></a>' +
        '<a class="stat" href="/b2b/orders?status=delivered,partially_delivered" data-link><small>Delivered</small><b>' + d.orders.delivered + '</b><span>all time</span></a>' +
        '<a class="stat" href="/b2b/payments" data-link><small>Outstanding</small><b>' + money(d.outstanding.amount, 0) + '</b><span>' + d.outstanding.orders + ' unpaid orders</span></a>' +
        '<a class="stat" href="/b2b/cart" data-link><small>Cart</small><b>' + S.cartCount + '</b><span>product' + (S.cartCount === 1 ? '' : 's') + ' waiting</span></a></div>' +
        '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin-top:12px">' +
        '<a class="stat" href="/b2b/distributor" data-link><small>My distributor</small>' + (d.distributor ? '<b style="font-size:17px">' + esc(d.distributor.name) + '</b><span>' + esc(d.distributor.contact_person) + ' · ' + esc(phone(d.distributor.mobile)) + '</span>'
          : '<b style="font-size:17px">Sake of Health (direct)</b><span>No distributor assigned yet — we supply you directly</span>') + '</a>' + creditCard(d.credit, 'Credit') + '</div>' +
        '<div class="btn-row" style="margin:14px 0"><a class="btn pri" href="/b2b/products" data-link>' + icon('box') + 'Browse products</a><a class="btn" href="/b2b/quick-order" data-link>' + icon('bolt') + 'Quick order</a>' +
        '<a class="btn" href="/b2b/products?frequent=1" data-link>' + icon('undo') + 'Buy again</a><a class="btn" href="/b2b/products?favorites=1" data-link>' + icon('heart') + 'Favourites</a></div>' +
        '<div class="card"><div class="card-h"><h2>Recent orders</h2><span class="sp"></span><a class="link small" href="/b2b/orders" data-link>See all</a></div><div class="list">' +
        (d.recentOrders.length ? d.recentOrders.map(function (o) { return orderRow(o, 'orders'); }).join('') : empty('box', 'No orders yet', 'Your first order is reviewed by our team before it is processed.')) + '</div></div>';
    }
    main.innerHTML = html;
  };

  /* ═════════════════ Products ═════════════════ */
  function stepper(p, qty) {
    var stepSize = p.enforce_case_multiple && p.case_qty > 1 ? p.case_qty : 1;
    if (!qty) return '<button class="btn pri sm" data-add="' + p.id + '" data-qty="' + p.min_qty + '"' + (p.stock === 'out' ? ' disabled' : '') + '>' + (p.stock === 'out' ? 'Out of stock' : 'Add ' + p.min_qty) + '</button>';
    return '<div class="step" data-step="' + p.id + '" data-min="' + p.min_qty + '" data-size="' + stepSize + '"><button type="button" data-dir="-1" aria-label="Less">−</button>' +
      '<input type="number" inputmode="numeric" value="' + qty + '" aria-label="Quantity"/><button type="button" data-dir="1" aria-label="More">+</button></div>';
  }
  function productCard(p) {
    var rule = 'MOQ ' + p.moq + (p.case_qty > 1 ? ' · case of ' + p.case_qty : '');
    return '<div class="prod" data-p="' + p.id + '"><button class="fav' + (p.is_favorite ? ' on' : '') + '" data-fav="' + p.id + '" aria-label="Favourite">' + icon('heart') + '</button>' +
      '<div class="prod-img">' + (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="" loading="lazy"/>' : esc((p.name || '?')[0])) + '</div>' +
      '<div><div class="prod-name">' + esc(p.name) + '</div><div class="prod-meta"><span class="mono">' + esc(p.sku) + '</span>' + (p.pack_size ? ' · ' + esc(p.pack_size) : '') + '</div>' +
      '<div class="prod-price"><b>' + money(p.unit_price) + '</b>' + (p.list_price ? '<s>' + money(p.list_price) + '</s>' : '') + '<span>+ ' + Number(p.gst_rate) + '% GST · MRP ' + money(p.mrp, 0) + '</span></div>' +
      (p.promo ? '<div class="prod-slabs">★ ' + esc(p.promo) + '</div>' : '') +
      (p.slabs.length ? '<div class="prod-slabs">' + p.slabs.slice(1).map(function (s) { return s.minQty + '+ : ' + money(s.unitPrice); }).join(' · ') + '</div>' : '') + '</div>' +
      '<div class="prod-buy"><div class="rule">' + esc(rule) + (p.stock === 'low' ? '<br/><span style="color:var(--amber);font-weight:600">Low stock</span>' : '') + '</div><span data-buy="' + p.id + '">' + stepper(p, p.in_cart) + '</span></div></div>';
  }
  var saveQty = debounce(async function (p, qty, slot) {
    try {
      var cart = await put('/cart/items/' + p.id, { qty: qty });
      S.cartCount = cart.items.length; p.in_cart = qty; cartBar(cart);
      if (!qty && slot) slot.innerHTML = stepper(p, 0);
    } catch (e) { toast(e.message, true); if (slot) slot.innerHTML = stepper(p, p.in_cart); }
  }, 350);
  function cartBar(cart) {
    var bar = $('#cartbar');
    if (!cart || !cart.items.length) { if (bar) bar.remove(); renderCounts(); return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'cartbar'; bar.className = 'cartbar'; document.body.appendChild(bar); }
    bar.innerHTML = '<div><b>' + cart.items.length + ' product' + (cart.items.length === 1 ? '' : 's') + ' · ' + money(cart.totals.grand_total, 0) + '</b><span>' + cart.totals.total_qty + ' units incl. GST</span></div><a class="btn" href="/b2b/cart" data-link>View cart</a>';
    renderCounts();
  }
  function renderCounts() { $$('.icon-btn[href="/b2b/cart"]').forEach(function (a) { var d = a.querySelector('.dot'); if (S.cartCount) { if (!d) { d = document.createElement('span'); d.className = 'dot'; a.appendChild(d); } d.textContent = S.cartCount; } else if (d) d.remove(); }); }

  ROUTES.products = ROUTES.favorites = async function () {
    renderShell('products', 'Products');
    var q = new URLSearchParams(location.search);
    var st = { q: q.get('q') || '', category_id: q.get('category_id') || '', favorites: q.get('favorites') === '1', frequent: q.get('frequent') === '1', page: 1, items: {}, total: 0 };
    if (!S.cats) S.cats = (await get('/categories')).categories;
    main.innerHTML = head('Products') + '<div class="search" style="margin-bottom:12px">' + icon('search') + '<input class="in" id="pq" placeholder="Search by name, SKU or barcode" value="' + esc(st.q) + '" autocomplete="off"/></div>' +
      '<div class="chips" id="pchips" style="margin-bottom:14px"></div><div class="pgrid" id="pgrid"></div><div class="pager" id="ppager"></div>';
    function chips() {
      $('#pchips').innerHTML = '<button class="chip' + (!st.category_id && !st.favorites && !st.frequent ? ' on' : '') + '" data-c="">All</button>' +
        '<button class="chip' + (st.frequent ? ' on' : '') + '" data-f="frequent">Buy again</button><button class="chip' + (st.favorites ? ' on' : '') + '" data-f="favorites">♥ Favourites</button>' +
        S.cats.map(function (c) { return '<button class="chip' + (String(st.category_id) === String(c.id) ? ' on' : '') + '" data-c="' + c.id + '">' + esc(c.name) + '</button>'; }).join('');
    }
    async function load(append) {
      if (!append) { $('#pgrid').innerHTML = '<div class="spin" style="grid-column:1/-1"></div>'; st.items = {}; }
      try {
        var d = await get('/products' + qstr({ q: st.q, category_id: st.category_id, favorites: st.favorites, frequent: st.frequent, page: st.page, limit: 24 }));
        d.items.forEach(function (p) { st.items[p.id] = p; });
        var html = d.items.map(productCard).join('');
        if (append) $('#pgrid').insertAdjacentHTML('beforeend', html);
        else $('#pgrid').innerHTML = html || '<div style="grid-column:1/-1">' + empty('search', st.favorites ? 'No favourites yet' : st.frequent ? 'Nothing ordered yet' : 'No products found', st.favorites ? 'Tap the heart on a product to keep it here.' : st.frequent ? 'Products you order will show up here for quick re-ordering.' : 'Try a different search or category.') + '</div>';
        $('#ppager').innerHTML = d.page < d.pages ? '<button class="btn" id="more">Show more (' + (d.total - d.page * d.limit) + ' left)</button>' : (d.total > 12 ? '<span class="muted small">' + d.total + ' products</span>' : '');
        if ($('#more')) $('#more').addEventListener('click', function () { st.page++; load(true); });
      } catch (e) { $('#pgrid').innerHTML = '<div class="alert err" style="grid-column:1/-1">' + esc(e.message) + '</div>'; }
    }
    chips(); load();
    refreshCart().then(cartBar);
    $('#pq').addEventListener('input', debounce(function () { st.q = $('#pq').value.trim(); st.page = 1; load(); }, 320));
    $('#pchips').addEventListener('click', function (e) {
      var b = e.target.closest('.chip'); if (!b) return;
      if (b.dataset.f) { var on = !st[b.dataset.f]; st.favorites = st.frequent = false; st[b.dataset.f] = on; st.category_id = ''; }
      else { st.category_id = b.dataset.c; st.favorites = st.frequent = false; }
      st.page = 1; chips(); load();
    });
    $('#pgrid').addEventListener('click', function (e) {
      var fav = e.target.closest('[data-fav]'), add = e.target.closest('[data-add]'), dir = e.target.closest('[data-dir]');
      if (fav) { var on = !fav.classList.contains('on'); fav.classList.toggle('on', on); api('/favorites/' + fav.dataset.fav, { method: on ? 'PUT' : 'DELETE', body: {} }).catch(function (er) { toast(er.message, true); fav.classList.toggle('on', !on); }); return; }
      if (add) { var p = st.items[add.dataset.add], slot = add.parentNode; slot.innerHTML = stepper(p, p.min_qty); saveQty(p, p.min_qty, slot); return; }
      if (dir) {
        var box = dir.closest('[data-step]'), p2 = st.items[box.dataset.step], inp = box.querySelector('input'), size = Number(box.dataset.size), min = Number(box.dataset.min);
        var v = (Number(inp.value) || 0) + Number(dir.dataset.dir) * size;
        if (v < min) v = 0;
        inp.value = v; saveQty(p2, v, box.parentNode);
      }
    });
    $('#pgrid').addEventListener('change', function (e) {
      var box = e.target.closest('[data-step]'); if (!box) return;
      var p = st.items[box.dataset.step], v = Math.max(0, Math.floor(Number(e.target.value) || 0));
      saveQty(p, v, box.parentNode);
    });
  };

  /* ═════════════════ Quick order ═════════════════ */
  ROUTES['quick-order'] = async function () {
    renderShell('quick-order', 'Quick order');
    var rows = [{ sku: '', qty: '' }, { sku: '', qty: '' }, { sku: '', qty: '' }, { sku: '', qty: '' }, { sku: '', qty: '' }];
    main.innerHTML = head('Quick order') + '<div class="alert info">Type a SKU (or scan a barcode) and a quantity on each line — or paste two columns straight from Excel. Then add everything to your cart in one go.</div>' +
      '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th style="width:38%">SKU / barcode</th><th>Product</th><th style="width:110px">Qty</th></tr></thead><tbody id="qrows"></tbody></table></div></div>' +
      '<div class="card-b" style="border-top:1px solid var(--line-2)"><div class="btn-row"><button class="btn sm" id="qadd">+ Add 5 lines</button><button class="btn sm" id="qpaste">Paste from Excel</button><span style="flex:1"></span>' +
      '<button class="btn pri" id="qgo">Add all to cart</button></div><div id="qmsg" style="margin-top:12px"></div></div></div>';
    var known = {};
    function draw() {
      $('#qrows').innerHTML = rows.map(function (r, i) {
        var p = known[String(r.sku).toLowerCase()];
        return '<tr><td><input class="in mono" data-i="' + i + '" data-k="sku" value="' + esc(r.sku) + '" placeholder="GUM001" autocapitalize="characters" autocomplete="off"/></td>' +
          '<td class="small">' + (r.sku ? (p ? '<b>' + esc(p.name) + '</b><br/><span class="muted">' + money(p.unit_price) + ' · MOQ ' + p.moq + (p.case_qty > 1 ? ' · case ' + p.case_qty : '') + '</span>' : (r.err ? '<span style="color:var(--red)">' + esc(r.err) + '</span>' : '<span class="muted">…</span>')) : '') + '</td>' +
          '<td><input class="in num" data-i="' + i + '" data-k="qty" type="number" inputmode="numeric" value="' + esc(r.qty) + '" placeholder="' + (p ? p.min_qty : '0') + '"/></td></tr>'; }).join('');
    }
    var lookup = debounce(async function () {
      var need = rows.map(function (r) { return String(r.sku).trim(); }).filter(function (s) { return s && !known[s.toLowerCase()]; });
      for (var i = 0; i < need.length; i++) {
        try { var d = await get('/products?limit=5&q=' + encodeURIComponent(need[i]));
          var hit = d.items.filter(function (p) { return p.sku.toLowerCase() === need[i].toLowerCase() || p.barcode === need[i]; })[0];
          if (hit) known[need[i].toLowerCase()] = hit; else rows.forEach(function (r) { if (String(r.sku).trim().toLowerCase() === need[i].toLowerCase()) r.err = 'Not found'; });
        } catch (e) { /* ignore */ }
      }
      var active = document.activeElement, pos = active && active.dataset ? [active.dataset.i, active.dataset.k] : null;
      draw();
      if (pos && pos[0] != null) { var el = $('[data-i="' + pos[0] + '"][data-k="' + pos[1] + '"]'); if (el) { el.focus(); if (el.setSelectionRange && el.type !== 'number') el.setSelectionRange(el.value.length, el.value.length); } }
    }, 450);
    draw();
    $('#qrows').addEventListener('input', function (e) { var i = e.target.dataset.i, k = e.target.dataset.k; if (i == null) return; rows[i][k] = e.target.value; if (k === 'sku') { rows[i].err = ''; lookup(); } });
    $('#qadd').addEventListener('click', function () { for (var i = 0; i < 5; i++) rows.push({ sku: '', qty: '' }); draw(); });
    $('#qpaste').addEventListener('click', function () {
      sheet({ title: 'Paste from Excel', ok: 'Use these lines', body: '<p class="muted small" style="margin-bottom:10px">One product per line: SKU, then quantity (separated by a tab, comma or space).</p><textarea class="ta mono" id="pasteBox" style="min-height:180px" placeholder="GUM001&#9;20&#10;GUM002&#9;12"></textarea>',
        onOk: function () {
          var parsed = $('#pasteBox').value.split(/\r?\n/).map(function (l) { var m = l.trim().split(/[\t,; ]+/); return m[0] ? { sku: m[0], qty: m[1] || '' } : null; }).filter(Boolean);
          if (!parsed.length) throw new Error('Nothing to add — paste at least one line.');
          rows = parsed.concat(rows.filter(function (r) { return r.sku; })).slice(0, 300); draw(); lookup();
        } });
    });
    $('#qgo').addEventListener('click', async function () {
      var lines = rows.filter(function (r) { return String(r.sku).trim(); }).map(function (r) { return { sku: String(r.sku).trim(), qty: Number(r.qty) }; });
      if (!lines.length) return toast('Enter at least one SKU and quantity', true);
      $('#qgo').disabled = true;
      try {
        var r = await post('/cart/bulk', { lines: lines });
        S.cartCount = r.cart.items.length; renderCounts();
        if (!r.errors.length) { toast(r.added + ' product' + (r.added === 1 ? '' : 's') + ' added to cart'); return go('cart'); }
        $('#qmsg').innerHTML = '<div class="alert ' + (r.added ? 'warn' : 'err') + '"><b>' + r.added + ' added, ' + r.errors.length + ' need attention:</b><br/>' + r.errors.map(function (e) { return 'Line ' + e.row + ' (' + esc(e.sku) + '): ' + esc(e.error); }).join('<br/>') + '</div>' +
          (r.added ? '<a class="btn pri" href="/b2b/cart" data-link>Go to cart</a>' : '');
      } catch (e) { toast(e.message, true); }
      $('#qgo').disabled = false;
    });
  };

  /* ═════════════════ Cart + checkout ═════════════════ */
  ROUTES.cart = ROUTES.checkout = async function () {
    renderShell('cart', 'Cart'); loading();
    var cart = await get('/cart');
    S.cartCount = cart.items.length;
    var keyName = 'soh_b2b_order_key';
    function draw() {
      renderCounts();
      if (!cart.items.length) { main.innerHTML = head('Cart') + '<div class="card">' + empty('cart', 'Your cart is empty', 'Add products from the catalogue or use quick order.', '<div class="btn-row" style="justify-content:center;margin-top:14px"><a class="btn pri" href="/b2b/products" data-link>Browse products</a><a class="btn" href="/b2b/quick-order" data-link>Quick order</a></div>') + '</div>'; return; }
      var t = cart.totals, saved = sessionStorage.getItem('soh_b2b_pay') || '';
      var methods = cart.payment.methods, chosen = methods.some(function (m) { return m.id === saved; }) ? saved : methods[0].id;
      main.innerHTML = head('Cart', '<button class="btn sm danger" id="clear">Empty cart</button>') +
        (cart.problems ? '<div class="alert err"><b>' + cart.problems + ' item' + (cart.problems === 1 ? ' needs' : 's need') + ' attention</b> before you can place the order.</div>' : '') +
        '<div class="card"><div class="list">' + cart.items.map(function (i) {
          var size = i.enforce_case_multiple && i.case_qty > 1 ? i.case_qty : 1;
          return '<div style="align-items:flex-start;flex-wrap:wrap"><div class="grow" style="min-width:180px"><b style="white-space:normal">' + esc(i.name) + '</b><span><span class="mono">' + esc(i.sku) + '</span> · ' + money(i.unit_price) + ' + ' + Number(i.gst_rate) + '% GST' +
            (i.list_price ? ' · <s>' + money(i.list_price) + '</s>' : '') + '</span>' + (i.problem ? '<span style="color:var(--red);font-weight:600;white-space:normal">' + esc(i.problem) + '</span>' : '') + '</div>' +
            '<div class="step" data-step="' + i.product_id + '" data-min="' + i.min_qty + '" data-size="' + size + '"><button type="button" data-dir="-1">−</button><input type="number" inputmode="numeric" value="' + i.qty + '"/><button type="button" data-dir="1">+</button></div>' +
            '<div class="end" style="min-width:92px"><b>' + money(i.line_total) + '</b><button class="link small" data-rm="' + i.product_id + '">Remove</button></div></div>'; }).join('') + '</div></div>' +
        '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(290px,1fr));margin-top:14px;align-items:start">' +
        '<div class="card"><div class="card-h"><h2>Payment</h2></div><div class="card-b">' + methods.map(function (m) {
          return '<label class="check" style="padding:9px 0"><input type="radio" name="pay" value="' + m.id + '"' + (m.id === chosen ? ' checked' : '') + '/><span><b>' + esc(m.label) + '</b>' +
            (m.id === 'credit' ? '<br/><span class="muted small">' + money(cart.payment.credit.available, 0) + ' available of ' + money(cart.payment.credit.credit_limit, 0) + '</span>' : '') +
            (m.id === 'gateway' ? '<br/><span class="muted small">Pay by card, UPI or net banking right after placing the order</span>' : '') +
            (m.id === 'bank_transfer' || m.id === 'upi' ? '<br/><span class="muted small">Pay ' + esc(cart.seller.name) + ' directly; they confirm receipt</span>' : '') + '</span></label>'; }).join('') +
          '<div class="field" style="margin-top:10px"><label for="notes">Note for the supplier (optional)</label><textarea class="ta" id="notes" maxlength="500" style="min-height:60px"></textarea></div></div></div>' +
        '<div class="card"><div class="card-h"><h2>Order summary</h2></div><div class="card-b"><dl class="kv">' +
          (Number(t.discount) ? '<dt>Gross</dt><dd>' + money(t.subtotal) + '</dd><dt>Discount</dt><dd>− ' + money(t.discount) + '</dd>' : '') +
          '<dt>Taxable value</dt><dd>' + money(t.taxable) + '</dd>' + (t.interstate ? '<dt>IGST</dt><dd>' + money(t.igst) + '</dd>' : '<dt>CGST</dt><dd>' + money(t.cgst) + '</dd><dt>SGST</dt><dd>' + money(t.sgst) + '</dd>') +
          (Number(t.round_off) ? '<dt>Round off</dt><dd>' + money(t.round_off) + '</dd>' : '') +
          '<dt style="font-weight:700;color:var(--ink);padding-top:8px;border-top:1px solid var(--line)">Total</dt><dd style="font-size:19px;font-weight:700;padding-top:8px;border-top:1px solid var(--line)">' + money(t.grand_total) + '</dd></dl>' +
          '<p class="muted small" style="margin:10px 0 14px">' + t.total_qty + ' units · supplied by <b>' + esc(cart.seller.name) + '</b>' + (Number(cart.min_order_value) ? ' · minimum order ' + money(cart.min_order_value, 0) : '') + '</p>' +
          '<button class="btn pri lg block" id="place"' + (cart.can_checkout ? '' : ' disabled') + '>Place order · ' + money(t.grand_total, 0) + '</button><div id="placeMsg" style="margin-top:10px"></div></div></div></div>';
      $('#clear').addEventListener('click', async function () { if (!confirm('Remove everything from your cart?')) return; await del('/cart'); cart = await get('/cart'); S.cartCount = 0; draw(); });
      $$('input[name=pay]').forEach(function (r) { r.addEventListener('change', function () { sessionStorage.setItem('soh_b2b_pay', r.value); }); });
      $('#place').addEventListener('click', place);
    }
    var update = debounce(async function (id, qty) { try { cart = await put('/cart/items/' + id, { qty: qty }); S.cartCount = cart.items.length; sessionStorage.removeItem(keyName); draw(); } catch (e) { toast(e.message, true); cart = await get('/cart'); draw(); } }, 400);
    main.addEventListener('click', onClick); main.addEventListener('change', onChange);
    function onClick(e) {
      if (!location.pathname.match(/\/(cart|checkout)$/)) { main.removeEventListener('click', onClick); main.removeEventListener('change', onChange); return; }
      var dir = e.target.closest('[data-dir]'), rm = e.target.closest('[data-rm]');
      if (rm) return update(rm.dataset.rm, 0);
      if (dir) { var box = dir.closest('[data-step]'), inp = box.querySelector('input'), v = (Number(inp.value) || 0) + Number(dir.dataset.dir) * Number(box.dataset.size); if (v < Number(box.dataset.min)) v = Number(dir.dataset.dir) < 0 ? 0 : Number(box.dataset.min); inp.value = v; update(box.dataset.step, v); }
    }
    function onChange(e) { var box = e.target.closest('[data-step]'); if (box && location.pathname.match(/\/(cart|checkout)$/)) update(box.dataset.step, Math.max(0, Math.floor(Number(e.target.value) || 0))); }

    async function place() {
      var btn = $('#place'), method = ($('input[name=pay]:checked') || {}).value;
      // One key per cart: pressing the button twice (or a retry on a slow network) can only ever create one order.
      var key = sessionStorage.getItem(keyName); if (!key) { key = uid(); sessionStorage.setItem(keyName, key); }
      btn.disabled = true; btn.textContent = 'Placing order…';
      try {
        var r = await post('/orders', { payment_method: method, notes: $('#notes').value }, { 'Idempotency-Key': key });
        sessionStorage.removeItem(keyName); S.cartCount = 0;
        history.replaceState(null, '', '/b2b/orders/' + r.order.id + '?placed=1' + (method === 'gateway' ? '&pay=1' : '')); route(); window.scrollTo(0, 0);
      } catch (e) {
        var d = e.data || {}, extra = '';
        if (d.code === 'INSUFFICIENT_STOCK' && d.shortages) extra = '<br/>' + d.shortages.map(function (s) { return esc(s.sku) + ': ' + s.available + ' available, ' + s.requested + ' requested'; }).join('<br/>');
        if (d.code === 'CART_INVALID' && d.items) extra = '<br/>' + d.items.map(function (s) { return esc(s.sku) + ': ' + esc(s.error); }).join('<br/>');
        $('#placeMsg').innerHTML = '<div class="alert err">' + esc(e.message) + extra + '</div>';
        btn.disabled = false; btn.textContent = 'Place order · ' + money(cart.totals.grand_total, 0);
        if (d.code) { cart = await get('/cart'); }
      }
    }
    draw();
  };

  /* ═════════════════ Orders ═════════════════ */
  function orderList(base, title, apiPath, activeNav, tabs) {
    return async function (id) {
      if (id) return orderDetail(id, base, apiPath, activeNav);
      renderShell(activeNav, title);
      var q = new URLSearchParams(location.search), st = { status: q.get('status') || '', q: '', page: 1, sel: {} };
      var seller = base === 'retailer-orders';
      main.innerHTML = head(title, seller ? '<button class="btn sm" id="bulkPrint" disabled>' + icon('print') + 'Print labels</button>' : '') +
        '<div class="search" style="margin-bottom:12px">' + icon('search') + '<input class="in" id="oq" placeholder="Search order number' + (seller ? ', shop, phone, pincode' : '') + '"/></div>' +
        '<div class="chips" id="ochips" style="margin-bottom:14px">' + tabs.map(function (t) { return '<button class="chip' + (t[0] === st.status ? ' on' : '') + '" data-s="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div><div class="card"><div class="list" id="olist"><div class="spin"></div></div></div><div class="pager" id="opager"></div>';
      async function load(append) {
        try {
          var d = await get(apiPath + qstr({ status: st.status, q: st.q, page: st.page, limit: 20 }));
          var html = d.items.map(function (o) {
            return '<a href="/b2b/' + base + '/' + o.id + '" data-link>' + (seller ? '<input type="checkbox" data-sel="' + o.id + '" aria-label="Select" style="width:18px;height:18px"' + (st.sel[o.id] ? ' checked' : '') + '/>' : '') +
              '<div class="grow"><b>' + (seller ? esc(o.buyer_shop || o.buyer_name) : '<span class="mono">' + esc(o.order_no) + '</span>') + '</b><span>' + (seller ? '<span class="mono">' + esc(o.order_no) + '</span> · ' + esc(o.ship_city) + ' ' + esc(o.ship_pincode) + ' · ' : '') +
              esc(o.total_qty) + ' units · ' + esc(ago(o.created_at)) + '</span></div><div class="end"><b>' + money(o.grand_total, 0) + '</b>' + badge(o.status) + (o.payment_status !== 'paid' && ['cancelled', 'rejected'].indexOf(o.status) === -1 ? '<br/><span class="small muted">' + esc(label(o.payment_status === 'pending' ? 'Unpaid' : o.payment_status)) + '</span>' : '') + '</div></a>'; }).join('');
          if (append) $('#olist').insertAdjacentHTML('beforeend', html); else $('#olist').innerHTML = html || empty('list', 'No orders here', seller ? 'Orders from your retailers appear here.' : 'Orders you place appear here.', seller ? '' : '<a class="btn pri" style="margin-top:12px" href="/b2b/products" data-link>Browse products</a>');
          $('#opager').innerHTML = d.page < d.pages ? '<button class="btn" id="omore">Show more</button>' : '';
          if ($('#omore')) $('#omore').addEventListener('click', function () { st.page++; load(true); });
        } catch (e) { $('#olist').innerHTML = '<div class="alert err" style="margin:14px">' + esc(e.message) + '</div>'; }
      }
      load();
      $('#oq').addEventListener('input', debounce(function () { st.q = $('#oq').value.trim(); st.page = 1; load(); }, 320));
      $('#ochips').addEventListener('click', function (e) { var b = e.target.closest('.chip'); if (!b) return; st.status = b.dataset.s; st.page = 1; $$('#ochips .chip').forEach(function (c) { c.classList.toggle('on', c === b); }); load(); });
      if (seller) {
        $('#olist').addEventListener('click', function (e) { var c = e.target.closest('[data-sel]'); if (!c) return; e.stopPropagation(); st.sel[c.dataset.sel] = c.checked; $('#bulkPrint').disabled = !Object.keys(st.sel).some(function (k) { return st.sel[k]; }); }, true);
        $('#bulkPrint').addEventListener('click', function () { printDoc('b2b-seller', 'label', Object.keys(st.sel).filter(function (k) { return st.sel[k]; })); });
      }
    };
  }
  var BUYER_TABS = [['', 'All'], ['pending_admin_approval,submitted,approved,assigned,accepted,processing,packed', 'In progress'], ['dispatched,out_for_delivery', 'On the way'], ['delivered,partially_delivered', 'Delivered'], ['cancelled,rejected,refunded,returned', 'Cancelled']];
  var SELLER_TABS = [['', 'All'], ['assigned', 'New'], ['accepted,processing,packed', 'Processing'], ['dispatched,out_for_delivery', 'On the way'], ['delivered,partially_delivered', 'Delivered'], ['cancelled,rejected,returned', 'Cancelled']];
  ROUTES.orders = function (id) { return orderList('orders', isDist() ? 'My purchases' : 'Orders', '/orders', 'orders', BUYER_TABS)(id); };
  ROUTES['retailer-orders'] = function (id) { return orderList('retailer-orders', 'Retailer orders', '/retailer-orders', 'retailer-orders', SELLER_TABS)(id); };

  var TRACK = ['submitted', 'accepted', 'packed', 'dispatched', 'delivered'];
  function trackPos(s) { return { submitted: 0, pending_admin_approval: 0, approved: 0, assigned: 0, accepted: 1, processing: 1, packed: 2, dispatched: 3, out_for_delivery: 3, delivered: 4, partially_delivered: 4 }[s]; }
  var SELLER_ACTION = { accepted: 'Accept order', processing: 'Start processing', packed: 'Mark packed', dispatched: 'Dispatch', out_for_delivery: 'Out for delivery', delivered: 'Mark delivered', cancelled: 'Cancel order', returned: 'Could not deliver — take back' };

  async function orderDetail(id, base, apiPath, activeNav) {
    var seller = base === 'retailer-orders';
    renderShell(activeNav, 'Order'); loading();
    var d = await get(apiPath + '/' + id), o = d.order, q = new URLSearchParams(location.search);
    var pos = trackPos(o.status), interstate = Number(o.igst_total) > 0;
    var dead = ['cancelled', 'rejected', 'refunded', 'returned'].indexOf(o.status) !== -1;
    var canReturn = !seller && (o.status === 'delivered' || o.status === 'partially_delivered');
    var canPayOnline = !seller && o.seller_type === 'company' && Number(d.outstanding) > 0 && !dead;
    var html = '<a class="link small" href="/b2b/' + base + '" data-link>← ' + (seller ? 'Retailer orders' : 'Orders') + '</a>' +
      '<div class="page-h" style="margin-top:8px"><h1 class="mono" style="font-size:19px">' + esc(o.order_no) + '</h1>' + badge(o.status) + '</div>' +
      (q.get('placed') ? '<div class="alert ok"><b>Order placed.</b> ' + (o.status === 'pending_admin_approval' ? 'As this is your first order, our team will review it before it is processed.' : 'It has been sent to ' + esc(o.seller_name || 'Sake of Health') + '.') + '</div>' : '') +
      (Number(o.is_on_hold) ? '<div class="alert warn">This order is on hold.</div>' : '') +
      (o.cancel_reason && dead ? '<div class="alert err">' + esc(label(o.status)) + ': ' + esc(o.cancel_reason) + '</div>' : '') +
      (pos != null ? '<div class="card"><div class="card-b"><div class="track">' + ['Placed', 'Accepted', 'Packed', 'Dispatched', 'Delivered'].map(function (s, i) { return '<div class="' + (i <= pos ? 'done' : '') + (i === pos ? ' now' : '') + '">' + s + '</div>'; }).join('') + '</div></div></div>' : '');

    // actions
    var acts = '';
    if (seller) {
      acts = d.nextStatuses.filter(function (s) { return s !== 'approved' && s !== 'cancelled'; }).map(function (s, i) { return '<button class="btn ' + (i === 0 ? 'pri' : '') + '" data-go="' + s + '">' + esc(SELLER_ACTION[s] || label(s)) + '</button>'; }).join('') +
        (d.nextStatuses.indexOf('approved') !== -1 ? '<button class="btn danger" data-go="approved">Decline</button>' : '') + (d.nextStatuses.indexOf('cancelled') !== -1 ? '<button class="btn danger" data-go="cancelled">Cancel order</button>' : '') +
        '<button class="btn" data-print="label">' + icon('print') + 'Delivery label</button><button class="btn" data-print="bill">' + icon('doc') + (d.invoice ? 'Invoice' : 'Order summary') + '</button>' +
        (['packed', 'dispatched', 'out_for_delivery'].indexOf(o.status) !== -1 ? '<button class="btn" id="shipBtn">' + icon('truck') + (d.shipment ? 'Delivery details' : 'Add delivery details') + '</button>' : '') +
        (d.shipment && d.shipment.challanNo ? '<button class="btn" id="challanBtn">' + icon('doc') + 'Challan</button>' : '') +
        (Number(d.outstanding) > 0 && !dead ? '<button class="btn" id="recPay">' + icon('rupee') + 'Record payment</button>' : '');
    } else {
      acts = (canPayOnline ? '<button class="btn pri" id="payNow">Pay ' + money(d.outstanding, 0) + ' online</button>' : '') + '<button class="btn" id="reorder">' + icon('undo') + 'Reorder</button>' +
        '<button class="btn" data-print="bill">' + icon('doc') + (d.invoice && d.invoice.status === 'final' ? 'Invoice' : 'Order summary') + '</button>' +
        (d.shipment && d.shipment.challanNo ? '<button class="btn" id="challanBtn">' + icon('doc') + 'Delivery challan</button>' : '') +
        (canReturn ? '<button class="btn" id="retBtn">Return items</button>' : '') + (d.nextStatuses.indexOf('cancelled') !== -1 ? '<button class="btn danger" id="cancelBtn">Cancel order</button>' : '');
    }
    html += '<div class="btn-row" style="margin:14px 0">' + acts + '</div>';

    html += '<div class="card"><div class="card-h"><h2>Items</h2><span class="sp"></span><span class="muted small">' + o.total_qty + ' units</span></div><div class="list">' + d.items.map(function (i) {
      return '<div><div class="grow"><b style="white-space:normal">' + esc(i.name) + '</b><span><span class="mono">' + esc(i.sku) + '</span> · ' + i.qty + ' × ' + money(i.unit_price) + ' + ' + Number(i.gst_rate) + '% GST' +
        (i.qty_delivered != null && Number(i.qty_delivered) !== Number(i.qty) ? ' · ' + i.qty_delivered + ' delivered' : '') + (Number(i.qty_returned) ? ' · ' + i.qty_returned + ' returned' : '') + '</span></div><div class="end"><b>' + money(i.line_total) + '</b></div></div>'; }).join('') + '</div>' +
      '<div class="card-b" style="border-top:1px solid var(--line-2)"><dl class="kv"><dt>Taxable value</dt><dd>' + money(o.taxable_total) + '</dd>' +
      (interstate ? '<dt>IGST</dt><dd>' + money(o.igst_total) + '</dd>' : '<dt>CGST</dt><dd>' + money(o.cgst_total) + '</dd><dt>SGST</dt><dd>' + money(o.sgst_total) + '</dd>') +
      (Number(o.round_off) ? '<dt>Round off</dt><dd>' + money(o.round_off) + '</dd>' : '') + '<dt style="font-weight:700;color:var(--ink)">Total</dt><dd style="font-size:17px;font-weight:700">' + money(o.grand_total) + '</dd></dl></div></div>';

    html += '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin-top:14px;align-items:start">' +
      '<div class="card"><div class="card-h"><h2>' + (seller ? 'Deliver to' : 'Delivery') + '</h2></div><div class="card-b"><b>' + esc(o.ship_name) + '</b><br/>' + (seller ? esc(o.ship_contact || '') + ' · <a class="link" href="tel:+91' + esc(o.ship_phone) + '">' + esc(phone(o.ship_phone)) + '</a><br/>' : '') +
        esc([o.ship_line1, o.ship_line2, o.ship_landmark].filter(Boolean).join(', ')) + '<br/>' + esc(o.ship_city) + ', ' + esc(o.ship_state) + ' ' + esc(o.ship_pincode) +
        (seller && o.ship_lat ? '<br/><a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(o.ship_lat + ',' + o.ship_lng) + '">Get directions</a>' : '') +
        (!seller ? '<p class="muted small" style="margin-top:10px">Supplied by <b>' + esc(o.seller_name || 'Sake of Health') + '</b>' + (o.seller_mobile ? ' · <a class="link" href="tel:+91' + esc(o.seller_mobile) + '">' + esc(phone(o.seller_mobile)) + '</a>' : '') + '</p>' : '') +
        (o.buyer_notes ? '<p style="margin-top:10px"><b>Note:</b> ' + esc(o.buyer_notes) + '</p>' : '') + '</div></div>' +
      '<div class="card"><div class="card-h"><h2>Payment</h2><span class="sp"></span>' + badge(o.payment_status) + '</div><div class="card-b"><dl class="kv"><dt>Method</dt><dd>' + esc(label(o.payment_method)) + '</dd><dt>Paid</dt><dd>' + money(o.amount_paid) + '</dd>' +
        '<dt>Outstanding</dt><dd><b>' + money(d.outstanding) + '</b></dd>' + (d.invoice ? '<dt>Invoice</dt><dd class="mono">' + esc(d.invoice.invoice_no) + '</dd>' + (d.invoice.due_date && Number(d.outstanding) > 0 ? '<dt>Due</dt><dd>' + esc(date(d.invoice.due_date)) + '</dd>' : '') : '') + '</dl>' +
        (d.payments.length ? '<div style="margin-top:10px;border-top:1px solid var(--line-2);padding-top:8px">' + d.payments.map(function (p) { return '<div class="small" style="display:flex;justify-content:space-between;padding:3px 0"><span>' + esc(date(p.received_at)) + ' · ' + esc(label(p.method)) + (p.reference ? ' · ' + esc(p.reference) : '') + '</span><b>' + (p.status === 'reversed' ? '− ' : '') + money(p.amount) + '</b></div>'; }).join('') + '</div>' : '') + '</div></div></div>';

    if (d.shipment) {
      var sh = d.shipment, how = { own_vehicle: 'Our vehicle', courier: 'Courier', transporter: 'Transporter', pickup: 'Pickup' }[sh.mode] || sh.mode;
      html += '<div class="card" style="margin-top:14px"><div class="card-h"><h2>Shipment</h2><span class="sp"></span>' + badge(sh.status === 'attempt_failed' ? 'pending' : (sh.status === 'ready' ? 'packed' : sh.status)) + '</div><div class="card-b"><dl class="kv">' +
        '<dt>Shipment</dt><dd class="mono">' + esc(sh.shipmentNo) + '</dd><dt>How</dt><dd>' + esc(how) + (sh.carrier ? ' · ' + esc(sh.carrier) : '') + '</dd>' +
        (sh.vehicleNo ? '<dt>Vehicle</dt><dd class="mono">' + esc(sh.vehicleNo) + '</dd>' : '') +
        (sh.driverName ? '<dt>Driver</dt><dd>' + esc(sh.driverName) + (sh.driverPhone ? ' · <a class="link" href="tel:+91' + esc(sh.driverPhone) + '">' + esc(phone(sh.driverPhone)) + '</a>' : '') + '</dd>' : '') +
        (sh.trackingNo ? '<dt>Tracking no.</dt><dd class="mono">' + esc(sh.trackingNo) + '</dd>' : '') + (sh.lrNo ? '<dt>LR no.</dt><dd class="mono">' + esc(sh.lrNo) + '</dd>' : '') +
        (sh.ewayBillNo ? '<dt>E-way bill</dt><dd class="mono">' + esc(sh.ewayBillNo) + '</dd>' : '') + (sh.challanNo ? '<dt>Challan</dt><dd class="mono">' + esc(sh.challanNo) + '</dd>' : '') +
        (sh.expectedAt ? '<dt>Expected</dt><dd>' + esc(dateTime(sh.expectedAt)) + (sh.late ? ' <b style="color:var(--red,#b00)">(late)</b>' : '') + '</dd>' : '') +
        (sh.receivedBy ? '<dt>Received by</dt><dd>' + esc(sh.receivedBy) + '</dd>' : '') + (sh.attempts ? '<dt>Failed attempts</dt><dd>' + sh.attempts + '</dd>' : '') + '</dl>' +
        (sh.events && sh.events.length ? '<ul class="tl" style="margin-top:10px">' + sh.events.slice().reverse().map(function (e) {
          return '<li><b>' + esc(label(e.kind)) + '</b><span>' + esc(dateTime(e.at)) + (e.place ? ' · ' + esc(e.place) : '') + (e.note ? ' · ' + esc(e.note) : '') + '</span></li>'; }).join('') + '</ul>' : '') + '</div></div>';
    }
    html += '<div class="card"><div class="card-h"><h2>History</h2></div><div class="card-b"><ul class="tl">' + d.history.slice().reverse().map(function (h) {
      return '<li><b>' + esc(label(h.to_status)) + '</b><span>' + esc(dateTime(h.created_at)) + (h.note ? ' · ' + esc(h.note) : '') + '</span></li>'; }).join('') + '</ul></div></div>';
    main.innerHTML = html;

    var reload = function () { history.replaceState(null, '', '/b2b/' + base + '/' + id); route(); };
    $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { printDoc(seller ? 'b2b-seller' : 'b2b-buyer', b.dataset.print, id); }); });
    $$('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () {
        var to = b.dataset.go, send = function (payload) { return post('/retailer-orders/' + id + '/status', Object.assign({ status: to }, payload)).then(function (r) { toast(r.invoiceNo && to === 'dispatched' ? 'Dispatched — invoice ' + r.invoiceNo : 'Order updated'); reload(); }); };
        if (to === 'approved') return ask('Decline this order', 'It goes back to Sake of Health to be reassigned.', { ok: 'Decline order', danger: true, label: 'Why can’t you supply it?' }, function (r) { return send({ note: r }); });
        if (to === 'cancelled') return ask('Cancel this order', 'The retailer is notified.', { ok: 'Cancel order', danger: true }, function (r) { return send({ note: r }); });
        if (to === 'returned') return ask('Could not deliver', 'Nothing was delivered: the goods come back to your stock and the retailer is told. Use “Mark delivered” if part of the order was accepted.', { ok: 'Take the goods back', danger: true, label: 'Why could it not be delivered?' }, function (r) { return send({ note: r }); });
        if (to === 'delivered') return sheet({ title: 'Confirm delivery', ok: 'Confirm delivery', body: '<p class="muted small" style="margin-bottom:12px">Change a quantity only if something could not be delivered — a credit note is raised for the difference.</p>' +
          d.items.map(function (i) { return '<div class="field"><label>' + esc(i.name) + ' <span class="muted">(ordered ' + i.qty + ')</span></label><input class="in" type="number" inputmode="numeric" min="0" max="' + i.qty + '" value="' + i.qty + '" data-del="' + i.id + '"/></div>'; }).join(''),
          onOk: function () { var del2 = {}; $$('[data-del]').forEach(function (x) { del2[x.dataset.del] = Number(x.value); }); return send({ delivered: del2 }); } });
        b.disabled = true; send({}).catch(function (e) { toast(e.message, true); b.disabled = false; });
      });
    });
    var on = function (sel, fn) { var el = $(sel); if (el) el.addEventListener('click', fn); };
    on('#challanBtn', async function () {
      var w = window.open('', '_blank');
      try { var res = await fetch('/api/b2b' + apiPath + '/' + id + '/challan', { headers: { Authorization: 'Bearer ' + session().token } }); if (!res.ok) throw new Error('Could not open the challan');
        w.location = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' })); } catch (e) { if (w) w.close(); toast(e.message, true); }
    });
    on('#shipBtn', function () {
      var sh = d.shipment || {};
      var f = function (k, lbl, attrs) { return '<div class="field"><label for="sh_' + k + '">' + lbl + '</label><input class="in" id="sh_' + k + '" ' + (attrs || '') + ' value="' + esc(sh[k] == null ? '' : sh[k]) + '"/></div>'; };
      sheet({ title: 'Delivery details for ' + o.order_no, ok: 'Save', body: '<div class="field"><label for="sh_mode">How it travels</label><select class="sel" id="sh_mode">' +
        [['own_vehicle', 'Our vehicle'], ['courier', 'Courier'], ['transporter', 'Transporter'], ['pickup', 'Retailer picks up']].map(function (m) { return '<option value="' + m[0] + '"' + (sh.mode === m[0] ? ' selected' : '') + '>' + m[1] + '</option>'; }).join('') + '</select></div>' +
        f('carrier', 'Courier / transporter') + f('vehicleNo', 'Vehicle number', 'placeholder="KA01AB1234"') + f('driverName', 'Driver name') + f('driverPhone', 'Driver phone', 'inputmode="numeric"') +
        f('trackingNo', 'Tracking number') + f('lrNo', 'LR number') + f('ewayBillNo', 'E-way bill (12 digits)', 'inputmode="numeric"') +
        '<div class="field"><label for="sh_exp">Expected delivery</label><input class="in" type="datetime-local" id="sh_exp" value="' + (sh.expectedAt ? new Date(sh.expectedAt).toISOString().slice(0, 16) : '') + '"/></div>',
        onOk: function () {
          var v2 = function (k) { return $('#sh_' + k).value.trim(); };
          return post('/retailer-orders/' + id + '/shipment', { mode: $('#sh_mode').value, carrier: v2('carrier'), vehicleNo: v2('vehicleNo'), driverName: v2('driverName'), driverPhone: v2('driverPhone'),
            trackingNo: v2('trackingNo'), lrNo: v2('lrNo'), ewayBillNo: v2('ewayBillNo'), expectedAt: $('#sh_exp').value ? new Date($('#sh_exp').value).toISOString() : null }).then(function () { toast('Delivery details saved'); reload(); });
        } });
    });
    on('#recPay', function () {
      sheet({ title: 'Record payment received', ok: 'Record payment', body: '<div class="field"><label>Method</label><select class="sel" id="pm"><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="cheque">Cheque</option></select></div>' +
        '<div class="field"><label>Amount (₹)</label><input class="in" id="pa" inputmode="decimal" value="' + esc(d.outstanding) + '"/><div class="hint">Outstanding: ' + money(d.outstanding) + '</div></div><div class="field"><label>Reference (UTR / cheque no.)</label><input class="in" id="pr"/></div>',
        onOk: function () { return post('/retailer-orders/' + id + '/payments', { method: $('#pm').value, amount: $('#pa').value, reference: $('#pr').value }).then(function () { toast('Payment recorded'); reload(); }); } });
    });
    on('#reorder', async function () {
      try { var r = await post('/orders/' + id + '/reorder'); S.cartCount = r.cart.items.length;
        if (r.notes.length) sheet({ title: 'Cart ready — a few changes', body: '<p style="margin-bottom:10px">' + r.added + ' product(s) added at today’s prices.</p>' + r.notes.map(function (n) { return '<div class="alert warn" style="margin-bottom:8px"><b>' + esc(n.name) + '</b><br/>' + esc(n.message) + '</div>'; }).join('') + '<a class="btn pri block" href="/b2b/cart" data-link>Go to cart</a>' });
        else { toast('Added to cart at today’s prices'); go('cart'); }
      } catch (e) { toast(e.message, true); }
    });
    on('#cancelBtn', function () { ask('Cancel order ' + o.order_no, 'Reserved stock and credit are released.', { ok: 'Cancel order', danger: true, label: 'Reason (optional)' }, function (r) { return post('/orders/' + id + '/cancel', { reason: r }).then(function () { toast('Order cancelled'); reload(); }); }); });
    on('#retBtn', function () {
      sheet({ title: 'Return items', ok: 'Request return', body: d.items.map(function (i) { var max = (i.qty_delivered == null ? i.qty : i.qty_delivered) - i.qty_returned;
        return '<div class="field"><label>' + esc(i.name) + ' <span class="muted">(up to ' + max + ')</span></label><input class="in" type="number" inputmode="numeric" min="0" max="' + max + '" value="0" data-ret="' + i.id + '"/></div>'; }).join('') +
        '<div class="field"><label>What is wrong?</label><textarea class="ta" id="retReason" maxlength="500" placeholder="e.g. 6 jars arrived with broken seals"></textarea></div>',
        onOk: function () { var items = $$('[data-ret]').map(function (x) { return { order_item_id: Number(x.dataset.ret), qty: Number(x.value) }; }).filter(function (x) { return x.qty > 0; });
          return post('/orders/' + id + '/returns', { items: items, reason: $('#retReason').value }).then(function (r) { toast('Return ' + r.return_no + ' requested'); go('returns'); }); } });
    });
    on('#payNow', function () { payOnline(id, reload); });
    if (q.get('pay') && canPayOnline) payOnline(id, reload);
  }

  async function payOnline(orderId, done) {
    try {
      var init = await post('/orders/' + orderId + '/pay/initiate');
      var confirmPay = function (paymentId, signature) { return post('/orders/' + orderId + '/pay/confirm', { gateway: init.gateway, gatewayOrderId: init.gatewayOrderId, paymentId: paymentId, signature: signature }).then(function () { toast('Payment received — thank you'); done(); }); };
      if (init.mock) return sheet({ title: 'Test payment', ok: 'Simulate successful payment', body: '<div class="alert info">Payments are in <b>test mode</b> on this site, so no money moves. Continue to simulate paying ' + money(init.amount, 0) + ' for ' + esc(init.orderNo) + '.</div>',
        onOk: function () { return confirmPay('mock_pay_' + Date.now(), 'mock'); } });
      if (!window.Razorpay) await new Promise(function (res, rej) { var s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js'; s.onload = res; s.onerror = function () { rej(new Error('Could not load the payment page. Check your connection.')); }; document.head.appendChild(s); });
      new window.Razorpay({ key: init.key, amount: init.amount * 100, currency: 'INR', order_id: init.gatewayOrderId, name: 'Sake of Health', description: 'Order ' + init.orderNo,
        prefill: { name: S.me.account.contact_person, email: S.me.account.email, contact: S.me.account.mobile }, theme: { color: '#296721' },
        handler: function (r) { confirmPay(r.razorpay_payment_id, r.razorpay_signature).catch(function (e) { toast(e.message + ' If money was debited it will be matched automatically.', true); done(); }); } }).open();
    } catch (e) { toast(e.message, true); }
  }

  /* ═════════════════ Invoices · payments · returns ═════════════════ */
  ROUTES.invoices = async function () {
    renderShell('invoices', 'Invoices'); loading();
    var d = await get('/invoices?limit=50');
    main.innerHTML = head('Invoices') + '<div class="card"><div class="list">' + (d.items.length ? d.items.map(function (i) {
      return '<div><div class="grow"><b class="mono">' + esc(i.invoice_no) + '</b><span>' + esc(date(i.invoice_date)) + ' · order ' + esc(i.order_no) + ' · ' + esc(i.seller_name) + (i.status === 'cancelled' ? ' · cancelled' : '') + '</span></div>' +
        '<div class="end"><b>' + money(i.grand_total, 0) + '</b>' + (i.status === 'cancelled' ? badge('cancelled') : badge(i.payment_status)) + '</div><button class="btn sm" data-inv="' + i.order_id + '" aria-label="Print invoice">' + icon('print') + '</button></div>'; }).join('')
      : empty('doc', 'No invoices yet', 'A GST invoice is issued when your order is dispatched.')) + '</div></div>';
    $$('[data-inv]').forEach(function (b) { b.addEventListener('click', function () { printDoc('b2b-buyer', 'bill', b.dataset.inv); }); });
  };

  ROUTES.payments = async function () {
    renderShell('payments', 'Payments & credit'); loading();
    var c = await get('/credit'), p = await get('/payments?limit=30');
    main.innerHTML = head('Payments & credit') + '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">' + creditCard(c.credit, 'Credit') +
      '<div class="stat"><small>Outstanding</small><b>' + money(c.outstanding.amount, 0) + '</b><span>across ' + c.outstanding.orders + ' unpaid order' + (c.outstanding.orders === 1 ? '' : 's') + '</span><div style="margin-top:10px"><a class="btn sm" href="/b2b/orders" data-link>View orders</a></div></div></div>' +
      '<div class="card"><div class="card-h"><h2>Payment history</h2></div><div class="list">' + (p.items.length ? p.items.map(function (x) {
        return '<a href="/b2b/orders/' + x.order_id + '" data-link><div class="grow"><b>' + esc(label(x.method)) + (x.status === 'reversed' ? ' (refund)' : '') + '</b><span>' + esc(dateTime(x.received_at)) + ' · <span class="mono">' + esc(x.order_no) + '</span>' + (x.reference ? ' · ' + esc(x.reference) : '') + '</span></div><div class="end"><b>' + (x.status === 'reversed' ? '− ' : '') + money(x.amount) + '</b></div></a>'; }).join('')
        : empty('rupee', 'No payments yet', 'Payments against your orders appear here.')) + '</div></div>' +
      (c.history.length ? '<div class="card"><div class="card-h"><h2>Credit activity</h2></div><div class="list">' + c.history.map(function (h) {
        return '<div><div class="grow"><b>' + esc(h.txn_type === 'debit' ? 'Order on credit' : h.txn_type === 'credit' ? 'Credit freed' : 'Limit changed') + '</b><span>' + esc(dateTime(h.created_at)) + (h.order_no ? ' · ' + esc(h.order_no) : '') + (h.due_date ? ' · due ' + esc(date(h.due_date)) : '') + '</span></div>' +
          '<div class="end"><b>' + (h.txn_type === 'credit' ? '− ' : h.txn_type === 'debit' ? '+ ' : '') + money(h.amount) + '</b><span class="small muted">used ' + money(h.balance_after, 0) + '</span></div></div>'; }).join('') + '</div></div>' : '');
  };

  ROUTES.returns = async function () {
    renderShell('returns', 'Returns');
    var seller = isDist() && new URLSearchParams(location.search).get('view') !== 'mine';
    var path = seller ? '/retailer-returns' : '/returns';
    loading();
    var d = await get(path + '?limit=50');
    main.innerHTML = head('Returns') + (isDist() ? '<div class="chips" style="margin-bottom:14px"><a class="chip' + (seller ? ' on' : '') + '" href="/b2b/returns" data-link>From my retailers</a><a class="chip' + (seller ? '' : ' on') + '" href="/b2b/returns?view=mine" data-link>My returns</a></div>' : '') +
      '<div class="card"><div class="list">' + (d.items.length ? d.items.map(function (r) {
        return '<button style="width:100%;border:0;background:none;text-align:left;cursor:pointer;font:inherit" data-ret="' + r.id + '"><div class="grow"><b><span class="mono">' + esc(r.return_no) + '</span>' + (seller ? ' · ' + esc(r.buyer_shop || r.buyer_name) : '') + '</b><span>Order ' + esc(r.order_no) + ' · ' + r.total_qty + ' units · ' + esc(r.reason) + '</span></div><div class="end">' + badge(r.status) + '</div></button>'; }).join('')
        : empty('undo', 'No returns', seller ? 'Return requests from your retailers appear here.' : 'To return something, open a delivered order and choose “Return items”.')) + '</div></div>';
    $$('[data-ret]').forEach(function (b) { b.addEventListener('click', function () { returnSheet(b.dataset.ret, seller, path); }); });
  };
  async function returnSheet(id, seller, path) {
    var d = await get(path + '/' + id), r = d.ret, inspecting = seller && (r.status === 'approved' || r.status === 'pickup_scheduled');
    var act = function (a, body) { return post('/retailer-returns/' + id + '/' + a, body).then(function () { toast('Return updated'); closeSheet(); route(); }); };
    sheet({ title: r.return_no, body: '<div style="margin-bottom:10px">' + badge(r.status) + ' <span class="muted small">Order ' + esc(r.order_no) + (seller ? ' · ' + esc(r.buyer_shop || r.buyer_name) : '') + '</span></div><p style="margin-bottom:12px"><b>Reason:</b> ' + esc(r.reason) + '</p>' +
      (r.inspection_note ? '<p class="muted small" style="margin-bottom:12px">' + esc(r.inspection_note) + '</p>' : '') +
      (r.credit_note_no ? '<div class="alert ok">Credit note <b class="mono">' + esc(r.credit_note_no) + '</b> for ' + money(r.credit_note_total) + (Number(r.refund_amount) ? ' · refund due ' + money(r.refund_amount) : '') + '</div>' : '') +
      d.items.map(function (i) { return '<div class="field"><label>' + esc(i.name) + ' <span class="muted">· requested ' + i.qty + (i.qty_accepted != null ? ' · accepted ' + i.qty_accepted + (i.item_condition ? ' (' + esc(i.item_condition) + ')' : '') : '') + '</span></label>' +
        (inspecting ? '<div class="frow"><input class="in" type="number" min="0" max="' + i.qty + '" value="' + i.qty + '" data-acc="' + i.id + '" aria-label="Accepted quantity"/><select class="sel" data-cond="' + i.id + '"><option value="good">Good — back to stock</option><option value="damaged">Damaged</option><option value="expired">Expired</option></select></div>' : '') + '</div>'; }).join('') +
      '<div class="btn-row">' + (seller && r.status === 'requested' ? '<button class="btn pri" data-a="approve">Approve</button><button class="btn danger" data-a="reject">Reject</button>' : '') +
        (seller && r.status === 'approved' ? '<button class="btn" data-a="schedule_pickup">Pickup scheduled</button>' : '') + (inspecting ? '<button class="btn pri" data-a="inspect">Goods received</button>' : '') +
        (seller && r.status === 'received' ? '<select class="sel" id="resol" style="width:auto"><option value="credit_note">Credit note</option><option value="refund">Refund</option><option value="replacement">Replacement</option></select><button class="btn pri" data-a="complete">Complete</button>' : '') +
        (!seller && r.status === 'requested' ? '<button class="btn danger" data-a="cancel">Cancel request</button>' : '') + '</div>',
      after: function (el) { $$('[data-a]', el).forEach(function (b) { b.addEventListener('click', function () {
        var a = b.dataset.a, body = {};
        if (a === 'cancel') return post('/returns/' + id + '/cancel').then(function () { toast('Return cancelled'); closeSheet(); route(); }).catch(function (e) { toast(e.message, true); });
        if (a === 'reject') { body.note = prompt('Reason for rejecting this return:') || ''; if (!body.note) return; }
        if (a === 'inspect') body.items = $$('[data-acc]', el).map(function (x) { return { return_item_id: Number(x.dataset.acc), qty_accepted: Number(x.value), condition: $('[data-cond="' + x.dataset.acc + '"]', el).value }; });
        if (a === 'complete') body.resolution = $('#resol').value;
        b.disabled = true; act(a, body).catch(function (e) { toast(e.message, true); b.disabled = false; });
      }); }); } });
  }

  /* ═════════════════ Retailer: my distributor ═════════════════ */
  ROUTES.distributor = async function () {
    renderShell('distributor', 'My distributor'); loading();
    var d = await get('/my-distributor'), x = d.distributor;
    main.innerHTML = head('My distributor') + (x ? '<div class="card"><div class="card-b"><h2 style="font-size:19px;margin-bottom:12px">' + esc(x.name) + '</h2><dl class="kv left"><dt>Contact person</dt><dd>' + esc(x.contact_person) + '</dd>' +
      '<dt>Phone</dt><dd><a class="link" href="tel:+91' + esc(x.phone) + '">' + esc(phone(x.phone)) + '</a></dd><dt>Email</dt><dd>' + esc(x.email) + '</dd><dt>Address</dt><dd>' + esc(x.address) + '</dd>' +
      '<dt>Service area</dt><dd>' + esc(x.service_area.join(', ')) + '</dd><dt>Your distributor since</dt><dd>' + esc(date(x.since)) + '</dd></dl>' +
      '<div class="btn-row" style="margin-top:16px"><a class="btn pri" href="tel:+91' + esc(x.phone) + '">Call</a><a class="btn" target="_blank" rel="noopener" href="https://wa.me/91' + esc(x.phone) + '">WhatsApp</a></div></div></div>' +
      '<div style="margin-top:14px">' + creditCard(d.credit, 'Your credit with ' + x.name) + '</div><p class="muted small" style="margin-top:12px">Your orders are delivered and invoiced by your distributor. Payments are made to them directly.</p>'
      : '<div class="card">' + empty('truck', 'No distributor assigned yet', d.message) + '</div>');
  };

  /* ═════════════════ Distributor: retailers, receivables, stock ═════════════════ */
  ROUTES.retailers = async function () {
    renderShell('retailers', 'My retailers');
    main.innerHTML = head('My retailers') + '<div class="search" style="margin-bottom:12px">' + icon('search') + '<input class="in" id="rq" placeholder="Search shop, phone or pincode"/></div><div class="card"><div class="list" id="rlist"><div class="spin"></div></div></div>';
    async function load() {
      try {
        var d = await get('/retailers' + qstr({ q: $('#rq').value.trim(), limit: 50 }));
        $('#rlist').innerHTML = d.items.length ? d.items.map(function (r) {
          return '<button style="width:100%;border:0;background:none;text-align:left;cursor:pointer;font:inherit" data-r="' + r.id + '"><div class="grow"><b>' + esc(r.shop || r.retailer) + '</b><span>' + esc(r.retailer) + ' · ' + esc(phone(r.phone)) + ' · ' + esc(r.city) + ' ' + esc(r.pincode) + '</span>' +
            '<span>' + r.orders + ' orders · last ' + (r.last_order ? esc(ago(r.last_order)) : 'never') + '</span></div><div class="end"><b>' + money(r.outstanding, 0) + '</b><span class="small muted">outstanding</span></div></button>'; }).join('')
          : empty('users', 'No retailers yet', 'Retailers in your service area are mapped to you when they are approved.');
        $$('[data-r]').forEach(function (b) { b.addEventListener('click', function () { retailerSheet(d.items.filter(function (r) { return String(r.id) === b.dataset.r; })[0], load); }); });
      } catch (e) { $('#rlist').innerHTML = '<div class="alert err" style="margin:14px">' + esc(e.message) + '</div>'; }
    }
    $('#rq').addEventListener('input', debounce(load, 320)); load();
  };
  async function retailerSheet(r, reload) {
    var d = await get('/retailers/' + r.id), c = d.credit;
    sheet({ title: r.shop || r.retailer, ok: 'Save credit terms', body: '<dl class="kv left" style="margin-bottom:14px"><dt>Retailer</dt><dd>' + esc(r.retailer) + '</dd><dt>Contact</dt><dd>' + esc(r.contact_person) + ' · <a class="link" href="tel:+91' + esc(r.phone) + '">' + esc(phone(r.phone)) + '</a></dd>' +
      '<dt>Location</dt><dd>' + esc(d.retailer.address) + ', ' + esc(r.city) + ' ' + esc(r.pincode) + (r.latitude ? ' · <a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(r.latitude + ',' + r.longitude) + '">Map</a>' : '') + '</dd>' +
      '<dt>Orders</dt><dd>' + r.orders + '</dd><dt>Outstanding</dt><dd><b>' + money(r.outstanding) + '</b></dd><dt>Last order</dt><dd>' + (r.last_order ? esc(dateTime(r.last_order)) : '—') + '</dd></dl>' +
      '<div class="btn-row" style="margin-bottom:16px"><a class="btn sm" href="/b2b/retailer-orders?retailer_id=' + r.id + '" data-link>Their orders</a></div>' +
      '<div class="sect" style="margin-top:0">Credit you give this retailer</div><div class="frow"><div class="field"><label>Credit limit (₹)</label><input class="in" id="cl" inputmode="decimal" value="' + esc(c.credit_limit) + '"/><div class="hint">Used now: ' + money(c.credit_used) + '</div></div>' +
      '<div class="field"><label>Credit days</label><input class="in" id="cd" inputmode="numeric" value="' + esc(c.credit_days) + '"/></div></div><p class="muted small">Set the limit to 0 to stop new orders on credit. Orders above the limit are refused automatically.</p>',
      onOk: function () { return put('/retailers/' + r.id + '/credit', { credit_limit: $('#cl').value || 0, credit_days: $('#cd').value || 0 }).then(function () { toast('Credit terms saved'); reload(); }); } });
  }

  ROUTES.receivables = async function () {
    renderShell('receivables', 'Receivables'); loading();
    var d = await get('/receivables?limit=50'), p = await get('/retailer-payments?limit=20');
    main.innerHTML = head('Receivables') + '<div class="grid g2"><div class="stat hl"><small>Retailers owe you</small><b>' + money(d.amount, 0) + '</b><span>' + d.total + ' retailer' + (d.total === 1 ? '' : 's') + '</span></div></div>' +
      '<div class="card"><div class="card-h"><h2>Outstanding by retailer</h2></div><div class="list">' + (d.items.length ? d.items.map(function (r) {
        return '<a href="/b2b/retailer-orders?retailer_id=' + r.account_id + '" data-link><div class="grow"><b>' + esc(r.shop_name || r.business_name) + '</b><span>' + esc(phone(r.mobile)) + ' · ' + r.open_orders + ' unpaid order' + (Number(r.open_orders) === 1 ? '' : 's') + (r.oldest_due_date ? ' · oldest due ' + esc(date(r.oldest_due_date)) : '') + '</span></div>' +
          '<div class="end"><b>' + money(r.outstanding, 0) + '</b>' + (Number(r.overdue) ? '<span class="small" style="color:var(--red);font-weight:600">' + money(r.overdue, 0) + ' overdue</span>' : '') + '</div></a>'; }).join('') : empty('rupee', 'Nothing outstanding', 'All retailer orders are paid.')) + '</div></div>' +
      '<div class="card"><div class="card-h"><h2>Payments received</h2></div><div class="list">' + (p.items.length ? p.items.map(function (x) {
        return '<a href="/b2b/retailer-orders/' + x.order_id + '" data-link><div class="grow"><b>' + esc(x.payer_name) + '</b><span>' + esc(dateTime(x.received_at)) + ' · ' + esc(label(x.method)) + (x.reference ? ' · ' + esc(x.reference) : '') + '</span></div><div class="end"><b>' + money(x.amount) + '</b></div></a>'; }).join('')
        : empty('rupee', 'No payments recorded', 'Open a retailer order and choose “Record payment” when you receive money.')) + '</div></div>';
  };

  ROUTES.stock = async function () {
    renderShell('stock', 'My stock'); loading();
    var d = await get('/stock?limit=100');
    main.innerHTML = head('My stock', '<button class="btn pri sm" id="stockAdd">+ Stock entry</button>') +
      '<div class="alert info">Stock you receive from Sake of Health is added here automatically when the order is delivered. Use “Stock entry” for opening stock, damage or corrections.</div>' +
      '<div class="card"><div class="card-b flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Product</th><th class="num">Available</th><th class="num">Reserved</th><th class="num">Damaged</th></tr></thead><tbody>' +
      (d.items.length ? d.items.map(function (s) { return '<tr><td><b>' + esc(s.name) + '</b><br/><span class="mono muted small">' + esc(s.sku) + '</span></td><td class="num strong">' + s.qty_available + '</td><td class="num">' + (s.qty_reserved + s.qty_allocated) + '</td><td class="num">' + (s.qty_damaged + s.qty_expired) + '</td></tr>'; }).join('')
        : '<tr><td colspan="4">' + empty('box', 'No stock recorded', 'Place an order with Sake of Health, or add your opening stock.') + '</td></tr>') + '</tbody></table></div></div></div>';
    $('#stockAdd').addEventListener('click', function () {
      sheet({ title: 'Stock entry', ok: 'Save', body: '<div class="field"><label>What happened</label><select class="sel" id="so"><option value="opening">Opening stock (already on my shelf)</option><option value="adjust_increase">Correction — add</option><option value="adjust_decrease">Correction — remove</option><option value="damage">Damaged</option><option value="expiry">Expired</option></select></div>' +
        '<div class="field"><label>Product (SKU)</label><input class="in mono" id="ss" placeholder="GUM001" autocapitalize="characters"/><div class="hint" id="ssHint"></div></div><div class="field"><label>Quantity</label><input class="in" id="sq" type="number" inputmode="numeric" min="1"/></div>' +
        '<div class="field"><label>Reason</label><input class="in" id="sr" maxlength="200" placeholder="e.g. stock count on 7 Oct"/></div>',
        onOk: async function () {
          var sku = $('#ss').value.trim(), hit = (await get('/products?limit=5&q=' + encodeURIComponent(sku))).items.filter(function (p) { return p.sku.toLowerCase() === sku.toLowerCase(); })[0];
          if (!hit) throw new Error('SKU not found');
          await post('/stock/entry', { operation: $('#so').value, product_id: hit.id, qty: $('#sq').value, reason: $('#sr').value || $('#so').value });
          toast('Stock updated'); route();
        } });
    });
  };

  /* ═════════════════ Notifications · profile ═════════════════ */
  ROUTES.notifications = async function () {
    renderShell('', 'Notifications'); loading();
    var d = await get('/notifications?limit=40');
    main.innerHTML = head('Notifications') + '<div class="card"><div class="list">' + (d.items.length ? d.items.map(function (n) {
      var inner = '<div class="grow"><b style="white-space:normal">' + (Number(n.is_read) ? '' : '● ') + esc(n.title) + '</b><span style="white-space:normal">' + esc(n.body || '') + '</span><span>' + esc(ago(n.created_at)) + '</span></div>';
      return n.link && /^\/b2b\//.test(n.link) ? '<a href="' + esc(n.link) + '" data-link>' + inner + '</a>' : '<div>' + inner + '</div>'; }).join('') : empty('bell', 'No notifications', 'Order updates appear here, and are also sent by email and WhatsApp.')) + '</div></div>';
    if (S.me.unreadNotifications) { post('/notifications/read').then(function () { S.me.unreadNotifications = 0; }); }
  };

  ROUTES.profile = async function () {
    renderShell('profile', 'Profile'); loading();
    var a = S.me.account, docs = await get('/me/documents');
    var comm = await get('/me/communication').catch(function () { return { available: false }; });
    var commCard = comm.available ? '<div class="card"><div class="card-h"><h2>Offers and promotions</h2></div><div class="card-b">' +
        '<p class="muted small" style="margin:0 0 10px">Choose whether we may send you offers and new-product news. Messages about your orders, payments and account always reach you.</p>' +
        [['email', 'By email', a.email], ['whatsapp', 'On WhatsApp', phone(a.mobile)]].map(function (c) {
          var x = comm.channels[c[0]];
          return '<label style="display:flex;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--line-2)"><input type="checkbox" data-offer="' + c[0] + '" style="width:20px;height:20px"' +
            (x.offers ? ' checked' : '') + (x.hasAddress ? '' : ' disabled') + '/><span class="grow"><b>' + c[1] + '</b><br><span class="muted small">' + esc(c[2] || 'No address on file') +
            (x.stoppedAll ? ' · you asked us to stop all messages on this channel (reply START on WhatsApp to resume)' : '') + '</span></span></label>';
        }).join('') + '</div></div>' : '';
    var more = approved() ? '<div class="card"><div class="list">' + [['invoices', 'Invoices', 'doc'], ['payments', 'Payments & credit', 'rupee'], ['returns', 'Returns', 'undo'], ['quick-order', 'Quick order', 'bolt'], ['notifications', 'Notifications', 'bell']]
      .concat(isDist() ? [['retailers', 'My retailers', 'users'], ['receivables', 'Receivables', 'rupee'], ['stock', 'My stock', 'box']] : [['distributor', 'My distributor', 'truck']])
      .map(function (l) { return '<a href="/b2b/' + l[0] + '" data-link>' + icon(l[2]).replace('<svg', '<svg style="width:20px;height:20px;color:var(--green)"') + '<div class="grow"><b>' + l[1] + '</b></div><span class="muted">›</span></a>'; }).join('') + '</div></div>' : '';
    main.innerHTML = head('Profile') + more +
      '<div class="card"><div class="card-h"><h2>Business details</h2><span class="sp"></span>' + badge(a.status) + '</div><div class="card-b"><dl class="kv left"><dt>Business</dt><dd>' + esc(a.business_name) + '</dd>' + (a.shop_name ? '<dt>Shop</dt><dd>' + esc(a.shop_name) + '</dd>' : '') +
        '<dt>Type</dt><dd style="text-transform:capitalize">' + esc(a.account_type) + '</dd><dt>GSTIN</dt><dd class="mono">' + esc(a.gstin || '—') + '</dd><dt>PAN</dt><dd class="mono">' + esc(a.pan || '—') + '</dd>' +
        '<dt>Mobile</dt><dd>' + esc(phone(a.mobile)) + '</dd><dt>Email</dt><dd>' + esc(a.email) + '</dd><dt>Address</dt><dd>' + esc([a.address_line1, a.city, a.district_name, a.state_name, a.pincode].filter(Boolean).join(', ')) + '</dd></dl>' +
        '<p class="muted small" style="margin-top:10px">To change your business name, GSTIN, mobile or address, contact us — these are verified details.</p></div></div>' +
      '<div class="card"><div class="card-h"><h2>Contact & delivery details</h2></div><div class="card-b"><div class="frow"><div class="field"><label>Contact person</label><input class="in" id="pf_contact" value="' + esc(a.contact_person) + '"/></div>' +
        '<div class="field"><label>Landmark</label><input class="in" id="pf_landmark" value="' + esc(a.landmark || '') + '"/></div></div><div class="field"><label>Address line 2</label><input class="in" id="pf_line2" value="' + esc(a.address_line2 || '') + '"/></div>' +
        '<div class="btn-row"><button class="btn pri" id="pfSave">Save</button><button class="btn" id="pfLoc">' + (a.latitude ? 'Update shop location' : 'Share shop location') + '</button></div><p class="muted small" style="margin-top:8px">' + (a.latitude ? 'Location on file: ' + esc(a.latitude) + ', ' + esc(a.longitude) : 'No map location yet — sharing it helps the delivery person find you.') + '</p></div></div>' +
      commCard +
      '<div class="card"><div class="card-h"><h2>Documents</h2></div><div class="list">' + (docs.documents.length ? docs.documents.map(function (d) { return '<div><div class="grow"><b>' + esc(docs.labels[d.doc_type] || d.doc_type) + '</b><span>' + esc(d.original_name) + '</span></div><button class="btn sm" data-doc="' + d.id + '">View</button></div>'; }).join('') : '<div class="muted">No documents.</div>') + '</div>' +
        '<div class="card-b" style="border-top:1px solid var(--line-2)"><div class="frow"><div class="field"><label>Add a document</label><select class="sel" id="docType">' + Object.keys(docs.labels).filter(function (k) { return k !== 'other'; }).map(function (k) { return '<option value="' + k + '">' + esc(docs.labels[k]) + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>File (PDF / JPG / PNG)</label><div class="file"><input type="file" id="docFile" accept=".pdf,.jpg,.jpeg,.png,.webp"/></div></div></div><button class="btn" id="docUp">Upload</button></div></div>' +
      '<div class="card"><div class="card-h"><h2>Password</h2></div><div class="card-b"><div class="frow"><div class="field"><label>Current password</label><input class="in" id="pw0" type="password" autocomplete="current-password"/></div>' +
        '<div class="field"><label>New password</label><input class="in" id="pw1" type="password" autocomplete="new-password"/><div class="hint">At least 8 characters, with a letter and a number</div></div></div><button class="btn" id="pwSave">Change password</button></div></div>' +
      '<button class="btn danger block" id="lo" style="margin-top:14px">Log out</button>';
    $('#lo').addEventListener('click', function () { logout(); });
    $$('[data-offer]').forEach(function (box) { box.addEventListener('change', function () {
      var body = {}; body[box.dataset.offer] = box.checked; box.disabled = true;
      api('/me/communication', { method: 'PUT', body: body }).then(function () { toast(box.checked ? 'Offers turned on' : 'Offers turned off'); })
        .catch(function (e) { box.checked = !box.checked; toast(e.message, true); }).then(function () { box.disabled = false; });
    }); });
    var saveProfile = function (body, msg) { return api('/me/profile', { method: 'PATCH', body: body }).then(loadMe).then(function () { toast(msg); route(); }).catch(function (e) { toast(e.message, true); }); };
    $('#pfSave').addEventListener('click', function () { saveProfile({ contact_person: $('#pf_contact').value, landmark: $('#pf_landmark').value, address_line2: $('#pf_line2').value }, 'Saved'); });
    $('#pfLoc').addEventListener('click', function () {
      if (!navigator.geolocation) return toast('Your browser cannot share location', true);
      navigator.geolocation.getCurrentPosition(function (p) { saveProfile({ latitude: p.coords.latitude, longitude: p.coords.longitude }, 'Location saved'); }, function () { toast('Could not get your location', true); }, { enableHighAccuracy: true, timeout: 12000 });
    });
    $$('[data-doc]').forEach(function (b) { b.addEventListener('click', async function () {
      var w = window.open('', '_blank');
      try { var res = await fetch('/api/b2b/me/documents/' + b.dataset.doc + '/file', { headers: { Authorization: 'Bearer ' + session().token } }); if (!res.ok) throw new Error('Could not open the file'); w.location = URL.createObjectURL(await res.blob()); }
      catch (e) { if (w) w.close(); toast(e.message, true); } }); });
    $('#docUp').addEventListener('click', async function () {
      var f = $('#docFile').files[0]; if (!f) return toast('Choose a file first', true);
      var fd = new FormData(); fd.append($('#docType').value, f);
      try { await api('/me/documents', { method: 'POST', body: fd }); toast('Document uploaded'); route(); } catch (e) { toast(e.message, true); }
    });
    $('#pwSave').addEventListener('click', async function () {
      try { var r = await post('/me/password', { current_password: $('#pw0').value, new_password: $('#pw1').value }); var s = session(); s.token = r.token; localStorage.setItem(KEY, JSON.stringify(s)); toast('Password changed'); $('#pw0').value = $('#pw1').value = ''; }
      catch (e) { toast(e.message, true); }
    });
  };

  /* ─────────── boot ─────────── */
  (async function () {
    if (!session()) return logout();
    try { await loadMe(); } catch (e) { if (e.status !== 401) main.innerHTML = '<div class="alert err" style="margin:20px">' + esc(e.message) + '</div>'; return; }
    if (approved()) await refreshCart();
    route();
  })();
})();
