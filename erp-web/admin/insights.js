/* Business platform admin — Smart Insights (no outside service, no cost): the week in sentences,
   sales forecast, stock-out and reorder advice, customer segments, unusual activity, and products
   bought together. Read only. Text via textContent only; the server checks every permission again. */
(function () {
  'use strict';
  var E = window.ERP, el = E.el, api = E.api, msg = E.msg, table = E.table, kpi = E.kpi, has = E.has;
  var I = '/api/erp/insights';

  function section(title, kids) { return el('section', { class: 'panel' }, [el('h2', { text: title })].concat(kids)); }
  function note(text) { return el('p', { class: 'note', text: text }); }
  function money(v) { return v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  function num(v) { return v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 }); }
  function tag(text, kind) { return el('span', { class: 'tag' + (kind ? ' ' + kind : ''), text: text }); }
  function err(box) { return function (e) { box.replaceChildren(msg('err', e.message)); }; }
  function loading(box) { box.replaceChildren(note('Working it out…')); }

  /** Eight weekly bars (oldest first), drawn in the page's own colour. */
  function spark(values) {
    var NS = 'http://www.w3.org/2000/svg', w = 88, hgt = 22, n = values.length || 1, bw = w / n, max = Math.max.apply(null, values.concat([1]));
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hgt); svg.setAttribute('width', String(w)); svg.setAttribute('height', String(hgt));
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Units sold per week, last ' + n + ' weeks: ' + values.join(', '));
    values.forEach(function (v, i) {
      var bh = Math.max(v > 0 ? 2 : 0, Math.round((v / max) * (hgt - 2)));
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', String(i * bw + 1)); r.setAttribute('y', String(hgt - bh)); r.setAttribute('width', String(Math.max(1, bw - 2))); r.setAttribute('height', String(bh));
      r.setAttribute('rx', '1'); r.setAttribute('fill', i === n - 1 ? 'var(--brand, #3f7a2a)' : 'var(--ink-3, #8a8f98)');
      svg.appendChild(r);
    });
    return svg;
  }

  function sources(list) {
    if (!list || !list.length) return null;
    return note('Data used: ' + list.map(function (s) { return s.name + (s.included ? '' : ' (not available)'); }).join(' · ') +
      (list.filter(function (s) { return s.note; }).map(function (s) { return ' ' + s.note; }).join('')));
  }

  var STATUS = {
    out_of_stock: ['Out of stock', 'bad'], order_now: ['Order now', 'bad'], order_soon: ['Order soon', 'pending'],
    ok: ['Enough stock', 'ok'], no_recent_sales: ['No recent sales', ''], no_stock_no_sales: ['No stock, no sales', ''],
  };
  var TREND = { rising: ['Rising', 'ok'], falling: ['Falling', 'bad'], steady: ['Steady', ''], new: ['New', 'pending'], 'no sales': ['No sales', ''] };
  var CONF = { high: 'High', medium: 'Medium', low: 'Low', none: '—' };
  var SEGMENT = { Champion: 'ok', Loyal: 'ok', New: 'pending', Occasional: '', 'At risk': 'pending', Lost: 'bad' };

  /* ── Overview ── */
  function overview(body) {
    var box = el('div'); body.appendChild(box); loading(box);
    api('GET', I + '/summary').then(function (s) {
      var kids = [];
      kids.push(section('This week at a glance', s.sentences.length ? s.sentences.map(function (t) { return el('p', { text: t }); }) : [note('Not enough data yet.')]));
      var k = [];
      if (s.sections.sales) { k.push(kpi('Sales, last 7 days', money(s.sections.sales.revenue7))); k.push(kpi('Orders, last 7 days', s.sections.sales.orders7)); k.push(kpi('Unusual activity', s.sections.sales.alerts)); }
      if (s.sections.stock) { k.push(kpi('Order now', s.sections.stock.outOfStock + s.sections.stock.orderNow)); k.push(kpi('Order soon', s.sections.stock.orderSoon)); }
      if (s.sections.customers) { k.push(kpi('Customers at risk', s.sections.customers['At risk'] || 0)); k.push(kpi('Champions', s.sections.customers.Champion || 0)); }
      if (k.length) kids.push(el('div', { class: 'grid' }, k));
      if (s.sections.sales) { var src = sources(s.sections.sales.sources); if (src) kids.push(src); }
      kids.push(note('Smart Insights are calculated on this server from your own sales, stock and purchase records. No data leaves the site and nothing is charged. They are estimates: check them before you act.'));
      box.replaceChildren.apply(box, kids);
    }).catch(err(box));
  }

  /* ── Sales forecast ── */
  function forecast(body) {
    if (!has('sales.reports.view')) { body.appendChild(note('Your role cannot see sales figures.')); return; }
    var box = el('div'); body.appendChild(box); loading(box);
    api('GET', I + '/forecast').then(function (f) {
      var rows = f.items.map(function (p) {
        var t = TREND[p.trend] || [p.trend, ''];
        return [p.name + ' (' + p.sku + ')', spark(p.lastWeeks), num(p.perWeek), String(p.forecast30), p.forecastLow + '–' + p.forecastHigh,
          el('span', {}, [tag(t[0], t[1]), p.changePct == null ? '' : ' ' + (p.changePct > 0 ? '+' : '') + p.changePct + '%']), CONF[p.confidence] || p.confidence];
      });
      box.replaceChildren(section('Sales forecast — next 30 days', [
        note('Expected units per product, from the last ' + f.defaults.weeksOfHistory + ' weeks of sales (trend-adjusted). The range covers about 8 in 10 outcomes. Confidence is low when there are few weeks of sales or sales jump around.'),
        table(['Product', 'Last 8 weeks', 'Per week now', 'Next 30 days', 'Likely range', 'Trend', 'Confidence'], rows),
        f.notSelling ? note(f.notSelling + ' active product' + (f.notSelling === 1 ? ' has' : 's have') + ' no sales in the last ' + f.defaults.weeksOfHistory + ' weeks and ' + (f.notSelling === 1 ? 'is' : 'are') + ' not listed.') : '',
        sources(f.sources) || '']));
    }).catch(err(box));
  }

  /* ── Stock & reorder ── */
  function stock(body) {
    if (!has('inventory.view')) { body.appendChild(note('Your role cannot see stock.')); return; }
    var box = el('div'); body.appendChild(box); loading(box);
    api('GET', I + '/stock').then(function (s) {
      var c = s.counts;
      var rows = s.items.map(function (p) {
        var st = STATUS[p.status] || [p.status, ''];
        return [p.name + ' (' + p.sku + ')', tag(st[0], st[1]), String(p.available), p.daysOfCover == null ? '—' : num(p.daysOfCover) + ' days',
          p.stockOutDate || '—', String(p.inTransit + p.onOrder), p.leadDays + ' days' + (p.leadDaysAssumed ? ' (assumed)' : ''), p.orderQty ? String(p.orderQty) : '—'];
      });
      box.replaceChildren(
        el('div', { class: 'grid' }, [kpi('Out of stock', c.outOfStock), kpi('Order now', c.orderNow), kpi('Order soon', c.orderSoon), kpi('Enough stock', c.ok), kpi('Slow or no sales', c.slowOrNoSales)]),
        section('Stock-out prediction and reorder advice', [
          note('Stock in company warehouses (available minus reserved) against the forecast. "Order now" means the stock runs out before a new delivery could arrive. ' +
            'Suggested quantity = demand over the lead time + ' + s.defaults.coverDays + ' days, plus safety stock, minus what is in stock, in transit or already on order; rounded up to whole cases. ' +
            'Lead time comes from approved supplier products, otherwise ' + s.defaults.leadDays + ' days is assumed.'),
          table(['Product', 'Status', 'Available', 'Lasts', 'Runs out on', 'Coming in', 'Lead time', 'Suggested order'], rows),
          note('To act on a suggestion, raise a purchase requisition under Procurement & Suppliers → Purchasing.')]));
    }).catch(err(box));
  }

  /* ── Customers ── */
  function customers(body) {
    if (!has('customers.view')) { body.appendChild(note('Your role cannot see customers.')); return; }
    var box = el('div'); body.appendChild(box); loading(box);
    api('GET', I + '/customers').then(function (c) {
      var order = ['Champion', 'Loyal', 'New', 'Occasional', 'At risk', 'Lost'];
      var rows = c.items.map(function (a) {
        return [a.name, a.type, tag(a.segment, SEGMENT[a.segment]), String(a.churnRisk) + '%', a.lastOrder + ' (' + a.daysSinceLastOrder + ' days ago)',
          'every ~' + a.usualGapDays + ' days', money(a.value90), a.valueTrendPct == null ? '—' : (a.valueTrendPct > 0 ? '+' : '') + a.valueTrendPct + '%'];
      });
      box.replaceChildren(
        el('div', { class: 'grid' }, order.map(function (k) { return kpi(k, c.segments[k] || 0); })),
        section('Business customers — segments and churn risk', [
          note('From each retailer\'s and distributor\'s trade orders in the last year. Churn risk grows when the time since the last order is longer than that customer\'s usual gap between orders. ' +
            'Champion: frequent and in the top quarter by value. At risk: overdue by more than half their usual gap. Lost: overdue three times their usual gap and silent for 60+ days.'),
          table(['Customer', 'Type', 'Segment', 'Churn risk', 'Last order', 'Usually orders', 'Value, last 90 days', 'vs previous 90'], rows)]));
    }).catch(err(box));
  }

  /* ── Alerts ── */
  function alerts(body) {
    if (!has('sales.reports.view')) { body.appendChild(note('Your role cannot see sales figures.')); return; }
    var box = el('div'); body.appendChild(box); loading(box);
    api('GET', I + '/alerts').then(function (a) {
      var dayRows = a.days.map(function (d) { return [d.day, tag(d.kind === 'spike' ? 'Unusually high' : 'Unusually low', d.kind === 'spike' ? 'pending' : 'bad'), money(d.value), money(d.normal)]; });
      var orderRows = a.orders.map(function (o) {
        return [o.day, o.orderNo || ('#' + o.orderId), o.accountName,
          o.kind === 'below_cost' ? tag('Sold below cost', 'bad') : tag('Much larger than usual', 'pending'), money(o.total),
          o.kind === 'below_cost' ? 'cost ' + money(o.cost) + ' vs ' + money(o.taxable) + ' before tax' : 'usual order ' + money(o.usual)];
      });
      box.replaceChildren(
        section('Days with unusual sales (last 14 days)', [note('Compared with the 8 weeks before each day. Shows days far above or below normal (robust statistics, so one odd day does not hide another).'),
          table(['Day', 'What', 'Sales that day', 'Normal day'], dayRows)]),
        section('Orders to check (last 30 days)', [note('Orders far larger than that customer\'s usual order (at least 3 times their median, after 3 earlier orders), and orders whose recorded cost is higher than their price before tax.'),
          table(['Day', 'Order', 'Customer', 'What', 'Order total', 'Detail'], orderRows)]));
    }).catch(err(box));
  }

  /* ── Product suggestions ── */
  function suggestions(body) {
    if (!has('sales.reports.view')) { body.appendChild(note('Your role cannot see sales figures.')); return; }
    var box = el('div'); body.appendChild(box); loading(box);
    api('GET', I + '/recommendations').then(function (r) {
      var pairRows = r.pairs.map(function (p) { return [p.aName, p.bName, String(p.together), Math.round(p.confidenceAB * 100) + '%', Math.round(p.confidenceBA * 100) + '%', num(p.lift) + '×']; });
      var accRows = r.accounts.map(function (a) { return [a.accountName, a.suggestions.map(function (s) { return s.name + ' (with ' + s.because + ')'; }).join('; ')]; });
      box.replaceChildren(
        section('Products bought together', [note('From ' + r.orders + ' trade orders in the last year. "' + 'A → B' + '" is how often an order with A also has B. Lift above 1× means they go together more than chance.'),
          table(['Product A', 'Product B', 'Orders with both', 'A → B', 'B → A', 'Lift'], pairRows)]),
        section('Suggestions for each customer', [note('Products a customer does not buy yet but that usually go with what they do buy. Useful for the sales team and the field app.'),
          table(['Customer', 'Suggest'], accRows)]));
    }).catch(err(box));
  }

  function render(main) {
    main.appendChild(el('h1', { text: 'Smart Insights' }));
    var list = [['overview', 'Overview', overview], ['forecast', 'Sales forecast', forecast], ['stock', 'Stock & reorder', stock],
      ['customers', 'Customers', customers], ['alerts', 'Alerts', alerts], ['suggest', 'Product suggestions', suggestions]];
    var bar = el('div', { class: 'ntabs', role: 'tablist', 'aria-label': 'Smart Insights sections' }), body = el('div', { class: 'nbody' });
    function go(k) {
      Array.prototype.forEach.call(bar.children, function (b) { b.setAttribute('aria-selected', b.dataset.k === k ? 'true' : 'false'); b.className = 'ntab' + (b.dataset.k === k ? ' on' : ''); });
      body.replaceChildren();
      list.filter(function (t) { return t[0] === k; })[0][2](body);
    }
    list.forEach(function (t) { var b = el('button', { type: 'button', role: 'tab', class: 'ntab', text: t[1], on: { click: function () { go(t[0]); } } }); b.dataset.k = t[0]; bar.appendChild(b); });
    main.appendChild(bar); main.appendChild(body);
    go('overview');
  }

  window.ERP_VIEWS.push({ id: 'insights', label: 'Smart Insights', perm: 'reports.export', render: render });
})();
