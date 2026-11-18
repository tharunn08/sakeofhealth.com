(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-inventory', 'Inventory', ['b2b.inventory.view']))) return;
  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var canEdit = B.can('b2b.inventory.edit');
  var state = { tab: params.get('tab') || 'stock', q: '', warehouse_id: '', low: params.get('low') === '1', owner: 'company', type: '', within: params.get('expired') === '1' ? 'expired' : '90', page: 1, warehouses: [] };
  var OPS = [['purchase', 'Purchase received'], ['production', 'Production received'], ['opening', 'Opening stock'], ['adjust_increase', 'Adjustment (+)'], ['adjust_decrease', 'Adjustment (−)'], ['damage', 'Damaged'], ['expiry', 'Expired / written off']];

  function whOptions(all) {
    var list = state.warehouses.filter(function (w) { return state.owner === 'all' || w.owner_account_id == null; });
    return (all ? [{ value: '', label: 'All warehouses' }] : []).concat(list.map(function (w) { return { value: w.id, label: w.code + ' — ' + w.name }; }));
  }
  function topbar() {
    document.getElementById('topbarActions').innerHTML =
      '<button class="btn btn-ghost btn-sm" id="expBtn">' + A.icon('download') + '<span class="hide-sm">Export</span></button>' +
      (canEdit ? (state.tab === 'warehouses' ? '<button class="btn btn-primary btn-sm" id="addWh">' + A.icon('plus') + 'Add warehouse</button>' : '<button class="btn btn-primary btn-sm" id="entryBtn">' + A.icon('plus') + 'Stock entry</button>') : '');
    B.$('#expBtn').addEventListener('click', function () { B.download('/export/' + (state.tab === 'movements' ? 'movements' : 'inventory') + '?format=xlsx').catch(function (e) { A.toast(e.message, 'error'); }); });
    if (B.$('#entryBtn')) B.$('#entryBtn').addEventListener('click', function () { entry({}); });
    if (B.$('#addWh')) B.$('#addWh').addEventListener('click', function () { whForm(null); });
  }

  function shell() {
    topbar();
    var t = state.tab;
    content.innerHTML = B.tabsHtml([{ id: 'stock', label: 'Stock' }, { id: 'low', label: 'Low stock' }, { id: 'expiry', label: 'Batches & expiry' }, { id: 'movements', label: 'Movements' }, { id: 'warehouses', label: 'Warehouses' }], t) +
      (t === 'warehouses' ? '' : '<div class="b2b-filters"><div class="search-box">' + A.icon('search') + '<input class="input" id="q" placeholder="Search SKU, product' + (t === 'expiry' ? ', batch' : '') + '…" value="' + esc(state.q) + '"/></div>' +
        B.select('fWh', whOptions(true), state.warehouse_id) +
        (t === 'expiry' ? B.select('fWithin', [{ value: '30', label: 'Expiring within 30 days' }, { value: '60', label: 'Within 60 days' }, { value: '90', label: 'Within 90 days' }, { value: 'expired', label: 'Already expired' }, { value: 'all', label: 'All batches' }], state.within) : '') +
        (t === 'movements' ? B.select('fType', [{ value: '', label: 'All movements' }].concat(['opening', 'purchase', 'production', 'reservation', 'release', 'allocation', 'deallocation', 'dispatch', 'delivery', 'damage', 'expiry', 'adjustment', 'return', 'transfer_in', 'transfer_out']), state.type) : '') +
        (t === 'stock' ? B.select('fOwner', [{ value: 'company', label: 'Company warehouses' }, { value: 'all', label: 'Company + distributor stock' }], state.owner) : '') + '</div>') +
      (t === 'expiry' ? '<div id="expSummary"></div>' : '') +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; state.page = 1; shell(); load(); }); });
    if (B.$('#q')) B.$('#q').addEventListener('input', B.debounce(function () { state.q = B.$('#q').value.trim(); state.page = 1; load(); }));
    [['fWh', 'warehouse_id'], ['fWithin', 'within'], ['fType', 'type'], ['fOwner', 'owner']].forEach(function (p) {
      var el = B.$('#' + p[0]); if (el) el.addEventListener('change', function () { state[p[1]] = el.value; state.page = 1; if (p[1] === 'owner') { state.warehouse_id = ''; shell(); } load(); });
    });
  }

  var qty = function (n, warn) { return '<span' + (warn ? ' style="color:var(--red);font-weight:600"' : '') + '>' + A.fmt.num(n) + '</span>'; };

  async function load() {
    var host = B.$('#host'), t = state.tab;
    try {
      if (t === 'warehouses') return warehouses(host);
      var base = { q: state.q, warehouse_id: state.warehouse_id, page: state.page, limit: 25, owner: state.owner };
      var d;
      if (t === 'stock' || t === 'low') {
        d = await B.api.get('/stock' + B.qs(Object.assign(base, { low: t === 'low', owner: t === 'low' ? 'company' : state.owner })));
        host.innerHTML = B.table([
          { label: 'Product', html: function (r) { return '<span class="td-strong">' + esc(r.name) + '</span><div class="td-muted td-mono">' + esc(r.sku) + (r.pack_size ? ' · ' + esc(r.pack_size) : '') + '</div>'; } },
          { label: 'Warehouse', cls: 'hide-sm td-mono', html: function (r) { return esc(r.warehouse_code); } },
          { label: 'Available', cls: 'num', html: function (r) { return qty(r.qty_available, Number(r.low_stock_threshold) && r.qty_available <= Number(r.low_stock_threshold)) + (Number(r.low_stock_threshold) ? '<div class="td-muted small">alert at ' + r.low_stock_threshold + '</div>' : ''); } },
          { label: 'Reserved', cls: 'num', html: function (r) { return qty(r.qty_reserved); } },
          { label: 'Allocated', cls: 'num hide-sm', html: function (r) { return qty(r.qty_allocated); } },
          { label: 'In transit', cls: 'num hide-sm', html: function (r) { return qty(r.qty_in_transit); } },
          { label: 'Damaged', cls: 'num hide-sm', html: function (r) { return qty(r.qty_damaged); } },
          { label: 'Expired', cls: 'num hide-sm', html: function (r) { return qty(r.qty_expired); } },
          { label: '', html: function (r) { return canEdit ? '<button class="btn btn-ghost btn-sm" data-entry="' + r.product_id + '|' + r.warehouse_id + '|' + esc(r.sku + ' — ' + r.name) + '">Adjust</button>' : ''; } },
        ], d.items, { icon: 'box', emptyTitle: t === 'low' ? 'Nothing is low on stock' : 'No stock recorded yet', emptyText: t === 'low' ? 'Products at or below their low-stock threshold appear here.' : 'Use “Stock entry” or an Excel import with Opening Stock.' }) + B.pager(d, 'rows');
        host.querySelectorAll('[data-entry]').forEach(function (b) { b.addEventListener('click', function () { var p = b.dataset.entry.split('|'); entry({ product_id: p[0], warehouse_id: p[1], label: p.slice(2).join('|') }); }); });
      } else if (t === 'expiry') {
        var q = Object.assign(base, { owner: 'company' });
        if (state.within === 'expired') q.expired = true; else if (state.within !== 'all') q.within = state.within;
        d = await B.api.get('/stock/batches' + B.qs(q));
        var s = d.summary;
        B.$('#expSummary').innerHTML = '<div class="stat-grid"><div class="stat ' + (s.expired ? 'red' : '') + '"><div class="stat-label">Expired on hand</div><div class="stat-value">' + s.expired + '</div></div>' +
          '<div class="stat ' + (s.within30 ? 'amber' : '') + '"><div class="stat-label">Within 30 days</div><div class="stat-value">' + s.within30 + '</div></div>' +
          '<div class="stat"><div class="stat-label">31 – 60 days</div><div class="stat-value">' + s.within60 + '</div></div><div class="stat"><div class="stat-label">61 – 90 days</div><div class="stat-value">' + s.within90 + '</div></div></div>';
        host.innerHTML = B.table([
          { label: 'Product', html: function (r) { return '<span class="td-strong">' + esc(r.name) + '</span><div class="td-muted td-mono">' + esc(r.sku) + '</div>'; } },
          { label: 'Batch', cls: 'td-mono', html: function (r) { return esc(r.batch_no); } },
          { label: 'Warehouse', cls: 'hide-sm td-mono', html: function (r) { return esc(r.warehouse_code); } },
          { label: 'Mfg', cls: 'hide-sm', html: function (r) { return esc(B.date(r.mfg_date)); } },
          { label: 'Expiry', html: function (r) { return esc(B.date(r.expiry_date)); } },
          { label: 'Days left', cls: 'num', html: function (r) { return r.days_left == null ? '—' : '<span style="font-weight:600;color:' + (r.days_left <= 0 ? 'var(--red)' : r.days_left <= 30 ? 'var(--amber)' : 'inherit') + '">' + r.days_left + '</span>'; } },
          { label: 'On hand', cls: 'num', html: function (r) { return A.fmt.num(r.qty_on_hand); } },
          { label: '', html: function (r) { return canEdit && r.days_left != null && r.days_left <= 0 ? '<button class="btn btn-danger-ghost btn-sm" data-wo="' + r.id + '|' + r.product_id + '|' + r.warehouse_id + '|' + r.qty_on_hand + '">Write off</button>' : ''; } },
        ], d.items, { icon: 'clock', emptyTitle: 'No batches in this window', emptyText: 'Stock is picked First-Expiry-First-Out automatically when orders are packed.' }) + B.pager(d, 'batches');
        host.querySelectorAll('[data-wo]').forEach(function (b) { b.addEventListener('click', async function () {
          var p = b.dataset.wo.split('|');
          if (!confirm('Write off ' + p[3] + ' expired unit(s) from this batch?')) return;
          try { await B.api.post('/stock/entry', { operation: 'expiry', batch_id: p[0], product_id: p[1], warehouse_id: p[2], qty: p[3], reason: 'Batch expired' }); A.toast('Written off', 'success'); load(); }
          catch (e) { A.toast(e.message, 'error'); } }); });
      } else {
        d = await B.api.get('/stock/movements' + B.qs(Object.assign(base, { type: state.type, owner: 'all' })));
        host.innerHTML = B.table([
          { label: 'When', cls: 'td-nowrap', html: function (r) { return esc(B.dateTime(r.created_at)); } },
          { label: 'Product', html: function (r) { return '<span class="td-mono">' + esc(r.sku) + '</span><div class="td-muted">' + esc(r.name) + '</div>'; } },
          { label: 'Warehouse', cls: 'hide-sm td-mono', html: function (r) { return esc(r.warehouse_code); } },
          { label: 'Movement', html: function (r) { return '<span class="td-strong">' + esc(B.label(r.movement_type)) + '</span><div class="td-muted small">' + esc(r.from_status ? B.label(r.from_status) : 'in') + ' → ' + esc(r.to_status ? B.label(r.to_status) : 'out') + (r.batch_no ? ' · batch ' + esc(r.batch_no) : '') + '</div>'; } },
          { label: 'Qty', cls: 'num td-strong', html: function (r) { return A.fmt.num(r.qty); } },
          { label: 'Reference', cls: 'hide-sm', html: function (r) { return r.ref_type === 'order' ? '<a href="orders.html?open=' + r.ref_id + '" style="text-decoration:underline">Order #' + r.ref_id + '</a>' : esc(r.ref_type ? B.label(r.ref_type) + (r.ref_id ? ' #' + r.ref_id : '') : '—'); } },
          { label: 'Reason / user', cls: 'hide-sm', html: function (r) { return esc(r.reason || '') + '<div class="td-muted">' + esc(r.actor_label || r.actor_type) + '</div>'; } },
        ], d.items, { icon: 'box', emptyTitle: 'No stock movements yet', emptyText: 'Every change to stock is recorded here and can never be edited.' }) + B.pager(d, 'movements');
      }
      host.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); load(); }); });
    } catch (e) { B.fail(host, e); }
  }

  function warehouses(host) {
    host.innerHTML = B.table([
      { label: 'Warehouse', html: function (w) { return '<span class="td-strong">' + esc(w.name) + '</span><div class="td-muted td-mono">' + esc(w.code) + '</div>'; } },
      { label: 'Owner', html: function (w) { return w.owner_account_id == null ? B.badge('company', 'no-dot') : B.badge('distributor', 'no-dot') + ' ' + esc(w.owner_name || ''); } },
      { label: 'Location', cls: 'hide-sm', html: function (w) { return esc([w.city, w.state_name, w.pincode].filter(Boolean).join(', ') || '—'); } },
      { label: 'SKUs in stock', cls: 'num', html: function (w) { return A.fmt.num(w.skus_in_stock); } },
      { label: 'Units available', cls: 'num', html: function (w) { return A.fmt.num(w.units_available); } },
      { label: 'Priority', cls: 'num hide-sm', html: function (w) { return esc(w.priority); } },
      { label: '', html: function (w) { return (Number(w.is_active) ? '' : B.badge('inactive') + ' ') + (canEdit && w.owner_account_id == null ? '<button class="btn btn-ghost btn-sm" data-wh="' + w.id + '">Edit</button>' : ''); } },
    ], state.warehouses, { icon: 'box', emptyTitle: 'No warehouses' }) +
      '<div class="td-muted small" style="padding:12px 16px">Orders are fulfilled from the highest-priority company warehouse that can cover the whole order. Each approved distributor also has its own stock point, credited automatically when their orders are delivered.</div>';
    host.querySelectorAll('[data-wh]').forEach(function (b) { b.addEventListener('click', function () { whForm(state.warehouses.filter(function (w) { return String(w.id) === b.dataset.wh; })[0]); }); });
  }
  async function whForm(w) {
    var isNew = !w; w = w || { priority: 0, is_active: 1 };
    var states = (await B.api.get('/geo/states')).states;
    B.modal({ title: isNew ? 'Add warehouse' : 'Edit warehouse', body: '<div class="form-grid">' +
      B.field('w_code', 'Code', B.input('w_code', w.code, 'maxlength="30" style="text-transform:uppercase" placeholder="MYS-01"')) + B.field('w_name', 'Name', B.input('w_name', w.name)) +
      B.field('w_state', 'State', B.select('w_state', [{ value: '', label: '—' }].concat(states.map(function (s) { return { value: s.id, label: s.name }; })), w.state_id)) +
      B.field('w_city', 'City', B.input('w_city', w.city)) + B.field('w_pincode', 'Pincode', B.input('w_pincode', w.pincode, 'maxlength="6"')) +
      B.field('w_priority', 'Priority', B.input('w_priority', w.priority, 'inputmode="numeric"'), 'Higher is tried first') +
      B.field('w_address', 'Address', B.input('w_address', w.address), '', 'wide') +
      '<div class="field wide"><label class="checkbox"><input type="checkbox" id="w_active"' + (Number(w.is_active) ? ' checked' : '') + '/><span>Active</span></label></div></div>',
      onSubmit: async function () {
        var b = { code: B.val('w_code'), name: B.val('w_name'), state_id: B.val('w_state'), city: B.val('w_city'), pincode: B.val('w_pincode'), priority: B.val('w_priority'), address: B.val('w_address'), is_active: B.val('w_active') };
        if (isNew) await B.api.post('/warehouses', b); else await B.api.patch('/warehouses/' + w.id, b);
        A.toast('Warehouse saved', 'success'); state.warehouses = (await B.api.get('/warehouses')).warehouses; load();
      } });
  }

  function entry(pre) {
    B.modal({ title: 'Stock entry', submit: 'Post to ledger', wide: true, body: '<div class="form-grid">' +
      B.field('e_op', 'What happened', B.select('e_op', OPS.map(function (o) { return { value: o[0], label: o[1] }; }), pre.product_id ? 'adjust_increase' : 'purchase')) +
      B.field('e_wh', 'Warehouse', B.select('e_wh', state.warehouses.filter(function (w) { return w.owner_account_id == null && Number(w.is_active); }).map(function (w) { return { value: w.id, label: w.code + ' — ' + w.name }; }), pre.warehouse_id)) +
      '<div class="field wide"><label for="e_pq">Product</label><input class="input" id="e_pq" autocomplete="off" placeholder="Type SKU or name…" value="' + esc(pre.label || '') + '"/><input type="hidden" id="e_pid" value="' + esc(pre.product_id || '') + '"/><div id="e_res" class="chips" style="margin-top:6px"></div></div>' +
      B.field('e_qty', 'Quantity (units)', B.input('e_qty', '', 'inputmode="numeric"')) +
      '<div id="e_batchWrap" class="wide form-grid" style="grid-column:1/-1">' + B.field('e_batch', 'Batch number', B.input('e_batch', '', 'maxlength="60"'), 'Optional but recommended — enables expiry tracking and FEFO picking') +
        B.field('e_mfg', 'Manufactured', B.input('e_mfg', '', 'type="date"')) + B.field('e_exp', 'Expiry', B.input('e_exp', '', 'type="date"')) + '</div>' +
      B.field('e_reason', 'Reason / reference', B.input('e_reason', '', 'maxlength="250" placeholder="e.g. GRN 1042, stock count"'), 'Required for adjustments, damage and write-offs', 'wide') + '</div>',
      onSubmit: async function () {
        if (!B.val('e_pid')) throw new Error('Choose a product from the search results');
        var r = await B.api.post('/stock/entry', { operation: B.val('e_op'), warehouse_id: B.val('e_wh'), product_id: B.val('e_pid'), qty: B.val('e_qty'), batch_no: B.val('e_batch'), mfg_date: B.val('e_mfg'), expiry_date: B.val('e_exp'), reason: B.val('e_reason') });
        A.toast('Posted — ' + A.fmt.num(r.qty_available) + ' now available', 'success'); load();
      } });
    var sync = function () { B.$('#e_batchWrap').style.display = ['adjust_decrease', 'damage', 'expiry'].indexOf(B.val('e_op')) === -1 ? '' : 'none'; };
    B.$('#e_op').addEventListener('change', sync); sync();
    B.$('#e_pq').addEventListener('input', B.debounce(async function () {
      B.$('#e_pid').value = '';
      var t = B.$('#e_pq').value.trim(); if (t.length < 2) { B.$('#e_res').innerHTML = ''; return; }
      try {
        var items = (await B.api.get('/products?limit=6&q=' + encodeURIComponent(t))).items;
        B.$('#e_res').innerHTML = items.map(function (p) { return '<button type="button" class="chip" style="cursor:pointer" data-pick="' + p.id + '" data-label="' + esc(p.sku + ' — ' + p.name) + '">' + esc(p.sku + ' — ' + p.name) + '</button>'; }).join('') || '<span class="muted small">No match</span>';
        B.$$('#e_res [data-pick]').forEach(function (b) { b.addEventListener('click', function () { B.$('#e_pid').value = b.dataset.pick; B.$('#e_pq').value = b.dataset.label; B.$('#e_res').innerHTML = ''; }); });
      } catch (e) { /* ignore */ }
    }, 250));
  }

  try { state.warehouses = (await B.api.get('/warehouses')).warehouses; } catch (e) { B.fail(content, e); return; }
  shell(); load();
})();
