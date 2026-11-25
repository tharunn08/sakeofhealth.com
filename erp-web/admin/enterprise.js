/* Business platform admin — Logos & Bills, and the AI Assistant.
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

  window.ERP_VIEWS.push({ id: 'branding', label: 'Logos & Bills', perm: 'core.settings.view', render: branding });
  window.ERP_VIEWS.push({ id: 'assistant', label: 'AI Assistant', perm: 'reports.export', render: assistant });
})();
