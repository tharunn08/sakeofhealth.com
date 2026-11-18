(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-pricing', 'Pricing & Margins', ['b2b.pricing.view']))) return;
  var content = document.getElementById('content');
  var canEdit = B.can('b2b.pricing.edit');
  var state = { tab: new URLSearchParams(location.search).get('tab') || 'margins', cats: [], settings: {}, scope: '', audience: '', q: '', page: 1 };

  function shell() {
    document.getElementById('topbarActions').innerHTML = state.tab === 'rules' && canEdit ? '<button class="btn btn-primary btn-sm" id="addRule">' + A.icon('plus') + 'Add pricing rule</button>' : '';
    if (B.$('#addRule')) B.$('#addRule').addEventListener('click', function () { ruleForm(null); });
    content.innerHTML = B.tabsHtml([{ id: 'margins', label: 'Margins' }, { id: 'bulk', label: 'Bulk update' }, { id: 'rules', label: 'Pricing rules' }, { id: 'simulate', label: 'Price check' }], state.tab) + '<div id="pane"></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; state.page = 1; shell(); }); });
    ({ margins: margins, bulk: bulk, rules: rules, simulate: simulate })[state.tab](B.$('#pane'));
  }

  /* ═════ Margins ═════ */
  function margins(pane) {
    var s = state.settings, dis = canEdit ? '' : ' disabled';
    pane.innerHTML = '<div class="grid-2"><div class="card"><div class="card-head"><h2>Default B2B margins</h2></div><div class="card-body">' +
      '<div class="field-row">' + B.field('dm', 'Default distributor margin %', B.input('dm', Number(s['pricing.default_distributor_margin']), 'inputmode="decimal"' + dis)) +
      B.field('rm', 'Default retailer margin %', B.input('rm', Number(s['pricing.default_retailer_margin']), 'inputmode="decimal"' + dis)) + '</div>' +
      B.field('mode', 'How a margin becomes a price', B.select('mode', [
        { value: 'markup_on_base', label: 'Mark-up on base price — price = base × (1 + margin%)' },
        { value: 'off_mrp', label: 'Off MRP — price = MRP (ex-GST) × (1 − margin%)' }], s['pricing.margin_mode'], dis),
        'Applies to every margin: default, category, product and customer-specific.') +
      '<div class="info-box mb-16" id="example"></div>' +
      (canEdit ? '<button class="btn btn-primary" id="saveMargins">Save margins</button>' : '<div class="td-muted">You can view margins but not change them.</div>') +
      '</div></div>' +
      '<div class="card"><div class="card-head"><h2>Which price wins</h2></div><div class="card-body"><div class="stepper">' +
      [['Customer-specific price', 'A rule for one retailer/distributor and one product.'], ['Retailer / distributor override', 'A rule for one account across all products.'],
        ['Product pricing', 'A product rule, else the product’s own fixed price or margin.'], ['Category pricing', 'A category rule (sub-category beats category).'],
        ['Default B2B margin', 'The two percentages on this page.']].map(function (r, i) {
        return '<div class="step done"><div class="step-dot" style="font-size:11px;font-weight:700;color:#fff">' + (i + 1) + '</div><div class="step-content"><strong>' + r[0] + '</strong><span>' + r[1] + '</span></div></div>'; }).join('') +
      '</div><p class="td-muted" style="margin-top:14px;line-height:1.6">The first level that has a price is used. Quantity slabs pick the highest slab the order reaches. Then a volume discount (if any) is applied, and a promotion replaces the price only when it is lower. ' +
      'Prices are always calculated on the server and exclude GST.</p></div></div></div>' +
      '<div class="card"><div class="card-head"><h2>Category margins</h2><div class="spacer"></div>' + (canEdit ? '<button class="btn btn-ghost btn-sm" id="addCatMargin">' + A.icon('plus') + 'Set a category margin</button>' : '') + '</div>' +
      '<div class="card-body tight" id="catHost">' + A.loadingState() + '</div></div>';

    var example = function () {
      var d = Number(B.val('dm')) || 0, r = Number(B.val('rm')) || 0, mode = B.val('mode');
      var base = 250, mrp = 499, ex = mrp / 1.18;
      var dp = mode === 'off_mrp' ? ex * (1 - d / 100) : base * (1 + d / 100), rp = mode === 'off_mrp' ? ex * (1 - r / 100) : base * (1 + r / 100);
      B.$('#example').innerHTML = '<strong>Example</strong>Base ₹250 · MRP ₹499 · GST 18%<br/>Distributor pays <b>' + B.money(dp) + '</b> · Retailer pays <b>' + B.money(rp) + '</b> (before GST)';
    };
    ['dm', 'rm', 'mode'].forEach(function (id) { B.$('#' + id).addEventListener('input', example); });
    example();
    if (B.$('#saveMargins')) B.$('#saveMargins').addEventListener('click', async function () {
      try {
        var r = await B.api.put('/settings', { 'pricing.default_distributor_margin': B.val('dm'), 'pricing.default_retailer_margin': B.val('rm'), 'pricing.margin_mode': B.val('mode') });
        A.toast(r.changed.length ? 'Margins saved — new prices apply immediately' : 'No changes', 'success');
        state.settings = (await B.api.get('/settings')).settings;
      } catch (e) { A.toast(e.message, 'error'); }
    });
    if (B.$('#addCatMargin')) B.$('#addCatMargin').addEventListener('click', function () { ruleForm({ scope: 'category', rule_type: 'margin_pct' }); });
    B.api.get('/pricing/rules?scope=category&active=1&limit=100').then(function (d) {
      B.$('#catHost').innerHTML = B.table(ruleCols(), d.items, { icon: 'tag', emptyTitle: 'No category margins', emptyText: 'Every category uses the default margins above.' });
      wireRules(B.$('#catHost'), d.items);
    }).catch(function (e) { B.fail(B.$('#catHost'), e); });
  }

  /* ═════ Bulk update ═════ */
  function bulk(pane) {
    if (!canEdit) { pane.innerHTML = '<div class="alert alert-warn">' + A.icon('alert') + '<span>Bulk margin updates need pricing-edit permission.</span></div>'; return; }
    pane.innerHTML = '<div class="steps"><div class="s on" id="s1"><b>Step 1</b>Select products</div><div class="s" id="s2"><b>Step 2</b>Set margins</div><div class="s" id="s3"><b>Step 3</b>Preview</div><div class="s" id="s4"><b>Step 4</b>Confirm & apply</div></div>' +
      '<div class="card"><div class="card-body"><div class="form-grid">' +
      B.field('bCat', 'Category', B.select('bCat', [{ value: '', label: 'Any category' }].concat(flatCats()), '')) +
      B.field('bQ', 'SKU / name contains', B.input('bQ', '', 'placeholder="e.g. GUM"')) +
      B.field('bSkus', 'Or paste SKUs (one per line or comma separated)', '<textarea class="textarea" id="bSkus" placeholder="GUM001, GUM002…"></textarea>', 'When SKUs are given, the filters above are ignored.', 'wide') +
      '<div class="field wide"><label class="checkbox"><input type="checkbox" id="bAll"/><span>Apply to <strong>all active products</strong> (only when no filter or SKU is given)</span></label></div>' +
      B.field('bD', 'Distributor margin %', B.input('bD', '', 'inputmode="decimal" placeholder="leave blank to keep"')) +
      B.field('bR', 'Retailer margin %', B.input('bR', '', 'inputmode="decimal" placeholder="leave blank to keep"')) +
      '<div class="field wide"><label class="checkbox"><input type="checkbox" id="bClear"/><span>Also clear fixed distributor/retailer prices on these products (a fixed price overrides its margin)</span></label></div>' +
      '</div><button class="btn btn-primary" id="bPreview">Preview changes</button></div></div><div id="bOut"></div>';

    async function selection() {
      var skus = B.val('bSkus').split(/[\s,;]+/).filter(Boolean);
      if (skus.length) return { skus: skus };
      return { category_id: B.val('bCat'), q: B.val('bQ'), all: B.val('bAll') };
    }
    B.$('#bPreview').addEventListener('click', async function () {
      var out = B.$('#bOut'); out.innerHTML = A.loadingState();
      try {
        var payload = { selection: await selection(), distributor_margin: B.val('bD'), retailer_margin: B.val('bR'), clear_fixed_prices: B.val('bClear') };
        var pv = await B.api.post('/pricing/bulk/preview', payload);
        ['s1', 's2'].forEach(function (id) { B.$('#' + id).className = 's done'; }); B.$('#s3').className = 's on';
        var blocked = pv.sample.filter(function (r) { return r.fixedPriceBlocks; }).length;
        out.innerHTML = '<div class="card"><div class="card-head"><h2>Preview — ' + A.fmt.num(pv.count) + ' product' + (pv.count === 1 ? '' : 's') + ' will change</h2></div><div class="card-body tight">' +
          B.table([
            { label: 'Product', html: function (r) { return '<span class="td-mono">' + esc(r.sku) + '</span><div class="td-muted">' + esc(r.name) + '</div>'; } },
            { label: 'Base', cls: 'num', html: function (r) { return B.money(r.base_price); } },
            { label: 'Distributor margin', cls: 'num', html: function (r) { return change(r.distributor.oldMargin, r.distributor.newMargin, '%'); } },
            { label: 'Distributor price', cls: 'num', html: function (r) { return change(r.distributor.oldPrice, r.distributor.newPrice, '₹'); } },
            { label: 'Retailer margin', cls: 'num', html: function (r) { return change(r.retailer.oldMargin, r.retailer.newMargin, '%'); } },
            { label: 'Retailer price', cls: 'num', html: function (r) { return change(r.retailer.oldPrice, r.retailer.newPrice, '₹'); } },
          ], pv.sample) + '</div><div class="card-body">' +
          (pv.count > pv.sample.length ? '<p class="td-muted mb-16">Showing the first ' + pv.sample.length + ' of ' + A.fmt.num(pv.count) + '.</p>' : '') +
          (pv.missingSkus && pv.missingSkus.length ? '<div class="alert alert-error">' + A.icon('alert') + '<span>These SKUs were not found and will be skipped: ' + esc(pv.missingSkus.join(', ')) + '</span></div>' : '') +
          (blocked ? '<div class="alert alert-warn">' + A.icon('alert') + '<span>' + blocked + ' product(s) shown have a fixed price, so their price will not move unless you tick “clear fixed prices”.</span></div>' : '') +
          '<label class="checkbox mb-16"><input type="checkbox" id="bConfirm"/><span>I have checked the preview and want to update <strong>' + A.fmt.num(pv.count) + '</strong> product(s).</span></label><br/>' +
          '<button class="btn btn-primary" id="bApply" disabled>Apply to ' + A.fmt.num(pv.count) + ' products</button></div></div>';
        B.$('#bConfirm').addEventListener('change', function () { B.$('#bApply').disabled = !B.$('#bConfirm').checked; B.$('#s3').className = 's done'; B.$('#s4').className = 's on'; });
        B.$('#bApply').addEventListener('click', async function () {
          B.$('#bApply').disabled = true;
          try {
            var r = await B.api.post('/pricing/bulk/apply', Object.assign({ confirm: true }, payload));
            out.innerHTML = '<div class="alert alert-success">' + A.icon('check') + '<span><strong>' + A.fmt.num(r.updated) + ' products updated.</strong> The previous margin of every product was saved in the audit log.</span></div>';
            B.$('#s4').className = 's done';
          } catch (e) { A.toast(e.message, 'error'); B.$('#bApply').disabled = false; }
        });
      } catch (e) { out.innerHTML = B.errorBox(e); }
    });
  }
  function change(a, b, unit) {
    var f = function (v) { return v == null || v === '' ? 'default' : (unit === '₹' ? B.money(v) : Number(v) + '%'); };
    return String(a) === String(b) || (a != null && b != null && Number(a) === Number(b)) ? '<span class="muted">' + f(a) + '</span>' : '<span class="muted"><s>' + f(a) + '</s></span> → <strong>' + f(b) + '</strong>';
  }
  function flatCats() { var o = []; state.cats.forEach(function (c) { o.push({ value: c.id, label: c.name }); (c.children || []).forEach(function (s) { o.push({ value: s.id, label: c.name + ' › ' + s.name }); }); }); return o; }

  /* ═════ Rules ═════ */
  function ruleCols() {
    return [
      { label: 'Applies to', html: function (r) { return '<div class="td-strong">' + esc(B.label(r.scope)) + '</div><div class="td-muted">' + esc([r.account_name, r.sku ? r.sku + ' ' + r.product_name : '', r.category_name].filter(Boolean).join(' · ') || 'All products') + '</div>'; } },
      { label: 'For', html: function (r) { return B.badge(r.audience, 'no-dot'); } },
      { label: 'Rule', html: function (r) { return esc(B.label(r.rule_type)) + ': <strong>' + (r.rule_type === 'fixed_price' ? B.money(r.value) : Number(r.value) + '%') + '</strong>' + (Number(r.is_promo) ? ' <span class="badge badge-flag no-dot">Promo' + (r.label ? ': ' + esc(r.label) : '') + '</span>' : ''); } },
      { label: 'From qty', cls: 'num', html: function (r) { return esc(r.min_qty); } },
      { label: 'Valid', cls: 'hide-sm td-muted', html: function (r) { return (r.starts_at ? esc(B.date(r.starts_at)) : 'now') + ' → ' + (r.ends_at ? esc(B.date(r.ends_at)) : 'open'); } },
      { label: 'Status', html: function (r) { var expired = r.ends_at && new Date(r.ends_at) < new Date(); return B.badge(!Number(r.is_active) ? 'inactive' : expired ? 'ended' : 'active'); } },
      { label: '', html: function (r) { return canEdit && Number(r.is_active) ? '<button class="btn btn-ghost btn-sm" data-redit="' + r.id + '">Edit</button> <button class="btn btn-danger-ghost btn-sm" data-roff="' + r.id + '">Retire</button>' : ''; } },
    ];
  }
  function wireRules(host, items) {
    host.querySelectorAll('[data-redit]').forEach(function (b) { b.addEventListener('click', function () { ruleForm(items.filter(function (r) { return String(r.id) === b.dataset.redit; })[0]); }); });
    host.querySelectorAll('[data-roff]').forEach(function (b) { b.addEventListener('click', async function () {
      if (!confirm('Retire this pricing rule? Prices fall back to the next level immediately.')) return;
      try { await B.api.del('/pricing/rules/' + b.dataset.roff); A.toast('Rule retired', 'success'); shell(); } catch (e) { A.toast(e.message, 'error'); } }); });
  }
  function rules(pane) {
    pane.innerHTML = '<div class="b2b-filters"><div class="search-box">' + A.icon('search') + '<input class="input" id="rq" placeholder="Search SKU, product, account, label…" value="' + esc(state.q) + '"/></div>' +
      B.select('rScope', [{ value: '', label: 'All levels' }, 'account_product', 'account', 'product', 'category', 'default'], state.scope) +
      B.select('rAud', [{ value: '', label: 'Retailer + distributor' }, 'retailer', 'distributor'], state.audience) + '</div><div class="card"><div class="card-body tight" id="rHost">' + A.loadingState() + '</div></div>';
    var load = async function () {
      try {
        var d = await B.api.get('/pricing/rules' + B.qs({ q: state.q, scope: state.scope, audience: state.audience, page: state.page, limit: 25 }));
        B.$('#rHost').innerHTML = B.table(ruleCols(), d.items, { icon: 'tag', emptyTitle: 'No pricing rules', emptyText: 'Everything is priced from product and default margins.' }) + B.pager(d, 'rules');
        wireRules(B.$('#rHost'), d.items);
        B.$$('#rHost [data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); load(); }); });
      } catch (e) { B.fail(B.$('#rHost'), e); }
    };
    B.$('#rq').addEventListener('input', B.debounce(function () { state.q = B.$('#rq').value.trim(); state.page = 1; load(); }));
    B.$('#rScope').addEventListener('change', function () { state.scope = B.$('#rScope').value; state.page = 1; load(); });
    B.$('#rAud').addEventListener('change', function () { state.audience = B.$('#rAud').value; state.page = 1; load(); });
    load();
  }

  /** Small "type to find" picker used for products and accounts. */
  function picker(id, labelText, kind, current) {
    return B.field(id + '_q', labelText, '<input class="input" id="' + id + '_q" autocomplete="off" placeholder="Type to search…" value="' + esc(current ? current.label : '') + '"/><input type="hidden" id="' + id + '" value="' + esc(current ? current.id : '') + '"/><div id="' + id + '_res" class="chips" style="margin-top:6px"></div>');
  }
  function wirePicker(id, kind, audience) {
    var q = B.$('#' + id + '_q'), res = B.$('#' + id + '_res'), hidden = B.$('#' + id);
    if (!q) return;
    q.addEventListener('input', B.debounce(async function () {
      hidden.value = '';
      if (q.value.trim().length < 2) { res.innerHTML = ''; return; }
      try {
        var items = kind === 'product' ? (await B.api.get('/products?limit=6&q=' + encodeURIComponent(q.value.trim()))).items.map(function (p) { return { id: p.id, label: p.sku + ' — ' + p.name }; })
          : (await B.api.get('/accounts?limit=6&status=approved&type=' + audience() + '&q=' + encodeURIComponent(q.value.trim()))).items.map(function (a) { return { id: a.id, label: a.business_name + ' (' + a.city + ')' }; });
        res.innerHTML = items.length ? items.map(function (i) { return '<button type="button" class="chip" data-pick="' + i.id + '" data-label="' + esc(i.label) + '" style="cursor:pointer">' + esc(i.label) + '</button>'; }).join('') : '<span class="muted small">No match</span>';
        res.querySelectorAll('[data-pick]').forEach(function (b) { b.addEventListener('click', function () { hidden.value = b.dataset.pick; q.value = b.dataset.label; res.innerHTML = ''; }); });
      } catch (e) { res.innerHTML = '<span class="muted small">' + esc(e.message) + '</span>'; }
    }, 250));
  }
  function ruleForm(r) {
    var isNew = !r || !r.id; r = r || {};
    var toLocal = function (d) { return d ? new Date(new Date(d).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; };
    B.modal({ title: isNew ? 'Add pricing rule' : 'Edit pricing rule', wide: true, submit: isNew ? 'Create rule' : 'Save rule', body: '<div class="form-grid">' +
      B.field('p_scope', 'Level', B.select('p_scope', [{ value: 'account_product', label: 'Customer-specific price (one account, one product)' }, { value: 'account', label: 'Account override (one account, all products)' },
        { value: 'product', label: 'Product (slab / promo for one product)' }, { value: 'category', label: 'Category' }, { value: 'default', label: 'Default (all products)' }], r.scope || 'product')) +
      B.field('p_audience', 'Buyer type', B.select('p_audience', ['retailer', 'distributor'], r.audience || 'retailer')) +
      '<div id="p_accWrap" class="wide">' + picker('p_account_id', 'Retailer / distributor', 'account', r.account_id ? { id: r.account_id, label: r.account_name } : null) + '</div>' +
      '<div id="p_prodWrap" class="wide">' + picker('p_product_id', 'Product', 'product', r.product_id ? { id: r.product_id, label: r.sku + ' — ' + r.product_name } : null) + '</div>' +
      '<div id="p_catWrap" class="wide">' + B.field('p_category_id', 'Category', B.select('p_category_id', flatCats(), r.category_id)) + '</div>' +
      B.field('p_rule_type', 'Rule', B.select('p_rule_type', [{ value: 'margin_pct', label: 'Margin %' }, { value: 'fixed_price', label: 'Fixed price (₹, ex-GST)' }, { value: 'discount_pct', label: 'Volume discount %' }], r.rule_type || 'margin_pct')) +
      B.field('p_value', 'Value', B.input('p_value', r.value == null ? '' : Number(r.value), 'inputmode="decimal"')) +
      B.field('p_min_qty', 'From quantity', B.input('p_min_qty', r.min_qty || 1, 'inputmode="numeric"'), '1 = always. Higher = quantity slab.') +
      B.field('p_label', 'Label (shown for promotions)', B.input('p_label', r.label, 'maxlength="120"')) +
      B.field('p_starts_at', 'Starts', B.input('p_starts_at', toLocal(r.starts_at), 'type="datetime-local"'), 'Blank = immediately') +
      B.field('p_ends_at', 'Ends', B.input('p_ends_at', toLocal(r.ends_at), 'type="datetime-local"'), 'Blank = no end') +
      '<div class="field wide"><label class="checkbox"><input type="checkbox" id="p_is_promo"' + (Number(r.is_promo) ? ' checked' : '') + '/><span>This is a promotion (needs an end date; only applies when it lowers the price)</span></label></div></div>',
      onSubmit: async function () {
        var b = {};
        ['scope', 'audience', 'account_id', 'product_id', 'category_id', 'rule_type', 'value', 'min_qty', 'label', 'is_promo'].forEach(function (k) { b[k] = B.val('p_' + k); });
        ['starts_at', 'ends_at'].forEach(function (k) { var v = B.val('p_' + k); b[k] = v ? new Date(v).toISOString() : ''; });
        if (isNew) await B.api.post('/pricing/rules', b); else await B.api.patch('/pricing/rules/' + r.id, b);
        A.toast('Pricing rule saved', 'success'); shell();
      } });
    var sync = function () {
      var s = B.val('p_scope');
      B.$('#p_accWrap').style.display = s === 'account_product' || s === 'account' ? '' : 'none';
      B.$('#p_prodWrap').style.display = s === 'account_product' || s === 'product' ? '' : 'none';
      B.$('#p_catWrap').style.display = s === 'category' ? '' : 'none';
    };
    B.$('#p_scope').addEventListener('change', sync); sync();
    wirePicker('p_account_id', 'account', function () { return B.val('p_audience'); });
    wirePicker('p_product_id', 'product');
  }

  /* ═════ Price check ═════ */
  function simulate(pane) {
    pane.innerHTML = '<div class="card"><div class="card-head"><h2>What will this buyer pay — and why?</h2></div><div class="card-body"><div class="form-grid">' +
      picker('x_product', 'Product', 'product') + picker('x_account', 'Buyer (optional)', 'account') +
      B.field('x_aud', 'Buyer type', B.select('x_aud', ['retailer', 'distributor'], 'retailer'), 'Used when no buyer is chosen, and to search buyers.') +
      B.field('x_qty', 'Quantity', B.input('x_qty', 1, 'inputmode="numeric"')) + '</div><button class="btn btn-primary" id="xGo">Check price</button><div id="xOut" style="margin-top:18px"></div></div></div>';
    wirePicker('x_product', 'product'); wirePicker('x_account', 'account', function () { return B.val('x_aud'); });
    B.$('#xGo').addEventListener('click', async function () {
      var out = B.$('#xOut');
      if (!B.val('x_product')) { out.innerHTML = B.errorBox({ message: 'Choose a product from the search results.' }); return; }
      try {
        var r = await B.api.get('/pricing/simulate' + B.qs({ product_id: B.val('x_product'), account_id: B.val('x_account'), audience: B.val('x_aud'), qty: B.val('x_qty') || 1 }));
        out.innerHTML = '<div class="stat-grid"><div class="stat"><div class="stat-label">Unit price (ex-GST)</div><div class="stat-value">' + B.money(r.unitPrice) + '</div><div class="stat-sub">' + esc(B.label(r.source)) + '</div></div>' +
          '<div class="stat blue"><div class="stat-label">With ' + Number(r.gstRate) + '% GST</div><div class="stat-value">' + B.money(Number(r.unitPrice) * (1 + Number(r.gstRate) / 100)) + '</div><div class="stat-sub">MRP ' + B.money(r.mrp) + '</div></div>' +
          '<div class="stat ' + (r.belowCost ? 'red' : 'teal') + '"><div class="stat-label">Margin over base</div><div class="stat-value">' + (r.marginPct == null ? '—' : r.marginPct + '%') + '</div><div class="stat-sub">Base ' + B.money(r.basePrice) + (r.belowCost ? ' · BELOW COST' : '') + '</div></div></div>' +
          '<div class="info-box"><strong>How this price was reached</strong>' + r.trace.map(function (t, i) { return (i + 1) + '. ' + esc(t); }).join('<br/>') + '</div>' +
          (r.slabs.length ? '<div class="chips" style="margin-top:12px">' + r.slabs.map(function (s) { return '<span class="chip">' + s.minQty + '+ units: ' + B.money(s.unitPrice) + '</span>'; }).join('') + '</div>' : '');
      } catch (e) { out.innerHTML = B.errorBox(e); }
    });
  }

  try {
    state.settings = (await B.api.get('/settings')).settings;
    state.cats = (await B.api.get('/categories')).categories;
  } catch (e) { B.fail(content, e); return; }
  shell();
})();
