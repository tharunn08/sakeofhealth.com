(async function () {
  'use strict';
  var A = window.Admin, B = window.B2B, esc = B.esc;
  if (!(await B.init('b2b-import', 'Excel Import', ['b2b.imports.execute']))) return;
  var content = document.getElementById('content');
  var state = { tab: 'new', imp: null, fields: [], filter: 'invalid', page: 1 };

  document.getElementById('topbarActions').innerHTML = '<button class="btn btn-ghost btn-sm" id="tplBtn">' + A.icon('download') + 'Download template</button>';
  B.$('#tplBtn').addEventListener('click', function () { B.download('/imports/template', 'product-import-template.xlsx').catch(function (e) { A.toast(e.message, 'error'); }); });

  var STEPS = ['Upload', 'Map columns', 'Validate & preview', 'Import', 'Result'];
  function steps(n) { return '<div class="steps">' + STEPS.map(function (s, i) { return '<div class="s ' + (i < n ? 'done' : i === n ? 'on' : '') + '"><b>Step ' + (i + 1) + '</b>' + s + '</div>'; }).join('') + '</div>'; }

  function shell() {
    content.innerHTML = B.tabsHtml([{ id: 'new', label: 'New import' }, { id: 'history', label: 'Import history' }], state.tab) + '<div id="pane"></div>';
    content.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { state.tab = b.dataset.tab; state.imp = null; shell(); }); });
    if (state.tab === 'history') return history(B.$('#pane'));
    if (!state.imp) return uploadStep(B.$('#pane'));
    route();
  }
  function route() {
    var st = state.imp.status, pane = B.$('#pane');
    if (st === 'uploaded') return mapStep(pane);
    if (st === 'ready') return previewStep(pane);
    if (st === 'processing' || st === 'validating') return progressStep(pane);
    return resultStep(pane);
  }

  /* ─── 1. Upload ─── */
  function uploadStep(pane) {
    pane.innerHTML = steps(0) + '<div class="card"><div class="card-body">' +
      '<label class="drop" id="drop"><input type="file" id="file" accept=".xlsx,.csv" hidden/><strong>Choose an Excel (.xlsx) or CSV file</strong>' +
      '<span class="muted">or drag it here · up to 20,000 rows</span></label>' +
      '<div class="alert alert-info" style="margin-top:16px">' + A.icon('alert') + '<span>Nothing changes when you upload. You will map the columns, see every problem row by row, and confirm before anything is written. ' +
      'SKU is the matching key: existing SKUs are updated, new SKUs are created, and blank cells never overwrite existing data.</span></div><div id="upMsg"></div></div></div>';
    var drop = B.$('#drop'), file = B.$('#file');
    var send = async function (f) {
      if (!f) return;
      B.$('#upMsg').innerHTML = A.loadingState();
      try {
        var fd = new FormData(); fd.append('file', f);
        var r = await B.upload('/imports', fd);
        state.fields = r.fields; state.imp = await B.api.get('/imports/' + r.id); state.sample = r.sample; route();
      } catch (e) { B.$('#upMsg').innerHTML = B.errorBox(e); }
    };
    file.addEventListener('change', function () { send(file.files[0]); });
    ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { send(e.dataTransfer.files[0]); });
  }

  /* ─── 2. Map columns ─── */
  var FIELDS = [['sku', 'SKU *'], ['name', 'Product Name *'], ['category', 'Category'], ['subcategory', 'Subcategory'], ['brand', 'Brand'], ['hsn_code', 'HSN'], ['gst_rate', 'GST Rate'], ['mrp', 'MRP'],
    ['base_price', 'Base Price'], ['distributor_margin', 'Distributor Margin'], ['retailer_margin', 'Retailer Margin'], ['moq', 'MOQ'], ['case_qty', 'Case Quantity'], ['pack_size', 'Pack Size'],
    ['barcode', 'Barcode'], ['opening_stock', 'Opening Stock'], ['warehouse', 'Warehouse'], ['active', 'Active'], ['description', 'Description'], ['image_url', 'Image URL'],
    ['distributor_price', 'Distributor Price'], ['retailer_price', 'Retailer Price'], ['batch_no', 'Batch'], ['expiry_date', 'Expiry']];
  function mapStep(pane) {
    var imp = state.imp, opts = [{ value: '', label: '— Ignore this column —' }].concat(FIELDS.map(function (f) { return { value: f[0], label: f[1] }; }));
    pane.innerHTML = steps(1) + '<div class="card"><div class="card-head"><h2>' + esc(imp.file_name) + ' · ' + A.fmt.num(imp.total_rows) + ' rows</h2></div><div class="card-body">' +
      '<p class="mb-16">We matched the columns we recognised. Check each one, then validate.</p>' +
      B.table([
        { label: 'Column in your file', html: function (h) { return '<span class="td-strong">' + esc(h) + '</span>'; } },
        { label: 'Example', cls: 'td-muted', html: function (h) { return esc(state.sample && state.sample[0] ? state.sample[0][h] : ''); } },
        { label: 'Import as', html: function (h, i) { return B.select('map' + i, opts, imp.mapping[h] || '', 'data-h="' + esc(h) + '"'); } },
      ], imp.headers) +
      '<div class="form-grid" style="margin-top:16px">' + B.field('mode', 'What to import', B.select('mode', [{ value: 'create_update', label: 'Create new products and update existing ones' },
        { value: 'create_only', label: 'Only create new products (skip existing SKUs)' }, { value: 'update_only', label: 'Only update existing products (skip new SKUs)' }], 'create_update')) + '</div>' +
      '<div id="mapMsg"></div><div class="inline-actions"><button class="btn btn-primary" id="valBtn">Validate file</button><button class="btn btn-ghost" id="restart">Start over</button></div></div></div>';
    B.$('#restart').addEventListener('click', function () { state.imp = null; shell(); });
    B.$('#valBtn').addEventListener('click', async function () {
      var mapping = {}; B.$$('[data-h]').forEach(function (s) { if (s.value) mapping[s.dataset.h] = s.value; });
      B.$('#valBtn').disabled = true; B.$('#mapMsg').innerHTML = A.loadingState();
      try { state.summary = await B.api.post('/imports/' + imp.id + '/validate', { mapping: mapping, mode: B.val('mode') }); state.imp = await B.api.get('/imports/' + imp.id); state.filter = state.summary.invalid ? 'invalid' : 'valid'; route(); }
      catch (e) { B.$('#mapMsg').innerHTML = B.errorBox(e); B.$('#valBtn').disabled = false; }
    });
  }

  /* ─── 3. Validate & preview ─── */
  function previewStep(pane) {
    var imp = state.imp, s = state.summary || {};
    pane.innerHTML = steps(2) + '<div class="stat-grid"><div class="stat"><div class="stat-label">Total rows</div><div class="stat-value">' + A.fmt.num(imp.total_rows) + '</div></div>' +
      '<div class="stat teal"><div class="stat-label">Valid</div><div class="stat-value">' + A.fmt.num(imp.valid_rows) + '</div><div class="stat-sub">' +
        (s.willCreate != null ? s.willCreate + ' new · ' + s.willUpdate + ' updates · ' + s.willDeactivate + ' deactivations' + (s.willSkip ? ' · ' + s.willSkip + ' skipped' : '') : 'ready to import') + '</div></div>' +
      '<div class="stat ' + (imp.invalid_rows ? 'red' : '') + '"><div class="stat-label">Invalid</div><div class="stat-value">' + A.fmt.num(imp.invalid_rows) + '</div><div class="stat-sub">will NOT be imported</div></div></div>' +
      '<div class="card"><div class="card-head"><h2>Preview</h2><div class="spacer"></div>' + (imp.invalid_rows ? '<button class="btn btn-ghost btn-sm" id="errCsv">' + A.icon('download') + 'Error report</button>' : '') + '</div>' +
      '<div class="card-body" style="padding-bottom:0">' + B.tabsHtml([{ id: 'invalid', label: 'Problems', count: imp.invalid_rows }, { id: 'valid', label: 'Will import', count: imp.valid_rows }, { id: 'all', label: 'All rows' }], state.filter, 'f') + '</div>' +
      '<div class="card-body tight" id="rows">' + A.loadingState() + '</div><div class="card-body">' +
      (imp.valid_rows ? '<label class="checkbox mb-16"><input type="checkbox" id="ok"/><span>Import the <strong>' + A.fmt.num(imp.valid_rows) + '</strong> valid row(s)' +
        (imp.invalid_rows ? ' and leave the <strong>' + A.fmt.num(imp.invalid_rows) + '</strong> invalid row(s) out' : '') + '.</span></label><br/>' : '<div class="alert alert-error">' + A.icon('alert') + '<span>No valid rows — fix the file and upload it again.</span></div>') +
      '<div class="inline-actions" style="margin-top:0">' + (imp.valid_rows ? '<button class="btn btn-primary" id="go" disabled>Import now</button>' : '') +
      '<button class="btn btn-ghost" id="remap">Back to column mapping</button><button class="btn btn-ghost" id="restart">Start over</button></div></div></div>';
    pane.querySelectorAll('[data-f]').forEach(function (b) { b.addEventListener('click', function () { state.filter = b.dataset.f; state.page = 1; previewStep(pane); }); });
    if (B.$('#errCsv')) B.$('#errCsv').addEventListener('click', function () { B.download('/imports/' + imp.id + '/errors.csv').catch(function (e) { A.toast(e.message, 'error'); }); });
    B.$('#restart').addEventListener('click', function () { state.imp = null; shell(); });
    B.$('#remap').addEventListener('click', function () { state.imp.status = 'uploaded'; route(); });
    if (B.$('#ok')) B.$('#ok').addEventListener('change', function () { B.$('#go').disabled = !B.$('#ok').checked; });
    if (B.$('#go')) B.$('#go').addEventListener('click', async function () {
      B.$('#go').disabled = true;
      try { await B.api.post('/imports/' + imp.id + '/apply', { confirm: true }); state.imp.status = 'processing'; route(); }
      catch (e) { A.toast(e.message, 'error'); B.$('#go').disabled = false; }
    });
    rows();
  }
  async function rows() {
    var host = B.$('#rows');
    try {
      var d = await B.api.get('/imports/' + state.imp.id + '/rows' + B.qs({ filter: state.filter === 'all' ? '' : state.filter, page: state.page, limit: 50 }));
      host.innerHTML = B.table([
        { label: 'Row', cls: 'num', html: function (r) { return esc(r.row); } },
        { label: 'SKU', cls: 'td-mono', html: function (r) { return esc(r.values.sku || '—'); } },
        { label: 'Product', html: function (r) { return esc(r.values.name || '') + '<div class="td-muted">' + esc([r.values.category, r.values.subcategory].filter(Boolean).join(' › ')) + '</div>'; } },
        { label: 'GST / MRP / Base', cls: 'num hide-sm', html: function (r) { return esc([r.values.gst_rate, r.values.mrp, r.values.base_price].map(function (x) { return x === undefined || x === '' ? '·' : x; }).join(' / ')); } },
        { label: 'Action', html: function (r) { return r.valid ? B.badge(r.action === 'create' ? 'approved' : r.action === 'update' ? 'processing' : r.action === 'deactivate' ? 'suspended' : 'draft').replace(/>[^<]+</, '>' + esc(B.label(r.action)) + '<') : B.badge('failed').replace(/>[^<]+</, '>Invalid<'); } },
        { label: 'Problems', html: function (r) { return r.errors.length ? '<span style="color:var(--red)">' + r.errors.map(esc).join('<br/>') + '</span>' : '<span class="muted">—</span>'; } },
      ], d.items, { emptyTitle: state.filter === 'invalid' ? 'No problems found' : 'No rows', emptyText: state.filter === 'invalid' ? 'Every row in the file is valid.' : '' }) + B.pager(d, 'rows');
      host.querySelectorAll('[data-page]').forEach(function (b) { b.addEventListener('click', function () { state.page = Number(b.dataset.page); rows(); }); });
    } catch (e) { B.fail(host, e); }
  }

  /* ─── 4. Import (runs in the background, in one transaction) ─── */
  function progressStep(pane) {
    pane.innerHTML = steps(3) + '<div class="card"><div class="card-body" style="text-align:center;padding:48px 20px">' + A.loadingState() +
      '<h2 style="margin-top:12px">Importing…</h2><p class="muted" style="margin-top:6px">All rows are written in a single transaction — if anything fails, nothing is changed. You can leave this page; the result is kept in Import history.</p></div></div>';
    var poll = async function () {
      try { state.imp = await B.api.get('/imports/' + state.imp.id); } catch (e) { /* keep polling */ }
      if (state.imp.status === 'processing' || state.imp.status === 'validating') setTimeout(poll, 1200); else route();
    };
    setTimeout(poll, 800);
  }

  /* ─── 5. Result ─── */
  function resultStep(pane) {
    var imp = state.imp, ok = imp.status === 'completed';
    pane.innerHTML = steps(ok ? 5 : 4) + '<div class="alert alert-' + (ok ? 'success' : imp.status === 'rolled_back' ? 'warn' : 'error') + '">' + A.icon(ok ? 'check' : 'alert') + '<span><strong>' +
      (ok ? 'Import complete.' : imp.status === 'rolled_back' ? 'This import was rolled back.' : 'Import failed — nothing was changed.') + '</strong> ' + esc(imp.error_message || '') + '</span></div>' +
      '<div class="stat-grid"><div class="stat teal"><div class="stat-label">Created</div><div class="stat-value">' + imp.created + '</div></div><div class="stat blue"><div class="stat-label">Updated</div><div class="stat-value">' + imp.updated + '</div></div>' +
      '<div class="stat"><div class="stat-label">Deactivated</div><div class="stat-value">' + imp.deactivated + '</div></div><div class="stat ' + (imp.invalid_rows ? 'red' : '') + '"><div class="stat-label">Not imported (invalid)</div><div class="stat-value">' + imp.invalid_rows + '</div></div></div>' +
      '<div class="inline-actions"><a class="btn btn-primary" href="catalogue.html">View catalogue</a><button class="btn btn-ghost" id="again">Import another file</button>' +
      (imp.invalid_rows ? '<button class="btn btn-ghost" id="errCsv2">' + A.icon('download') + 'Error report</button>' : '') +
      (ok ? '<button class="btn btn-danger-ghost" id="rb">Roll back this import</button>' : '') + '</div>';
    B.$('#again').addEventListener('click', function () { state.imp = null; shell(); });
    if (B.$('#errCsv2')) B.$('#errCsv2').addEventListener('click', function () { B.download('/imports/' + imp.id + '/errors.csv').catch(function (e) { A.toast(e.message, 'error'); }); });
    if (B.$('#rb')) B.$('#rb').addEventListener('click', function () { rollback(imp.id, function (r) { state.imp.status = 'rolled_back'; route(); }); });
  }
  function rollback(id, done) {
    if (!confirm('Roll back import #' + id + '?\n\nUpdated products get their previous values back, products created by this import are deactivated, and opening stock posted by it is reversed where still available.')) return;
    B.api.post('/imports/' + id + '/rollback').then(function (r) { A.toast('Rolled back: ' + r.restored + ' restored, ' + r.deactivated + ' deactivated', 'success'); done(r); }).catch(function (e) { A.toast(e.message, 'error'); });
  }

  /* ─── History ─── */
  async function history(pane) {
    pane.innerHTML = '<div class="card"><div class="card-body tight" id="hist">' + A.loadingState() + '</div></div>';
    try {
      var d = await B.api.get('/imports?limit=50');
      B.$('#hist').innerHTML = B.table([
        { label: 'Import ID', cls: 'td-mono', html: function (i) { return '#' + i.id; } },
        { label: 'File', html: function (i) { return '<span class="td-strong">' + esc(i.file_name) + '</span><div class="td-muted">' + esc(i.uploaded_by) + '</div>'; } },
        { label: 'Uploaded', cls: 'td-nowrap hide-sm', html: function (i) { return esc(B.dateTime(i.created_at)); } },
        { label: 'Rows', cls: 'num', html: function (i) { return A.fmt.num(i.total_rows); } },
        { label: 'Successful', cls: 'num', html: function (i) { return A.fmt.num(i.created + i.updated + i.deactivated); } },
        { label: 'Failed', cls: 'num', html: function (i) { return i.invalid_rows ? '<span style="color:var(--red)">' + A.fmt.num(i.invalid_rows) + '</span>' : '0'; } },
        { label: 'Status', html: function (i) { return B.badge(i.status); } },
        { label: '', html: function (i) { return (i.invalid_rows ? '<button class="btn btn-ghost btn-sm" data-err="' + i.id + '">Errors</button> ' : '') +
          (i.status === 'completed' ? '<button class="btn btn-danger-ghost btn-sm" data-rb="' + i.id + '">Roll back</button>' : '') +
          (i.status === 'ready' || i.status === 'uploaded' ? '<button class="btn btn-ghost btn-sm" data-resume="' + i.id + '">Continue</button>' : ''); } },
      ], d.items, { icon: 'upload', emptyTitle: 'No imports yet', emptyText: 'Every upload is listed here with its result.' });
      B.$$('[data-err]').forEach(function (b) { b.addEventListener('click', function () { B.download('/imports/' + b.dataset.err + '/errors.csv').catch(function (e) { A.toast(e.message, 'error'); }); }); });
      B.$$('[data-rb]').forEach(function (b) { b.addEventListener('click', function () { rollback(b.dataset.rb, function () { history(pane); }); }); });
      B.$$('[data-resume]').forEach(function (b) { b.addEventListener('click', async function () { state.imp = await B.api.get('/imports/' + b.dataset.resume); state.summary = null; state.tab = 'new'; shell(); }); });
    } catch (e) { B.fail(B.$('#hist'), e); }
  }

  shell();
})();
