(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('products', 'Products')) return;
  A.ensureOverlay();

  var content = document.getElementById('content');
  var state = { filter: '', products: [] };

  document.getElementById('topbarActions').innerHTML =
    '<button class="btn btn-primary btn-sm" id="addBtn">' + A.icon('plus') + 'Add Product</button>';

  var TABS = [
    { id: '', label: 'All' },
    { id: 'live', label: 'Live' },
    { id: 'upcoming', label: 'Upcoming' },
  ];

  function shell() {
    content.innerHTML =
      '<div class="toolbar"><div class="tabs" id="tabs">' + TABS.map(function (t) {
        return '<button class="tab' + (state.filter === t.id ? ' active' : '') +
          '" data-f="' + t.id + '">' + A.esc(t.label) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>' +
      modalHTML();

    document.getElementById('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]'); if (!b) return;
      state.filter = b.dataset.f; shell(); load();
    });
    document.getElementById('modalClose').addEventListener('click', function () { A.closePanel(); });
    document.getElementById('cancelBtn').addEventListener('click', function () { A.closePanel(); });
    document.getElementById('productForm').addEventListener('submit', save);
  }

  function modalHTML() {
    return '<div class="modal wide" id="productModal">' +
      '<form id="productForm">' +
      '<div class="modal-head"><h2 id="modalTitle">Add Product</h2><div class="spacer"></div>' +
        '<button type="button" class="close-btn" id="modalClose">' + A.icon('close') + '</button></div>' +
      '<div class="modal-body">' +
        '<input type="hidden" id="pId"/>' +
        '<div id="formAlert"></div>' +
        '<div class="field"><label for="pName">Product name *</label>' +
          '<input class="input" id="pName" required placeholder="e.g. Vitamin D3 Gummies"/></div>' +
        '<div class="field"><label for="pShort">Short description</label>' +
          '<input class="input" id="pShort" placeholder="One line that appears on product cards"/></div>' +
        '<div class="field"><label for="pDesc">Full description</label>' +
          '<textarea class="textarea" id="pDesc" placeholder="Detailed description shown on the product page"></textarea></div>' +
        '<div class="field-row-3">' +
          '<div class="field"><label for="pPrice">Selling price (₹) *</label>' +
            '<input class="input" type="number" id="pPrice" min="0" step="1" required/></div>' +
          '<div class="field"><label for="pMrp">MRP (₹)</label>' +
            '<input class="input" type="number" id="pMrp" min="0" step="1" placeholder="Optional"/></div>' +
          '<div class="field"><label for="pStock">Stock</label>' +
            '<input class="input" type="number" id="pStock" min="0" step="1" placeholder="Leave blank for unlimited"/></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="pCategory">Category</label>' +
            '<select class="select" id="pCategory">' +
            '<option value="multivitamins">Multivitamins</option>' +
            '<option value="iron">Iron</option>' +
            '<option value="athletic">Athletic</option>' +
            '<option value="general">General</option>' +
            '</select></div>' +
          '<div class="field"><label for="pSku">SKU</label>' +
            '<input class="input" id="pSku" placeholder="e.g. SOH-VD-60"/></div>' +
        '</div>' +
        '<div class="field"><label for="pImage">Main image URL</label>' +
          '<input class="input" id="pImage" placeholder="/assets/images/product.png"/>' +
          '<div class="hint">Upload the image to <code>frontend/assets/images/</code> and reference its path here.</div></div>' +
        '<div class="field"><label for="pHighlights">Key highlights</label>' +
          '<textarea class="textarea" id="pHighlights" placeholder="One per line&#10;Vegan &amp; gelatin-free&#10;30-day supply"></textarea>' +
          '<div class="hint">One highlight per line — shown as bullet points on the product page.</div></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="pBadge">Badge</label>' +
            '<input class="input" id="pBadge" placeholder="e.g. Bestseller, New"/></div>' +
          '<div class="field"><label for="pSort">Display order</label>' +
            '<input class="input" type="number" id="pSort" value="0"/></div>' +
        '</div>' +
        '<div class="field"><label class="checkbox"><input type="checkbox" id="pUpcoming"/>' +
          '<span>Upcoming product — show as "Coming Soon" and disable purchase</span></label></div>' +
        '<div class="field" id="launchField" style="display:none"><label for="pLaunch">Launch date</label>' +
          '<input class="input" type="date" id="pLaunch"/></div>' +
        '<div class="field"><label class="checkbox"><input type="checkbox" id="pActive" checked/>' +
          '<span>Active — visible on the storefront</span></label></div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>' +
        '<button type="submit" class="btn btn-primary" id="saveBtn">Save Product</button>' +
      '</div></form></div>';
  }

  function render() {
    var host = document.getElementById('host');
    if (!state.products.length) {
      host.innerHTML = A.emptyState('products', 'No products here',
        'Add your first product to start selling on the storefront.');
      return;
    }
    host.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th style="width:60px"></th><th>Product</th><th class="hide-sm">Category</th>' +
      '<th class="td-right">Price</th><th class="hide-xs td-right">Stock</th>' +
      '<th>Status</th><th style="width:100px"></th></tr></thead><tbody>' +
      state.products.map(function (p) {
        var status = (p.upcoming ? '<span class="badge badge-prepared">Upcoming</span>'
          : p.active === false ? '<span class="badge badge-neutral">Hidden</span>'
          : '<span class="badge badge-delivered">Live</span>') +
          (p.protected ? ' <span class="badge badge-accepted" title="One of the four protected products: it cannot be deleted or hidden">Protected</span>' : '');
        var stock = p.stock == null ? '<span class="td-muted">∞</span>'
          : p.stock === 0 ? '<span style="color:var(--red);font-weight:600">Out</span>'
          : p.stock < 20 ? '<span style="color:var(--amber);font-weight:600">' + p.stock + '</span>'
          : p.stock;
        return '<tr>' +
          '<td>' + (p.image
            ? '<img class="product-thumb" src="' + A.esc(p.image) + '" alt="" onerror="this.style.visibility=\'hidden\'"/>'
            : '<div class="product-thumb"></div>') + '</td>' +
          '<td><div class="td-strong">' + A.esc(p.name) + '</div>' +
            '<div class="td-muted">' + A.esc(p.sku || p.slug || '') + '</div></td>' +
          '<td class="hide-sm td-muted" style="text-transform:capitalize">' + A.esc(p.category || '—') + '</td>' +
          '<td class="td-right"><span class="td-strong">' + A.fmt.money(p.price) + '</span>' +
            (p.mrp && p.mrp > p.price ? '<br/><span class="td-muted" style="text-decoration:line-through;font-size:11.5px">' +
              A.fmt.money(p.mrp) + '</span>' : '') + '</td>' +
          '<td class="hide-xs td-right">' + stock + '</td>' +
          '<td>' + status + '</td>' +
          '<td><div class="flex gap-8">' +
            '<button class="btn btn-ghost btn-icon" data-edit="' + A.esc(p.id) + '" title="Edit">' + A.icon('edit') + '</button>' +
            (p.protected ? '' : '<button class="btn btn-ghost btn-icon" data-del="' + A.esc(p.id) + '" title="Delete">' + A.icon('trash') + '</button>') +
          '</div></td></tr>';
      }).join('') + '</tbody></table></div>';

    host.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openForm(b.dataset.edit); });
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { del(b.dataset.del); });
    });
  }

  function openForm(id) {
    var p = id ? state.products.find(function (x) { return x.id === id; }) : null;
    document.getElementById('modalTitle').textContent = p ? 'Edit Product' : 'Add Product';
    document.getElementById('formAlert').innerHTML = '';
    var f = {
      pId: p ? p.id : '', pName: p ? p.name : '', pShort: p ? p.shortDescription : '',
      pDesc: p ? p.description : '', pPrice: p ? p.price : '', pMrp: p && p.mrp ? p.mrp : '',
      pStock: p && p.stock != null ? p.stock : '', pSku: p ? p.sku : '',
      pImage: p ? p.image : '', pBadge: p ? p.badge : '', pSort: p ? (p.sortOrder || 0) : 0,
      pLaunch: p && p.launchDate ? p.launchDate : '',
      pHighlights: p && p.highlights ? p.highlights.join('\n') : '',
    };
    Object.keys(f).forEach(function (k) { document.getElementById(k).value = f[k]; });
    document.getElementById('pCategory').value = (p && p.category) || 'multivitamins';
    document.getElementById('pUpcoming').checked = !!(p && p.upcoming);
    document.getElementById('pActive').checked = p ? p.active !== false : true;
    // protected products: identity and on-sale status are locked (the server enforces it too)
    var locked = !!(p && p.protected);
    ['pName', 'pCategory', 'pActive', 'pUpcoming'].forEach(function (k) { document.getElementById(k).disabled = locked; });
    document.getElementById('pSku').disabled = locked && !!(p && p.sku);
    if (locked) {
      document.getElementById('formAlert').innerHTML = '<div class="alert alert-info">' + A.icon('alert') + '<span>' +
        'Protected product: its name, category and on-sale status cannot change, and it cannot be deleted. ' +
        'You will be asked for a reason when you save; every change is logged.' +
        (p.toConfirm && p.toConfirm.length ? ' Still to confirm: ' + A.esc(p.toConfirm.join(', ').replace('hsnCode', 'HSN code').replace('gstRate', 'GST rate').replace('sku', 'SKU')) + '.' : '') +
        '</span></div>';
    }
    toggleLaunch();
    A.openPanel(document.getElementById('productModal'));
    setTimeout(function () { document.getElementById('pName').focus(); }, 100);
  }

  function toggleLaunch() {
    document.getElementById('launchField').style.display =
      document.getElementById('pUpcoming').checked ? 'block' : 'none';
  }

  async function save(e) {
    e.preventDefault();
    var btn = document.getElementById('saveBtn');
    var id = document.getElementById('pId').value;
    var payload = {
      name: document.getElementById('pName').value.trim(),
      shortDescription: document.getElementById('pShort').value.trim(),
      description: document.getElementById('pDesc').value.trim(),
      price: Number(document.getElementById('pPrice').value),
      mrp: document.getElementById('pMrp').value ? Number(document.getElementById('pMrp').value) : null,
      stock: document.getElementById('pStock').value === '' ? null : Number(document.getElementById('pStock').value),
      category: document.getElementById('pCategory').value,
      sku: document.getElementById('pSku').value.trim(),
      image: document.getElementById('pImage').value.trim(),
      badge: document.getElementById('pBadge').value.trim(),
      sortOrder: Number(document.getElementById('pSort').value) || 0,
      upcoming: document.getElementById('pUpcoming').checked,
      launchDate: document.getElementById('pLaunch').value || null,
      active: document.getElementById('pActive').checked,
      highlights: document.getElementById('pHighlights').value.split('\n')
        .map(function (s) { return s.trim(); }).filter(Boolean),
    };

    var current = id ? state.products.find(function (x) { return x.id === id; }) : null;
    if (current && current.protected) {
      var why = window.prompt('Reason for changing "' + current.name + '" (kept in the change log):', '');
      if (why === null) return;
      payload.reason = why;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      if (id) await A.api.patch('/products/' + id, payload);
      else await A.api.post('/products', payload);
      A.toast(id ? 'Product updated' : 'Product added — now live on the storefront', 'success');
      A.closePanel();
      load();
    } catch (err) {
      document.getElementById('formAlert').innerHTML =
        '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(err.message) + '</span></div>';
    }
    btn.disabled = false;
    btn.textContent = 'Save Product';
  }

  async function del(id) {
    var p = state.products.find(function (x) { return x.id === id; });
    if (!confirm('Delete "' + (p ? p.name : 'this product') + '"? This cannot be undone.')) return;
    try {
      await A.api.del('/products/' + id);
      A.toast('Product deleted', 'success');
      load();
    } catch (e) { A.toast(e.message, 'error'); }
  }

  async function load() {
    try {
      var q = state.filter ? '?status=' + state.filter : '';
      var d = await A.api.get('/products' + q);
      state.products = d.products;
      render();
    } catch (e) {
      document.getElementById('host').innerHTML =
        '<div class="alert alert-error" style="margin:20px">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  document.getElementById('addBtn').addEventListener('click', function () { openForm(null); });
  shell();
  document.getElementById('pUpcoming').addEventListener('change', toggleLaunch);
  load();
})();
