(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-settings', 'B2B Settings'))) return;
  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var canEdit = B.can('b2b.settings.edit');
  var TABS = [
    { id: 'company', label: 'Company & invoices', perm: 'b2b.settings.view' }, { id: 'rules', label: 'Order rules', perm: 'b2b.settings.view' },
    { id: 'states', label: 'Service states', perm: 'b2b.settings.view' }, { id: 'notifications', label: 'Notifications', perm: 'b2b.settings.view' },
    { id: 'audit', label: 'Audit log', perm: 'b2b.audit.view' }, { id: 'system', label: 'System', perm: 'b2b.settings.view' },
  ].filter(function (t) { return B.can(t.perm) || (t.id === 'system' && B.can('b2b.system.migrate')); });
  if (!TABS.length) { content.innerHTML = '<div class="alert alert-warn">' + A.icon('alert') + '<span>Your role does not have access to settings.</span></div>'; return; }
  var state = { tab: params.get('tab') || TABS[0].id, s: {}, audit: { action: '', entity: '', actor: '', page: 1 }, nq: 'failed' };
  if (!TABS.some(function (t) { return t.id === state.tab; })) state.tab = TABS[0].id;

  function shell() {
    content.innerHTML = B.tabsHtml(TABS, state.tab) + '<div id="pane">' + A.loadingState() + '</div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; shell(); }); });
    ({ company: company, rules: rules, states: states, notifications: notifications, audit: audit, system: system })[state.tab](B.$('#pane')).catch(function (e) { B.fail(B.$('#pane'), e); });
  }
  async function loadSettings() { state.s = (await B.api.get('/settings')).settings; }
  function saveBtn(id) { return canEdit ? '<button class="btn btn-primary" id="' + id + '">Save</button>' : '<div class="td-muted">Read-only for your role.</div>'; }
  async function save(map) {
    var body = {}; Object.keys(map).forEach(function (k) { body[k] = map[k](); });
    try { var r = await B.api.put('/settings', body); A.toast(r.changed.length ? 'Saved' : 'No changes', 'success'); await loadSettings(); } catch (e) { A.toast(e.message, 'error'); }
  }
  var dis = canEdit ? '' : ' disabled';

  async function company(pane) {
    await loadSettings(); var s = state.s, st = (await B.api.get('/geo/states')).states;
    pane.innerHTML = '<div class="card"><div class="card-head"><h2>Seller details printed on invoices, bills and labels</h2></div><div class="card-body"><div class="form-grid">' +
      B.field('c_legal', 'Legal name', B.input('c_legal', s['company.legal_name'], dis)) + B.field('c_brand', 'Brand name', B.input('c_brand', s['company.brand_name'], dis)) +
      B.field('c_gstin', 'GSTIN', B.input('c_gstin', s['company.gstin'], 'maxlength="15" style="text-transform:uppercase"' + dis)) + B.field('c_pan', 'PAN', B.input('c_pan', s['company.pan'], 'maxlength="10" style="text-transform:uppercase"' + dis)) +
      B.field('c_address', 'Registered address', B.input('c_address', s['company.address'], dis), '', 'wide') +
      B.field('c_city', 'City', B.input('c_city', s['company.city'], dis)) + B.field('c_pin', 'Pincode', B.input('c_pin', s['company.pincode'], 'maxlength="6"' + dis)) +
      B.field('c_state', 'State (decides CGST/SGST vs IGST)', B.select('c_state', st.map(function (x) { return { value: x.gst_code, label: x.name + ' (' + x.gst_code + ')' }; }), s['company.state_gst_code'], dis)) +
      B.field('c_phone', 'Phone', B.input('c_phone', s['company.phone'], dis)) + B.field('c_email', 'Email', B.input('c_email', s['company.email'], dis)) +
      B.field('c_prefix', 'Invoice number prefix', B.input('c_prefix', s['invoice.prefix'], 'maxlength="8" style="text-transform:uppercase"' + dis), 'e.g. SOH → SOH2627-00001 (prefix + financial year + running number)') +
      B.field('c_bank', 'Bank details (printed on invoices)', '<textarea class="textarea" id="c_bank"' + dis + '>' + esc(s['company.bank_details']) + '</textarea>', '', 'wide') +
      B.field('c_footer', 'Invoice footer', B.input('c_footer', s['company.invoice_footer'], dis), '', 'wide') + '</div>' + saveBtn('saveCompany') +
      (!s['company.gstin'] || !s['company.address'] ? '<div class="alert alert-warn" style="margin-top:16px">' + A.icon('alert') + '<span>Add your GSTIN and address before issuing invoices — they are printed on every tax invoice.</span></div>' : '') + '</div></div>';
    if (B.$('#saveCompany')) B.$('#saveCompany').addEventListener('click', function () {
      save({ 'company.legal_name': function () { return B.val('c_legal'); }, 'company.brand_name': function () { return B.val('c_brand'); }, 'company.gstin': function () { return B.val('c_gstin').toUpperCase(); },
        'company.pan': function () { return B.val('c_pan').toUpperCase(); }, 'company.address': function () { return B.val('c_address'); }, 'company.city': function () { return B.val('c_city'); },
        'company.pincode': function () { return B.val('c_pin'); }, 'company.state_gst_code': function () { return B.val('c_state'); }, 'company.phone': function () { return B.val('c_phone'); },
        'company.email': function () { return B.val('c_email'); }, 'invoice.prefix': function () { return B.val('c_prefix').toUpperCase(); }, 'company.bank_details': function () { return B.val('c_bank'); },
        'company.invoice_footer': function () { return B.val('c_footer'); } });
    });
  }

  async function rules(pane) {
    await loadSettings(); var s = state.s;
    var chk = function (id, text, on, hint) { return '<div class="field"><label class="checkbox"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + dis + '/><span>' + text + '</span></label>' + (hint ? '<div class="hint" style="margin-left:26px">' + hint + '</div>' : '') + '</div>'; };
    pane.innerHTML = '<div class="card"><div class="card-head"><h2>Order rules</h2></div><div class="card-body">' +
      chk('r_first', '<strong>First order needs admin approval</strong>', s['orders.first_order_approval'], 'The first order from every new retailer or distributor waits in “Pending approval”.') +
      chk('r_pay', '<strong>Payment before dispatch</strong>', s['orders.require_payment_before_dispatch'], 'Orders that are not on credit must be fully paid before they can be dispatched.') +
      chk('r_stock', '<strong>Track distributor stock</strong>', s['inventory.track_distributor_stock'], 'When on, retailer orders reserve stock from the distributor’s own stock point and are refused if it is short. Leave off until distributors keep their stock up to date here.') +
      '<div class="form-grid">' +
      B.field('r_cancel', 'Buyers may cancel until the order is…', B.select('r_cancel', ['submitted', 'pending_admin_approval', 'approved', 'assigned', 'accepted'], s['orders.buyer_cancel_until'], dis)) +
      B.field('r_min', 'Minimum order value (₹, incl. GST)', B.input('r_min', s['orders.min_order_value'], 'inputmode="decimal"' + dis)) +
      B.field('r_inv', 'Generate the tax invoice when the order is…', B.select('r_inv', ['dispatched', 'delivered'], s['invoice.generate_on'], dis), 'GST rules expect the invoice to travel with the goods.') +
      B.field('r_ret', 'Return window (days after delivery)', B.input('r_ret', s['returns.window_days'], 'inputmode="numeric"' + dis), '0 = no limit') +
      B.field('r_emails', 'Send B2B alerts to (emails)', B.input('r_emails', s['notify.admin_emails'], 'placeholder="sales@…, accounts@…"' + dis), 'New registrations, first orders and declined orders. The owner/admin email always receives them.', 'wide') +
      '</div>' + saveBtn('saveRules') + '</div></div>';
    if (B.$('#saveRules')) B.$('#saveRules').addEventListener('click', function () {
      save({ 'orders.first_order_approval': function () { return B.val('r_first'); }, 'orders.require_payment_before_dispatch': function () { return B.val('r_pay'); },
        'inventory.track_distributor_stock': function () { return B.val('r_stock'); }, 'orders.buyer_cancel_until': function () { return B.val('r_cancel'); },
        'orders.min_order_value': function () { return B.val('r_min') || '0'; }, 'invoice.generate_on': function () { return B.val('r_inv'); },
        'returns.window_days': function () { return Number(B.val('r_ret')) || 0; }, 'notify.admin_emails': function () { return B.val('r_emails'); } });
    });
  }

  async function states(pane) {
    var st = (await B.api.get('/geo/states')).states;
    pane.innerHTML = '<div class="card"><div class="card-head"><h2>States you currently serve</h2></div><div class="card-body"><p class="mb-16">Registrations from other states are still accepted but flagged for review. Switch a state on when you expand there — nothing else needs to change.</p><div class="chips">' +
      st.map(function (x) { return '<label class="chip" style="cursor:pointer;padding:6px 12px"><input type="checkbox" data-state="' + x.id + '"' + (Number(x.is_serviceable) ? ' checked' : '') + dis + '/> ' + esc(x.name) + '</label>'; }).join('') + '</div></div></div>';
    pane.querySelectorAll('[data-state]').forEach(function (c) { c.addEventListener('change', async function () {
      try { await B.api.post('/geo/states/' + c.dataset.state + '/serviceable', { serviceable: c.checked }); A.toast('Updated', 'success'); } catch (e) { A.toast(e.message, 'error'); c.checked = !c.checked; } }); });
  }

  // What a queue status really means (owner rule: nothing counts as sent unless a provider took it).
  var NQ_LABEL = { pending: 'Queued', sending: 'Sending', sent: 'Accepted by provider', failed: 'Failed', skipped_no_provider: 'Not sent: no provider',
    skipped_no_contact: 'Not sent: no contact', skipped_opt_out: 'Not sent: opted out' };
  var DS_LABEL = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed (report)' };
  function nqBadge(n) {
    var cls = n.status === 'sent' ? 'approved' : (n.status === 'failed' ? 'rejected' : (/^skipped/.test(n.status) ? 'cancelled' : 'pending'));
    return '<span class="badge badge-' + cls + '">' + esc(NQ_LABEL[n.status] || n.status) + '</span>' +
      (n.delivery_status && DS_LABEL[n.delivery_status] ? ' <span class="badge badge-' + (n.delivery_status === 'failed' ? 'rejected' : 'approved') + '">' + esc(DS_LABEL[n.delivery_status]) + '</span>' : '');
  }
  async function notifications(pane) {
    var d = await B.api.get('/notifications/queue?status=' + state.nq);
    pane.innerHTML = '<div class="alert alert-info">' + A.icon('alert') + '<span>Emails, WhatsApp and SMS are queued when something happens and sent in the background. A failed message is retried automatically (1, 5, 30, 120 minutes) — orders are never held up by notifications. <b>Accepted by provider</b> means the email server or WhatsApp/SMS gateway took the message; delivery is shown only when the provider reports it. Messages are never shown as sent when no provider is configured.</span></div>' +
      '<div class="b2b-filters">' + B.tabsHtml([{ id: 'failed', label: 'Failed' }, { id: 'not_sent', label: 'Not sent' }, { id: 'pending', label: 'Waiting' }, { id: 'sent', label: 'Accepted' }], state.nq, 'nq').replace('mb-16', '') + '<div class="spacer"></div>' +
      (canEdit && state.nq === 'failed' ? '<button class="btn btn-ghost btn-sm" id="retry">' + A.icon('refresh') + 'Retry all failed now</button>' : '') + '</div>' +
      '<div class="card"><div class="card-body tight">' + B.table([
        { label: 'Created', cls: 'td-nowrap', html: function (n) { return esc(B.dateTime(n.created_at)); } }, { label: 'Channel', html: function (n) { return esc(B.label(n.channel)); } },
        { label: 'To', html: function (n) { return esc(n.recipient); } }, { label: 'Subject', cls: 'hide-sm', html: function (n) { return esc(n.subject || (n.template_name ? 'Template ' + n.template_name : '—')); } },
        { label: 'Attempts', cls: 'num', html: function (n) { return esc(n.attempts); } }, { label: 'Status', html: function (n) { return nqBadge(n) + (n.last_error && n.status !== 'sent' ? '<div class="td-muted small">' + esc(n.last_error) + '</div>' : ''); } },
        { label: '', cls: 'td-nowrap', html: function (n) { return '<button class="btn btn-ghost btn-sm" data-nh="' + n.id + '">History</button>' + (canEdit && n.can_retry ? ' <button class="btn btn-ghost btn-sm" data-nr="' + n.id + '">' + A.icon('refresh') + 'Retry</button>' : ''); } },
      ], d.items, { icon: 'inbox', emptyTitle: state.nq === 'failed' ? 'No failed notifications' : 'Nothing here' }) + B.pager(d, 'messages') + '</div></div>';
    pane.querySelectorAll('[data-nq]').forEach(function (b) { b.addEventListener('click', function () { state.nq = b.dataset.nq; shell(); }); });
    if (B.$('#retry')) B.$('#retry').addEventListener('click', async function () { var btn = this; btn.disabled = true; try { var r = await B.api.post('/notifications/retry'); A.toast(r.requeued + ' re-queued' + (r.skipped ? ', ' + r.skipped + ' one-time code(s) skipped' : ''), 'success'); shell(); } catch (e) { btn.disabled = false; A.toast(e.message, 'error'); } });
    pane.querySelectorAll('[data-nr]').forEach(function (b) { b.addEventListener('click', async function () {
      b.disabled = true;   // one press = one retry; the button stays off until the list reloads
      try { await B.api.post('/notifications/queue/' + b.dataset.nr + '/retry'); A.toast('Message re-queued', 'success'); shell(); } catch (e) { b.disabled = false; A.toast(e.message, 'error'); }
    }); });
    pane.querySelectorAll('[data-nh]').forEach(function (b) { b.addEventListener('click', async function () {
      try {
        var m = await B.api.get('/notifications/queue/' + b.dataset.nh);
        var rows = (m.history || []).map(function (h) { return '<tr><td class="td-nowrap">' + esc(B.dateTime(h.created_at)) + '</td><td>' + esc(NQ_LABEL[h.status] || B.label(h.status)) + '</td><td class="small">' + esc([h.detail, h.provider_ref ? 'ref ' + h.provider_ref : '', h.actor_label ? 'by ' + h.actor_label : ''].filter(Boolean).join(' · ') || '—') + '</td></tr>'; }).join('');
        B.modal({ title: 'Message #' + m.id + ' — ' + B.label(m.channel), wide: true, body:
          '<p>' + nqBadge(m) + '</p><p class="small td-muted">To ' + esc(m.recipient) + ' · attempts ' + esc(m.attempts) + ' of ' + esc(m.max_attempts) + (m.provider_message_id ? ' · provider ref ' + esc(m.provider_message_id) : '') + '</p>' +
          (rows ? '<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Status</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="td-muted">No status history yet (it starts once migration 016 is applied).</p>') });
      } catch (e) { A.toast(e.message, 'error'); }
    }); });
  }

  async function audit(pane) {
    var a = state.audit;
    var d = await B.api.get('/audit' + B.qs({ action: a.action, entity: a.entity, actor: a.actor, page: a.page, limit: 50 }));
    pane.innerHTML = '<div class="b2b-filters">' + B.input('aAction', a.action, 'placeholder="Action starts with… e.g. pricing" style="max-width:240px"') +
      B.select('aEntity', [{ value: '', label: 'Any record type' }].concat(['retailer', 'distributor', 'order', 'product', 'pricing_rule', 'invoice', 'credit_note', 'credit_account', 'stock', 'import', 'settings', 'warehouse', 'return', 'category', 'document', 'export']), a.entity) +
      B.input('aActor', a.actor, 'placeholder="User email starts with…" style="max-width:240px"') + '</div><div class="card"><div class="card-body tight">' + B.table([
        { label: 'When', cls: 'td-nowrap', html: function (r) { return esc(B.dateTime(r.created_at)); } },
        { label: 'User', html: function (r) { return esc(r.actor_label || r.actor_type) + '<div class="td-muted">' + esc(r.actor_role || '') + (r.ip ? ' · ' + esc(r.ip) : '') + '</div>'; } },
        { label: 'Action', html: function (r) { return '<span class="td-strong td-mono">' + esc(r.action) + '</span><div class="td-muted">' + esc(r.entity) + (r.entity_id ? ' #' + esc(r.entity_id) : '') + '</div>'; } },
        { label: 'Old value', cls: 'hide-sm', html: function (r) { return r.old_value ? '<div class="pre">' + esc(String(r.old_value).slice(0, 600)) + '</div>' : '<span class="muted">—</span>'; } },
        { label: 'New value', html: function (r) { return r.new_value ? '<div class="pre">' + esc(String(r.new_value).slice(0, 600)) + '</div>' : '<span class="muted">—</span>'; } },
      ], d.items, { icon: 'shield', emptyTitle: 'No matching audit entries' }) + B.pager(d, 'entries') + '</div></div>' +
      '<p class="td-muted small" style="margin-top:10px">The audit log is append-only: there is no way to edit or delete an entry from the application.</p>';
    var go = B.debounce(function () { a.action = B.val('aAction'); a.entity = B.val('aEntity'); a.actor = B.val('aActor'); a.page = 1; shell(); }, 450);
    ['aAction', 'aActor'].forEach(function (id) { B.$('#' + id).addEventListener('change', go); });
    B.$('#aEntity').addEventListener('change', go);
    pane.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { a.page = Number(b.dataset.page); shell(); }); });
  }

  async function system(pane) {
    var s = await B.api.get('/system/status');
    var row = function (label, ok, text) { return '<div class="detail-row"><dt>' + esc(label) + '</dt><dd><span class="badge ' + (ok ? 'badge-delivered' : 'badge-cancelled') + '">' + esc(text) + '</span></dd></div>'; };
    var pending = s.migrations ? s.migrations.pending : null;
    pane.innerHTML = '<div class="grid-2"><div class="card"><div class="card-head"><h2>Status</h2></div><div class="card-body"><dl>' +
      row('MySQL database', s.database.connected, s.database.connected ? 'Connected' : (s.database.configured ? 'Not reachable (' + s.database.error + ')' : 'Not configured')) +
      row('Database schema', s.schema && s.schema.ok, s.schema ? (s.schema.ok ? 'Up to date' : (pending ? pending + ' migration(s) pending' : 'Incomplete')) : 'Unknown') +
      row('Session signing secret', s.strongSecret, s.strongSecret ? 'Set' : 'Weak — set B2B_JWT_SECRET') +
      '<div class="detail-row"><dt>Private document storage</dt><dd class="td-mono">' + esc(s.privateStorage) + '</dd></div>' +
      '<div class="detail-row"><dt>Application version</dt><dd>' + esc(s.version) + '</dd></div>' +
      '<div class="detail-row"><dt>Auto-migrate on start</dt><dd>' + (s.autoMigrate ? 'On (DB_AUTO_MIGRATE=true)' : 'Off (recommended)') + '</dd></div></dl></div></div>' +
      '<div class="card"><div class="card-head"><h2>Database migrations</h2></div><div class="card-body">' +
      (s.migrations ? s.migrations.migrations.map(function (m) { return '<div class="line-item" style="padding:7px 0"><div class="li-info"><strong class="td-mono">' + esc(m.file) + '</strong><span>' + (m.applied ? 'Applied ' + esc(B.dateTime(m.appliedAt)) : 'Not applied yet') + '</span></div>' + B.badge(m.applied ? 'completed' : 'pending') + '</div>'; }).join('') : '<div class="td-muted">Connect the database to see migrations.</div>') +
      (s.schema && s.schema.missing && s.schema.missing.length ? '<div class="alert alert-warn" style="margin-top:12px">' + A.icon('alert') + '<span>Missing tables: ' + esc(s.schema.missing.join(', ')) + '</span></div>' : '') +
      (B.can('b2b.system.migrate') && s.database.connected ? '<div class="inline-actions"><button class="btn ' + (pending ? 'btn-primary' : 'btn-ghost') + '" id="migrate">' + (pending ? 'Run ' + pending + ' pending migration(s)' : 'Re-check migrations') + '</button></div>' : '') +
      '<p class="td-muted small" style="margin-top:12px">Migrations only ever add tables or columns — they never drop or empty anything. Take a database backup in hPanel before running them on production.</p><div id="mLog"></div></div></div></div>';
    if (B.$('#migrate')) B.$('#migrate').addEventListener('click', async function () {
      if (pending && !confirm('Run ' + pending + ' database migration(s) now?\n\nHave you taken a database backup?')) return;
      B.$('#migrate').disabled = true;
      try { var r = await B.api.post('/system/migrate'); A.toast(r.applied.length ? r.applied.length + ' migration(s) applied' : 'Already up to date', 'success'); B.$('#mLog').innerHTML = '<div class="pre" style="margin-top:10px">' + esc(r.log.join('\n') || 'Nothing to do.') + '</div>'; setTimeout(shell, 1500); }
      catch (e) { A.toast(e.message, 'error'); B.$('#migrate').disabled = false; }
    });
  }

  shell();
})();
