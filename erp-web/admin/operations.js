/* Business platform admin — operations screens: online-shop stock (3b.3/3b.4), events and counter
   sales (3b.5), field and event locations (3b.2), offline sync (3b.6) and all customers (N4).
   Text via textContent only; the server checks every permission again. */
(function () {
  'use strict';
  var E = window.ERP, el = E.el, api = E.api, msg = E.msg, fmt = E.fmt, table = E.table, kpi = E.kpi;
  var B = '/api/erp';
  function err(box) { return function (e) { box.prepend(msg('err', e.message)); }; }
  function btn(text, onClick, kind) { return el('button', { class: 'btn' + (kind ? ' ' + kind : ''), type: 'button', text: text, on: { click: onClick } }); }
  function input(label, attrs) { var i = el('input', Object.assign({ 'aria-label': label }, attrs || {})); return { node: el('label', {}, [label, i]), input: i }; }
  function select(label, opts, value) {
    var s = el('select', { 'aria-label': label }, opts.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    if (value != null) s.value = value;
    return { node: el('label', {}, [label, s]), input: s };
  }
  function section(title, kids) { return el('section', { class: 'panel' }, [el('h2', { text: title })].concat(kids)); }
  function money(v) { return v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function tabs(list, draw) {
    var bar = el('div', { class: 'ntabs', role: 'tablist' }), body = el('div', { class: 'nbody' }), current = list[0][0];
    function go(k) {
      current = k;
      Array.prototype.forEach.call(bar.children, function (b) { b.setAttribute('aria-selected', b.dataset.k === k ? 'true' : 'false'); b.className = 'ntab' + (b.dataset.k === k ? ' on' : ''); });
      body.replaceChildren(); draw(k, body);
    }
    list.forEach(function (t) { var b = el('button', { type: 'button', role: 'tab', class: 'ntab', text: t[1], on: { click: function () { go(t[0]); } } }); b.dataset.k = t[0]; bar.appendChild(b); });
    return { node: el('div', {}, [bar, body]), go: go, current: function () { return current; } };
  }
  function ask(text) { var v = window.prompt(text); return v == null ? null : v.trim(); }
  function openHtml(path, download) {
    // invoices are HTML documents fetched with the staff token, then shown or saved
    var h = { Accept: 'text/html' }, t = window.ERP.state && window.ERP.state.token;
    if (t) h.Authorization = 'Bearer ' + t;
    fetch(path + (download ? (path.indexOf('?') === -1 ? '?' : '&') + 'download=1' : ''), { headers: h, credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('Could not open the invoice (' + r.status + ')');
      return r.text();
    }).then(function (html) {
      var blob = new Blob([html], { type: 'text/html' }), url = URL.createObjectURL(blob);
      if (download) { var a = el('a', { href: url, download: 'invoice.html' }); document.body.appendChild(a); a.click(); a.remove(); }
      else window.open(url, '_blank', 'noopener');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (e) { window.alert(e.message); });
  }

  // ── Online shop stock (3b.3 shadow, 3b.4 enforcement) ──
  var MODE_TEXT = { off: 'Off — the shop works exactly as before; the ledger is not involved.', shadow: 'Shadow — nothing is refused and no stock moves; every checkout and order is replayed to show what enforcement would do.',
    enforce: 'Enforced — stock is held at Pay, committed before the order exists, deducted when it leaves, released or returned when cancelled.' };
  function shopStock(main) {
    main.appendChild(el('h1', { text: 'Online shop stock' }));
    var top = el('div'), t = tabs([['lines', 'Order lines'], ['holds', 'Holds'], ['disc', 'Discrepancies'], ['exc', 'Paid but short']], drawTab);
    main.appendChild(top); main.appendChild(t.node);
    function loadTop() {
      api('GET', B + '/shop-stock/overview').then(function (o) {
        var kids = [el('p', {}, [el('b', { text: 'Mode: ' + o.mode + '. ' }), MODE_TEXT[o.mode] || '']),
          el('div', { class: 'grid' }, [kpi('Products mapped to the shop', o.mapped + ' of ' + o.shopProducts), kpi('Open holds', o.openHolds), kpi('Open discrepancies', o.openDiscrepancies), kpi('Refunds to settle', o.openExceptions)]),
          el('p', { class: 'note', text: 'Warehouse: ' + (o.warehouse ? o.warehouse.code + ' — ' + o.warehouse.name : 'not chosen') + ' · Holds last ' + o.holdMinutes + ' minutes · Automatic refunds: ' + (o.autoRefund ? 'on' : 'off (staff press Refund)') +
            (o.lastSync ? ' · Last catch-up ' + fmt(o.lastSync.last_run_at) : '') }),
          el('p', { class: 'note', text: 'The mode, warehouse and hold time are business decisions: change them under Administration → Business Decisions (a second person approves).' })];
        if (o.blockers.length) kids.push(msg('warn', 'Before enforcing: ' + o.blockers.join(' ')));
        else kids.push(msg('ok', 'Ready to enforce: every shop product is mapped and the warehouse is set.'));
        if (E.has('shop_stock.resolve')) kids.push(btn('Run the catch-up now', function () {
          api('POST', B + '/shop-stock/sync', {}).then(function (r) { top.prepend(msg('ok', 'Catch-up: ' + JSON.stringify(r))); loadTop(); t.go(t.current()); }).catch(err(top));
        }));
        top.replaceChildren(section('Status', kids));
      }).catch(err(top));
    }
    function drawTab(k, body) {
      if (k === 'lines') {
        var mode = select('Mode', [['', 'Live and shadow'], ['live', 'Live'], ['shadow', 'Shadow']]), stage = select('Stage', [['', 'Any stage'], ['allocated', 'Allocated'], ['sold', 'Sold'], ['released', 'Released'], ['returned', 'Returned'], ['short', 'Short']]);
        var q = input('Order number'), box = el('div');
        var load = function () {
          api('GET', B + '/shop-stock/lines?mode=' + mode.input.value + '&stage=' + stage.input.value + '&q=' + encodeURIComponent(q.input.value)).then(function (r) {
            box.replaceChildren(table(['Order', 'Product', 'Qty', 'Stage', 'Shop status', 'Batches', 'Updated', ''], r.items.map(function (x) {
              var act = x.mode === 'live' && x.stage === 'sold' && E.has('shop_stock.resolve') ? btn('Record return', function () {
                var cond = ask('Condition: quarantine (to inspect), damaged or expired'); if (!cond) return;
                var why = ask('Reason (at least 5 characters)'); if (!why) return;
                api('POST', B + '/shop-stock/lines/' + x.id + '/return', { condition: cond, reason: why }).then(load).catch(err(box));
              }) : el('span');
              return [(x.shopOrderNo || x.shopOrderId) + (x.mode === 'shadow' ? ' (shadow)' : ''), x.sku + ' ' + x.name, String(x.qty), x.stage, x.shopStatus || '—',
                x.batches.map(function (b) { return (b.batchNo || 'no batch') + ' × ' + b.qty; }).join(', ') || '—', fmt(x.updatedAt), act];
            })));
          }).catch(err(box));
        };
        body.appendChild(el('div', { class: 'row' }, [mode.node, stage.node, q.node, btn('Show', load)])); body.appendChild(box); load();
      }
      if (k === 'holds') {
        var st = select('Status', [['held', 'Held'], ['committed', 'Committed'], ['expired', 'Expired'], ['released', 'Released'], ['short', 'Short'], ['', 'All']]), hb = el('div');
        var lh = function () { api('GET', B + '/shop-stock/holds?status=' + st.input.value).then(function (r) {
          hb.replaceChildren(table(['Checkout', 'Mode', 'Product', 'Qty', 'Status', 'Expires'], r.items.map(function (x) { return [x.ref, x.mode, x.sku + ' ' + x.name, String(x.qty), x.status, fmt(x.expiresAt)]; })));
        }).catch(err(hb)); };
        body.appendChild(el('div', { class: 'row' }, [st.node, btn('Show', lh)])); body.appendChild(hb); lh();
      }
      if (k === 'disc') {
        var ds = select('Status', [['open', 'Open'], ['explained', 'Explained'], ['resolved', 'Resolved']]), db = el('div');
        var KIND = { unmapped_product: 'Shop product not mapped', stock_mismatch: 'Shop figure ≠ ledger', would_refuse: 'Enforcement would refuse', order_without_hold: 'Order the ledger could not cover' };
        var ld = function () { api('GET', B + '/shop-stock/discrepancies?status=' + ds.input.value).then(function (r) {
          db.replaceChildren(table(['What', 'Product', 'Shop', 'Ledger', 'Details', 'Last seen', ''], r.items.map(function (x) {
            var act = x.status === 'open' && E.has('shop_stock.resolve') ? el('div', { class: 'row' }, [btn('Explain', function () { var n = ask('What was found?'); if (n) api('POST', B + '/shop-stock/discrepancies/' + x.id + '/explain', { note: n }).then(ld).catch(err(db)); }),
              btn('Resolved', function () { var n = ask('How was it fixed?'); if (n) api('POST', B + '/shop-stock/discrepancies/' + x.id + '/explain', { note: n, resolved: true }).then(ld).catch(err(db)); })]) : el('span', { text: x.note || '' });
            return [KIND[x.kind] || x.kind, x.sku ? x.sku + ' ' + x.name : x.ref, x.shopQty == null ? '—' : String(x.shopQty), x.ledgerQty == null ? '—' : String(x.ledgerQty), x.details || '', fmt(x.lastSeenAt), act];
          })));
        }).catch(err(db)); };
        body.appendChild(el('div', { class: 'row' }, [ds.node, btn('Show', ld)])); body.appendChild(db); ld();
      }
      if (k === 'exc') {
        var eb = el('div');
        var le = function () { api('GET', B + '/shop-stock/exceptions').then(function (r) {
          eb.replaceChildren(el('p', { class: 'note', text: 'A customer paid but the ledger had no stock: no order is created and the payment is refunded (decision 3). Refunding needs two-factor sign-in.' }),
            table(['Checkout', 'Payment', 'Amount', 'Short', 'Status', 'Refund', ''], r.items.map(function (x) {
              var acts = el('div', { class: 'row' });
              if (['open', 'refund_failed'].indexOf(x.status) !== -1 && E.has('shop_stock.refund.pay')) acts.appendChild(btn('Refund', function () {
                if (!window.confirm('Refund ' + money(x.amount) + ' to payment ' + x.paymentId + '?')) return;
                api('POST', B + '/shop-stock/exceptions/' + x.id + '/refund', {}).then(le).catch(err(eb));
              }, 'primary'));
              if (x.status !== 'refunded' && E.has('shop_stock.resolve')) acts.appendChild(btn('Close with a note', function () {
                var n = ask('How was it settled? (e.g. refunded in the Razorpay dashboard, or the customer agreed to wait)'); if (!n) return;
                api('POST', B + '/shop-stock/exceptions/' + x.id + '/close', { note: n, backorder: /wait|backorder/i.test(n) }).then(le).catch(err(eb));
              }));
              return [x.ref, x.paymentId || '—', money(x.amount), (x.details && x.details.short || []).map(function (s) { return s.name + ' ' + s.left + '/' + s.wanted; }).join(', '), x.status, x.refundRef || x.refundError || '—', acts];
            })));
        }).catch(err(eb)); };
        body.appendChild(eb); le();
      }
    }
    loadTop(); t.go('lines');
  }

  // ── Events and counter sales (3b.5) ──
  function events(main) {
    main.appendChild(el('h1', { text: 'Events & counter sales' }));
    main.appendChild(el('p', { class: 'note', text: 'Each event has its own stock point. Move stock in and out with a transfer (Stock & batches). Event staff see and sell only at their events.' }));
    var top = el('div'), detail = el('div'); main.appendChild(top); main.appendChild(detail);
    function list() {
      api('GET', B + '/events').then(function (r) {
        var kids = [table(['Event', 'Dates', 'Venue', 'Status', 'Invoices', 'Revenue', ''], r.items.map(function (e) {
          return [e.code + ' — ' + e.name, e.startsOn + ' → ' + e.endsOn, [e.venue, e.city].filter(Boolean).join(', ') || '—', e.status, String(e.sales), money(e.revenue), btn('Open', function () { open(e.id); })];
        }))];
        if (E.has('events.manage')) {
          var code = input('Code'), name = input('Name'), venue = input('Venue'), city = input('City'), from = input('Starts', { type: 'date' }), to = input('Ends', { type: 'date' }), pre = input('Invoice prefix', { value: 'EV', maxlength: '5' });
          var out = el('div');
          kids.push(el('h3', { text: 'New event' }), el('div', { class: 'row' }, [code.node, name.node, venue.node, city.node]), el('div', { class: 'row' }, [from.node, to.node, pre.node, btn('Create event', function () {
            api('POST', B + '/events', { code: code.input.value, name: name.input.value, venue: venue.input.value, city: city.input.value, startsOn: from.input.value, endsOn: to.input.value, invoicePrefix: pre.input.value })
              .then(function (e) { list(); open(e.id); }).catch(err(out));
          }, 'primary')]), out);
        }
        top.replaceChildren(section('Events', kids));
        reportBox();
      }).catch(err(top));
    }
    function reportBox() {
      if (!E.has('events.reports.view')) return;
      var rb = el('div');
      api('GET', B + '/events/report').then(function (r) {
        rb.replaceChildren(el('div', { class: 'grid' }, [kpi('Invoices', r.totals.invoices), kpi('Revenue', money(r.totals.revenue)), kpi('Tax', money(r.totals.tax)), kpi('Collected', money(r.totals.collected))]),
          table(['Event', 'Invoices', 'Units', 'Revenue'], r.byEvent.map(function (x) { return [x.code + ' ' + x.name, String(x.invoices), String(x.units), money(x.revenue)]; })),
          table(['Payment method', 'Net received'], r.byMethod.map(function (x) { return [x.method, money(x.net)]; })),
          table(['Returned as', 'Units', 'Refunded'], r.returns.map(function (x) { return [x.item_condition, String(x.units), money(x.refunded)]; })));
      }).catch(err(rb));
      top.appendChild(section('All events: sales report', [rb]));
    }
    function open(id) {
      detail.replaceChildren(el('p', { class: 'note', text: 'Loading…' }));
      Promise.all([api('GET', B + '/events/' + id), api('GET', B + '/events/' + id + '/stock'), api('GET', B + '/events/sales?eventId=' + id)]).then(function (x) {
        var ev = x[0], stock = x[1], sales = x[2], kids = [];
        var acts = el('div', { class: 'row' });
        if (E.has('events.manage')) {
          ({ planned: ['open', 'closed'], open: ['closed'], closed: [] }[ev.status] || []).forEach(function (s) {
            acts.appendChild(btn(s === 'open' ? 'Open for sales' : 'Close event', function () { if (window.confirm('Mark ' + ev.code + ' as ' + s + '?')) api('POST', B + '/events/' + id + '/status', { status: s }).then(function () { open(id); list(); }).catch(err(detail)); }));
          });
          acts.appendChild(btn('Set staff (ids)', function () {
            var v = ask('Staff ids allowed to sell here, separated by commas (current: ' + ev.staff.map(function (s) { return s.id; }).join(', ') + ')'); if (v == null) return;
            api('PUT', B + '/events/' + id + '/staff', { staffIds: v.split(',').map(function (s) { return Number(s.trim()); }).filter(Boolean) }).then(function () { open(id); }).catch(err(detail));
          }));
        }
        kids.push(el('p', {}, [el('b', { text: ev.code + ' — ' + ev.name }), ' · ' + ev.status + ' · stock point #' + ev.warehouseId + ' · invoices ' + ev.invoicePrefix + '/…']),
          el('p', { class: 'note', text: 'Staff: ' + (ev.staff.map(function (s) { return s.name; }).join(', ') || 'none yet') }), acts);
        kids.push(el('h3', { text: 'Stock at this event' }), table(['Product', 'MRP', 'GST', 'Available', 'Damaged', 'Expired', 'Next expiry'], stock.items.map(function (s) {
          return [s.sku + ' ' + s.name, money(s.mrp), s.gstRate + '%', String(s.available), String(s.damaged), String(s.expired), s.nextExpiry || '—'];
        })));
        if (E.has('events.sell') && ev.status === 'open') kids.push(counter(ev, stock, function () { open(id); }));
        kids.push(el('h3', { text: 'Invoices' }), table(['Invoice', 'Time', 'Customer', 'Total', 'Paid', 'Status', ''], sales.items.map(function (s) {
          return [s.invoiceNo + (s.offline ? ' (synced from offline)' : ''), fmt(s.soldAt), s.customer || 'Walk-in', money(s.total), money(s.paid) + ' · ' + s.paymentStatus, s.status, btn('Open', function () { saleBox(s.id, function () { open(id); }); })];
        })));
        detail.replaceChildren(section('Event', kids));
      }).catch(err(detail));
    }
    function counter(ev, stock, done) {
      var lines = {}, box = el('div'), out = el('div'), key = null;
      var rows = stock.items.filter(function (s) { return s.available > 0; }).map(function (s) {
        var q = el('input', { type: 'number', min: '0', max: String(s.available), step: '1', 'aria-label': 'Quantity of ' + s.name, style: 'width:80px' });
        q.addEventListener('input', function () { var n = parseInt(q.value, 10); if (n > 0) lines[s.productId] = n; else delete lines[s.productId]; key = null; });
        return [s.sku + ' ' + s.name, money(s.mrp), String(s.available), q];
      });
      var cn = input('Customer name'), cm = input('Mobile (for the WhatsApp invoice)'), ce = input('Email'), cg = input('GSTIN (business buyer)');
      var pm = select('Paid by', [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['', 'Not paid yet']]), pa = input('Amount paid', { type: 'number', step: '0.01', min: '0' });
      var sell = btn('Confirm sale', function () {
        var items = Object.keys(lines).map(function (k) { return { productId: Number(k), qty: lines[k] }; });
        if (!items.length) { out.replaceChildren(msg('err', 'Enter a quantity for at least one product.')); return; }
        key = key || uuid(); sell.disabled = true;
        api('POST', B + '/events/sales', { idempotencyKey: key, eventId: ev.id, items: items, customer: { name: cn.input.value, mobile: cm.input.value, email: ce.input.value, gstin: cg.input.value },
          payments: pm.input.value && Number(pa.input.value) > 0 ? [{ method: pm.input.value, amount: Number(pa.input.value) }] : [] })
          .then(function (s) { out.replaceChildren(msg('ok', 'Invoice ' + s.invoiceNo + ': ' + money(s.totals.grand) + (s.duplicate ? ' (already recorded)' : ''))); key = null; setTimeout(done, 900); })
          .catch(function (e) { sell.disabled = false; out.replaceChildren(msg('err', e.message)); });
      }, 'primary');
      box.appendChild(el('h3', { text: 'Sell at the counter' }));
      box.appendChild(table(['Product', 'MRP', 'Available', 'Qty'], rows));
      box.appendChild(el('div', { class: 'row' }, [cn.node, cm.node, ce.node, cg.node]));
      box.appendChild(el('div', { class: 'row' }, [pm.node, pa.node, sell]));
      box.appendChild(out);
      return box;
    }
    function saleBox(id, done) {
      api('GET', B + '/events/sales/' + id).then(function (s) {
        var out = el('div'), kids = [el('p', {}, [el('b', { text: 'Invoice ' + s.invoiceNo }), ' · ' + fmt(s.soldAt) + ' · ' + s.seller + (s.voided ? ' · VOID: ' + s.voided.reason : '')]),
          el('div', { class: 'row' }, [btn('Print / PDF', function () { openHtml(B + '/events/sales/' + id + '/invoice'); }), btn('Download', function () { openHtml(B + '/events/sales/' + id + '/invoice', true); })]),
          table(['Item', 'Batch', 'Qty', 'Returned', 'Amount'], s.items.map(function (i) { return [i.sku + ' ' + i.name, (i.batchNo || '—') + (i.expiry ? ' · exp ' + i.expiry : ''), String(i.qty), String(i.returned), money(i.total)]; })),
          el('p', {}, ['Total ' + money(s.totals.grand) + ' · paid ' + money(s.totals.paid) + ' (' + s.paymentStatus + ')'])];
        if (s.status === 'completed' && E.has('events.sell')) {
          kids.push(el('div', { class: 'row' }, [btn('Take a payment', function () {
            var m = ask('Method: cash, upi, card or bank_transfer'); if (!m) return; var a = ask('Amount'); if (!a) return;
            api('POST', B + '/events/sales/' + id + '/payments', { idempotencyKey: 'pay-' + uuid(), method: m, amount: Number(a) }).then(function () { saleBox(id, done); }).catch(err(out));
          }), btn('Return items', function () {
            var lineNo = ask('Line number to return (1–' + s.items.length + ')'); if (!lineNo) return;
            var it = s.items[Number(lineNo) - 1]; if (!it) return;
            var q = ask('How many of ' + it.name + '?'); if (!q) return;
            var c = ask('Condition: resaleable, damaged or expired'); if (!c) return;
            var why = ask('Reason (at least 5 characters)'); if (!why) return;
            var how = ask('Refund by: cash, upi, card, bank_transfer or none'); if (!how) return;
            api('POST', B + '/events/sales/' + id + '/returns', { idempotencyKey: uuid(), items: [{ saleItemId: it.id, qty: Number(q), condition: c }], reason: why, refundMethod: how })
              .then(function () { saleBox(id, done); }).catch(err(out));
          })].concat(E.has('events.sales.void') ? [btn('Void invoice', function () {
            var why = ask('Why is this invoice void? (all stock goes back; payments are refunded)'); if (!why) return;
            api('POST', B + '/events/sales/' + id + '/void', { reason: why }).then(function () { saleBox(id, done); done(); }).catch(err(out));
          }, 'danger')] : [])));
        }
        if (s.payments.length) kids.push(table(['Payment', 'Amount', 'By', 'When'], s.payments.map(function (p) { return [p.method + (p.direction === 'refund' ? ' (refund)' : ''), money(p.amount), p.by, fmt(p.at)]; })));
        if (s.returns.length) kids.push(table(['Return', 'Reason', 'Refund'], s.returns.map(function (r) { return [r.returnNo, r.reason, money(r.refund) + ' ' + r.method]; })));
        kids.push(out);
        detail.prepend(section('Invoice ' + s.invoiceNo, kids));
      }).catch(err(detail));
    }
    list();
  }

  // ── Locations (3b.2) ──
  function locations(main) {
    main.appendChild(el('h1', { text: 'Field & event locations' }));
    main.appendChild(el('p', { class: 'note', text: 'Only fixes people send are recorded (check-in, visit, sale, stall, manual entry); nothing tracks anyone in the background. Points are drawn from the recorded coordinates; "Open map" shows one in a map service of your choice.' }));
    var subj = select('Who', [['', 'Salesmen and events'], ['salesman', 'Salesmen'], ['event', 'Events']]), days = select('Period', [['1', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days']], '7');
    var mapBox = el('div'), hist = el('div'), att = el('div');
    main.appendChild(el('div', { class: 'row' }, [subj.node, days.node, btn('Show', load)]));
    main.appendChild(section('Latest position of each', [mapBox])); main.appendChild(section('History', [hist])); main.appendChild(section('Attendance (salesmen)', [att]));
    function plot(points) {
      if (!points.length) return el('p', { class: 'note', text: 'No locations recorded in this period.' });
      var W = 640, H = 360, pad = 28;
      var lats = points.map(function (p) { return p.lat; }), lngs = points.map(function (p) { return p.lng; });
      var minLa = Math.min.apply(null, lats), maxLa = Math.max.apply(null, lats), minLo = Math.min.apply(null, lngs), maxLo = Math.max.apply(null, lngs);
      var dLa = Math.max(maxLa - minLa, 0.01), dLo = Math.max(maxLo - minLo, 0.01);
      var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', points.length + ' locations');
      svg.setAttribute('style', 'width:100%;max-width:' + W + 'px;background:#f6f7f4;border:1px solid #e4e8e0;border-radius:8px');
      points.forEach(function (p) {
        var x = pad + (p.lng - minLo) / dLo * (W - 2 * pad), y = H - pad - (p.lat - minLa) / dLa * (H - 2 * pad);
        var c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', y.toFixed(1)); c.setAttribute('r', '6');
        c.setAttribute('fill', p.subject === 'event' ? '#b8590f' : '#2f5d1f');
        var t = document.createElementNS(NS, 'title'); t.textContent = (p.subjectName || p.subject) + ' · ' + new Date(p.capturedAt).toLocaleString(); c.appendChild(t);
        var l = document.createElementNS(NS, 'text'); l.setAttribute('x', (x + 9).toFixed(1)); l.setAttribute('y', (y + 4).toFixed(1)); l.setAttribute('font-size', '11'); l.textContent = p.subjectName || p.subject;
        svg.appendChild(c); svg.appendChild(l);
      });
      return el('div', {}, [svg, el('p', { class: 'note', text: 'Green: salesmen · orange: events. North is up; positions are to scale within this area only.' })]);
    }
    function mapsLink(p) { return el('a', { href: 'https://www.openstreetmap.org/?mlat=' + p.lat + '&mlon=' + p.lng + '#map=16/' + p.lat + '/' + p.lng, target: '_blank', rel: 'noopener noreferrer', text: 'Open map' }); }
    function load() {
      api('GET', B + '/locations/map?days=' + days.input.value + '&subject=' + subj.input.value).then(function (r) {
        mapBox.replaceChildren(plot(r.points), table(['Who', 'Kind', 'When', 'Source', 'Accuracy', ''], r.points.map(function (p) {
          return [p.subjectName || '—', p.subject + ' · ' + p.purpose, fmt(p.capturedAt), p.source, p.accuracyM == null ? '—' : p.accuracyM + ' m', mapsLink(p)];
        })));
      }).catch(err(mapBox));
      var from = new Date(Date.now() - (Number(days.input.value) - 1) * 86400000).toISOString().slice(0, 10);
      api('GET', B + '/locations?subject=' + subj.input.value + '&from=' + from).then(function (r) {
        hist.replaceChildren(table(['When', 'Who', 'Recorded by', 'Purpose', 'Source', 'Linked to', 'Note', ''], r.items.map(function (p) {
          return [fmt(p.capturedAt), p.subjectName || p.subject, p.staffName || '—', p.purpose, p.source, p.visitId ? 'visit #' + p.visitId : (p.ref ? p.ref.type + ' ' + p.ref.id : '—'), p.note || '', mapsLink(p)];
        })));
      }).catch(err(hist));
      api('GET', B + '/locations/attendance?from=' + from).then(function (r) {
        att.replaceChildren(table(['Day', 'Salesman', 'First fix', 'Last fix', 'Fixes', 'Visits'], r.items.map(function (a) { return [String(a.day).slice(0, 10), a.name, fmt(a.firstFix), fmt(a.lastFix), String(a.fixes), String(a.visits)]; })));
      }).catch(err(att));
    }
    load();
  }

  // ── Offline sync (3b.6) ──
  function offline(main) {
    main.appendChild(el('h1', { text: 'Offline sync' }));
    main.appendChild(el('p', { class: 'note', text: 'Every operation a device sent after being offline. Nothing is ever deleted: a conflict or failure waits here until someone retries it, settles it by hand, or discards it with a note.' }));
    var st = select('Show', [['attention', 'Needs attention'], ['conflict', 'Conflicts'], ['failed', 'Failed'], ['applied', 'Applied'], ['resolved', 'Resolved'], ['discarded', 'Discarded'], ['', 'All']]);
    var kind = select('Kind', [['', 'Any kind'], ['event_sale', 'Event sale'], ['event_payment', 'Event payment'], ['field_order', 'Field order'], ['visit', 'Visit'], ['location', 'Location']]);
    var top = el('div'), box = el('div'), det = el('div');
    main.appendChild(el('div', { class: 'row' }, [st.node, kind.node, btn('Show', load)])); main.appendChild(top); main.appendChild(box); main.appendChild(det);
    function load() {
      api('GET', B + '/offline/ops?status=' + st.input.value + '&kind=' + kind.input.value).then(function (r) {
        top.replaceChildren(el('div', { class: 'grid' }, ['applied', 'conflict', 'failed', 'resolved', 'discarded'].map(function (k) { return kpi(k, r.counts[k] || 0); })));
        box.replaceChildren(table(['Received', 'By', 'Kind', 'Status', 'Attempts', 'Problem', ''], r.items.map(function (o) {
          return [fmt(o.firstReceivedAt) + (o.createdOfflineAt ? ' (made ' + fmt(o.createdOfflineAt) + ')' : ''), o.staffName, o.kind, o.status, String(o.attempts), o.error || '—', btn('Open', function () { show(o.id); })];
        })));
      }).catch(err(box));
    }
    function show(id) {
      api('GET', B + '/offline/ops/' + id).then(function (o) {
        var out = el('div'), acts = el('div', { class: 'row' });
        if (['conflict', 'failed'].indexOf(o.status) !== -1 && E.has('offline.resolve')) {
          acts.appendChild(btn('Retry as ' + o.staffName, function () { api('POST', B + '/offline/ops/' + id + '/retry', {}).then(function (r) { out.replaceChildren(msg(r.status === 'applied' ? 'ok' : 'warn', 'Result: ' + r.status + (r.error ? ' — ' + r.error : ''))); load(); show(id); }).catch(err(out)); }, 'primary'));
          acts.appendChild(btn('Settled by hand', function () { var n = ask('What was done?'); if (n) api('POST', B + '/offline/ops/' + id + '/resolve', { note: n }).then(function () { load(); show(id); }).catch(err(out)); }));
          acts.appendChild(btn('Discard', function () { var n = ask('Why must this not happen? (the record stays)'); if (n) api('POST', B + '/offline/ops/' + id + '/discard', { note: n }).then(function () { load(); show(id); }).catch(err(out)); }, 'danger'));
        }
        det.replaceChildren(section('Operation ' + o.clientOpId, [el('p', {}, [o.kind + ' · ' + o.status + ' · by ' + o.staffName + ' · device ' + (o.deviceId || '—')]),
          o.error ? msg(o.status === 'conflict' ? 'warn' : 'err', o.error) : el('span'), o.note ? el('p', { class: 'note', text: 'Note: ' + o.note + (o.resolvedBy ? ' — ' + o.resolvedBy : '') }) : el('span'),
          el('h3', { text: 'What the device sent' }), el('pre', { text: JSON.stringify(o.payload, null, 1) }), o.result ? el('pre', { text: 'Result: ' + JSON.stringify(o.result) }) : el('span'), acts, out]));
      }).catch(err(det));
    }
    load();
  }

  // ── All customers (N4) ──
  function allCustomers(main) {
    main.appendChild(el('h1', { text: 'All customers' }));
    main.appendChild(el('p', { class: 'note', text: 'One record per person across the online shop, event counters, field sales and business accounts. Shop customers keep their own login; nobody registers again. Records are never merged automatically: a doubtful match is flagged for review.' }));
    var q = input('Name, exact email or mobile'), ch = select('Bought through', [['', 'Any channel'], ['b2c', 'Online shop'], ['event', 'Events'], ['b2b', 'Business'], ['field', 'Field sales']]);
    var rv = select('Show', [['', 'All'], ['1', 'Needs review']]), box = el('div'), det = el('div'), top = el('div');
    var acts = [q.node, ch.node, rv.node, btn('Search', load)];
    if (E.has('customers.link.manage')) acts.push(btn('Import / refresh from the shop', function () {
      top.replaceChildren(msg('ok', 'Importing…'));
      api('POST', B + '/customers/import', {}).then(function (r) { top.replaceChildren(msg('ok', 'Linked ' + r.linked + ' (new ' + r.created + ', to review ' + r.review + '), orders ' + r.orders + ', business accounts ' + r.accounts + (r.unreadable.length ? ' · not read: ' + r.unreadable.join('; ') : ''))); load(); }).catch(err(top));
    }));
    main.appendChild(el('div', { class: 'row' }, acts)); main.appendChild(top); main.appendChild(box); main.appendChild(det);
    function load() {
      api('GET', B + '/customers?q=' + encodeURIComponent(q.input.value) + '&channel=' + ch.input.value + '&review=' + rv.input.value).then(function (r) {
        box.replaceChildren(el('p', { class: 'note', text: r.total + ' customer(s)' }), table(['Name', 'Email', 'Mobile', 'Seen through', 'Orders', 'Spent', 'Last seen', ''], r.items.map(function (c) {
          return [c.name || '—', c.email || '—', c.mobile || '—', c.sources.join(', ') + (c.review ? ' · review' : ''), String(c.orders), money(c.spent), fmt(c.lastSeenAt), btn('Open', function () { show(c.id); })];
        })));
      }).catch(err(box));
    }
    function show(id) {
      api('GET', B + '/customers/' + id).then(function (d) {
        var out = el('div');
        det.replaceChildren(section(d.customer.name || 'Customer #' + d.customer.id, [el('p', {}, [(d.customer.email || '—') + ' · ' + (d.customer.mobile || '—')]),
          el('h3', { text: 'Linked records' }), table(['Source', 'Reference', 'Matched by', 'Review', ''], d.links.map(function (l) {
            var a = l.review && E.has('customers.link.manage') ? el('div', { class: 'row' }, [btn('Confirm', function () { var n = ask('Why is this the same person?'); if (n) api('POST', B + '/customers/links/' + l.id + '/resolve', { note: n }).then(function () { show(id); }).catch(err(out)); }),
              btn('Move to…', function () { var to = ask('Customer number to move this record to'); if (!to) return; var n = ask('Why?'); if (n) api('POST', B + '/customers/links/' + l.id + '/resolve', { note: n, moveTo: Number(to) }).then(function () { show(id); load(); }).catch(err(out)); })]) : el('span', { text: l.note || '' });
            return [l.source, l.ref, l.rule, l.review ? 'needs review' : '—', a];
          })), el('h3', { text: 'Orders across channels' }), table(['Channel', 'Order', 'Status', 'Items', 'Total', 'When'], d.orders.map(function (o) {
            return [o.channel, o.orderNo || o.id, o.status || '—', o.items == null ? '—' : String(o.items), money(o.total), fmt(o.at)];
          })), out]));
      }).catch(err(det));
    }
    load();
  }

  window.ERP_VIEWS.push(
    { id: 'shopstock', label: 'Online shop stock', perm: 'shop_stock.view', render: shopStock },
    { id: 'events', label: 'Events & counter sales', perm: 'events.view', render: events },
    { id: 'locations', label: 'Field & event locations', perm: 'locations.view', render: locations },
    { id: 'offline', label: 'Offline sync', perm: 'offline.view', render: offline },
    { id: 'customers', label: 'All customers', perm: 'customers.view', render: allCustomers }
  );
})();
