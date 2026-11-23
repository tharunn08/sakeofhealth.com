/* Business platform admin — manufacturers, manufacturing orders, batch quality and release, bills of
   materials (migration 020) and trade deliveries (shipments, challans, proof of delivery).
   Text via textContent only; the server checks every permission again. */
(function () {
  'use strict';
  var E = window.ERP, el = E.el, api = E.api, msg = E.msg, fmt = E.fmt, table = E.table, kpi = E.kpi;
  var M = '/api/erp/manufacturing', D = '/api/erp/deliveries';
  function err(box) { return function (e) { box.prepend(msg('err', e.message)); }; }
  function btn(text, onClick, kind) { return el('button', { class: 'btn' + (kind ? ' ' + kind : ''), type: 'button', text: text, on: { click: onClick } }); }
  function input(label, attrs) { var i = el('input', Object.assign({ 'aria-label': label }, attrs || {})); return { node: el('label', {}, [label, i]), input: i }; }
  function select(label, opts, value) {
    var s = el('select', { 'aria-label': label }, opts.map(function (o) { return el('option', { value: String(o[0]), text: o[1] }); }));
    if (value != null) s.value = String(value);
    return { node: el('label', {}, [label, s]), input: s };
  }
  function section(title, kids) { return el('section', { class: 'panel' }, [el('h2', { text: title })].concat(kids)); }
  function money(v) { return v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(v) { return v == null ? '—' : v + '%'; }
  function day(v) { return v ? String(v).slice(0, 10) : '—'; }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function ask(text) { var v = window.prompt(text); return v == null ? null : v.trim(); }
  function label(s) { return String(s || '').replace(/_/g, ' '); }
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
  /** Files behind the staff token (documents, proofs, challans): fetched, then shown in a new tab. */
  function openFile(path) {
    var h = {}, t = window.ERP.state && window.ERP.state.token;
    if (t) h.Authorization = 'Bearer ' + t;
    fetch(path, { headers: h, credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || ('Could not open (' + r.status + ')')); });
      return r.blob();
    }).then(function (b) {
      var url = URL.createObjectURL(b); window.open(url, '_blank', 'noopener');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (e) { window.alert(e.message); });
  }
  var LOOK = null;
  function lookups() { return LOOK ? Promise.resolve(LOOK) : api('GET', M + '/lookups').then(function (l) { LOOK = l; return l; }); }
  function productOpts(l, kinds, first) {
    return [['', first || 'Choose…']].concat(l.products.filter(function (p) { return !kinds || kinds.indexOf(p.kind) !== -1; }).map(function (p) { return [p.id, p.sku + ' — ' + p.name + (p.kind !== 'finished' ? ' (' + label(p.kind) + ')' : '')]; }));
  }

  // ═══════════════ Manufacturers ═══════════════
  function manufacturers(main) {
    main.appendChild(el('h1', { text: 'Manufacturers' }));
    main.appendChild(el('p', { class: 'note', text: 'Manufacturers make their own branded products; contract manufacturers make our products to our specification. Registration, document checks and product / price approval stay under Procurement → Manufacturers & Suppliers.' }));
    var t = tabs([['list', 'Manufacturers'], ['own', 'Our facilities'], ['late', 'Late deliveries']], draw), det = el('div');
    main.appendChild(t.node); main.appendChild(det);
    setTimeout(function () { t.go('list'); }, 0);
    function draw(k, body) {
      if (k === 'list') {
        var q = input('Search name, GSTIN or code'), cap = select('Type', [['', 'All'], ['manufacturer', 'Manufacturer (own brand)'], ['contract_manufacturer', 'Contract manufacturer']]), box = el('div');
        var load = function () {
          api('GET', M + '/manufacturers?q=' + encodeURIComponent(q.input.value) + '&capability=' + cap.input.value).then(function (r) {
            box.replaceChildren(table(['Manufacturer', 'Type', 'FSSAI', 'Facilities', 'Products', 'Open orders', 'Batches for QC', 'Late deliveries', ''], r.items.map(function (m) {
              return [m.name + (m.code ? ' (' + m.code + ')' : '') + (m.status !== 'approved' ? ' · ' + m.status : ''), m.capabilities.map(function (c) { return label(c.capability) + (c.status !== 'approved' ? ' (' + c.status + ')' : ''); }).join(', '),
                (m.fssai || '—') + (m.fssaiExpired ? ' · EXPIRED' : ''), String(m.facilities), m.productsApproved + ' approved' + (m.productsPending ? ', ' + m.productsPending + ' pending' : ''),
                String(m.openOrders), String(m.batchesWaiting), m.lateDeliveries ? String(m.lateDeliveries) + ' late' : '0', btn('Open', function () { show(m.id); })];
            })));
          }).catch(err(box));
        };
        body.appendChild(el('div', { class: 'row' }, [q.node, cap.node, btn('Search', load)])); body.appendChild(box); load();
      } else if (k === 'own') {
        var b2 = el('div');
        var loadOwn = function () {
          api('GET', M + '/facilities?vendorId=own').then(function (r) {
            b2.replaceChildren(table(['Facility', 'City', 'FSSAI', 'Capacity / month', 'Status', ''], r.items.map(function (f) {
              return [f.name, f.city || '—', (f.fssai || '—') + (f.fssaiValidTo ? ' to ' + f.fssaiValidTo : ''), f.capacityPerMonth == null ? '—' : f.capacityPerMonth + ' ' + (f.capacityUom || ''), f.status,
                E.has('manufacturing.manage') ? btn('Edit', function () { facilityForm(b2, null, f, loadOwn); }) : el('span')];
            })));
            if (E.has('manufacturing.manage')) b2.appendChild(btn('Add one of our facilities', function () { facilityForm(b2, null, null, loadOwn); }, 'primary'));
          }).catch(err(b2));
        };
        body.appendChild(b2); loadOwn();
      } else {
        var b3 = el('div');
        api('GET', M + '/deliveries?late=1').then(function (r) {
          b3.replaceChildren(r.items.length ? table(['Manufacturer', 'PO', 'Dispatch notice', 'Transporter / LR', 'Expected', 'Late by', 'Units'], r.items.map(function (a) {
            return [a.vendor, a.poNo, a.deliveryNoteNo || ('ASN ' + a.id), [a.transporter, a.lrNo].filter(Boolean).join(' · ') || '—', fmt(a.expectedAt), a.lateHours + ' h', String(a.units)];
          })) : msg('ok', 'No manufacturer delivery is late.'));
        }).catch(err(b3));
        body.appendChild(b3);
      }
    }
    function show(id) {
      api('GET', M + '/manufacturers/' + id).then(function (d) {
        var m = d.manufacturer, p = d.performance, out = el('div');
        var facBox = el('div');
        var drawFac = function () {
          facBox.replaceChildren(table(['Facility', 'Address', 'FSSAI', 'Capacity / month', 'Status', ''], d.facilities.map(function (f) {
            return [f.name, [f.address, f.city, f.pincode].filter(Boolean).join(', ') || '—', (f.fssai || '—') + (f.fssaiValidTo ? ' to ' + f.fssaiValidTo : ''), f.capacityPerMonth == null ? '—' : f.capacityPerMonth + ' ' + (f.capacityUom || ''), f.status,
              E.has('manufacturing.manage') ? btn('Edit', function () { facilityForm(facBox, m.id, f, function () { show(id); }); }) : el('span')];
          })));
          if (E.has('manufacturing.manage')) facBox.appendChild(btn('Add facility', function () { facilityForm(facBox, m.id, null, function () { show(id); }); }));
        };
        drawFac();
        det.replaceChildren(section(m.legal_name + (m.vendor_code ? ' (' + m.vendor_code + ')' : ''), [out,
          el('p', {}, ['GSTIN ' + (m.gstin || '—') + ' · PAN ' + (m.pan || '—') + ' · FSSAI ' + (m.fssai_licence || '—') + (m.fssai_valid_to ? ' (to ' + m.fssai_valid_to + (m.fssaiExpired ? ', EXPIRED' : '') + ')' : '') + ' · Status ' + m.status]),
          el('p', {}, ['Contact: ' + (d.contact ? [d.contact.name, d.contact.email, d.contact.mobile].filter(Boolean).join(' · ') : '—') + ' · Types: ' + d.capabilities.map(function (c) { return label(c.capability) + ' (' + c.status + ')'; }).join(', ')]),
          el('div', { class: 'grid' }, [kpi('On-time deliveries', pct(p.onTimePct)), kpi('Fill rate', pct(p.fillRatePct)), kpi('Rejected at receipt', pct(p.receiptRejectPct)), kpi('Average lead time', p.avgLeadDays == null ? '—' : p.avgLeadDays + ' days'),
            kpi('Batches released / rejected', p.batchesReleased + ' / ' + p.batchesRejected), kpi('Late deliveries now', p.lateDeliveries), kpi('Purchase orders', p.purchaseOrders), kpi('Purchased value', money(p.purchaseValue))]),
          el('h3', { text: 'Facilities' }), facBox,
          el('h3', { text: 'Products (' + d.approvedProducts + ' approved, ' + d.pendingProducts + ' pending)' }), table(['Product', 'Our SKU', 'HSN', 'MRP', 'Shelf life', 'Lead time', 'Status'], d.products.map(function (x) {
            return [x.name + (x.vendor_sku ? ' (' + x.vendor_sku + ')' : ''), x.sku || '—', x.hsn_code || '—', money(x.mrp), x.shelf_life_days ? x.shelf_life_days + ' days' : '—', x.lead_days ? x.lead_days + ' days' : '—', x.status + (x.review_note ? ': ' + x.review_note : '')];
          })),
          el('h3', { text: 'Price submissions' }), table(['Product', 'Unit price (ex-GST)', 'GST', 'Valid', 'Status'], d.priceLists.map(function (x) { return [x.name, money(x.unit_price), x.gst_rate + '%', day(x.valid_from) + ' → ' + day(x.valid_to), x.status]; })),
          el('h3', { text: 'Documents and certificates' }), table(['Type', 'File', 'Valid to', 'Review'], d.documents.map(function (x) { return [label(x.doc_type), x.original_name, day(x.valid_to), x.review_status + (x.review_note ? ': ' + x.review_note : '')]; })),
          el('h3', { text: 'Manufacturing orders' }), table(['Order', 'Product', 'Planned', 'Made', 'Released', 'Rejected', 'Due', 'Status'], d.manufacturingOrders.map(function (x) { return [x.mo_no, x.sku + ' ' + x.name, String(x.planned_qty), String(x.produced_qty), String(x.released_qty), String(x.rejected_qty), day(x.planned_end), label(x.status)]; })),
          el('h3', { text: 'Batch records' }), table(['Batch', 'Order', 'Product', 'Made', 'Expiry', 'Qty', 'QC', 'CoA'], d.batches.map(function (x) { return [x.batch_no, x.mo_no, x.sku, x.mfg_date, x.expiry_date, String(x.qty), x.status + (Number(x.rejected_qty) ? ' (' + x.rejected_qty + ' rejected)' : '') + (x.qc_note ? ': ' + x.qc_note : ''), x.coa_document_id ? 'yes' : '—']; })),
          el('h3', { text: 'Purchase orders' }), table(['PO', 'Status', 'Total', 'Deliver by', 'Sent'], d.purchaseOrders.map(function (x) { return [x.po_no, label(x.status), money(x.grand_total), day(x.delivery_by), fmt(x.sent_at)]; })),
          el('h3', { text: 'Deliveries (dispatch notices)' }), table(['Notice', 'PO', 'Transporter / LR', 'E-way bill', 'Dispatched', 'Expected', 'Received', 'Status'], d.deliveries.map(function (a) {
            return [a.deliveryNoteNo || ('ASN ' + a.id), a.poNo, [a.transporter, a.lrNo].filter(Boolean).join(' · ') || '—', a.ewayBillNo || '—', fmt(a.dispatchedAt), fmt(a.expectedAt), fmt(a.receivedAt), a.status + (a.late ? ' · LATE ' + a.lateHours + ' h' : '')];
          }))]));
        det.scrollIntoView({ behavior: 'smooth' });
      }).catch(err(det));
    }
  }

  function facilityForm(box, vendorId, f, done) {
    f = f || {};
    var name = input('Facility name', { value: f.name || '' }), addr = input('Address', { value: f.address || '' }), city = input('City', { value: f.city || '' }), pin = input('Pincode', { value: f.pincode || '', inputmode: 'numeric' });
    var fssai = input('FSSAI licence (14 digits)', { value: f.fssai || '', inputmode: 'numeric' }), valid = input('FSSAI valid to', { type: 'date', value: f.fssaiValidTo || '' });
    var cap = input('Capacity per month', { value: f.capacityPerMonth == null ? '' : String(f.capacityPerMonth), inputmode: 'numeric' }), uom = input('Unit', { value: f.capacityUom || 'units' }), cats = input('Product categories', { value: f.categories || '' });
    var st = select('Status', [['active', 'Active'], ['inactive', 'Inactive']], f.status || 'active'), out = el('div');
    box.appendChild(el('div', { class: 'panel' }, [el('h3', { text: f.id ? 'Edit facility' : 'New facility' }), out, el('div', { class: 'row' }, [name.node, addr.node, city.node, pin.node]),
      el('div', { class: 'row' }, [fssai.node, valid.node, cap.node, uom.node, cats.node, st.node]), btn('Save facility', function () {
        var body = { vendorId: vendorId, name: name.input.value, address: addr.input.value, city: city.input.value, pincode: pin.input.value, fssai: fssai.input.value, fssaiValidTo: valid.input.value,
          capacityPerMonth: cap.input.value, capacityUom: uom.input.value, categories: cats.input.value, status: st.input.value };
        (f.id ? api('PUT', M + '/facilities/' + f.id, body) : api('POST', M + '/facilities', body)).then(function () { done(); }).catch(err(out));
      }, 'primary')]));
  }

  // ═══════════════ Manufacturing orders ═══════════════
  function orders(main) {
    main.appendChild(el('h1', { text: 'Manufacturing orders' }));
    var top = el('div'), t = tabs([['open', 'Open'], ['all', 'All'], ['new', 'New order']], draw), det = el('div');
    main.appendChild(top); main.appendChild(t.node); main.appendChild(det);
    setTimeout(function () { t.go('open'); }, 0);
    function draw(k, body) {
      if (k === 'new') return newOrder(body);
      var box = el('div');
      api('GET', M + '/orders' + (k === 'open' ? '?status=open' : '')).then(function (r) {
        box.replaceChildren(table(['Order', 'Type', 'Made by', 'Product', 'Planned', 'Made', 'Released', 'Rejected', 'Due', 'Status', ''], r.items.map(function (m) {
          return [m.moNo, m.mode === 'contract' ? 'Contract' : 'In-house', m.vendor || (m.facility || 'Our plant'), m.sku + ' ' + m.product, String(m.plannedQty), String(m.producedQty), String(m.releasedQty), String(m.rejectedQty),
            m.plannedEnd ? m.plannedEnd + (m.late ? ' · LATE' : '') : '—', label(m.status), btn('Open', function () { show(m.id); })];
        })));
      }).catch(err(box));
      body.appendChild(box);
    }
    function newOrder(body) {
      if (!E.has('manufacturing.manage')) { body.appendChild(msg('warn', 'You can view manufacturing orders but not create them.')); return; }
      var out = el('div');
      lookups().then(function (l) {
        var mode = select('Type', [['contract', 'Contract — a manufacturer makes it'], ['in_house', 'In-house — our plant makes it']]);
        var prod = select('Product', productOpts(l, ['finished'])), qty = input('Planned quantity', { inputmode: 'numeric' });
        var wh = select('Warehouse', [['', 'Choose…']].concat(l.warehouses.map(function (w) { return [w.id, w.code + ' — ' + w.name]; })));
        var mk = select('Manufacturer', [['', 'Choose…']].concat(l.manufacturers.map(function (m) { return [m.id, m.name]; })));
        var po = select('Purchase order', [['', 'None yet']]), fac = select('Facility', [['', 'Any / not stated']]);
        var s1 = input('Start', { type: 'date' }), s2 = input('Needed by', { type: 'date' }), note = input('Note');
        var bomNote = el('p', { class: 'note' });
        function refresh() {
          var c = mode.input.value === 'contract', vid = Number(mk.input.value) || null, pid = Number(prod.input.value) || null;
          mk.node.style.display = c ? '' : 'none'; po.node.style.display = c ? '' : 'none';
          po.input.replaceChildren.apply(po.input, [el('option', { value: '', text: 'None yet' })].concat(l.purchaseOrders.filter(function (p) { return p.vendorId === vid; }).map(function (p) { return el('option', { value: String(p.id), text: p.poNo + ' (' + label(p.status) + ')' }); })));
          fac.input.replaceChildren.apply(fac.input, [el('option', { value: '', text: 'Any / not stated' })].concat(l.facilities.filter(function (f) { return c ? f.vendorId === vid : f.vendorId == null; }).map(function (f) { return el('option', { value: String(f.id), text: f.name }); })));
          var bom = l.activeBoms.filter(function (b) { return b.productId === pid; })[0];
          bomNote.textContent = c ? 'The manufacturer accepts the order, posts updates and records batches with their Certificate of Analysis; our QC releases each batch before it ships.'
            : (pid ? (bom ? 'Uses bill of materials version ' + bom.version + '.' : 'This product has no active bill of materials: create and activate one first.') : 'An in-house order consumes materials by the active bill of materials.');
        }
        [mode, mk, prod].forEach(function (x) { x.input.addEventListener('change', refresh); });
        refresh();
        body.appendChild(section('New manufacturing order', [out, el('div', { class: 'row' }, [mode.node, prod.node, qty.node, wh.node]), el('div', { class: 'row' }, [mk.node, po.node, fac.node]),
          el('div', { class: 'row' }, [s1.node, s2.node, note.node]), bomNote, btn('Create order', function () {
            var b = { mode: mode.input.value, productId: Number(prod.input.value), plannedQty: Number(qty.input.value), warehouseId: Number(wh.input.value), facilityId: fac.input.value ? Number(fac.input.value) : null,
              plannedStart: s1.input.value || null, plannedEnd: s2.input.value || null, note: note.input.value };
            if (b.mode === 'contract') { b.vendorId = Number(mk.input.value); b.poId = po.input.value ? Number(po.input.value) : null; }
            api('POST', M + '/orders', b).then(function (r) { top.prepend(msg('ok', 'Created ' + r.moNo + ' as a draft. Release it when it is ready to start.')); t.go('open'); show(r.id); }).catch(err(out));
          }, 'primary')]));
      }).catch(err(body));
    }
    function show(id) {
      api('GET', M + '/orders/' + id).then(function (m) {
        var out = el('div'), acts = el('div', { class: 'row' });
        var act = function (path, body, done) { api('POST', M + '/orders/' + id + path, body || {}).then(function (r) { if (done) done(r); show(id); t.go(t.current()); }).catch(err(out)); };
        if (E.has('manufacturing.manage')) {
          if (m.status === 'draft') acts.appendChild(btn('Release', function () { act('/release'); }, 'primary'));
          if (['draft', 'released', 'accepted'].indexOf(m.status) !== -1) acts.appendChild(btn('Cancel order', function () { var r = ask('Why is this order cancelled?'); if (r) act('/cancel', { reason: r }); }, 'danger'));
          if (m.status === 'in_production') acts.appendChild(btn('Production complete', function () { if (window.confirm('No more batches will be recorded on ' + m.moNo + '. Continue?')) act('/complete'); }));
          if (m.status === 'completed') acts.appendChild(btn('Close', function () { act('/close'); }));
          if (['released', 'accepted', 'in_production'].indexOf(m.status) !== -1 && (m.mode === 'in_house' || m.status !== 'released')) acts.appendChild(btn('Post an update', function () {
            var st = ask('Stage (e.g. mixing, filling, packing)'); if (st == null) return; var n = ask('Note (optional)'); var q = ask('Quantity made so far (optional)');
            act('/progress', { stage: st, note: n || '', qty: q ? Number(q) : null });
          }));
        }
        var kids = [out, el('p', {}, [(m.mode === 'contract' ? 'Contract · ' + (m.vendor || '') : 'In-house' + (m.facility ? ' · ' + m.facility : '')) + ' · ' + m.sku + ' ' + m.product + ' · warehouse ' + (m.warehouse || m.warehouseId) +
          (m.poNo ? ' · PO ' + m.poNo : '') + ' · due ' + (m.plannedEnd || '—') + (m.late ? ' (LATE)' : '')]),
          el('div', { class: 'grid' }, [kpi('Planned', m.plannedQty), kpi('Made (batches)', m.producedQty), kpi('Released by QC', m.releasedQty), kpi('Rejected by QC', m.rejectedQty)]), acts];
        if (m.status === 'released' && m.mode === 'contract') kids.push(msg('warn', 'Waiting for ' + (m.vendor || 'the manufacturer') + ' to accept the order in the supplier portal.'));
        if (m.materials) {
          kids.push(el('h3', { text: 'Materials (bill of materials v' + m.bom.version + ': ' + m.bom.outputQty + ' units)' }));
          var qtys = {};
          kids.push(table(['Material', 'Needed', 'Issued', 'Issue now'], m.materials.map(function (x) {
            var i = el('input', { inputmode: 'numeric', 'aria-label': 'Issue ' + x.name, value: String(Math.max(0, x.required - x.issued)), size: 6 }); qtys[x.productId] = i;
            return [x.sku + ' ' + x.name + (x.uom ? ' (' + x.uom + ')' : ''), String(x.required), String(x.issued), ['released', 'in_production'].indexOf(m.status) !== -1 && E.has('manufacturing.issue') ? i : el('span', { text: '—' })];
          })));
          if (['released', 'in_production'].indexOf(m.status) !== -1 && E.has('manufacturing.issue')) {
            var key = uuid();
            kids.push(el('div', { class: 'row' }, [btn('Issue materials (earliest expiry first)', function () {
              var lines = Object.keys(qtys).map(function (k) { return { productId: Number(k), qty: Number(qtys[k].value) }; }).filter(function (x) { return x.qty > 0; });
              var b = { idempotencyKey: key, lines: lines };
              api('POST', M + '/orders/' + id + '/materials/issue', b).catch(function (e) {
                if (e.code !== 'over_issue') throw e;
                var r = ask(e.message + '\nReason:'); if (!r) throw e; b.reason = r; return api('POST', M + '/orders/' + id + '/materials/issue', b);
              }).then(function () { show(id); }).catch(err(out));
            }, 'primary'), btn('Return unused material', function () {
              var pid = ask('Product number (id) of the material'); if (!pid) return; var q = ask('Quantity'); if (!q) return; var bid = ask('Batch id it came from (blank if none)');
              api('POST', M + '/orders/' + id + '/materials/return', { idempotencyKey: uuid(), lines: [{ productId: Number(pid), qty: Number(q), batchId: bid ? Number(bid) : null }] }).then(function () { show(id); }).catch(err(out));
            })]));
          }
          if (m.issues && m.issues.length) kids.push(table(['Material', 'Batch', 'Qty', 'Kind', 'When'], m.issues.map(function (x) { return [String(x.product_id), x.batch_no || '—', String(x.qty), x.kind, fmt(x.issued_at)]; })));
        }
        kids.push(el('h3', { text: 'Batches' }));
        kids.push(table(['Batch', 'Made', 'Expiry', 'Qty', 'QC', 'Certificate'], m.batches.map(function (b) {
          return [b.batchNo, b.mfgDate, b.expiryDate, String(b.qty), b.status + (b.rejectedQty ? ' (' + b.rejectedQty + ' rejected)' : '') + (b.qcNote ? ': ' + b.qcNote : ''), b.hasCoa ? 'attached' : 'missing'];
        })));
        if (['accepted', 'in_production'].indexOf(m.status) !== -1 || (m.mode === 'in_house' && m.status === 'released')) {
          if (E.has('manufacturing.issue')) {
            var bn = input('Batch number'), mf = input('Made on', { type: 'date' }), ex = input('Expiry', { type: 'date' }), bq = input('Quantity', { inputmode: 'numeric' });
            kids.push(el('div', { class: 'row' }, [bn.node, mf.node, ex.node, bq.node, btn(m.mode === 'in_house' ? 'Record output (goes to quarantine)' : 'Record batch for the manufacturer', function () {
              api('POST', M + '/orders/' + id + '/batches', { batchNo: bn.input.value, mfgDate: mf.input.value, expiryDate: ex.input.value, qty: Number(bq.input.value) }).then(function () { show(id); }).catch(err(out));
            })]));
          }
        }
        kids.push(el('h3', { text: 'Documents (Certificates of Analysis, test reports)' }));
        kids.push(table(['Type', 'File', 'Batch', 'By', 'When', ''], m.documents.map(function (d) {
          var b = m.batches.filter(function (x) { return x.id === d.batchId; })[0];
          return [label(d.type), d.name, b ? b.batchNo : '—', d.by, fmt(d.at), btn('Open', function () { openFile(M + '/documents/' + d.id + '/file'); })];
        })));
        if (E.has('manufacturing.manage') && m.status !== 'cancelled') {
          var ft = select('Type', [['coa', 'Certificate of Analysis'], ['test_report', 'Test report'], ['production_record', 'Production record'], ['other', 'Other']]);
          var fb = select('Batch', [['', 'Whole order']].concat(m.batches.map(function (b) { return [b.id, b.batchNo]; })));
          var ff = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.webp', 'aria-label': 'File' });
          kids.push(el('div', { class: 'row' }, [ft.node, fb.node, ff, btn('Upload', function () {
            if (!ff.files[0]) return out.prepend(msg('err', 'Choose a file'));
            var fd = new FormData(); fd.append('docType', ft.input.value); if (fb.input.value) fd.append('batchId', fb.input.value); fd.append('file', ff.files[0]);
            api('POST', M + '/orders/' + id + '/documents', fd).then(function () { show(id); }).catch(err(out));
          })]));
        }
        if (m.receipts) kids.push(el('h3', { text: 'Received against the purchase order' }), table(['Batch', 'Received', 'Accepted', 'Rejected'], m.receipts.map(function (r) { return [r.batchNo, String(r.received), String(r.accepted), String(r.rejected)]; })));
        kids.push(el('h3', { text: 'History' }), table(['When', 'What', 'Stage', 'Qty', 'Note', 'By'], m.events.map(function (e) { return [fmt(e.at), label(e.kind), e.stage || '—', e.qty == null ? '—' : String(e.qty), e.note || '—', e.by]; })));
        det.replaceChildren(section(m.moNo + ' — ' + label(m.status), kids));
        det.scrollIntoView({ behavior: 'smooth' });
      }).catch(err(det));
    }
  }

  // ═══════════════ Batch quality and release ═══════════════
  function quality(main) {
    main.appendChild(el('h1', { text: 'Batch quality & release' }));
    main.appendChild(el('p', { class: 'note', text: 'Every manufactured batch waits here for a QC decision. A batch is released only with its Certificate of Analysis or test report attached. In-house output moves from quarantine to available (released) or damaged (rejected); a contract batch may ship only after release. The person who recorded a batch cannot release it.' }));
    var st = select('Show', [['submitted', 'Waiting for QC'], ['released', 'Released'], ['rejected', 'Rejected'], ['', 'All']]), box = el('div');
    main.appendChild(el('div', { class: 'row' }, [st.node, btn('Refresh', load)])); main.appendChild(box);
    st.input.addEventListener('change', load);
    function decide(b, result) {
      var note = ask('What did QC find? (a short note)'); if (!note) return;
      var body = { result: result, note: note };
      if (result === 'partial') {
        var rel = ask('How many of ' + b.qty + ' are released?'); if (rel == null) return;
        body.releasedQty = Number(rel); body.rejectedQty = b.qty - Number(rel);
      }
      api('POST', M + '/batches/' + b.id + '/qc', body).then(function (r) { box.prepend(msg('ok', 'Batch ' + b.batchNo + ': ' + r.status + ' (' + r.releasedQty + ' released, ' + r.rejectedQty + ' rejected)')); load(); }).catch(err(box));
    }
    function load() {
      api('GET', M + '/batches?status=' + st.input.value).then(function (r) {
        box.replaceChildren(table(['Batch', 'Order', 'Made by', 'Product', 'Made', 'Expiry', 'Qty', 'Certificate', 'Status', ''], r.items.map(function (b) {
          var a = el('div', { class: 'row' });
          if (b.status === 'submitted' && E.has('manufacturing.qc.release')) {
            a.appendChild(btn('Release', function () { decide(b, 'pass'); }, 'primary'));
            a.appendChild(btn('Partly', function () { decide(b, 'partial'); }));
            a.appendChild(btn('Reject', function () { decide(b, 'fail'); }, 'danger'));
          }
          return [b.batchNo, b.moNo + (b.mode === 'contract' ? '' : ' (in-house)'), b.vendor, b.sku + ' ' + b.product, b.mfgDate, b.expiryDate, String(b.qty), b.hasCoa ? 'attached' : 'MISSING',
            b.status + (b.rejectedQty ? ' (' + b.rejectedQty + ' rejected)' : '') + (b.qcNote ? ': ' + b.qcNote : ''), a];
        })));
      }).catch(err(box));
    }
    load();
  }

  // ═══════════════ Bills of materials ═══════════════
  function boms(main) {
    main.appendChild(el('h1', { text: 'Bills of materials' }));
    main.appendChild(el('p', { class: 'note', text: 'What an in-house order consumes per batch of output. A new version starts as a draft; a different person activates it (two-factor sign-in), which archives the previous version.' }));
    var top = el('div'), box = el('div'), det = el('div');
    main.appendChild(top); main.appendChild(box); main.appendChild(det);
    function load() {
      api('GET', M + '/boms').then(function (r) {
        box.replaceChildren(table(['Product', 'Version', 'Makes', 'Materials', 'Status', 'Activated', ''], r.items.map(function (b) {
          var a = el('div', { class: 'row' }, [btn('Open', function () { show(b.id); })]);
          if (b.status === 'draft' && E.has('manufacturing.bom.approve')) a.appendChild(btn('Activate', function () { api('POST', M + '/boms/' + b.id + '/activate', {}).then(function () { LOOK = null; load(); }).catch(err(box)); }, 'primary'));
          if (b.status !== 'archived' && E.has('manufacturing.manage')) a.appendChild(btn('Archive', function () { if (window.confirm('Archive version ' + b.version + '?')) api('POST', M + '/boms/' + b.id + '/archive', {}).then(function () { LOOK = null; load(); }).catch(err(box)); }));
          return [b.sku + ' ' + b.name, 'v' + b.version, b.outputQty + ' units', String(b.lines), b.status, fmt(b.approvedAt), a];
        })));
      }).catch(err(box));
    }
    function show(id) {
      api('GET', M + '/boms/' + id).then(function (b) {
        det.replaceChildren(section(b.sku + ' ' + b.name + ' — v' + b.version + ' (' + b.status + ')', [el('p', {}, ['Makes ' + b.outputQty + ' units' + (b.note ? ' · ' + b.note : '')]),
          table(['Material', 'Kind', 'Quantity', 'Scrap %', 'Note'], b.lines.map(function (l) { return [l.sku + ' ' + l.name, label(l.kind), l.qty + (l.uom ? ' ' + l.uom : ''), l.scrapPct + '%', l.note || '—']; }))]));
      }).catch(err(det));
    }
    if (E.has('manufacturing.manage')) {
      lookups().then(function (l) {
        var out = el('div'), prod = select('Finished product', productOpts(l, ['finished'])), outQty = input('Makes (units)', { inputmode: 'numeric', value: '100' }), note = input('Note');
        var rows = el('div'), lines = [];
        function addLine() {
          var mat = select('Material', productOpts(l, ['raw_material', 'packaging', 'finished'])), q = input('Quantity', { inputmode: 'decimal' }), sc = input('Scrap %', { inputmode: 'decimal', value: '0' });
          lines.push({ mat: mat, q: q, sc: sc }); rows.appendChild(el('div', { class: 'row' }, [mat.node, q.node, sc.node]));
        }
        addLine(); addLine();
        top.appendChild(section('New bill of materials (draft)', [out, el('div', { class: 'row' }, [prod.node, outQty.node, note.node]), rows, el('div', { class: 'row' }, [btn('Add material', addLine), btn('Save draft', function () {
          var b = { productId: Number(prod.input.value), outputQty: Number(outQty.input.value), note: note.input.value,
            lines: lines.filter(function (x) { return x.mat.input.value && x.q.input.value; }).map(function (x) { return { productId: Number(x.mat.input.value), qty: Number(x.q.input.value), scrapPct: Number(x.sc.input.value || 0) }; }) };
          api('POST', M + '/boms', b).then(function (r) { out.replaceChildren(msg('ok', 'Saved version ' + r.version + ' as a draft. Another person activates it.')); load(); }).catch(err(out));
        }, 'primary')])]));
      }).catch(err(top));
    }
    load();
  }

  // ═══════════════ Trade deliveries ═══════════════
  var MODE_LABEL = { own_vehicle: 'Own vehicle', courier: 'Courier', transporter: 'Transporter', pickup: 'Buyer pickup' };
  function deliveries(main) {
    main.appendChild(el('h1', { text: 'Trade deliveries' }));
    var top = el('div'), t = tabs([['open', 'On the way'], ['ship', 'To ship'], ['late', 'Late'], ['all', 'All']], draw), det = el('div');
    main.appendChild(top); main.appendChild(t.node); main.appendChild(det);
    var staffList = null;
    setTimeout(function () { t.go('open'); }, 0);
    function staff() { return staffList ? Promise.resolve(staffList) : (E.has('deliveries.manage') ? api('GET', D + '/staff').then(function (r) { staffList = r.items; return staffList; }) : Promise.resolve([])); }
    function draw(k, body) {
      var box = el('div'); body.appendChild(box);
      var q = k === 'open' ? '?status=open' : (k === 'late' ? '?late=1' : '');
      api('GET', D + '/' + q).then(function (r) {
        if (k === 'ship') {
          if (!r.toShip) { box.appendChild(msg('warn', 'You can see deliveries but not create shipments.')); return; }
          box.replaceChildren(r.toShip.length ? table(['Order', 'Buyer', 'Destination', 'Units', 'Value', 'Packed', 'From', ''], r.toShip.map(function (o) {
            return [o.orderNo, o.buyer, o.city + ' ' + o.pincode, String(o.units), money(o.value), fmt(o.packedAt), o.sellerType === 'distributor' ? 'Distributor' : (o.warehouse || '—'), btn('Create shipment', function () { shipmentForm(o); }, 'primary')];
          })) : msg('ok', 'Every packed order has a shipment.'));
          return;
        }
        box.replaceChildren(table(['Shipment', 'Order', 'Buyer', 'How', 'Vehicle / tracking', 'Driver', 'Expected', 'Attempts', 'Status', ''], r.items.map(function (s) {
          return [s.shipmentNo, s.orderNo, s.buyer, MODE_LABEL[s.mode] + (s.carrier ? ' · ' + s.carrier : ''), s.vehicleNo || s.trackingNo || s.lrNo || '—', s.deliveryStaff || s.driverName || '—',
            s.expectedAt ? fmt(s.expectedAt) + (s.late ? ' · LATE' : '') : '—', String(s.attempts), label(s.status) + (s.missing && s.missing.length ? ' (needs ' + s.missing.join(', ') + ')' : ''), btn('Open', function () { show(s.id); })];
        })));
      }).catch(err(box));
    }
    function shipmentForm(o, s) {
      s = s || {};
      var out = el('div');
      staff().then(function (people) {
        var mode = select('How it travels', Object.keys(MODE_LABEL).map(function (k) { return [k, MODE_LABEL[k]]; }), s.mode || 'own_vehicle');
        var carrier = input('Courier / transporter', { value: s.carrier || '' }), veh = input('Vehicle number', { value: s.vehicleNo || '', placeholder: 'KA01AB1234' });
        var dn = input('Driver name', { value: s.driverName || '' }), dp = input('Driver phone', { value: s.driverPhone || '', inputmode: 'numeric' });
        var who = select('Our delivery staff', [['', 'None']].concat(people.map(function (p) { return [p.id, p.name]; })), s.deliveryStaffId || '');
        var tr = input('Tracking number', { value: s.trackingNo || '' }), lr = input('LR number', { value: s.lrNo || '' }), ew = input('E-way bill (12 digits)', { value: s.ewayBillNo || '', inputmode: 'numeric' });
        var pk = input('Packages', { value: s.packages == null ? '' : String(s.packages), inputmode: 'numeric' }), kg = input('Weight (kg)', { value: s.weightKg == null ? '' : String(s.weightKg), inputmode: 'decimal' });
        var exp = input('Expected delivery', { type: 'datetime-local', value: s.expectedAt ? new Date(s.expectedAt).toISOString().slice(0, 16) : '' });
        var panel = section(s.id ? 'Change ' + s.shipmentNo : 'Shipment for ' + o.orderNo, [out, el('div', { class: 'row' }, [mode.node, carrier.node, veh.node, dn.node, dp.node, who.node]),
          el('div', { class: 'row' }, [tr.node, lr.node, ew.node, pk.node, kg.node, exp.node]), btn(s.id ? 'Save changes' : 'Create shipment', function () {
            var b = { mode: mode.input.value, carrier: carrier.input.value, vehicleNo: veh.input.value, driverName: dn.input.value, driverPhone: dp.input.value, deliveryStaffId: who.input.value ? Number(who.input.value) : null,
              trackingNo: tr.input.value, lrNo: lr.input.value, ewayBillNo: ew.input.value, packages: pk.input.value, weightKg: kg.input.value, expectedAt: exp.input.value ? new Date(exp.input.value).toISOString() : null };
            var p = s.id ? api('PUT', D + '/' + s.id, b) : api('POST', D + '/', Object.assign({ orderId: o.orderId }, b));
            p.then(function (r) { top.prepend(msg('ok', s.id ? 'Saved.' : 'Shipment ' + r.shipmentNo + ' created.')); t.go(s.id ? t.current() : 'open'); show(r.id || s.id); }).catch(err(out));
          }, 'primary')]);
        det.replaceChildren(panel); det.scrollIntoView({ behavior: 'smooth' });
      }).catch(err(det));
    }
    function show(id) {
      api('GET', D + '/' + id).then(function (s) {
        var out = el('div'), acts = el('div', { class: 'row' });
        var go = function (path, body) { return api('POST', D + '/' + id + path, body || {}).then(function (r) { if (r.warnings && r.warnings.length) top.prepend(msg('warn', r.warnings.join(' '))); show(id); t.go(t.current()); return r; }).catch(err(out)); };
        var moving = ['dispatched', 'out_for_delivery', 'attempt_failed'].indexOf(s.status) !== -1;
        if (s.canManage && ['ready', 'dispatched', 'out_for_delivery', 'attempt_failed'].indexOf(s.status) !== -1) acts.appendChild(btn('Change details', function () { shipmentForm({ orderNo: s.orderNo, orderId: s.orderId }, s); }));
        if (s.canManage && s.status === 'ready') acts.appendChild(btn('Dispatch', function () { go('/dispatch').then(function (r) { if (r && r.challanNo) top.prepend(msg('ok', 'Dispatched. Challan ' + r.challanNo + (r.invoiceNo ? ', invoice ' + r.invoiceNo : '') + '.')); }); }, 'primary'));
        if (s.status === 'dispatched' || s.status === 'attempt_failed') acts.appendChild(btn('Out for delivery', function () { go('/out-for-delivery'); }));
        if (moving) {
          acts.appendChild(btn('Add a location', function () { var p = ask('Where is it now? (place)'); if (p) go('/location', { place: p }); }));
          acts.appendChild(btn('Failed attempt', function () { var r = ask('Why could it not be delivered?'); if (r) go('/attempt-failed', { reason: r }); }));
          acts.appendChild(btn('Delivered…', function () { podForm(s); }, 'primary'));
          if (s.canManage) acts.appendChild(btn('Back to warehouse', function () {
            var r = ask('Why is it coming back? (at least 5 characters)'); if (!r) return;
            var c = window.confirm('Are the goods in good condition? OK = back to available stock, Cancel = to damaged.') ? 'good' : 'damaged';
            go('/return', { reason: r, condition: c });
          }, 'danger'));
        }
        if (s.challanNo) acts.appendChild(btn('Challan ' + s.challanNo, function () { openFile(D + '/' + id + '/challan'); }));
        if (s.hasProof) acts.appendChild(btn('Proof of delivery', function () { openFile(D + '/' + id + '/proof'); }));
        var a = s.address;
        var mapLink = a.lat != null ? el('a', { href: 'https://www.openstreetmap.org/?mlat=' + a.lat + '&mlon=' + a.lng + '#map=16/' + a.lat + '/' + a.lng, target: '_blank', rel: 'noopener', text: 'Open map' }) : el('span');
        det.replaceChildren(section(s.shipmentNo + ' — ' + label(s.status), [out,
          el('p', {}, ['Order ' + s.orderNo + ' (' + label(s.orderStatus) + ') · ' + s.buyer + ' · ' + money(s.value)]),
          el('p', {}, ['Deliver to ' + [a.name, a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', ') + ' · ' + (a.contact || '') + ' ' + (a.phone || '') + ' ', mapLink]),
          el('p', {}, [MODE_LABEL[s.mode] + [s.carrier, s.vehicleNo ? 'vehicle ' + s.vehicleNo : null, s.driverName ? 'driver ' + s.driverName + (s.driverPhone ? ' ' + s.driverPhone : '') : null, s.deliveryStaff ? 'staff ' + s.deliveryStaff : null,
            s.trackingNo ? 'tracking ' + s.trackingNo : null, s.lrNo ? 'LR ' + s.lrNo : null, s.ewayBillNo ? 'e-way bill ' + s.ewayBillNo : null].filter(Boolean).map(function (x) { return ' · ' + x; }).join('') +
            (s.expectedAt ? ' · expected ' + fmt(s.expectedAt) + (s.late ? ' (LATE)' : '') : '') + ' · attempts ' + s.attempts + (s.maxAttempts ? ' of ' + s.maxAttempts : '')]),
          s.missing && s.missing.length ? msg('warn', 'Before dispatch, add ' + s.missing.join(' and ') + '.') : el('span'),
          s.receivedBy ? el('p', {}, ['Received by ' + s.receivedBy + (s.receiverPhone ? ' (' + s.receiverPhone + ')' : '') + (s.podNote ? ' · ' + s.podNote : '')]) : el('span'),
          acts, el('h3', { text: 'Items' }), table(['Item', 'Ordered', 'Delivered'], s.items.map(function (i) { return [i.sku + ' ' + i.name, String(i.qty), i.delivered == null ? '—' : String(i.delivered)]; })),
          el('h3', { text: 'Tracking' }), table(['When', 'What', 'Where', 'Note', 'By'], s.events.map(function (e) {
            return [fmt(e.at), label(e.kind), e.place || (e.lat != null ? e.lat.toFixed(4) + ', ' + e.lng.toFixed(4) : '—'), e.note || '—', e.by];
          }))]));
        det.scrollIntoView({ behavior: 'smooth' });
      }).catch(err(det));
    }
    function podForm(s) {
      var out = el('div'), rb = input('Received by'), ph = input('Receiver phone', { inputmode: 'numeric' }), note = input('Note');
      var file = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.webp', 'aria-label': 'Photo or signed challan' });
      var qtys = {};
      var rows = s.items.map(function (i) { var x = el('input', { inputmode: 'numeric', value: String(i.qty), 'aria-label': 'Delivered ' + i.name, size: 5 }); qtys[i.id] = x; return [i.sku + ' ' + i.name, String(i.qty), x]; });
      det.prepend(section('Proof of delivery — ' + s.shipmentNo, [out, el('div', { class: 'row' }, [rb.node, ph.node, note.node]), el('label', {}, ['Photo or signed challan (optional)', file]),
        el('p', { class: 'note', text: 'Change a quantity only if something was not delivered: a credit note is raised for the difference.' }), table(['Item', 'Ordered', 'Delivered'], rows),
        btn('Confirm delivery', function () {
          var del = {}; Object.keys(qtys).forEach(function (k) { del[k] = Number(qtys[k].value); });
          var fd = new FormData(); fd.append('receivedBy', rb.input.value); fd.append('receiverPhone', ph.input.value); fd.append('note', note.input.value); fd.append('delivered', JSON.stringify(del));
          if (file.files[0]) fd.append('file', file.files[0]);
          api('POST', D + '/' + s.id + '/delivered', fd).then(function (r) { top.prepend(msg('ok', 'Delivered' + (r.invoiceNo ? ' — invoice ' + r.invoiceNo : '') + (r.creditNote ? ', credit note ' + r.creditNote.creditNoteNo : '') + '.')); show(s.id); t.go(t.current()); }).catch(err(out));
        }, 'primary')]));
    }
  }

  window.ERP_VIEWS.push(
    { id: 'manufacturers', label: 'Manufacturers', perm: 'manufacturing.view', render: manufacturers },
    { id: 'manufacturing', label: 'Manufacturing orders', perm: 'manufacturing.view', render: orders },
    { id: 'quality', label: 'Batch quality & release', perm: 'manufacturing.view', render: quality },
    { id: 'boms', label: 'Bills of materials', perm: 'manufacturing.view', render: boms },
    { id: 'deliveries', label: 'Trade deliveries', perm: 'deliveries.view', render: deliveries }
  );
})();
