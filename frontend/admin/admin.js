/* ═══════════ Sake of Health — Admin shared runtime ═══════════ */
(function () {
  'use strict';

  var TOKEN_KEY = 'soh_admin_token';
  var USER_KEY = 'soh_admin_user';
  var ERP_KEY = 'soh_erp_token';      // ERP staff session (MySQL accounts), set by the one sign-in

  /* ─────────── Auth ─────────── */
  var Auth = {
    token: function () { return localStorage.getItem(TOKEN_KEY) || ''; },
    user: function () {
      try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
    },
    erpToken: function () { return localStorage.getItem(ERP_KEY) || ''; },
    set: function (token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    /** One panel session: shop/trade staff token and/or ERP token (either may be null). */
    setSession: function (token, erpToken, user) {
      if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
      if (erpToken) localStorage.setItem(ERP_KEY, erpToken); else localStorage.removeItem(ERP_KEY);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      try { sessionStorage.removeItem('soh_admin_nav'); } catch (e) { /* */ }
    },
    clearErp: function () { localStorage.removeItem(ERP_KEY); try { sessionStorage.removeItem('soh_admin_nav'); } catch (e) { /* */ } },
    clear: function () {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(ERP_KEY);
      try { sessionStorage.removeItem('soh_admin_nav'); } catch (e) { /* */ }
    },
    logout: function () {
      this.clear();
      location.href = '/login';
    },
    require: function () {
      if (!this.token() && !this.erpToken()) { location.replace('/login'); return false; }
      return true;
    },
  };

  /* ─────────── API client ─────────── */
  async function api(path, options) {
    options = options || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var token = Auth.token();
    if (token) headers.Authorization = 'Bearer ' + token;

    var res;
    try {
      res = await fetch('/api/admin' + path, Object.assign({}, options, {
        headers: headers,
        body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
      }));
    } catch (e) {
      throw new Error('Network error — check your connection and try again.');
    }

    if (res.status === 401) {
      Auth.clear();
      location.replace('/login?expired=1');
      throw new Error('Session expired');
    }

    var ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      if (!res.ok) throw new Error('Request failed (' + res.status + ')');
      return res;
    }

    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  api.get = function (p) { return api(p); };
  api.post = function (p, body) { return api(p, { method: 'POST', body: body }); };
  api.patch = function (p, body) { return api(p, { method: 'PATCH', body: body }); };
  api.put = function (p, body) { return api(p, { method: 'PUT', body: body }); };
  api.del = function (p) { return api(p, { method: 'DELETE' }); };

  /* ─────────── Formatting ─────────── */
  var fmt = {
    money: function (n) {
      return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    },
    moneyShort: function (n) {
      n = Number(n || 0);
      if (n >= 10000000) return '₹' + (n / 10000000).toFixed(1).replace('.0', '') + 'Cr';
      if (n >= 100000) return '₹' + (n / 100000).toFixed(1).replace('.0', '') + 'L';
      if (n >= 1000) return '₹' + (n / 1000).toFixed(1).replace('.0', '') + 'k';
      return '₹' + n;
    },
    num: function (n) { return Number(n || 0).toLocaleString('en-IN'); },
    date: function (d) {
      if (!d) return '—';
      return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    },
    dateTime: function (d) {
      if (!d) return '—';
      return new Date(d).toLocaleString('en-IN', {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
      });
    },
    time: function (d) {
      if (!d) return '—';
      return new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
    },
    relative: function (d) {
      if (!d) return '—';
      var diff = Date.now() - new Date(d).getTime();
      var mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      var days = Math.floor(hrs / 24);
      if (days < 7) return days + 'd ago';
      return fmt.date(d);
    },
    phone: function (p) {
      p = String(p || '');
      return p.length === 10 ? p.slice(0, 5) + ' ' + p.slice(5) : p;
    },
    initials: function (name) {
      return String(name || '?').trim().split(/\s+/).slice(0, 2)
        .map(function (w) { return w[0]; }).join('').toUpperCase();
    },
    stars: function (r) {
      var full = Math.round(Number(r) || 0);
      return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
    },
  };

  /* ─────────── HTML escaping ─────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ─────────── Status meta ─────────── */
  var STATUS = {
    pending: { label: 'Pending', short: 'Pending', order: 0 },
    accepted: { label: 'Order Accepted', short: 'Accepted', order: 1 },
    prepared: { label: 'Order Prepared', short: 'Prepared', order: 2 },
    out_for_delivery: { label: 'Out for Delivery', short: 'Out for Delivery', order: 3 },
    delivered: { label: 'Delivered', short: 'Delivered', order: 4 },
    cancelled: { label: 'Cancelled', short: 'Cancelled', order: 99 },
  };
  var STATUS_FLOW = ['pending', 'accepted', 'prepared', 'out_for_delivery', 'delivered'];

  function statusBadge(status) {
    var meta = STATUS[status] || { short: status };
    return '<span class="badge badge-' + esc(status) + '">' + esc(meta.short) + '</span>';
  }

  /* ─────────── Toasts ─────────── */
  function toast(message, type) {
    var stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all .2s';
      setTimeout(function () { el.remove(); }, 200);
    }, type === 'error' ? 4500 : 2800);
  }

  /* ─────────── Icons ─────────── */
  var icons = {
    dashboard: '<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>',
    orders: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0"/>',
    products: '<path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.3 7 12 12l8.7-5M12 22V12"/>',
    coupons: '<path d="M9 5H2v14h7M9 5h13v14H9M9 5v14M13 9h5M13 13h5"/>',
    analytics: '<path d="M3 3v18h18M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/>',
    customers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    reviews: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    reports: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    staff: '<path d="M20 7h-9M14 17H5M17 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM7 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>',
    deliveries: '<path d="M10 17h4V5H2v12h3M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1M14 17h1"/><circle cx="7.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    map: '<path d="M9 20 3 17V4l6 3m0 13 6-3m-6 3V7m6 10 6 3V7l-6-3m0 13V4m0 0L9 7"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    refresh: '<path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
    store: '<path d="M3 9l1-5h16l1 5M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>',
    truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    network: '<circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><path d="M12 8v4M12 12l-5.5 4.5M12 12l5.5 4.5"/>',
    box: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>',
    rupee: '<path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  };

  function icon(name, size) {
    var path = icons[name];
    if (!path) return '';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"' +
      (size ? ' width="' + size + '" height="' + size + '"' : '') + '>' + path + '</svg>';
  }

  /* ─────────── Sidebar ───────────
     One menu for the whole admin panel. The server builds it from the page
     registry (src/platform/registry.js) and the user's permissions, so a link
     is shown only when the user may open that page. It is cached for this
     browser tab and refreshed on every page load. */
  var B2B_ONLY_ROLES = ['b2b_admin', 'b2b_manager', 'sales', 'inventory', 'finance', 'support'];
  var NAV_KEY = 'soh_admin_nav';
  function b2bEnabled() { return !!(window.SOH_CONFIG && window.SOH_CONFIG.b2bEnabled); }
  function navCacheKey() { return (Auth.token() + '|' + Auth.erpToken()).slice(-48); }
  function cachedNav() {
    try {
      var c = JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null');
      return c && c.key === navCacheKey() ? c.nav : null;
    } catch (e) { return null; }
  }
  async function fetchNav() {
    var h = {};
    if (Auth.token()) h.Authorization = 'Bearer ' + Auth.token();
    if (Auth.erpToken()) h['X-ERP-Token'] = Auth.erpToken();
    var res = await fetch('/api/platform/nav', { headers: h });
    if (res.status === 401) { Auth.clear(); location.replace('/login?expired=1'); throw new Error('Session expired'); }
    if (res.status === 503) throw new Error('The business platform is not available right now');
    if (!res.ok) throw new Error('Menu unavailable');
    var nav = await res.json();
    // An ERP session that has ended (signed out elsewhere, role removed) is dropped quietly.
    if (nav.erp === 'ended' || nav.erp === 'invalid') localStorage.removeItem(ERP_KEY);
    try { sessionStorage.setItem(NAV_KEY, JSON.stringify({ key: navCacheKey(), nav: nav })); } catch (e) { /* storage blocked */ }
    return nav;
  }
  function navItems(nav) { return nav ? nav.groups.reduce(function (a, g) { return a.concat(g.items); }, []) : []; }
  function navHTML(nav, activeId) {
    if (!nav) return '<div class="sb-group"><div class="sb-group-title">Loading menu…</div></div>';
    var note = nav.erp === 'unavailable'
      ? '<div class="sb-group"><div class="sb-group-title" role="status">Business modules unavailable — database not reachable</div></div>' : '';
    return note + nav.groups.map(function (group) {
      return '<div class="sb-group">' +
        '<div class="sb-group-title">' + esc(group.label) + '</div>' +
        group.items.map(function (it) {
          return '<a class="sb-link' + (it.id === activeId ? ' active' : '') + '" href="' + esc(it.path) + '"' +
            (it.id === activeId ? ' aria-current="page"' : '') + '>' +
            icon(it.icon) + '<span>' + esc(it.label) + '</span>' +
            (it.badge ? '<span class="sb-badge" data-badge="' + esc(it.badge) + '" style="display:none"></span>' : '') +
            '</a>';
        }).join('') +
        '</div>';
    }).join('');
  }

  /* The menu keeps its scroll position from page to page (each menu link opens a new page, which used to
     redraw the menu at the top). The position is saved when a link is clicked or the page is left, and put
     back after every redraw; the open page's link is always brought into view. */
  var NAV_SCROLL_KEY = 'soh_admin_nav_scroll';
  function saveNavScroll() {
    var el = document.getElementById('sbNav');
    if (el) { try { sessionStorage.setItem(NAV_SCROLL_KEY, String(el.scrollTop)); } catch (e) { /* storage blocked */ } }
  }
  function restoreNavScroll() {
    var el = document.getElementById('sbNav');
    if (!el) return;
    var saved = null;
    try { saved = sessionStorage.getItem(NAV_SCROLL_KEY); } catch (e) { /* storage blocked */ }
    if (saved !== null && !isNaN(+saved)) el.scrollTop = +saved;
    var a = el.querySelector('.sb-link.active');
    if (!a) return;
    var box = el.getBoundingClientRect(), r = a.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) el.scrollTop += (r.top - box.top) - (box.height - r.height) / 2;
  }
  function watchNavScroll() {
    var el = document.getElementById('sbNav');
    if (!el) return;
    el.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('a.sb-link')) saveNavScroll(); }, true);
    var t = null;
    el.addEventListener('scroll', function () { clearTimeout(t); t = setTimeout(saveNavScroll, 120); }, { passive: true });
    window.addEventListener('pagehide', saveNavScroll);
  }

  /** /admin: open the signed-in user's first permitted page. */
  async function goHome() {
    if (!Auth.require()) return;
    try { var nav = await fetchNav(); location.replace(nav.home || '/login'); }
    catch (e) { document.body.innerHTML = '<div class="login-wrap"><div class="login-card"><div class="alert alert-error">' + icon('alert') + '<span>' + esc(e.message) + ' — please reload.</span></div></div></div>'; }
  }

  function renderShell(activeId, title) {
    var user = Auth.user() || { name: 'Admin', email: '', role: 'admin' };
    var brand = (window.SOH_CONFIG && window.SOH_CONFIG.brand) || 'Sake of Health';


    return '' +
    '<div class="sb-backdrop" id="sbBackdrop"></div>' +
    '<aside class="sidebar" id="sidebar">' +
      '<div class="sb-head">' +
        '<div class="sb-logo">S</div>' +
        '<div class="sb-brand">' + esc(brand) + '<small>Admin</small></div>' +
      '</div>' +
      '<nav class="sb-nav" id="sbNav" aria-label="Admin menu">' + navHTML(cachedNav(), activeId) + '</nav>' +
      '<div class="sb-foot">' +
        '<div class="sb-user">' +
          '<div class="sb-avatar">' + esc(fmt.initials(user.name)) + '</div>' +
          '<div class="sb-user-info"><strong>' + esc(user.name) + '</strong><span>' + esc(user.role || 'Business staff') + '</span></div>' +
          '<button class="sb-logout" id="logoutBtn" title="Sign out">' + icon('logout') + '</button>' +
        '</div>' +
      '</div>' +
    '</aside>' +
    '<div class="main">' +
      '<header class="topbar">' +
        '<button class="hamburger" id="hamburger">' + icon('menu') + '</button>' +
        '<h1>' + esc(title) + '</h1>' +
        '<div class="spacer"></div>' +
        '<div id="topbarActions" class="flex items-center gap-8"></div>' +
      '</header>' +
      '<div class="content" id="content"></div>' +
    '</div>' +
    '<div class="toast-stack"></div>';
  }

  function initShell(activeId, title) {
    if (!Auth.require()) return false;
    // Staff with a B2B-only role have no B2C pages — send them to the B2B dashboard.
    var who = Auth.user() || {};
    // A page outside the user's menu sends them to their home page (the server
    // refuses the data anyway). Uses the cached menu when there is one…
    var cached = cachedNav();
    if (cached && cached.home && !navItems(cached).some(function (i) { return i.id === activeId; })) {
      location.replace(cached.home);
      return false;
    }
    // …and, before the first menu has loaded, the two fixed cases.
    if (!cached && B2B_ONLY_ROLES.indexOf(who.role) !== -1 && String(activeId).indexOf('b2b-') !== 0) {
      if (b2bEnabled()) location.replace('/admin/overview/trade');
      else { Auth.clear(); location.replace('/login'); }
      return false;
    }
    if (!cached && who.role === 'delivery' && activeId !== 'deliveries') {
      location.replace('/admin/sales/deliveries');
      return false;
    }
    document.body.className = 'shell';
    document.body.innerHTML = renderShell(activeId, title);
    restoreNavScroll();
    watchNavScroll();

    document.getElementById('logoutBtn').addEventListener('click', function () {
      if (confirm('Sign out of the admin panel?')) Auth.logout();
    });

    var sidebar = document.getElementById('sidebar');
    var backdrop = document.getElementById('sbBackdrop');
    document.getElementById('hamburger').addEventListener('click', function () {
      sidebar.classList.add('open');
      backdrop.classList.add('open');
    });
    backdrop.addEventListener('click', function () {
      sidebar.classList.remove('open');
      backdrop.classList.remove('open');
    });

    // Refresh the menu from the server (permissions may have changed).
    fetchNav().then(function (nav) {
      if (nav.home && !navItems(nav).some(function (i) { return i.id === activeId; })) { location.replace(nav.home); return; }
      var el = document.getElementById('sbNav');
      if (el) { el.innerHTML = navHTML(nav, activeId); restoreNavScroll(); }
      loadBadges();
    }).catch(function (e) {
      var el = document.getElementById('sbNav');
      if (el && !cached) el.innerHTML = '<div class="sb-group"><div class="sb-group-title">' + esc(e.message) + ' — reload the page</div></div>';
    });
    return true;
  }

  async function loadBadges() {
    var who = Auth.user() || {};
    if (!Auth.token()) return;   // ERP-only staff: the shop/trade counters are not theirs
    if (b2bEnabled() && who.role !== 'delivery') {
      try {
        var b = await api.get('/b2b/dashboard');
        setBadge('b2b-accounts', b.pendingApprovals.accounts);
        setBadge('b2b-orders', b.pendingApprovals.orders);
      } catch (e) { /* silent — no permission or database not ready */ }
    }
    if (B2B_ONLY_ROLES.indexOf(who.role) !== -1 || who.role === 'delivery') return;
    try {
      var d = await api.get('/dashboard');
      setBadge('pending', d.pendingAction);
    } catch (e) { /* silent */ }
    try {
      var r = await api.get('/reviews?status=pending');
      setBadge('reviews', r.stats.pending);
    } catch (e) { /* silent */ }
  }

  function setBadge(name, count) {
    document.querySelectorAll('[data-badge="' + name + '"]').forEach(function (el) {
      if (count > 0) { el.textContent = count > 99 ? '99+' : count; el.style.display = 'grid'; }
      else el.style.display = 'none';
    });
  }

  /* ─────────── Modal / drawer helpers ─────────── */
  function openPanel(el) {
    var overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.add('open');
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closePanel(el) {
    var overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.remove('open');
    if (el) el.classList.remove('open');
    else document.querySelectorAll('.modal.open,.drawer.open').forEach(function (p) { p.classList.remove('open'); });
    document.body.style.overflow = '';
  }

  function ensureOverlay() {
    if (document.getElementById('overlay')) return;
    var ov = document.createElement('div');
    ov.className = 'overlay';
    ov.id = 'overlay';
    ov.addEventListener('click', function () { closePanel(); });
    document.body.appendChild(ov);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });
  }

  /* ─────────── Empty state ─────────── */
  function emptyState(iconName, title, message) {
    return '<div class="empty">' + icon(iconName) +
      '<strong>' + esc(title) + '</strong><p>' + esc(message) + '</p></div>';
  }

  function loadingState() {
    return '<div class="loading"><div class="spinner dark"></div></div>';
  }

  /* ─────────── Simple SVG line chart ─────────── */
  function lineChart(series, opts) {
    opts = opts || {};
    var w = 800, h = opts.height || 240, pad = { t: 14, r: 14, b: 30, l: 52 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    if (!series.length) return '<div class="empty"><p>No data for this period</p></div>';

    var key = opts.key || 'revenue';
    var values = series.map(function (d) { return d[key]; });
    var max = Math.max.apply(null, values.concat([1]));
    max = Math.ceil(max * 1.15 / 10) * 10 || 10;

    var x = function (i) { return pad.l + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw); };
    var y = function (v) { return pad.t + ih - (v / max) * ih; };

    var line = series.map(function (d, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(d[key]).toFixed(1); }).join(' ');
    var area = line + ' L' + x(series.length - 1).toFixed(1) + ' ' + (pad.t + ih) + ' L' + x(0).toFixed(1) + ' ' + (pad.t + ih) + ' Z';

    var gridLines = '', labels = '';
    for (var g = 0; g <= 4; g++) {
      var gv = (max / 4) * g, gy = y(gv);
      gridLines += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (w - pad.r) + '" y2="' + gy.toFixed(1) +
        '" stroke="var(--line-2)" stroke-width="1"/>';
      labels += '<text x="' + (pad.l - 9) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end" ' +
        'font-size="11" fill="var(--ink-4)">' +
        (opts.money ? fmt.moneyShort(gv) : Math.round(gv)) + '</text>';
    }

    var step = Math.max(1, Math.ceil(series.length / 7));
    var xLabels = series.map(function (d, i) {
      if (i % step !== 0 && i !== series.length - 1) return '';
      var dt = new Date(d.date);
      return '<text x="' + x(i).toFixed(1) + '" y="' + (h - 9) + '" text-anchor="middle" ' +
        'font-size="11" fill="var(--ink-4)">' +
        dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + '</text>';
    }).join('');

    var dots = series.map(function (d, i) {
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(d[key]).toFixed(1) + '" r="3" ' +
        'fill="var(--surface)" stroke="var(--brand)" stroke-width="2"><title>' +
        esc(new Date(d.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })) + ': ' +
        (opts.money ? fmt.money(d[key]) : d[key]) + '</title></circle>';
    }).join('');

    return '<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">' +
      '<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="var(--brand)" stop-opacity=".22"/>' +
      '<stop offset="100%" stop-color="var(--brand)" stop-opacity="0"/></linearGradient></defs>' +
      gridLines + labels + xLabels +
      '<path d="' + area + '" fill="url(#cg)"/>' +
      '<path d="' + line + '" fill="none" stroke="var(--brand)" stroke-width="2.5" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>' + dots +
      '</svg></div>';
  }

  function barList(items, opts) {
    opts = opts || {};
    if (!items.length) return '<div class="empty"><p>' + esc(opts.emptyText || 'No data yet') + '</p></div>';
    var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));
    return '<div class="bar-list">' + items.map(function (i) {
      return '<div class="bar-item">' +
        '<div class="bl-name" title="' + esc(i.label) + '">' + esc(i.label) + '</div>' +
        '<div class="bl-value">' + esc(i.display != null ? i.display : i.value) + '</div>' +
        '<div class="bar-track"><div class="bar-fill' + (opts.color ? ' ' + opts.color : '') +
        '" style="width:' + ((i.value / max) * 100).toFixed(1) + '%"></div></div>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* ─────────── Exports ─────────── */
  window.Admin = {
    Auth: Auth, api: api, fmt: fmt, esc: esc, icon: icon, toast: toast,
    STATUS: STATUS, STATUS_FLOW: STATUS_FLOW, statusBadge: statusBadge,
    initShell: initShell, setBadge: setBadge, loadBadges: loadBadges, goHome: goHome, fetchNav: fetchNav,
    openPanel: openPanel, closePanel: closePanel, ensureOverlay: ensureOverlay,
    emptyState: emptyState, loadingState: loadingState,
    lineChart: lineChart, barList: barList,
  };
})();
