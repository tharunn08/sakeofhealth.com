(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-accounts', 'Business Users', ['b2b.users.view']))) return;
  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var TABS = [
    { id: 'pending', label: 'Pending approvals', q: { status: 'pending,under_review' } },
    { id: 'retailers', label: 'Retailers', q: { type: 'retailer', status: 'approved' } },
    { id: 'distributors', label: 'Distributors', q: { type: 'distributor', status: 'approved' } },
    { id: 'suspended', label: 'Suspended / blocked', q: { status: 'suspended,blocked' } },
    { id: 'rejected', label: 'Rejected', q: { status: 'rejected' } },
    { id: 'all', label: 'All', q: {} },
  ];
  var state = { tab: params.get('tab') || 'pending', q: '', state_id: '', page: 1, states: [] };

  document.getElementById('topbarActions').innerHTML =
    (B.can('b2b.users.view') ? '<button class="btn btn-ghost btn-sm" id="expR">' + A.icon('download') + '<span class="hide-sm">Retailers</span></button><button class="btn btn-ghost btn-sm" id="expD">' + A.icon('download') + '<span class="hide-sm">Distributors</span></button>' : '');
  var dl = function (name) { return function () { B.download('/export/' + name + '?format=xlsx').catch(function (e) { A.toast(e.message, 'error'); }); }; };
  if (B.$('#expR')) { B.$('#expR').addEventListener('click', dl('retailers')); B.$('#expD').addEventListener('click', dl('distributors')); }

  function shell() {
    content.innerHTML = B.tabsHtml(TABS, state.tab) +
      '<div class="b2b-filters"><div class="search-box">' + A.icon('search') + '<input class="input" id="q" placeholder="Search name, shop, phone, email, GSTIN, pincode, city…" value="' + esc(state.q) + '"/></div>' +
      B.select('stateF', [{ value: '', label: 'All states' }].concat(state.states.map(function (s) { return { value: s.id, label: s.name }; })), state.state_id) + '</div>' +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; state.page = 1; history.replaceState(null, '', '?tab=' + state.tab); shell(); load(); }); });
    B.$('#q').addEventListener('input', B.debounce(function () { state.q = B.$('#q').value.trim(); state.page = 1; load(); }));
    B.$('#stateF').addEventListener('change', function () { state.state_id = B.$('#stateF').value; state.page = 1; load(); });
  }

  async function load() {
    var host = B.$('#host');
    var tab = TABS.filter(function (t) { return t.id === state.tab; })[0] || TABS[0];
    try {
      var d = await B.api.get('/accounts' + B.qs(Object.assign({ q: state.q, state_id: state.state_id, distributor_id: params.get('distributor_id') || '', page: state.page, limit: 25 }, tab.q)));
      host.innerHTML = B.table([
        { label: 'Business', html: function (r) { return '<div class="td-strong">' + esc(r.business_name) + '</div><div class="td-muted">' + esc(r.shop_name && r.shop_name !== r.business_name ? r.shop_name + ' · ' : '') + esc(r.contact_person) + '</div>'; } },
        { label: 'Type', html: function (r) { return B.badge(r.account_type, 'no-dot'); } },
        { label: 'Contact', cls: 'hide-sm', html: function (r) { return esc(A.fmt.phone(r.mobile)) + '<div class="td-muted">' + esc(r.email) + '</div>'; } },
        { label: 'Location', html: function (r) { return esc(r.city) + ' · ' + esc(r.pincode) + '<div class="td-muted">' + esc(r.district_name) + ', ' + esc(r.state_name) + '</div>'; } },
        { label: 'GSTIN', cls: 'hide-sm td-mono', html: function (r) { return esc(r.gstin || '—'); } },
        { label: 'Distributor', cls: 'hide-sm', html: function (r) { return r.account_type !== 'retailer' ? '<span class="muted">—</span>' : (r.distributor_name ? esc(r.distributor_name) + (r.mapping_status === 'suspended' ? ' ' + B.badge('suspended') : '') : '<span class="badge badge-unpaid no-dot">Unmapped</span>'); } },
        { label: 'Status', html: function (r) { return B.badge(r.status) + (r.risk_flags.length ? ' <span class="badge badge-flag no-dot" title="Risk flags">' + r.risk_flags.length + ' ⚑</span>' : ''); } },
        { label: 'Registered', cls: 'hide-sm td-muted td-nowrap', html: function (r) { return esc(A.fmt.relative(r.created_at)); } },
      ], d.items, { clickable: true, rowAttr: function (r) { return 'data-id="' + r.id + '"'; }, icon: 'customers',
        emptyTitle: state.tab === 'pending' ? 'No registrations waiting' : 'No business accounts found',
        emptyText: state.tab === 'pending' ? 'New retailer and distributor registrations appear here for review.' : 'Try another tab or search term.' }) + B.pager(d, 'accounts');
      host.querySelectorAll('tr[data-id]').forEach(function (tr) { tr.addEventListener('click', function () { open(tr.dataset.id); }); });
      host.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); load(); }); });
    } catch (e) { B.fail(host, e); }
  }

  /* ═════════ Detail drawer ═════════ */

  var STATUS_ACTIONS = {
    pending: [['under_review', 'Start review', 'ghost'], ['approved', 'Approve', 'primary'], ['rejected', 'Reject', 'danger-ghost']],
    under_review: [['approved', 'Approve', 'primary'], ['rejected', 'Reject', 'danger-ghost']],
    approved: [['suspended', 'Suspend', 'ghost'], ['blocked', 'Block', 'danger-ghost']],
    rejected: [['under_review', 'Re-open for review', 'ghost']],
    suspended: [['approved', 'Reinstate', 'primary'], ['blocked', 'Block', 'danger-ghost']],
    blocked: [['approved', 'Unblock', 'primary']],
  };

  async function open(id) {
    var body = B.drawer('Business account', null);
    try { var d = await B.api.get('/accounts/' + id); render(body, d); }
    catch (e) { body.innerHTML = B.errorBox(e); }
  }

  function render(body, d) {
    var a = d.account, isRet = a.account_type === 'retailer';
    document.getElementById('b2bDrawerTitle').textContent = a.business_name;
    var acts = B.can('b2b.users.approve') ? (STATUS_ACTIONS[a.status] || []).map(function (x) {
      return '<button class="btn btn-' + x[2] + ' btn-sm" data-status="' + x[0] + '">' + esc(x[1]) + '</button>'; }).join('') : '';
    var map = a.latitude && a.longitude ? ' <a target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a.latitude + ',' + a.longitude) + '" style="color:var(--brand);text-decoration:underline">Open map</a>' : '';

    var html = '<div class="detail-section"><div class="flex items-center gap-8 mb-16" style="flex-wrap:wrap">' + B.badge(a.account_type, 'no-dot') + B.badge(a.status) +
      '<span class="td-muted">Registered ' + esc(B.dateTime(a.created_at)) + '</span></div>' +
      (acts ? '<div class="inline-actions" style="margin-top:0">' + acts + '</div>' : '') + '</div>' +

      '<div class="detail-section"><div class="detail-title">Risk flags</div>' + B.flags(a.risk_flags) + '</div>' +

      '<div class="detail-section"><div class="detail-title">Registration details</div><dl class="kv">' +
        '<dt>' + (isRet ? 'Retailer' : 'Distributor') + ' name</dt><dd>' + esc(a.business_name) + '</dd>' +
        (isRet ? '<dt>Shop name</dt><dd>' + esc(a.shop_name || '—') + '</dd>' : '') +
        '<dt>Contact person</dt><dd>' + esc(a.contact_person) + '</dd>' +
        '<dt>Mobile</dt><dd><a href="tel:+91' + esc(a.mobile) + '">' + esc(A.fmt.phone(a.mobile)) + '</a></dd>' +
        '<dt>Email</dt><dd>' + esc(a.email) + '</dd>' +
        '<dt>GSTIN</dt><dd class="td-mono">' + esc(a.gstin || '—') + '</dd><dt>PAN</dt><dd class="td-mono">' + esc(a.pan || '—') + '</dd>' +
        '<dt>Business type</dt><dd>' + esc(a.business_type || '—') + '</dd>' +
        '<dt>Address</dt><dd>' + esc([a.address_line1, a.address_line2, a.landmark].filter(Boolean).join(', ')) + '</dd>' +
        '<dt>City / District</dt><dd>' + esc(a.city) + ' / ' + esc(a.district_name) + '</dd>' +
        '<dt>State / Pincode</dt><dd>' + esc(a.state_name) + ' (' + esc(a.state_gst_code) + ') · ' + esc(a.pincode) + '</dd>' +
        '<dt>Location</dt><dd>' + (a.latitude ? esc(a.latitude + ', ' + a.longitude) + map : '<span class="muted">Not shared</span>') + '</dd>' +
        (a.approved_at ? '<dt>Approved</dt><dd>' + esc(B.dateTime(a.approved_at)) + ' by ' + esc(a.approved_by || '—') + '</dd>' : '') +
        (a.admin_notes ? '<dt>Internal notes</dt><dd>' + esc(a.admin_notes) + '</dd>' : '') +
      '</dl>' + (B.can('b2b.users.edit') ? '<div class="inline-actions"><button class="btn btn-ghost btn-sm" id="editBtn">' + A.icon('edit') + 'Edit details</button>' +
        '<button class="btn btn-ghost btn-sm" id="pwBtn">Reset password</button></div>' : '') + '</div>' +

      '<div class="detail-section"><div class="detail-title">Documents</div>' + (d.documents.length ? d.documents.map(function (doc) {
        return '<div class="line-item" style="padding:8px 0"><div class="li-info"><strong>' + esc(B.label(doc.doc_type)) + '</strong><span>' + esc(doc.original_name) + ' · ' + Math.max(1, Math.round(doc.size_bytes / 1024)) + ' KB</span></div>' +
          '<button class="btn btn-ghost btn-sm" data-doc="' + doc.id + '">' + A.icon('external') + 'View</button></div>'; }).join('')
        : '<div class="info-box td-muted">No documents uploaded.</div>') +
        '<div class="td-muted small mt-16">Documents are stored privately and opened through your signed-in session only. Each view is logged.</div></div>';

    if (isRet) {
      var m = d.mapping;
      html += '<div class="detail-section"><div class="detail-title">Distributor mapping</div>' +
        (m ? '<div class="info-box"><strong>' + esc(m.distributor_name) + ' ' + (m.status === 'suspended' ? B.badge('suspended') : '') + '</strong>' + esc(m.distributor_contact) + ' · ' + esc(A.fmt.phone(m.distributor_mobile)) + '<br/>' +
            esc(m.distributor_city) + ' ' + esc(m.distributor_pincode) + '<br/><span class="td-muted">' + esc(B.label(m.method)) + ' · since ' + esc(B.date(m.started_at)) + (m.reason ? ' · ' + esc(m.reason) : '') + '</span></div>'
          : '<div class="alert alert-warn mb-0">' + A.icon('alert') + '<span>No distributor is mapped. Orders from this retailer are supplied directly by the company until one is assigned.</span></div>') +
        (B.can('b2b.network.edit') && a.status === 'approved' ? '<div class="inline-actions"><button class="btn btn-ghost btn-sm" id="autoMap">Re-run automatic mapping</button>' +
          (m ? '<button class="btn btn-ghost btn-sm" data-mapstatus="' + (m.status === 'suspended' ? 'active' : 'suspended') + '">' + (m.status === 'suspended' ? 'Resume mapping' : 'Suspend mapping') + '</button>' +
            '<button class="btn btn-danger-ghost btn-sm" data-assign="">Remove distributor</button>' : '') + '</div>' : '') + '</div>';
      if (d.candidates) {
        html += '<div class="detail-section"><div class="detail-title">Eligible distributors (ranked)</div>' + (d.candidates.length ? d.candidates.map(function (c) {
          var cur = m && Number(m.distributor_id) === c.distributorId;
          return '<div class="rank' + (cur ? ' current' : '') + '"><div class="n">' + c.rank + '</div><div class="body"><strong>' + esc(c.name) + (cur ? ' <span class="badge badge-delivered no-dot">Current</span>' : '') + (c.atCapacity ? ' <span class="badge badge-cancelled no-dot">At capacity</span>' : '') + '</strong>' +
            '<span>Matched by ' + esc(B.label(c.matchedBy).toLowerCase()) + ' · ' + c.activeRetailers + (c.maxRetailers ? '/' + c.maxRetailers : '') + ' retailers · ' + c.openOrders + ' open orders' +
            (c.stockCoverage != null ? ' · stock ' + Math.round(c.stockCoverage * 100) + '%' : '') + (c.distanceKm != null ? ' · ' + c.distanceKm + ' km' : '') + '</span></div>' +
            (!cur && B.can('b2b.network.edit') && a.status === 'approved' ? '<button class="btn btn-ghost btn-sm" data-assign="' + c.distributorId + '" data-name="' + esc(c.name) + '">Assign</button>' : '') + '</div>'; }).join('')
          : '<div class="info-box td-muted">No approved distributor has a service area covering ' + esc(a.pincode) + ' / ' + esc(a.district_name) + '. Add a service area under Network.</div>') +
          '<div class="td-muted small">Ranking: service territory → stock → capacity → workload → distance.</div></div>';
      }
      if (d.mappingHistory && d.mappingHistory.length) {
        html += '<div class="detail-section"><div class="detail-title">Mapping history</div>' + B.table([
          { label: 'Distributor', html: function (r) { return esc(r.distributor_name); } },
          { label: 'How', html: function (r) { return esc(B.label(r.method)) + '<div class="td-muted">' + esc(r.reason || '') + '</div>'; } },
          { label: 'By', html: function (r) { return esc(r.assigned_by || '—'); } },
          { label: 'From', cls: 'td-nowrap', html: function (r) { return esc(B.date(r.started_at)); } },
          { label: 'To', cls: 'td-nowrap', html: function (r) { return r.ended_at ? esc(B.date(r.ended_at)) : B.badge(r.status); } },
        ], d.mappingHistory) + '</div>';
      }
    } else {
      html += '<div class="detail-section"><div class="detail-title">Network</div><dl class="kv"><dt>Active retailers</dt><dd>' + d.retailerCount + (a.max_retailers ? ' of ' + a.max_retailers + ' max' : '') +
        ' · <a href="accounts.html?tab=retailers&distributor_id=' + a.id + '" style="color:var(--brand);text-decoration:underline">view</a></dd>' +
        '<dt>Daily order capacity</dt><dd>' + esc(a.daily_order_capacity || 'Not set') + '</dd><dt>Invoice prefix</dt><dd class="td-mono">' + esc(a.invoice_prefix || 'D' + a.id) + '</dd></dl>' +
        '<div class="detail-title" style="margin-top:16px">Service areas</div><div class="chips">' + (d.serviceAreas.length ? d.serviceAreas.map(function (s) {
          var t = s.area_type === 'pincode' ? s.pincode_from : s.area_type === 'pincode_range' ? s.pincode_from + '–' + s.pincode_to : s.area_type === 'city' ? s.city : s.area_type === 'district' ? s.district_name + ' district' : s.state_name + ' (state)';
          return '<span class="chip' + (Number(s.is_active) ? '' : ' off') + '">' + esc(t) + '</span>'; }).join('') : '<span class="muted">None</span>') + '</div>' +
        '<div class="inline-actions"><a class="btn btn-ghost btn-sm" href="network.html?distributor=' + a.id + '">' + A.icon('network') + 'Manage service areas</a></div></div>';
    }

    html += '<div class="detail-section"><div class="detail-title">Trading summary</div><dl class="kv"><dt>Orders placed</dt><dd>' + d.stats.orders + ' · ' + B.money(d.stats.total_value) + '</dd>' +
      '<dt>Outstanding</dt><dd>' + B.money(d.stats.outstanding) + '</dd><dt>Last order</dt><dd>' + esc(d.stats.last_order_at ? B.dateTime(d.stats.last_order_at) : 'Never') + '</dd>' +
      '<dt>First order approved</dt><dd>' + (a.first_order_done ? 'Yes' : 'Not yet') + '</dd></dl>' +
      (d.credit.length ? '<div class="detail-title" style="margin-top:16px">Credit lines</div>' + B.table([
        { label: 'From', html: function (c) { return esc(c.creditor_name || 'Company'); } },
        { label: 'Limit', cls: 'num', html: function (c) { return B.money(c.credit_limit); } },
        { label: 'Used', cls: 'num', html: function (c) { return B.money(c.credit_used); } },
        { label: 'Days', cls: 'num', html: function (c) { return esc(c.credit_days); } },
      ], d.credit) : '') +
      '<div class="inline-actions"><a class="btn btn-ghost btn-sm" href="orders.html?buyer_id=' + a.id + '">View orders</a>' +
      (B.can('b2b.credit.edit') && a.status === 'approved' ? '<a class="btn btn-ghost btn-sm" href="finance.html?tab=credit&q=' + encodeURIComponent(a.mobile) + '">Credit limit</a>' : '') + '</div></div>';

    html += '<div class="detail-section"><div class="detail-title">Approval history</div><div class="stepper">' + d.history.map(function (h) {
      return '<div class="step done"><div class="step-dot">' + A.icon('check', 12) + '</div><div class="step-content"><strong>' + esc(B.label(h.to_status)) + '</strong><span>' + esc(B.dateTime(h.created_at)) + ' · ' + esc(h.actor_label || h.actor_type) + '</span>' +
        (h.reason ? '<span>' + esc(h.reason) + '</span>' : '') + '</div></div>'; }).join('') + '</div></div>';

    body.innerHTML = html;
    wire(body, d);
  }

  function wire(body, d) {
    var a = d.account, reload = function () { open(a.id); load(); A.loadBadges(); };
    body.querySelectorAll('[data-status]').forEach(function (b) {
      b.addEventListener('click', function () {
        var to = b.dataset.status, needs = ['rejected', 'suspended', 'blocked'].indexOf(to) !== -1;
        var go = async function (reason) { var r = await B.api.post('/accounts/' + a.id + '/status', { status: to, reason: reason });
          A.toast(to === 'approved' ? 'Approved' + (r.mapping ? ' — mapped to ' + r.mapping.name : '') : 'Status updated', 'success'); reload(); };
        if (needs) B.askReason(b.textContent + ' — ' + a.business_name, 'The business is notified by email and WhatsApp with this reason.', { danger: to !== 'suspended', submit: b.textContent }, go);
        else { b.disabled = true; go('').catch(function (e) { A.toast(e.message, 'error'); b.disabled = false; }); }
      });
    });
    body.querySelectorAll('[data-doc]').forEach(function (b) { b.addEventListener('click', function () { B.openFile('/documents/' + b.dataset.doc + '/file'); }); });
    body.querySelectorAll('[data-assign]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.assign;
        B.askReason(id ? 'Assign to ' + b.dataset.name : 'Remove distributor', id ? 'Open orders already assigned stay with the current distributor.' : 'Future orders from this retailer will be supplied directly by the company.',
          { submit: id ? 'Assign' : 'Remove', danger: !id, placeholder: 'e.g. Closer to the shop' }, async function (reason) {
            await B.api.post('/retailers/' + a.id + '/mapping', { distributor_id: id || null, reason: reason }); A.toast('Mapping updated', 'success'); reload(); });
      });
    });
    var auto = body.querySelector('#autoMap');
    if (auto) auto.addEventListener('click', async function () {
      auto.disabled = true;
      try { var r = await B.api.post('/retailers/' + a.id + '/mapping/auto'); A.toast(r.assigned ? 'Mapped to ' + r.assigned.name : 'No eligible distributor found', r.assigned ? 'success' : 'error'); reload(); }
      catch (e) { A.toast(e.message, 'error'); auto.disabled = false; }
    });
    body.querySelectorAll('[data-mapstatus]').forEach(function (b) {
      b.addEventListener('click', function () {
        B.askReason(b.textContent, '', { optional: true, submit: b.textContent }, async function (reason) {
          await B.api.post('/retailers/' + a.id + '/mapping/status', { status: b.dataset.mapstatus, reason: reason }); A.toast('Mapping updated', 'success'); reload(); });
      });
    });
    var edit = body.querySelector('#editBtn');
    if (edit) edit.addEventListener('click', function () {
      var isRet = a.account_type === 'retailer';
      B.modal({ title: 'Edit ' + a.business_name, wide: true, body: '<div class="form-grid">' +
        B.field('e_business_name', isRet ? 'Retailer name' : 'Distributor name', B.input('e_business_name', a.business_name)) +
        (isRet ? B.field('e_shop_name', 'Shop name', B.input('e_shop_name', a.shop_name)) : '') +
        B.field('e_contact_person', 'Contact person', B.input('e_contact_person', a.contact_person)) +
        B.field('e_gstin', 'GSTIN', B.input('e_gstin', a.gstin, 'maxlength="15" style="text-transform:uppercase"')) +
        B.field('e_business_type', 'Business type', B.input('e_business_type', a.business_type)) +
        B.field('e_address_line1', 'Address', B.input('e_address_line1', a.address_line1), '', 'wide') +
        B.field('e_address_line2', 'Address line 2', B.input('e_address_line2', a.address_line2)) + B.field('e_landmark', 'Landmark', B.input('e_landmark', a.landmark)) +
        B.field('e_city', 'City', B.input('e_city', a.city)) + B.field('e_pincode', 'Pincode', B.input('e_pincode', a.pincode, 'maxlength="6" inputmode="numeric"')) +
        B.field('e_latitude', 'Latitude', B.input('e_latitude', a.latitude)) + B.field('e_longitude', 'Longitude', B.input('e_longitude', a.longitude)) +
        (isRet ? '' : B.field('e_max_retailers', 'Max retailers (capacity)', B.input('e_max_retailers', a.max_retailers, 'inputmode="numeric"'), 'Blank = no limit') +
          B.field('e_daily_order_capacity', 'Orders per day (capacity)', B.input('e_daily_order_capacity', a.daily_order_capacity, 'inputmode="numeric"')) +
          B.field('e_invoice_prefix', 'Invoice prefix', B.input('e_invoice_prefix', a.invoice_prefix, 'maxlength="6" style="text-transform:uppercase"'), 'Up to 6 letters/digits')) +
        B.field('e_admin_notes', 'Internal notes', '<textarea class="textarea" id="e_admin_notes">' + esc(a.admin_notes || '') + '</textarea>', '', 'wide') + '</div>',
        onSubmit: async function () {
          var body2 = {};
          ['business_name', 'shop_name', 'contact_person', 'gstin', 'business_type', 'address_line1', 'address_line2', 'landmark', 'city', 'pincode', 'latitude', 'longitude', 'max_retailers', 'daily_order_capacity', 'invoice_prefix', 'admin_notes']
            .forEach(function (k) { var v = B.val('e_' + k); if (v !== undefined) body2[k] = v; });
          await B.api.patch('/accounts/' + a.id, body2); A.toast('Saved', 'success'); reload();
        } });
    });
    var pw = body.querySelector('#pwBtn');
    if (pw) pw.addEventListener('click', function () {
      B.modal({ title: 'Reset password — ' + a.business_name, submit: 'Set password',
        body: B.field('np', 'New password', B.input('np', '', 'type="text" autocomplete="off" minlength="8"'), 'At least 8 characters with a letter and a number. Share it with the business securely; all their existing sessions are signed out.'),
        onSubmit: async function () { await B.api.post('/accounts/' + a.id + '/reset-password', { password: B.val('np') }); A.toast('Password reset', 'success'); } });
    });
  }

  try { state.states = (await B.api.get('/geo/states')).states; } catch (e) { /* filter just stays empty */ }
  shell(); load();
  if (params.get('open')) open(params.get('open'));
})();
