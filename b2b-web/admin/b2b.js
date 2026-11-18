/* ═══════════ B2B back office — shared runtime (builds on window.Admin) ═══════════ */
(function () {
  'use strict';
  var A = window.Admin;
  var esc = A.esc;
  var perms = [];

  /* ─────────── API ─────────── */
  function api(path, opts) { return A.api('/b2b' + path, opts); }
  api.get = function (p) { return api(p); };
  api.post = function (p, b) { return api(p, { method: 'POST', body: b || {} }); };
  api.patch = function (p, b) { return api(p, { method: 'PATCH', body: b || {} }); };
  api.put = function (p, b) { return api(p, { method: 'PUT', body: b || {} }); };
  api.del = function (p) { return api(p, { method: 'DELETE' }); };

  async function raw(path, opts) {
    opts = opts || {};
    var res = await fetch('/api/admin/b2b' + path, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + A.Auth.token() }, opts.headers || {}) }));
    if (res.status === 401) { A.Auth.clear(); location.replace('/admin/index.html?expired=1'); throw new Error('Session expired'); }
    return res;
  }
  /** multipart upload (the browser sets the boundary) */
  async function upload(path, formData) {
    var res = await raw(path, { method: 'POST', body: formData });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }
  /** Authenticated download: the token travels in a header, never in the URL. */
  async function download(path, fallbackName) {
    var res = await raw(path);
    if (!res.ok) { var d = await res.json().catch(function () { return {}; }); throw new Error(d.error || 'Download failed'); }
    var name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || fallbackName || 'download';
    var url = URL.createObjectURL(await res.blob());
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  /** Open a private file (KYC document) in a new tab. */
  async function openFile(path) {
    var w = window.open('', '_blank');
    try {
      var res = await raw(path);
      if (!res.ok) throw new Error('Could not open the file');
      var url = URL.createObjectURL(await res.blob());
      if (w) w.location = url; else location.href = url;
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    } catch (e) { if (w) w.close(); A.toast(e.message, 'error'); }
  }

  /* ─────────── Formatting ─────────── */
  var LABEL = { pending_admin_approval: 'Awaiting approval', under_review: 'Under review', out_for_delivery: 'Out for delivery', partially_delivered: 'Partly delivered',
    pickup_scheduled: 'Pickup scheduled', rolled_back: 'Rolled back', bank_transfer: 'Bank transfer', upi: 'UPI', gateway: 'Online', credit: 'Credit', credit_note: 'Credit note',
    in_transit: 'In transit', account_product: 'Customer + product', margin_pct: 'Margin %', fixed_price: 'Fixed price', discount_pct: 'Discount %', pincode_range: 'Pincode range' };
  function label(s) { if (s == null || s === '') return '—'; return LABEL[s] || String(s).replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function badge(s, extra) { return '<span class="badge badge-' + esc(s) + (extra ? ' ' + extra : '') + '">' + esc(label(s)) + '</span>'; }
  function money(v) { return '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function money0(v) { return '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  function date(d) { return d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function dateTime(d) { return d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true }) : '—'; }
  var FLAG = { gstin_state_mismatch: 'GSTIN state ≠ address state', gstin_pan_mismatch: 'GSTIN does not match PAN', no_gstin: 'No GSTIN', no_location: 'No map location',
    state_not_serviceable: 'State not yet serviceable', possible_duplicate_business: 'Possible duplicate business' };
  function flags(list) { return (list || []).map(function (f) { return '<span class="badge badge-flag no-dot">' + esc(FLAG[f] || f) + '</span>'; }).join('') || '<span class="muted">None</span>'; }
  function qs(obj) { var p = new URLSearchParams(); Object.keys(obj).forEach(function (k) { if (obj[k] !== '' && obj[k] != null && obj[k] !== false) p.set(k, obj[k] === true ? '1' : obj[k]); }); var s = p.toString(); return s ? '?' + s : ''; }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms || 300); }; }
  function can(p) { return perms.indexOf(p) !== -1; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ─────────── Building blocks ─────────── */

  /** cols: [{ label, cls, html: row => string }] — every html() must escape its own data. */
  function table(cols, rows, opts) {
    opts = opts || {};
    if (!rows || !rows.length) return A.emptyState(opts.icon || 'inbox', opts.emptyTitle || 'Nothing here yet', opts.emptyText || 'Try changing the filters or search term.');
    return '<div class="table-wrap"><table><thead><tr>' + cols.map(function (c) { return '<th class="' + (c.cls || '') + '">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r, i) {
        return '<tr' + (opts.rowAttr ? ' ' + opts.rowAttr(r, i) : '') + (opts.clickable ? ' class="clickable"' : '') + '>' +
          cols.map(function (c) { return '<td class="' + (c.cls || '') + '">' + c.html(r, i) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  function pager(d, noun) {
    if (!d || d.pages <= 1) return d && d.total ? '<div class="pagination"><span class="info">' + A.fmt.num(d.total) + ' ' + esc(noun || 'rows') + '</span></div>' : '';
    return '<div class="pagination"><span class="info">Page ' + d.page + ' of ' + d.pages + ' · ' + A.fmt.num(d.total) + ' ' + esc(noun || 'rows') + '</span><div class="spacer"></div>' +
      '<button class="btn btn-ghost btn-sm" data-page="' + (d.page - 1) + '"' + (d.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<button class="btn btn-ghost btn-sm" data-page="' + (d.page + 1) + '"' + (d.page >= d.pages ? ' disabled' : '') + '>Next</button></div>';
  }
  function tabsHtml(list, active, attr) {
    return '<div class="tabs wrap mb-16" style="overflow-x:auto">' + list.map(function (t) {
      return '<button class="tab' + (t.id === active ? ' active' : '') + '" data-' + (attr || 'tab') + '="' + esc(t.id) + '">' + esc(t.label) +
        (t.count ? ' <span class="badge badge-neutral no-dot" style="margin-left:4px">' + esc(t.count) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }
  function errorBox(e) { return '<div class="alert alert-error" style="margin:16px">' + A.icon('alert') + '<span>' + esc(e.message || e) + '</span></div>'; }
  function field(id, labelText, inner, hint, cls) {
    return '<div class="field' + (cls ? ' ' + cls : '') + '"><label for="' + id + '">' + esc(labelText) + '</label>' + inner + (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '</div>';
  }
  function input(id, value, attrs) { return '<input class="input" id="' + id + '" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + '/>'; }
  function select(id, options, value, attrs) {
    return '<select class="select" id="' + id + '" ' + (attrs || '') + '>' + options.map(function (o) {
      var v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : label(o);
      return '<option value="' + esc(v) + '"' + (String(v) === String(value == null ? '' : value) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('') + '</select>';
  }
  function val(id) { var el = document.getElementById(id); if (!el) return undefined; return el.type === 'checkbox' ? el.checked : el.value.trim(); }

  /* ─────────── Drawer + modal (one of each per page) ─────────── */
  function ensurePanels() {
    A.ensureOverlay();
    if (!document.getElementById('b2bDrawer')) {
      var d = document.createElement('aside'); d.className = 'drawer'; d.id = 'b2bDrawer';
      d.innerHTML = '<div class="drawer-head"><h2 id="b2bDrawerTitle"></h2><div class="spacer"></div><button class="close-btn" id="b2bDrawerClose">' + A.icon('close') + '</button></div><div class="drawer-body" id="b2bDrawerBody"></div>';
      document.body.appendChild(d);
      var m = document.createElement('div'); m.className = 'modal'; m.id = 'b2bModal';
      m.innerHTML = '<form id="b2bModalForm" novalidate><div class="modal-head"><h2 id="b2bModalTitle"></h2><div class="spacer"></div><button type="button" class="close-btn" id="b2bModalClose">' + A.icon('close') + '</button></div>' +
        '<div class="modal-body"><div id="b2bModalAlert"></div><div id="b2bModalBody"></div></div><div class="modal-foot"><button type="button" class="btn btn-ghost" id="b2bModalCancel">Cancel</button>' +
        '<button type="submit" class="btn btn-primary" id="b2bModalSubmit">Save</button></div></form>';
      document.body.appendChild(m);
      document.getElementById('b2bDrawerClose').addEventListener('click', function () { A.closePanel(); });
      document.getElementById('b2bModalClose').addEventListener('click', closeModal);
      document.getElementById('b2bModalCancel').addEventListener('click', closeModal);
    }
  }
  function drawer(title, html) {
    ensurePanels();
    document.getElementById('b2bDrawerTitle').textContent = title;
    var body = document.getElementById('b2bDrawerBody');
    body.innerHTML = html == null ? A.loadingState() : html;
    var el = document.getElementById('b2bDrawer');
    if (!el.classList.contains('open')) A.openPanel(el);
    return body;
  }
  var modalWasDrawer = false;
  function closeModal() {
    var m = document.getElementById('b2bModal');
    m.classList.remove('open');
    if (!modalWasDrawer) A.closePanel(); // keep the overlay if a drawer is still open underneath
  }
  /** opts: { title, body (html), submit (label), danger, wide, onSubmit: async () => {…} — throw to show an error } */
  function modal(opts) {
    ensurePanels();
    var m = document.getElementById('b2bModal'), form = document.getElementById('b2bModalForm');
    modalWasDrawer = document.getElementById('b2bDrawer').classList.contains('open');
    m.className = 'modal' + (opts.wide ? ' wide' : '');
    m.style.zIndex = 1200;
    document.getElementById('b2bModalTitle').textContent = opts.title;
    document.getElementById('b2bModalBody').innerHTML = opts.body || '';
    document.getElementById('b2bModalAlert').innerHTML = '';
    var btn = document.getElementById('b2bModalSubmit');
    btn.textContent = opts.submit || 'Save'; btn.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'); btn.disabled = false;
    btn.style.display = opts.onSubmit ? '' : 'none';
    document.getElementById('b2bModalCancel').textContent = opts.onSubmit ? 'Cancel' : 'Close';
    form.onsubmit = async function (e) {
      e.preventDefault();
      if (!opts.onSubmit) return;
      btn.disabled = true; var old = btn.textContent; btn.innerHTML = '<span class="spinner"></span> Working…';
      try { var keep = await opts.onSubmit(); if (keep !== false) closeModal(); }
      catch (err) { document.getElementById('b2bModalAlert').innerHTML = '<div class="alert alert-error">' + A.icon('alert') + '<span>' + esc(err.message) + '</span></div>'; }
      btn.disabled = false; btn.textContent = old;
    };
    document.getElementById('overlay').classList.add('open');
    m.classList.add('open');
    var first = m.querySelector('input:not([type=hidden]),select,textarea'); if (first) setTimeout(function () { first.focus(); }, 60);
  }
  /** Ask for a reason, then run fn(reason). */
  function askReason(title, text, opts, fn) {
    opts = opts || {};
    modal({ title: title, submit: opts.submit || 'Confirm', danger: opts.danger,
      body: (text ? '<p class="mb-16" style="line-height:1.55">' + esc(text) + '</p>' : '') +
        field('b2bReason', opts.label || 'Reason', '<textarea class="textarea" id="b2bReason" maxlength="400" placeholder="' + esc(opts.placeholder || '') + '"></textarea>', opts.optional ? 'Optional' : 'Recorded in the audit log.'),
      onSubmit: function () { return fn(val('b2bReason')); } });
  }

  /* ─────────── Page bootstrap ─────────── */
  async function init(activeId, title, anyOf) {
    if (!A.initShell(activeId, title)) return false;
    var content = document.getElementById('content');
    content.innerHTML = A.loadingState();
    try {
      var me = await api.get('/me');
      perms = me.permissions || [];
    } catch (e) {
      content.innerHTML = errorBox(e);
      return false;
    }
    if (anyOf && !anyOf.some(can)) {
      content.innerHTML = '<div class="alert alert-warn">' + A.icon('alert') + '<span>Your role does not have access to this section. Ask an administrator if you need it.</span></div>';
      return false;
    }
    ensurePanels();
    return true;
  }
  /** Wrap a page load: shows database / schema problems with a pointer to the System tab. */
  function fail(host, e) {
    var schema = /database has not been set up|temporarily unavailable/i.test(e.message);
    host.innerHTML = '<div class="alert alert-' + (schema ? 'warn' : 'error') + '" style="margin:16px">' + A.icon('alert') + '<span>' + esc(e.message) +
      (schema ? ' <a href="/admin/b2b/settings.html?tab=system" style="text-decoration:underline;font-weight:600">Open Settings → System</a>' : '') + '</span></div>';
  }

  window.B2B = { api: api, upload: upload, download: download, openFile: openFile, can: can, init: init, fail: fail,
    label: label, badge: badge, money: money, money0: money0, date: date, dateTime: dateTime, flags: flags, qs: qs, debounce: debounce, $: $, $$: $$,
    table: table, pager: pager, tabsHtml: tabsHtml, errorBox: errorBox, field: field, input: input, select: select, val: val,
    drawer: drawer, modal: modal, closeModal: closeModal, askReason: askReason, esc: esc, perms: function () { return perms; } };
})();
