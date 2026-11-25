/* Business platform admin — My Work, Logos & Bills, and the AI Assistant.
   My Work: each person's day from live data (approvals, money, cash, deliveries, manufacturing, stock).
   Logos & Bills: upload several logos and choose which one prints on bills (src/platform/branding.js).
   AI Assistant: answers questions from the business's own reports; switched off until a provider key
   is set in Hostinger and a Super Admin switches it on (src/modules/erp/assistant/service.js).
   The server checks every permission; this page only shows what it allows. Text via textContent only. */
(function () {
  'use strict';
  var E = window.ERP, el = E.el, msg = E.msg, fmt = E.fmt;

  // ── Logos & Bills ──
  function branding(main) {
    main.appendChild(el('h1', { text: 'Logos & Bills' }));
    var box = el('div'); main.appendChild(box);
    function draw() {
      E.api('GET', '/api/erp/core/branding').then(function (st) {
        box.replaceChildren();
        box.appendChild(el('section', { class: 'panel' }, [
          el('h2', { text: 'Logo printed on bills' }),
          el('div', { class: 'row' }, [el('img', { src: st.bill.url, alt: st.bill.label, style: 'max-height:60px;max-width:200px;object-fit:contain;background:#fff;border:1px solid #e3e7ea;border-radius:6px;padding:6px' }),
            el('strong', { text: st.bill.label })]),
          el('p', { class: 'note', text: 'Used on shop bills, trade invoices and counter-sale invoices. The shop logo is used until you choose another one.' }),
        ]));
        var cards = [Object.assign({}, st.shop, { builtIn: true })].concat(st.logos).map(function (l) {
          var chosen = st.billLogo === l.id, out = el('div');
          var acts = el('div', { class: 'row' });
          if (st.canChange && !chosen) acts.appendChild(el('button', { class: 'btn primary', type: 'button', text: 'Print this on bills', on: { click: function () {
            E.api('PUT', '/api/erp/core/branding/bill-logo', { id: l.id }).then(draw).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
          } } }));
          if (st.canChange && !l.builtIn) acts.appendChild(el('button', { class: 'btn danger', type: 'button', text: 'Remove', on: { click: function () {
            E.api('POST', '/api/erp/core/branding/logos/' + encodeURIComponent(l.id) + '/remove', {}).then(draw).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
          } } }));
          return el('div', { class: 'panel' }, [
            el('img', { src: l.url, alt: l.label, style: 'height:70px;max-width:100%;object-fit:contain;display:block;margin-bottom:8px' }),
            el('strong', { text: l.label + (chosen ? ' — on bills now' : '') }),
            el('p', { class: 'note', text: l.builtIn ? 'The shop\'s own logo' : 'Added ' + fmt(l.uploadedAt) + (l.uploadedBy ? ' by ' + l.uploadedBy : '') + ' · ' + Math.round(l.bytes / 1024) + ' KB' }),
            acts, out]);
        });
        box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Logo library (' + st.logos.length + ' of ' + st.maxLogos + ')' }), el('div', { class: 'grid' }, cards)]));
        if (!st.canChange) { box.appendChild(el('p', { class: 'note', text: 'Only a Super Admin can add logos or change the one on bills.' })); return; }
        var file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'Logo file' });
        var label = el('input', { 'aria-label': 'Logo name', placeholder: 'Name, e.g. Ayurveda range', maxlength: '60' });
        var out = el('div');
        box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Add a logo' }),
          el('p', { class: 'note', text: 'PNG, JPG or WEBP, up to 1 MB. A wide logo on a white or transparent background prints best.' }),
          el('div', { class: 'row' }, [el('label', {}, ['File', file]), el('label', {}, ['Name', label]), el('button', { class: 'btn primary', type: 'button', text: 'Upload', on: { click: function () {
            if (!file.files || !file.files[0]) { out.replaceChildren(msg('err', 'Choose a picture file first.')); return; }
            if (file.files[0].size > st.maxBytes) { out.replaceChildren(msg('err', 'The logo must be 1 MB or smaller.')); return; }
            var fd = new FormData(); fd.append('label', label.value); fd.append('file', file.files[0]);
            E.api('POST', '/api/erp/core/branding/logos', fd).then(draw).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
          } } })]), out]));
      }).catch(function (e) { box.replaceChildren(msg('err', e.message)); });
    }
    draw();
  }

  // ── AI Assistant ──
  function assistant(main) {
    main.appendChild(el('h1', { text: 'AI Assistant' }));
    var box = el('div'); main.appendChild(box);
    E.api('GET', '/api/erp/assistant/status').then(function (st) {
      if (!st.available) {
        var why = {
          not_configured: 'Built, and switched off. It needs an AI provider key, which is paid per question. To use it: add AI_PROVIDER = anthropic and AI_API_KEY in Hostinger → your website → Environment variables, then come back and switch it on. With the default low-cost model, about 1,500 questions cost roughly $5 a month.',
          switched_off: 'The provider key is set, but the assistant is switched off.',
          no_data_permissions: 'Your role cannot open any of the reports the assistant uses (sales, stock, customers).',
        }[st.reason] || 'The assistant is not available.';
        box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Status: off' }), el('p', { text: why }),
          el('p', { class: 'note', text: 'Until it is on, nothing is sent outside the server. Smart Insights (Overview → Smart Insights) works without it, at no cost.' })]));
        if (st.canSwitch && st.reason === 'switched_off') {
          var out = el('div');
          box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn primary', type: 'button', text: 'Switch on', on: { click: function () {
            E.api('PUT', '/api/erp/assistant/switch', { on: true }).then(function () { E.show('assistant'); }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
          } } }), out]));
        }
        return;
      }
      box.appendChild(el('p', { class: 'note', text: 'Answers come only from the reports your role can open. Facts are kept apart from possible causes, and suggested actions are drafts: you do them in the screen named. ' +
        'Used today: ' + st.usedToday + ' of ' + st.limits.perPerson + '. Every question is recorded in the audit log.' }));
      var q = el('textarea', { rows: '3', maxlength: '1000', 'aria-label': 'Your question', placeholder: 'e.g. Which products will run out in the next two weeks, and how much should we order?', style: 'width:100%' });
      var ans = el('div'), btn = el('button', { class: 'btn primary', type: 'button', text: 'Ask' });
      btn.addEventListener('click', function () {
        btn.disabled = true; ans.replaceChildren(el('p', { class: 'note', text: 'Working on it…' }));
        E.api('POST', '/api/erp/assistant/ask', { question: q.value }).then(function (r) {
          ans.replaceChildren(el('section', { class: 'panel' }, [el('pre', { text: r.answer, style: 'max-height:none;font-size:14px;white-space:pre-wrap' }),
            el('p', { class: 'note', text: 'Reports used: ' + (r.toolsUsed.join(', ') || 'none') })]));
        }).catch(function (e) { ans.replaceChildren(msg('err', e.message)); }).then(function () { btn.disabled = false; });
      });
      box.appendChild(el('section', { class: 'panel' }, [q, el('div', { class: 'row' }, [btn]), ans]));
      if (st.canSwitch) box.appendChild(el('button', { class: 'btn danger', type: 'button', text: 'Switch the assistant off', on: { click: function () {
        E.api('PUT', '/api/erp/assistant/switch', { on: false }).then(function () { E.show('assistant'); }).catch(function (e) { box.appendChild(msg('err', e.message)); });
      } } }));
    }).catch(function (e) { box.appendChild(msg('err', e.message)); });
  }

  // ── My Work: one page per person, from live data, showing only what their role covers ──
  function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  function count(n) { return String(n == null ? '—' : n); }
  function mywork(main) {
    var me = E.state.me || { roles: [] };
    main.appendChild(el('h1', { text: 'My Work' }));
    main.appendChild(el('p', { class: 'note', text: 'Today for ' + (me.name || 'you') + (me.roles && me.roles.length ? ' (' + me.roles.join(', ').replace(/_/g, ' ') + ')' : '') +
      '. Figures are live; each card shows only what your role can open.' }));
    var grid = el('div', { class: 'grid' }); main.appendChild(grid);
    var details = el('div'); main.appendChild(details);
    var shown = 0;
    function card(title, perm, load) {
      if (perm && !perm.some(E.has)) return;
      shown++;
      var body = el('div', {}, [el('p', { class: 'note', text: 'Loading…' })]);
      grid.appendChild(el('section', { class: 'panel' }, [el('h2', { text: title }), body]));
      load().then(function (kids) { body.replaceChildren.apply(body, kids); })
        .catch(function (e) { body.replaceChildren(el('p', { class: 'note', text: e.status === 403 ? 'Not available for your role.' : 'Could not load: ' + e.message })); });
    }
    function line(label, value, go) {
      return el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' }, [el('span', { text: label }),
        go ? el('button', { class: 'linkish', type: 'button', text: value, 'aria-label': label + ': ' + value + ', open', on: { click: function () { E.show(go); } } }) : el('strong', { text: value })]);
    }
    card('Waiting for your approval', ['core.approvals.view'], function () {
      return E.api('GET', '/api/erp/core/approvals').then(function (r) {
        var items = r.items || [];
        if (items.length) details.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Approvals waiting for you' }),
          E.table(['Request', 'Reason', 'Asked by', 'When'], items.slice(0, 20).map(function (a) { return [a.type.replace(/^core\./, '').replace(/_/g, ' '), a.reason || '', a.requestedBy || '', fmt(a.requestedAt)]; }))]));
        return [line('Requests', count(items.length), 'approvals')];
      });
    });
    card('Money owed to you', ['finance.reports.view'], function () {
      return E.api('GET', '/api/erp/finance/ageing').then(function (r) {
        var t = r.totals || {};
        var overdue = (t['1_30'] || 0) + (t['31_60'] || 0) + (t['61_90'] || 0) + (t['90_plus'] || 0);
        var late = (r.parties || []).filter(function (p) { return (p.total || 0) - (p.current || 0) > 0; }).slice(0, 10);
        if (late.length) details.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Customers with overdue invoices' }),
          E.table(['Customer', 'Overdue (₹)', '90+ days (₹)', 'Total open (₹)'], late.map(function (p) { return [p.party, money((p.total || 0) - (p.current || 0)), money(p['90_plus']), money(p.total)]; }))]));
        return [line('Open', money(t.total), 'finance'), line('Overdue', money(overdue)), line('Over 90 days', money(t['90_plus']))];
      });
    });
    card('Bills you owe suppliers', ['finance.reports.view'], function () {
      return E.api('GET', '/api/erp/finance/ageing?side=payables').then(function (r) {
        var t = r.totals || {};
        return [line('Open', money(t.total), E.has('finance.payables.view') ? 'bills' : null), line('Past due', money((t['1_30'] || 0) + (t['31_60'] || 0) + (t['61_90'] || 0) + (t['90_plus'] || 0)))];
      });
    });
    card('Field cash to confirm', ['sales.collections.confirm'], function () {
      return E.api('GET', '/api/erp/sales/collections/pending').then(function (r) {
        var items = r.items || [], sum = items.reduce(function (a, p) { return a + Number(p.amount || 0); }, 0);
        return [line('Collections', count(items.length), 'collections'), line('Amount', money(sum))];
      });
    });
    card('Deliveries today', ['deliveries.view', 'deliveries.manage'], function () {
      return E.api('GET', '/api/erp/deliveries/summary').then(function (r) {
        return [line('Open shipments', count(r.open), 'deliveryhub'), line('Late', count(r.late)), line('Delivered today', count(r.deliveredToday)), line('Packed, no shipment yet', count(r.waitingForShipment))];
      });
    });
    card('Manufacturing', ['manufacturing.view'], function () {
      return Promise.all([E.api('GET', '/api/erp/manufacturing/orders?status=open'), E.api('GET', '/api/erp/manufacturing/batches?status=submitted')]).then(function (x) {
        return [line('Open production orders', count((x[0].items || []).length), 'manufacturing'), line('Batches waiting for quality release', count((x[1].items || []).length), 'quality')];
      });
    });
    if (E.has('reports.export') && E.has('inventory.view')) card('Stock', null, function () {
      return E.api('GET', '/api/erp/insights/stock').then(function (r) {
        var c = r.counts || {};
        return [line('Out of stock', count(c.outOfStock), 'insights'), line('Order now', count(c.orderNow)), line('Order soon', count(c.orderSoon))];
      });
    });
    if (!shown) main.appendChild(el('p', { text: 'Your role has no business figures to show yet. ERP Home lists the pages you can open.' }));
    main.appendChild(el('p', { class: 'note', text: 'Manufacturers and suppliers outside the company have their own dashboard in the supplier portal (sakeofhealth.com/vendor-portal/). Salesmen, delivery and event staff use the Field app.' }));
  }

  window.ERP_VIEWS.push({ id: 'mywork', label: 'My Work', perm: 'core.self.view', render: mywork });
  window.ERP_VIEWS.push({ id: 'branding', label: 'Logos & Bills', perm: 'core.settings.view', render: branding });
  window.ERP_VIEWS.push({ id: 'assistant', label: 'AI Assistant', perm: 'reports.export', render: assistant });
})();
