(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-orders', 'B2B Orders', ['b2b.orders.view']))) return;
  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var TABS = [
    { id: '', label: 'All' },
    { id: 'pending_admin_approval', label: 'Pending approval' },
    { id: 'approved,assigned', label: 'Awaiting acceptance' },
    { id: 'accepted,processing,packed', label: 'Processing' },
    { id: 'dispatched,out_for_delivery', label: 'Dispatched' },
    { id: 'delivered,partially_delivered', label: 'Delivered' },
    { id: 'cancelled,rejected,refunded,returned', label: 'Cancelled / returned' },
    { id: '__returns', label: 'Returns' },
  ];
  var state = { status: params.get('tab') === 'returns' ? '__returns' : (params.get('status') || ''), q: '', buyer_type: '', seller_type: '', payment_status: '', from: '', to: '',
    buyer_id: params.get('buyer_id') || '', page: 1, selected: {}, data: null };

  document.getElementById('topbarActions').innerHTML =
    '<button class="btn btn-ghost btn-sm" id="printSel" disabled>' + A.icon('print') + '<span class="hide-sm">Print labels</span></button>' +
    '<button class="btn btn-ghost btn-sm" id="billSel" disabled>' + A.icon('reports') + '<span class="hide-sm">Print bills</span></button>' +
    '<button class="btn btn-ghost btn-sm" id="expBtn">' + A.icon('download') + '<span class="hide-sm">Export</span></button>';
  function selectedIds() { return Object.keys(state.selected).filter(function (k) { return state.selected[k]; }); }
  function syncSel() { var n = selectedIds().length; ['printSel', 'billSel'].forEach(function (id) { B.$('#' + id).disabled = !n; }); }
  function printDocs(doc, ids) { window.open('/admin/print.html?src=b2b&doc=' + doc + '&ids=' + encodeURIComponent(ids.join(',')), '_blank', 'noopener'); }
  B.$('#printSel').addEventListener('click', function () { printDocs('label', selectedIds()); });
  B.$('#billSel').addEventListener('click', function () { printDocs('bill', selectedIds()); });
  B.$('#expBtn').addEventListener('click', function () { B.download('/export/orders' + B.qs({ format: 'xlsx', from: state.from, to: state.to })).catch(function (e) { A.toast(e.message, 'error'); }); });

  function shell() {
    var returns = state.status === '__returns';
    content.innerHTML = B.tabsHtml(TABS, state.status) +
      '<div class="b2b-filters"><div class="search-box">' + A.icon('search') + '<input class="input" id="q" placeholder="' + (returns ? 'Search return no, order no, buyer…' : 'Search order no, buyer, phone, pincode…') + '" value="' + esc(state.q) + '"/></div>' +
      (returns ? '' :
        B.select('fBuyer', [{ value: '', label: 'All buyers' }, { value: 'retailer', label: 'Retailers' }, { value: 'distributor', label: 'Distributors' }], state.buyer_type) +
        B.select('fSeller', [{ value: '', label: 'Any supplier' }, { value: 'company', label: 'Supplied by company' }, { value: 'distributor', label: 'Supplied by distributor' }], state.seller_type) +
        B.select('fPay', [{ value: '', label: 'Any payment' }, { value: 'pending', label: 'Unpaid' }, { value: 'partial', label: 'Part paid' }, { value: 'paid', label: 'Paid' }], state.payment_status) +
        '<input class="input" type="date" id="fFrom" value="' + esc(state.from) + '" title="From date"/><input class="input" type="date" id="fTo" value="' + esc(state.to) + '" title="To date"/>') +
      '</div>' + (state.buyer_id ? '<div class="alert alert-info mb-16">' + A.icon('alert') + '<span>Showing orders for one buyer. <a href="orders.html" style="text-decoration:underline">Show all</a></span></div>' : '') +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.status = b.dataset.tab; state.page = 1; state.selected = {}; syncSel(); shell(); load(); }); });
    B.$('#q').addEventListener('input', B.debounce(function () { state.q = B.$('#q').value.trim(); state.page = 1; load(); }));
    [['fBuyer', 'buyer_type'], ['fSeller', 'seller_type'], ['fPay', 'payment_status'], ['fFrom', 'from'], ['fTo', 'to']].forEach(function (p) {
      var el = B.$('#' + p[0]); if (el) el.addEventListener('change', function () { state[p[1]] = el.value; state.page = 1; load(); });
    });
  }

  async function load() {
    var host = B.$('#host');
    try {
      if (state.status === '__returns') return loadReturns(host);
      var d = state.data = await B.api.get('/orders' + B.qs({ status: state.status, q: state.q, buyer_type: state.buyer_type, seller_type: state.seller_type, payment_status: state.payment_status,
        from: state.from, to: state.to, buyer_id: state.buyer_id, page: state.page, limit: 25 }));
      host.innerHTML = B.table([
        { label: '', html: function (r) { return '<input type="checkbox" data-sel="' + r.id + '"' + (state.selected[r.id] ? ' checked' : '') + ' aria-label="Select order"/>'; } },
        { label: 'Order', html: function (r) { return '<span class="td-mono td-strong td-nowrap">' + esc(r.order_no) + '</span>' + (Number(r.is_first_order) ? '<div class="td-muted">First order</div>' : ''); } },
        { label: 'Buyer', html: function (r) { return '<div class="td-strong">' + esc(r.buyer_shop || r.buyer_name) + '</div><div class="td-muted">' + B.badge(r.buyer_type, 'no-dot') + ' ' + esc(r.ship_city) + ' · ' + esc(r.ship_pincode) + '</div>'; } },
        { label: 'Supplied by', cls: 'hide-sm', html: function (r) { return r.seller_type === 'company' ? B.badge('company', 'no-dot') : esc(r.seller_name || '—'); } },
        { label: 'Units', cls: 'num hide-sm', html: function (r) { return esc(r.total_qty); } },
        { label: 'Total', cls: 'num td-strong', html: function (r) { return B.money0(r.grand_total); } },
        { label: 'Payment', cls: 'hide-sm', html: function (r) { return '<span class="badge ' + (r.payment_status === 'paid' ? 'badge-paid' : 'badge-unpaid') + '">' + esc(B.label(r.payment_method)) + '</span>'; } },
        { label: 'Status', html: function (r) { return B.badge(r.status) + (Number(r.is_on_hold) ? ' <span class="badge badge-hold no-dot">Hold</span>' : ''); } },
        { label: 'Placed', cls: 'hide-sm td-muted td-nowrap', html: function (r) { return esc(A.fmt.relative(r.created_at)); } },
      ], d.items, { clickable: true, rowAttr: function (r) { return 'data-id="' + r.id + '"'; }, emptyTitle: 'No orders found', emptyText: 'Orders placed by retailers and distributors appear here.' }) + B.pager(d, 'orders');
      host.querySelectorAll('tr[data-id]').forEach(function (tr) { tr.addEventListener('click', function (e) { if (e.target.closest('[data-sel]')) return; open(tr.dataset.id); }); });
      host.querySelectorAll('[data-sel]').forEach(function (c) { c.addEventListener('change', function () { state.selected[c.dataset.sel] = c.checked; syncSel(); }); });
      host.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); load(); }); });
    } catch (e) { B.fail(host, e); }
  }

  /* ═════════ Order detail ═════════ */

  var ACTION_LABEL = { returned: 'Could not deliver — take back', approved: 'Approve order', rejected: 'Reject', cancelled: 'Cancel order', assigned: 'Assign', accepted: 'Accept', processing: 'Start processing', packed: 'Mark packed',
    dispatched: 'Dispatch', out_for_delivery: 'Out for delivery', delivered: 'Mark delivered', refunded: 'Record refund' };

  async function open(id) {
    var body = B.drawer('Order', null);
    try { render(body, await B.api.get('/orders/' + id)); } catch (e) { body.innerHTML = B.errorBox(e); }
  }

  function render(body, d) {
    var o = d.order;
    document.getElementById('b2bDrawerTitle').textContent = o.order_no;
    var interstate = Number(o.igst_total) > 0;
    var canAdjust = o.status === 'pending_admin_approval' && B.can('b2b.orders.approve');
    var next = d.nextStatuses.filter(function (s) { return !(o.status === 'assigned' && s === 'approved'); });
    var actions = next.map(function (s) {
      var danger = s === 'cancelled' || s === 'rejected' || s === 'returned';
      return '<button class="btn btn-' + (danger ? 'danger-ghost' : (s === next[0] ? 'primary' : 'ghost')) + ' btn-sm" data-go="' + s + '">' + esc(ACTION_LABEL[s] || B.label(s)) + '</button>'; }).join('');
    var margin = o.cost_total != null ? Number(o.taxable_total) - Number(o.cost_total) : null;

    var html = '<div class="detail-section"><div class="flex items-center gap-8 mb-16" style="flex-wrap:wrap">' + B.badge(o.status) +
      (Number(o.is_on_hold) ? '<span class="badge badge-hold no-dot">On hold</span>' : '') + (Number(o.is_first_order) ? '<span class="badge badge-flag no-dot">First order</span>' : '') +
      '<span class="td-muted">Placed ' + esc(B.dateTime(o.created_at)) + '</span></div>' +
      (Number(o.is_on_hold) ? '<div class="alert alert-warn">' + A.icon('alert') + '<span>On hold: ' + esc(o.hold_reason || '') + '</span></div>' : '') +
      '<div class="inline-actions" style="margin-top:0">' + actions +
        (B.can('b2b.orders.approve') && ['cancelled', 'rejected', 'refunded', 'delivered', 'partially_delivered', 'returned'].indexOf(o.status) === -1
          ? '<button class="btn btn-ghost btn-sm" id="holdBtn">' + (Number(o.is_on_hold) ? 'Release hold' : 'Put on hold') + '</button>' : '') +
      '</div>' + (!actions && !Number(o.is_on_hold) && o.seller_type === 'distributor' && ['assigned', 'accepted', 'processing', 'packed', 'dispatched', 'out_for_delivery'].indexOf(o.status) !== -1 && !B.can('b2b.orders.fulfil')
        ? '<div class="td-muted small mt-16">Fulfilment is handled by the distributor.</div>' : '') + '</div>';

    html += '<div class="detail-section"><div class="detail-title">Print</div><div class="flex gap-8" style="flex-wrap:wrap">' +
      '<button class="btn btn-primary btn-sm" data-print="label">' + A.icon('print') + 'Delivery label</button>' +
      '<button class="btn btn-ghost btn-sm" data-print="bill">' + A.icon('reports') + (d.invoice && d.invoice.status === 'final' ? 'Tax invoice' : 'Order summary') + '</button></div></div>';

    html += '<div class="split"><div class="detail-section"><div class="detail-title">Buyer · ' + esc(o.buyer_type) + '</div><div class="info-box"><strong>' + esc(o.buyer_name) + '</strong>' +
        (o.buyer_shop && o.buyer_shop !== o.buyer_name ? esc(o.buyer_shop) + '<br/>' : '') + esc(o.buyer_contact || '') + ' · <a href="tel:+91' + esc(o.ship_phone) + '">' + esc(A.fmt.phone(o.ship_phone)) + '</a><br/>' +
        'GSTIN: ' + esc(o.buyer_gstin || 'Unregistered') + '<br/><a href="accounts.html?open=' + o.buyer_account_id + '" style="color:var(--brand);text-decoration:underline">Open account & documents</a></div>' +
        (d.buyerRiskFlags ? '<div style="margin-top:8px"><span class="muted small">Risk flags: </span>' + B.flags(d.buyerRiskFlags) + '</div>' : '') + '</div>' +
      '<div class="detail-section"><div class="detail-title">Deliver to</div><div class="info-box"><strong>' + esc(o.ship_name) + '</strong>' +
        esc([o.ship_line1, o.ship_line2, o.ship_landmark].filter(Boolean).join(', ')) + '<br/>' + esc(o.ship_city) + ', ' + esc(o.ship_district || '') + '<br/>' + esc(o.ship_state) + ' · ' + esc(o.ship_pincode) +
        (o.ship_lat ? '<br/><a target="_blank" rel="noopener" style="color:var(--brand);text-decoration:underline" href="https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(o.ship_lat + ',' + o.ship_lng) + '">Get directions</a>' : '') + '</div></div></div>';

    html += '<div class="detail-section"><div class="detail-title">Supplied by</div><div class="info-box"><strong>' + (o.seller_type === 'company' ? esc(window.SOH_CONFIG.brand) + ' (direct)' : esc(o.seller_name)) + '</strong>' +
      (o.seller_type === 'company' ? 'Warehouse ' + esc(o.warehouse_code || '—') + ' · stock ' + (Number(o.stock_reserved) ? 'reserved' : 'not reserved') : esc(A.fmt.phone(o.seller_mobile || '')) + (Number(o.stock_reserved) ? ' · stock reserved' : '')) + '</div>' +
      (d.candidates && B.can('b2b.orders.approve') ? '<div class="inline-actions"><button class="btn btn-ghost btn-sm" id="sellerBtn">' + A.icon('network') + 'Change distributor</button></div>' : '') + '</div>';

    html += '<div class="detail-section"><div class="detail-title">Items</div>' + B.table([
      { label: 'Item', html: function (i) { return '<div class="td-strong">' + esc(i.name) + '</div><div class="td-muted td-mono">' + esc(i.sku) + (i.hsn_code ? ' · HSN ' + esc(i.hsn_code) : '') + '</div>'; } },
      { label: 'Qty', cls: 'num', html: function (i) { return canAdjust ? '<input class="input qty-input" type="number" min="0" max="' + i.qty + '" value="' + i.qty + '" data-qty="' + i.id + '"/>' :
        esc(i.qty) + (i.qty_delivered != null && Number(i.qty_delivered) !== Number(i.qty) ? '<div class="td-muted">' + i.qty_delivered + ' delivered</div>' : '') + (Number(i.qty_returned) ? '<div class="td-muted">' + i.qty_returned + ' returned</div>' : ''); } },
      { label: 'Rate', cls: 'num', html: function (i) { return B.money(i.unit_price) + (Number(i.list_price) !== Number(i.unit_price) ? '<div class="td-muted"><s>' + B.money(i.list_price) + '</s></div>' : '') +
        (i.price_source ? '<div class="td-muted small">' + esc(B.label(i.price_source)) + '</div>' : ''); } },
      { label: 'GST', cls: 'num hide-sm', html: function (i) { return esc(Number(i.gst_rate)) + '%'; } },
      { label: 'Amount', cls: 'num td-strong', html: function (i) { return B.money(i.line_total); } },
    ], d.items) + (canAdjust ? '<div class="inline-actions"><button class="btn btn-ghost btn-sm" id="qtyBtn">Save reduced quantities</button><span class="td-muted small">Quantities can be reduced or set to 0 to drop a line.</span></div>' : '') +
      '<dl style="margin-top:14px;border-top:1px solid var(--line-2);padding-top:12px">' +
        (Number(o.discount_total) ? '<div class="detail-row"><dt>Gross</dt><dd>' + B.money(o.subtotal) + '</dd></div><div class="detail-row"><dt>Trade discount</dt><dd>− ' + B.money(o.discount_total) + '</dd></div>' : '') +
        '<div class="detail-row"><dt>Taxable value</dt><dd>' + B.money(o.taxable_total) + '</dd></div>' +
        (interstate ? '<div class="detail-row"><dt>IGST</dt><dd>' + B.money(o.igst_total) + '</dd></div>'
          : '<div class="detail-row"><dt>CGST</dt><dd>' + B.money(o.cgst_total) + '</dd></div><div class="detail-row"><dt>SGST</dt><dd>' + B.money(o.sgst_total) + '</dd></div>') +
        (Number(o.round_off) ? '<div class="detail-row"><dt>Round off</dt><dd>' + B.money(o.round_off) + '</dd></div>' : '') +
        '<div class="detail-row" style="border-top:1px solid var(--line-2);margin-top:6px;padding-top:11px"><dt style="font-weight:700;color:var(--ink)">Total</dt><dd style="font-size:16px;font-weight:700">' + B.money(o.grand_total) + '</dd></div>' +
        (margin != null && o.seller_type === 'company' ? '<div class="detail-row"><dt>Company margin</dt><dd>' + B.money(margin) + ' (' + (Number(o.taxable_total) ? (margin / Number(o.taxable_total) * 100).toFixed(1) : '0') + '%)</dd></div>' : '') +
      '</dl>' + (o.buyer_notes ? '<div class="info-box" style="margin-top:10px"><strong>Buyer note</strong>' + esc(o.buyer_notes) + '</div>' : '') + '</div>';

    html += '<div class="detail-section"><div class="detail-title">Payment</div><dl class="kv"><dt>Method</dt><dd>' + esc(B.label(o.payment_method)) + '</dd><dt>Status</dt><dd>' + B.badge(o.payment_status) + '</dd>' +
      '<dt>Paid</dt><dd>' + B.money(o.amount_paid) + '</dd><dt>Outstanding</dt><dd><strong>' + B.money(d.outstanding) + '</strong></dd></dl>' +
      (d.payments.length ? B.table([
        { label: 'When', html: function (p) { return esc(B.dateTime(p.received_at)); } }, { label: 'Method', html: function (p) { return esc(B.label(p.method)) + (p.status === 'reversed' ? ' ' + B.badge('refunded') : ''); } },
        { label: 'Reference', cls: 'td-mono', html: function (p) { return esc(p.reference || '—'); } }, { label: 'Amount', cls: 'num', html: function (p) { return B.money(p.amount); } },
      ], d.payments) : '') +
      (B.can('b2b.payments.record') && Number(d.outstanding) > 0 && ['cancelled', 'rejected', 'refunded'].indexOf(o.status) === -1 ? '<div class="inline-actions"><button class="btn btn-ghost btn-sm" id="payBtn">' + A.icon('rupee') + 'Record payment</button></div>' : '') + '</div>';

    html += '<div class="detail-section"><div class="detail-title">Invoice</div>' + (d.invoice
      ? '<div class="info-box"><strong class="td-mono">' + esc(d.invoice.invoice_no) + ' ' + B.badge(d.invoice.status) + '</strong>Dated ' + esc(B.date(d.invoice.invoice_date)) + (d.invoice.due_date ? ' · due ' + esc(B.date(d.invoice.due_date)) : '') + '</div>' +
        (d.invoice.status === 'final' && B.can('b2b.invoices.create') ? '<div class="inline-actions"><button class="btn btn-danger-ghost btn-sm" id="invCancel">Cancel invoice (credit note)</button></div>' : '')
      : '<div class="info-box td-muted">No invoice yet — it is generated automatically at dispatch.</div>') +
      ((!d.invoice || d.invoice.status !== 'final') && B.can('b2b.invoices.create') && ['packed', 'dispatched', 'out_for_delivery', 'delivered', 'partially_delivered'].indexOf(o.status) !== -1
        ? '<div class="inline-actions"><button class="btn btn-ghost btn-sm" id="invGen">Generate invoice now</button></div>' : '') + '</div>';

    if (d.returns.length) html += '<div class="detail-section"><div class="detail-title">Returns</div>' + d.returns.map(function (r) {
      return '<div class="line-item" style="padding:8px 0"><div class="li-info"><strong class="td-mono">' + esc(r.return_no) + '</strong><span>' + esc(B.dateTime(r.created_at)) + '</span></div>' + B.badge(r.status) + '</div>'; }).join('') + '</div>';

    html += '<div class="detail-section"><div class="detail-title">Timeline</div><div class="stepper">' + d.history.map(function (h) {
      return '<div class="step done"><div class="step-dot">' + A.icon('check', 12) + '</div><div class="step-content"><strong>' + esc(B.label(h.to_status)) + '</strong><span>' + esc(B.dateTime(h.created_at)) + ' · ' + esc(h.actor_label || h.actor_type) + '</span>' +
        (h.note ? '<span>' + esc(h.note) + '</span>' : '') + '</div></div>'; }).join('') + '</div></div>';

    if (B.can('b2b.orders.approve') || B.can('b2b.orders.fulfil')) html += '<div class="detail-section"><div class="detail-title">Internal note</div><textarea class="textarea" id="noteBox" placeholder="Visible to staff only…">' + esc(o.internal_notes || '') +
      '</textarea><div class="inline-actions"><button class="btn btn-ghost btn-sm" id="noteBtn">Save note</button></div></div>';

    body.innerHTML = html;
    wire(body, d);
  }

  function wire(body, d) {
    var o = d.order, reload = function () { open(o.id); load(); A.loadBadges(); };
    var on = function (sel, fn) { var el = body.querySelector(sel); if (el) el.addEventListener('click', fn); };
    var post = function (path, payload, msg) { return B.api.post('/orders/' + o.id + path, payload).then(function (r) { A.toast(msg || 'Updated', 'success'); reload(); return r; }); };

    body.querySelectorAll('[data-print]').forEach(function (b) { b.addEventListener('click', function () { printDocs(b.dataset.print, [o.id]); }); });
    body.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () {
        var to = b.dataset.go;
        if (to === 'delivered') return deliverModal(d, reload);
        if (to === 'returned') {
          return B.askReason(b.textContent + ' — ' + o.order_no, 'Nothing was delivered: the goods go back to available stock and any credit is released. The buyer is notified. Use Mark delivered if part of it was accepted.',
            { danger: true, submit: 'Take the goods back' }, function (reason) { return post('/status', { status: to, note: reason }, 'Order returned to the warehouse'); });
        }
        if (to === 'cancelled' || to === 'rejected' || to === 'refunded') {
          return B.askReason(b.textContent + ' — ' + o.order_no, to === 'refunded' ? 'Records that ' + B.money(o.amount_paid) + ' has been paid back to the buyer.' : 'Reserved stock and credit are released. The buyer is notified.',
            { danger: true, submit: b.textContent, optional: to === 'refunded' }, function (reason) { return post('/status', { status: to, note: reason }, 'Order ' + B.label(to).toLowerCase()); });
        }
        b.disabled = true;
        post('/status', { status: to }, to === 'dispatched' ? 'Dispatched — invoice generated' : 'Status updated').catch(function (e) { A.toast(e.message, 'error'); b.disabled = false; });
      });
    });
    on('#holdBtn', function () {
      if (Number(o.is_on_hold)) return post('/hold', { hold: false }, 'Hold released').catch(function (e) { A.toast(e.message, 'error'); });
      B.askReason('Put ' + o.order_no + ' on hold', 'The order cannot move forward until the hold is released.', { submit: 'Hold order' }, function (reason) { return post('/hold', { hold: true, reason: reason }, 'Order on hold'); });
    });
    on('#qtyBtn', function () {
      var items = B.$$('[data-qty]', body).map(function (i) { return { order_item_id: Number(i.dataset.qty), qty: Number(i.value) }; });
      post('/quantities', { items: items }, 'Quantities updated').catch(function (e) { A.toast(e.message, 'error'); });
    });
    on('#sellerBtn', function () {
      var opts = [{ value: '', label: (window.SOH_CONFIG.brand || 'Company') + ' — supply directly' }].concat(d.candidates.map(function (c) {
        return { value: c.distributorId, label: '#' + c.rank + ' ' + c.name + ' — ' + B.label(c.matchedBy).toLowerCase() + ', ' + c.openOrders + ' open orders' + (c.atCapacity ? ' (at capacity)' : '') }; }));
      B.modal({ title: 'Change distributor — ' + o.order_no, submit: 'Change supplier',
        body: B.field('ns', 'Supply this order from', B.select('ns', opts, o.seller_account_id || ''), 'Stock, credit and the GST split move to the new supplier in one step.') +
          B.field('nr', 'Reason', '<textarea class="textarea" id="nr"></textarea>', 'Recorded in the audit log.'),
        onSubmit: function () { return post('/seller', { distributor_id: B.val('ns') || null, reason: B.val('nr') }, 'Supplier changed'); } });
    });
    on('#payBtn', function () {
      B.modal({ title: 'Record payment — ' + o.order_no, submit: 'Record payment', body: '<div class="form-grid">' +
        B.field('pm', 'Method', B.select('pm', ['bank_transfer', 'upi', 'cheque', 'cash', 'adjustment'], 'bank_transfer')) +
        B.field('pa', 'Amount (₹)', B.input('pa', d.outstanding, 'inputmode="decimal"'), 'Outstanding: ' + B.money(d.outstanding)) +
        B.field('pr', 'Reference (UTR / cheque no.)', B.input('pr', ''), '', 'wide') + B.field('pn', 'Note', B.input('pn', ''), '', 'wide') + '</div>',
        onSubmit: function () { return post('/payments', { method: B.val('pm'), amount: B.val('pa'), reference: B.val('pr'), note: B.val('pn') }, 'Payment recorded'); } });
    });
    on('#invGen', function () { post('/invoice', {}, 'Invoice generated').catch(function (e) { A.toast(e.message, 'error'); }); });
    on('#invCancel', function () {
      B.askReason('Cancel invoice ' + d.invoice.invoice_no, 'The invoice is kept as issued and a full credit note is raised against it. You can then generate a corrected invoice with a new number.',
        { danger: true, submit: 'Cancel invoice' }, async function (reason) { var r = await B.api.post('/invoices/' + d.invoice.id + '/cancel', { reason: reason }); A.toast('Cancelled — credit note ' + r.creditNoteNo, 'success'); reload(); });
    });
    on('#noteBtn', function () { B.api.put('/orders/' + o.id + '/note', { note: B.val('noteBox') }).then(function () { A.toast('Note saved', 'success'); }).catch(function (e) { A.toast(e.message, 'error'); }); });
  }

  function deliverModal(d, reload) {
    B.modal({ title: 'Mark delivered — ' + d.order.order_no, submit: 'Confirm delivery', wide: true,
      body: '<p class="mb-16">Enter what was actually delivered. If anything is short, a credit note is raised automatically and the undelivered units go back into stock.</p>' + B.table([
        { label: 'Item', html: function (i) { return esc(i.name) + '<div class="td-muted td-mono">' + esc(i.sku) + '</div>'; } },
        { label: 'Ordered', cls: 'num', html: function (i) { return esc(i.qty); } },
        { label: 'Delivered', cls: 'num', html: function (i) { return '<input class="input qty-input" type="number" min="0" max="' + i.qty + '" value="' + i.qty + '" data-del="' + i.id + '"/>'; } },
      ], d.items),
      onSubmit: async function () {
        var delivered = {}; B.$$('[data-del]').forEach(function (i) { delivered[i.dataset.del] = Number(i.value); });
        var r = await B.api.post('/orders/' + d.order.id + '/status', { status: 'delivered', delivered: delivered });
        A.toast(r.creditNote ? 'Partly delivered — credit note ' + r.creditNote.creditNoteNo : 'Delivered', 'success'); reload();
      } });
  }

  /* ═════════ Returns ═════════ */

  async function loadReturns(host) {
    var d = await B.api.get('/returns' + B.qs({ q: state.q, page: state.page, limit: 25 }));
    host.innerHTML = B.table([
      { label: 'Return', html: function (r) { return '<span class="td-mono td-strong">' + esc(r.return_no) + '</span><div class="td-muted td-mono">' + esc(r.order_no) + '</div>'; } },
      { label: 'Buyer', html: function (r) { return esc(r.buyer_shop || r.buyer_name); } },
      { label: 'Reason', cls: 'hide-sm', html: function (r) { return esc(r.reason); } },
      { label: 'Units', cls: 'num', html: function (r) { return esc(r.total_qty); } },
      { label: 'Handled by', cls: 'hide-sm', html: function (r) { return B.badge(r.seller_type, 'no-dot'); } },
      { label: 'Status', html: function (r) { return B.badge(r.status) + (r.resolution ? '<div class="td-muted">' + esc(B.label(r.resolution)) + '</div>' : ''); } },
      { label: 'Requested', cls: 'td-muted td-nowrap hide-sm', html: function (r) { return esc(A.fmt.relative(r.created_at)); } },
    ], d.items, { clickable: true, rowAttr: function (r) { return 'data-id="' + r.id + '"'; }, emptyTitle: 'No returns', emptyText: 'Return requests raised by buyers appear here.' }) + B.pager(d, 'returns');
    host.querySelectorAll('tr[data-id]').forEach(function (tr) { tr.addEventListener('click', function () { openReturn(tr.dataset.id); }); });
    host.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); load(); }); });
  }

  async function openReturn(id) {
    var body = B.drawer('Return', null);
    try {
      var d = await B.api.get('/returns/' + id), r = d.ret, manage = B.can('b2b.returns.manage');
      document.getElementById('b2bDrawerTitle').textContent = r.return_no;
      var inspecting = manage && (r.status === 'approved' || r.status === 'pickup_scheduled');
      body.innerHTML = '<div class="detail-section"><div class="flex items-center gap-8 mb-16">' + B.badge(r.status) + (r.resolution ? B.badge(r.resolution, 'no-dot') : '') + '<span class="td-muted">' + esc(B.dateTime(r.created_at)) + '</span></div>' +
        '<dl class="kv"><dt>Order</dt><dd class="td-mono">' + esc(r.order_no) + '</dd><dt>Buyer</dt><dd>' + esc(r.buyer_shop || r.buyer_name) + ' · ' + esc(A.fmt.phone(r.buyer_mobile)) + '</dd><dt>Reason</dt><dd>' + esc(r.reason) + '</dd>' +
        (r.inspection_note ? '<dt>Note</dt><dd>' + esc(r.inspection_note) + '</dd>' : '') + (r.credit_note_no ? '<dt>Credit note</dt><dd class="td-mono">' + esc(r.credit_note_no) + ' · ' + B.money(r.credit_note_total) + (Number(r.refund_amount) ? ' (refund due ' + B.money(r.refund_amount) + ')' : '') + '</dd>' : '') + '</dl></div>' +
        '<div class="detail-section"><div class="detail-title">Items</div>' + B.table([
          { label: 'Item', html: function (i) { return esc(i.name) + '<div class="td-muted td-mono">' + esc(i.sku) + '</div>'; } },
          { label: 'Requested', cls: 'num', html: function (i) { return esc(i.qty); } },
          { label: 'Accepted', cls: 'num', html: function (i) { return inspecting ? '<input class="input qty-input" type="number" min="0" max="' + i.qty + '" value="' + i.qty + '" data-acc="' + i.id + '"/>' : esc(i.qty_accepted == null ? '—' : i.qty_accepted); } },
          { label: 'Condition', html: function (i) { return inspecting ? B.select('cond' + i.id, ['good', 'damaged', 'expired'], 'good', 'data-cond="' + i.id + '"') : esc(i.item_condition ? B.label(i.item_condition) : '—'); } },
        ], d.items) + '</div>' +
        (manage ? '<div class="detail-section"><div class="inline-actions" style="margin-top:0">' +
          (r.status === 'requested' ? '<button class="btn btn-primary btn-sm" data-ract="approve">Approve return</button><button class="btn btn-danger-ghost btn-sm" data-ract="reject">Reject</button>' : '') +
          (r.status === 'approved' ? '<button class="btn btn-ghost btn-sm" data-ract="schedule_pickup">Pickup scheduled</button>' : '') +
          (inspecting ? '<button class="btn btn-primary btn-sm" data-ract="inspect">Goods received & inspected</button>' : '') +
          (r.status === 'received' ? B.select('resol', [{ value: 'credit_note', label: 'Credit note' }, { value: 'refund', label: 'Refund' }, { value: 'replacement', label: 'Replacement' }], 'credit_note', 'style="width:auto"') + '<button class="btn btn-primary btn-sm" data-ract="complete">Complete return</button>' : '') +
          '</div><div class="td-muted small mt-16">Accepted units go back into stock at inspection (good → available, damaged/expired → written off). Completing the return raises the credit note.</div></div>' : '');
      body.querySelectorAll('[data-ract]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.dataset.ract, done = function () { A.toast('Return updated', 'success'); openReturn(id); load(); };
          var run = function (payload) { return B.api.post('/returns/' + id + '/' + act, payload).then(done); };
          if (act === 'reject') return B.askReason('Reject return ' + r.return_no, '', { danger: true, submit: 'Reject' }, function (reason) { return run({ note: reason }); });
          var payload = {};
          if (act === 'inspect') payload.items = B.$$('[data-acc]', body).map(function (i) { return { return_item_id: Number(i.dataset.acc), qty_accepted: Number(i.value), condition: body.querySelector('[data-cond="' + i.dataset.acc + '"]').value }; });
          if (act === 'complete') payload.resolution = B.val('resol');
          b.disabled = true; run(payload).catch(function (e) { A.toast(e.message, 'error'); b.disabled = false; });
        });
      });
    } catch (e) { body.innerHTML = B.errorBox(e); }
  }

  shell(); load();
  if (params.get('open')) open(params.get('open'));
})();
