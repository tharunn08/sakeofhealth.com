(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('coupons', 'Coupons')) return;
  A.ensureOverlay();

  var content = document.getElementById('content');
  var state = { coupons: [] };

  document.getElementById('topbarActions').innerHTML =
    '<button class="btn btn-primary btn-sm" id="addBtn">' + A.icon('plus') + 'Create Coupon</button>';

  function shell() {
    content.innerHTML =
      '<div class="alert alert-info mb-20">' + A.icon('alert') +
      '<span>Coupons marked <strong>"Show on storefront"</strong> appear automatically in the offers strip ' +
      'on your site and at checkout. Others work only when typed in manually.</span></div>' +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>' +
      modalHTML();

    document.getElementById('modalClose').addEventListener('click', function () { A.closePanel(); });
    document.getElementById('cancelBtn').addEventListener('click', function () { A.closePanel(); });
    document.getElementById('couponForm').addEventListener('submit', save);
    document.getElementById('cType').addEventListener('change', onTypeChange);
  }

  function modalHTML() {
    return '<div class="modal" id="couponModal"><form id="couponForm">' +
      '<div class="modal-head"><h2 id="modalTitle">Create Coupon</h2><div class="spacer"></div>' +
        '<button type="button" class="close-btn" id="modalClose">' + A.icon('close') + '</button></div>' +
      '<div class="modal-body">' +
        '<input type="hidden" id="cId"/>' +
        '<div id="formAlert"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="cCode">Coupon code *</label>' +
            '<input class="input td-mono" id="cCode" required placeholder="SUMMER25" ' +
            'style="text-transform:uppercase;letter-spacing:.5px"/></div>' +
          '<div class="field"><label for="cType">Discount type *</label>' +
            '<select class="select" id="cType">' +
            '<option value="percent">Percentage off</option>' +
            '<option value="flat">Flat amount off</option>' +
            '<option value="free_shipping">Free delivery</option>' +
            '</select></div>' +
        '</div>' +
        '<div class="field-row" id="valueRow">' +
          '<div class="field"><label for="cValue"><span id="valueLabel">Percentage (%)</span> *</label>' +
            '<input class="input" type="number" id="cValue" min="0" step="1" required/></div>' +
          '<div class="field" id="maxRow"><label for="cMax">Maximum discount (₹)</label>' +
            '<input class="input" type="number" id="cMax" min="0" placeholder="Optional cap"/></div>' +
        '</div>' +
        '<div class="field"><label for="cDesc">Description</label>' +
          '<input class="input" id="cDesc" placeholder="e.g. 25% off your summer order"/>' +
          '<div class="hint">Shown to customers when the coupon is displayed on your site.</div></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="cMin">Minimum order value (₹)</label>' +
            '<input class="input" type="number" id="cMin" min="0" value="0"/></div>' +
          '<div class="field"><label for="cLimit">Total usage limit</label>' +
            '<input class="input" type="number" id="cLimit" min="1" placeholder="Unlimited"/></div>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="cStart">Starts on</label>' +
            '<input class="input" type="date" id="cStart"/></div>' +
          '<div class="field"><label for="cExpiry">Expires on</label>' +
            '<input class="input" type="date" id="cExpiry"/></div>' +
        '</div>' +
        '<div class="field"><label class="checkbox"><input type="checkbox" id="cShow"/>' +
          '<span>Show on storefront — advertise this coupon publicly</span></label></div>' +
        '<div class="field"><label class="checkbox"><input type="checkbox" id="cActive" checked/>' +
          '<span>Active — customers can redeem this coupon</span></label></div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>' +
        '<button type="submit" class="btn btn-primary" id="saveBtn">Save Coupon</button>' +
      '</div></form></div>';
  }

  function onTypeChange() {
    var t = document.getElementById('cType').value;
    document.getElementById('valueLabel').textContent = t === 'percent' ? 'Percentage (%)' : 'Amount (₹)';
    document.getElementById('valueRow').style.display = t === 'free_shipping' ? 'none' : 'grid';
    document.getElementById('maxRow').style.display = t === 'percent' ? 'block' : 'none';
    document.getElementById('cValue').required = t !== 'free_shipping';
  }

  function describe(c) {
    if (c.type === 'percent') return c.value + '% off' + (c.maxDiscount ? ' (max ' + A.fmt.money(c.maxDiscount) + ')' : '');
    if (c.type === 'flat') return A.fmt.money(c.value) + ' off';
    return 'Free delivery';
  }

  function render() {
    var host = document.getElementById('host');
    if (!state.coupons.length) {
      host.innerHTML = A.emptyState('coupons', 'No coupons yet',
        'Create a coupon to run a promotion on your storefront.');
      return;
    }
    var now = Date.now();
    host.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Code</th><th>Discount</th><th class="hide-sm">Conditions</th>' +
      '<th class="hide-xs td-right">Used</th><th class="hide-sm">Expires</th>' +
      '<th>Status</th><th style="width:100px"></th></tr></thead><tbody>' +
      state.coupons.map(function (c) {
        var expired = c.expiresAt && now > new Date(c.expiresAt).getTime();
        var exhausted = c.usageLimit && (c.usedCount || 0) >= c.usageLimit;
        var status = c.active === false ? '<span class="badge badge-neutral">Inactive</span>'
          : expired ? '<span class="badge badge-cancelled">Expired</span>'
          : exhausted ? '<span class="badge badge-cancelled">Limit reached</span>'
          : '<span class="badge badge-delivered">Active</span>';
        return '<tr>' +
          '<td><div class="td-mono td-strong" style="font-size:13px;letter-spacing:.4px">' + A.esc(c.code) + '</div>' +
            (c.showOnSite ? '<div class="td-muted" style="font-size:11px">Public</div>' : '') + '</td>' +
          '<td><div class="td-strong">' + A.esc(describe(c)) + '</div>' +
            (c.description ? '<div class="td-muted">' + A.esc(c.description) + '</div>' : '') + '</td>' +
          '<td class="hide-sm td-muted">' + (c.minOrderValue ? 'Min ' + A.fmt.money(c.minOrderValue) : 'No minimum') + '</td>' +
          '<td class="hide-xs td-right">' + (c.usedCount || 0) + (c.usageLimit ? ' / ' + c.usageLimit : '') + '</td>' +
          '<td class="hide-sm td-muted td-nowrap">' + (c.expiresAt ? A.esc(A.fmt.date(c.expiresAt)) : 'Never') + '</td>' +
          '<td>' + status + '</td>' +
          '<td><div class="flex gap-8">' +
            '<button class="btn btn-ghost btn-icon" data-edit="' + A.esc(c.id) + '" title="Edit">' + A.icon('edit') + '</button>' +
            '<button class="btn btn-ghost btn-icon" data-del="' + A.esc(c.id) + '" title="Delete">' + A.icon('trash') + '</button>' +
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
    var c = id ? state.coupons.find(function (x) { return x.id === id; }) : null;
    document.getElementById('modalTitle').textContent = c ? 'Edit Coupon' : 'Create Coupon';
    document.getElementById('formAlert').innerHTML = '';
    document.getElementById('cId').value = c ? c.id : '';
    document.getElementById('cCode').value = c ? c.code : '';
    document.getElementById('cType').value = c ? c.type : 'percent';
    document.getElementById('cValue').value = c ? c.value : '';
    document.getElementById('cMax').value = c && c.maxDiscount ? c.maxDiscount : '';
    document.getElementById('cDesc').value = c ? (c.description || '') : '';
    document.getElementById('cMin').value = c ? (c.minOrderValue || 0) : 0;
    document.getElementById('cLimit').value = c && c.usageLimit ? c.usageLimit : '';
    document.getElementById('cStart').value = c && c.startsAt ? String(c.startsAt).slice(0, 10) : '';
    document.getElementById('cExpiry').value = c && c.expiresAt ? String(c.expiresAt).slice(0, 10) : '';
    document.getElementById('cShow').checked = !!(c && c.showOnSite);
    document.getElementById('cActive').checked = c ? c.active !== false : true;
    onTypeChange();
    A.openPanel(document.getElementById('couponModal'));
    setTimeout(function () { document.getElementById('cCode').focus(); }, 100);
  }

  async function save(e) {
    e.preventDefault();
    var btn = document.getElementById('saveBtn');
    var id = document.getElementById('cId').value;
    var payload = {
      code: document.getElementById('cCode').value.trim().toUpperCase(),
      type: document.getElementById('cType').value,
      value: Number(document.getElementById('cValue').value) || 0,
      maxDiscount: document.getElementById('cMax').value ? Number(document.getElementById('cMax').value) : null,
      description: document.getElementById('cDesc').value.trim(),
      minOrderValue: Number(document.getElementById('cMin').value) || 0,
      usageLimit: document.getElementById('cLimit').value ? Number(document.getElementById('cLimit').value) : null,
      startsAt: document.getElementById('cStart').value || null,
      expiresAt: document.getElementById('cExpiry').value || null,
      showOnSite: document.getElementById('cShow').checked,
      active: document.getElementById('cActive').checked,
    };

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      if (id) await A.api.patch('/coupons/' + id, payload);
      else await A.api.post('/coupons', payload);
      A.toast(id ? 'Coupon updated' : 'Coupon created and live', 'success');
      A.closePanel();
      load();
    } catch (err) {
      document.getElementById('formAlert').innerHTML =
        '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(err.message) + '</span></div>';
    }
    btn.disabled = false;
    btn.textContent = 'Save Coupon';
  }

  async function del(id) {
    var c = state.coupons.find(function (x) { return x.id === id; });
    if (!confirm('Delete coupon "' + (c ? c.code : '') + '"? Customers will no longer be able to use it.')) return;
    try {
      await A.api.del('/coupons/' + id);
      A.toast('Coupon deleted', 'success');
      load();
    } catch (e) { A.toast(e.message, 'error'); }
  }

  async function load() {
    try {
      var d = await A.api.get('/coupons');
      state.coupons = d.coupons;
      render();
    } catch (e) {
      document.getElementById('host').innerHTML =
        '<div class="alert alert-error" style="margin:20px">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  document.getElementById('addBtn').addEventListener('click', function () { openForm(null); });
  shell();
  load();
})();
