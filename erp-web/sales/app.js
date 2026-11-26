/* Field app (phone first). Staff sign in with their staff account and see what their role does:
   - Salesmen: today's route and numbers, every shop in their territory in full (who to ask for, what it
     owes, its credit, what it usually buys, past orders and visit notes), visits with what the shop needs
     and its feedback, orders confirmed by the retailer's one-time code, payments collected, new shops.
   - Delivery staff: their deliveries by status with the customer and the goods; start, delivered (photo,
     who received it, short items), could not deliver (why), an update on the way; what they finished.
   - Event staff: the counter of the events they are assigned to (GST invoices).
   Without a connection, sales, check-ins, orders, delivery steps and locations wait in the offline queue
   (queue.js) and are sent when it returns; the server does each one once. Text via textContent only;
   the server checks everything again. */
(function () {
  'use strict';
  var token = null; try { token = sessionStorage.getItem('sales.token'); } catch (e) { /* */ }
  var root = document.getElementById('app');
  var Q = window.SOH_QUEUE;
  var who = { ready: false, salesman: null, events: [], deliveries: null, name: '', perms: {} };
  var mode = null;        // 'sales' | 'delivery' | 'events'
  var seq = 0;            // page generation: late answers for a page that is gone are dropped
  var queueOps = [];      // what waits in the offline queue (one listener keeps it current)
  var queueViews = [];    // redraws of the queue state on the current page

  // ───────────────────────── small helpers ─────────────────────────
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') { if (attrs.on) Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); }); }
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
    store: 'M4 9l1.2-5h13.6L20 9M4 9h16v11H4zM4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M9.5 20v-5.5h5V20',
    list: 'M9 3.5h6v3H9zM7 5H5v16h14V5h-2M8.5 11h7M8.5 15h7',
    wallet: 'M3 7h15a3 3 0 0 1 3 3v8a2 2 0 0 1-2 2H3zM3 7V5.5A1.5 1.5 0 0 1 4.5 4H16v3M16.5 13.5h1.5',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    truck: 'M2 6h11v10H2zM13 9h5l3 4v3h-8M6.5 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM17.5 19.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.2l2.8 2.8L16.2 9',
    tick: 'M5 12.5l4.5 4.5L19 7.5',
    phone: 'M5 4h3.5l2 5-2.4 1.5a11 11 0 0 0 5.4 5.4L15 13.5l5 2V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
    chat: 'M4.5 19.5l1.2-3.7A8 8 0 1 1 8.3 18.4z',
    pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    plus: 'M12 5v14M5 12h14',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
    back: 'M15 5l-7 7 7 7',
    chevron: 'M9 6l6 6-6 6',
    calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
    cart: 'M3 4h2l2.4 11h11.2l2-8H6.1M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    alert: 'M12 3.5l9 16H3zM12 10v4M12 17h.01',
    note: 'M4 20h4L18.5 9.5l-4-4L4 16zM13 7l4 4',
    box: 'M3 7.5l9-4 9 4v9l-9 4-9-4zM3 7.5l9 4 9-4M12 11.5v9',
    x: 'M6 6l12 12M18 6L6 18',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
    logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h4M18 9v6a4 4 0 0 1-4 4h-4',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  };
  function icon(name, size) {
    var s = document.createElementNS(SVGNS, 'svg');
    var a = { viewBox: '0 0 24 24', width: size || 20, height: size || 20, fill: 'none', stroke: 'currentColor', 'stroke-width': name === 'more' ? '3' : '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ic' };
    Object.keys(a).forEach(function (k) { s.setAttribute(k, a[k]); });
    var p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', ICONS[name] || ''); s.appendChild(p);
    return s;
  }
  function api(method, url, body) {
    var h = { 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token;
    return fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && !/login$/.test(url)) logout();
        if (!r.ok) { var e = new Error(j.error || 'Request failed'); e.code = j.code; e.data = j; e.status = r.status; throw e; }
        return j;
      });
    });
  }
  /** Public reference lists (states, districts): no staff token is sent to another API. */
  function pub(url) { return fetch(url).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; }); }); }
  function authBlob(url) {
    return fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'Could not open it'); });
      return r.blob();
    });
  }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify({ at: new Date().toISOString(), data: v })); } catch (e) { /* a convenience copy for offline only */ } }
  function load(k) { try { var x = JSON.parse(localStorage.getItem(k) || 'null'); return x && x.data !== undefined ? x : null; } catch (e) { return null; } }
  function forgetAll() { try { Object.keys(localStorage).forEach(function (k) { if (/^soh\./.test(k) && k !== 'soh.device') localStorage.removeItem(k); }); } catch (e) { /* */ } }
  /** Online first (and keep a copy); offline, the copy last loaded on this phone. */
  function cached(key, url) {
    return api('GET', url).then(function (d) { store(key, d); return { data: d, old: false }; }).catch(function (x) {
      var c = load(key);
      if (offline(x) && c) return { data: c.data, old: true, at: c.at };
      throw x;
    });
  }
  function msg(k, t) { return el('div', { class: 'msg ' + k, role: k === 'err' ? 'alert' : 'status', text: t }); }
  function btn(t, f, k) { return el('button', { class: 'btn' + (k ? ' ' + k : ''), type: 'button', text: t, on: { click: f } }); }
  function uuid() { return Q.uuid(); }
  function money(v) { return '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function rupees(v) { return '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  function day(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''; }
  function clock(d) { return d ? new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : ''; }
  function midnight(d) { var t = d ? new Date(d) : new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime(); }
  function daysAgo(d) { return d ? Math.round((midnight() - midnight(d)) / 86400000) : null; }
  /** "today 10:30", "yesterday", "5 days ago", "12 Oct". */
  function when(d) {
    if (!d) return '—';
    var n = daysAgo(d);
    if (n === 0) return 'today ' + clock(d);
    if (n === 1) return 'yesterday ' + clock(d);
    if (n === -1) return 'tomorrow ' + clock(d);
    if (n > 1 && n < 30) return n + ' days ago';
    return day(d) + (new Date(d).getFullYear() !== new Date().getFullYear() ? ' ' + new Date(d).getFullYear() : '');
  }
  function logout() {
    token = null; forgetAll();
    try { sessionStorage.removeItem('sales.token'); } catch (e) { /* */ }
    who = { ready: false, salesman: null, events: [], deliveries: null, name: '', perms: {} };
    if (location.hash) history.replaceState(null, '', location.pathname);
    start();
  }
  function offline(e) { return Q.isNetworkError(e) || navigator.onLine === false; }
  function errText(e) { return e.message + (e.data && Array.isArray(e.data.items) ? ' — ' + e.data.items.map(function (i) { return i.error; }).join('; ') : ''); }
  /** Online first; without a connection the operation waits in the queue under the same id. */
  function sendOrQueue(kind, url, payload, label, opId, onDone, out, onQueued) {
    var queued = function () {
      return Q.add(kind, payload, label, opId).then(function () {
        out.replaceChildren(msg('warn', 'No connection: saved on this phone, it is sent automatically when the signal returns.'));
        if (onQueued) onQueued();
      });
    };
    if (navigator.onLine === false) return queued();
    return api('POST', url, payload).then(onDone).catch(function (e) {
      if (!offline(e)) { out.replaceChildren(msg('err', errText(e))); return; }
      return queued();
    });
  }
  function gps() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve({});
      navigator.geolocation.getCurrentPosition(function (p) { resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); }, function () { resolve({}); }, { timeout: 8000, maximumAge: 60000 });
    });
  }
  function digits(m) { return String(m || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''); }
  function telHref(m) { return 'tel:+91' + digits(m); }
  function waHref(m) { return 'https://wa.me/91' + digits(m); }
  function mapHref(lat, lng, address) {
    return lat != null && lng != null ? 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address || '');
  }
  function alive() { var my = seq; return function () { return my === seq; }; }
  function firstName() { return String(who.name || '').split(' ')[0] || 'there'; }
  function greeting() { var h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
  function todayLong() { return new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }); }

  // ───────────────────────── building blocks ─────────────────────────
  function card(kids, cls) { return el('section', { class: 'card' + (cls ? ' ' + cls : '') }, kids); }
  function head(t, right) { return el('div', { class: 'card-h' }, [el('h2', { text: t }), right || null]); }
  function tile(label, value, sub, tone, pct, onClick) {
    return el(onClick ? 'button' : 'div', { class: 'tile' + (tone ? ' ' + tone : '') + (onClick ? ' click' : ''), type: onClick ? 'button' : false, on: onClick ? { click: onClick } : undefined },
      [el('div', { class: 'l', text: label }), el('div', { class: 'v', text: value }), sub ? el('div', { class: 's', text: sub }) : null, pct != null ? bar(pct, tone) : null]);
  }
  function bar(pct, tone) {
    var v = Math.max(0, Math.min(100, Number(pct) || 0));
    return el('div', { class: 'bar' + (tone ? ' ' + tone : ''), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(v)) }, [el('i', { style: 'width:' + v + '%' })]);
  }
  function badge(t, tone) { return el('span', { class: 'badge' + (tone ? ' ' + tone : ''), text: t }); }
  function chips(list, cur, pick, wrap) {
    return el('div', { class: 'chips' + (wrap ? ' wrap' : ''), role: 'group' }, list.map(function (c) {
      return el('button', { type: 'button', class: 'chip' + (c[0] === cur ? ' on' : ''), 'aria-pressed': c[0] === cur ? 'true' : 'false', text: c[1], on: { click: function () { pick(c[0]); } } });
    }));
  }
  function linkAct(ic, label, href, ext) { return el('a', { class: 'act', href: href, target: ext ? '_blank' : false, rel: ext ? 'noopener' : false }, [icon(ic, 22), el('span', { text: label })]); }
  function act(ic, label, f, cls, disabled) { return el('button', { type: 'button', class: 'act' + (cls ? ' ' + cls : ''), disabled: !!disabled, on: { click: f } }, [icon(ic, 22), el('span', { text: label })]); }
  function big(ic, label, f, cls) { return el('button', { type: 'button', class: 'big' + (cls ? ' ' + cls : ''), on: { click: f } }, [ic ? icon(ic, 22) : null, el('span', { text: label })]); }
  function rowi(title, sub, right, onClick, cls, lead) {
    var kids = [lead || null, el('span', { class: 'r-m' }, [el('span', { class: 'r-t', text: title }), sub ? (typeof sub === 'string' ? el('span', { class: 'r-s', text: sub }) : sub) : null]), right ? el('span', { class: 'r-r' }, [].concat(right)) : null];
    if (onClick) { kids.push(icon('chevron', 18)); return el('button', { type: 'button', class: 'rowi' + (cls ? ' ' + cls : ''), on: { click: onClick } }, kids); }
    return el('div', { class: 'rowi' + (cls ? ' ' + cls : '') }, kids);
  }
  /** replaceChildren without the empty (null) parts. */
  function put(node, kids) { node.replaceChildren.apply(node, kids.filter(function (k) { return k != null && k !== false; })); }
  function list(rows) { return el('div', { class: 'list' }, rows); }
  function empty(t, s, action) { return el('div', { class: 'empty' }, [el('strong', { text: t }), s ? el('p', { text: s }) : null, action || null]); }
  function skeleton(n) { var k = []; for (var i = 0; i < (n || 3); i++) k.push(el('div', { class: 'sk' })); return el('div', { class: 'sks', 'aria-label': 'Loading', role: 'status' }, k); }
  function kv(pairs) {
    var kids = [];
    pairs.forEach(function (p) { if (p && p[1] != null && p[1] !== '') { kids.push(el('dt', { text: p[0] })); kids.push(el('dd', { text: String(p[1]) })); } });
    return el('dl', { class: 'kv' }, kids);
  }
  function field(label, input, hint) { return el('label', {}, [label, input, hint ? el('span', { class: 'muted small', text: hint }) : null]); }
  function setTitle(t, sub) {
    var h = document.querySelector('.top h1'); if (h) h.textContent = t;
    var s = document.querySelector('.top .sub');
    if (sub && !s && h) { s = el('div', { class: 'sub' }); h.parentNode.appendChild(s); }
    if (s) s.textContent = sub || '';
  }
  function oldNote(at) { return msg('warn', 'Offline: showing what was last loaded on this phone' + (at ? ' (' + when(at) + ')' : '') + '.'); }

  var ORDER_ST = {
    pending_otp: ['Waiting for code', 'warn'], otp_expired: ['Code expired', ''], draft: ['Draft', ''], submitted: ['Submitted', 'info'], pending_admin_approval: ['Awaiting approval', 'warn'],
    approved: ['Approved', 'info'], assigned: ['Assigned', 'info'], accepted: ['Accepted', 'info'], processing: ['Being prepared', 'info'], packed: ['Packed', 'info'],
    dispatched: ['Dispatched', 'info'], out_for_delivery: ['Out for delivery', 'info'], delivered: ['Delivered', 'good'], partially_delivered: ['Part delivered', 'warn'],
    cancelled: ['Cancelled', 'bad'], rejected: ['Rejected', 'bad'], returned: ['Returned', 'bad'], refunded: ['Refunded', ''],
  };
  var SHIP_ST = {
    ready: ['Being packed', ''], dispatched: ['Ready to go', 'info'], out_for_delivery: ['On the way', 'accent'], attempt_failed: ['Attempt failed', 'bad'],
    delivered: ['Delivered', 'good'], partially_delivered: ['Part delivered', 'warn'], returned: ['Returned', 'bad'], cancelled: ['Cancelled', ''],
  };
  var OUTCOME = { order: 'Order taken', no_order: 'No order', shop_closed: 'Shop closed', collection_only: 'Payment only', new_registration: 'New shop' };
  var PAY = { upi: 'UPI', bank_transfer: 'Bank transfer', credit: 'Credit', prepaid: 'Prepaid', gateway: 'Online', cash: 'Cash', cheque: 'Cheque' };
  var WEEKDAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  function orderBadge(s) { var x = ORDER_ST[s] || [String(s || '').replace(/_/g, ' '), '']; return badge(x[0], x[1]); }
  function shipBadge(s) { var x = SHIP_ST[s] || [String(s || '').replace(/_/g, ' '), '']; return badge(x[0], x[1]); }
  function shopStatus(s) { return s === 'approved' ? null : badge(s === 'pending' || s === 'under_review' ? 'Awaiting approval' : String(s).replace(/_/g, ' '), s === 'pending' || s === 'under_review' ? 'warn' : 'bad'); }

  // ───────────────────────── frame, tabs and routes ─────────────────────────
  var NAV = {
    sales: [['today', 'Today', 'home'], ['shops', 'Shops', 'store'], ['orders', 'Orders', 'list'], ['money', 'Money', 'wallet']],
    delivery: [['deliveries', 'To do', 'truck'], ['done', 'Done', 'check']],
    events: [['events', 'Events', 'calendar']],
  };
  var HOME = { sales: 'today', delivery: 'deliveries', events: 'events' };
  function modes() {
    var m = [];
    if (who.salesman) m.push('sales');
    if (who.deliveries) m.push('delivery');
    if (who.events.length) m.push('events');
    return m;
  }
  function path() { return (location.hash || '').replace(/^#\/?/, '').split('?')[0]; }
  function query() {
    var q = {}, s = (location.hash || '').split('?')[1] || '';
    s.split('&').forEach(function (p) { if (!p) return; var i = p.indexOf('='); q[decodeURIComponent(i < 0 ? p : p.slice(0, i))] = i < 0 ? '' : decodeURIComponent(p.slice(i + 1)); });
    return q;
  }
  function go(p) { if (location.hash === '#/' + p) render(); else location.hash = '#/' + p; }
  function statusPill() {
    var p = el('button', { class: 'pill', type: 'button', 'aria-label': 'Connection and unsent work', on: { click: function () { go('more'); } } });
    function draw() {
      var waiting = queueOps.filter(function (o) { return o.status === 'pending'; }).length, stuck = queueOps.length - waiting, off = navigator.onLine === false;
      p.className = 'pill' + (off ? ' off' : stuck ? ' bad' : waiting ? ' warn' : '');
      p.textContent = off ? 'Offline' + (waiting ? ' · ' + waiting + ' saved' : '') : stuck ? stuck + ' for the office' : waiting ? waiting + ' to send' : 'Online';
    }
    draw(); queueViews.push(draw);
    return p;
  }
  function frame(title, opts) {
    opts = opts || {};
    var main = el('main', { id: 'main', class: 'view' });
    var top = el('header', { class: 'top' }, [
      opts.back ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Back', on: { click: function () { go(opts.back); } } }, [icon('back', 22)]) : null,
      el('div', { class: 'top-t' }, [el('h1', { text: title }), opts.sub ? el('div', { class: 'sub', text: opts.sub }) : null]),
      statusPill(),
    ]);
    var ms = modes(), kids = [top];
    if (ms.length > 1 && !opts.back) {
      var L = { sales: 'Sales', delivery: 'Deliveries', events: 'Events' };
      kids.push(el('div', { class: 'modes', role: 'tablist', 'aria-label': 'Work' }, ms.map(function (m) {
        return el('button', { type: 'button', role: 'tab', 'aria-selected': m === mode ? 'true' : 'false', class: m === mode ? 'on' : '', text: L[m], on: { click: function () { mode = m; go(HOME[m]); } } });
      })));
    }
    kids.push(main);
    var cur = path().split('/')[0];
    var alias = { shop: 'shops', 'new-shop': 'shops', order: 'orders', delivery: 'deliveries', counter: 'events' };
    kids.push(el('nav', { class: 'tabs', 'aria-label': 'Sections' }, (NAV[mode] || []).concat([['more', 'More', 'more']]).map(function (it) {
      var on = (alias[cur] || cur) === it[0];
      return el('button', { type: 'button', class: 'tab', 'aria-current': on ? 'page' : false, on: { click: function () { go(it[0]); } } }, [icon(it[2], 22), el('span', { text: it[1] })]);
    })));
    root.replaceChildren(el('div', { class: 'app' }, kids));
    window.scrollTo(0, 0);
    return main;
  }
  var ROUTES = [
    [/^today$/, 'sales', viewToday], [/^shops$/, 'sales', viewShops], [/^shop\/(\d+)$/, 'sales', viewShop], [/^shop\/(\d+)\/visit$/, 'sales', viewVisit],
    [/^shop\/(\d+)\/order$/, 'sales', viewOrder], [/^shop\/(\d+)\/pay$/, 'sales', viewPay], [/^new-shop$/, 'sales', viewNewShop],
    [/^orders$/, 'sales', viewOrders], [/^order\/(\d+)$/, 'sales', viewOrderDetail], [/^money$/, 'sales', viewMoney],
    [/^deliveries$/, 'delivery', viewDeliveries], [/^delivery\/(\d+)$/, 'delivery', viewDelivery], [/^delivery\/(\d+)\/pod$/, 'delivery', viewPod],
    [/^delivery\/(\d+)\/failed$/, 'delivery', viewFailed], [/^done$/, 'delivery', viewDone],
    [/^events$/, 'events', viewEvents], [/^counter\/(\d+)$/, 'events', viewCounter], [/^more$/, null, viewMore],
  ];
  function render() {
    if (!token) { root.replaceChildren(login()); return; }
    if (!who.ready) return;
    var p = path(), ms = modes(), hit = null, m = null;
    for (var i = 0; i < ROUTES.length && !hit; i++) { m = ROUTES[i][0].exec(p); if (m) hit = ROUTES[i]; }
    if (!hit || (hit[1] && ms.indexOf(hit[1]) === -1)) { location.replace('#/' + HOME[mode && ms.indexOf(mode) !== -1 ? mode : ms[0]]); return; }
    if (hit[1]) mode = hit[1];
    else if (!mode || ms.indexOf(mode) === -1) mode = ms[0];
    try { sessionStorage.setItem('sales.mode', mode); } catch (e) { /* */ }
    seq++; queueViews = [];
    hit[2](m.slice(1), query());
  }
  window.addEventListener('hashchange', render);
  ['online', 'offline'].forEach(function (ev) { window.addEventListener(ev, function () { queueViews.forEach(function (f) { f(); }); }); });

  // ───────────────────────── sign-in, queue, location ─────────────────────────
  function keep(t) { token = t; try { sessionStorage.setItem('sales.token', t); } catch (x) { /* */ } }
  function login(error, email) {
    var e = el('input', { type: 'email', autocomplete: 'username', inputmode: 'email', value: email || '' }), p = el('input', { type: 'password', autocomplete: 'current-password' }), c = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: 'only if asked', maxlength: '9' });
    var go1 = function () {
      var mail = e.value.trim();
      api('POST', '/api/erp/core/login', { email: mail, password: p.value, totp: c.value || undefined }).then(function (r) {
        keep(r.token);
        // a new account (or a password reset by the office) starts with a temporary password: choose your own first
        if (r.mustChangePassword) { root.replaceChildren(newPassword(mail, p.value)); return; }
        start();
      }).catch(function (x) { root.replaceChildren(login(x.message, mail)); });
    };
    p.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go1(); });
    return el('div', { class: 'card login' }, [el('h1', { text: 'Field app' }), el('p', { class: 'muted', text: 'For salesmen, delivery staff and event counters. Sign in with your staff account (the one the office made for you), not a shop customer account.' }),
      error ? msg('err', error) : null, field('E-mail', e), field('Password', p), field('Authenticator or backup code', c),
      big(null, 'Sign in', go1, 'primary'), el('a', { href: '/login', class: 'small', text: 'Forgot your password? Use the main sign-in page' })]);
  }
  /** First sign-in with a temporary password: choose your own (12+ characters, letters and a number), then carry on. */
  function newPassword(email, temp, error) {
    var a = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' }), b = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password again' });
    var save = function () {
      var n = a.value;
      var problem = n.length < 12 ? 'Choose a password of at least 12 characters.' : !/[A-Za-z]/.test(n) || !/[0-9]/.test(n) ? 'Use letters and at least one number.'
        : n === temp ? 'Choose a new password, different from the temporary one.' : n !== b.value ? 'The two passwords are not the same.' : null;
      if (problem) { root.replaceChildren(newPassword(email, temp, problem)); return; }
      api('POST', '/api/erp/core/me/password', { currentPassword: temp, newPassword: n })
        .then(function () { return api('POST', '/api/erp/core/login', { email: email, password: n }); })   // the old session ends with the change
        .then(function (r) { keep(r.token); start(); })
        .catch(function (x) { if (x.code === 'mfa_required') { token = null; root.replaceChildren(login('Password changed. Sign in with it and your authenticator code.', email)); return; } root.replaceChildren(newPassword(email, temp, x.message)); });
    };
    b.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') save(); });
    return el('div', { class: 'card login' }, [el('h1', { text: 'Choose your password' }),
      el('p', { class: 'muted', text: 'You signed in with a temporary password. Choose your own to continue: at least 12 characters, with letters and a number.' }),
      error ? msg('err', error) : null, field('New password', a), field('New password again', b), big(null, 'Save and continue', save, 'primary')]);
  }

  function queuePanel() {
    var box = el('div', { class: 'queue', 'aria-live': 'polite' });
    function draw() {
      var ops = queueOps, pending = ops.filter(function (o) { return o.status === 'pending'; }), stuck = ops.filter(function (o) { return o.status !== 'pending'; });
      var kids = [el('div', { class: 'row' }, [el('strong', { text: pending.length ? pending.length + ' waiting to send' : 'Nothing waiting to send' }), navigator.onLine === false ? badge('offline', 'warn') : null,
        btn('Send now', function () { Q.sync(); }, 'sm')])];
      pending.slice(0, 8).forEach(function (o) { kids.push(el('div', { class: 'muted small', text: '• ' + o.label + ' (' + when(o.createdAt) + ')' })); });
      stuck.forEach(function (o) {
        kids.push(el('div', { class: 'msg ' + (o.status === 'conflict' ? 'warn' : 'err') }, [o.label + ': ' + (o.error || o.status) + ' — the office can see this and settle it. ',
          btn('Hide on this phone', function () { if (window.confirm('Hide this from the phone? It stays recorded in the office.')) Q.remove(o.clientOpId); }, 'sm')]));
      });
      Q.recent().slice(0, 3).forEach(function (d) { kids.push(el('div', { class: 'muted small', text: 'Sent: ' + d.label + (d.result && d.result.invoiceNo ? ' → ' + d.result.invoiceNo : '') + (d.result && d.result.orderNo ? ' → order ' + d.result.orderNo + ' (ask the retailer for the code)' : '') })); });
      box.replaceChildren.apply(box, kids);
    }
    draw(); queueViews.push(draw);
    return box;
  }

  /** Share my position (GPS, or typed in when there is none): salesmen and event staff. */
  function shareLocation(subject, eventId, out) {
    var send = function (pos, manual) {
      var p = { clientUuid: uuid(), subject: subject, eventId: eventId || undefined, purpose: subject === 'event' ? 'stall' : 'check_in', capturedAt: new Date().toISOString() };
      if (manual) { p.lat = manual.lat; p.lng = manual.lng; p.source = 'manual'; p.note = manual.note; }
      else { p.lat = pos.coords.latitude; p.lng = pos.coords.longitude; p.accuracy = pos.coords.accuracy; p.source = 'gps'; }
      sendOrQueue('location', '/api/erp/locations', p, 'Location', p.clientUuid, function () { out.replaceChildren(msg('ok', 'Location recorded.')); }, out);
    };
    var typed = function () {
      var v = window.prompt('GPS is not available. Type the position as "latitude, longitude" (from a maps app):'); if (!v) return;
      var m = v.split(',').map(function (x) { return Number(x.trim()); });
      if (m.length !== 2 || !isFinite(m[0]) || !isFinite(m[1])) { out.replaceChildren(msg('err', 'That is not a latitude, longitude pair.')); return; }
      send(null, { lat: m[0], lng: m[1], note: 'typed in' });
    };
    out.replaceChildren(msg('info', 'Finding your position…'));
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(function (pos) { send(pos); }, typed, { timeout: 10000, enableHighAccuracy: true }); else typed();
  }
  function canShareLocation() { return !!who.perms['locations.capture']; }

  // ───────────────────────── SALES: today ─────────────────────────
  function orderingOn() { return who.salesman && /enabled/.test(who.salesman.otpOrdering); }
  function orderingOffNote() {
    return msg('warn', 'Taking orders in the app is switched off until the owner approves the order-code rules. You can still visit shops, note what they need (it reaches the office) and collect payments.');
  }
  function viewToday() {
    var main = frame(greeting() + ', ' + firstName(), { sub: todayLong() });
    var ok = alive();
    if (!orderingOn()) main.appendChild(orderingOffNote());
    var numbers = el('div', {}, [skeleton(2)]), out = el('div'), route = el('div'), code = el('div'), follow = el('div'), recent = el('div');
    main.appendChild(numbers);
    main.appendChild(el('div', { class: 'acts' }, [
      act('search', 'Find a shop', function () { go('shops'); }),
      act('plus', 'New shop', function () { go('new-shop'); }),
      act('list', 'My orders', function () { go('orders'); }),
      canShareLocation() ? act('pin', 'Share location', function () { shareLocation('salesman', null, out); }) : null,
    ]));
    [out, code, route, follow, recent].forEach(function (x) { main.appendChild(x); });
    cached('soh.dash', '/api/sales/dashboard').then(function (r) { if (ok()) drawDash(r.data, r.old, r.at); })
      .catch(function (x) { if (ok()) numbers.replaceChildren(msg('err', x.message)); });
    api('GET', '/api/sales/orders?filter=code&limit=20').then(function (r) {
      if (!ok() || !r.items.length) return;
      code.replaceChildren(card([head('Waiting for the retailer\'s code', badge(String(r.items.length), 'warn')),
        el('p', { class: 'muted small', text: 'These orders go ahead only when the retailer reads out the code they received. Open one to enter it.' }),
        list(r.items.map(function (o) { return rowi(o.shop, o.orderNo + ' · ' + when(o.at), [money(o.total)], function () { go('order/' + o.id); }); }))]));
    }).catch(function () { /* the rest of the page still works */ });
    cached('soh.retailers', '/api/sales/retailers?limit=300').then(function (r) { if (ok()) drawFollow(r.data.items || []); }).catch(function () { /* */ });

    function drawDash(d, old, at) {
      var t = d.target || {}, p = d.achievementPct || {}, m = d.monthToDate || {};
      var stops = 0; d.beatsToday.forEach(function (b) { stops += b.stops.length; });
      var cashPct = d.cashLimit ? d.cashInHand * 100 / d.cashLimit : null;
      numbers.replaceChildren.apply(numbers, [old ? oldNote(at) : null,
        el('div', { class: 'tiles' }, [
          tile('Orders today', String(d.today.orders), rupees(d.today.value), null, null, function () { go('orders'); }),
          tile('Shops visited', String(d.today.visits), stops ? 'of ' + stops + ' on today\'s route' : 'today', null, stops ? d.today.visits * 100 / stops : null),
          tile('Collected today', rupees(d.today.collected), 'cash, UPI and cheques', null, null, function () { go('money'); }),
          tile('Cash in hand', rupees(d.cashInHand), d.cashLimit ? 'limit ' + rupees(d.cashLimit) : 'hand over at the office', d.overCashLimit ? 'bad' : cashPct > 80 ? 'warn' : null, cashPct, function () { go('money'); }),
          tile('Sales this month', rupees(m.sales_value), t.sales_value ? (p.sales_value || 0) + '% of ' + rupees(t.sales_value) : 'no target set', null, t.sales_value ? p.sales_value : null),
          tile('Visits this month', String(m.visits || 0), t.visits ? 'target ' + t.visits : 'no target set', null, t.visits ? p.visits : null),
        ]),
        d.overCashLimit ? msg('err', 'You are holding more cash than your limit. Hand it over at the office today.') : null].filter(Boolean));
      var beats = d.beatsToday.map(function (b) {
        var nextDone = false;
        return card([head('Today\'s route · ' + b.name, badge(b.done + ' of ' + b.stops.length + ' visited', b.done === b.stops.length && b.stops.length ? 'good' : 'info')),
          bar(b.stops.length ? b.done * 100 / b.stops.length : 0),
          list(b.stops.map(function (s, i) {
            var isNext = !s.visitedAt && !nextDone; if (isNext) nextDone = true;
            return rowi(s.shop, (s.city || '') + (s.visitedAt ? ' · visited ' + clock(s.visitedAt) : isNext ? ' · next stop' : ''), s.visitedAt ? [badge('Visited', 'good')] : null,
              function () { go('shop/' + s.accountId); }, isNext ? 'next' : '', el('span', { class: 'num' + (s.visitedAt ? ' done' : ''), text: s.visitedAt ? '✓' : String(i + 1) }));
          }))]);
      });
      route.replaceChildren.apply(route, beats.length ? beats : [card([head('Today\'s route'), empty('No route planned for today', 'Your manager plans routes (beats) in the admin panel. Meanwhile, pick shops from the follow-up list below or from Shops.')])]);
      if (d.recentOrders.length) {
        recent.replaceChildren(card([head('Recent orders', btn('All', function () { go('orders'); }, 'sm')),
          list(d.recentOrders.slice(0, 6).map(function (o) { return rowi(o.shop, o.orderNo + ' · ' + when(o.at), [money(o.value), orderBadge(o.status)], function () { go('order/' + o.id); }); }))]));
      }
    }
    function drawFollow(items) {
      var live = items.filter(function (a) { return a.status === 'approved'; });
      var owes = live.filter(function (a) { return a.due > 0; }).sort(function (x, y) { return y.due - x.due; }).slice(0, 5);
      var quiet = live.filter(function (a) { var n = daysAgo(a.last_visit_at); return n == null || n >= 14; })
        .sort(function (x, y) { return (x.last_visit_at ? Date.parse(x.last_visit_at) : 0) - (y.last_visit_at ? Date.parse(y.last_visit_at) : 0); }).slice(0, 5);
      if (!owes.length && !quiet.length) return;
      var kids = [head('Follow up')];
      if (owes.length) {
        kids.push(el('div', { class: 'muted small', text: 'Shops that owe money' }));
        kids.push(list(owes.map(function (a) { return rowi(a.shop_name || a.business_name, [a.city, a.last_visit_at ? 'visited ' + when(a.last_visit_at) : 'never visited'].filter(Boolean).join(' · '), [badge(rupees(a.due), 'warn')], function () { go('shop/' + a.id); }); })));
      }
      if (quiet.length) {
        kids.push(el('div', { class: 'muted small', text: 'Not visited for two weeks or more' }));
        kids.push(list(quiet.map(function (a) { return rowi(a.shop_name || a.business_name, [a.city, a.last_visit_at ? 'last visit ' + when(a.last_visit_at) : 'never visited'].filter(Boolean).join(' · '), null, function () { go('shop/' + a.id); }); })));
      }
      follow.replaceChildren(card(kids));
    }
  }

  // ───────────────────────── SALES: shops ─────────────────────────
  function routeShopIds() {
    var d = load('soh.dash'), ids = {};
    if (d && d.data && d.data.beatsToday) d.data.beatsToday.forEach(function (b) { b.stops.forEach(function (s) { ids[s.accountId] = b.id; }); });
    return ids;
  }
  function viewShops(p, qs) {
    var main = frame('Shops', { sub: 'Retailers in your area' });
    var ok = alive(), filter = qs.f || 'all', items = [], fromServer = false, beat = routeShopIds();
    var q = el('input', { type: 'search', placeholder: 'Shop name, mobile or PIN code', 'aria-label': 'Search shops', value: qs.q || '', autocomplete: 'off' });
    var chipBox = el('div'), count = el('div', { class: 'muted small' }), box = el('div', {}, [skeleton(4)]);
    main.appendChild(el('div', { class: 'searchbar' }, [icon('search', 18), q]));
    main.appendChild(chipBox); main.appendChild(count); main.appendChild(box);
    main.appendChild(big('plus', 'Add a new shop', function () { go('new-shop'); }, 'secondary'));
    var F = [['all', 'All'], ['route', 'Today\'s route'], ['due', 'Owes money'], ['quiet', 'Not visited 14+ days'], ['pending', 'Awaiting approval']];
    function drawChips() { chipBox.replaceChildren(chips(F, filter, function (f) { filter = f; drawChips(); draw(); })); }
    function keep(a) {
      if (filter === 'route') return beat[a.id] != null;
      if (filter === 'due') return a.due > 0;
      if (filter === 'quiet') { var n = daysAgo(a.last_visit_at); return a.status === 'approved' && (n == null || n >= 14); }
      if (filter === 'pending') return a.status !== 'approved';
      return true;
    }
    function textMatch(a, t) {
      if (!t || fromServer) return true;
      t = t.toLowerCase();
      return [a.shop_name, a.business_name, a.mobile, a.pincode, a.city].some(function (x) { return String(x || '').toLowerCase().indexOf(t) !== -1; });
    }
    function draw() {
      var t = q.value.trim(), shown = items.filter(function (a) { return keep(a) && textMatch(a, t); });
      if (filter === 'due') shown.sort(function (x, y) { return y.due - x.due; });
      count.textContent = shown.length + ' shop' + (shown.length === 1 ? '' : 's') + (t ? ' matching "' + t + '"' : '');
      if (!shown.length) { box.replaceChildren(empty(t ? 'No shop matches' : 'No shops here', t ? 'Try the mobile number or PIN code, or add the shop as new.' : filter === 'route' ? 'No route is planned for today.' : 'Nothing in this group.')); return; }
      box.replaceChildren(card([list(shown.slice(0, 200).map(function (a) {
        var sub = [a.city, a.pincode].filter(Boolean).join(' · ') + ' · ' + (a.last_order_at ? 'ordered ' + when(a.last_order_at) : 'no orders yet') + (a.last_visit_at ? ' · visited ' + when(a.last_visit_at) : '');
        return rowi(a.shop_name || a.business_name, sub, [a.due > 0 ? badge('Owes ' + rupees(a.due), 'warn') : null, shopStatus(a.status), beat[a.id] != null ? badge('Today', 'info') : null].filter(Boolean), function () { go('shop/' + a.id); });
      }))]));
    }
    function fetchList() {
      var t = q.value.trim();
      fromServer = t.length >= 2;
      var url = '/api/sales/retailers?limit=300' + (fromServer ? '&q=' + encodeURIComponent(t) : '');
      (fromServer ? api('GET', url).then(function (d) { return { data: d }; }) : cached('soh.retailers', url)).then(function (r) {
        if (!ok()) return; items = r.data.items || []; if (r.old) main.insertBefore(oldNote(r.at), main.firstChild); draw();
      }).catch(function (x) {
        if (!ok()) return;
        var c = load('soh.retailers');
        if (offline(x) && c) { fromServer = false; items = c.data.items || []; draw(); return; }
        box.replaceChildren(msg('err', x.message));
      });
    }
    var timer = null;
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(fetchList, 350); });
    drawChips(); fetchList();
  }

  function viewShop(p) {
    var id = Number(p[0]);
    var main = frame('Shop', { back: 'shops' }), ok = alive();
    main.appendChild(skeleton(4));
    cached('soh.shop.' + id, '/api/sales/retailers/' + id).then(function (r) { if (ok()) drawShop(r.data, r.old, r.at); })
      .catch(function (x) { if (ok()) main.replaceChildren(msg('err', x.status === 404 ? 'This shop is not in your area.' : x.message)); });
    function drawShop(d, old, at) {
      var s = d.shop, m = d.money, c = d.credit;
      setTitle(s.name, [s.city, s.pincode].filter(Boolean).join(' · '));
      var approved = s.status === 'approved', addr = [s.address, s.landmark, s.city, s.pincode].filter(Boolean).join(', ');
      var kids = [old ? oldNote(at) : null];
      kids.push(card([
        el('div', { class: 'card-h' }, [el('div', {}, [el('h2', { text: s.name }), s.businessName && s.businessName !== s.name ? el('div', { class: 'muted small', text: s.businessName }) : null]), shopStatus(s.status)]),
        el('div', { class: 'muted', text: [s.contact, s.mobile].filter(Boolean).join(' · ') }),
        el('div', { class: 'acts' }, [s.mobile ? linkAct('phone', 'Call', telHref(s.mobile)) : null, s.mobile ? linkAct('chat', 'WhatsApp', waHref(s.mobile), true) : null, linkAct('pin', 'Directions', mapHref(s.lat, s.lng, addr), true)]),
      ], 'hero'));
      if (!approved) kids.push(msg('warn', 'This shop is waiting for the office to approve it. Orders can be taken after approval; visits can be recorded now.'));
      kids.push(el('div', { class: 'acts' }, [
        act('cart', 'Take order', function () { go('shop/' + id + '/order'); }, 'primary', !approved),
        act('note', 'Record visit', function () { go('shop/' + id + '/visit'); }),
        act('wallet', 'Collect payment', function () { go('shop/' + id + '/pay'); }, '', !d.dueOrders.some(function (o) { return o.collectable > 0; })),
      ]));
      kids.push(el('div', { class: 'tiles' }, [
        tile('Owes', rupees(m.due), m.openOrders ? m.openOrders + ' unpaid order' + (m.openOrders === 1 ? '' : 's') : 'nothing due', m.due > 0 ? 'warn' : 'good'),
        tile('Overdue', rupees(m.overdue), m.oldestDueDate ? 'oldest due ' + day(m.oldestDueDate) : 'none', m.overdue > 0 ? 'bad' : null),
        tile('Waiting handover', rupees(m.waitingHandover), m.waitingReceipts ? m.waitingReceipts + ' receipt(s) not yet at the office' : 'none'),
        c && c.active ? tile('Credit left', rupees(c.available), 'of ' + rupees(c.limit) + (c.days ? ' · ' + c.days + ' days' : ''), c.available <= 0 ? 'bad' : null, c.limit ? c.available * 100 / c.limit : null) : tile('Credit', 'Not set', 'pays by UPI or bank'),
        tile('Last order', d.lastOrderAt ? when(d.lastOrderAt) : 'Never', d.orders.length ? d.orders.length + ' recent' : ''),
        tile('Last visit', d.lastVisitAt ? when(d.lastVisitAt) : 'Never', d.visits[0] ? 'by ' + d.visits[0].by : ''),
      ]));
      var usual = d.usual || [];
      kids.push(card([head('Usually buys', usual.length && approved ? btn('Repeat order', function () {
        var cart = {}; usual.forEach(function (u) { cart[u.productId] = u.usualQty; }); store('soh.cart.' + id, cart); go('shop/' + id + '/order');
      }, 'sm primary') : null),
      usual.length ? list(usual.map(function (u) { return rowi(u.name, 'bought ' + u.times + ' time' + (u.times === 1 ? '' : 's') + ' · last ' + when(u.lastAt), ['~' + u.usualQty + ' per order']); }))
        : empty('Nothing yet', 'No orders in the last six months. Ask what the shop sells most and note it in the visit.')]));
      kids.push(card([head('Recent orders'), d.orders.length ? list(d.orders.map(function (o) {
        return rowi(o.orderNo, when(o.at) + ' · ' + o.items + ' item' + (o.items === 1 ? '' : 's') + (o.due > 0 ? ' · due ' + money(o.due) : '') + (o.mine ? '' : o.channel === 'portal' ? ' · ordered online' : ''), [money(o.total), orderBadge(o.status)], o.mine ? function () { go('order/' + o.id); } : null);
      })) : empty('No orders yet', approved ? 'Take the first order from here.' : '')]));
      kids.push(card([head('Visit notes', btn('Add', function () { go('shop/' + id + '/visit'); }, 'sm')), d.visits.length ? list(d.visits.map(function (v) {
        return rowi((OUTCOME[v.outcome] || 'Visit') + ' · ' + when(v.at), el('span', { class: 'r-s', text: (v.note || 'No note') + ' — ' + v.by + (v.distanceM != null && v.distanceM > 300 ? ' (checked in ' + v.distanceM + ' m away)' : '') }));
      })) : empty('No visits yet', 'Record what the shop needs and what it says after each visit.')]));
      kids.push(card([head('Details'), kv([['Contact', s.contact], ['Mobile', s.mobile], ['E-mail', s.email], ['GSTIN', s.gstin], ['Address', s.address], ['Landmark', s.landmark], ['City', s.city], ['District', s.district], ['State', s.state], ['PIN code', s.pincode],
        ['On my routes', d.beats.map(function (b) { return b.name + ' (' + (WEEKDAY[b.weekday] || '') + ')'; }).join(', ')], ['Sells to us since', s.since ? day(s.since) + ' ' + new Date(s.since).getFullYear() : null],
        ['Supplied by', c ? (c.seller === 'distributor' ? (c.sellerName || 'distributor') : 'Sake of Health') : null]])]));
      main.replaceChildren.apply(main, kids.filter(Boolean));
    }
  }

  // ───────────────────────── SALES: visit ─────────────────────────
  function viewVisit(p) {
    var id = Number(p[0]), shop = load('soh.shop.' + id), name = shop ? shop.data.shop.name : 'this shop';
    var main = frame('Record visit', { back: 'shop/' + id, sub: shop ? name : '' });
    var outcome = 'no_order', key = uuid(), out = el('div');
    var oc = el('div');
    function drawOc() { oc.replaceChildren(chips([['order', 'Order taken'], ['no_order', 'No order today'], ['shop_closed', 'Shop closed'], ['collection_only', 'Payment only']], outcome, function (v) { outcome = v; drawOc(); }, true)); }
    drawOc();
    var needs = el('textarea', { rows: '3', placeholder: 'Products and quantities, by when — e.g. 20 × jaggery 1 kg before Friday', 'aria-label': 'What the shop needs' });
    var fb = el('textarea', { rows: '3', placeholder: 'Prices, quality, delivery, what other brands offer…', 'aria-label': 'Feedback from the shop' });
    var next = el('input', { type: 'date', 'aria-label': 'Next visit', min: new Date().toISOString().slice(0, 10) });
    var left = el('div', { class: 'muted small' });
    function compose() {
      return [needs.value.trim() ? 'Needs: ' + needs.value.trim() : '', fb.value.trim() ? 'Feedback: ' + fb.value.trim() : '', next.value ? 'Next visit: ' + next.value : ''].filter(Boolean).join(' · ');
    }
    function count() { var n = compose().length; left.textContent = n > 500 ? 'Too long by ' + (n - 500) + ' characters' : (500 - n) + ' characters left'; left.style.color = n > 500 ? 'var(--bad)' : ''; }
    [needs, fb, next].forEach(function (i) { i.addEventListener('input', count); }); count();
    var save = big('check', 'Save visit', function () {
      var note = compose();
      if (note.length > 500) { out.replaceChildren(msg('err', 'Please shorten the notes (500 characters in all).')); return; }
      save.disabled = true; out.replaceChildren(msg('info', 'Saving…'));
      gps().then(function (pos) {
        var beat = routeShopIds()[id];
        var payload = { retailerId: id, clientUuid: key, outcome: outcome, note: note || undefined, latitude: pos.lat, longitude: pos.lng, beatId: beat || undefined };
        sendOrQueue('visit', '/api/sales/visits', payload, 'Visit at ' + name, key, function (v) {
          out.replaceChildren(msg(v.flagged ? 'warn' : 'ok', v.duplicate ? 'This visit was already saved.' : 'Visit saved' + (v.flagged ? ' — ' + v.flagged + '.' : '. The office sees your notes.')));
          done();
        }, out, done).then(function () { if (!out.querySelector('.ok, .warn')) save.disabled = false; });
      });
    }, 'primary');
    function done() {
      save.remove();
      main.appendChild(el('div', { class: 'btns two' }, [big('back', 'Back to the shop', function () { go('shop/' + id); }), big('route', 'Today\'s route', function () { go('today'); }, 'secondary')]));
    }
    main.appendChild(card([el('h2', { text: 'How did it go?' }), oc]));
    main.appendChild(card([el('div', { class: 'form' }, [field('What does the shop need?', needs), field('Feedback or complaints', fb), field('Next visit (optional)', next), left])]));
    main.appendChild(el('p', { class: 'muted small', text: 'Your position is saved with the visit when the phone allows it, to show you were at the shop.' }));
    main.appendChild(out); main.appendChild(save);
  }

  // ───────────────────────── SALES: take an order ─────────────────────────
  function viewOrder(p) {
    var id = Number(p[0]);
    var main = frame('New order', { back: 'shop/' + id }), ok = alive();
    var shopC = load('soh.shop.' + id), shop = shopC ? shopC.data : null, name = shop ? shop.shop.name : 'the shop';
    if (shop) setTitle('New order', name);
    var cart = (load('soh.cart.' + id) || {}).data || {};
    var products = [], byId = {}, usual = {}, filter = 'all', stage = 'pick', pay = 'upi', key = uuid(), needKey = uuid();
    (shop && shop.usual || []).forEach(function (u) { usual[u.productId] = u.usualQty; });
    if (!orderingOn()) main.appendChild(msg('warn', 'Taking orders in the app is switched off until the owner approves the order-code rules. Make the list anyway and save it as what the shop needs: the office sees it with your visit and can place the order.'));
    var top = el('div'), box = el('div', {}, [skeleton(4)]), barBox = el('div'), out = el('div');
    main.appendChild(top); main.appendChild(box); main.appendChild(out); main.appendChild(barBox);
    var q = el('input', { type: 'search', placeholder: 'Search products', 'aria-label': 'Search products', autocomplete: 'off' });
    q.addEventListener('input', function () { drawList(); });
    function save() { store('soh.cart.' + id, cart); }
    function lines() { return Object.keys(cart).filter(function (k) { return cart[k] > 0 && byId[k]; }).map(function (k) { return { p: byId[k], qty: cart[k] }; }); }
    function est(l) { return Number(l.p.unitPriceExGst) * l.qty * (1 + Number(l.p.gstRate || 0) / 100); }
    function setQty(pid, n) { n = Math.max(0, Math.min(99999, Math.floor(Number(n) || 0))); if (n > 0) cart[pid] = n; else delete cart[pid]; save(); }
    function stepper(pr, after) {
      var moq = Math.max(1, Number(pr.moq) || 1), cs = Number(pr.caseQty) || 0;
      var inp = el('input', { inputmode: 'numeric', 'aria-label': 'Quantity of ' + pr.name, value: cart[pr.productId] ? String(cart[pr.productId]) : '', placeholder: '0' });
      inp.addEventListener('change', function () { setQty(pr.productId, inp.value); after(); });
      var minus = el('button', { type: 'button', 'aria-label': 'One less ' + pr.name, text: '−', on: { click: function () { var n = (cart[pr.productId] || 0) - 1; setQty(pr.productId, n < moq ? 0 : n); after(); } } });
      var plus = el('button', { type: 'button', class: 'plus', 'aria-label': 'One more ' + pr.name, text: '+', on: { click: function () { var n = cart[pr.productId] || 0; setQty(pr.productId, n ? n + 1 : moq); after(); } } });
      return el('div', { class: 'step' }, [minus, inp, plus, cs > 1 ? el('button', { type: 'button', class: 'case', 'aria-label': 'Add a case of ' + cs, text: '+' + cs, on: { click: function () { setQty(pr.productId, (cart[pr.productId] || 0) + cs); after(); } } }) : null]);
    }
    function prodCard(pr) {
      var inCart = cart[pr.productId] > 0, stock = pr.available;
      var initials = String(pr.name || '?').split(' ').slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
      var cardEl = el('div', { class: 'prod' + (inCart ? ' in' : '') + (pr.problem ? ' off' : '') });
      var redraw = function () { var n = prodCard(pr); cardEl.replaceWith(n); drawBar(); };
      cardEl.appendChild(pr.image ? el('img', { src: pr.image, alt: '', loading: 'lazy' }) : el('div', { class: 'ph', text: initials }));
      cardEl.appendChild(el('div', { class: 'p-m' }, [
        el('div', { class: 'p-t', text: pr.name }),
        el('div', { class: 'p-s', text: [pr.packSize, pr.sku].filter(Boolean).join(' · ') }),
        el('div', { class: 'p-tags' }, [
          pr.problem ? badge(pr.problem, 'bad') : stock == null ? null : stock > 0 ? badge(stock + ' in stock', stock < (Number(pr.moq) || 1) * 2 ? 'warn' : 'good') : badge('Out of stock', 'bad'),
          usual[pr.productId] ? badge('Usual ~' + usual[pr.productId], 'info') : null,
          Number(pr.moq) > 1 ? badge('Min ' + pr.moq) : null,
        ]),
      ]));
      cardEl.appendChild(el('div', { class: 'p-foot' }, [
        el('div', { class: 'p-price' }, [el('b', { text: money(pr.unitPriceExGst) }), el('span', { class: 'muted', text: ' + ' + Number(pr.gstRate || 0) + '% GST' }), el('div', { class: 'muted small', text: 'MRP ' + money(pr.mrp) })]),
        pr.problem ? null : stepper(pr, redraw),
      ]));
      return cardEl;
    }
    function drawTop() {
      if (stage === 'review') { top.replaceChildren(); return; }
      top.replaceChildren(el('div', { class: 'searchbar' }, [icon('search', 18), q]),
        chips([['all', 'All products'], ['usual', 'Usually buys'], ['stock', 'In stock'], ['cart', 'In this order']], filter, function (f) { filter = f; drawTop(); drawList(); }));
    }
    function drawList() {
      if (stage === 'review') return drawReview();
      var t = q.value.trim().toLowerCase();
      var shown = products.filter(function (pr) {
        if (t && [pr.name, pr.sku, pr.brand].join(' ').toLowerCase().indexOf(t) === -1) return false;
        if (filter === 'usual') return !!usual[pr.productId];
        if (filter === 'stock') return pr.available == null || pr.available > 0;
        if (filter === 'cart') return cart[pr.productId] > 0;
        return true;
      });
      if (filter === 'all' && !t) shown.sort(function (a, b) { return (usual[b.productId] ? 1 : 0) - (usual[a.productId] ? 1 : 0); });
      box.replaceChildren(shown.length ? el('div', { class: 'prods' }, shown.map(prodCard)) : empty('No products here', filter === 'usual' ? 'This shop has no order history yet.' : 'Try another search.'));
      drawBar();
    }
    function totals() { var ls = lines(), n = 0, units = 0, sum = 0, ex = 0; ls.forEach(function (l) { n++; units += l.qty; sum += est(l); ex += Number(l.p.unitPriceExGst) * l.qty; }); return { n: n, units: units, sum: sum, ex: ex }; }
    function drawBar() {
      var t = totals();
      main.classList.toggle('has-cart', stage !== 'review' && t.n > 0);
      if (stage === 'review' || !t.n) { barBox.replaceChildren(); return; }
      barBox.replaceChildren(el('div', { class: 'cartbar' }, [icon('cart', 22), el('div', { class: 'c-m' }, [el('div', { class: 'c-t', text: t.n + ' item' + (t.n === 1 ? '' : 's') + ' · ' + t.units + ' units' }), el('div', { class: 'c-s', text: 'about ' + money(t.sum) + ' with GST' })]),
        btn('Review', function () { stage = 'review'; drawTop(); drawList(); window.scrollTo(0, 0); })]));
    }
    function drawReview() {
      var ls = lines(), t = totals(), c = shop && shop.credit;
      barBox.replaceChildren(); main.classList.remove('has-cart');
      if (!ls.length) { stage = 'pick'; drawTop(); drawList(); return; }
      var noteIn = el('textarea', { rows: '2', placeholder: 'Delivery time, special request… (optional)', 'aria-label': 'Note on the order' });
      var payBox = el('div');
      var drawPay = function () {
        put(payBox, [chips([['upi', 'UPI'], ['bank_transfer', 'Bank transfer'], ['credit', 'Credit']], pay, function (v) { pay = v; drawPay(); }, true),
          pay === 'credit' ? el('div', { class: 'muted small', text: c && c.active ? 'Credit left: ' + money(c.available) + ' of ' + money(c.limit) + '. Over the limit, the office decides.' : 'This shop has no credit line set; the office decides.' }) : null]);
      };
      drawPay();
      var sendBtn = big('check', 'Send the code to the retailer', send, 'primary');
      var needBtn = big('note', orderingOn() ? 'Not ordering now — save as what the shop needs' : 'Save as what the shop needs', saveNeeds, orderingOn() ? '' : 'primary');
      box.replaceChildren(
        card([head('Check the order', btn('Add more', function () { stage = 'pick'; drawTop(); drawList(); }, 'sm')),
          list(ls.map(function (l) {
            var after = function () { drawReview(); };
            return el('div', { class: 'rowi wrap' }, [el('span', { class: 'r-m' }, [el('span', { class: 'r-t', text: l.p.name }), el('span', { class: 'r-s', text: money(l.p.unitPriceExGst) + ' + ' + Number(l.p.gstRate || 0) + '% GST · about ' + money(est(l)) })]), stepper(l.p, after)]);
          })),
          el('div', { class: 'totals' }, ['Before GST', el('span', { text: money(t.ex) }), 'GST', el('span', { text: money(t.sum - t.ex) }), el('span', { class: 'g', text: 'About' }), el('span', { class: 'g', text: money(t.sum) })]),
          el('p', { class: 'muted small', text: 'The system works out the final amount (schemes, minimum order). The retailer sees it in the code message.' })]),
        card([el('h2', { text: 'Payment' }), payBox, field('Note for the office', noteIn)]),
        out,
        el('div', { class: 'btns' }, [orderingOn() ? sendBtn : null, needBtn]));
      function send() {
        var items = ls.map(function (l) { return { productId: Number(l.p.productId), qty: l.qty }; });
        var body = { retailerId: id, paymentMethod: pay, clientUuid: key, items: items, notes: noteIn.value.trim() || undefined };
        sendBtn.disabled = true; out.replaceChildren(msg('info', 'Sending…'));
        sendOrQueue('field_order', '/api/sales/orders', body, 'Order for ' + name, key, function (o) {
          cart = {}; save(); go('order/' + o.orderId);
        }, out, function () {
          cart = {}; save();
          out.appendChild(msg('info', 'When it is sent, open Orders → Waiting for code and ask the retailer for the code.'));
          sendBtn.remove(); needBtn.remove();
        }).then(function () { sendBtn.disabled = false; });
      }
      function saveNeeds() {
        var text = 'Shop needs: ' + ls.map(function (l) { return l.qty + ' × ' + l.p.name; }).join(', ') + (noteIn.value.trim() ? ' · ' + noteIn.value.trim() : '');
        if (text.length > 500) text = text.slice(0, 497) + '…';
        needBtn.disabled = true;
        gps().then(function (pos) {
          var payload = { retailerId: id, clientUuid: needKey, outcome: 'no_order', note: text, latitude: pos.lat, longitude: pos.lng, beatId: routeShopIds()[id] || undefined };
          sendOrQueue('visit', '/api/sales/visits', payload, 'What ' + name + ' needs', needKey, function () {
            cart = {}; save();
            box.replaceChildren(card([el('div', { class: 'done-big' }, [el('span', { class: 'dot' }, [icon('tick', 34)]), el('h2', { text: 'Saved with your visit' }), el('p', { class: 'muted', text: 'The office sees what ' + name + ' needs and can place the order.' })]),
              big('back', 'Back to the shop', function () { go('shop/' + id); })]));
            out.replaceChildren();
          }, out, function () { cart = {}; save(); sendBtn.remove(); needBtn.remove(); }).then(function () { needBtn.disabled = false; });
        });
      }
    }
    if (!shop) api('GET', '/api/sales/retailers/' + id).then(function (d) {
      if (!ok()) return;
      store('soh.shop.' + id, d); shop = d; name = d.shop.name; setTitle('New order', name);
      (d.usual || []).forEach(function (u) { usual[u.productId] = u.usualQty; });
      if (products.length) { drawTop(); drawList(); }
    }).catch(function () { /* the order works without the shop's history */ });
    cached('soh.cat.' + id, '/api/sales/catalogue?retailerId=' + id + '&limit=200').then(function (r) {
      if (!ok()) return;
      products = r.data.items || []; byId = {}; products.forEach(function (pr) { byId[pr.productId] = pr; });
      if (r.old) main.insertBefore(msg('warn', 'Offline: prices from ' + when(r.at) + '. The order is priced again when it is sent; if stock ran out, the office settles it.'), main.firstChild);
      drawTop(); drawList();
    }).catch(function (x) {
      if (ok()) box.replaceChildren(msg('err', offline(x) ? 'Offline, and this shop\'s price list is not saved on the phone yet. Open the order once with signal.' : x.status === 404 ? 'This shop is not in your area.' : x.message));
    });
  }

  // ───────────────────────── SALES: orders ─────────────────────────
  function viewOrders(p, qs) {
    var f = qs.f || 'all';
    var main = frame('My orders'), ok = alive();
    var chipBox = el('div'), box = el('div', {}, [skeleton(4)]);
    main.appendChild(chipBox); main.appendChild(box);
    var F = [['all', 'All'], ['code', 'Waiting for code'], ['open', 'In progress'], ['due', 'Owes money'], ['delivered', 'Delivered'], ['closed', 'Cancelled / expired']];
    function drawChips(counts) {
      chipBox.replaceChildren(chips(F.map(function (c) { return [c[0], c[1] + (counts && counts[c[0]] != null && c[0] !== 'all' ? ' (' + counts[c[0]] + ')' : '')]; }), f, function (v) { go('orders' + (v === 'all' ? '' : '?f=' + v)); }));
    }
    drawChips();
    api('GET', '/api/sales/orders' + (f !== 'all' ? '?filter=' + encodeURIComponent(f) : '')).then(function (r) {
      if (!ok()) return;
      drawChips(r.counts);
      if (!r.items.length) { box.replaceChildren(empty('No orders here', f === 'code' ? 'Nothing is waiting for a retailer\'s code.' : 'Orders you take in shops appear here.')); return; }
      box.replaceChildren(card([list(r.items.map(function (o) {
        return rowi(o.shop, o.orderNo + ' · ' + when(o.at) + ' · ' + o.items + ' item' + (o.items === 1 ? '' : 's') + (o.due > 0 ? ' · due ' + money(o.due) : ''), [money(o.total), orderBadge(o.status)], function () { go('order/' + o.id); });
      }))]));
    }).catch(function (x) { if (ok()) box.replaceChildren(msg(offline(x) ? 'warn' : 'err', offline(x) ? 'Your orders need a connection. Work saved offline is under More.' : x.message)); });
  }

  function viewOrderDetail(p) {
    var id = Number(p[0]);
    var main = frame('Order', { back: 'orders' }), ok = alive();
    main.appendChild(skeleton(3));
    function load1() {
      api('GET', '/api/sales/orders/' + id).then(function (o) { if (ok()) draw(o); })
        .catch(function (x) { if (ok()) main.replaceChildren(msg('err', offline(x) ? 'This order needs a connection.' : x.message)); });
    }
    function draw(o) {
      setTitle('Order ' + o.orderNo, o.shop);
      var live = ['pending_otp', 'otp_expired', 'cancelled', 'rejected', 'draft'].indexOf(o.status) === -1;
      var kids = [];
      kids.push(card([el('div', { class: 'card-h' }, [el('div', {}, [el('h2', { text: money(o.total) }), el('div', { class: 'muted small', text: when(o.at) + ' · ' + o.items + ' item' + (o.items === 1 ? '' : 's') + ' · ' + (PAY[o.paymentMethod] || o.paymentMethod) })]), orderBadge(o.status)]),
        rowi(o.shop, o.city || '', null, function () { go('shop/' + o.shopId); }, '', icon('store', 20))]));
      if (o.status === 'pending_otp') kids.push(codeCard(o));
      if (o.status === 'otp_expired') kids.push(msg('warn', 'The retailer\'s code was not given in time, so the stock was released. Take the order again if the shop still wants it.'));
      kids.push(card([head('Items'), list(o.lines.map(function (l) { return rowi(l.name, l.qty + ' × ' + money(l.unitPrice) + ' + ' + l.gstRate + '% GST', [money(l.total)]); })),
        el('div', { class: 'totals' }, ['Before GST', el('span', { text: money(o.subtotal) }), 'GST', el('span', { text: money(o.tax) }), el('span', { class: 'g', text: 'Total' }), el('span', { class: 'g', text: money(o.total) })]
          .concat(live ? ['Paid', el('span', { text: money(o.paid) }), 'Still due', el('span', { text: money(o.due) })] : [])),
        o.notes ? el('p', { class: 'muted small', text: 'Note: ' + o.notes }) : null]));
      if (o.shipment) kids.push(card([head('Delivery', shipBadge(o.shipment.status)), kv([['Shipment', o.shipment.shipmentNo], ['Expected', o.shipment.expectedAt ? when(o.shipment.expectedAt) : null], ['Delivered', o.shipment.deliveredAt ? when(o.shipment.deliveredAt) : null], ['Received by', o.shipment.receivedBy]])]));
      if (o.payments.length) kids.push(card([head('Payments'), list(o.payments.map(function (x) { return rowi((PAY[x.method] || x.method) + ' · ' + (x.receiptNo || ''), when(x.at), [money(x.amount), badge(x.status === 'pending' ? 'At the office soon' : x.status, x.status === 'received' ? 'good' : 'warn')]); }))]));
      if (o.history.length) kids.push(card([head('History'), el('ol', { class: 'timeline' }, o.history.map(function (h) { return el('li', {}, [el('div', { class: 't', text: (ORDER_ST[h.to] || [h.to])[0] }), el('div', { class: 's', text: when(h.at) + (h.note ? ' · ' + h.note : '') })]); }))]));
      var acts = [];
      if (o.due > 0 && ['pending_otp', 'otp_expired', 'cancelled', 'rejected'].indexOf(o.status) === -1) acts.push(big('wallet', 'Collect payment', function () { go('shop/' + o.shopId + '/pay?order=' + o.id); }, 'secondary'));
      if (o.status !== 'pending_otp') acts.push(big('cart', 'Order the same again', function () { var c = {}; o.lines.forEach(function (l) { if (l.unitPrice > 0) c[l.productId] = (c[l.productId] || 0) + l.qty; }); store('soh.cart.' + o.shopId, c); go('shop/' + o.shopId + '/order'); }));
      kids.push(el('div', { class: 'btns' }, acts));
      main.replaceChildren.apply(main, kids);
    }
    function codeCard(o) {
      var out = el('div'), c = o.code;
      var sent = c && (c.sent === 'queued' || c.sent === 'sent' || c.sent === 'delivered');
      var code = el('input', { class: 'codein', inputmode: 'numeric', autocomplete: 'one-time-code', 'aria-label': 'Code from the retailer', maxlength: '8', placeholder: '••••••' });
      var confirmBtn = big('check', 'Confirm the order', function () {
        if (!/^\d{4,8}$/.test(code.value.trim())) { out.replaceChildren(msg('err', 'Type the code the retailer received (numbers only).')); return; }
        confirmBtn.disabled = true;
        api('POST', '/api/sales/orders/' + o.id + '/otp/verify', { code: code.value.trim() }).then(function (r) {
          out.replaceChildren(msg('ok', 'Order confirmed — ' + ((ORDER_ST[r.status] || [r.status])[0]).toLowerCase() + '.')); setTimeout(load1, 1200);
        }).catch(function (x) { confirmBtn.disabled = false; out.replaceChildren(msg('err', x.message + (x.data && x.data.attemptsLeft != null ? ' (' + x.data.attemptsLeft + ' tries left)' : ''))); });
      }, 'primary');
      var reason = el('textarea', { rows: '2', placeholder: 'Why can the retailer not give the code? (at least 10 characters)', 'aria-label': 'Reason for the override' });
      var overrideBox = el('div', { hidden: true }, [field('Reason', reason), btn('Send to an approver', function () {
        api('POST', '/api/sales/orders/' + o.id + '/otp-override', { reason: reason.value }).then(function () { overrideBox.replaceChildren(msg('ok', 'Sent to an approver. The order goes ahead when they approve it.')); })
          .catch(function (x) { out.replaceChildren(msg('err', x.message)); });
      }, 'primary')]);
      return card([head('Ask the retailer for the code', badge('Waiting', 'warn')),
        el('p', { class: 'muted', text: sent ? 'A code was sent to the shop\'s mobile ' + c.sentTo + '. Ask the owner to read it out.' : 'The code could not be sent (no SMS or WhatsApp sender is set up yet). Ask an approver to confirm the order instead.' }),
        o.holdUntil ? el('p', { class: 'muted small', text: 'Stock is held for this order until ' + clock(o.holdUntil) + (c && c.expiresAt ? '; the code works until ' + clock(c.expiresAt) : '') + '.' }) : null,
        sent ? code : null, sent ? confirmBtn : null, out,
        el('div', { class: 'row', style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
          sent ? btn('Send the code again', function () { api('POST', '/api/sales/orders/' + o.id + '/otp/resend', {}).then(function (r) { out.replaceChildren(msg(r.resent ? 'ok' : 'warn', r.resent ? 'Sent again.' : 'Not sent: no SMS or WhatsApp sender.')); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); }); }, 'sm') : null,
          btn('Ask an approver to confirm', function () { overrideBox.hidden = !overrideBox.hidden; }, 'sm'),
        ]), overrideBox]);
    }
    load1();
  }

  // ───────────────────────── SALES: collect a payment ─────────────────────────
  function viewPay(p, qs) {
    var id = Number(p[0]);
    var main = frame('Collect payment', { back: 'shop/' + id }), ok = alive();
    main.appendChild(skeleton(2));
    api('GET', '/api/sales/retailers/' + id).then(function (d) { if (ok()) draw(d); })
      .catch(function (x) { if (ok()) main.replaceChildren(msg(offline(x) ? 'warn' : 'err', offline(x) ? 'Recording a payment needs a connection (the receipt number comes from the office system). Note it on paper and record it when you have signal.' : x.message)); });
    function draw(d) {
      setTitle('Collect payment', d.shop.name);
      var due = d.dueOrders.filter(function (o) { return o.collectable > 0; });
      if (!due.length) { main.replaceChildren(empty('Nothing to collect', 'This shop has no unpaid orders, or what it owes is already waiting for handover at the office.', big('back', 'Back to the shop', function () { go('shop/' + id); }))); return; }
      var pick = due.find ? due.find(function (o) { return String(o.id) === String(qs.order); }) : null;
      var sel = pick || due[0], method = 'cash', key = uuid(), out = el('div');
      var amount = el('input', { inputmode: 'decimal', 'aria-label': 'Amount', value: String(sel.collectable) });
      var ref = el('input', { 'aria-label': 'UPI reference or cheque number', placeholder: 'UPI reference or cheque number', autocomplete: 'off' });
      var orderBox = el('div'), methBox = el('div'), refBox = el('div');
      var dash = load('soh.dash'), cash = dash && dash.data ? dash.data : null;
      function drawOrders() {
        orderBox.replaceChildren(list(due.map(function (o) {
          var on = o.id === sel.id;
          return rowi(o.orderNo + ' · ' + day(o.at), 'due ' + money(o.due) + (o.waiting > 0 ? ' · ' + money(o.waiting) + ' waiting at the office' : ''), [money(o.collectable)], function () { sel = o; amount.value = String(o.collectable); drawOrders(); }, on ? 'next' : '',
            el('span', { class: 'num' + (on ? ' done' : ''), text: on ? '✓' : '' }));
        })));
      }
      function drawMethod() {
        methBox.replaceChildren(chips([['cash', 'Cash'], ['upi', 'UPI'], ['cheque', 'Cheque']], method, function (v) { method = v; drawMethod(); }, true));
        put(refBox, [method === 'cash' ? (cash ? el('div', { class: 'muted small', text: 'Cash in hand now: ' + money(cash.cashInHand) + (cash.cashLimit ? ' of your ' + money(cash.cashLimit) + ' limit' : '') }) : null) : field(method === 'upi' ? 'UPI reference' : 'Cheque number', ref)]);
      }
      drawOrders(); drawMethod();
      var saveBtn = big('check', 'Record the payment', function () {
        saveBtn.disabled = true; out.replaceChildren(msg('info', 'Saving…'));
        api('POST', '/api/sales/collections', { orderId: sel.id, method: method, amount: amount.value, reference: method === 'cash' ? undefined : ref.value, clientUuid: key }).then(function (r) {
          main.replaceChildren(card([el('div', { class: 'done-big' }, [el('span', { class: 'dot' }, [icon('tick', 34)]), el('h2', { text: 'Receipt ' + r.receiptNo }),
            el('p', { class: 'muted', text: money(amount.value) + ' by ' + (PAY[method] || method) + ' for order ' + sel.orderNo + '. Hand it over at the office: it counts on the order when finance confirms it.' })]),
          big('back', 'Back to the shop', function () { go('shop/' + id); }, 'primary')]));
        }).catch(function (x) { saveBtn.disabled = false; out.replaceChildren(msg('err', offline(x) ? 'No connection: the payment was not recorded. Try again when you have signal.' : x.message)); });
      }, 'primary');
      main.replaceChildren(card([el('h2', { text: 'Which order?' }), orderBox]), card([el('h2', { text: 'How did they pay?' }), methBox, field('Amount (₹)', amount), refBox]),
        el('p', { class: 'muted small', text: 'A receipt number is made now. The money is applied to the order once finance confirms the handover.' }), out, saveBtn);
    }
  }

  // ───────────────────────── SALES: money ─────────────────────────
  function viewMoney() {
    var main = frame('Money', { sub: 'What you collected' }), ok = alive();
    main.appendChild(skeleton(3));
    api('GET', '/api/sales/collections').then(function (r) {
      if (!ok()) return;
      var w = r.waiting, cashPct = r.cashLimit ? w.cash * 100 / r.cashLimit : null;
      var waiting = r.items.filter(function (x) { return x.status === 'pending'; }), done = r.items.filter(function (x) { return x.status !== 'pending'; });
      var row = function (x) { return rowi(x.shop || 'Payment', [x.receiptNo, x.orderNo, when(x.at)].filter(Boolean).join(' · '), [money(x.amount), badge(PAY[x.method] || x.method, x.status === 'received' ? 'good' : x.status === 'pending' ? 'warn' : 'bad')], x.orderId ? function () { go('order/' + x.orderId); } : null); };
      main.replaceChildren(
        el('div', { class: 'tiles' }, [
          tile('Cash in hand', rupees(w.cash), r.cashLimit ? 'limit ' + rupees(r.cashLimit) : '', r.cashLimit && w.cash > r.cashLimit ? 'bad' : cashPct > 80 ? 'warn' : null, cashPct),
          tile('UPI to confirm', rupees(w.upi), 'finance checks the bank'), tile('Cheques to hand over', rupees(w.cheque), ''),
          tile('Confirmed (30 days)', rupees(r.confirmed30d), 'counted on the orders', 'good'),
        ]),
        msg('info', 'Hand over cash and cheques at the office. A payment counts on the order only after finance confirms it.'),
        card([head('Waiting for handover', badge(String(waiting.length), waiting.length ? 'warn' : '')), waiting.length ? list(waiting.map(row)) : empty('Nothing waiting', 'Everything you collected has been confirmed.')]),
        card([head('Confirmed'), done.length ? list(done.slice(0, 50).map(row)) : empty('Nothing yet', 'Payments appear here once finance confirms them.')]));
    }).catch(function (x) { if (ok()) main.replaceChildren(msg(offline(x) ? 'warn' : 'err', offline(x) ? 'This page needs a connection.' : x.message)); });
  }

  // ───────────────────────── SALES: a new shop ─────────────────────────
  function viewNewShop() {
    var main = frame('New shop', { back: 'shops', sub: 'Sent to the office for approval' });
    var f = {
      shop: el('input', { autocomplete: 'off' }), biz: el('input', { autocomplete: 'off', placeholder: 'As on the GST or shop licence' }), contact: el('input', { autocomplete: 'off' }),
      mobile: el('input', { inputmode: 'numeric', maxlength: '10', autocomplete: 'off', placeholder: '10-digit mobile' }), email: el('input', { type: 'email', autocomplete: 'off' }),
      gstin: el('input', { autocomplete: 'off', maxlength: '15', style: 'text-transform:uppercase' }), address: el('input', { autocomplete: 'off' }), city: el('input', { autocomplete: 'off' }),
      pincode: el('input', { inputmode: 'numeric', maxlength: '6', autocomplete: 'off' }),
      state: el('select', { 'aria-label': 'State' }, [el('option', { value: '', text: 'Loading…' })]), district: el('select', { 'aria-label': 'District' }, [el('option', { value: '', text: 'Choose the state first' })]),
      consent: el('input', { type: 'checkbox' }),
    };
    var pos = null, posNote = el('div', { class: 'muted small', text: 'No location saved.' }), out = el('div'), key = null;
    pub('/api/b2b/geo/states').then(function (r) {
      f.state.replaceChildren.apply(f.state, [el('option', { value: '', text: 'Choose…' })].concat((r.states || []).map(function (s) { return el('option', { value: String(s.id), text: s.name }); })));
    }).catch(function () { f.state.replaceChildren(el('option', { value: '', text: 'States need a connection' })); });
    f.state.addEventListener('change', function () {
      f.district.replaceChildren(el('option', { value: '', text: 'Loading…' }));
      pub('/api/b2b/geo/districts?state_id=' + encodeURIComponent(f.state.value)).then(function (r) {
        f.district.replaceChildren.apply(f.district, [el('option', { value: '', text: 'Choose…' })].concat((r.districts || []).map(function (d) { return el('option', { value: String(d.id), text: d.name }); })));
      }).catch(function () { f.district.replaceChildren(el('option', { value: '', text: 'Districts need a connection' })); });
    });
    var locBtn = btn('Save my current position as the shop\'s location', function () {
      if (!f.consent.checked) { posNote.textContent = 'First ask the owner and tick the box above.'; return; }
      posNote.textContent = 'Finding your position…';
      gps().then(function (g) { if (g.lat == null) { posNote.textContent = 'The phone could not find the position. You can register without it.'; return; } pos = g; posNote.textContent = 'Saved: ' + g.lat.toFixed(5) + ', ' + g.lng.toFixed(5) + (g.accuracy ? ' (±' + Math.round(g.accuracy) + ' m)' : ''); });
    }, 'sm');
    var saveBtn = big('check', 'Register the shop', function () {
      var body = { shopName: f.shop.value, businessName: f.biz.value || f.shop.value, contactPerson: f.contact.value, mobile: f.mobile.value, email: f.email.value || undefined, gstin: f.gstin.value ? f.gstin.value.toUpperCase() : undefined,
        address: f.address.value, city: f.city.value, pincode: f.pincode.value, stateId: Number(f.state.value) || null, districtId: Number(f.district.value) || null };
      if (pos && f.consent.checked) { body.locationConsent = true; body.latitude = pos.lat; body.longitude = pos.lng; body.accuracyM = pos.accuracy ? Math.round(pos.accuracy) : undefined; }
      saveBtn.disabled = true; out.replaceChildren(msg('info', 'Sending…'));
      api('POST', '/api/sales/retailers', body).then(function (r) {
        key = r.accountId;
        main.replaceChildren(card([el('div', { class: 'done-big' }, [el('span', { class: 'dot' }, [icon('tick', 34)]), el('h2', { text: 'Sent for approval' }),
          el('p', { class: 'muted', text: 'The office checks the shop and its documents, then sets up its sign-in. You can record visits now; orders after approval.' })]),
        el('div', { class: 'btns two' }, [big('store', 'Open the shop', function () { go('shop/' + key); }, 'primary'), big('plus', 'Add another', function () { go('new-shop'); })])]));
      }).catch(function (x) { saveBtn.disabled = false; out.replaceChildren(msg('err', offline(x) ? 'No connection: the shop was not registered. Try again when you have signal.' : x.message)); });
    }, 'primary');
    main.appendChild(card([el('div', { class: 'form' }, [
      field('Shop name', f.shop), field('Business name', f.biz), el('div', { class: 'grid2' }, [field('Owner / contact', f.contact), field('Mobile', f.mobile)]),
      el('div', { class: 'grid2' }, [field('E-mail (optional)', f.email), field('GSTIN (optional)', f.gstin)]),
      field('Shop address', f.address), el('div', { class: 'grid2' }, [field('City / town', f.city), field('PIN code', f.pincode)]),
      el('div', { class: 'grid2' }, [field('State', f.state), field('District', f.district)]),
    ])]));
    main.appendChild(card([el('h2', { text: 'Shop location (optional)' }), el('label', { class: 'check' }, [f.consent, 'The owner agreed that we save the shop\'s location (for routes and deliveries).']), locBtn, posNote]));
    main.appendChild(out); main.appendChild(saveBtn);
  }

  // ───────────────────────── DELIVERIES ─────────────────────────
  function addr(a) { a = a || {}; return [a.line1, a.line2, a.city, a.pincode].filter(Boolean).join(', '); }
  function dueText(s) {
    var p = s.payment;
    if (!p || !(p.due > 0)) return null;
    if (p.method === 'credit') return 'Credit order · ' + money(p.due) + ' paid later to the office';
    return 'Not paid yet: ' + money(p.due) + (p.method ? ' (' + (PAY[p.method] || p.method) + ')' : '');
  }
  function deliveryStep(s, action, pathPart, extra, label, out, after) {
    var opId = uuid();
    return gps().then(function (pos) {
      var payload = Object.assign({ shipmentId: s.id, action: action, clientUuid: opId }, pos.lat != null ? { lat: pos.lat, lng: pos.lng } : {}, extra || {});
      return sendOrQueue('delivery', '/api/erp/deliveries/' + s.id + pathPart, payload, label + ' · ' + s.orderNo, opId, function (r) { if (after) after(true, r); }, out, function () { if (after) after(false); });
    });
  }
  function viewDeliveries(p, qs) {
    var f = qs.f || 'all';
    var main = frame('Deliveries', { sub: todayLong() }), ok = alive();
    var tiles = el('div', {}, [skeleton(1)]), chipBox = el('div'), box = el('div', {}, [skeleton(3)]), out = el('div');
    [tiles, chipBox, out, box].forEach(function (x) { main.appendChild(x); });
    Promise.all([
      cached('soh.deliv', '/api/erp/deliveries?status=open'),
      api('GET', '/api/erp/deliveries?status=done&days=1').catch(function () { return null; }),
    ]).then(function (r) {
      if (!ok()) return;
      var items = r[0].data.items || [], doneToday = r[1] ? (r[1].items || []).filter(function (s) { return daysAgo(s.deliveredAt || s.returnedAt) === 0; }) : null;
      who.deliveries = items;
      var n = function (st) { return items.filter(function (s) { return st.indexOf(s.status) !== -1; }).length; };
      var late = items.filter(function (s) { return s.late; }).length;
      tiles.replaceChildren.apply(tiles, [r[0].old ? oldNote(r[0].at) : null, el('div', { class: 'tiles t4' }, [
        tile('To deliver', String(n(['dispatched', 'attempt_failed'])), 'ready to go', null, null, function () { go('deliveries?f=todo'); }),
        tile('On the way', String(n(['out_for_delivery'])), 'started', null, null, function () { go('deliveries?f=way'); }),
        tile('Delivered today', doneToday ? String(doneToday.length) : '—', 'see Done', 'good', null, function () { go('done'); }),
        tile('Late', String(late), late ? 'past the expected time' : 'none', late ? 'bad' : null),
      ])].filter(Boolean));
      var F = [['all', 'All (' + items.length + ')'], ['todo', 'Ready to go'], ['way', 'On the way'], ['failed', 'Failed attempts'], ['packing', 'Being packed']];
      chipBox.replaceChildren(chips(F, f, function (v) { go('deliveries' + (v === 'all' ? '' : '?f=' + v)); }));
      var keep = { all: null, todo: ['dispatched'], way: ['out_for_delivery'], failed: ['attempt_failed'], packing: ['ready'] }[f];
      var shown = items.filter(function (s) { return !keep || keep.indexOf(s.status) !== -1; });
      if (!shown.length) {
        box.replaceChildren(card([empty(items.length ? 'Nothing in this group' : 'No deliveries for you right now', items.length ? '' : 'New deliveries appear here when the warehouse assigns them to you and dispatches them.', btn('Refresh', function () { render(); }))]));
        return;
      }
      box.replaceChildren(el('div', { class: 'prods' }, shown.map(function (s) { return deliveryCard(s, out); })));
    }).catch(function (x) { if (ok()) box.replaceChildren(msg('err', offline(x) ? 'Offline, and no deliveries are saved on this phone yet.' : x.message)); });
  }
  function deliveryCard(s, out) {
    var a = s.address || {}, due = dueText(s);
    var acts = [];
    if (a.phone) acts.push(el('a', { href: telHref(a.phone) }, [icon('phone', 18), 'Call']));
    acts.push(el('a', { href: mapHref(a.lat, a.lng, addr(a)), target: '_blank', rel: 'noopener' }, [icon('pin', 18), 'Map']));
    if (s.status === 'dispatched' || s.status === 'attempt_failed') acts.push(el('button', { type: 'button', on: { click: function () { deliveryStep(s, 'out_for_delivery', '/out-for-delivery', {}, 'Started', out, function (sent) { if (sent) go('delivery/' + s.id); }); } } }, [icon('truck', 18), 'Start']));
    if (s.status === 'out_for_delivery') acts.push(el('button', { type: 'button', class: 'primary', on: { click: function () { store('soh.ship.' + s.id, s); go('delivery/' + s.id + '/pod'); } } }, [icon('check', 18), 'Delivered']));
    return el('div', { class: 'dcard st-' + s.status }, [
      el('button', { type: 'button', class: 'd-main', on: { click: function () { go('delivery/' + s.id); } } }, [
        el('span', { class: 'd-top' }, [shipBadge(s.status), s.late ? badge('Late', 'bad') : null, s.attempts ? badge(s.attempts + ' failed attempt' + (s.attempts === 1 ? '' : 's'), 'warn') : null, el('span', { class: 'muted small', text: s.orderNo })]),
        el('span', { class: 'd-t', text: s.buyer || a.name || 'Customer' }),
        el('span', { class: 'd-s', text: addr(a) || 'No address on the order' }),
        el('span', { class: 'd-s', text: [s.packages ? s.packages + ' package' + (s.packages === 1 ? '' : 's') : null, s.units ? s.units + ' units' : null, s.expectedAt ? 'expected ' + when(s.expectedAt) : null, s.deliveryStaff && !who.perms['deliveries.update'] ? s.deliveryStaff : null].filter(Boolean).join(' · ') }),
        due ? el('span', { class: 'd-due' + (s.payment.method === 'credit' ? ' muted' : ''), text: due }) : null,
      ]),
      el('div', { class: 'd-acts' }, acts),
    ]);
  }
  function viewDelivery(p) {
    var id = Number(p[0]);
    var main = frame('Delivery', { back: 'deliveries' }), ok = alive();
    main.appendChild(skeleton(3));
    cached('soh.ship.' + id, '/api/erp/deliveries/' + id).then(function (r) { if (ok()) draw(r.data, r.old, r.at); })
      .catch(function (x) { if (ok()) main.replaceChildren(msg('err', x.status === 404 ? 'This delivery is not assigned to you.' : offline(x) ? 'Offline, and this delivery is not saved on the phone yet.' : x.message)); });
    function draw(s, old, at) {
      var a = s.address || {}, out = el('div'), moving = ['dispatched', 'out_for_delivery', 'attempt_failed'].indexOf(s.status) !== -1;
      setTitle(s.buyer || 'Delivery', s.orderNo + (s.shipmentNo ? ' · ' + s.shipmentNo : ''));
      var ST = {
        ready: ['box', '', 'Being packed at the warehouse', 'You can start once it is dispatched.'],
        dispatched: ['truck', 'info', 'Ready to go', 'Start the delivery when you leave with it.'],
        out_for_delivery: ['truck', 'accent', 'On the way', 'Confirm with a photo when it is handed over.'],
        attempt_failed: ['alert', 'bad', 'Attempt failed', 'Start again when you go back to the customer.'],
        delivered: ['check', 'good', 'Delivered', s.deliveredAt ? when(s.deliveredAt) : ''],
        partially_delivered: ['check', 'good', 'Part delivered', s.deliveredAt ? when(s.deliveredAt) : ''],
        returned: ['back', 'bad', 'Returned to the warehouse', s.returnedAt ? when(s.returnedAt) : ''],
        cancelled: ['x', '', 'Cancelled', ''],
      }[s.status] || ['box', '', s.status, ''];
      var kids = [old ? oldNote(at) : null];
      kids.push(card([el('div', { class: 'status ' + ST[1] }, [el('span', { class: 'dot' }, [icon(ST[0], 24)]), el('div', {}, [el('div', { class: 'st-t', text: ST[2] }), el('div', { class: 'st-s', text: ST[3] })])]),
        el('div', { class: 'd-top' }, [s.late ? badge('Late', 'bad') : null, s.expectedAt ? badge('Expected ' + when(s.expectedAt), s.late ? 'bad' : 'info') : null,
          s.attempts ? badge(s.attempts + (s.maxAttempts ? ' of ' + s.maxAttempts : '') + ' attempts failed', 'warn') : null])]));
      var main1 = [];
      if (s.status === 'dispatched' || s.status === 'attempt_failed') main1.push(big('truck', s.status === 'attempt_failed' ? 'Start again' : 'Start delivery', function (ev) { ev.currentTarget.disabled = true; deliveryStep(s, 'out_for_delivery', '/out-for-delivery', {}, 'Started', out, function () { setTimeout(render, 600); }); }, 'primary'));
      if (moving) main1.push(big('camera', 'Delivered — take a photo', function () { store('soh.ship.' + s.id, s); go('delivery/' + s.id + '/pod'); }, s.status === 'out_for_delivery' ? 'primary' : ''));
      if (s.status === 'out_for_delivery' || s.status === 'dispatched') main1.push(big('alert', 'Could not deliver', function () { store('soh.ship.' + s.id, s); go('delivery/' + s.id + '/failed'); }, 'danger'));
      if (main1.length) kids.push(el('div', { class: 'btns' }, main1));
      kids.push(out);
      kids.push(card([head('Customer'), el('div', {}, [el('strong', { text: a.name || s.buyer || '' }), el('div', { class: 'muted', text: [a.contact, a.phone].filter(Boolean).join(' · ') }), el('div', { text: addr(a) }), a.state ? el('div', { class: 'muted small', text: a.state }) : null]),
        el('div', { class: 'acts' }, [a.phone ? linkAct('phone', 'Call', telHref(a.phone)) : null, a.phone ? linkAct('chat', 'WhatsApp', waHref(a.phone), true) : null, linkAct('pin', 'Directions', mapHref(a.lat, a.lng, addr(a)), true)])]));
      var items = s.items || [];
      kids.push(card([head('Goods', s.challanNo ? btn('Challan', function () { openChallan(s.id, out); }, 'sm') : null),
        items.length ? list(items.map(function (i) { return rowi(i.name, i.sku || '', [i.delivered != null && i.delivered !== i.qty ? i.delivered + ' of ' + i.qty : '× ' + i.qty]); })) : el('div', { class: 'muted small', text: 'Open with signal to see the items.' }),
        kv([['Packages', s.packages], ['Weight', s.weightKg != null ? s.weightKg + ' kg' : null], ['Vehicle', s.vehicleNo], ['Carrier', s.carrier], ['Tracking / LR', s.trackingNo || s.lrNo], ['E-way bill', s.ewayBillNo], ['Challan', s.challanNo], ['From', s.warehouse]])]));
      if (s.payment) kids.push(card([head('Payment'), kv([['Order value', money(s.value)], ['Paid', money(s.payment.paid)], ['Still due', money(s.payment.due)], ['How the buyer pays', PAY[s.payment.method] || s.payment.method]]),
        s.payment.due > 0 ? el('p', { class: 'muted small', text: 'If the customer pays you, give the money to the office with the order number — this app does not record payments for deliveries.' }) : null]));
      if (s.status === 'delivered' || s.status === 'partially_delivered') {
        var proofBox = el('div');
        kids.push(card([head('Proof of delivery'), kv([['Received by', s.receivedBy], ['Phone', s.receiverPhone], ['Note', s.podNote], ['When', s.deliveredAt ? when(s.deliveredAt) : null]]),
          s.hasProof ? btn('Show the photo', function () { showProof(s.id, proofBox); }, 'sm') : el('div', { class: 'muted small', text: 'No photo was attached.' }), proofBox]));
      }
      if (moving) {
        var noteIn = el('input', { placeholder: 'e.g. Stuck in traffic, 20 minutes late', 'aria-label': 'Update on the way' }), upOut = el('div');
        kids.push(card([head('Send an update'), el('p', { class: 'muted small', text: 'Shown on the delivery timeline for the office and the customer.' }), noteIn,
          el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [btn('Send', function () {
            if (!noteIn.value.trim()) { upOut.replaceChildren(msg('err', 'Write the update first.')); return; }
            deliveryStep(s, 'location', '/location', { note: noteIn.value.trim() }, 'Update', upOut, function (sent) { if (sent) { upOut.replaceChildren(msg('ok', 'Update sent.')); noteIn.value = ''; } });
          }, 'primary sm'), btn('I am here (share position)', function () { deliveryStep(s, 'location', '/location', { place: a.city || 'on the way' }, 'Position', upOut, function (sent) { if (sent) upOut.replaceChildren(msg('ok', 'Position shared.')); }); }, 'sm')]), upOut]));
      }
      if (s.events && s.events.length) {
        var K = { created: 'Shipment created', dispatched: 'Dispatched', out_for_delivery: 'Out for delivery', location: 'Position', note: 'Update', attempt_failed: 'Attempt failed', delivered: 'Delivered', partially_delivered: 'Part delivered', returned: 'Returned', cancelled: 'Cancelled' };
        kids.push(card([head('Timeline'), el('ol', { class: 'timeline' }, s.events.slice().reverse().map(function (e) {
          return el('li', {}, [el('div', { class: 't', text: K[e.kind] || e.kind }), el('div', { class: 's', text: [when(e.at), e.note, e.place].filter(Boolean).join(' · ') })]);
        }))]));
      }
      main.replaceChildren.apply(main, kids.filter(Boolean));
    }
  }
  function showProof(id, box) {
    box.replaceChildren(msg('info', 'Loading…'));
    authBlob('/api/erp/deliveries/' + id + '/proof').then(function (b) {
      var u = URL.createObjectURL(b);
      box.replaceChildren(/^image\//.test(b.type) ? el('img', { class: 'proofimg', src: u, alt: 'Proof of delivery' }) : el('a', { href: u, target: '_blank', rel: 'noopener', text: 'Open the signed copy (PDF)' }));
    }).catch(function (x) { box.replaceChildren(msg('err', x.message)); });
  }
  function openChallan(id, out) {
    var w = window.open('', '_blank');
    authBlob('/api/erp/deliveries/' + id + '/challan').then(function (b) {
      var u = URL.createObjectURL(new Blob([b], { type: 'text/html' }));
      if (w) w.location.href = u; else location.href = u;
    }).catch(function (x) { if (w) w.close(); out.replaceChildren(msg('err', x.message)); });
  }
  /** Phone photos are large: send at most ~1600 px as JPEG (also turns HEIC into JPEG where the phone can). */
  function shrink(file) {
    return new Promise(function (resolve) {
      var plain = { blob: file, name: file.name || 'proof' };
      var isImg = /^image\//.test(file.type), ok = /^image\/(jpeg|png|webp)$/.test(file.type);
      if (!isImg || (ok && file.size < 1200000) || !window.createImageBitmap) return resolve(plain);
      createImageBitmap(file).then(function (img) {
        var scale = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        if (!c.toBlob) return resolve(plain);
        c.toBlob(function (b) { resolve(b && (!ok || b.size < file.size) ? { blob: b, name: 'proof.jpg' } : plain); }, 'image/jpeg', 0.82);
      }).catch(function () { resolve(plain); });
    });
  }
  function shipmentFor(id, ok, then, main) {
    api('GET', '/api/erp/deliveries/' + id).then(function (s) { store('soh.ship.' + id, s); if (ok()) then(s); }).catch(function (x) {
      var c = load('soh.ship.' + id);
      if (offline(x) && c) { if (ok()) then(c.data); return; }
      if (ok()) main.replaceChildren(msg('err', x.message));
    });
  }
  function viewPod(p) {
    var id = Number(p[0]);
    var main = frame('Confirm delivery', { back: 'delivery/' + id }), ok = alive();
    main.appendChild(skeleton(2));
    shipmentFor(id, ok, draw, main);
    function draw(s) {
      var a = s.address || {}, items = s.items || [], file = null, mode1 = 'all', key = uuid(), out = el('div');
      setTitle('Confirm delivery', (s.buyer || '') + ' · ' + s.orderNo);
      if (['dispatched', 'out_for_delivery', 'attempt_failed'].indexOf(s.status) === -1) { main.replaceChildren(msg('warn', 'This delivery is ' + ((SHIP_ST[s.status] || [s.status])[0]).toLowerCase() + '.'), big('back', 'Back', function () { go('delivery/' + id); })); return; }
      var picker = el('input', { type: 'file', accept: 'image/*,.pdf', capture: 'environment', hidden: true, 'aria-label': 'Photo of the goods or the signed challan' });
      var photo = el('button', { type: 'button', class: 'photo', on: { click: function () { picker.click(); } } });
      function drawPhoto() {
        if (!file) { photo.replaceChildren(icon('camera', 34), el('span', { text: 'Take a photo of the goods or the signed challan' }), el('span', { class: 'muted small', text: 'Recommended. A PDF works too.' })); return; }
        photo.replaceChildren(/^image\//.test(file.type) ? el('img', { src: URL.createObjectURL(file), alt: 'Photo to send' }) : el('strong', { text: file.name }), el('span', { class: 'muted small', text: 'Tap to take it again' }));
      }
      picker.addEventListener('change', function () { file = picker.files && picker.files[0] || null; drawPhoto(); });
      drawPhoto();
      var rb = el('input', { value: a.contact || a.name || '', autocomplete: 'off' }), ph = el('input', { inputmode: 'numeric', maxlength: '13', value: digits(a.phone), autocomplete: 'off' });
      var noteIn = el('input', { placeholder: 'Optional', autocomplete: 'off' });
      var qtys = {}, qBox = el('div'), modeBox = el('div');
      function drawMode() {
        modeBox.replaceChildren(chips([['all', 'Everything delivered'], ['part', 'Some items short']], mode1, function (v) { mode1 = v; drawMode(); }, true));
        if (mode1 !== 'part') { qBox.replaceChildren(); return; }
        qBox.replaceChildren(items.length ? list(items.map(function (i) {
          var inp = el('input', { inputmode: 'numeric', value: String(qtys[i.id] != null ? qtys[i.id] : i.qty), 'aria-label': 'Delivered quantity of ' + i.name, style: 'width:80px' });
          inp.addEventListener('input', function () { qtys[i.id] = inp.value; });
          return el('div', { class: 'rowi' }, [el('span', { class: 'r-m' }, [el('span', { class: 'r-t', text: i.name }), el('span', { class: 'r-s', text: 'ordered ' + i.qty })]), inp]);
        })) : msg('warn', 'Open this delivery with signal to change quantities.'),
        el('p', { class: 'muted small', text: 'Write how many were actually handed over. The office raises the credit note for the rest.' }));
      }
      drawMode();
      var confirmBtn = big('check', 'Confirm delivery', function () {
        if (rb.value.trim().length < 2) { out.replaceChildren(msg('err', 'Write who received the goods.')); return; }
        var delivered;
        if (mode1 === 'part') {
          delivered = {};
          for (var k = 0; k < items.length; k++) {
            var it = items[k], v = qtys[it.id] != null ? Number(qtys[it.id]) : it.qty;
            if (!isFinite(v) || v < 0 || v > it.qty || Math.floor(v) !== v) { out.replaceChildren(msg('err', 'Check the quantity of ' + it.name + ' (0 to ' + it.qty + ').')); return; }
            delivered[it.id] = v;
          }
        }
        confirmBtn.disabled = true; out.replaceChildren(msg('info', file ? 'Sending the photo…' : 'Saving…'));
        gps().then(function (pos) {
          var payload = { shipmentId: s.id, action: 'delivered', clientUuid: key, receivedBy: rb.value.trim(), receiverPhone: digits(ph.value) || undefined, note: noteIn.value.trim() || undefined, delivered: delivered };
          if (pos.lat != null) { payload.lat = pos.lat; payload.lng = pos.lng; }
          if (file && navigator.onLine !== false) {
            return shrink(file).then(function (f) {
              var fd = new FormData();
              Object.keys(payload).forEach(function (k2) { if (payload[k2] != null && k2 !== 'action' && k2 !== 'shipmentId') fd.append(k2, k2 === 'delivered' ? JSON.stringify(payload[k2]) : String(payload[k2])); });
              fd.append('file', f.blob, f.name);
              return fetch('/api/erp/deliveries/' + s.id + '/delivered', { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd })
                .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'Failed'); e.status = r.status; throw e; } return j; }); })
                .then(function (r) { finished(r, true); })
                .catch(function (e) {
                  if (!offline(e)) { confirmBtn.disabled = false; out.replaceChildren(msg('err', e.message)); return; }
                  out.replaceChildren(msg('warn', 'The connection dropped while sending the photo. The delivery is saved on this phone without the photo; show the photo to the office.'));
                  return Q.add('delivery', payload, 'Delivered · ' + s.orderNo, key).then(function () { finished(null, false); });
                });
            });
          }
          if (file) out.replaceChildren(msg('warn', 'No connection: the delivery is saved without the photo; show it to the office later.'));
          return sendOrQueue('delivery', '/api/erp/deliveries/' + s.id + '/delivered', payload, 'Delivered · ' + s.orderNo, key, function (r) { finished(r, true); }, out, function () { finished(null, false); })
            .then(function () { confirmBtn.disabled = false; });
        });
      }, 'primary');
      function finished(r, sent) {
        main.replaceChildren(card([el('div', { class: 'done-big' }, [el('span', { class: 'dot' }, [icon('tick', 34)]),
          el('h2', { text: sent ? (r && r.status === 'partially_delivered' ? 'Part delivered — saved' : 'Delivered — saved') : 'Saved on this phone' }),
          el('p', { class: 'muted', text: sent ? (r && r.invoiceNo ? 'Invoice ' + r.invoiceNo + '. ' : '') + 'The customer and the office can see it now.' : 'It is sent automatically when the signal returns.' })]),
        big('truck', 'Next delivery', function () { go('deliveries'); }, 'primary')]));
      }
      main.replaceChildren(card([el('h2', { text: 'Photo' }), photo, picker]),
        card([el('div', { class: 'form' }, [field('Received by', rb), field('Their phone', ph, 'So the office can confirm if needed.'), el('div', { class: 'form' }, [el('strong', { text: 'Was everything handed over?' }), modeBox]), qBox, field('Note', noteIn)])]),
        out, confirmBtn);
    }
  }
  function viewFailed(p) {
    var id = Number(p[0]);
    var main = frame('Could not deliver', { back: 'delivery/' + id }), ok = alive();
    main.appendChild(skeleton(2));
    shipmentFor(id, ok, draw, main);
    function draw(s) {
      setTitle('Could not deliver', (s.buyer || '') + ' · ' + s.orderNo);
      if (s.status !== 'out_for_delivery' && s.status !== 'dispatched') { main.replaceChildren(msg('warn', s.status === 'attempt_failed' ? 'A failed attempt is already recorded. Start the delivery again when you go back.' : 'This delivery is not on its way.'), big('back', 'Back', function () { go('delivery/' + id); })); return; }
      var reason = null, out = el('div'), box = el('div');
      var R = [['Shop closed', 'Shop closed'], ['Owner not available', 'Owner not available'], ['Refused to accept', 'Refused to accept'], ['Address not found', 'Address not found'], ['Payment not ready', 'Payment not ready'], ['other', 'Other']];
      var more = el('textarea', { rows: '3', placeholder: 'What happened? When should we come back?', 'aria-label': 'Details' });
      function drawR() { box.replaceChildren(chips(R, reason, function (v) { reason = v; drawR(); }, true)); }
      drawR();
      var save = big('alert', 'Save the failed attempt', function () {
        var text = reason && reason !== 'other' ? reason + (more.value.trim() ? ' — ' + more.value.trim() : '') : more.value.trim();
        if (!text || text.length < 3) { out.replaceChildren(msg('err', 'Choose a reason or write what happened.')); return; }
        save.disabled = true;
        deliveryStep(s, 'attempt_failed', '/attempt-failed', { reason: text.slice(0, 300) }, 'Failed attempt', out, function (sent, r) {
          main.replaceChildren(card([el('div', { class: 'done-big' }, [el('span', { class: 'dot' }, [icon('alert', 30)]), el('h2', { text: sent ? 'Failed attempt saved' : 'Saved on this phone' }),
            el('p', { class: 'muted', text: sent ? (r && r.lastAttempt ? 'This was the last attempt: take the goods back to the warehouse. ' : 'The customer is told and the office sees it. ') : 'It is sent automatically when the signal returns.' })]),
          big('truck', 'Next delivery', function () { go('deliveries'); }, 'primary')]));
        }).then(function () { save.disabled = false; });
      }, 'danger');
      put(main, [card([el('h2', { text: 'Why?' }), box, field('Details', more)]),
        s.maxAttempts ? el('p', { class: 'muted small', text: 'Attempt ' + (Number(s.attempts || 0) + 1) + ' of ' + s.maxAttempts + '. After the last one the goods go back to the warehouse.' }) : null,
        out, save]);
    }
  }
  function viewDone(p, qs) {
    var d = ['1', '7', '30'].indexOf(qs.d) !== -1 ? qs.d : '1';
    var main = frame('Done', { sub: 'What you finished' }), ok = alive();
    var box = el('div', {}, [skeleton(3)]);
    main.appendChild(chips([['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']], d, function (v) { go('done?d=' + v); }));
    main.appendChild(box);
    api('GET', '/api/erp/deliveries?status=done&days=' + d).then(function (r) {
      if (!ok()) return;
      var items = (r.items || []).filter(function (s) { return d !== '1' || daysAgo(s.deliveredAt || s.returnedAt) === 0; });
      var n = function (st) { return items.filter(function (s) { return s.status === st; }).length; };
      box.replaceChildren(el('div', { class: 'tiles' }, [tile('Delivered', String(n('delivered')), '', 'good'), tile('Part delivered', String(n('partially_delivered')), '', n('partially_delivered') ? 'warn' : null), tile('Returned', String(n('returned')), '', n('returned') ? 'bad' : null)]),
        items.length ? card([list(items.map(function (s) {
          return rowi(s.buyer || s.orderNo, [s.orderNo, when(s.deliveredAt || s.returnedAt), s.receivedBy ? 'received by ' + s.receivedBy : null, s.hasProof ? 'photo ✓' : null].filter(Boolean).join(' · '), [shipBadge(s.status)], function () { go('delivery/' + s.id); });
        }))]) : card([empty(d === '1' ? 'Nothing finished yet today' : 'Nothing in this period', 'Deliveries you complete appear here.')]));
    }).catch(function (x) { if (ok()) box.replaceChildren(msg(offline(x) ? 'warn' : 'err', offline(x) ? 'This page needs a connection.' : x.message)); });
  }

  // ───────────────────────── EVENTS ─────────────────────────
  function viewEvents() {
    var main = frame('My events'), out = el('div');
    main.appendChild(out);
    who.events.forEach(function (ev) {
      main.appendChild(card([el('div', { class: 'card-h' }, [el('div', {}, [el('h2', { text: ev.code + ' — ' + ev.name }), el('div', { class: 'muted small', text: ev.startsOn + ' → ' + ev.endsOn })]), badge(ev.status, ev.status === 'open' ? 'good' : 'warn')]),
        el('div', { class: 'btns two' }, [ev.status === 'open' ? big('cart', 'Open the counter', function () { go('counter/' + ev.id); }, 'primary') : el('div', { class: 'muted', text: ev.status === 'planned' ? 'Not open yet' : 'Closed' }),
          canShareLocation() ? big('pin', 'Share stall location', function () { shareLocation('event', ev.id, out); }) : null])]));
    });
  }
  // Event counter (3b.5): sells online, or keeps the sale for sending when offline
  function viewCounter(p) {
    var ev = who.events.filter(function (e) { return String(e.id) === String(p[0]); })[0];
    if (!ev) { go('events'); return; }
    var main = frame(ev.code + ' counter', { back: 'events', sub: ev.name });
    var out = el('div'), items = el('div', { class: 'prods' }), lines = {}, key = uuid();
    main.appendChild(out); main.appendChild(items);
    var cacheKey = 'soh.eventstock.' + ev.id;
    function drawStock(stock, cached1) {
      if (cached1) items.appendChild(msg('warn', 'Offline: prices from ' + new Date(stock.at).toLocaleString() + '. Stock is checked again when the sale is sent; if it ran out, the office settles it.'));
      stock.items.forEach(function (pr) {
        var q = el('input', { inputmode: 'numeric', 'aria-label': 'Quantity of ' + pr.name, placeholder: '0', style: 'width:80px' });
        q.addEventListener('input', function () { var n = parseInt(q.value, 10); if (n > 0) lines[pr.productId] = n; else delete lines[pr.productId]; total(); });
        items.appendChild(el('div', { class: 'prod' }, [el('div', { class: 'p-m' }, [el('div', { class: 'p-t', text: pr.name }), el('div', { class: 'p-s', text: money(pr.mrp) + ' incl. GST ' + pr.gstRate + '% · ' + pr.available + ' here' + (pr.nextExpiry ? ' · next expiry ' + String(pr.nextExpiry).slice(0, 10) : '') })]), q]));
      });
      var byId = {}; stock.items.forEach(function (pr) { byId[pr.productId] = pr; });
      function total() { var t = 0; Object.keys(lines).forEach(function (k) { t += byId[k].mrp * lines[k]; }); sum.textContent = 'Total ' + money(t); }
      var sum = el('strong', { text: 'Total ₹0.00' });
      var cn = el('input', { 'aria-label': 'Customer name', placeholder: 'Customer name (optional)' }), cm = el('input', { 'aria-label': 'Customer mobile', inputmode: 'tel', placeholder: 'Mobile for the invoice (optional)' });
      var pm = el('select', { 'aria-label': 'Paid by' }, [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['', 'Not paid yet']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      main.appendChild(card([sum, el('div', { class: 'grid2' }, [cn, cm]), pm, big('check', 'Confirm sale', function () {
        var its = Object.keys(lines).map(function (k) { return { productId: Number(k), qty: lines[k] }; });
        if (!its.length) { out.replaceChildren(msg('err', 'Enter a quantity.')); return; }
        var grand = 0; its.forEach(function (i) { grand += byId[i.productId].mrp * i.qty; });
        var body = { idempotencyKey: key, eventId: ev.id, items: its, customer: { name: cn.value, mobile: cm.value }, soldAt: new Date().toISOString(),
          payments: pm.value ? [{ method: pm.value, amount: Math.round(grand) }] : [] };
        sendOrQueue('event_sale', '/api/erp/events/sales', body, 'Sale at ' + ev.code + ' (' + money(grand) + ')', key, function (s) {
          out.replaceChildren(msg('ok', 'Invoice ' + s.invoiceNo + ' · ' + money(s.totals.grand) + (s.duplicate ? ' (already recorded)' : '')));
          setTimeout(render, 1500);
        }, out).then(function () { key = uuid(); lines = {}; });
      }, 'primary')]));
    }
    api('GET', '/api/erp/events/' + ev.id + '/stock').then(function (s) {
      try { localStorage.setItem(cacheKey, JSON.stringify({ at: new Date().toISOString(), items: s.items })); } catch (e) { /* convenience copy only */ }
      drawStock(s);
    }).catch(function (x) {
      var c = null; try { c = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch (e) { /* */ }
      if (offline(x) && c) drawStock(c, true); else out.replaceChildren(msg('err', offline(x) ? 'Offline and no price list saved on this phone yet: open the counter once with a connection.' : x.message));
    });
  }

  // ───────────────────────── MORE ─────────────────────────
  function viewMore() {
    var main = frame('More'), out = el('div');
    var roles = [who.salesman ? 'Salesman' + (who.salesman.salesman.employeeCode ? ' (' + who.salesman.salesman.employeeCode + ')' : '') : null, who.deliveries ? 'Deliveries' : null, who.events.length ? 'Event counter' : null].filter(Boolean);
    main.appendChild(card([el('div', { class: 'status' }, [el('span', { class: 'dot' }, [icon('user', 24)]), el('div', {}, [el('div', { class: 'st-t', text: who.name || 'Signed in' }), el('div', { class: 'st-s', text: roles.join(' · ') })])])]));
    main.appendChild(card([head('Work saved on this phone'), queuePanel()]));
    Q.persistent().then(function (okp) { if (!okp) main.insertBefore(msg('warn', 'This browser cannot keep unsent work after the page closes: stay on this page until it is sent.'), main.firstChild); });
    if (canShareLocation() && who.salesman) main.appendChild(card([head('My location'), el('p', { class: 'muted small', text: 'Shares where you are now with the office, once. Nothing tracks you in the background.' }), btn('Share my location', function () { shareLocation('salesman', null, out); }), out]));
    main.appendChild(card([head('Help'), el('p', { class: 'muted small', text: 'Without signal, visits, orders, delivery steps and sales are kept on this phone and sent when the signal returns. Payments and new shops need a connection.' }),
      el('p', { class: 'muted small', text: 'Password or two-step sign-in: use the main sign-in page (sakeofhealth.com/login).' })]));
    main.appendChild(big('logout', 'Sign out', function () { logout(); }, 'danger'));
  }

  // ───────────────────────── start ─────────────────────────
  function start() {
    if (!token) { root.replaceChildren(login()); return; }
    Q.init(function () { return token; });
    root.replaceChildren(el('div', { class: 'boot' }, [skeleton(3)]));
    who = { ready: false, salesman: null, events: [], deliveries: null, name: '', perms: {} };
    Promise.all([
      api('GET', '/api/sales/me').catch(function (x) { if (x.code === 'password_change_required') throw x; if (x.code === 'not_salesman' || x.status === 403) return null; throw x; }),
      api('GET', '/api/erp/events').then(function (r) { return r.items.filter(function (e) { return e.status !== 'closed'; }); }).catch(function (x) { if (x.status === 403) return []; throw x; }),
      // deliveries are optional here: any failure (no right, older server) leaves the rest of the app working
      api('GET', '/api/erp/deliveries?status=open').then(function (r) { if (Array.isArray(r && r.items)) store('soh.deliv', r); return Array.isArray(r && r.items) ? r.items : null; }).catch(function () { return null; }),
      api('GET', '/api/erp/core/me').catch(function () { return null; }),
    ]).then(function (x) {
      who.salesman = x[0]; who.events = x[1]; who.deliveries = x[2];
      var me = x[3];
      who.name = (me && me.name) || (x[0] && x[0].salesman.name) || '';
      who.perms = {}; ((me && me.permissions) || []).forEach(function (pm) { who.perms[pm] = true; });
      if (!me && x[0]) who.perms['locations.capture'] = true;
      if (!who.salesman && !who.events.length && !who.deliveries) { root.replaceChildren(login('This account is not set up as a salesman, for any event or for deliveries.')); return; }
      who.ready = true;
      var saved = null; try { saved = sessionStorage.getItem('sales.mode'); } catch (e) { /* */ }
      mode = modes().indexOf(saved) !== -1 ? saved : modes()[0];
      if (!path()) location.replace('#/' + HOME[mode]); else render();
    }).catch(function (x) {
      if (x.code === 'password_change_required') {   // a saved session from before the password must be changed
        token = null; try { sessionStorage.removeItem('sales.token'); } catch (e) { /* */ }
        root.replaceChildren(login('Sign in again with your temporary password to choose your own.'));
        return;
      }
      if (offline(x)) {
        root.replaceChildren(el('div', { class: 'boot' }, [msg('warn', 'Offline. Saved work is kept on this phone and sent when the connection returns.'), card([queuePanel()]), big('refresh', 'Try again', start, 'primary')]));
        return;
      }
      logout();
    });
  }
  Q.onChange(function (ops) { queueOps = ops || []; queueViews.forEach(function (f) { f(); }); });
  start();
})();
