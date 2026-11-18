/* Vendor portal. Shows only the signed-in vendor's own records (the server filters by
   the vendor from the session, never from the page). Text via textContent only. */
(function () {
  'use strict';
  var API = '/api/vendor';
  var token = null; try { token = sessionStorage.getItem('vendor.token'); } catch (e) { /* */ }
  var root = document.getElementById('app');
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function api(method, path, body) {
    var form = body instanceof FormData, h = {};
    if (!form) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(API + path, { method: method, headers: h, body: body ? (form ? body : JSON.stringify(body)) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && path !== '/auth/login') logout();
        if (!r.ok) { var e = new Error(j.error || 'Request failed'); e.code = j.code; throw e; }
        return j;
      });
    });
  }
  function msg(k, t) { return el('div', { class: 'msg ' + k, role: k === 'err' ? 'alert' : 'status', text: t }); }
  function field(label, attrs) { var i = el('input', attrs || {}); return { node: el('label', {}, [label, i]), input: i }; }
  function btn(t, f, k) { return el('button', { class: 'btn' + (k ? ' ' + k : ''), type: 'button', text: t, on: { click: f } }); }
  function table(head, rows) {
    return el('div', { class: 'table-wrap' }, [el('table', {}, [el('thead', {}, [el('tr', {}, head.map(function (x) { return el('th', { text: x }); }))]),
      el('tbody', {}, rows.length ? rows.map(function (r) { return el('tr', {}, r.map(function (c) { return el('td', {}, [c]); })); }) : [el('tr', {}, [el('td', { colspan: String(head.length), class: 'note', text: 'Nothing here.' })])])])]);
  }
  function logout() { token = null; try { sessionStorage.removeItem('vendor.token'); } catch (e) { /* */ } start(); }

  function login(error) {
    var e = field('E-mail', { type: 'email', autocomplete: 'username' }), p = field('Password', { type: 'password', autocomplete: 'current-password' });
    var invite = new URLSearchParams(location.search).get('invite');
    var box = el('div', { class: 'panel login' }, [el('h1', { text: invite ? 'Set your password' : 'Vendor sign-in' }), error ? msg('err', error) : null]);
    if (invite) {
      var np = field('New password (12+ characters)', { type: 'password', autocomplete: 'new-password' });
      box.appendChild(np.node);
      box.appendChild(btn('Activate account', function () {
        api('POST', '/invite/accept', { token: invite, password: np.input.value }).then(function () { history.replaceState(null, '', location.pathname); root.replaceChildren(login()); root.prepend(msg('ok', 'Done — sign in now.')); })
          .catch(function (x) { root.replaceChildren(login(x.message)); });
      }, 'primary'));
      return box;
    }
    box.appendChild(e.node); box.appendChild(p.node);
    box.appendChild(btn('Sign in', function () {
      api('POST', '/auth/login', { email: e.input.value, password: p.input.value }).then(function (r) { token = r.token; try { sessionStorage.setItem('vendor.token', r.token); } catch (x) { /* */ } start(); })
        .catch(function (x) { root.replaceChildren(login(x.message)); });
    }, 'primary'));
    box.appendChild(el('p', { class: 'note' }, ['New supplier? ', el('a', { href: '#', text: 'Register your business', on: { click: function (ev) { ev.preventDefault(); root.replaceChildren(register()); } } })]));
    return box;
  }

  function register() {
    var f = { legalName: field('Legal name'), gstin: field('GSTIN'), name: field('Your name'), email: field('E-mail', { type: 'email' }), mobile: field('Mobile', { inputmode: 'numeric' }),
      password: field('Password (12+ characters)', { type: 'password', autocomplete: 'new-password' }) };
    var cap = el('select', { 'aria-label': 'You are a' }, [['manufacturer', 'Manufacturer'], ['authorised_distributor', 'Authorised distributor'], ['supplier_wholesaler', 'Supplier / wholesaler']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    var out = el('div');
    return el('div', { class: 'panel login' }, [el('h1', { text: 'Register as a supplier' }), out].concat(Object.keys(f).map(function (k) { return f[k].node; })).concat([el('label', {}, ['You are a', cap]),
      btn('Register', function () {
        api('POST', '/register', { legalName: f.legalName.input.value, gstin: f.gstin.input.value, capabilities: [cap.value],
          user: { name: f.name.input.value, email: f.email.input.value, mobile: f.mobile.input.value, password: f.password.input.value } })
          .then(function () { root.replaceChildren(login()); root.prepend(msg('ok', 'Registered. Sign in to upload your documents; our team verifies them before you can quote.')); })
          .catch(function (x) { out.replaceChildren(msg('err', x.message)); });
      }, 'primary'), btn('Back', function () { root.replaceChildren(login()); })]));
  }

  function home(me) {
    var main = el('main', { id: 'main' });
    main.appendChild(el('div', { class: 'row' }, [el('h1', { text: me.vendor.legal_name }), el('span', { class: 'tag', text: me.vendor.status.replace(/_/g, ' ') }), btn('Sign out', logout)]));
    if (me.vendor.status !== 'approved') main.appendChild(msg('warn', 'Your business is being verified. Upload the documents below; you can quote once approved.'));
    var out = el('div'); main.appendChild(out);
    // documents
    var type = el('select', { 'aria-label': 'Document type' }, ['gst_certificate', 'pan', 'business_registration', 'bank_proof', 'cancelled_cheque', 'fssai_licence', 'quality_certificate', 'manufacturer_authorisation', 'other']
      .map(function (t) { return el('option', { value: t, text: t.replace(/_/g, ' ') }); }));
    var file = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.webp', 'aria-label': 'File' });
    main.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Documents' }),
      table(['Type', 'File', 'Review'], me.documents.map(function (d) { return [d.doc_type.replace(/_/g, ' '), d.original_name, d.review_status + (d.review_note ? ': ' + d.review_note : '')]; })),
      el('div', { class: 'row' }, [type, file, btn('Upload', function () {
        var f = new FormData(); f.append('docType', type.value); if (file.files[0]) f.append('file', file.files[0]);
        api('POST', '/documents', f).then(function () { start(); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
      })])]));
    // products
    var pn = field('Product name'), sku = field('Your SKU'), hsn = field('HSN'), gst = field('GST %', { inputmode: 'decimal' }), mrp = field('MRP', { inputmode: 'decimal' });
    main.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Offer a product' }), el('div', { class: 'row' }, [pn.node, sku.node, hsn.node, gst.node, mrp.node, btn('Submit', function () {
      api('POST', '/products', { name: pn.input.value, vendorSku: sku.input.value, hsnCode: hsn.input.value, gstRate: Number(gst.input.value), mrp: Number(mrp.input.value) })
        .then(function () { out.replaceChildren(msg('ok', 'Submitted for review')); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
    })])]));
    if (me.vendor.status === 'approved') { rfqs(main, out); pos(main, out); returnsToUs(main, out); }
    root.replaceChildren(el('div', { class: 'shell' }, [main]));
  }

  function rfqs(main, out) {
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Requests for quotation' })]); main.appendChild(sec);
    api('GET', '/rfqs').then(function (r) {
      sec.appendChild(table(['RFQ', 'Reply by', 'Status', ''], r.items.map(function (q) {
        return [q.rfq_no + ' · ' + q.title, new Date(q.respond_by).toLocaleString(), q.status + (q.my_revision ? ' (your quote v' + q.my_revision + ')' : ''), q.status === 'sent' ? btn('Quote', function () { quote(out, q.id); }) : ''];
      })));
    }).catch(function (x) { sec.appendChild(msg('err', x.message)); });
  }
  function quote(out, id) {
    api('GET', '/rfqs/' + id).then(function (q) {
      var rows = q.items.map(function (i) { return { i: i, avail: el('input', { inputmode: 'numeric', value: String(i.qty), 'aria-label': 'Available' }), price: el('input', { inputmode: 'decimal', 'aria-label': 'Unit price ex-GST' }), gst: el('input', { inputmode: 'decimal', 'aria-label': 'GST %' }) }; });
      var until = el('input', { type: 'date', 'aria-label': 'Valid until' }), freight = el('input', { inputmode: 'decimal', value: '0', 'aria-label': 'Freight' });
      out.replaceChildren(el('section', { class: 'panel' }, [el('h2', { text: 'Quote for ' + q.rfq_no }), table(['Product', 'Qty asked', 'Available', 'Unit price (ex-GST)', 'GST %'], rows.map(function (r) { return [r.i.name, String(r.i.qty), r.avail, r.price, r.gst]; })),
        el('div', { class: 'row' }, [el('label', {}, ['Valid until', until]), el('label', {}, ['Total freight', freight]), btn('Send quote', function () {
          api('POST', '/rfqs/' + id + '/responses', { validUntil: until.value, freightTotal: Number(freight.value || 0), items: rows.map(function (r) { return { rfqItemId: r.i.id, availableQty: Number(r.avail.value), unitPrice: r.price.value, gstRate: Number(r.gst.value) }; }) })
            .then(function (x) { out.replaceChildren(msg('ok', 'Quote v' + x.revision + ' sent')); }).catch(function (x) { out.prepend(msg('err', x.message)); });
        }, 'primary')])]));
    }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
  }
  function pos(main, out) {
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Purchase orders' })]); main.appendChild(sec);
    api('GET', '/purchase-orders').then(function (r) {
      sec.appendChild(table(['PO', 'Status', 'Total', 'Deliver by', ''], r.items.map(function (p) {
        var a = el('div', { class: 'row' });
        if (p.status === 'sent') {
          a.appendChild(btn('Accept', function () { api('POST', '/purchase-orders/' + p.id + '/acknowledge', { response: 'accepted' }).then(start).catch(function (x) { out.replaceChildren(msg('err', x.message)); }); }, 'primary'));
          a.appendChild(btn('Reject', function () { var n = window.prompt('Reason'); if (n) api('POST', '/purchase-orders/' + p.id + '/acknowledge', { response: 'rejected', note: n }).then(start).catch(function (x) { out.replaceChildren(msg('err', x.message)); }); }, 'danger'));
        }
        if (['accepted', 'partially_accepted', 'partially_received'].indexOf(p.status) !== -1) a.appendChild(btn('Dispatch notice', function () { asn(out, p.id); }));
        return [p.po_no, p.status.replace(/_/g, ' '), '₹' + p.grand_total, p.delivery_by ? new Date(p.delivery_by).toLocaleDateString() : '—', a];
      })));
    }).catch(function (x) { sec.appendChild(msg('err', x.message)); });
  }
  function asn(out, poId) {
    api('GET', '/purchase-orders/' + poId).then(function (po) {
      var rows = po.items.map(function (i) { return { i: i, qty: el('input', { inputmode: 'numeric', 'aria-label': 'Qty', value: String(Number(i.qty_accepted_by_vendor || i.qty_ordered) - Number(i.qty_received)) }), batch: el('input', { 'aria-label': 'Batch' }),
        mfg: el('input', { type: 'date', 'aria-label': 'Mfg' }), exp: el('input', { type: 'date', 'aria-label': 'Expiry' }) }; });
      var inv = el('input', { 'aria-label': 'Your invoice no.' });
      out.replaceChildren(el('section', { class: 'panel' }, [el('h2', { text: 'Dispatch notice for ' + po.po_no }), table(['Product', 'Qty', 'Batch', 'Mfg', 'Expiry'], rows.map(function (r) { return [r.i.name, r.qty, r.batch, r.mfg, r.exp]; })),
        el('div', { class: 'row' }, [el('label', {}, ['Your invoice no.', inv]), btn('Send', function () {
          api('POST', '/asns', { poId: poId, vendorInvoiceNo: inv.value, items: rows.filter(function (r) { return Number(r.qty.value) > 0; }).map(function (r) { return { poItemId: r.i.id, qty: Number(r.qty.value), batchNo: r.batch.value, mfgDate: r.mfg.value || undefined, expiryDate: r.exp.value || undefined }; }) })
            .then(function () { out.replaceChildren(msg('ok', 'Dispatch notice sent')); }).catch(function (x) { out.prepend(msg('err', x.message)); });
        }, 'primary')])]));
    }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
  }

  function returnsToUs(main, out) {
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Goods returned to you (debit notes)' })]); main.appendChild(sec);
    api('GET', '/purchase-returns').then(function (r) {
      sec.appendChild(table(['Return', 'Debit note', 'Reason', 'Total', 'Status', ''], r.items.map(function (x) {
        return [x.return_no, x.debit_note_no || '—', x.source.replace('_', ' '), '₹' + x.grand_total, x.status, x.status === 'dispatched' ? btn('Confirm received', function () {
          api('POST', '/purchase-returns/' + x.id + '/acknowledge', { note: window.prompt('Note (optional)') || '' }).then(start).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
        }) : ''];
      })));
    }).catch(function (x) { sec.appendChild(msg('err', x.message)); });
  }

  function start() {
    if (!token) { root.replaceChildren(login()); return; }
    api('GET', '/me').then(home).catch(function () { logout(); });
  }
  start();
})();
