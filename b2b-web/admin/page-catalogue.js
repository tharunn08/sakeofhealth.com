(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-catalogue', 'B2B Catalogue', ['b2b.catalogue.view']))) return;
  var content = document.getElementById('content');
  var params = new URLSearchParams(location.search);
  var state = { tab: params.get('tab') || 'products', q: '', category_id: '', active: '', channel: '', page: 1, cats: [] };
  var canEdit = B.can('b2b.catalogue.edit'), canPrice = B.can('b2b.pricing.edit'), seePrice = B.can('b2b.pricing.view');
  var GST = [0, 5, 12, 18, 28, 40];

  function topbar() {
    document.getElementById('topbarActions').innerHTML = state.tab === 'products'
      ? (seePrice ? '<button class="btn btn-ghost btn-sm" id="expBtn">' + A.icon('download') + '<span class="hide-sm">Export</span></button>' : '') +
        (canEdit ? '<button class="btn btn-ghost btn-sm" id="syncBtn" title="Copy products from the customer storefront by SKU">' + A.icon('refresh') + '<span class="hide-sm">Sync from store</span></button>' +
          '<a class="btn btn-ghost btn-sm" href="import.html">' + A.icon('upload') + '<span class="hide-sm">Excel import</span></a>' +
          '<button class="btn btn-primary btn-sm" id="addBtn">' + A.icon('plus') + 'Add product</button>' : '')
      : (canEdit ? '<button class="btn btn-primary btn-sm" id="addCat">' + A.icon('plus') + 'Add category</button>' : '');
    var on = function (id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('addBtn', function () { edit(null); });
    on('addCat', function () { editCat(null); });
    on('expBtn', function () { B.download('/export/products?format=xlsx').catch(function (e) { A.toast(e.message, 'error'); }); });
    on('syncBtn', async function () {
      if (!confirm('Copy products from the customer storefront into the product master?\n\nOnly missing SKUs are added. Storefront prices are not used for trade pricing, and nothing on the storefront changes.')) return;
      try { var r = await B.api.post('/products/sync-b2c'); A.toast(r.created + ' added, ' + r.linked + ' linked, ' + r.skipped + ' skipped', 'success'); if (r.note) alert(r.note); load(); }
      catch (e) { A.toast(e.message, 'error'); }
    });
  }

  function catOptions(includeAll) {
    var out = includeAll ? [{ value: '', label: 'All categories' }] : [{ value: '', label: '— None —' }];
    state.cats.forEach(function (c) { out.push({ value: c.id, label: c.name }); (c.children || []).forEach(function (s) { if (includeAll) out.push({ value: s.id, label: '   ' + c.name + ' › ' + s.name }); }); });
    return out;
  }

  function shell() {
    topbar();
    content.innerHTML = B.tabsHtml([{ id: 'products', label: 'Products' }, { id: 'categories', label: 'Categories' }], state.tab) +
      (state.tab === 'products' ? '<div class="b2b-filters"><div class="search-box">' + A.icon('search') + '<input class="input" id="q" placeholder="Search SKU, name, barcode, brand…" value="' + esc(state.q) + '"/></div>' +
        B.select('fCat', catOptions(true), state.category_id) +
        B.select('fAct', [{ value: '', label: 'Active + inactive' }, { value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }], state.active) +
        B.select('fCh', [{ value: '', label: 'All channels' }, { value: 'retailer', label: 'Sold to retailers' }, { value: 'distributor', label: 'Sold to distributors' }, { value: 'b2c', label: 'On customer store' }], state.channel) + '</div>' : '') +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; state.page = 1; shell(); load(); }); });
    if (state.tab !== 'products') return;
    B.$('#q').addEventListener('input', B.debounce(function () { state.q = B.$('#q').value.trim(); state.page = 1; load(); }));
    [['fCat', 'category_id'], ['fAct', 'active'], ['fCh', 'channel']].forEach(function (p) { B.$('#' + p[0]).addEventListener('change', function () { state[p[1]] = B.$('#' + p[0]).value; state.page = 1; load(); }); });
  }

  async function load() {
    var host = B.$('#host');
    try {
      if (state.tab === 'categories') return renderCats(host);
      var d = await B.api.get('/products' + B.qs({ q: state.q, category_id: state.category_id, active: state.active, channel: state.channel, page: state.page, limit: 25 }));
      var cols = [
        { label: 'Product', html: function (p) { return '<div class="flex items-center gap-12">' + (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px" onerror="this.style.visibility=\'hidden\'"/>' : '<div class="product-thumb" style="width:36px;height:36px"></div>') +
          '<div><div class="td-strong">' + esc(p.name) + '</div><div class="td-muted td-mono">' + esc(p.sku) + (p.pack_size ? ' · ' + esc(p.pack_size) : '') + '</div></div></div>'; } },
        { label: 'Category', cls: 'hide-sm', html: function (p) { return esc(p.category_name || '—') + (p.subcategory_name ? '<div class="td-muted">' + esc(p.subcategory_name) + '</div>' : ''); } },
        { label: 'GST', cls: 'num hide-sm', html: function (p) { return esc(Number(p.gst_rate)) + '%'; } },
        { label: 'MRP', cls: 'num', html: function (p) { return B.money(p.mrp); } },
      ];
      if (seePrice) cols.push(
        { label: 'Base', cls: 'num', html: function (p) { return B.money(p.base_price); } },
        { label: 'Distributor', cls: 'num', html: function (p) { return priceCell(p.computed.distributor); } },
        { label: 'Retailer', cls: 'num', html: function (p) { return priceCell(p.computed.retailer); } });
      cols.push(
        { label: 'MOQ / case', cls: 'num hide-sm', html: function (p) { return esc(p.moq) + ' / ' + esc(p.case_qty); } },
        { label: 'Stock', cls: 'num', html: function (p) { var low = Number(p.low_stock_threshold) && p.company_stock <= Number(p.low_stock_threshold); return '<span' + (low ? ' style="color:var(--red);font-weight:600"' : '') + '>' + A.fmt.num(p.company_stock) + '</span>'; } },
        { label: 'Sold to', cls: 'hide-sm', html: function (p) { return (Number(p.avail_distributor) ? '<span class="badge badge-distributor no-dot">D</span> ' : '') + (Number(p.avail_retailer) ? '<span class="badge badge-retailer no-dot">R</span> ' : '') + (Number(p.avail_b2c) ? '<span class="badge badge-neutral no-dot">B2C</span>' : ''); } },
        { label: '', html: function (p) { return Number(p.is_active) ? '' : B.badge('inactive'); } });
      host.innerHTML = B.table(cols, d.items, { clickable: canEdit, rowAttr: function (p) { return 'data-id="' + p.id + '"'; }, icon: 'products', emptyTitle: 'No products yet',
        emptyText: 'Add a product, import an Excel file, or sync from the customer store.' }) + B.pager(d, 'products');
      if (canEdit) host.querySelectorAll('tr[data-id]').forEach(function (tr) { tr.addEventListener('click', function () { edit(d.items.filter(function (p) { return String(p.id) === tr.dataset.id; })[0]); }); });
      host.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); load(); }); });
    } catch (e) { B.fail(host, e); }
  }
  function priceCell(c) {
    return '<span' + (c.belowCost ? ' style="color:var(--red);font-weight:600" title="Below base price"' : '') + '>' + B.money(c.price) + '</span><div class="td-muted small">' + esc(B.label(c.source)) + (c.marginPct != null ? ' · ' + c.marginPct + '%' : '') + '</div>';
  }

  /* ─── Product form ─── */
  function edit(p) {
    var isNew = !p; p = p || { gst_rate: 18, moq: 1, case_qty: 1, enforce_case_multiple: 1, avail_retailer: 1, avail_distributor: 1, avail_b2c: 0, is_active: 1 };
    var chk = function (id, text, on) { return '<label class="checkbox"><input type="checkbox" id="' + id + '"' + (Number(on) ? ' checked' : '') + '/><span>' + esc(text) + '</span></label>'; };
    var parent = state.cats.filter(function (c) { return Number(c.id) === Number(p.category_id); })[0];
    var subs = [{ value: '', label: '— None —' }].concat(((parent && parent.children) || []).map(function (s) { return { value: s.id, label: s.name }; }));
    var priceAttr = canPrice ? '' : ' disabled';
    B.modal({ title: isNew ? 'Add product' : 'Edit ' + p.sku, wide: true, submit: isNew ? 'Create product' : 'Save changes', body:
      '<div class="form-grid">' +
      B.field('f_sku', 'SKU *', B.input('f_sku', p.sku, 'maxlength="64"'), 'Unique. The key used by Excel import.') + B.field('f_name', 'Product name *', B.input('f_name', p.name, 'maxlength="200"')) +
      B.field('f_category_id', 'Category', B.select('f_category_id', catOptions(false), p.category_id)) + B.field('f_subcategory_id', 'Sub-category', B.select('f_subcategory_id', subs, p.subcategory_id)) +
      B.field('f_brand', 'Brand', B.input('f_brand', p.brand)) + B.field('f_pack_size', 'Pack size', B.input('f_pack_size', p.pack_size, 'placeholder="e.g. 60 gummies"')) +
      B.field('f_barcode', 'Barcode', B.input('f_barcode', p.barcode)) + B.field('f_hsn_code', 'HSN', B.input('f_hsn_code', p.hsn_code, 'inputmode="numeric" maxlength="8"')) +
      B.field('f_gst_rate', 'GST % *', B.select('f_gst_rate', GST.concat(GST.indexOf(Number(p.gst_rate)) === -1 ? [Number(p.gst_rate)] : []).map(function (g) { return { value: g, label: g + '%' }; }), Number(p.gst_rate), priceAttr)) +
      B.field('f_mrp', 'MRP (incl. GST) *', B.input('f_mrp', p.mrp, 'inputmode="decimal"' + priceAttr)) +
      (seePrice ? B.field('f_base_price', 'Base price (ex-GST) *', B.input('f_base_price', p.base_price, 'inputmode="decimal"' + priceAttr), 'Your price before trade margin.') +
        B.field('f_distributor_margin', 'Distributor margin %', B.input('f_distributor_margin', p.distributor_margin == null ? '' : Number(p.distributor_margin), 'inputmode="decimal" placeholder="default"' + priceAttr), 'Blank = category / default margin') +
        B.field('f_retailer_margin', 'Retailer margin %', B.input('f_retailer_margin', p.retailer_margin == null ? '' : Number(p.retailer_margin), 'inputmode="decimal" placeholder="default"' + priceAttr)) +
        B.field('f_distributor_price', 'Fixed distributor price', B.input('f_distributor_price', p.distributor_price, 'inputmode="decimal" placeholder="none"' + priceAttr), 'Overrides the margin when set') +
        B.field('f_retailer_price', 'Fixed retailer price', B.input('f_retailer_price', p.retailer_price, 'inputmode="decimal" placeholder="none"' + priceAttr)) : '') +
      B.field('f_moq', 'MOQ', B.input('f_moq', p.moq, 'inputmode="numeric"'), 'Minimum order quantity') + B.field('f_case_qty', 'Case quantity', B.input('f_case_qty', p.case_qty, 'inputmode="numeric"')) +
      B.field('f_low_stock_threshold', 'Low-stock alert at', B.input('f_low_stock_threshold', p.low_stock_threshold || 0, 'inputmode="numeric"')) +
      B.field('f_effective_from', 'Available from', B.input('f_effective_from', p.effective_from ? String(p.effective_from).slice(0, 10) : '', 'type="date"'), 'Blank = available now') +
      B.field('f_image_url', 'Image URL', B.input('f_image_url', p.image_url, 'placeholder="/assets/images/… or https://…"'), '', 'wide') +
      B.field('f_description', 'Description', '<textarea class="textarea" id="f_description">' + esc(p.description || '') + '</textarea>', '', 'wide') +
      '<div class="field wide" style="display:flex;gap:18px;flex-wrap:wrap">' + chk('f_enforce_case_multiple', 'Order in case multiples only', p.enforce_case_multiple) + chk('f_avail_distributor', 'Sell to distributors', p.avail_distributor) +
        chk('f_avail_retailer', 'Sell to retailers', p.avail_retailer) + chk('f_avail_b2c', 'Also on customer store', p.avail_b2c) + chk('f_is_active', 'Active', p.is_active) + '</div></div>' +
      (canPrice ? '' : '<div class="alert alert-info mb-0">' + A.icon('alert') + '<span>Prices and margins can only be changed by staff with pricing permission.</span></div>'),
      onSubmit: async function () {
        var b = {};
        ['sku', 'name', 'category_id', 'subcategory_id', 'brand', 'pack_size', 'barcode', 'hsn_code', 'moq', 'case_qty', 'low_stock_threshold', 'effective_from', 'image_url', 'description',
          'enforce_case_multiple', 'avail_distributor', 'avail_retailer', 'avail_b2c', 'is_active'].forEach(function (k) { b[k] = B.val('f_' + k); });
        if (canPrice || isNew) ['gst_rate', 'mrp', 'base_price', 'distributor_margin', 'retailer_margin', 'distributor_price', 'retailer_price'].forEach(function (k) { var v = B.val('f_' + k); if (v !== undefined) b[k] = v; });
        if (isNew) await B.api.post('/products', b); else await B.api.patch('/products/' + p.id, b);
        A.toast(isNew ? 'Product created' : 'Saved', 'success'); load();
      } });
    B.$('#f_category_id').addEventListener('change', function () {
      var c = state.cats.filter(function (x) { return String(x.id) === B.$('#f_category_id').value; })[0];
      B.$('#f_subcategory_id').innerHTML = '<option value="">— None —</option>' + ((c && c.children) || []).map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('');
    });
  }

  /* ─── Categories ─── */
  function renderCats(host) {
    var rows = [];
    state.cats.forEach(function (c) { rows.push(c); (c.children || []).forEach(function (s) { rows.push(Object.assign({ child: true, parentName: c.name }, s)); }); });
    host.innerHTML = B.table([
      { label: 'Category', html: function (c) { return (c.child ? '<span class="muted" style="padding-left:22px">↳ </span>' : '') + '<span class="' + (c.child ? '' : 'td-strong') + '">' + esc(c.name) + '</span>'; } },
      { label: 'Active products', cls: 'num', html: function (c) { return esc(c.product_count); } },
      { label: 'Order', cls: 'num hide-sm', html: function (c) { return esc(c.sort_order); } },
      { label: 'Status', html: function (c) { return B.badge(Number(c.is_active) ? 'active' : 'inactive'); } },
      { label: '', html: function (c) { return canEdit ? '<button class="btn btn-ghost btn-sm" data-edit="' + c.id + '">Edit</button>' : ''; } },
    ], rows, { icon: 'products', emptyTitle: 'No categories' }) +
      '<div class="td-muted small" style="padding:12px 16px">Categories are data, not code — add Gummies, Biscuits, Energy Drinks or anything new here and it appears in the portal immediately.</div>';
    host.querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { editCat(rows.filter(function (c) { return String(c.id) === b.dataset.edit; })[0]); }); });
  }
  function editCat(c) {
    var isNew = !c; c = c || { is_active: 1, sort_order: 0 };
    B.modal({ title: isNew ? 'Add category' : 'Edit category', body:
      B.field('c_name', 'Name', B.input('c_name', c.name, 'maxlength="100"')) +
      B.field('c_parent', 'Parent (for a sub-category)', B.select('c_parent', [{ value: '', label: '— Top level —' }].concat(state.cats.filter(function (x) { return x.id !== c.id; }).map(function (x) { return { value: x.id, label: x.name }; })), c.parent_id)) +
      B.field('c_sort', 'Display order', B.input('c_sort', c.sort_order, 'inputmode="numeric"')) +
      '<label class="checkbox"><input type="checkbox" id="c_active"' + (Number(c.is_active) ? ' checked' : '') + '/><span>Active</span></label>',
      onSubmit: async function () {
        var b = { name: B.val('c_name'), parent_id: B.val('c_parent'), sort_order: B.val('c_sort'), is_active: B.val('c_active') };
        if (isNew) await B.api.post('/categories', b); else await B.api.patch('/categories/' + c.id, b);
        A.toast('Category saved', 'success'); await loadCats(); shell(); load();
      } });
  }
  async function loadCats() { state.cats = (await B.api.get('/categories')).categories; }

  try { await loadCats(); } catch (e) { B.fail(content, e); return; }
  shell(); load();
})();
