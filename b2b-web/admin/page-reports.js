(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-reports', 'B2B Reports', ['b2b.reports.view']))) return;
  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var REPORTS = [
    { id: 'sales', label: 'Sales', q: 'What are our monthly B2B sales?', opts: 'group' },
    { id: 'products', label: 'Products', q: 'Which products sell the most?' },
    { id: 'retailers', label: 'Retailers', q: 'Which retailer buys the most?' },
    { id: 'distributors', label: 'Distributors', q: 'Which distributor has the highest sales?' },
    { id: 'mapping', label: 'Mapping', q: 'Which distributor serves which retailers?', nodate: true },
    { id: 'geographic', label: 'Geographic', q: 'Which district performs best?', opts: 'level' },
    { id: 'inventory', label: 'Inventory', q: 'How much stock is available?', nodate: true },
    { id: 'gst', label: 'GST', q: 'GST collected by rate and supply type', opts: 'seller' },
    { id: 'margins', label: 'Margins', q: 'How much margin are we making?', perm: 'b2b.pricing.view' },
  ].filter(function (r) { return !r.perm || B.can(r.perm); });
  var today = new Date(), iso = function (d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  var state = { type: params.get('type') || 'sales', from: iso(new Date(today.getTime() - 29 * 86400000)), to: iso(today), group: 'day', level: params.get('level') || 'district', seller: 'company' };
  if (!REPORTS.some(function (r) { return r.id === state.type; })) state.type = 'sales';

  function current() { return REPORTS.filter(function (r) { return r.id === state.type; })[0]; }
  function query() { return B.qs({ from: state.from, to: state.to, group: state.group, level: state.level, seller: state.seller }); }

  function shell() {
    var r = current();
    document.getElementById('topbarActions').innerHTML = '<button class="btn btn-ghost btn-sm" id="csvBtn">' + A.icon('download') + 'CSV</button><button class="btn btn-ghost btn-sm" id="xlsBtn">' + A.icon('download') + 'Excel</button>';
    var dl = function (fmt) { return function () { B.download('/export/' + state.type + query() + '&format=' + fmt).catch(function (e) { A.toast(e.message, 'error'); }); }; };
    B.$('#csvBtn').addEventListener('click', dl('csv')); B.$('#xlsBtn').addEventListener('click', dl('xlsx'));
    var preset = function (days, label) { return '<button class="tab" data-days="' + days + '">' + label + '</button>'; };
    content.innerHTML = B.tabsHtml(REPORTS, state.type) + '<div class="b2b-filters">' +
      (r.nodate ? '<span class="muted">Current position — no date range.</span>' : '<input class="input" type="date" id="from" value="' + state.from + '"/><span class="muted">to</span><input class="input" type="date" id="to" value="' + state.to + '"/>' +
        '<div class="tabs">' + preset(7, '7 days') + preset(30, '30 days') + preset(90, '90 days') + preset(365, '1 year') + '</div>') +
      (r.opts === 'group' ? B.select('group', [{ value: 'day', label: 'By day' }, { value: 'month', label: 'By month' }], state.group) : '') +
      (r.opts === 'level' ? B.select('level', [{ value: 'state', label: 'By state' }, { value: 'district', label: 'By district' }, { value: 'city', label: 'By city' }, { value: 'pincode', label: 'By pincode' }], state.level) : '') +
      (r.opts === 'seller' ? B.select('seller', [{ value: 'company', label: 'Company invoices only' }, { value: 'all', label: 'Company + distributor invoices' }], state.seller) : '') +
      '</div><div class="card"><div class="card-head"><h2>' + esc(r.q) + '</h2></div><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.type = b.dataset.tab; shell(); load(); }); });
    content.querySelectorAll('[data-days]').forEach(function (b) { b.addEventListener('click', function () { state.to = iso(new Date()); state.from = iso(new Date(Date.now() - (Number(b.dataset.days) - 1) * 86400000)); shell(); load(); }); });
    ['from', 'to', 'group', 'level', 'seller'].forEach(function (id) { var el = B.$('#' + id); if (el) el.addEventListener('change', function () { state[id] = el.value; load(); }); });
  }

  async function load() {
    var host = B.$('#host');
    try {
      var d = await B.api.get('/reports/' + state.type + query());
      var totals = d.totals || {};
      var chart = state.type === 'sales' && d.rows.length > 1
        ? '<div style="padding:18px 20px 0">' + A.lineChart(d.rows.map(function (r) { return { date: String(r.period).length === 7 ? r.period + '-01' : r.period, revenue: Number(r.total) }; }), { money: true, height: 220 }) + '</div>' : '';
      host.innerHTML = chart + B.table(d.columns.map(function (c) {
        return { label: c.label, cls: c.type === 'money' || c.type === 'number' ? 'num' : '', html: function (r) {
          var v = r[c.key];
          if (v == null || v === '') return '<span class="muted">—</span>';
          if (c.type === 'money') return B.money(v);
          if (c.type === 'number') return esc(Number(v).toLocaleString('en-IN'));
          if (c.type === 'date') return esc(String(v).length === 7 ? v : B.date(v));
          return esc(v);
        } };
      }), d.rows, { icon: 'reports', emptyTitle: 'No data for this period', emptyText: 'Try a wider date range.' }) +
        (d.rows.length ? '<div style="padding:12px 16px;border-top:1px solid var(--line-2);display:flex;gap:18px;flex-wrap:wrap;font-size:13px"><strong>' + Number(d.total).toLocaleString('en-IN') + ' rows</strong>' + (d.truncated ? '<span class="muted">showing the first ' + d.rows.length + ' — use CSV or Excel for the full list</span>' : '') +
          d.columns.filter(function (c) { return totals[c.key] != null; }).map(function (c) { return '<span><span class="muted">' + esc(c.label) + ':</span> <strong>' + (c.type === 'money' ? B.money(totals[c.key]) : Number(totals[c.key]).toLocaleString('en-IN')) + '</strong></span>'; }).join('') + '</div>' : '');
    } catch (e) { B.fail(host, e); }
  }
  shell(); load();
})();
