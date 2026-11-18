(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-finance', 'Finance', ['b2b.invoices.view', 'b2b.payments.view']))) return;
  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var state = { tab: params.get('tab') || 'invoices', q: params.get('q') || '', from: '', to: '', payment: '', page: 1 };
  var TABS = [{ id: 'invoices', label: 'Invoices' }, { id: 'payments', label: 'Payments' }, { id: 'outstanding', label: 'Outstanding' }, { id: 'credit', label: 'Credit' }, { id: 'credit-notes', label: 'Credit notes' }];
  var EXPORT = { invoices: 'invoices', payments: 'payments', outstanding: 'outstanding' };

  function shell() {
    document.getElementById('topbarActions').innerHTML = EXPORT[state.tab] ? '<button class="btn btn-ghost btn-sm" id="expBtn">' + A.icon('download') + '<span class="hide-sm">Export</span></button>' : '';
    if (B.$('#expBtn')) B.$('#expBtn').addEventListener('click', function () { B.download('/export/' + EXPORT[state.tab] + B.qs({ format: 'xlsx', from: state.from, to: state.to })).catch(function (e) { A.toast(e.message, 'error'); }); });
    var dates = state.tab !== 'outstanding' && state.tab !== 'credit';
    content.innerHTML = B.tabsHtml(TABS, state.tab) + '<div id="summary"></div><div class="b2b-filters"><div class="search-box">' + A.icon('search') +
      '<input class="input" id="q" placeholder="Search…" value="' + esc(state.q) + '"/></div>' +
      (state.tab === 'invoices' ? B.select('fPay', [{ value: '', label: 'All invoices' }, { value: 'unpaid', label: 'Unpaid' }, { value: 'paid', label: 'Paid' }], state.payment) : '') +
      (dates ? '<input class="input" type="date" id="fFrom" value="' + esc(state.from) + '"/><input class="input" type="date" id="fTo" value="' + esc(state.to) + '"/>' : '') +
      '</div><div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; state.page = 1; state.q = ''; shell(); load(); }); });
    B.$('#q').addEventListener('input', B.debounce(function () { state.q = B.$('#q').value.trim(); state.page = 1; load(); }));
    [['fPay', 'payment'], ['fFrom', 'from'], ['fTo', 'to']].forEach(function (p) { var el = B.$('#' + p[0]); if (el) el.addEventListener('change', function () { state[p[1]] = el.value; state.page = 1; load(); }); });
  }
  function summary(items) {
    B.$('#summary').innerHTML = '<div class="stat-grid">' + items.map(function (i) { return '<div class="stat ' + (i[2] || '') + '"><div class="stat-label">' + esc(i[0]) + '</div><div class="stat-value">' + esc(i[1]) + '</div></div>'; }).join('') + '</div>';
  }
  var printBill = function (orderId) { window.open('/admin/print.html?src=b2b&doc=bill&ids=' + orderId, '_blank', 'noopener'); };

  async function load() {
    var host = B.$('#host'), t = state.tab, d;
    var q = { q: state.q, from: state.from, to: state.to, page: state.page, limit: 25 };
    try {
      if (t === 'invoices') {
        d = await B.api.get('/invoices' + B.qs(Object.assign(q, { payment: state.payment })));
        summary([['Invoices', A.fmt.num(d.total)], ['Invoiced value', B.money0(d.amount), 'blue']]);
        host.innerHTML = B.table([
          { label: 'Invoice', html: function (i) { return '<span class="td-mono td-strong">' + esc(i.invoice_no) + '</span><div class="td-muted">' + esc(B.date(i.invoice_date)) + '</div>'; } },
          { label: 'Buyer', html: function (i) { return esc(i.buyer_name) + '<div class="td-muted td-mono">' + esc(i.buyer_gstin || 'Unregistered') + '</div>'; } },
          { label: 'Seller', cls: 'hide-sm', html: function (i) { return i.seller_type === 'company' ? B.badge('company', 'no-dot') : esc(i.seller_name); } },
          { label: 'Taxable', cls: 'num hide-sm', html: function (i) { return B.money(i.taxable_total); } },
          { label: 'GST', cls: 'num hide-sm', html: function (i) { return B.money(i.tax_total) + '<div class="td-muted small">' + (Number(i.is_interstate) ? 'IGST' : 'CGST+SGST') + '</div>'; } },
          { label: 'Total', cls: 'num td-strong', html: function (i) { return B.money(i.grand_total); } },
          { label: 'Due', cls: 'hide-sm', html: function (i) { var late = i.due_date && i.payment_status !== 'paid' && new Date(i.due_date) < new Date(); return '<span' + (late ? ' style="color:var(--red);font-weight:600"' : '') + '>' + esc(B.date(i.due_date)) + '</span>'; } },
          { label: 'Status', html: function (i) { return i.status === 'cancelled' ? B.badge('cancelled') : B.badge(i.payment_status === 'paid' ? 'paid' : i.payment_status === 'partial' ? 'partial' : 'pending').replace('Pending', 'Unpaid'); } },
          { label: '', html: function (i) { return '<span style="white-space:nowrap"><button class="btn btn-ghost btn-sm" title="Print invoice" data-print="' + i.order_id + '">Print</button> <a class="btn btn-ghost btn-sm" href="orders.html?open=' + i.order_id + '">Order</a></span>'; } },
        ], d.items, { icon: 'reports', emptyTitle: 'No invoices yet', emptyText: 'Invoices are generated automatically when an order is dispatched.' }) + B.pager(d, 'invoices');
        host.querySelectorAll('[data-print]').forEach(function (b) { b.addEventListener('click', function () { printBill(b.dataset.print); }); });
      } else if (t === 'payments') {
        d = await B.api.get('/payments' + B.qs(q));
        summary([['Payments', A.fmt.num(d.total)], ['Net received', B.money0(d.amount), 'teal']]);
        host.innerHTML = B.table([
          { label: 'Received', cls: 'td-nowrap', html: function (p) { return esc(B.dateTime(p.received_at)); } },
          { label: 'Order', cls: 'td-mono', html: function (p) { return '<a href="orders.html?open=' + p.order_id + '" style="text-decoration:underline">' + esc(p.order_no) + '</a>'; } },
          { label: 'Paid by', html: function (p) { return esc(p.payer_name); } },
          { label: 'Paid to', cls: 'hide-sm', html: function (p) { return B.badge(p.payee_type, 'no-dot'); } },
          { label: 'Method', html: function (p) { return esc(B.label(p.method)) + (p.status === 'reversed' ? ' ' + B.badge('refunded') : ''); } },
          { label: 'Reference', cls: 'td-mono hide-sm', html: function (p) { return esc(p.reference || p.gateway_payment_id || '—'); } },
          { label: 'Amount', cls: 'num td-strong', html: function (p) { return (p.status === 'reversed' ? '− ' : '') + B.money(p.amount); } },
          { label: 'Recorded by', cls: 'hide-sm td-muted', html: function (p) { return esc(p.recorded_by || '—'); } },
        ], d.items, { icon: 'rupee', emptyTitle: 'No payments recorded' }) + B.pager(d, 'payments');
      } else if (t === 'outstanding') {
        d = await B.api.get('/outstanding' + B.qs(q));
        summary([['Accounts owing', A.fmt.num(d.total)], ['Total outstanding', B.money0(d.amount), Number(d.amount) ? 'amber' : '']]);
        host.innerHTML = B.table([
          { label: 'Account', html: function (r) { return '<a class="td-strong" href="accounts.html?open=' + r.account_id + '">' + esc(r.shop_name || r.business_name) + '</a><div class="td-muted">' + B.badge(r.account_type, 'no-dot') + ' ' + esc(r.city) + ' · ' + esc(A.fmt.phone(r.mobile)) + '</div>'; } },
          { label: 'Open orders', cls: 'num', html: function (r) { return esc(r.open_orders); } },
          { label: 'Outstanding', cls: 'num td-strong', html: function (r) { return B.money(r.outstanding); } },
          { label: 'Overdue', cls: 'num', html: function (r) { return Number(r.overdue) ? '<span style="color:var(--red);font-weight:600">' + B.money(r.overdue) + '</span>' : '—'; } },
          { label: 'Oldest due', cls: 'hide-sm', html: function (r) { return esc(B.date(r.oldest_due_date)); } },
          { label: '', html: function (r) { return '<a class="btn btn-ghost btn-sm" href="orders.html?buyer_id=' + r.account_id + '">Orders</a>'; } },
        ], d.items, { icon: 'rupee', emptyTitle: 'Nothing outstanding', emptyText: 'Every order is fully paid.' }) + B.pager(d, 'accounts') +
          '<div class="td-muted small" style="padding:12px 16px">Includes amounts owed to distributors by their retailers. Export for the order-by-order list with days overdue.</div>';
      } else if (t === 'credit') {
        d = await B.api.get('/credit' + B.qs({ q: state.q, page: state.page, limit: 25, creditor: 'all' }));
        summary([['Credit lines', A.fmt.num(d.total)], ['Total limit', B.money0(d.totalLimit), 'blue'], ['Credit used (exposure)', B.money0(d.totalUsed), 'violet']]);
        host.innerHTML = B.table([
          { label: 'Account', html: function (c) { return '<span class="td-strong">' + esc(c.business_name) + '</span><div class="td-muted">' + B.badge(c.account_type, 'no-dot') + ' ' + esc(c.city) + '</div>'; } },
          { label: 'Credit from', html: function (c) { return Number(c.creditor_account_id) ? esc(c.creditor_name) : B.badge('company', 'no-dot'); } },
          { label: 'Limit', cls: 'num', html: function (c) { return B.money(c.credit_limit); } },
          { label: 'Used', cls: 'num', html: function (c) { return B.money(c.credit_used); } },
          { label: 'Available', cls: 'num td-strong', html: function (c) { return B.money(c.available) + (Number(c.override_amount) ? '<div class="td-muted small">incl. override ' + B.money0(c.override_amount) + '</div>' : ''); } },
          { label: 'Days', cls: 'num', html: function (c) { return esc(c.credit_days); } },
          { label: '', html: function (c) { return '<button class="btn btn-ghost btn-sm" data-hist="' + c.debtor_account_id + '|' + c.creditor_account_id + '|' + esc(c.business_name) + '">History</button>' +
            (!Number(c.creditor_account_id) && B.can('b2b.credit.edit') ? ' <button class="btn btn-ghost btn-sm" data-limit="' + c.debtor_account_id + '">Set limit</button>' : '') +
            (!Number(c.creditor_account_id) && B.can('b2b.credit.override') ? ' <button class="btn btn-ghost btn-sm" data-over="' + c.debtor_account_id + '">Override</button>' : ''); } },
        ], d.items, { icon: 'rupee', emptyTitle: 'No credit lines', emptyText: 'A credit line is created (limit ₹0) when an account is approved.' }) + B.pager(d, 'credit lines');
        var find = function (id) { return d.items.filter(function (c) { return String(c.debtor_account_id) === String(id) && !Number(c.creditor_account_id); })[0]; };
        host.querySelectorAll('[data-limit]').forEach(function (b) { b.addEventListener('click', function () {
          var c = find(b.dataset.limit);
          B.modal({ title: 'Credit terms — ' + c.business_name, body: '<div class="field-row">' + B.field('cl', 'Credit limit (₹)', B.input('cl', c.credit_limit, 'inputmode="decimal"')) + B.field('cd', 'Credit days', B.input('cd', c.credit_days, 'inputmode="numeric"')) + '</div>' +
            '<label class="checkbox"><input type="checkbox" id="ca"' + (c.is_active !== false ? ' checked' : '') + '/><span>Credit enabled</span></label><p class="td-muted" style="margin-top:12px">Currently used: ' + B.money(c.credit_used) + '. Orders on credit are refused once the limit is reached.</p>',
            onSubmit: async function () { await B.api.put('/credit/' + c.debtor_account_id, { credit_limit: B.val('cl'), credit_days: B.val('cd'), is_active: B.val('ca') }); A.toast('Credit terms saved', 'success'); load(); } });
        }); });
        host.querySelectorAll('[data-over]').forEach(function (b) { b.addEventListener('click', function () {
          var c = find(b.dataset.over);
          B.modal({ title: 'Temporary override — ' + c.business_name, submit: 'Grant override', body: '<p class="mb-16">Allows this account to order above its limit for a short time. Logged with your name.</p><div class="field-row">' +
            B.field('oa', 'Extra amount (₹)', B.input('oa', '', 'inputmode="decimal"'), '0 clears an existing override') + B.field('oh', 'Valid for (hours)', B.input('oh', 24, 'inputmode="numeric"')) + '</div>' + B.field('or', 'Reason', '<textarea class="textarea" id="or"></textarea>'),
            onSubmit: async function () { await B.api.post('/credit/' + c.debtor_account_id + '/override', { amount: B.val('oa'), hours: B.val('oh'), reason: B.val('or') }); A.toast('Override saved', 'success'); load(); } });
        }); });
        host.querySelectorAll('[data-hist]').forEach(function (b) { b.addEventListener('click', async function () {
          var p = b.dataset.hist.split('|'), body = B.drawer('Credit history — ' + p[2], null);
          try {
            var h = await B.api.get('/credit/' + p[0] + '/history?creditor=' + p[1]);
            body.innerHTML = '<dl class="kv mb-16"><dt>Limit</dt><dd>' + B.money(h.credit.credit_limit) + '</dd><dt>Used</dt><dd>' + B.money(h.credit.credit_used) + '</dd><dt>Available</dt><dd>' + B.money(h.credit.available) + '</dd></dl>' + B.table([
              { label: 'When', cls: 'td-nowrap', html: function (x) { return esc(B.dateTime(x.created_at)); } },
              { label: 'Type', html: function (x) { return esc(B.label(x.txn_type)) + (x.order_no ? '<div class="td-muted td-mono">' + esc(x.order_no) + '</div>' : ''); } },
              { label: 'Amount', cls: 'num', html: function (x) { return (x.txn_type === 'credit' ? '− ' : x.txn_type === 'debit' ? '+ ' : '') + B.money(x.amount); } },
              { label: 'Used after', cls: 'num', html: function (x) { return B.money(x.balance_after); } },
              { label: 'Note', html: function (x) { return esc(x.note || '') + (x.due_date ? '<div class="td-muted">due ' + esc(B.date(x.due_date)) + '</div>' : ''); } },
            ], h.history, { emptyTitle: 'No credit activity yet' });
          } catch (e) { body.innerHTML = B.errorBox(e); }
        }); });
      } else {
        d = await B.api.get('/credit-notes' + B.qs(q));
        summary([['Credit notes', A.fmt.num(d.total)], ['Total credited', B.money0(d.amount), 'amber']]);
        host.innerHTML = B.table([
          { label: 'Credit note', html: function (c) { return '<span class="td-mono td-strong">' + esc(c.credit_note_no) + '</span><div class="td-muted">' + esc(B.date(c.note_date)) + '</div>'; } },
          { label: 'Against invoice', cls: 'td-mono', html: function (c) { return esc(c.invoice_no); } },
          { label: 'Buyer', html: function (c) { return esc(c.buyer_name); } },
          { label: 'Reason', cls: 'hide-sm', html: function (c) { return esc(c.reason) + (Number(c.is_full_cancellation) ? ' <span class="badge badge-cancelled no-dot">Invoice cancelled</span>' : ''); } },
          { label: 'Value', cls: 'num td-strong', html: function (c) { return B.money(c.grand_total); } },
          { label: 'Adjusted / refund due', cls: 'num hide-sm', html: function (c) { return B.money(c.applied_amount) + ' / ' + (Number(c.refund_amount) ? '<span style="color:var(--amber);font-weight:600">' + B.money(c.refund_amount) + '</span>' : '—'); } },
          { label: '', html: function (c) { return '<a class="btn btn-ghost btn-sm" href="orders.html?open=' + c.order_id + '">Order</a>'; } },
        ], d.items, { icon: 'reports', emptyTitle: 'No credit notes', emptyText: 'Credit notes are raised for short deliveries, returns and cancelled invoices.' }) + B.pager(d, 'credit notes');
      }
      host.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); load(); }); });
    } catch (e) { B.fail(host, e); }
  }
  shell(); load();
})();
