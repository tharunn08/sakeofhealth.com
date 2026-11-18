/* Business platform admin — module screens (pricing, vendors, purchasing, receiving,
   bills, stock, network, recalls, finance, collections). Text via textContent only;
   the server checks every permission again. */
(function () {
  'use strict';
  var E = window.ERP, el = E.el, api = E.api, msg = E.msg, fmt = E.fmt, table = E.table, kpi = E.kpi;
  var B = '/api/erp';
  function err(box) { return function (e) { box.prepend(msg('err', e.message)); }; }
  function btn(text, onClick, kind) { return el('button', { class: 'btn' + (kind ? ' ' + kind : ''), type: 'button', text: text, on: { click: onClick } }); }
  function input(label, attrs) { var i = el('input', Object.assign({ 'aria-label': label }, attrs || {})); return { node: el('label', {}, [label, i]), input: i }; }
  function json(o) { return el('pre', { text: JSON.stringify(o, null, 1) }); }
  function section(title, kids) { return el('section', { class: 'panel' }, [el('h2', { text: title })].concat(kids)); }
  function money(v) { return v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // ── Price lists ──
  function pricing(main) {
    main.appendChild(el('h1', { text: 'Price lists' }));
    main.appendChild(el('p', { class: 'note', text: 'Rows the sheet itself makes unreliable (text MRP, typed values in formulas) are held: never priced, never published. Publishing needs approval by a second person and writes only the tiers decided in Business decisions.' }));
    var out = el('div'); main.appendChild(out);
    if (E.has('catalog.pricing.import')) {
      var code = input('Code', { placeholder: 'SST-FMCG' }), name = input('Name', { placeholder: 'SS Price List revised 9 Oct 2026' }), brand = input('Brand'),
        file = el('input', { type: 'file', accept: '.xlsx', 'aria-label': 'Workbook' }), create = el('input', { type: 'checkbox', 'aria-label': 'Create missing products (inactive)' });
      main.appendChild(section('Import a brand price list (.xlsx)', [el('div', { class: 'row' }, [code.node, name.node, brand.node, el('label', {}, ['Workbook', file]),
        el('label', {}, [el('span', { text: 'Create missing products (inactive, hidden)' }), create]),
        btn('Import', function () {
          var f = new FormData(); f.append('code', code.input.value); f.append('name', name.input.value); f.append('brand', brand.input.value);
          f.append('createMissing', create.checked ? 'true' : 'false'); if (file.files[0]) f.append('file', file.files[0]);
          api('POST', B + '/catalog/price-lists/imports', f).then(function (r) {
            out.replaceChildren(msg('ok', 'Draft v' + r.version + ': ' + r.report.priced + ' priced, ' + r.report.held.length + ' held, ' + r.report.unmatched.length + ' unmatched, ' + r.report.created.length + ' products created'),
              section('Held rows (need the brand\'s confirmed values)', [table(['Row', 'SAP', 'Product', 'Why'], r.report.held.map(function (h) { return [String(h.row), h.sap, h.desc, h.reasons.join('; ')]; }))]));
            E.show('pricing');
          }).catch(err(out));
        }, 'primary')])]));
    }
    var list = el('div'); main.appendChild(list);
    api('GET', B + '/catalog/price-lists').then(function (r) {
      list.appendChild(section('Versions', [table(['List', 'Status', 'Items', 'Created', ''], r.items.map(function (p) {
        var act = el('div', { class: 'row' });
        act.appendChild(btn('Changes', function () {
          api('GET', B + '/catalog/price-lists/' + p.id + '/diff').then(function (d) {
            out.replaceChildren(section(p.code + ' v' + p.version_no + ' — what publishing changes (tiers: ' + d.tiersWritten.join(', ') + ')', [
              d.blockers.length ? msg('warn', 'Blocked: ' + d.blockers.join('; ')) : msg('ok', 'No blockers'),
              table(['Row', 'SKU', 'Product', 'Changes', 'Tax'], d.items.slice(0, 300).map(function (i) {
                return [String(i.row || ''), i.sku, i.name, el('pre', { text: Object.keys(i.changes).map(function (k) { return k + ': ' + i.changes[k].from + ' → ' + i.changes[k].to; }).join('\n') || 'no change' }), i.taxOk ? 'approved' : 'no approved rate'];
              }))]));
          }).catch(err(out));
        }));
        act.appendChild(btn('Held rows', function () { api('GET', B + '/catalog/price-lists/' + p.id + '/report').then(function (rep) { out.replaceChildren(section('Import report', [json(rep && rep.report)])); }).catch(err(out)); }));
        if (p.status === 'draft' && E.has('catalog.pricing.edit')) act.appendChild(btn('Submit for approval', function () {
          var why = window.prompt('Reason for this price change'); if (!why) return;
          api('POST', B + '/catalog/price-lists/' + p.id + '/submit', { reason: why }).then(function () { E.show('pricing'); }).catch(err(out));
        }));
        if (p.status === 'approved' && E.has('catalog.pricing.publish')) act.appendChild(btn('Publish', function () {
          api('POST', B + '/catalog/price-lists/' + p.id + '/publish', {}).then(function (x) { out.replaceChildren(msg('ok', 'Published to ' + x.products + ' products')); E.show('pricing'); }).catch(err(out));
        }, 'primary'));
        return [p.code + ' v' + p.version_no + ' · ' + p.name, el('span', { class: 'tag', text: p.status }), String(p.items), fmt(p.created_at), act];
      }))]));
    }).catch(err(list));
    var sim = el('div');
    var f = { mrp: input('MRP'), gst: input('GST %'), rm: input('Retailer margin %'), dm: input('Distributor margin %'), sm: input('SS margin %'), sc: input('Scheme %') };
    main.appendChild(section('Price calculator (divide chain)', [el('div', { class: 'row' }, Object.keys(f).map(function (k) { return f[k].node; }).concat([btn('Calculate', function () {
      api('POST', B + '/catalog/pricing/simulate', { mrp: Number(f.mrp.input.value), gstPct: Number(f.gst.input.value), retailerMarginPct: Number(f.rm.input.value),
        distributorMarginPct: Number(f.dm.input.value), ssMarginPct: Number(f.sm.input.value || 0), schemePct: Number(f.sc.input.value || 0) }).then(function (r) { sim.replaceChildren(json(r)); }).catch(err(sim));
    })])), sim]));
  }

  function products(main) {
    main.appendChild(el('h1', { text: 'Products' }));
    var q = input('Search'), box = el('div');
    main.appendChild(el('div', { class: 'row' }, [q.node, btn('Search', load)]));
    main.appendChild(box);
    function load() {
      api('GET', B + '/catalog/products?q=' + encodeURIComponent(q.input.value) + '&limit=100').then(function (r) {
        box.replaceChildren(table(['SKU / SAP', 'Name', 'MRP', 'Retailer', 'Distributor', 'GST (master / approved)', 'Active'], r.items.map(function (p) {
          return [p.sku + (p.sap_code ? ' / ' + p.sap_code : ''), p.name, money(p.mrp), money(p.retailer_price), money(p.distributor_price), p.gst_rate + '% / ' + (p.approved_gst_rate == null ? 'none' : p.approved_gst_rate + '%'), p.is_active ? 'yes' : 'no'];
        })));
      }).catch(err(box));
    }
    load();
  }

  // ── Vendors ──
  function vendors(main) {
    main.appendChild(el('h1', { text: 'Vendors' }));
    var out = el('div'); main.appendChild(out);
    api('GET', B + '/vendors').then(function (r) {
      main.appendChild(table(['Vendor', 'GSTIN', 'Status', 'Capabilities', 'Docs to review', ''], r.items.map(function (v) {
        return [v.legal_name + (v.vendor_code ? ' (' + v.vendor_code + ')' : ''), v.gstin || '—', el('span', { class: 'tag', text: v.status }), v.capabilities || '', String(v.docs_pending),
          btn('Open', function () { vendorDetail(out, v.id); })];
      })));
    }).catch(err(out));
  }
  function vendorDetail(out, id) {
    api('GET', B + '/vendors/' + id).then(function (d) {
      var box = el('div');
      var stage = el('select', { 'aria-label': 'Stage' }, ['verification', 'document_review', 'procurement', 'finance_compliance', 'admin'].map(function (s) { return el('option', { value: s, text: s.replace('_', ' ') }); }));
      var outcome = el('select', { 'aria-label': 'Outcome' }, ['passed', 'more_info_required', 'failed'].map(function (s) { return el('option', { value: s, text: s.replace(/_/g, ' ') }); }));
      var note = input('Note');
      box.appendChild(section(d.vendor.legal_name + ' — ' + d.vendor.status, [
        table(['Document', 'Status', 'Uploaded', ''], d.documents.map(function (doc) {
          var a = el('div', { class: 'row' }, [el('a', { href: '#', text: 'View', on: { click: function (e) {
            e.preventDefault();
            fetch(B + '/vendors/' + id + '/documents/' + doc.id + '/file', { headers: { Authorization: 'Bearer ' + E.state.token } }).then(function (r) { return r.blob(); }).then(function (b) { window.open(URL.createObjectURL(b), '_blank', 'noopener'); });
          } } })]);
          if (doc.review_status === 'pending' && E.has('vendors.verify')) {
            a.appendChild(btn('Accept', function () { api('POST', B + '/vendors/' + id + '/documents/' + doc.id + '/review', { status: 'accepted' }).then(function () { vendorDetail(out, id); }).catch(err(box)); }));
            a.appendChild(btn('Reject', function () { var n = window.prompt('Why?'); if (n) api('POST', B + '/vendors/' + id + '/documents/' + doc.id + '/review', { status: 'rejected', note: n }).then(function () { vendorDetail(out, id); }).catch(err(box)); }, 'danger'));
          }
          return [doc.doc_type, doc.review_status, fmt(doc.created_at), a];
        })),
        el('h2', { text: 'Verification' }),
        table(['Stage', 'Outcome', 'Note', 'When'], d.verifications.map(function (x) { return [x.stage, x.outcome, x.note || '', fmt(x.created_at)]; })),
        E.has('vendors.verify') ? el('div', { class: 'row' }, [stage, outcome, note.node, btn('Record', function () {
          api('POST', B + '/vendors/' + id + '/verifications', { stage: stage.value, outcome: outcome.value, note: note.input.value }).then(function (r) {
            box.prepend(msg('ok', r.approval ? 'All stages passed — sent for approval' : 'Recorded')); vendorDetail(out, id);
          }).catch(err(box));
        }, 'primary')]) : null,
        el('h2', { text: 'Products offered' }),
        table(['Name', 'SKU', 'HSN', 'Status', ''], d.products.map(function (p) {
          var a = el('div', { class: 'row' });
          if (['submitted', 'under_review'].indexOf(p.status) !== -1 && E.has('vendors.products.approve')) {
            var pid = el('input', { 'aria-label': 'Map to product id', placeholder: 'Product id', inputmode: 'numeric' });
            a.appendChild(pid);
            a.appendChild(btn('Approve', function () { api('POST', B + '/vendor-products/' + p.id + '/decide', { decision: 'approved', productId: Number(pid.value) }).then(function () { vendorDetail(out, id); }).catch(err(box)); }));
          }
          return [p.name, p.vendor_sku || '', p.hsn_code || '', p.status, a];
        }))
      ]));
      out.replaceChildren(box);
    }).catch(err(out));
  }

  // ── Purchasing ──
  function purchasing(main) {
    main.appendChild(el('h1', { text: 'Purchasing' }));
    var out = el('div'); main.appendChild(out);
    api('GET', B + '/procurement/reorder-suggestions').then(function (r) {
      main.appendChild(section('Reorder suggestions', [table(['Warehouse', 'Product', 'Position', 'Min', 'Suggest'], r.items.map(function (x) { return [String(x.warehouse_id), x.name, String(x.position), String(x.min_qty), String(x.suggestedQty)]; }))]));
    }).catch(err(out));
    api('GET', B + '/procurement/purchase-orders').then(function (r) {
      main.appendChild(section('Purchase orders', [table(['PO', 'Vendor', 'Status', 'Total', 'Created', ''], r.items.map(function (p) {
        var a = el('div', { class: 'row' }, [btn('Lines', function () { api('GET', B + '/procurement/purchase-orders/' + p.id).then(function (d) {
          out.replaceChildren(section(d.po_no + ' — ' + d.status, [table(['Product', 'Ordered', 'Received', 'Rejected', 'Price', 'GST'], d.items.map(function (i) { return [i.name, String(i.qty_ordered), String(i.qty_received), String(i.qty_rejected), i.unit_price, i.gst_rate + '%']; }))]));
        }).catch(err(out)); })]);
        if (p.status === 'draft' && E.has('procurement.po.create')) a.appendChild(btn('Submit', function () { api('POST', B + '/procurement/purchase-orders/' + p.id + '/submit', {}).then(function () { E.show('purchasing'); }).catch(err(out)); }));
        if (p.status === 'approved' && E.has('procurement.po.create')) a.appendChild(btn('Send to vendor', function () { api('POST', B + '/procurement/purchase-orders/' + p.id + '/send', {}).then(function () { E.show('purchasing'); }).catch(err(out)); }, 'primary'));
        return [p.po_no, p.legal_name, el('span', { class: 'tag', text: p.status }), money(p.grand_total), fmt(p.created_at), a];
      }))]));
    }).catch(err(out));
    api('GET', B + '/procurement/purchase-returns').then(function (r) {
      main.appendChild(section('Returns to vendors (debit notes)', [table(['Return', 'Vendor', 'Source', 'Status', 'Debit note', 'Total', ''], r.items.map(function (x) {
        var a = el('div', { class: 'row' });
        if (x.status === 'draft' && E.has('procurement.po.create')) a.appendChild(btn('Submit', function () { api('POST', B + '/procurement/purchase-returns/' + x.id + '/submit', {}).then(function () { E.show('purchasing'); }).catch(err(out)); }));
        if (x.status === 'approved' && E.has('warehouse.grn.post')) a.appendChild(btn('Dispatch', function () { api('POST', B + '/procurement/purchase-returns/' + x.id + '/dispatch', {}).then(function () { E.show('purchasing'); }).catch(err(out)); }));
        if (['dispatched', 'acknowledged'].indexOf(x.status) !== -1 && E.has('finance.payables.pay')) a.appendChild(btn('Settle', function () {
          var bill = window.prompt('Adjust against bill id (leave empty if the vendor refunded)');
          var body = bill ? { supplierInvoiceId: Number(bill) } : { refundReference: window.prompt('Vendor refund reference') };
          api('POST', B + '/procurement/purchase-returns/' + x.id + '/settle', body).then(function () { E.show('purchasing'); }).catch(err(out));
        }));
        return [x.return_no, x.legal_name, x.source, el('span', { class: 'tag', text: x.status }), x.debit_note_no || '—', money(x.grand_total), a];
      }))]));
    }).catch(err(out));
    var rfq = input('RFQ id', { inputmode: 'numeric' });
    main.appendChild(section('Compare quotes', [el('div', { class: 'row' }, [rfq.node, btn('Compare', function () {
      api('GET', B + '/procurement/rfqs/' + Number(rfq.input.value) + '/comparison').then(function (c) {
        out.replaceChildren(section(c.rfq.rfqNo + ' — landed cost per vendor', [table(['Vendor', 'Landed total', 'Lines quoted', 'Lines fully covered', ''], c.vendorTotals.map(function (t, i) {
          return [t.vendor + (i === 0 ? ' (lowest)' : ''), money(t.landedTotal), String(t.linesQuoted), String(t.linesCovered), E.has('procurement.rfq.award') ? btn('Award', function () {
            var why = i === 0 ? 'Lowest landed cost' : window.prompt('Not the lowest: why award to this vendor?'); if (!why) return;
            api('POST', B + '/procurement/rfqs/' + c.rfq.id + '/award', { responseId: t.responseId, reason: why }).then(function (r) { out.replaceChildren(msg('ok', 'Draft PO ' + r.poNo + ' created')); }).catch(err(out));
          }) : ''];
        }))]));
      }).catch(err(out));
    })])]));
  }

  // ── Receiving ──
  function receiving(main) {
    main.appendChild(el('h1', { text: 'Goods receipt' }));
    main.appendChild(el('p', { class: 'note', text: 'Every accepted line needs batch and expiry. While the shelf-life rule is a pending decision you must tick that you reviewed the shelf life of each accepted line.' }));
    var po = input('PO id', { inputmode: 'numeric' }), out = el('div');
    main.appendChild(el('div', { class: 'row' }, [po.node, btn('Load PO', function () {
      api('GET', B + '/procurement/purchase-orders/' + Number(po.input.value)).then(function (d) {
        var rows = d.items.map(function (i) {
          return { i: i, batch: el('input', { 'aria-label': 'Batch' }), mfg: el('input', { type: 'date', 'aria-label': 'Mfg' }), exp: el('input', { type: 'date', 'aria-label': 'Expiry' }),
            rec: el('input', { inputmode: 'numeric', 'aria-label': 'Received', value: String(Number(i.qty_ordered) - Number(i.qty_received)) }), acc: el('input', { inputmode: 'numeric', 'aria-label': 'Accepted' }),
            rej: el('input', { inputmode: 'numeric', 'aria-label': 'Rejected', value: '0' }), qua: el('input', { inputmode: 'numeric', 'aria-label': 'Quarantined', value: '0' }),
            why: el('select', { 'aria-label': 'Reject reason' }, ['', 'damaged', 'short_expiry', 'wrong_item', 'quality_fail', 'excess', 'other'].map(function (x) { return el('option', { value: x, text: x || '—' }); })),
            ok: el('input', { type: 'checkbox', 'aria-label': 'Shelf life reviewed' }) };
        });
        out.replaceChildren(section(d.po_no + ' (' + d.status + ')', [table(['Product', 'Batch', 'Mfg', 'Expiry', 'Received', 'Accepted', 'Rejected', 'Quarantine', 'Reason', 'Life reviewed'], rows.map(function (r) {
          return [r.i.name, r.batch, r.mfg, r.exp, r.rec, r.acc, r.rej, r.qua, r.why, r.ok];
        })), btn('Create GRN and post', function () {
          var items = rows.filter(function (r) { return Number(r.rec.value) > 0; }).map(function (r) {
            var rec = Number(r.rec.value), rej = Number(r.rej.value || 0), qua = Number(r.qua.value || 0), acc = r.acc.value === '' ? rec - rej - qua : Number(r.acc.value);
            return { poItemId: r.i.id, batchNo: r.batch.value, mfgDate: r.mfg.value || undefined, expiryDate: r.exp.value || undefined, qtyReceived: rec, qtyAccepted: acc, qtyRejected: rej, qtyQuarantined: qua, rejectReason: r.why.value || undefined, shelfLifeReviewed: r.ok.checked };
          });
          api('POST', B + '/procurement/grns', { poId: d.id, items: items }).then(function (g) {
            return api('POST', B + '/procurement/grns/' + g.grnId + '/post', { reason: 'Quantities differ from the dispatch note' }).then(function (p) { out.replaceChildren(msg('ok', g.grnNo + ': ' + p.status)); });
          }).catch(err(out));
        }, 'primary')]));
      }).catch(err(out));
    })]));
    main.appendChild(out);
  }

  // ── Supplier bills ──
  function bills(main) {
    main.appendChild(el('h1', { text: 'Supplier bills' }));
    main.appendChild(el('p', { class: 'note', text: 'Three-way match: PO price × goods accepted at receipt × bill. While tolerance is a pending decision, any difference blocks payment until a finance manager resolves it.' }));
    var out = el('div'); main.appendChild(out);
    api('GET', B + '/procurement/supplier-invoices').then(function (r) {
      main.appendChild(table(['Vendor', 'Bill', 'Date', 'Total', 'Status', ''], r.items.map(function (i) {
        return [i.legal_name, i.invoice_no, fmt(i.invoice_date), money(i.grand_total), el('span', { class: 'tag', text: i.status }), E.has('finance.payables.create') && ['entered', 'disputed'].indexOf(i.status) !== -1 ? btn('Match', function () {
          api('POST', B + '/procurement/supplier-invoices/' + i.id + '/match', {}).then(function (m) {
            out.replaceChildren(section('Match result: ' + m.status, [table(['Line', 'Result', 'Billed', 'Accepted', 'PO price', 'Bill price', 'Variance'], m.lines.map(function (l) { return [String(l.line), l.result, String(l.qtyInvoiced), String(l.qtyAccepted), l.pricePo || '', l.priceInvoiced || '', l.variance || '']; }))]));
          }).catch(err(out));
        }) : ''];
      })));
    }).catch(err(out));
  }

  // ── Stock ──
  function stock(main) {
    main.appendChild(el('h1', { text: 'Stock' }));
    main.appendChild(msg('warn', 'Online-shop (B2C) stock is kept by the shop and is NOT included or synchronised here yet (shop integration comes in a later, separately approved step). Do not treat these figures as the shop\'s stock.'));
    var out = el('div');
    api('GET', B + '/inventory/stock').then(function (r) {
      main.appendChild(section('Balances', [table(['Warehouse', 'SKU', 'Product', 'Available', 'Reserved', 'Picked', 'In transit', 'Quarantine', 'Damaged', 'Expired'], r.items.map(function (x) {
        return [x.warehouse, x.sku, x.name, String(x.qty_available), String(x.qty_reserved), String(x.qty_allocated), String(x.qty_in_transit), String(x.qty_quarantine), String(x.qty_damaged), String(x.qty_expired)];
      }))]));
      main.appendChild(out);
    }).catch(err(main));
    api('GET', B + '/inventory/lots?limit=300').then(function (r) {
      main.appendChild(section('Batches (lots) — ' + r.nearExpiryRule, [table(['Product', 'Batch', 'Maker', 'Expiry', 'Days left', 'On hand', 'Quarantine', 'Status', ''], r.items.map(function (l) {
        return [l.name, l.batch_no, l.manufacturer, fmt(l.expiry_date), l.days_to_expiry == null ? '—' : String(l.days_to_expiry), String(l.on_hand), String(l.quarantine), l.status,
          E.has('inventory.trace') ? btn('Trace', function () { api('GET', B + '/inventory/lots/' + l.id + '/trace').then(function (t) {
            out.replaceChildren(section('Trace: batch ' + t.lot.batch_no, [el('p', { class: 'note', text: t.limits }), json(t.balance),
              el('h2', { text: 'Came from' }), table(['GRN', 'PO', 'Supplier', 'Accepted', 'Quarantined'], t.backward.map(function (b) { return [b.grn_no, b.po_no, b.supplier, String(b.qty_accepted), String(b.qty_quarantined)]; })),
              el('h2', { text: 'Went to' }), table(['Order', 'Customer', 'Mobile', 'Units', 'Status'], t.forward.map(function (f) { return [f.order_no, f.business_name, f.mobile, String(f.qty), f.status]; }))]));
          }).catch(err(out)); }) : ''];
      }))]));
    }).catch(err(main));
    api('GET', B + '/inventory/b2c-feed').then(function (f) {
      main.appendChild(section('Online shop demand (observe only)', [msg('warn', f.warning), el('p', { class: 'note', text: f.lastRun ? 'Last read: ' + fmt(f.lastRun.last_run_at) + ' — ' + f.lastRun.last_result : 'Not run (decision b2c.feed.enabled is off)' }),
        table(['SKU', 'Product', 'Shop units (' + f.days + ' days)', 'Business stock available'], f.items.map(function (x) { return [x.sku, x.name, String(x.shop_units), String(x.business_available)]; })),
        f.unmapped.length ? el('p', { class: 'note', text: 'Shop items not linked to a product (set b2c_ref): ' + f.unmapped.map(function (u) { return u.b2c_item_ref + ' (' + u.units + ')'; }).join(', ') }) : null]));
    }).catch(err(main));
    // Adjustments and opening balances (owner decision 5): proposed here, posted after a second person approves
    var adj = el('div'); main.appendChild(adj);
    function loadAdjustments() {
      api('GET', B + '/inventory/adjustments').then(function (r) {
        adj.replaceChildren(section('Stock adjustments and opening balances', [
          el('p', { class: 'note', text: 'Company stock is added only through a goods receipt, or through an adjustment / opening balance that a second person approves under Approvals. Nothing below changes stock until it is approved.' }),
          table(['No.', 'Kind', 'Warehouse', 'SKU', 'Batch', 'Change', 'Reason', 'Status'], r.items.map(function (a) {
            return [a.adj_no, a.kind === 'opening' ? 'Opening balance' : 'Adjustment', a.warehouse, a.sku, a.batch_no || '—',
              (a.direction === 'increase' ? '+' : '−') + a.qty + ' ' + a.bucket, a.reason_code + ': ' + a.reason,
              a.status === 'proposed' ? 'Awaiting approval' + (a.approval_status && a.approval_status !== 'pending' ? ' (' + a.approval_status + ')' : '') : a.status];
          })), E.has('inventory.adjust.propose') ? adjustForm() : null]));
      }).catch(err(adj));
    }
    function adjustForm() {
      var box = el('div');
      var kind = el('select', { 'aria-label': 'Kind' }, [el('option', { value: 'adjustment', text: 'Adjustment' }), el('option', { value: 'opening', text: 'Opening balance' })]);
      var dir = el('select', { 'aria-label': 'Direction' }, [el('option', { value: 'decrease', text: 'Decrease' }), el('option', { value: 'increase', text: 'Increase' })]);
      var bucket = el('select', { 'aria-label': 'Bucket' }, ['available', 'damaged', 'expired', 'quarantine'].map(function (b) { return el('option', { value: b, text: b }); }));
      var reasonCode = el('select', { 'aria-label': 'Reason' }, ['damage', 'expiry', 'loss', 'theft', 'correction', 'found'].map(function (b) { return el('option', { value: b, text: b }); }));
      var f = { wh: input('Warehouse id', { inputmode: 'numeric' }), pr: input('Product id', { inputmode: 'numeric' }), qty: input('Quantity', { inputmode: 'numeric' }),
        lot: input('Existing lot id (optional)', { inputmode: 'numeric' }), batch: input('Batch no. (new stock)'), exp: input('Expiry (YYYY-MM-DD)'), mfr: input('Manufacturer id', { inputmode: 'numeric' }),
        why: input('Reason (at least 5 characters)') };
      box.appendChild(el('h2', { text: 'Propose' }));
      box.appendChild(el('div', { class: 'row' }, [el('label', {}, ['Kind', kind]), el('label', {}, ['Direction', dir]), el('label', {}, ['Bucket', bucket]), el('label', {}, ['Reason code', reasonCode]),
        f.wh.node, f.pr.node, f.qty.node, f.lot.node, f.batch.node, f.exp.node, f.mfr.node, f.why.node]));
      var send = btn('Send for approval', function () {
        send.disabled = true;
        api('POST', B + '/inventory/adjustments', { kind: kind.value, direction: dir.value, bucket: bucket.value, reasonCode: reasonCode.value, warehouseId: f.wh.input.value, productId: f.pr.input.value,
          qty: Number(f.qty.input.value), lotId: f.lot.input.value || undefined, batchNo: f.batch.input.value || undefined, expiry: f.exp.input.value || undefined, manufacturerId: f.mfr.input.value || undefined, reason: f.why.input.value })
          .then(function (r) { loadAdjustments(); main.prepend(msg('ok', r.adjNo + ' sent for approval')); })
          .catch(function (e) { send.disabled = false; box.prepend(msg('err', e.message)); });
      }, 'primary');
      box.appendChild(send);
      return box;
    }
    loadAdjustments();
    main.appendChild(btn('Run reconciliation', function () {
      api('GET', B + '/inventory/reconciliation').then(function (r) { out.replaceChildren(r.ok ? msg('ok', 'All ' + r.checked + ' balances agree with the ledger and batches') : section(r.issues.length + ' difference(s)', [json(r.issues)])); }).catch(err(out));
    }));
  }

  // ── Network ──
  function network(main) {
    main.appendChild(el('h1', { text: 'Distribution network' }));
    main.appendChild(el('p', { class: 'note', text: 'Points are drawn from saved shop locations only (no map service is called). Blue = distributor, green = retailer with a distributor, orange = retailer served by the company.' }));
    var canvas = el('canvas', { width: '900', height: '520', role: 'img', 'aria-label': 'Network map', style: 'width:100%;max-width:900px;border:1px solid #DDE1E6;border-radius:8px;background:#fff' });
    var info = el('div');
    main.appendChild(canvas); main.appendChild(info);
    api('GET', B + '/network/map').then(function (m) {
      var f = m.features; if (!f.length) { info.appendChild(msg('warn', 'No located accounts yet.')); return; }
      var xs = f.map(function (p) { return p.geometry.coordinates[0]; }), ys = f.map(function (p) { return p.geometry.coordinates[1]; });
      var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
      var pad = 30, w = canvas.width - 2 * pad, h = canvas.height - 2 * pad, sx = w / Math.max(maxX - minX, 0.01), sy = h / Math.max(maxY - minY, 0.01), sc = Math.min(sx, sy);
      var ctx = canvas.getContext('2d');
      f.forEach(function (p) {
        var x = pad + (p.geometry.coordinates[0] - minX) * sc, y = canvas.height - pad - (p.geometry.coordinates[1] - minY) * sc;
        ctx.beginPath(); ctx.arc(x, y, p.properties.kind === 'distributor' ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = p.properties.kind === 'distributor' ? '#1F5FBF' : (p.properties.distributorId ? '#1E7A46' : '#C2410C'); ctx.fill();
      });
      info.appendChild(el('p', { class: 'note', text: f.length + ' located · ' + m.withoutLocation.length + ' without a location' }));
    }).catch(err(info));
    api('GET', B + '/network/territories').then(function (r) {
      main.appendChild(section('Territories', [table(['Code', 'Name', 'Level', 'Accounts'], r.items.map(function (t) { return [t.code, t.name, t.level, String(t.accounts)]; }))]));
    }).catch(err(info));
  }

  // ── Recalls ──
  function recalls(main) {
    main.appendChild(el('h1', { text: 'Recalls' }));
    var out = el('div'); main.appendChild(out);
    if (E.has('recalls.create')) {
      var lots = input('Lot ids (comma separated)'), reason = input('Reason'), sev = el('select', { 'aria-label': 'Severity' }, ['class_1', 'class_2', 'class_3', 'precautionary'].map(function (s) { return el('option', { value: s, text: s.replace('_', ' ') }); })),
        by = el('select', { 'aria-label': 'Initiated by' }, ['manufacturer', 'company', 'regulator'].map(function (s) { return el('option', { value: s, text: s }); }));
      main.appendChild(section('Start a recall (draft)', [el('div', { class: 'row' }, [lots.node, reason.node, sev, by, btn('Create draft', function () {
        api('POST', B + '/recalls', { lotIds: lots.input.value.split(',').map(function (x) { return Number(x.trim()); }), reason: reason.input.value, severity: sev.value, initiatedBy: by.value })
          .then(function () { E.show('recalls'); }).catch(err(out));
      }, 'primary')])]));
    }
    api('GET', B + '/recalls').then(function (r) {
      main.appendChild(table(['Recall', 'Severity', 'Status', 'Lots', 'Open customers', ''], r.items.map(function (x) {
        var a = el('div', { class: 'row' }, [btn('Reconcile', function () { api('GET', B + '/recalls/' + x.id + '/reconciliation').then(function (rc) {
          out.replaceChildren(section(x.recall_no + (rc.readyToClose ? ' — ready to close' : ' — open: ' + rc.blockers.join('; ')), [
            table(['Batch', 'Product', 'Received', 'Shipped', 'Returned', 'Saleable now', 'At customers'], rc.lots.map(function (l) { return [l.batch_no, l.name, String(l.qty_received_total), String(l.qty_shipped_out), String(l.qty_returned), String(l.onHandNow), String(l.outstandingAtCustomers)]; })),
            table(['Customer', 'Mobile', 'Supplied', 'Returned', 'Declared sold', 'Status'], rc.parties.map(function (p) { return [p.business_name, p.mobile, String(p.qty_supplied), String(p.qty_returned), String(p.qty_declared_sold), p.status]; }))]));
        }).catch(err(out)); })]);
        if (x.status === 'draft' && E.has('recalls.activate')) a.appendChild(btn('Activate now', function () {
          if (!window.confirm('Activating blocks these batches everywhere and notifies every customer who received them. Continue?')) return;
          api('POST', B + '/recalls/' + x.id + '/activate', {}).then(function (r2) { out.replaceChildren(msg('ok', r2.lotsBlocked + ' batch(es) blocked, ' + r2.partiesNotified + ' customer(s) notified')); }).catch(err(out));
        }, 'danger'));
        return [x.recall_no + ' — ' + x.reason, x.severity, el('span', { class: 'tag', text: x.status }), String(x.lots), String(x.open_parties), a];
      })));
    }).catch(err(out));
  }

  // ── Finance ──
  function finance(main) {
    main.appendChild(el('h1', { text: 'Finance' }));
    main.appendChild(el('p', { class: 'note', text: 'No bank is connected: statements are uploaded as CSV and matches are confirmed by a person.' }));
    var out = el('div'); main.appendChild(out);
    ['receivables', 'payables'].forEach(function (side) {
      api('GET', B + '/finance/ageing?side=' + side).then(function (r) {
        main.appendChild(section('Ageing — ' + side + ' (total ' + money(r.totals.total) + ')', [el('p', { class: 'note', text: r.basis }),
          table(['Party', 'Current', '1–30', '31–60', '61–90', '90+', 'Total'], r.parties.map(function (p) { return [p.party, money(p.current), money(p['1_30']), money(p['31_60']), money(p['61_90']), money(p['90_plus']), money(p.total)]; }))]));
      }).catch(err(out));
    });
    api('GET', B + '/finance/settlements').then(function (r) {
      main.appendChild(section('Distributor settlements', [table(['No.', 'Distributor', 'Period', 'Scheme claims', 'Return credits', 'Other', 'Net', 'Status', ''], r.items.map(function (x) {
        var a = el('div', { class: 'row' });
        if (x.status === 'draft' && E.has('finance.payables.create')) a.appendChild(btn('Submit', function () { api('POST', B + '/finance/settlements/' + x.id + '/submit', {}).then(function () { E.show('finance'); }).catch(err(out)); }));
        if (x.status === 'approved' && E.has('finance.payables.pay')) a.appendChild(btn('Mark paid', function () { var ref = window.prompt('Bank reference'); if (ref) api('POST', B + '/finance/settlements/' + x.id + '/mark-settled', { reference: ref }).then(function () { E.show('finance'); }).catch(err(out)); }));
        return [x.settlement_no, x.business_name, fmt(x.period_from).split(',')[0] + ' – ' + fmt(x.period_to).split(',')[0], money(x.scheme_claims), money(x.return_credits), money(x.other_adjustments), money(x.net_amount), x.status, a];
      }))]));
    }).catch(err(out));
    if (E.has('finance.payables.create')) {
      var dId = input('Distributor id', { inputmode: 'numeric' }), from = input('From', { type: 'date' }), to = input('To', { type: 'date' }), other = input('Other adjustment (₹, ±)'), why = input('Reason');
      main.appendChild(section('New settlement', [el('div', { class: 'row' }, [dId.node, from.node, to.node, other.node, why.node, btn('Draft', function () {
        api('POST', B + '/finance/settlements', { distributorId: Number(dId.input.value), periodFrom: from.input.value, periodTo: to.input.value, otherAdjustments: other.input.value || 0, reason: why.input.value })
          .then(function () { E.show('finance'); }).catch(err(out));
      }, 'primary')])]));
    }
    if (E.has('finance.bank.reconcile')) api('GET', B + '/finance/bank-lines?status=suggested').then(function (r) {
      main.appendChild(section('Bank lines with a suggested match', [table(['Date', 'Description', 'Debit', 'Credit', 'Suggested', ''], r.items.map(function (l) {
        return [fmt(l.txn_date), l.description, money(l.debit), money(l.credit), l.matched_type + ' #' + l.matched_id, btn('Confirm', function () {
          api('POST', B + '/finance/bank-lines/' + l.id + '/match', {}).then(function () { E.show('finance'); }).catch(err(out));
        })];
      }))]));
    }).catch(err(out));
  }

  function collections(main) {
    main.appendChild(el('h1', { text: 'Salesman collections' }));
    main.appendChild(el('p', { class: 'note', text: 'Money collected in the field is applied to the order only after you confirm it reached the company. The collector cannot confirm their own collection.' }));
    var out = el('div'); main.appendChild(out);
    api('GET', B + '/sales/collections/pending').then(function (r) {
      main.appendChild(table(['Receipt', 'Salesman', 'Order', 'Method', 'Amount', 'Reference', ''], r.items.map(function (p) {
        return [p.receipt_no, p.salesman, String(p.order_id), p.method, money(p.amount), p.reference || '', btn('Confirm handover', function () {
          api('POST', B + '/sales/collections/' + p.id + '/confirm', {}).then(function () { E.show('collections'); }).catch(err(out));
        }, 'primary')];
      })));
    }).catch(err(out));
  }

  function salesDesk(main) {
    main.appendChild(el('h1', { text: 'Sales desk' }));
    var out = el('div'); main.appendChild(out);
    api('GET', B + '/sales/performance').then(function (r) {
      main.appendChild(section('Achievement — ' + r.month, [el('p', { class: 'note', text: r.basis }), table(['Salesman', 'Sales ₹ (target)', 'Orders', 'New retailers', 'Collections ₹', 'Visits'], r.items.map(function (x) {
        var f = function (k) { return String(x.actual[k]) + (x.target[k] != null ? ' / ' + x.target[k] + ' (' + x.achievementPct[k] + '%)' : ''); };
        return [x.name, f('sales_value'), f('orders'), f('new_retailers'), f('collections'), f('visits')];
      }))]));
    }).catch(err(out));
    if (E.has('sales.targets.edit')) {
      var sm = input('Salesman id', { inputmode: 'numeric' }), mo = input('Month', { placeholder: 'YYYY-MM' }), val = input('Target');
      var met = el('select', { 'aria-label': 'Metric' }, ['sales_value', 'orders', 'new_retailers', 'collections', 'visits'].map(function (m) { return el('option', { value: m, text: m.replace('_', ' ') }); }));
      main.appendChild(section('Set a target', [el('div', { class: 'row' }, [sm.node, mo.node, met, val.node, btn('Save', function () {
        api('PUT', B + '/sales/targets', { salesmanId: Number(sm.input.value), month: mo.input.value, metric: met.value, value: Number(val.input.value) }).then(function () { E.show('salesdesk'); }).catch(err(out));
      })])]));
    }
    api('GET', B + '/sales/beats').then(function (r) {
      main.appendChild(section('Beats', [table(['Beat', 'Salesman', 'Day', 'Stops', 'Active'], r.items.map(function (b) { return [b.name, String(b.salesman_id), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][b.weekday], String(b.stops), b.is_active ? 'yes' : 'no']; }))]));
    }).catch(err(out));
    if (E.has('sales.office_orders.create')) {
      var acc = input('Customer account id', { inputmode: 'numeric' }), lines = input('Items (productId:qty, …)'), why = input('Who asked, how');
      var pay = el('select', { 'aria-label': 'Payment' }, [['bank_transfer', 'Bank transfer'], ['upi', 'UPI'], ['credit', 'Credit']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      main.appendChild(section('Office order (needs approval)', [el('div', { class: 'row' }, [acc.node, lines.node, pay, why.node, btn('Request', function () {
        var items = lines.input.value.split(',').map(function (x) { var p = x.split(':'); return { productId: Number(p[0]), qty: Number(p[1]) }; });
        api('POST', B + '/sales/office-orders', { accountId: Number(acc.input.value), items: items, paymentMethod: pay.value, reason: why.input.value })
          .then(function (r) { out.replaceChildren(msg('ok', r.orderNo + ' (₹' + r.grandTotal + ') sent for approval')); }).catch(err(out));
      }, 'primary')])]));
    }
  }

  // ── Notifications (N2/N3): compose, history, detail, resend, templates, consent ──
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  var N_STATUS = { pending: 'Queued', sending: 'Sending', sent: 'Accepted by provider', failed: 'Failed', skipped_no_provider: 'Not sent: no provider', skipped_no_contact: 'Not sent: no contact', skipped_opt_out: 'Not sent: opted out',
    queued: 'Queued', accepted: 'Accepted by provider', retry_scheduled: 'Retry scheduled', requeued: 'Re-queued', delivered: 'Delivered', read: 'Read' };
  function nTag(st, dl) {
    var cls = st === 'sent' ? 'ok' : (st === 'failed' ? 'bad' : (/^skipped/.test(st) ? '' : 'pending'));
    var t = el('span', {}, [el('span', { class: 'tag ' + cls, text: N_STATUS[st] || st })]);
    if (dl && dl !== 'unknown') t.appendChild(el('span', { class: 'tag ' + (dl === 'failed' ? 'bad' : 'ok'), text: dl === 'failed' ? 'Failed (report)' : (N_STATUS[dl] || dl), style: 'margin-left:6px' }));
    return t;
  }
  function notifications(main) {
    var st = { tab: 'overview', meta: null, picked: [], found: [], detail: null, filters: {} };
    main.appendChild(el('h1', { text: 'Notifications' }));
    main.appendChild(el('p', { class: 'note', text: 'Email, WhatsApp and SMS to retailers, distributors, salesmen, suppliers, manufacturers and staff. "Accepted by provider" means the mail server or gateway took the message; delivery is shown only when the provider reports it. Shop customers are not included.' }));
    var tabs = el('div', { class: 'ntabs', role: 'tablist' }), body = el('div', { class: 'nbody' });
    main.appendChild(tabs); main.appendChild(body);
    function tabBar() {
      var list = [['overview', 'Overview'], ['compose', 'Compose'], ['history', 'History'], ['templates', 'Templates'], ['consent', 'Consent & groups']].filter(function (t) {
        if (t[0] === 'compose') return st.meta && st.meta.recipientTypes.length;
        return true;
      });
      tabs.replaceChildren.apply(tabs, list.map(function (t) {
        return el('button', { type: 'button', role: 'tab', class: 'ntab', 'aria-selected': String(st.tab === t[0]), text: t[1], on: { click: function () { st.tab = t[0]; st.detail = null; draw(); } } });
      }));
    }
    function draw() { tabBar(); body.replaceChildren(); if (st.detail) return detail(st.detail); ({ overview: overview, compose: compose, history: history, templates: tmpl, consent: consent })[st.tab](); }
    api('GET', B + '/notifications/meta').then(function (m) { st.meta = m; draw(); }).catch(err(main));

    function overview() {
      api('GET', B + '/notifications/analytics?days=30').then(function (a) {
        var sum = function (f) { return a.byChannel.filter(f).reduce(function (n, r) { return n + r.n; }, 0); };
        body.appendChild(el('div', { class: 'grid' }, [kpi('Messages (30 days)', a.messages), kpi('Resends', a.resends), kpi('Accepted by provider', sum(function (r) { return r.status === 'sent'; })),
          kpi('Delivered (reported)', sum(function (r) { return r.deliveryStatus === 'delivered' || r.deliveryStatus === 'read'; })), kpi('Failed', sum(function (r) { return r.status === 'failed'; })),
          kpi('Not sent', sum(function (r) { return /^skipped/.test(r.status); }))]));
        var p = st.meta.providers;
        body.appendChild(section('Providers', [el('div', { class: 'row' }, [['Email (SMTP)', p.email], ['WhatsApp', p.whatsapp], ['SMS (MSG91)', p.sms]].map(function (x) {
          return el('span', { class: 'tag ' + (x[1] ? 'ok' : 'pending'), text: x[0] + ': ' + (x[1] ? 'configured' : 'not configured — messages are marked Not sent') });
        })), el('p', { class: 'note', text: a.note })]));
        var chans = ['email', 'whatsapp', 'sms'];
        body.appendChild(section('By channel (30 days)', [table(['Channel', 'Accepted', 'Delivered', 'Failed', 'Not sent', 'Queued'], chans.map(function (c) {
          var f = function (g) { return String(a.byChannel.filter(function (r) { return r.channel === c && g(r); }).reduce(function (n, r) { return n + r.n; }, 0)); };
          return [c, f(function (r) { return r.status === 'sent'; }), f(function (r) { return r.deliveryStatus === 'delivered' || r.deliveryStatus === 'read'; }), f(function (r) { return r.status === 'failed'; }), f(function (r) { return /^skipped/.test(r.status); }), f(function (r) { return r.status === 'pending' || r.status === 'sending'; })];
        }))]));
        body.appendChild(section('Most common reasons for failed or unsent messages', [a.topReasons.length ? table(['Reason', 'Messages'], a.topReasons.map(function (r) { return [r.reason || '—', String(r.n)]; })) : el('p', { class: 'note', text: 'None in the last 30 days.' })]));
        body.appendChild(section('Limits in force', [el('p', { class: 'note', text: 'Up to ' + st.meta.limits.max_recipients + ' recipients per send; ' + st.meta.limits.max_sends_per_hour + ' sends per administrator per hour; promotional sends above ' + st.meta.limits.promo_approval_over + ' recipients need a second person\'s approval. Changed under Business Decisions (notifications.limits).' })]));
      }).catch(err(body));
    }

    function compose() {
      var m = st.meta, key = null;
      var type = el('select', { 'aria-label': 'Recipient type' }, m.recipientTypes.map(function (t) { return el('option', { value: t, text: t.charAt(0).toUpperCase() + t.slice(1) + 's' }); }));
      var q = el('input', { 'aria-label': 'Search recipients', placeholder: 'Name, email or mobile' });
      var results = el('div'), picked = el('div'), count = el('p', { class: 'note' });
      function showPicked() {
        count.textContent = st.picked.length + ' recipient(s) selected (limit ' + m.limits.max_recipients + ')';
        picked.replaceChildren.apply(picked, st.picked.map(function (p, i) {
          return el('span', { class: 'tag', style: 'margin:0 6px 6px 0' }, [p.name + ' · ' + p.type + ' ', el('button', { type: 'button', class: 'linkish', 'aria-label': 'Remove ' + p.name, text: '×', on: { click: function () { st.picked.splice(i, 1); showPicked(); } } })]);
        }));
      }
      function add(p) { if (!st.picked.some(function (x) { return x.type === p.type && x.ref === p.ref; })) st.picked.push(p); }
      function find(all) {
        api('GET', B + '/notifications/recipients?type=' + type.value + '&q=' + encodeURIComponent(q.value) + (all ? '&all=1' : '')).then(function (r) {
          if (all) { r.items.slice(0, m.limits.max_recipients).forEach(add); showPicked(); if (r.truncated) results.prepend(msg('warn', 'More than ' + m.limits.max_recipients + ' match; only the first ' + m.limits.max_recipients + ' were added.')); return; }
          results.replaceChildren(table(['', 'Name', 'Email', 'Mobile'], r.items.map(function (p) {
            return [btn('Add', function () { add(p); showPicked(); }), p.name, p.email || '—', p.mobile || '—'];
          })));
        }).catch(err(results));
      }
      var chk = {};
      var chans = el('div', { class: 'row' }, ['email', 'whatsapp', 'sms'].map(function (c) {
        chk[c] = el('input', { type: 'checkbox', 'aria-label': c });
        if (c === 'email') chk[c].checked = true;
        return el('label', { style: 'flex-direction:row;align-items:center;gap:8px' }, [chk[c], c === 'email' ? 'Email' : (c === 'whatsapp' ? 'WhatsApp (approved template)' : 'SMS (DLT template)')]);
      }));
      var tSel = {}, tParams = {};
      function fillTemplates(c, promo) {
        var opts = m.templates.filter(function (t) { return t.channel === c && (t.category === 'promotional') === promo; });
        tSel[c].replaceChildren.apply(tSel[c], [el('option', { value: '', text: opts.length ? 'Choose a template' : 'No approved ' + (promo ? 'promotional ' : '') + c + ' template yet (see Templates)' })].concat(opts.map(function (t) { return el('option', { value: String(t.id), text: t.name + (t.language ? ' (' + t.language + ')' : '') }); })));
        tParams[c].replaceChildren();
      }
      ['whatsapp', 'sms'].forEach(function (c) {
        tSel[c] = el('select', { 'aria-label': c + ' template' });
        tParams[c] = el('div', { class: 'row' });
        fillTemplates(c, false);
        tSel[c].addEventListener('change', function () {
          var t = m.templates.find(function (x) { return String(x.id) === tSel[c].value; });
          tParams[c].replaceChildren.apply(tParams[c], (t && t.param_names ? t.param_names.split(',') : []).map(function (n) { return input(n, { 'data-p': n }).node; }));
        });
      });
      var category = el('select', { 'aria-label': 'Category' }, [el('option', { value: 'transactional', text: 'Transactional (orders, payments, accounts)' }), el('option', { value: 'service', text: 'Service update' })]
        .concat(m.canPromote ? [el('option', { value: 'promotional', text: 'Promotional (offers; consented business accounts only)' })] : []));
      var reason = input('Why this promotion (read by the approver)'); reason.node.hidden = true;
      var promoNote = el('p', { class: 'note', hidden: 'hidden', text: 'Promotional messages go only to retailers and distributors who agreed to receive offers on that channel; everyone else is shown as "Not sent: opted out". Not by SMS. More than ' + m.limits.promo_approval_over + ' recipients need a second person\'s approval before anything is sent.' });
      category.addEventListener('change', function () {
        var promo = category.value === 'promotional';
        fillTemplates('whatsapp', promo); fillTemplates('sms', promo);
        chk.sms.disabled = promo; if (promo) chk.sms.checked = false;
        reason.node.hidden = !promo; promoNote.hidden = !promo;
        key = null; sendBtn.disabled = true; preview.replaceChildren();
      });
      var subject = input('Subject (email)'), text = el('textarea', { rows: '6', 'aria-label': 'Message', placeholder: 'Write the message. Email uses it as the body; WhatsApp and SMS use their approved template.' });
      var preview = el('div'), out = el('div'), sendBtn;
      var gSel = el('select', { 'aria-label': 'Recipient group' }, [el('option', { value: '', text: 'Loading groups…' })]), gPicked = el('div');
      st.groups = st.groups || [];
      function showGroups() {
        gPicked.replaceChildren.apply(gPicked, st.groups.map(function (g, i) {
          return el('span', { class: 'tag', style: 'margin:0 6px 6px 0' }, ['Group: ' + g.name + ' (' + g.size + ') ', el('button', { type: 'button', class: 'linkish', 'aria-label': 'Remove group ' + g.name, text: '×', on: { click: function () { st.groups.splice(i, 1); showGroups(); } } })]);
        }));
      }
      api('GET', B + '/notifications/groups').then(function (r) {
        var usable = r.items.filter(function (g) { return g.usable; });
        gSel.replaceChildren.apply(gSel, [el('option', { value: '', text: usable.length ? 'Choose a group' : 'No groups yet (Consent & groups tab)' })].concat(usable.map(function (g) { return el('option', { value: String(g.id), text: g.name + ' — ' + g.size + ' ' + g.types.join('/') + (g.kind === 'rule' ? ' (rule)' : '') }); })));
        gSel._items = usable;
      }).catch(function () { gSel.replaceChildren(el('option', { value: '', text: 'Groups unavailable' })); });
      body.appendChild(section('1. Recipients', [el('div', { class: 'row' }, [el('label', {}, ['Type', type]), el('label', { style: 'flex:1 1 260px' }, ['Search', q]), btn('Search', function () { find(false); }), btn('Add all active', function () { find(true); })]), results, count, picked,
        el('div', { class: 'row' }, [el('label', { style: 'flex:1 1 260px' }, ['Or a saved group', gSel]), btn('Add group', function () {
          var g = (gSel._items || []).find(function (x) { return String(x.id) === gSel.value; });
          if (g && !st.groups.some(function (x) { return x.id === g.id; })) { st.groups.push(g); showGroups(); }
        })]), gPicked]));
      showGroups();
      body.appendChild(section('2. Message', [el('div', { class: 'row' }, [el('label', {}, ['Category', category])]), promoNote, chans, subject.node, el('label', {}, ['Message', text]),
        el('div', { class: 'row' }, [el('label', {}, ['WhatsApp template', tSel.whatsapp])]), tParams.whatsapp, el('div', { class: 'row' }, [el('label', {}, ['SMS template', tSel.sms])]), tParams.sms, reason.node]));
      function params(c) { var o = {}; tParams[c].querySelectorAll('input').forEach(function (i) { o[i.getAttribute('data-p')] = i.value; }); return o; }
      function payload() {
        var ch = ['email', 'whatsapp', 'sms'].filter(function (c) { return chk[c].checked; });
        var wp = params('whatsapp');
        return { category: category.value, channels: ch, subject: subject.input.value, body: text.value, whatsappTemplateId: tSel.whatsapp.value || undefined, smsTemplateId: tSel.sms.value || undefined,
          params: { whatsapp: Object.keys(wp).map(function (k) { return wp[k]; }), sms: params('sms') }, recipients: st.picked.map(function (p) { return { type: p.type, ref: p.ref }; }),
          groups: st.groups.map(function (g) { return g.id; }), reason: category.value === 'promotional' ? reason.input.value : undefined };
      }
      sendBtn = btn('Confirm and send', function () {
        sendBtn.disabled = true; out.replaceChildren();
        var b = payload(); b.requestKey = key;
        api('POST', B + '/notifications/messages', b).then(function (r) {
          out.replaceChildren(r.awaitingApproval
            ? msg('warn', r.messageNo + ' is waiting for a second person\'s approval (Administration → Approvals). Nothing has been sent yet.' + (r.duplicate ? ' (Already submitted with this confirmation.)' : ''))
            : msg('ok', r.messageNo + ' queued: ' + r.queued + ' message(s). ' + (r.duplicate ? '(Already sent with this confirmation — not sent twice.)' : '')), btn('Open ' + r.messageNo, function () { st.detail = r.messageId; draw(); }));
          st.picked = []; st.groups = []; key = null;
        }).catch(function (e) { sendBtn.disabled = false; out.replaceChildren(msg('err', e.message)); });
      }, 'primary');
      sendBtn.disabled = true;
      body.appendChild(section('3. Preview and confirm', [btn('Preview', function () {
        var b = payload(), lack = { email: 0, mobile: 0 };
        st.picked.forEach(function (p) { if (!p.hasEmail) lack.email++; if (!p.hasMobile) lack.mobile++; });
        var lines = [el('p', {}, [el('b', { text: b.recipients.length + ' picked' + (b.groups.length ? ' + ' + b.groups.length + ' group(s)' : '') }), ' by ' + (b.channels.join(', ') || 'no channel') + ' · ' + b.category])];
        if (b.channels.indexOf('email') !== -1) lines.push(el('div', { class: 'panel' }, [el('div', { class: 'note', text: 'Email subject' }), el('div', { text: b.subject || '(none)' }), el('div', { class: 'note', text: 'Email body', style: 'margin-top:8px' }), el('div', { text: b.body || '(none)', style: 'white-space:pre-wrap' })]));
        ['whatsapp', 'sms'].forEach(function (c) {
          if (b.channels.indexOf(c) === -1) return;
          var t = m.templates.find(function (x) { return String(x.id) === tSel[c].value; });
          lines.push(el('div', { class: 'panel' }, [el('div', { class: 'note', text: c === 'whatsapp' ? 'WhatsApp template' : 'SMS template' }), el('div', { text: t ? t.name + ' — ' + (t.sample_text || '') : 'No template chosen' }), el('pre', { text: JSON.stringify(c === 'whatsapp' ? b.params.whatsapp : b.params.sms) })]));
        });
        if (b.channels.indexOf('email') !== -1 && lack.email) lines.push(msg('warn', lack.email + ' recipient(s) have no email address: their email will show "Not sent: no contact".'));
        if ((b.channels.indexOf('whatsapp') !== -1 || b.channels.indexOf('sms') !== -1) && lack.mobile) lines.push(msg('warn', lack.mobile + ' recipient(s) have no mobile number.'));
        preview.replaceChildren.apply(preview, lines);
        sendBtn.disabled = true;
        if (!b.channels.length || (!b.recipients.length && !b.groups.length)) return;
        // what the server will do: active recipients, consent per channel, approval
        api('POST', B + '/notifications/preview', b).then(function (pv) {
          var more = [el('p', {}, [el('b', { text: pv.active + ' active recipient(s)' }), pv.chosen !== pv.active ? ' of ' + pv.chosen + ' chosen' : ''])];
          if (pv.tooMany) more.push(msg('err', 'More than ' + pv.limit + ' recipients: split the send.'));
          more.push(table(['Channel', 'With address', 'Will be sent', 'Opted out', 'No consent'], Object.keys(pv.channels).map(function (c) {
            var x = pv.channels[c]; return [c, String(x.withAddress), String(x.willSend), String(x.optedOut), pv.category === 'promotional' ? String(x.noConsent) : '—'];
          })));
          if (pv.needsApproval) more.push(msg('warn', 'More than ' + pv.approvalOver + ' recipients: this promotion waits for a second person\'s approval. Give a reason above.'));
          if (pv.problem) more.push(msg('err', pv.problem.error));
          more.forEach(function (n) { preview.appendChild(n); });
          key = uuid(); sendBtn.disabled = !!pv.problem || !pv.active || pv.tooMany;
        }).catch(function (e) { preview.appendChild(msg('err', e.message)); });
      }), preview, sendBtn, out]));
      showPicked();
    }

    function history() {
      var f = st.filters;
      var fields = { q: input('Search text', { value: f.q || '' }), recipient: input('Recipient', { value: f.recipient || '' }), sender: input('Sender', { value: f.sender || '' }), from: input('From', { type: 'date', value: f.from || '' }), to: input('To', { type: 'date', value: f.to || '' }) };
      var channel = el('select', { 'aria-label': 'Channel' }, [['', 'Any channel'], ['email', 'Email'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      var status = el('select', { 'aria-label': 'Status' }, [['', 'Any status'], ['queued', 'Queued'], ['accepted', 'Accepted by provider'], ['failed', 'Failed'], ['not_sent', 'Not sent'], ['awaiting_approval', 'Waiting for approval'], ['rejected', 'Not approved']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      channel.value = f.channel || ''; status.value = f.status || '';
      var list = el('div');
      function load() {
        st.filters = { q: fields.q.input.value, recipient: fields.recipient.input.value, sender: fields.sender.input.value, from: fields.from.input.value, to: fields.to.input.value, channel: channel.value, status: status.value };
        var qs = Object.keys(st.filters).filter(function (k) { return st.filters[k]; }).map(function (k) {
          var name = k === 'status' && /^(awaiting_approval|rejected)$/.test(st.filters[k]) ? 'messageStatus' : k;   // a message state, not a delivery state
          return name + '=' + encodeURIComponent(st.filters[k]);
        }).join('&');
        api('GET', B + '/notifications/messages?' + qs).then(function (r) {
          list.replaceChildren(el('p', { class: 'note', text: r.total + ' message(s)' }), table(['Message', 'Subject', 'Category', 'Recipient', 'Channel', 'Sender', 'Date', 'Status', 'Attempts', ''], r.items.map(function (x) {
            var s = [x.accepted ? x.accepted + ' accepted' : '', x.delivered ? x.delivered + ' delivered' : '', x.failed ? x.failed + ' failed' : '', x.not_sent ? x.not_sent + ' not sent' : '', x.queued ? x.queued + ' queued' : ''].filter(Boolean).join(' · ');
            return [x.message_no, x.subject || '(template)', x.category + (x.origin === 'workflow' ? ' · automatic' : ''), (x.first_recipient || '—') + (x.recipients > 1 ? ' +' + (x.recipients - 1) : ''), x.channels.replace(/,/g, ', '),
              x.created_by_label || 'system', fmt(x.created_at), x.message_status === 'awaiting_approval' ? 'Waiting for approval' : (x.message_status === 'rejected' ? 'Not approved' : (s || '—')), String(x.attempts) + (x.resend_count ? ' (' + x.resend_count + ' resend' + (x.resend_count > 1 ? 's' : '') + ')' : ''), btn('Open', function () { st.detail = x.id; draw(); })];
          })));
        }).catch(err(list));
      }
      body.appendChild(section('Search', [el('div', { class: 'row' }, [fields.q.node, fields.recipient.node, el('label', {}, ['Channel', channel]), el('label', {}, ['Status', status]), fields.sender.node, fields.from.node, fields.to.node, btn('Apply', load, 'primary')])]));
      body.appendChild(list); load();
    }

    function detail(id) {
      body.appendChild(btn('← Back', function () { st.detail = null; draw(); }));
      api('GET', B + '/notifications/messages/' + id).then(function (d) {
        var m = d.message;
        body.appendChild(section(m.message_no + ' — ' + (m.subject || '(template message)'), [
          el('p', { class: 'note', text: m.category + ' · ' + (m.origin === 'workflow' ? 'automatic (' + (m.ref_type || '') + ')' : 'written by ' + (m.created_by_label || '—')) + ' · ' + fmt(m.created_at) + ' · channels: ' + m.channels.replace(/,/g, ', ') + ' · resent ' + m.resend_count + ' time(s)' }),
          el('div', { class: 'panel', style: 'white-space:pre-wrap' }, [m.body_purged_at ? el('span', { class: 'note', text: 'Message text removed after the retention period.' }) : (m.body_text || '(WhatsApp/SMS template only)')])]));
        var sel = {};
        body.appendChild(section('Recipients', [table(['Resend', 'Name', 'Type', 'Email', 'Mobile'], d.recipients.map(function (r) {
          sel[r.id] = el('input', { type: 'checkbox', 'aria-label': 'Include ' + r.name }); sel[r.id].checked = r.canSend; sel[r.id].disabled = !r.canSend;
          return [sel[r.id], r.name, r.type, r.email || '—', r.mobile || '—'];
        }))]));
        // Resend: always available, even after delivery
        var rkey = uuid(), editBox = el('input', { type: 'checkbox', 'aria-label': 'Edit before sending' }), es = input('Subject', { value: m.subject || '' }), eb = el('textarea', { rows: '5', 'aria-label': 'Message' });
        eb.value = m.body_text || '';
        var ed = el('div', { hidden: 'hidden' }, [es.node, el('label', {}, ['Message', eb]), el('p', { class: 'note', text: 'The original stays unchanged; the edited copy is kept with this send.' })]);
        editBox.addEventListener('change', function () { ed.hidden = !editBox.checked; });
        var rout = el('div');
        function doResend(confirmChanged) {
          rb.disabled = true;
          var ids = Object.keys(sel).filter(function (k) { return sel[k].checked; }).map(Number);
          var b = { requestKey: rkey, recipientIds: ids, confirmChanged: !!confirmChanged };
          if (editBox.checked) b.edit = { subject: es.input.value, body: eb.value };
          if (m.category === 'promotional') b.reason = rreason.input.value;
          api('POST', B + '/notifications/messages/' + m.id + '/resend', b).then(function (r) {
            if (r.awaitingApproval) { rout.replaceChildren(msg('warn', 'Send ' + r.sendNo + ' is waiting for a second person\'s approval (Administration → Approvals). Nothing has been sent yet.')); setTimeout(function () { draw(); }, 1500); return; }
            rout.replaceChildren(msg('ok', 'Send ' + r.sendNo + ' queued: ' + r.queued + ' message(s).' + (r.skipped && r.skipped.length ? ' Skipped: ' + r.skipped.map(function (s) { return s.name + ' (' + s.reason + ')'; }).join(', ') : '') + (r.duplicate ? ' (already sent with this confirmation)' : '')));
            setTimeout(function () { draw(); }, 900);
          }).catch(function (e) {
            if (e.data && e.data.code === 'contact_changed') {
              rout.replaceChildren(msg('warn', e.message), table(['Recipient', 'Before', 'Now'], e.data.changes.map(function (c) { return [c.name, [c.old.email, c.old.mobile].filter(Boolean).join(' · '), [c.new.email, c.new.mobile].filter(Boolean).join(' · ')]; })),
                btn('Send to the current details', function () { doResend(true); }, 'primary'));
            } else rout.replaceChildren(msg('err', e.message));
            rb.disabled = false;
          });
        }
        var rb = btn('Resend now', function () { doResend(false); }, 'primary');
        var rreason = input('Why send this promotion again (needed above ' + (st.meta ? st.meta.limits.promo_approval_over : 100) + ' recipients)');
        if (m.ref_type === 'otp') body.appendChild(section('Resend', [msg('warn', 'One-time codes are never resent: they expire. The salesman asks for a new code from the app.')]));
        else if (m.status === 'awaiting_approval') body.appendChild(section('Resend', [msg('warn', 'Waiting for a second person\'s approval (Administration → Approvals). It can be resent after it has gone out.')]));
        else if (m.status === 'rejected') body.appendChild(section('Resend', [msg('err', 'This promotion was not approved and never went out. Write a new message instead.')]));
        else body.appendChild(section('Resend', [el('p', { class: 'note', text: 'Sends this message again to the ticked recipients, as a new send. Earlier results are kept. One press sends once.' + (m.category === 'promotional' ? ' Consent is checked again for every recipient.' : '') }),
          el('label', { style: 'flex-direction:row;align-items:center;gap:8px' }, [editBox, 'Edit before sending']), ed, m.category === 'promotional' ? rreason.node : el('span'), rb, rout]));
        var AP = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Not approved', withdrawn: 'Withdrawn' };
        body.appendChild(section('Sends', [table(['Send', 'By', 'When', 'Edited', 'Recipients', 'Queued', 'Skipped', 'Approval', 'Note'], d.sends.map(function (s) {
          return ['#' + s.send_no, s.initiated_by_label || 'system', fmt(s.created_at), s.edited ? 'yes' : 'no', String(s.recipient_count), String(s.queued_count), String(s.skipped_count), s.approval ? (AP[s.approval.status] || s.approval.status) : '—', s.reason || '—'];
        }))]));
        var names = {}; d.recipients.forEach(function (r) { names[r.id] = r.name; });
        var sendNo = {}; d.sends.forEach(function (s) { sendNo[s.id] = s.send_no; });
        var hbox = el('div');
        body.appendChild(section('Delivery attempts', [table(['Send', 'Recipient', 'Channel', 'To', 'Status', 'Tries', 'Provider ref', 'Error', ''], d.attempts.map(function (a) {
          return ['#' + (sendNo[a.sendId] || '?'), names[a.recipientId] || '—', a.channel, a.to || '—', nTag(a.status, a.deliveryStatus), a.tries + '/' + a.maxTries, a.providerRef || '—', a.error || '—',
            btn('History', function () { hbox.replaceChildren(section('History of attempt ' + a.id, [table(['When', 'Status', 'Detail', 'Source'], a.history.map(function (h) { return [fmt(h.created_at), N_STATUS[h.status] || h.status, [h.detail, h.provider_ref ? 'ref ' + h.provider_ref : ''].filter(Boolean).join(' · ') || '—', h.source + (h.actor_label ? ' · ' + h.actor_label : '')]; }))])); hbox.scrollIntoView({ behavior: 'smooth' }); })];
        })), hbox]));
      }).catch(err(body));
    }

    function tmpl() {
      api('GET', B + '/notifications/templates').then(function (r) {
        var can = st.meta.canManageTemplates;
        body.appendChild(section('Templates', [el('p', { class: 'note', text: 'WhatsApp business messages need a template approved by Meta; SMS needs a DLT-registered template. Only templates marked approved and active can be chosen when sending.' }),
          table(['Channel', 'Name', 'Category', 'Provider template', 'Language', 'Values', 'Approved at provider', 'Active', ''], r.items.map(function (t) {
            return [t.channel, t.name, t.category, t.provider_template || '—', t.language || '—', t.param_names || '—', Number(t.approved_at_provider) ? 'yes' : 'no', Number(t.active) ? 'yes' : 'no',
              can ? btn(Number(t.approved_at_provider) ? 'Mark not approved' : 'Mark approved', function () { api('PUT', B + '/notifications/templates/' + t.id, { approvedAtProvider: !Number(t.approved_at_provider) }).then(function () { draw(); }).catch(err(body)); }) : ''];
          }))]));
        if (!can) return;
        var ch = el('select', { 'aria-label': 'Channel' }, ['whatsapp', 'sms', 'email'].map(function (c) { return el('option', { value: c, text: c }); }));
        var cat = el('select', { 'aria-label': 'Category' }, ['transactional', 'service', 'authentication', 'promotional'].map(function (c) { return el('option', { value: c, text: c }); }));
        var f = { name: input('Name (e.g. order_update)'), prov: input('Meta template name / DLT id'), lang: input('Language', { value: 'en_US' }), params: input('Values, in order (comma separated)'), sample: input('Sample text') };
        var ok = el('input', { type: 'checkbox', 'aria-label': 'Approved at provider' }), out = el('div');
        body.appendChild(section('Add a template', [el('div', { class: 'row' }, [el('label', {}, ['Channel', ch]), el('label', {}, ['Category', cat]), f.name.node, f.prov.node, f.lang.node, f.params.node, f.sample.node,
          el('label', { style: 'flex-direction:row;align-items:center;gap:8px' }, [ok, 'Approved at provider'])]),
          btn('Save template', function () {
            api('POST', B + '/notifications/templates', { channel: ch.value, category: cat.value, name: f.name.input.value, providerTemplate: f.prov.input.value, language: f.lang.input.value, paramNames: f.params.input.value, sampleText: f.sample.input.value, approvedAtProvider: ok.checked })
              .then(function () { api('GET', B + '/notifications/meta').then(function (m) { st.meta = m; draw(); }); }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
          }, 'primary'), out]));
      }).catch(err(body));
    }

    function consent() {
      var m = st.meta;
      var STATE = { opted_in: 'Agreed', opted_out: 'Stopped' };
      var SRC = { portal: 'Business portal', admin_written: 'Written / signed form', admin_call: 'Phone call', admin_email: 'Email from them', admin_meeting: 'In person',
        unsubscribe_link: 'Unsubscribe link', whatsapp_reply: 'WhatsApp reply', provider_report: 'Provider report' };
      // 1. record a preference (opt-in needs evidence; opt-outs are always accepted)
      if (m.canManageConsent && m.recipientTypes.length) {
        var type = el('select', { 'aria-label': 'Recipient type' }, m.recipientTypes.map(function (t) { return el('option', { value: t, text: t.charAt(0).toUpperCase() + t.slice(1) + 's' }); }));
        var q = input('Name, email or mobile'), found = el('div'), chosen = el('div');
        var pick = function (p) {
          chosen.replaceChildren(el('p', { class: 'note', text: 'Loading…' }));
          api('GET', B + '/notifications/consent/recipient?type=' + p.type + '&ref=' + p.ref).then(function (r) {
            var ch = el('select', { 'aria-label': 'Channel' }, [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
            var what = el('select', { 'aria-label': 'Preference' }, [['promotional:opted_in', 'Agreed to receive offers'], ['promotional:opted_out', 'Does not want offers'], ['all:opted_out', 'Stop ALL messages on this channel'], ['all:opted_in', 'Resume all messages']]
              .filter(function (o) { return o[0] !== 'promotional:opted_in' || p.type === 'retailer' || p.type === 'distributor'; }).map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
            var src = el('select', { 'aria-label': 'How they told us' }, ['admin_written', 'admin_call', 'admin_email', 'admin_meeting'].map(function (k) { return el('option', { value: k, text: SRC[k] }); }));
            var note = input('How and when they said so (needed for consent)'), res = el('div');
            var save = btn('Record', function () {
              var w = what.value.split(':'); save.disabled = true;
              api('POST', B + '/notifications/consent', { recipient: { type: p.type, ref: p.ref }, channel: ch.value, scope: w[0], state: w[1], source: src.value, note: note.input.value })
                .then(function (x) { res.replaceChildren(msg('ok', x.changed ? 'Recorded.' : 'Already recorded that way.')); setTimeout(function () { pick(p); loadList(); }, 700); })
                .catch(function (e) { save.disabled = false; res.replaceChildren(msg('err', e.message)); });
            }, 'primary');
            chosen.replaceChildren(el('h3', { text: r.name }), table(['Channel', 'Address on file', 'Offers', 'All messages'], r.items.map(function (x) {
              return [x.channel, x.hasAddress ? (x.channel === 'email' ? (p.email || 'yes') : (p.mobile || 'yes')) : 'none', x.promotional ? STATE[x.promotional] : 'Not asked', x.all === 'opted_out' ? 'Stopped' : 'Allowed'];
            })), el('div', { class: 'row' }, [el('label', {}, ['Channel', ch]), el('label', {}, ['Preference', what]), el('label', {}, ['How they told us', src])]), note.node,
            el('p', { class: 'note', text: 'Consent to offers is recorded only for retailers and distributors, and only with how it was given. "Stop all" also stops order and account messages on that channel (sign-in codes still go).' }), save, res);
          }).catch(err(chosen));
        };
        var search = function () {
          api('GET', B + '/notifications/recipients?type=' + type.value + '&q=' + encodeURIComponent(q.input.value)).then(function (r) {
            found.replaceChildren(table(['', 'Name', 'Email', 'Mobile'], r.items.map(function (p) { return [btn('Choose', function () { pick(p); }), p.name, p.email || '—', p.mobile || '—']; })));
          }).catch(err(found));
        };
        body.appendChild(section('Record consent or an opt-out', [el('div', { class: 'row' }, [el('label', {}, ['Type', type]), q.node, btn('Search', search)]), found, chosen]));
      }
      // 2. recorded preferences
      var fCh = el('select', { 'aria-label': 'Channel filter' }, [['', 'Any channel'], ['email', 'Email'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      var fSt = el('select', { 'aria-label': 'State filter' }, [['', 'Agreed or stopped'], ['opted_in', 'Agreed'], ['opted_out', 'Stopped']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      var listBox = el('div');
      function loadList() {
        api('GET', B + '/notifications/consent?channel=' + fCh.value + '&state=' + fSt.value).then(function (r) {
          listBox.replaceChildren(r.items.length ? table(['Who', 'Channel', 'Applies to', 'State', 'Source', 'Recorded by', 'When'], r.items.map(function (x) {
            return [x.recipient ? x.recipient.name + ' (' + x.recipient.type + ')' : '(address only — from a link or reply)', x.channel, x.scope === 'all' ? 'All messages' : 'Offers', STATE[x.state], SRC[x.source] || x.source, x.recordedBy || '—', fmt(x.updatedAt)];
          })) : el('p', { class: 'note', text: 'Nothing recorded yet. Offers go only to people listed here as Agreed.' }));
        }).catch(err(listBox));
      }
      body.appendChild(section('Recorded preferences', [el('div', { class: 'row' }, [el('label', {}, ['Channel', fCh]), el('label', {}, ['State', fSt]), btn('Apply', loadList)]), listBox]));
      loadList();
      // 3. recipient groups
      var gBox = el('div'), gOut = el('div');
      function loadGroups() {
        api('GET', B + '/notifications/groups').then(function (r) {
          gBox.replaceChildren(r.items.length ? table(['Group', 'Kind', 'Recipients now', 'Types', 'Status', ''], r.items.map(function (g) {
            return [g.name, g.kind === 'rule' ? 'Rule (evaluated at send time)' : 'Fixed list', String(g.size), g.types.join(', '), g.active ? 'On' : 'Off',
              g.mayEdit ? btn(g.active ? 'Switch off' : 'Switch on', function () {
                api('PUT', B + '/notifications/groups/' + g.id, { active: !g.active }).then(loadGroups).catch(function (e) { gOut.replaceChildren(msg('err', e.message)); });
              }) : el('span', { class: 'note', text: 'not yours to change' })];
          })) : el('p', { class: 'note', text: 'No groups yet.' }));
        }).catch(err(gBox));
      }
      if (m.recipientTypes.length) {
        var gName = input('Group name'), gType = el('select', { 'aria-label': 'Rule type' }, m.recipientTypes.map(function (t) { return el('option', { value: t, text: 'All active ' + t + 's' }); }));
        var mk = function (b) { gOut.replaceChildren(); api('POST', B + '/notifications/groups', b).then(function () { gOut.replaceChildren(msg('ok', 'Group saved.')); loadGroups(); }).catch(function (e) { gOut.replaceChildren(msg('err', e.message)); }); };
        body.appendChild(section('Recipient groups', [gBox, el('div', { class: 'row' }, [gName.node, btn('Save the ' + st.picked.length + ' recipient(s) picked in Compose', function () {
          mk({ name: gName.input.value, kind: 'list', members: st.picked.map(function (p) { return { type: p.type, ref: p.ref }; }) });
        }), el('label', {}, ['or a rule', gType]), btn('Save rule', function () { mk({ name: gName.input.value, kind: 'rule', rule: { type: gType.value } }); })]),
          el('p', { class: 'note', text: 'A rule group is worked out when you send, so new accounts are included. Rules by state or district can be set through the API (see the notifications API document).' }), gOut]));
      } else body.appendChild(section('Recipient groups', [gBox]));
      loadGroups();
      // 4. promotions waiting for approval
      var wBox = el('div');
      api('GET', B + '/notifications/messages?messageStatus=awaiting_approval').then(function (r) {
        wBox.replaceChildren(r.items.length ? table(['Message', 'Subject', 'Recipients', 'Written by', ''], r.items.map(function (x) { return [x.message_no, x.subject || '(template)', String(x.recipients), x.created_by_label || '—', btn('Open', function () { st.detail = x.id; draw(); })]; }))
          : el('p', { class: 'note', text: 'None waiting.' }));
      }).catch(err(wBox));
      body.appendChild(section('Promotions waiting for approval', [el('p', { class: 'note', text: 'Approved or rejected under Administration → Approvals by someone other than the writer, with two-factor sign-in.' }), wBox]));
    }
  }

  window.ERP_VIEWS.push(
    { id: 'pricing', label: 'Price lists', perm: 'catalog.pricing.view', render: pricing },
    { id: 'products', label: 'Products', perm: 'catalog.products.view', render: products },
    { id: 'vendors', label: 'Vendors', perm: 'vendors.view', render: vendors },
    { id: 'purchasing', label: 'Purchasing', perm: 'procurement.pr.view', render: purchasing },
    { id: 'receiving', label: 'Goods receipt', perm: 'warehouse.grn.create', render: receiving },
    { id: 'bills', label: 'Supplier bills', perm: 'finance.payables.view', render: bills },
    { id: 'stock', label: 'Stock & batches', perm: 'inventory.view', render: stock },
    { id: 'network', label: 'Network map', perm: 'network.map.view', render: network },
    { id: 'recalls', label: 'Recalls', perm: 'recalls.view', render: recalls },
    { id: 'finance', label: 'Finance', perm: 'finance.reports.view', render: finance },
    { id: 'collections', label: 'Collections', perm: 'sales.collections.confirm', render: collections },
    { id: 'salesdesk', label: 'Sales desk', perm: 'sales.reports.view', render: salesDesk },
    { id: 'notifications', label: 'Notifications', perm: 'notifications.view', render: notifications }
  );
})();
