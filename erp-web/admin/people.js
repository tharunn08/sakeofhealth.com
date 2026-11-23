/* Business platform admin — the people the business works with:
     • Manufacturers & Suppliers: everything about each supplier / manufacturer (identity, sign-ins, addresses,
       bank accounts, documents, verification, products and prices), adding one with its sign-in;
     • Salesmen: each salesman's day and month, orders, visits, cash in hand, beats, targets and positions;
     • Delivery: one dashboard for shop and trade deliveries, and the delivery staff with their workload.
   Text via textContent only; the server checks every permission again. */
(function () {
  'use strict';
  var E = window.ERP, el = E.el, api = E.api, msg = E.msg, fmt = E.fmt, table = E.table, kpi = E.kpi;
  var B = '/api/erp', V = '/api/erp/vendors', S = '/api/erp/sales', D = '/api/erp/deliveries';
  function err(box) { return function (e) { box.prepend(msg('err', e.message)); }; }
  function btn(text, onClick, kind) { return el('button', { class: 'btn' + (kind ? ' ' + kind : ''), type: 'button', text: text, on: { click: onClick } }); }
  function input(label, attrs) { var i = el('input', Object.assign({ 'aria-label': label }, attrs || {})); return { node: el('label', {}, [label, i]), input: i }; }
  function select(label, opts, value) {
    var s = el('select', { 'aria-label': label }, opts.map(function (o) { return el('option', { value: String(o[0]), text: o[1] }); }));
    if (value != null) s.value = String(value);
    return { node: el('label', {}, [label, s]), input: s };
  }
  function check(label, on) { var c = el('input', { type: 'checkbox', 'aria-label': label }); c.checked = !!on; return { node: el('label', { class: 'chk' }, [c, ' ' + label]), input: c }; }
  function section(title, kids) { return el('section', { class: 'panel' }, [el('h2', { text: title })].concat(kids)); }
  function money(v) { return v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function day(v) { return v ? String(v).slice(0, 10) : '—'; }
  function label(s) { return String(s || '').replace(/_/g, ' '); }
  function ask(text) { var v = window.prompt(text); return v == null ? null : v.trim(); }
  function tag(t, kind) { return el('span', { class: 'tag' + (kind ? ' ' + kind : ''), text: label(t) }); }
  function row(kids) { return el('div', { class: 'row' }, kids); }
  function kpis(list) { return el('div', { class: 'grid' }, list.map(function (k) { return kpi(k[0], k[1]); })); }
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
  function openFile(path) {
    var h = {}, t = E.state && E.state.token;
    if (t) h.Authorization = 'Bearer ' + t;
    fetch(path, { headers: h, credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('Could not open (' + r.status + ')')); });
      return r.blob();
    }).then(function (b) { var url = URL.createObjectURL(b); window.open(url, '_blank', 'noopener'); setTimeout(function () { URL.revokeObjectURL(url); }, 60000); })
      .catch(function (e) { window.alert(e.message); });
  }
  /** A one-time password, shown once in a box the person can copy from. */
  function secretBox(who, login) {
    var code = el('code', { class: 'secret', text: login.temporaryPassword });
    return el('div', { class: 'msg ok', role: 'status' }, [
      el('strong', { text: 'Sign-in created for ' + who + '. ' }),
      'E-mail: ' + login.email + ' · temporary password: ', code, ' ',
      btn('Copy', function () { if (navigator.clipboard) navigator.clipboard.writeText(login.temporaryPassword); }),
      el('p', { class: 'note', text: 'Give it to them privately (it is not stored and cannot be shown again). They sign in at ' + location.origin + '/login' +
        (login.mustChangeAtFirstSignIn === false ? '.' : ' and must choose their own password first.') }),
    ]);
  }
  var STATES = null;
  function states() { return STATES ? Promise.resolve(STATES) : api('GET', V + '-lookup/states').then(function (r) { STATES = r.items; return STATES; }); }
  function addressForm(onSave, stateList) {
    var type = select('Type', [['registered', 'Registered office'], ['factory', 'Factory'], ['warehouse', 'Warehouse'], ['billing', 'Billing']]);
    var l1 = input('Address line 1'), l2 = input('Line 2 (optional)'), city = input('City'), pin = input('PIN code', { inputmode: 'numeric', maxlength: '6' });
    var st = select('State', [['', 'Choose…']].concat(stateList.map(function (s) { return [s.id, s.name]; })));
    var lat = input('Latitude (optional)', { inputmode: 'decimal' }), lng = input('Longitude (optional)', { inputmode: 'decimal' });
    return {
      node: row([type.node, l1.node, l2.node, city.node, st.node, pin.node, lat.node, lng.node, btn('Add address', function () {
        onSave({ type: type.input.value, line1: l1.input.value, line2: l2.input.value, city: city.input.value, stateId: Number(st.input.value) || null, pincode: pin.input.value,
          latitude: lat.input.value || null, longitude: lng.input.value || null });
      }, 'primary')]),
    };
  }
  var CAP_LABEL = { manufacturer: 'Manufacturer (own brand)', contract_manufacturer: 'Contract manufacturer', authorised_distributor: 'Authorised distributor', supplier_wholesaler: 'Supplier / wholesaler' };
  function capText(list) {
    return String(list || '').split(',').filter(Boolean).map(function (c) { var p = c.split(':'); return (CAP_LABEL[p[0]] || label(p[0])) + (p[1] && p[1] !== 'approved' ? ' (' + label(p[1]) + ')' : ''); }).join(', ') || '—';
  }

  // ═══════════════ Manufacturers & Suppliers ═══════════════
  function vendors(main) {
    main.appendChild(el('h1', { text: 'Manufacturers & Suppliers' }));
    main.appendChild(el('p', { class: 'note', text: 'Every manufacturer and supplier, with their sign-ins, addresses, bank accounts, documents, verification, products and prices. They sign in at /login (or /vendor-portal/) with the e-mail and password set here or at registration.' }));
    var head = el('div'); main.appendChild(head);
    var list = [['list', 'All']];
    if (E.has('vendors.create')) list.push(['add', 'Add manufacturer / supplier']);
    var t = tabs(list, draw), det = el('div', { id: 'vendorDetail' });
    main.appendChild(t.node); main.appendChild(det);
    setTimeout(function () { t.go('list'); }, 0);
    function draw(k, body) {
      if (k === 'list') return drawList(body);
      return drawAdd(body);
    }
    function drawList(body) {
      var q = input('Search name, GSTIN, code, e-mail or mobile'), st = select('Status', [['', 'All'], ['submitted', 'Submitted'], ['under_verification', 'Under verification'], ['more_info_required', 'More information required'], ['approved', 'Approved'], ['suspended', 'Suspended'], ['rejected', 'Rejected'], ['draft', 'Invited (not yet active)']]);
      var cap = select('Type', [['', 'All types']].concat(Object.keys(CAP_LABEL).map(function (c) { return [c, CAP_LABEL[c]]; })));
      var box = el('div');
      body.appendChild(row([q.node, st.node, cap.node, btn('Search', load, 'primary')]));
      body.appendChild(box);
      q.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
      function load() {
        var p = new URLSearchParams(); if (q.input.value) p.set('q', q.input.value); if (st.input.value) p.set('status', st.input.value); if (cap.input.value) p.set('capability', cap.input.value);
        box.replaceChildren(el('p', { class: 'note', text: 'Loading…' }));
        api('GET', V + '?' + p.toString()).then(function (r) {
          var s = r.byStatus || {};
          head.replaceChildren(kpis([['Approved', s.approved || 0], ['Waiting for checks', (s.submitted || 0) + (s.under_verification || 0)], ['More info asked', s.more_info_required || 0], ['Suspended', s.suspended || 0], ['Invited', s.draft || 0]]));
          box.replaceChildren(table(['Business', 'Type', 'GSTIN', 'Place', 'Owner (signs in as)', 'Status', 'To review', ''], r.items.map(function (v) {
            var pend = [];
            if (v.docs_pending) pend.push(v.docs_pending + ' document(s)');
            if (v.banks_pending) pend.push(v.banks_pending + ' bank account(s)');
            if (v.products_pending) pend.push(v.products_pending + ' product(s)');
            return [v.legal_name + (v.trade_name ? ' (' + v.trade_name + ')' : '') + (v.vendor_code ? ' · ' + v.vendor_code : ''), capText(v.capabilities), v.gstin || '—',
              [v.city, v.state].filter(Boolean).join(', ') || '—', v.owner ? v.owner.name + ' · ' + v.owner.email + ' · ' + v.owner.mobile + (v.owner.lastLoginAt ? '' : ' · never signed in') : '—',
              tag(v.status), pend.join(', ') || '—', btn('Open', function () { detail(det, v.id); })];
          })));
        }).catch(err(box));
      }
      load();
    }
    function drawAdd(body) {
      states().then(function (stateList) {
        var out = el('div');
        var ln = input('Legal name *'), tn = input('Trade name'), gst = input('GSTIN', { maxlength: '15' }), pan = input('PAN', { maxlength: '10' }), fssai = input('FSSAI licence no.'), fv = input('FSSAI valid to', { type: 'date' });
        var web = input('Website'), cats = input('Product categories'), terms = input('Payment terms (days)', { inputmode: 'numeric' }), lead = input('Usual lead time (days)', { inputmode: 'numeric' });
        var caps = Object.keys(CAP_LABEL).map(function (c) { var x = check(CAP_LABEL[c], c === 'supplier_wholesaler'); x.input.value = c; return x; });
        var on = input('Owner\'s name *'), oe = input('Owner\'s e-mail * (sign-in name)', { type: 'email' }), om = input('Owner\'s mobile *', { inputmode: 'numeric', maxlength: '10' });
        var how = select('How they get in', [['password', 'Create the sign-in now (temporary password shown once)'], ['invite', 'One-time activation link (they set their own password)']]);
        var a = { l1: input('Address line 1'), city: input('City'), pin: input('PIN code', { inputmode: 'numeric', maxlength: '6' }), st: select('State', [['', 'Choose…']].concat(stateList.map(function (s) { return [s.id, s.name]; }))) };
        body.appendChild(section('Business', [row([ln.node, tn.node, gst.node, pan.node]), row([fssai.node, fv.node, web.node, cats.node]), row([terms.node, lead.node]),
          el('p', { class: 'note', text: 'What they are (tick all that apply)' }), row(caps.map(function (c) { return c.node; }))]));
        body.appendChild(section('Registered office (optional)', [row([a.l1.node, a.city.node, a.st.node, a.pin.node])]));
        body.appendChild(section('Owner and sign-in', [row([on.node, oe.node, om.node, how.node]), out, btn('Add', function () {
          var payload = { legalName: ln.input.value, tradeName: tn.input.value, gstin: gst.input.value, pan: pan.input.value, fssaiLicence: fssai.input.value, fssaiValidTo: fv.input.value || null,
            website: web.input.value, categoriesNote: cats.input.value, paymentTermsDays: terms.input.value, defaultLeadDays: lead.input.value,
            capabilities: caps.filter(function (c) { return c.input.checked; }).map(function (c) { return c.input.value; }),
            user: { name: on.input.value, email: oe.input.value, mobile: om.input.value } };
          if (a.l1.input.value || a.city.input.value || a.pin.input.value) payload.address = { type: 'registered', line1: a.l1.input.value, city: a.city.input.value, pincode: a.pin.input.value, stateId: Number(a.st.input.value) || null };
          if (how.input.value === 'invite') {
            delete payload.paymentTermsDays; delete payload.defaultLeadDays;
            api('POST', V + '/invite', payload).then(function (r) {
              var link = location.origin + r.invitePath;
              out.replaceChildren(el('div', { class: 'msg ok', role: 'status' }, ['Added. Send this one-time link privately (valid ' + r.expiresInDays + ' days): ', el('code', { class: 'secret', text: link }), ' ',
                btn('Copy', function () { if (navigator.clipboard) navigator.clipboard.writeText(link); }), ' ', btn('Open the record', function () { detail(det, r.vendorId); })]));
            }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
          } else {
            api('POST', V, payload).then(function (r) {
              out.replaceChildren(secretBox(on.input.value, r.login), btn('Open the record', function () { detail(det, r.vendorId); }));
            }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
          }
        }, 'primary')]));
      }).catch(err(body));
    }
  }

  function detail(det, id, openTab) {
    if (!openTab) det.replaceChildren(el('p', { class: 'note', text: 'Loading…' }));
    api('GET', V + '/' + id).then(function (d) {
      var vd = d.vendor, box = el('div'), top = el('div'), t;
      var reload = function () { detail(det, id, t.current()); };
      t = tabs([['overview', 'Overview'], ['people', 'Sign-ins (' + d.users.length + ')'], ['addresses', 'Addresses (' + d.addresses.length + ')'], ['bank', 'Bank accounts (' + d.bankAccounts.length + ')'],
        ['docs', 'Documents & checks (' + d.documents.length + ')'], ['products', 'Products & prices (' + d.products.length + ')']], draw);
      top.appendChild(el('div', { class: 'row' }, [el('h2', { text: vd.legal_name + (vd.vendor_code ? ' · ' + vd.vendor_code : '') }), tag(vd.status), btn('Close', function () { det.replaceChildren(); })]));
      var tr = d.trade || {};
      top.appendChild(kpis([
        ['Type', d.capabilities.map(function (c) { return (CAP_LABEL[c.capability] || label(c.capability)) + (c.status !== 'approved' ? ' (' + label(c.status) + ')' : ''); }).join(', ') || '—'],
        ['Purchase orders', tr.purchaseOrders ? tr.purchaseOrders.count + ' (' + tr.purchaseOrders.open + ' open) · ' + money(tr.purchaseOrders.value) : '—'],
        ['Manufacturing orders', tr.manufacturingOrders ? tr.manufacturingOrders.count + ' (' + tr.manufacturingOrders.open + ' open)' : '—'],
        ['Deliveries to us', tr.deliveries ? tr.deliveries.count + ' (' + tr.deliveries.inTransit + ' on the way)' : '—'],
      ]));
      det.replaceChildren(el('section', { class: 'panel' }, [top, box, t.node]));
      setTimeout(function () { t.go(openTab || 'overview'); if (!openTab) det.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 0);

      function draw(k, body) {
        var out = el('div'); body.appendChild(out);
        var fail = function (e) { out.replaceChildren(msg('err', e.message)); };
        if (k === 'overview') {
          var facts = [['Legal name', vd.legal_name], ['Trade name', vd.trade_name], ['GSTIN', vd.gstin], ['PAN', vd.pan], ['CIN', vd.cin], ['FSSAI licence', vd.fssai_licence ? vd.fssai_licence + (vd.fssai_valid_to ? ' (valid to ' + day(vd.fssai_valid_to) + ')' : '') : null],
            ['MSME Udyam', vd.msme_udyam], ['State (GST)', d.state ? d.state.name + ' (' + d.state.gst_code + ')' : null], ['Website', vd.website], ['Categories', vd.categories_note], ['Brands', vd.brands_note],
            ['What they make / capacity', vd.capabilities_note], ['Payment terms', vd.payment_terms_days != null ? vd.payment_terms_days + ' days' : null], ['Lead time', vd.default_lead_days != null ? vd.default_lead_days + ' days' : null],
            ['Credit terms', vd.credit_terms_note], ['Joined', fmt(vd.created_at)], ['How', vd.onboarding === 'self' ? 'Registered themselves' : 'Added by our team'], ['Approved', vd.approved_at ? fmt(vd.approved_at) : null]];
          body.appendChild(table(['', ''], facts.map(function (f) { return [f[0], f[1] == null || f[1] === '' ? '—' : String(f[1])]; })));
          if (E.has('vendors.create')) {
            var f = { legalName: input('Legal name', { value: vd.legal_name || '' }), tradeName: input('Trade name', { value: vd.trade_name || '' }), gstin: input('GSTIN', { value: vd.gstin || '' }), pan: input('PAN', { value: vd.pan || '' }),
              fssaiLicence: input('FSSAI', { value: vd.fssai_licence || '' }), fssaiValidTo: input('FSSAI valid to', { type: 'date', value: vd.fssai_valid_to ? day(vd.fssai_valid_to) : '' }), msmeUdyam: input('MSME Udyam', { value: vd.msme_udyam || '' }),
              website: input('Website', { value: vd.website || '' }), categoriesNote: input('Categories', { value: vd.categories_note || '' }), brandsNote: input('Brands', { value: vd.brands_note || '' }),
              capabilitiesNote: input('What they make / capacity', { value: vd.capabilities_note || '' }), paymentTermsDays: input('Payment terms (days)', { value: vd.payment_terms_days == null ? '' : String(vd.payment_terms_days), inputmode: 'numeric' }),
              defaultLeadDays: input('Lead time (days)', { value: vd.default_lead_days == null ? '' : String(vd.default_lead_days), inputmode: 'numeric' }), creditTermsNote: input('Credit terms note', { value: vd.credit_terms_note || '' }) };
            var reason = input('Why (kept in the audit log)');
            body.appendChild(section('Edit details', [row(Object.keys(f).map(function (k2) { return f[k2].node; })), row([reason.node, btn('Save changes', function () {
              var p = { reason: reason.input.value };
              Object.keys(f).forEach(function (k2) { p[k2] = f[k2].input.value; });
              if (!p.fssaiValidTo) p.fssaiValidTo = null;
              api('PUT', V + '/' + id, p).then(reload).catch(fail);
            }, 'primary')])]));
          }
          if (E.has('vendors.verify')) {
            var caps = d.capabilities.map(function (c) {
              var a = row([]);
              if (c.status !== 'approved' && vd.status === 'approved') a.appendChild(btn('Approve', function () { api('POST', V + '/' + id + '/capabilities', { capability: c.capability, status: 'approved' }).then(reload).catch(fail); }));
              if (c.status === 'requested') a.appendChild(btn('Reject', function () { var n = ask('Why?'); if (n) api('POST', V + '/' + id + '/capabilities', { capability: c.capability, status: 'rejected', note: n }).then(reload).catch(fail); }, 'danger'));
              if (c.status === 'approved') a.appendChild(btn('Suspend', function () { var n = ask('Why?'); if (n) api('POST', V + '/' + id + '/capabilities', { capability: c.capability, status: 'suspended', note: n }).then(reload).catch(fail); }, 'danger'));
              return [CAP_LABEL[c.capability] || label(c.capability), label(c.status), c.decided_at ? fmt(c.decided_at) : '—', a];
            });
            body.appendChild(section('What they may do', [table(['Capability', 'Status', 'Decided', ''], caps),
              el('p', { class: 'note', text: 'All capabilities they asked for are approved together with the business; here you can change one later.' })]));
            if (vd.status !== 'suspended' && vd.status !== 'rejected') {
              body.appendChild(row([btn('Suspend this business (ends all their sign-ins now)', function () {
                var r2 = ask('Reason for suspending (at least 5 characters)'); if (r2) api('POST', V + '/' + id + '/suspend', { reason: r2 }).then(reload).catch(fail);
              }, 'danger')]));
            }
          }
        }
        if (k === 'people') {
          body.appendChild(table(['Name', 'E-mail (sign-in)', 'Mobile', 'Role', 'Status', 'Last sign-in', ''], d.users.map(function (u) {
            var a = row([]);
            if (E.has('vendors.create') && u.status !== 'disabled') a.appendChild(btn('New temporary password', function () {
              if (!window.confirm('Give ' + u.name + ' a new temporary password? Their current password and sessions stop working.')) return;
              api('POST', V + '/' + id + '/users/' + u.id + '/reset-password').then(function (r) { out.replaceChildren(secretBox(u.name, r)); }).catch(fail);
            }));
            if (E.has('vendors.verify')) {
              if (u.status === 'active') a.appendChild(btn('Turn off', function () { api('POST', V + '/' + id + '/users/' + u.id + '/status', { status: 'disabled' }).then(reload).catch(fail); }, 'danger'));
              if (u.status === 'disabled') a.appendChild(btn('Turn on', function () { api('POST', V + '/' + id + '/users/' + u.id + '/status', { status: 'active' }).then(reload).catch(fail); }));
            }
            return [u.name, u.email, u.mobile, label(u.role), label(u.status) + (u.locked ? ' (locked: too many attempts)' : '') + (u.mustChangePassword ? ' · must set own password' : ''), u.lastLoginAt ? fmt(u.lastLoginAt) : 'never', a];
          })));
          if (E.has('vendors.create')) {
            var n = input('Name'), e = input('E-mail', { type: 'email' }), m = input('Mobile', { inputmode: 'numeric', maxlength: '10' });
            var r = select('Role', [['sales', 'Sales (quotes, prices)'], ['dispatch', 'Dispatch (deliveries, batches)'], ['accounts', 'Accounts (documents, bank, payments)'], ['owner', 'Owner (everything)']]);
            body.appendChild(section('Add a sign-in for this business', [row([n.node, e.node, m.node, r.node, btn('Create sign-in', function () {
              api('POST', V + '/' + id + '/users', { name: n.input.value, email: e.input.value, mobile: m.input.value, role: r.input.value }).then(function (x) { out.replaceChildren(secretBox(n.input.value, x), btn('Refresh the list', reload)); }).catch(fail);
            }, 'primary')])]));
          }
        }
        if (k === 'addresses') {
          body.appendChild(table(['Type', 'Address', 'City', 'State', 'PIN', 'Map', ''], d.addresses.map(function (a) {
            var map = a.latitude != null ? el('a', { href: 'https://www.google.com/maps?q=' + a.latitude + ',' + a.longitude, target: '_blank', rel: 'noopener', text: 'Open' }) : '—';
            return [label(a.type), [a.line1, a.line2].filter(Boolean).join(', '), a.city, a.state || '—', a.pincode, map,
              E.has('vendors.create') ? btn('Remove', function () { if (window.confirm('Remove this address?')) api('DELETE', V + '/' + id + '/addresses/' + a.id).then(reload).catch(fail); }, 'danger') : ''];
          })));
          if (E.has('vendors.create')) states().then(function (sl) { body.appendChild(section('Add an address', [addressForm(function (p) { api('POST', V + '/' + id + '/addresses', p).then(reload).catch(fail); }, sl).node])); }).catch(fail);
        }
        if (k === 'bank') {
          body.appendChild(el('p', { class: 'note', text: 'Account numbers are stored encrypted and shown masked. A new account is not used for any payment until a second person verifies it (the person who added it cannot).' }));
          body.appendChild(table(['Account holder', 'Account', 'IFSC', 'Status', 'Verified by', 'Added', ''], d.bankAccounts.map(function (b) {
            var a = row([]);
            if (b.status === 'pending' && E.has('vendors.verify')) {
              a.appendChild(btn('Verify', function () { api('POST', V + '/' + id + '/bank-accounts/' + b.id + '/verify', { status: 'verified' }).then(reload).catch(fail); }, 'primary'));
              a.appendChild(btn('Reject', function () { var n2 = ask('Why?'); if (n2) api('POST', V + '/' + id + '/bank-accounts/' + b.id + '/verify', { status: 'rejected', note: n2 }).then(reload).catch(fail); }, 'danger'));
            }
            return [b.accountName, b.accountMasked, b.ifsc, label(b.status), b.verifiedBy || '—', fmt(b.addedAt), a];
          })));
          if (E.has('vendors.create')) {
            var an = input('Account holder name'), no = input('Account number', { inputmode: 'numeric', autocomplete: 'off' }), ifsc = input('IFSC', { maxlength: '11' });
            body.appendChild(section('Add a bank account', [row([an.node, no.node, ifsc.node, btn('Add', function () {
              api('POST', V + '/' + id + '/bank-accounts', { accountName: an.input.value, accountNo: no.input.value, ifsc: ifsc.input.value }).then(reload).catch(fail);
            }, 'primary')])]));
          }
        }
        if (k === 'docs') {
          body.appendChild(table(['Document', 'File', 'Valid to', 'Review', 'Uploaded', ''], d.documents.map(function (doc) {
            var a = row([btn('View', function () { openFile(V + '/' + id + '/documents/' + doc.id + '/file'); })]);
            if (doc.review_status === 'pending' && E.has('vendors.verify')) {
              a.appendChild(btn('Accept', function () { api('POST', V + '/' + id + '/documents/' + doc.id + '/review', { status: 'accepted' }).then(reload).catch(fail); }, 'primary'));
              a.appendChild(btn('Reject', function () { var n3 = ask('Why?'); if (n3) api('POST', V + '/' + id + '/documents/' + doc.id + '/review', { status: 'rejected', note: n3 }).then(reload).catch(fail); }, 'danger'));
            }
            return [label(doc.doc_type), doc.original_name, day(doc.valid_to), label(doc.review_status) + (doc.review_note ? ': ' + doc.review_note : ''), fmt(doc.created_at), a];
          })));
          body.appendChild(el('h3', { text: 'Verification' }));
          body.appendChild(el('p', { class: 'note', text: 'Each stage is recorded by a person. When every stage has passed and every document is reviewed, the "admin" stage sends the business for approval by a second person.' }));
          body.appendChild(table(['Stage', 'Outcome', 'Note', 'When'], d.verifications.map(function (x) { return [label(x.stage), label(x.outcome), x.note || '—', fmt(x.created_at)]; })));
          if (E.has('vendors.verify') && ['approved', 'rejected', 'suspended'].indexOf(vd.status) === -1) {
            var stg = select('Stage', [['verification', 'Verification'], ['document_review', 'Document review'], ['procurement', 'Procurement'], ['finance_compliance', 'Finance & compliance'], ['admin', 'Admin (final)']]);
            var oc = select('Outcome', [['passed', 'Passed'], ['more_info_required', 'More information required'], ['failed', 'Failed (reject)']]), nt = input('Note');
            body.appendChild(row([stg.node, oc.node, nt.node, btn('Record', function () {
              api('POST', V + '/' + id + '/verifications', { stage: stg.input.value, outcome: oc.input.value, note: nt.input.value }).then(function (r2) {
                reload(); if (r2.approval) window.alert('All stages passed — sent to a second person for approval (Administration → Approvals).');
              }).catch(fail);
            }, 'primary')]));
          }
        }
        if (k === 'products') {
          body.appendChild(table(['Product', 'Their SKU', 'HSN', 'MRP', 'Pack', 'Status', 'Our product', ''], d.products.map(function (p) {
            var a = row([]);
            if (['submitted', 'under_review'].indexOf(p.status) !== -1 && E.has('vendors.products.approve')) {
              var q = input('Find our product (SKU or name)'), pick = el('select', { 'aria-label': 'Our product' }, [el('option', { value: '', text: 'Search first…' })]);
              q.input.addEventListener('change', function () {
                api('GET', V + '-lookup/products?q=' + encodeURIComponent(q.input.value)).then(function (r3) {
                  pick.replaceChildren.apply(pick, [el('option', { value: '', text: r3.items.length ? 'Choose…' : 'No match' })].concat(r3.items.map(function (x) { return el('option', { value: String(x.id), text: x.sku + ' — ' + x.name }); })));
                }).catch(fail);
              });
              a.appendChild(q.node); a.appendChild(pick);
              a.appendChild(btn('Approve', function () { api('POST', B + '/vendor-products/' + p.id + '/decide', { decision: 'approved', productId: Number(pick.value) }).then(reload).catch(fail); }, 'primary'));
              a.appendChild(btn('Reject', function () { var n4 = ask('Why?'); if (n4) api('POST', B + '/vendor-products/' + p.id + '/decide', { decision: 'rejected', note: n4 }).then(reload).catch(fail); }, 'danger'));
            }
            return [p.name + (p.brand ? ' · ' + p.brand : ''), p.vendor_sku || '—', p.hsn_code || '—', p.mrp == null ? '—' : money(p.mrp), p.pack_size || '—', label(p.status) + (p.review_note ? ': ' + p.review_note : ''),
              p.mapped_sku ? p.mapped_sku + ' — ' + p.mapped_name : '—', a];
          })));
          body.appendChild(el('h3', { text: 'Prices they offered' }));
          body.appendChild(table(['Product', 'Unit price (ex-GST)', 'GST', 'Discount', 'Freight / unit', 'MOQ', 'Lead', 'Valid', 'Status', ''], d.prices.map(function (p) {
            var a = row([]);
            if (p.status === 'submitted' && E.has('vendors.products.approve')) {
              a.appendChild(btn('Accept', function () { api('POST', B + '/vendor-prices/' + p.id + '/decide', { decision: 'accepted' }).then(reload).catch(fail); }, 'primary'));
              a.appendChild(btn('Reject', function () { var n5 = ask('Why?'); if (n5) api('POST', B + '/vendor-prices/' + p.id + '/decide', { decision: 'rejected', note: n5 }).then(reload).catch(fail); }, 'danger'));
            }
            return [p.product, money(p.unit_price), Number(p.gst_rate) + '%', Number(p.discount_pct) + '%', money(p.freight_per_unit), p.moq == null ? '—' : String(p.moq), p.lead_days == null ? '—' : p.lead_days + ' d',
              day(p.valid_from) + ' → ' + (p.valid_to ? day(p.valid_to) : 'open'), label(p.status), a];
          })));
        }
      }
    }).catch(function (e) { det.replaceChildren(msg('err', e.message)); });
  }

  // ═══════════════ Salesmen ═══════════════
  var METRICS = [['sales_value', 'Sales value (₹)'], ['orders', 'Orders'], ['new_retailers', 'New retailers'], ['collections', 'Collections (₹)'], ['visits', 'Visits']];
  function salesmen(main) {
    main.appendChild(el('h1', { text: 'Salesmen' }));
    main.appendChild(el('p', { class: 'note', text: 'Each salesman\'s day and month: orders the retailer confirmed, shop visits, cash collected and not yet handed over, beats and targets. Salesmen work in the field app at /sales-app/.' }));
    var head = el('div'); main.appendChild(head);
    var list = [['list', 'All salesmen']];
    if (E.has('core.staff.edit')) list.push(['add', 'Add a salesman']);
    if (E.has('sales.targets.edit')) list.push(['targets', 'Set targets']);
    var t = tabs(list, draw), det = el('div', { id: 'salesmanDetail' });
    main.appendChild(t.node); main.appendChild(det);
    var cache = null;
    setTimeout(function () { t.go('list'); }, 0);
    function load(month) { return api('GET', S + '/salesmen' + (month ? '?month=' + month : '')).then(function (r) { cache = r; return r; }); }
    function draw(k, body) {
      if (k === 'list') {
        var month = input('Month', { type: 'month', value: new Date().toISOString().slice(0, 7) }), box = el('div');
        body.appendChild(row([month.node, btn('Show', show, 'primary')])); body.appendChild(box);
        function show() {
          box.replaceChildren(el('p', { class: 'note', text: 'Loading…' }));
          load(month.input.value).then(function (r) {
            var tt = r.totals;
            head.replaceChildren(kpis([['Active salesmen', tt.salesmen], ['Orders today', tt.todayOrders + ' · ' + money(tt.todayValue)], ['Visits today', tt.todayVisits], ['Sales this month', money(tt.monthValue)],
              ['Cash in hand (not handed over)', money(tt.cashInHand)], ['Over their cash limit', tt.overCashLimit]]));
            box.replaceChildren(table(['Salesman', 'Territory', 'Today', 'Month (' + r.month + ')', 'Target', 'Cash in hand', 'Last seen', 'Status', ''], r.items.map(function (s) {
              var n = s.numbers, over = s.cashLimit > 0 && n.cashInHand > s.cashLimit;
              var tg = n.target.sales_value ? money(n.target.sales_value) + ' (' + (n.achievementPct.sales_value == null ? '—' : n.achievementPct.sales_value + '%') + ')' : 'not set';
              return [s.name + (s.employeeCode ? ' · ' + s.employeeCode : '') + ' · ' + (s.mobile || s.email), s.territory || '—',
                n.today.orders + ' orders · ' + money(n.today.value) + ' · ' + n.today.visits + ' visits', money(n.monthToDate.sales_value) + ' · ' + n.monthToDate.orders + ' orders', tg,
                el('span', { class: over ? 'tag bad' : '', text: money(n.cashInHand) + (over ? ' — over limit ' + money(s.cashLimit) : '') }),
                s.lastVisit ? fmt(s.lastVisit.at) + ' at ' + s.lastVisit.shop : (s.lastLocationAt ? fmt(s.lastLocationAt) : '—'), s.active ? 'active' : 'switched off', btn('Open', function () { salesmanDetail(det, s.id); })];
            })));
            if (!r.items.length) box.appendChild(el('p', { class: 'note', text: 'No salesmen yet. Add one: first give the person the Salesman role under Administration → Business Staff & Roles, then add them here.' }));
          }).catch(err(box));
        }
        show();
      }
      if (k === 'add') {
        api('GET', S + '/salesmen/lookups').then(function (l) {
          var who = select('Staff member', [['', 'Choose…']].concat(l.staff.map(function (s) { return [s.id, s.name + ' · ' + s.email + (s.hasSalesmanRole ? '' : ' (no Salesman role yet)')]; })));
          var code = input('Employee code'), terr = select('Home territory', [['', 'None']].concat(l.territories.map(function (x) { return [x.id, x.name + ' (' + x.level + ')']; })));
          var wh = select('Ships from warehouse', [['', 'Default']].concat(l.warehouses.map(function (x) { return [x.id, x.code + ' — ' + x.name]; }))), cash = input('Cash limit (₹)', { inputmode: 'decimal', value: '20000' });
          var out = el('div');
          body.appendChild(section('Add a salesman', [el('p', { class: 'note', text: 'Only active business staff appear here. To create the person first, use Administration → Business Staff & Roles and give them the Salesman role (a second person approves roles).' }),
            row([who.node, code.node, terr.node, wh.node, cash.node, btn('Add', function () {
              api('POST', S + '/salesmen', { staffId: Number(who.input.value), employeeCode: code.input.value, homeTerritoryId: Number(terr.input.value) || null, defaultWarehouseId: Number(wh.input.value) || null, cashLimit: cash.input.value })
                .then(function (r) { out.replaceChildren(msg('ok', 'Added. They can now sign in to the field app at /sales-app/.')); salesmanDetail(det, r.salesmanId); }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
            }, 'primary')]), out]));
        }).catch(err(body));
      }
      if (k === 'targets') {
        (cache ? Promise.resolve(cache) : load()).then(function (r) {
          var who = select('Salesman', [['', 'Choose…']].concat(r.items.filter(function (s) { return s.active; }).map(function (s) { return [s.id, s.name + (s.employeeCode ? ' · ' + s.employeeCode : '')]; })));
          var month = input('Month', { type: 'month', value: new Date().toISOString().slice(0, 7) }), metric = select('Measure', METRICS), val = input('Target', { inputmode: 'decimal' }), out = el('div');
          body.appendChild(section('Monthly target', [row([who.node, month.node, metric.node, val.node, btn('Save target', function () {
            api('PUT', S + '/targets', { salesmanId: Number(who.input.value), month: month.input.value, metric: metric.input.value, value: Number(val.input.value) })
              .then(function () { out.replaceChildren(msg('ok', 'Target saved')); cache = null; }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
          }, 'primary')]), out]));
        }).catch(err(body));
      }
    }
  }

  function salesmanDetail(det, id, openTab) {
    if (!openTab) det.replaceChildren(el('p', { class: 'note', text: 'Loading…' }));
    api('GET', S + '/salesmen/' + id).then(function (d) {
      var s = d.salesman, n = d.numbers, t, reload = function () { salesmanDetail(det, id, t.current()); };
      var box = el('section', { class: 'panel' }), out = el('div');
      var fail = function (e) { out.replaceChildren(msg('err', e.message)); };
      box.appendChild(row([el('h2', { text: s.name + (s.employeeCode ? ' · ' + s.employeeCode : '') }), el('span', { class: 'tag', text: s.active ? 'active' : 'switched off' }), btn('Close', function () { det.replaceChildren(); })]));
      box.appendChild(el('p', { class: 'note', text: [s.email, s.mobile, s.territory ? 'territory ' + s.territory : null, s.warehouse ? 'ships from ' + s.warehouse : null, d.retailersRegistered + ' retailers registered'].filter(Boolean).join(' · ') }));
      box.appendChild(kpis([['Orders today', n.today.orders + ' · ' + money(n.today.value)], ['Visits today', n.today.visits], ['Collected today', money(n.today.collected)],
        ['Month sales', money(n.monthToDate.sales_value) + (n.target.sales_value ? ' / ' + money(n.target.sales_value) : '')], ['Month visits', n.monthToDate.visits + (n.target.visits ? ' / ' + n.target.visits : '')],
        ['Cash in hand', money(n.cashInHand) + ' (limit ' + money(s.cashLimit) + ')']]));
      box.appendChild(out);
      t = tabs([['orders', 'Orders'], ['visits', 'Visits'], ['cash', 'Cash to hand over (' + d.collectionsPending.length + ')'], ['beats', 'Beats'], ['targets', 'Targets'], ['where', 'Positions'], ['edit', 'Settings']], draw);
      box.appendChild(t.node);
      det.replaceChildren(box);
      setTimeout(function () { t.go(openTab || 'orders'); if (!openTab) det.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 0);
      function draw(k, body) {
        if (k === 'orders') body.appendChild(table(['Order', 'Shop', 'Value', 'Status', 'When'], d.orders.map(function (o) { return [o.order_no, o.shop_name || o.business_name, money(o.grand_total), label(o.status), fmt(o.created_at)]; })));
        if (k === 'visits') body.appendChild(table(['When', 'Shop', 'City', 'Outcome', 'Distance from shop pin', 'Note'], d.visits.map(function (v) { return [fmt(v.checked_in_at), v.shop_name || v.business_name, v.city || '—', label(v.outcome) || '—', v.distance_m == null ? '—' : v.distance_m + ' m', v.note || '—']; })));
        if (k === 'cash') {
          body.appendChild(table(['Receipt', 'Order', 'Method', 'Amount', 'Reference', 'Collected', ''], d.collectionsPending.map(function (p) {
            return [p.receipt_no || ('#' + p.id), p.order_no || '—', label(p.method), money(p.amount), p.reference || '—', fmt(p.received_at),
              E.has('sales.collections.confirm') ? btn('Confirm received', function () { api('POST', S + '/collections/' + p.id + '/confirm').then(reload).catch(fail); }, 'primary') : ''];
          })));
        }
        if (k === 'beats') {
          var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          if (!d.beats.length) body.appendChild(el('p', { class: 'note', text: 'No beats yet. Beats are set up on the Sales Desk.' }));
          d.beats.forEach(function (b) {
            body.appendChild(el('h3', { text: WD[b.weekday] + ' · ' + b.name + (b.territory ? ' · ' + b.territory : '') + (b.is_active ? '' : ' (off)') }));
            body.appendChild(table(['#', 'Shop', 'City'], b.stops.map(function (x) { return [String(x.seq), x.shop_name || x.business_name, x.city || '—']; })));
          });
        }
        if (k === 'targets') body.appendChild(table(['Month', 'Measure', 'Target'], d.targets.map(function (x) { var m = METRICS.filter(function (y) { return y[0] === x.metric; })[0]; return [x.period_month, m ? m[1] : x.metric, String(Number(x.target_value))]; })));
        if (k === 'where') {
          body.appendChild(el('p', { class: 'note', text: 'Positions are recorded only when the salesman checks in or shares location in the field app.' }));
          body.appendChild(table(['When', 'Why', 'Accuracy', 'Map'], d.locations.map(function (l) {
            return [fmt(l.captured_at), label(l.purpose), l.accuracy_m == null ? '—' : l.accuracy_m + ' m', el('a', { href: 'https://www.google.com/maps?q=' + l.lat + ',' + l.lng, target: '_blank', rel: 'noopener', text: 'Open map' })];
          })));
        }
        if (k === 'edit') {
          if (!E.has('core.staff.edit')) { body.appendChild(el('p', { class: 'note', text: 'Only staff administrators can change these.' })); return; }
          api('GET', S + '/salesmen/lookups').then(function (l) {
            var code = input('Employee code', { value: s.employeeCode || '' });
            var terr = select('Home territory', [['', 'None']].concat(l.territories.map(function (x) { return [x.id, x.name + ' (' + x.level + ')']; })), s.territoryId || '');
            var wh = select('Ships from warehouse', [['', 'Default']].concat(l.warehouses.map(function (x) { return [x.id, x.code + ' — ' + x.name]; })), s.warehouseId || '');
            var cash = input('Cash limit (₹)', { inputmode: 'decimal', value: String(s.cashLimit) });
            body.appendChild(row([code.node, terr.node, wh.node, cash.node, btn('Save', function () {
              api('PUT', S + '/salesmen/' + id, { employeeCode: code.input.value, homeTerritoryId: Number(terr.input.value) || null, defaultWarehouseId: Number(wh.input.value) || null, cashLimit: Number(cash.input.value) }).then(reload).catch(fail);
            }, 'primary')]));
            body.appendChild(row([s.active ? btn('Switch off (stops field-app access)', function () {
              var why = ask('Why? (kept in the audit log)'); if (why == null) return;
              api('PUT', S + '/salesmen/' + id, { active: false, reason: why }).then(reload).catch(fail);
            }, 'danger') : btn('Switch back on', function () { api('PUT', S + '/salesmen/' + id, { active: true }).then(reload).catch(fail); })]));
          }).catch(fail);
        }
      }
    }).catch(function (e) { det.replaceChildren(msg('err', e.message)); });
  }

  // ═══════════════ Delivery ═══════════════
  /** The shop's own deliveries (online orders), read with the shop sign-in the admin shell already holds. */
  function shopDeliveries() {
    var A = window.Admin;
    if (!A || !A.Auth || !A.Auth.token() || !A.api) return Promise.resolve(null);
    return A.api.get('/deliveries').catch(function () { return null; });
  }
  function deliveryHub(main) {
    main.appendChild(el('h1', { text: 'Delivery Dashboard' }));
    main.appendChild(el('p', { class: 'note', text: 'Online-shop deliveries and trade shipments in one place. Open a list to assign, dispatch or record proof of delivery.' }));
    var shop = el('div'), trade = el('div');
    main.appendChild(shop); main.appendChild(trade);
    shopDeliveries().then(function (r) {
      if (!r) { shop.appendChild(section('Online shop', [el('p', { class: 'note', text: 'Your shop role does not include deliveries.' })])); return; }
      var c = r.counts || {};
      var link = el('a', { class: 'btn', href: '/admin/sales/deliveries', text: 'Open shop deliveries' });
      shop.appendChild(section('Online shop', [kpis([['Accepted', c.accepted || 0], ['Being prepared', c.prepared || 0], ['Out for delivery', c.out_for_delivery || 0], ['Not assigned to a rider', c.unassigned || 0], ['Riders', (r.agents || []).length]]),
        table(['Order', 'Customer', 'City', 'Status', 'Rider'], (r.deliveries || []).slice(0, 15).map(function (o) {
          return [o.orderId, o.customer ? o.customer.name : '—', o.address ? o.address.city : '—', label(o.status), o.assignedTo ? o.assignedTo.name : 'not assigned'];
        })), row([link])]));
    });
    api('GET', D + '/summary').then(function (s) {
      var st = s.byStatus || {};
      trade.appendChild(section('Trade shipments (retailers & distributors)', [
        kpis([['Packed, waiting for a shipment', s.waitingForShipment], ['Open shipments', s.open], ['Late', s.late], ['Out for delivery', st.out_for_delivery || 0], ['Delivered today', s.deliveredToday], ['Failed attempts today', s.failedToday],
          ['Own-vehicle shipments without a driver', s.unassignedOwnVehicle]]),
        table(['Status', 'Shipments'], Object.keys(st).map(function (k) { return [label(k), String(st[k])]; })),
        el('h3', { text: 'Delivery staff today' }),
        table(['Name', 'Mobile', 'Open', 'Delivered today', 'Failed', 'Late'], s.staff.map(function (p) { return [p.name, p.mobile || '—', String(p.open), String(p.deliveredToday), String(p.failed), String(p.late)]; })),
        row([btn('Open trade deliveries', function () { E.show('deliveries'); }, 'primary')])]));
    }).catch(err(trade));
  }

  function deliveryStaff(main) {
    main.appendChild(el('h1', { text: 'Delivery Staff' }));
    var trade = el('div'), shop = el('div');
    main.appendChild(trade); main.appendChild(shop);
    api('GET', D + '/summary').then(function (s) {
      trade.appendChild(section('Trade delivery staff (field app)', [
        el('p', { class: 'note', text: 'People with the Delivery staff role. They sign in at /sales-app/ and see the shipments assigned to them: out for delivery, location, proof of delivery, failed attempts. To add one, create the person under Administration → Business Staff & Roles and give them the Delivery staff role.' }),
        table(['Name', 'Mobile', 'Open shipments', 'Delivered today', 'Failed', 'Late'], s.staff.map(function (p) { return [p.name, p.mobile || '—', String(p.open), String(p.deliveredToday), String(p.failed), String(p.late)]; })),
        E.has('core.staff.view') ? row([btn('Business Staff & Roles', function () { E.show('staff'); })]) : null]));
    }).catch(err(trade));
    shopDeliveries().then(function (r) {
      if (!r) return;
      shop.appendChild(section('Online-shop riders', [
        el('p', { class: 'note', text: 'Shop staff with the Delivery role. They sign in at /login and see only the online orders assigned to them. Add or remove riders under Administration → Staff.' }),
        table(['Name', 'Phone', 'E-mail', 'Assigned now'], (r.agents || []).map(function (a) {
          var n = (r.deliveries || []).filter(function (o) { return o.assignedTo && String(o.assignedTo.id) === String(a.id); }).length;
          return [a.name, a.phone || '—', a.email || '—', String(n)];
        })),
        row([el('a', { class: 'btn', href: '/admin/administration/staff', text: 'Shop staff' })])]));
    });
  }

  window.ERP_VIEWS.push(
    { id: 'vendors', label: 'Manufacturers & Suppliers', perm: 'vendors.view', render: vendors },
    { id: 'salesmen', label: 'Salesmen', perm: 'sales.reports.view', render: salesmen },
    { id: 'deliveryhub', label: 'Delivery dashboard', perm: 'deliveries.view', render: deliveryHub },
    { id: 'deliverystaff', label: 'Delivery staff', perm: 'deliveries.manage', render: deliveryStaff }
  );
})();
