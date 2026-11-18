(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-network', 'Distribution Network', ['b2b.network.view']))) return;
  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var canEdit = B.can('b2b.network.edit');
  var state = { tab: params.get('distributor') ? 'areas' : (params.get('tab') || 'mapping'), q: '', page: 1, distributor: params.get('distributor') || '', distributors: [], states: [], selected: {}, filter: 'all' };

  function distOptions(placeholder) {
    return [{ value: '', label: placeholder }].concat(state.distributors.map(function (d) { return { value: d.id, label: d.business_name + ' — ' + d.city }; }));
  }
  function areaText(s) {
    return s.area_type === 'pincode' ? s.pincode_from : s.area_type === 'pincode_range' ? s.pincode_from + '–' + s.pincode_to : s.area_type === 'city' ? s.city + ' (city)' : s.area_type === 'district' ? s.district_name + ' district' : s.state_name + ' (whole state)';
  }

  function shell() {
    content.innerHTML = B.tabsHtml([{ id: 'mapping', label: 'Retailer mapping' }, { id: 'areas', label: 'Service areas' }, { id: 'distributors', label: 'Distributor overview' }], state.tab) + '<div id="pane"></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; state.page = 1; state.selected = {}; shell(); }); });
    ({ mapping: mapping, areas: areas, distributors: overview })[state.tab](B.$('#pane'));
  }

  /* ═════ Retailer mapping (with bulk remap) ═════ */
  function mapping(pane) {
    pane.innerHTML = '<div class="b2b-filters"><div class="search-box">' + A.icon('search') + '<input class="input" id="q" placeholder="Search retailer, shop, phone, pincode, city…" value="' + esc(state.q) + '"/></div>' +
      B.select('fMap', [{ value: 'all', label: 'All approved retailers' }, { value: 'unmapped', label: 'Unmapped only' }].concat(state.distributors.map(function (d) { return { value: d.id, label: 'Mapped to ' + d.business_name }; })), state.filter) + '</div>' +
      (canEdit ? '<div class="card mb-16" id="bulkBar" style="display:none"><div class="card-body" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><strong id="selCount"></strong>' +
        B.select('bulkTo', distOptions('Move to…').concat([{ value: 'none', label: 'Remove distributor (supply directly)' }]), '', 'style="width:auto;min-width:240px"') +
        '<button class="btn btn-primary btn-sm" id="bulkGo">Remap selected</button></div></div>' : '') +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>';
    var load = async function () {
      var host = B.$('#host');
      try {
        var q = { type: 'retailer', status: 'approved', q: state.q, page: state.page, limit: 50 };
        if (state.filter === 'unmapped') q.unmapped = true; else if (state.filter !== 'all') q.distributor_id = state.filter;
        var d = await B.api.get('/accounts' + B.qs(q));
        host.innerHTML = B.table([
          { label: '', html: function (r) { return canEdit ? '<input type="checkbox" data-sel="' + r.id + '"' + (state.selected[r.id] ? ' checked' : '') + ' aria-label="Select"/>' : ''; } },
          { label: 'Retailer', html: function (r) { return '<a class="td-strong" href="accounts.html?open=' + r.id + '">' + esc(r.shop_name || r.business_name) + '</a><div class="td-muted">' + esc(r.contact_person) + ' · ' + esc(A.fmt.phone(r.mobile)) + '</div>'; } },
          { label: 'Location', html: function (r) { return esc(r.city) + ' · <span class="td-mono">' + esc(r.pincode) + '</span><div class="td-muted">' + esc(r.district_name) + ', ' + esc(r.state_name) + '</div>'; } },
          { label: 'Distributor', html: function (r) { return r.distributor_name ? esc(r.distributor_name) + (r.mapping_status === 'suspended' ? ' ' + B.badge('suspended') : '') : '<span class="badge badge-unpaid no-dot">Unmapped</span>'; } },
          { label: '', html: function (r) { return canEdit ? '<a class="btn btn-ghost btn-sm" href="accounts.html?open=' + r.id + '">Change</a>' : ''; } },
        ], d.items, { icon: 'network', emptyTitle: 'No retailers found' }) + B.pager(d, 'retailers');
        host.querySelectorAll('[data-sel]').forEach(function (c) { c.addEventListener('change', function () { state.selected[c.dataset.sel] = c.checked; sync(); }); });
        host.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); load(); }); });
      } catch (e) { B.fail(host, e); }
    };
    var sync = function () {
      var n = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).length, bar = B.$('#bulkBar');
      if (bar) { bar.style.display = n ? '' : 'none'; B.$('#selCount').textContent = n + ' selected'; }
    };
    B.$('#q').addEventListener('input', B.debounce(function () { state.q = B.$('#q').value.trim(); state.page = 1; load(); }));
    B.$('#fMap').addEventListener('change', function () { state.filter = B.$('#fMap').value; state.page = 1; state.selected = {}; sync(); load(); });
    if (B.$('#bulkGo')) B.$('#bulkGo').addEventListener('click', function () {
      var to = B.val('bulkTo'), ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).map(Number);
      if (!to) return A.toast('Choose where to move them', 'error');
      B.askReason('Remap ' + ids.length + ' retailer(s)', 'Each change is recorded in the mapping history. Orders already assigned stay with their current distributor.', { submit: 'Remap' }, async function (reason) {
        var r = await B.api.post('/mapping/bulk', { retailer_ids: ids, distributor_id: to === 'none' ? null : Number(to), reason: reason });
        A.toast(r.changed + ' of ' + r.requested + ' remapped', 'success'); state.selected = {}; sync(); load();
      });
    });
    load();
  }

  /* ═════ Service areas ═════ */
  function areas(pane) {
    pane.innerHTML = '<div class="b2b-filters">' + B.select('dPick', distOptions('Choose a distributor…'), state.distributor, 'style="min-width:300px"') + '</div><div id="aHost"></div>';
    B.$('#dPick').addEventListener('change', function () { state.distributor = B.$('#dPick').value; load(); });
    var load = async function () {
      var host = B.$('#aHost');
      if (!state.distributor) { host.innerHTML = '<div class="card"><div class="card-body">' + A.emptyState('map', 'Choose a distributor', 'Service areas decide which retailers a distributor can be mapped to: pincode beats pincode range, then city, district and state.') + '</div></div>'; return; }
      host.innerHTML = A.loadingState();
      try {
        var list = (await B.api.get('/distributors/' + state.distributor + '/service-areas')).areas;
        var groups = { pincode: [], pincode_range: [], city: [], district: [], state: [] };
        list.forEach(function (s) { groups[s.area_type].push(s); });
        var kState = (state.distributors.filter(function (d) { return String(d.id) === String(state.distributor); })[0] || {}).state_id;
        host.innerHTML = '<div class="grid-2"><div class="card"><div class="card-head"><h2>Current service areas</h2></div><div class="card-body">' +
          (list.length ? ['pincode', 'pincode_range', 'city', 'district', 'state'].filter(function (t) { return groups[t].length; }).map(function (t) {
            return '<div class="detail-title">' + esc(B.label(t)) + ' (' + groups[t].length + ')</div><div class="chips mb-16">' + groups[t].map(function (s) {
              return '<span class="chip' + (Number(s.is_active) ? '' : ' off') + '">' + esc(areaText(s)) + (canEdit ? '<button type="button" title="' + (Number(s.is_active) ? 'Disable' : 'Enable') + '" data-toggle="' + s.id + '" data-on="' + (Number(s.is_active) ? 0 : 1) + '">' + (Number(s.is_active) ? '×' : '↺') + '</button>' : '') + '</span>'; }).join('') + '</div>'; }).join('')
            : '<div class="td-muted">No service areas yet — this distributor will not be matched to any retailer.</div>') + '</div></div>' +
          (canEdit ? '<div class="card"><div class="card-head"><h2>Add service area</h2></div><div class="card-body">' +
            B.field('aType', 'Type', B.select('aType', [{ value: 'pincodes', label: 'Pincodes (paste a list)' }, { value: 'pincode_range', label: 'Pincode range' }, { value: 'city', label: 'City' }, { value: 'district', label: 'District' }, { value: 'state', label: 'Whole state' }], 'pincodes')) +
            B.field('aState', 'State', B.select('aState', state.states.map(function (s) { return { value: s.id, label: s.name }; }), kState)) +
            '<div id="aFields"></div>' + B.field('aPrio', 'Priority (optional)', B.input('aPrio', 0, 'inputmode="numeric"'), 'When two distributors cover the same area at the same level, the higher priority wins.') +
            '<button class="btn btn-primary" id="aAdd">Add</button></div></div>' : '') + '</div>';
        host.querySelectorAll('[data-toggle]').forEach(function (b) { b.addEventListener('click', async function () {
          try { await B.api.post('/service-areas/' + b.dataset.toggle + '/active', { active: b.dataset.on === '1' }); load(); } catch (e) { A.toast(e.message, 'error'); } }); });
        if (!canEdit) return;
        var fields = async function () {
          var t = B.val('aType'), f = B.$('#aFields');
          if (t === 'pincodes') f.innerHTML = B.field('aPins', 'Pincodes', '<textarea class="textarea" id="aPins" placeholder="560001, 560002, 560003 …"></textarea>', 'Separate with commas, spaces or new lines.');
          else if (t === 'pincode_range') f.innerHTML = '<div class="field-row">' + B.field('aFrom', 'From pincode', B.input('aFrom', '', 'maxlength="6" inputmode="numeric"')) + B.field('aTo', 'To pincode', B.input('aTo', '', 'maxlength="6" inputmode="numeric"')) + '</div>';
          else if (t === 'city') f.innerHTML = B.field('aCity', 'City', B.input('aCity', ''));
          else if (t === 'district') { var ds = (await B.api.get('/geo/districts?state_id=' + B.val('aState'))).districts; f.innerHTML = B.field('aDist', 'District', B.select('aDist', ds.map(function (d) { return { value: d.id, label: d.name }; }), '')); }
          else f.innerHTML = '';
        };
        B.$('#aType').addEventListener('change', fields); B.$('#aState').addEventListener('change', fields); fields();
        B.$('#aAdd').addEventListener('click', async function () {
          var t = B.val('aType'), body = { state_id: B.val('aState'), priority: B.val('aPrio') };
          if (t === 'pincodes') body = { pincodes: B.val('aPins') };
          else { body.area_type = t; if (t === 'pincode_range') { body.pincode_from = B.val('aFrom'); body.pincode_to = B.val('aTo'); } if (t === 'city') body.city = B.val('aCity'); if (t === 'district') body.district_id = B.val('aDist'); }
          try { var r = await B.api.post('/distributors/' + state.distributor + '/service-areas', body); A.toast(r.added != null ? r.added + ' of ' + r.requested + ' pincodes added' : 'Service area added', 'success'); load(); }
          catch (e) { A.toast(e.message, 'error'); }
        });
      } catch (e) { B.fail(host, e); }
    };
    load();
  }

  /* ═════ Overview: which distributor serves which retailers ═════ */
  async function overview(pane) {
    pane.innerHTML = '<div class="card"><div class="card-body tight" id="oHost">' + A.loadingState() + '</div></div>';
    try {
      var r = await B.api.get('/reports/distributors');
      B.$('#oHost').innerHTML = B.table([
        { label: 'Distributor', html: function (x) { return '<span class="td-strong">' + esc(x.name) + '</span><div class="td-muted">' + esc(x.city) + '</div>'; } },
        { label: 'Active retailers', cls: 'num', html: function (x) { return esc(x.retailers); } },
        { label: 'Retailer orders (30 d)', cls: 'num', html: function (x) { return esc(x.retailer_orders); } },
        { label: 'Sales to retailers', cls: 'num', html: function (x) { return B.money0(x.retailer_sales); } },
        { label: 'Purchases from us', cls: 'num', html: function (x) { return B.money0(x.purchases); } },
      ], r.rows, { icon: 'network', emptyTitle: 'No approved distributors yet' }) +
        '<div class="td-muted small" style="padding:12px 16px">Last 30 days. Download the full retailer-by-distributor list from <a href="reports.html?type=mapping" style="text-decoration:underline">Reports → Mapping</a>.</div>';
    } catch (e) { B.fail(B.$('#oHost'), e); }
  }

  try {
    state.distributors = (await B.api.get('/accounts?type=distributor&status=approved&limit=100&sort=name&dir=asc')).items;
    state.states = (await B.api.get('/geo/states')).states;
  } catch (e) { B.fail(content, e); return; }
  shell();
})();
