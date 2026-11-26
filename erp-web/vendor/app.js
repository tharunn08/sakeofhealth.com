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
        if (r.status === 401 && path !== '/auth/login') logout(true);
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
  function logout(expired) { token = null; try { sessionStorage.removeItem('vendor.token'); } catch (e) { /* */ } toSignIn(expired); }
  /** Everyone signs in on the one page; it brings manufacturers and suppliers back here. */
  function toSignIn(expired) { location.replace('/login?to=supplier' + (expired ? '&expired=1' : '')); }

  function login(error) {
    var e = field('E-mail', { type: 'email', autocomplete: 'username' }), p = field('Password', { type: 'password', autocomplete: 'current-password' });
    var invite = new URLSearchParams(location.search).get('invite');
    var box = el('div', { class: 'panel login' }, [el('h1', { text: invite ? 'Set your password' : 'Manufacturer & supplier sign-in' }), error ? msg('err', error) : null]);
    if (invite) {
      var np = field('New password (12+ characters)', { type: 'password', autocomplete: 'new-password' });
      box.appendChild(np.node);
      box.appendChild(btn('Activate account', function () {
        api('POST', '/invite/accept', { token: invite, password: np.input.value }).then(function () { history.replaceState(null, '', location.pathname); root.replaceChildren(msg('ok', 'Done — your account is ready. Taking you to the sign-in page…')); setTimeout(function () { toSignIn(); }, 1500); })
          .catch(function (x) { root.replaceChildren(login(x.message)); });
      }, 'primary'));
      return box;
    }
    toSignIn();
    return box;
  }

  var CAPS = [['manufacturer', 'Manufacturer (own brand)'], ['contract_manufacturer', 'Contract manufacturer (makes our products)'], ['authorised_distributor', 'Authorised distributor'], ['supplier_wholesaler', 'Supplier / wholesaler']];
  var STATES = null;
  function states() { return STATES ? Promise.resolve(STATES) : api('GET', '/states').then(function (r) { STATES = r.states; return STATES; }); }
  function stateSelect(label) {
    var s = el('select', { 'aria-label': label }, [el('option', { value: '', text: 'Choose…' })]);
    states().then(function (list) { list.forEach(function (x) { s.appendChild(el('option', { value: String(x.id), text: x.name })); }); }).catch(function () { /* the server checks again */ });
    return { node: el('label', {}, [label, s]), input: s };
  }

  function register() {
    var f = { legalName: field('Legal name (as on GST) *'), tradeName: field('Trade / brand name'), gstin: field('GSTIN', { maxlength: '15' }), pan: field('PAN', { maxlength: '10' }),
      fssaiLicence: field('FSSAI licence no.'), fssaiValidTo: field('FSSAI valid to', { type: 'date' }), categoriesNote: field('What you supply (categories)') };
    var a = { line1: field('Address *'), city: field('City *'), pincode: field('PIN code *', { inputmode: 'numeric', maxlength: '6' }) }, st = stateSelect('State *');
    var u = { name: field('Your name *'), email: field('E-mail * (you sign in with this)', { type: 'email', autocomplete: 'username' }), mobile: field('Mobile *', { inputmode: 'numeric', maxlength: '10' }),
      password: field('Password * (12+ characters, letters and a number)', { type: 'password', autocomplete: 'new-password' }) };
    var caps = CAPS.map(function (c) { var i = el('input', { type: 'checkbox', value: c[0], 'aria-label': c[1] }); return { node: el('label', { class: 'chk' }, [i, ' ' + c[1]]), input: i }; });
    var out = el('div');
    function group(title, kids) { return el('fieldset', {}, [el('legend', { text: title })].concat(kids)); }
    return el('div', { class: 'panel login wide' }, [el('h1', { text: 'Register as a manufacturer or supplier' }),
      el('p', { class: 'note', text: 'Our team checks your documents before you can quote or receive orders. You can upload GST, PAN, FSSAI and bank proof after signing in.' }), out,
      group('Your business', Object.keys(f).map(function (k) { return f[k].node; })),
      group('What you are (tick all that apply) *', caps.map(function (c) { return c.node; })),
      group('Registered office', [a.line1.node, a.city.node, st.node, a.pincode.node]),
      group('Your sign-in', Object.keys(u).map(function (k) { return u[k].node; })),
      el('div', { class: 'row' }, [btn('Register', function () {
        var body = { capabilities: caps.filter(function (c) { return c.input.checked; }).map(function (c) { return c.input.value; }),
          address: { type: 'registered', line1: a.line1.input.value, city: a.city.input.value, pincode: a.pincode.input.value, stateId: Number(st.input.value) || null },
          user: { name: u.name.input.value, email: u.email.input.value, mobile: u.mobile.input.value, password: u.password.input.value } };
        Object.keys(f).forEach(function (k) { body[k] = f[k].input.value; });
        if (!body.fssaiValidTo) delete body.fssaiValidTo;
        api('POST', '/register', body)
          .then(function () { root.replaceChildren(login()); root.prepend(msg('ok', 'Registered. Sign in to upload your documents; our team verifies them before you can quote.')); })
          .catch(function (x) { out.replaceChildren(msg('err', x.message)); window.scrollTo(0, 0); });
      }, 'primary'), btn('Back to sign-in', function () { root.replaceChildren(login()); })])]);
  }

  /** A one-time password for a team member: shown once. */
  function secretBox(who, r) {
    return el('div', { class: 'msg ok', role: 'status' }, ['Sign-in for ' + who + ': ' + r.email + ' · temporary password ', el('code', { class: 'secret', text: r.temporaryPassword }),
      '. Give it to them privately — it is not shown again. They sign in at ' + location.origin + '/login and choose their own password first.']);
  }
  function addresses(main, out, me) {
    var owner = me.user.role === 'owner', sec = el('section', { class: 'panel' }, [el('h2', { text: 'Addresses' })]);
    sec.appendChild(table(['Type', 'Address', 'City', 'State', 'PIN', ''], (me.addresses || []).map(function (x) {
      return [x.type, [x.line1, x.line2].filter(Boolean).join(', '), x.city, x.state || '—', x.pincode, owner ? btn('Remove', function () {
        if (window.confirm('Remove this address?')) api('DELETE', '/addresses/' + x.id).then(start).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
      }, 'danger') : ''];
    })));
    if (owner) {
      var type = el('select', { 'aria-label': 'Type' }, [['registered', 'Registered office'], ['factory', 'Factory'], ['warehouse', 'Warehouse'], ['billing', 'Billing']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      var l1 = field('Address'), l2 = field('Line 2'), city = field('City'), pin = field('PIN code', { inputmode: 'numeric', maxlength: '6' }), st = stateSelect('State');
      sec.appendChild(el('div', { class: 'row' }, [el('label', {}, ['Type', type]), l1.node, l2.node, city.node, st.node, pin.node, btn('Add address', function () {
        api('POST', '/addresses', { type: type.value, line1: l1.input.value, line2: l2.input.value, city: city.input.value, stateId: Number(st.input.value) || null, pincode: pin.input.value })
          .then(start).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
      })]));
    }
    main.appendChild(sec);
  }
  function bank(main, out, me) {
    if (!me.bankAccounts) return;
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Bank accounts' }), el('p', { class: 'note', text: 'We pay only into an account our finance team has verified. Upload a cancelled cheque or bank letter under Documents for each new account.' })]);
    sec.appendChild(table(['Account holder', 'Account', 'IFSC', 'Status'], me.bankAccounts.map(function (b) { return [b.accountName, b.accountMasked, b.ifsc, b.status]; })));
    var an = field('Account holder name'), no = field('Account number', { inputmode: 'numeric', autocomplete: 'off' }), ifsc = field('IFSC', { maxlength: '11' });
    sec.appendChild(el('div', { class: 'row' }, [an.node, no.node, ifsc.node, btn('Add account', function () {
      api('POST', '/bank-accounts', { accountName: an.input.value, accountNo: no.input.value, ifsc: ifsc.input.value }).then(start).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
    })]));
    main.appendChild(sec);
  }
  function team(main, out, me) {
    if (!me.users) return;
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Your team (who can sign in)' })]), res = el('div');
    sec.appendChild(table(['Name', 'E-mail', 'Mobile', 'Role', 'Status', 'Last sign-in', ''], me.users.map(function (u) {
      var a = el('div', { class: 'row' });
      if (u.id !== me.user.id) {
        if (u.status !== 'disabled') a.appendChild(btn('New password', function () {
          if (window.confirm('Give ' + u.name + ' a new temporary password?')) api('POST', '/users/' + u.id + '/reset-password').then(function (r) { res.replaceChildren(secretBox(u.name, r)); }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
        }));
        a.appendChild(btn(u.status === 'active' ? 'Turn off' : 'Turn on', function () {
          api('POST', '/users/' + u.id + '/status', { status: u.status === 'active' ? 'disabled' : 'active' }).then(start).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
        }, u.status === 'active' ? 'danger' : ''));
      }
      return [u.name, u.email, u.mobile, u.role, u.status, u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never', a];
    })));
    var n = field('Name'), e = field('E-mail', { type: 'email' }), m = field('Mobile', { inputmode: 'numeric', maxlength: '10' });
    var r = el('select', { 'aria-label': 'Role' }, [['sales', 'Sales (quotes, prices)'], ['dispatch', 'Dispatch (deliveries, batches)'], ['accounts', 'Accounts (documents, bank, payments)'], ['owner', 'Owner (everything)']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
    sec.appendChild(el('div', { class: 'row' }, [n.node, e.node, m.node, el('label', {}, ['Role', r]), btn('Add a sign-in', function () {
      api('POST', '/users', { name: n.input.value, email: e.input.value, mobile: m.input.value, role: r.value }).then(function (x) { res.replaceChildren(secretBox(n.input.value, x)); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
    })]));
    sec.appendChild(res);
    // capabilities: what we have approved, and asking for another
    var have = (me.capabilities || []).map(function (c) { return c.capability; });
    sec.appendChild(el('h3', { text: 'What you are approved for' }));
    sec.appendChild(el('p', { class: 'note', text: (me.capabilities || []).map(function (c) { var l = CAPS.filter(function (x) { return x[0] === c.capability; })[0]; return (l ? l[1] : c.capability) + ' — ' + c.status; }).join(' · ') || '—' }));
    var more = CAPS.filter(function (c) { return have.indexOf(c[0]) === -1; });
    if (more.length) {
      var cs = el('select', { 'aria-label': 'Capability' }, more.map(function (c) { return el('option', { value: c[0], text: c[1] }); }));
      sec.appendChild(el('div', { class: 'row' }, [el('label', {}, ['Ask to also be', cs]), btn('Send request', function () {
        api('POST', '/capabilities', { capability: cs.value }).then(start).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
      })]));
    }
    main.appendChild(sec);
  }

  function home(me) {
    var main = el('main', { id: 'main' });
    main.appendChild(el('div', { class: 'row' }, [el('h1', { text: me.vendor.legal_name }), el('span', { class: 'tag', text: me.vendor.status.replace(/_/g, ' ') }), btn('Sign out', function () { logout(false); })]));
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
    // profile (identity fields are verified by us and cannot be changed here)
    profile(main, out, me);
    addresses(main, out, me);
    bank(main, out, me);
    team(main, out, me);
    // products
    var pn = field('Product name'), sku = field('Your SKU'), hsn = field('HSN'), gst = field('GST %', { inputmode: 'decimal' }), mrp = field('MRP', { inputmode: 'decimal' });
    main.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Offer a product' }), el('div', { class: 'row' }, [pn.node, sku.node, hsn.node, gst.node, mrp.node, btn('Submit', function () {
      api('POST', '/products', { name: pn.input.value, vendorSku: sku.input.value, hsnCode: hsn.input.value, gstRate: Number(gst.input.value), mrp: Number(mrp.input.value) })
        .then(function () { out.replaceChildren(msg('ok', 'Submitted for review')); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
    })])]));
    myProducts(main, out, me);
    if (me.vendor.status === 'approved') {
      var maker = (me.capabilities || []).some(function (c) { return (c.capability === 'manufacturer' || c.capability === 'contract_manufacturer') && c.status === 'approved'; });
      if (maker) manufacturing(main, out, me);
      rfqs(main, out); pos(main, out); deliveries(main); returnsToUs(main, out);
      if (me.user.role === 'owner' || me.user.role === 'accounts') accounts(main);
    }
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

  function profile(main, out, me) {
    var vd = me.vendor, owner = me.user.role === 'owner';
    var kids = [el('h2', { text: 'Profile' }), el('p', { class: 'note', text: 'Legal name ' + vd.legal_name + ' · GSTIN ' + (vd.gstin || '—') + ' · PAN ' + (vd.pan || '—') + ' · FSSAI ' + (vd.fssai_licence || '—') +
      (vd.fssai_valid_to ? ' (valid to ' + String(vd.fssai_valid_to).slice(0, 10) + ')' : '') + '. These are verified by us: to change them, upload the new certificate under Documents.' })];
    var cn = field('Your name', { value: me.user.name || '' }), cm = field('Your mobile', { value: me.user.mobile || '', inputmode: 'numeric' });
    kids.push(el('div', { class: 'row' }, [cn.node, cm.node, btn('Save my contact details', function () {
      api('PUT', '/me/contact', { contactName: cn.input.value, contactMobile: cm.input.value }).then(function () { out.replaceChildren(msg('ok', 'Contact details saved')); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
    })]));
    if (owner) {
      var tn = field('Trade name', { value: vd.trade_name || '' }), ws = field('Website', { value: vd.website || '' }), ct = field('Product categories', { value: vd.categories_note || '' });
      var br = field('Brands', { value: vd.brands_note || '' }), capn = field('What you make / capacity', { value: vd.capabilities_note || '' }), ld = field('Usual lead time (days)', { value: vd.default_lead_days == null ? '' : String(vd.default_lead_days), inputmode: 'numeric' });
      kids.push(el('div', { class: 'row' }, [tn.node, ws.node, ct.node, br.node, capn.node, ld.node, btn('Save business profile', function () {
        api('PUT', '/profile', { tradeName: tn.input.value, website: ws.input.value, categories: ct.input.value, brands: br.input.value, capabilitiesNote: capn.input.value, defaultLeadDays: ld.input.value })
          .then(function () { out.replaceChildren(msg('ok', 'Profile saved')); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
      })]));
    }
    main.appendChild(el('section', { class: 'panel' }, kids));
  }

  function myProducts(main, out, me) {
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Your products and prices' }), el('p', { class: 'note', text: 'Products and prices become active in our catalogue only after our team approves them.' })]);
    main.appendChild(sec);
    var canPrice = me.user.role === 'owner' || me.user.role === 'sales';
    api('GET', '/products').then(function (r) {
      sec.appendChild(table(['Product', 'Your SKU', 'MRP', 'Review', 'Latest price (ex-GST)', ''], r.items.map(function (p) {
        var lp = p.lastPrice ? '₹' + p.lastPrice.unitPrice.toFixed(2) + ' + ' + p.lastPrice.gstRate + '% GST from ' + p.lastPrice.validFrom + ' — ' + p.lastPrice.status : '—';
        return [p.name, p.vendorSku || '—', p.mrp == null ? '—' : '₹' + p.mrp.toFixed(2), p.status.replace(/_/g, ' ') + (p.reviewNote ? ': ' + p.reviewNote : ''), lp,
          canPrice && p.status !== 'rejected' && p.status !== 'delisted' ? btn('Submit a price', function () { priceForm(sec, out, p); }) : ''];
      })));
    }).catch(function (x) { sec.appendChild(msg('err', x.message)); });
  }
  function priceForm(sec, out, p) {
    var up = field('Unit price ex-GST (₹)', { inputmode: 'decimal' }), gst = el('select', { 'aria-label': 'GST %' }, [0, 0.25, 3, 5, 12, 18, 28, 40].map(function (g) { return el('option', { value: String(g), text: g + '%' }); }));
    var vf = field('Valid from', { type: 'date', value: new Date().toISOString().slice(0, 10) }), vt = field('Valid to (optional)', { type: 'date' }), moq = field('MOQ', { inputmode: 'numeric' }), ld = field('Lead time (days)', { inputmode: 'numeric' });
    gst.value = '5';
    sec.appendChild(el('div', { class: 'panel' }, [el('h3', { text: 'Price for ' + p.name }), el('div', { class: 'row' }, [up.node, el('label', {}, ['GST %', gst]), vf.node, vt.node, moq.node, ld.node, btn('Send for approval', function () {
      api('POST', '/price-lists', { vendorProductId: p.id, unitPrice: Number(up.input.value), gstRate: Number(gst.value), validFrom: vf.input.value, validTo: vt.input.value || null, moq: moq.input.value || null, leadDays: ld.input.value || null })
        .then(function () { out.replaceChildren(msg('ok', 'Price sent for approval')); start(); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
    }, 'primary')])]));
  }

  // ── manufacturer workspace: manufacturing orders, production updates, batches and certificates ──
  function manufacturing(main, out, me) {
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Manufacturing orders' })]), det = el('div'); main.appendChild(sec); main.appendChild(det);
    var role = me.user.role;
    api('GET', '/manufacturing-orders').then(function (r) {
      sec.appendChild(table(['Order', 'Product', 'Planned', 'Made', 'Released by QC', 'Needed by', 'Status', ''], r.items.map(function (m) {
        return [m.moNo, m.sku + ' ' + m.product, String(m.plannedQty), String(m.producedQty), String(m.releasedQty), m.plannedEnd || '—', m.status.replace(/_/g, ' '), btn('Open', function () { openMo(m.id); })];
      })));
    }).catch(function (x) { sec.appendChild(msg('err', x.message)); });
    function openMo(id) {
      api('GET', '/manufacturing-orders/' + id).then(function (m) {
        var o2 = el('div'), kids = [o2, el('p', {}, [m.sku + ' ' + m.product + ' · planned ' + m.plannedQty + ' · needed by ' + (m.plannedEnd || '—') + (m.poNo ? ' · against PO ' + m.poNo : '')])];
        var post = function (path, body) { return api('POST', '/manufacturing-orders/' + id + path, body).then(function () { openMo(id); }).catch(function (x) { o2.replaceChildren(msg('err', x.message)); }); };
        if (m.status === 'released' && (role === 'owner' || role === 'sales')) {
          kids.push(el('div', { class: 'row' }, [btn('Accept order', function () { post('/respond', { response: 'accepted' }); }, 'primary'),
            btn('Decline', function () { var n = window.prompt('Why can you not take this order?'); if (n) post('/respond', { response: 'declined', note: n }); }, 'danger')]));
        }
        var working = m.status === 'accepted' || m.status === 'in_production';
        if (working && (role === 'owner' || role === 'dispatch')) {
          var st = field('Stage (mixing, filling, packing…)'), q = field('Made so far', { inputmode: 'numeric' }), n = field('Note');
          kids.push(el('h3', { text: 'Production update' }), el('div', { class: 'row' }, [st.node, q.node, n.node, btn('Post update', function () {
            post('/progress', { stage: st.input.value, qty: q.input.value === '' ? null : Number(q.input.value), note: n.input.value });
          })]));
          var bn = field('Batch number'), mf = field('Manufactured on', { type: 'date' }), ex = field('Expiry', { type: 'date' }), bq = field('Quantity', { inputmode: 'numeric' });
          var coa = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.webp', 'aria-label': 'Certificate of Analysis' });
          kids.push(el('h3', { text: 'Record a batch' }), el('p', { class: 'note', text: 'Attach its Certificate of Analysis. Our quality team releases the batch before you dispatch it; only released batches can go on a dispatch notice.' }),
            el('div', { class: 'row' }, [bn.node, mf.node, ex.node, bq.node, el('label', {}, ['Certificate of Analysis', coa]), btn('Record batch', function () {
              api('POST', '/manufacturing-orders/' + id + '/batches', { batchNo: bn.input.value, mfgDate: mf.input.value, expiryDate: ex.input.value, qty: Number(bq.input.value) }).then(function (r) {
                if (!coa.files[0]) return null;
                var fd = new FormData(); fd.append('docType', 'coa'); fd.append('batchId', String(r.batchId)); fd.append('file', coa.files[0]);
                return api('POST', '/manufacturing-orders/' + id + '/documents', fd);
              }).then(function () { openMo(id); }).catch(function (x) { o2.replaceChildren(msg('err', x.message)); });
            }, 'primary')]));
        }
        kids.push(el('h3', { text: 'Batches' }), table(['Batch', 'Made', 'Expiry', 'Qty', 'Our QC', 'Certificate', ''], m.batches.map(function (b) {
          var up = el('span');
          if (!b.hasCoa && b.status === 'submitted' && (role === 'owner' || role === 'dispatch')) {
            var f = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.webp', 'aria-label': 'Certificate for ' + b.batchNo });
            up = el('div', { class: 'row' }, [f, btn('Upload certificate', function () {
              if (!f.files[0]) return; var fd = new FormData(); fd.append('docType', 'coa'); fd.append('batchId', String(b.id)); fd.append('file', f.files[0]);
              api('POST', '/manufacturing-orders/' + id + '/documents', fd).then(function () { openMo(id); }).catch(function (x) { o2.replaceChildren(msg('err', x.message)); });
            })]);
          }
          var qc = b.status === 'submitted' ? 'waiting' : (b.status === 'released' ? 'released' + (b.rejectedQty ? ' (' + b.rejectedQty + ' rejected)' : '') + ' — you may dispatch it' : 'rejected — do not dispatch');
          return [b.batchNo, b.mfgDate, b.expiryDate, String(b.qty), qc + (b.qcNote ? ': ' + b.qcNote : ''), b.hasCoa ? 'attached' : 'missing', up];
        })));
        kids.push(el('h3', { text: 'History' }), table(['When', 'What', 'Stage', 'Qty', 'Note', 'By'], m.events.map(function (e) {
          return [new Date(e.at).toLocaleString(), e.kind.replace(/_/g, ' '), e.stage || '—', e.qty == null ? '—' : String(e.qty), e.note || '—', e.by]; })));
        det.replaceChildren(el('section', { class: 'panel' }, [el('h2', { text: m.moNo + ' — ' + m.status.replace(/_/g, ' ') })].concat(kids)));
        det.scrollIntoView({ behavior: 'smooth' });
      }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
    }
  }

  function deliveries(main) {
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Your deliveries to us' })]); main.appendChild(sec);
    api('GET', '/deliveries').then(function (r) {
      sec.appendChild(table(['Dispatch notice', 'PO', 'Transporter / LR', 'Dispatched', 'Expected', 'Received', 'Status'], r.items.map(function (a) {
        return [a.deliveryNoteNo || a.invoiceNo || ('#' + a.id), a.poNo, [a.transporter, a.lrNo].filter(Boolean).join(' · ') || '—', a.dispatchedAt ? new Date(a.dispatchedAt).toLocaleString() : '—',
          a.expectedAt ? new Date(a.expectedAt).toLocaleString() : '—', a.receivedAt ? new Date(a.receivedAt).toLocaleString() : '—', a.status + (a.late ? ' — LATE by ' + a.lateHours + ' h' : '')];
      })));
    }).catch(function (x) { sec.appendChild(msg('err', x.message)); });
  }

  function accounts(main) {
    var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Invoices and payments' })]); main.appendChild(sec);
    api('GET', '/accounts').then(function (r) {
      sec.appendChild(el('h3', { text: 'Your invoices with us' }));
      sec.appendChild(table(['Invoice', 'Date', 'PO', 'Total', 'Paid', 'Outstanding', 'Due', 'Status'], r.invoices.map(function (i) {
        return [i.invoiceNo, i.date || '—', i.poNo || '—', '₹' + i.total.toFixed(2), '₹' + i.paid.toFixed(2), '₹' + i.outstanding.toFixed(2), i.dueDate || '—', i.status.replace(/_/g, ' ')];
      })));
      sec.appendChild(el('h3', { text: 'Payments made to you' }));
      sec.appendChild(table(['Payment', 'Date', 'Method', 'Amount', 'TDS', 'Reference'], r.payments.map(function (p) {
        return [p.paymentNo, p.paidAt ? new Date(p.paidAt).toLocaleDateString() : '—', p.method.replace(/_/g, ' '), '₹' + p.amount.toFixed(2), '₹' + p.tds.toFixed(2), p.reference || '—'];
      })));
    }).catch(function (x) { sec.appendChild(msg('err', x.message)); });
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
    if (!token) { root.replaceChildren(/[?&]register\b/.test(location.search) ? register() : login()); return; }
    api('GET', '/me').then(home).catch(function () { logout(true); });
  }
  start();
})();
