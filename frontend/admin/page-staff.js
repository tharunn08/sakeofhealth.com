(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('staff', 'Staff')) return;
  A.ensureOverlay();

  var content = document.getElementById('content');
  var state = { staff: [] };

  var ROLES = {
    admin: 'Full access to everything',
    manager: 'Everything except deleting staff accounts',
    staff: 'Orders, customers, reviews and deliveries',
    delivery: 'Assigned deliveries only',
  };
  // B2B back-office roles — only offered when the B2B platform is switched on.
  if (window.SOH_CONFIG && window.SOH_CONFIG.b2bEnabled) {
    ROLES.b2b_admin = 'B2B only: full access to the B2B section';
    ROLES.b2b_manager = 'B2B only: accounts, orders, catalogue, network (no settings or price changes)';
    ROLES.sales = 'B2B only: approve retailers/distributors, orders, mapping';
    ROLES.inventory = 'B2B only: stock, warehouses, order fulfilment, Excel import';
    ROLES.finance = 'B2B only: invoices, payments, credit limits, reports';
    ROLES.support = 'B2B only: read-only view of accounts, orders and invoices';
  }
  function roleLabel(r) {
    return r.replace(/^b2b_/, 'B2B ').replace(/_/g, ' ').replace(/(^|\s)([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
  }

  document.getElementById('topbarActions').innerHTML =
    '<button class="btn btn-primary btn-sm" id="addBtn">' + A.icon('plus') + 'Add Staff</button>';

  function shell() {
    content.innerHTML =
      '<div class="alert alert-info mb-20">' + A.icon('alert') +
      '<span>Staff sign in at the same admin URL with their own email and password. ' +
      'Their role controls what they can see and do.</span></div>' +
      '<div class="card"><div class="card-body tight" id="host">' + A.loadingState() + '</div></div>' +
      modalHTML();
    document.getElementById('modalClose').addEventListener('click', function () { A.closePanel(); });
    document.getElementById('cancelBtn').addEventListener('click', function () { A.closePanel(); });
    document.getElementById('staffForm').addEventListener('submit', save);
  }

  function modalHTML() {
    return '<div class="modal" id="staffModal"><form id="staffForm">' +
      '<div class="modal-head"><h2 id="modalTitle">Add Staff Member</h2><div class="spacer"></div>' +
        '<button type="button" class="close-btn" id="modalClose">' + A.icon('close') + '</button></div>' +
      '<div class="modal-body"><input type="hidden" id="sId"/><div id="formAlert"></div>' +
        '<div class="field"><label for="sName">Full name *</label>' +
          '<input class="input" id="sName" required placeholder="e.g. Priya Sharma"/></div>' +
        '<div class="field"><label for="sEmail">Email address *</label>' +
          '<input class="input" type="email" id="sEmail" required placeholder="priya@sakeofhealth.com"/>' +
          '<div class="hint">They will use this to sign in.</div></div>' +
        '<div class="field"><label for="sPhone">Phone number</label>' +
          '<input class="input" id="sPhone" placeholder="9876543210"/>' +
          '<div class="hint">Delivery agents receive assignment alerts on WhatsApp at this number.</div></div>' +
        '<div class="field"><label for="sRole">Role *</label>' +
          '<select class="select" id="sRole">' +
          Object.keys(ROLES).map(function (r) {
            return '<option value="' + r + '">' + roleLabel(r) + '</option>';
          }).join('') + '</select>' +
          '<div class="hint" id="roleHint"></div></div>' +
        '<div class="field"><label for="sPass">Password <span id="passReq">*</span></label>' +
          '<input class="input" type="password" id="sPass" minlength="8" placeholder="Minimum 8 characters"/>' +
          '<div class="hint" id="passHint">Share this with them securely — they can change it later.</div></div>' +
        '<div class="field"><label class="checkbox"><input type="checkbox" id="sActive" checked/>' +
          '<span>Active — can sign in</span></label></div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button type="button" class="btn btn-ghost" id="cancelBtn">Cancel</button>' +
        '<button type="submit" class="btn btn-primary" id="saveBtn">Save</button>' +
      '</div></form></div>';
  }

  function render() {
    var host = document.getElementById('host');
    if (!state.staff.length) {
      host.innerHTML = A.emptyState('staff', 'No staff accounts',
        'Add team members so they can help manage orders and deliveries.');
      return;
    }
    host.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Name</th><th class="hide-sm">Email</th><th class="hide-xs">Phone</th>' +
      '<th>Role</th><th class="hide-sm">Last Login</th><th>Status</th>' +
      '<th style="width:100px"></th></tr></thead><tbody>' +
      state.staff.map(function (s) {
        return '<tr>' +
          '<td><div class="flex items-center gap-12">' +
            '<div class="sb-avatar">' + A.esc(A.fmt.initials(s.name)) + '</div>' +
            '<span class="td-strong">' + A.esc(s.name) + '</span></div></td>' +
          '<td class="hide-sm td-muted">' + A.esc(s.email) + '</td>' +
          '<td class="hide-xs td-muted">' + A.esc(A.fmt.phone(s.phone || '') || '—') + '</td>' +
          '<td><span class="badge badge-neutral no-dot" style="text-transform:capitalize">' + A.esc(s.role) + '</span></td>' +
          '<td class="hide-sm td-muted td-nowrap">' + (s.lastLogin ? A.esc(A.fmt.relative(s.lastLogin)) : 'Never') + '</td>' +
          '<td>' + (s.active
            ? '<span class="badge badge-delivered">Active</span>'
            : '<span class="badge badge-neutral">Disabled</span>') + '</td>' +
          '<td><div class="flex gap-8">' +
            '<button class="btn btn-ghost btn-icon" data-edit="' + A.esc(s.id) + '">' + A.icon('edit') + '</button>' +
            '<button class="btn btn-ghost btn-icon" data-del="' + A.esc(s.id) + '">' + A.icon('trash') + '</button>' +
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
    var s = id ? state.staff.find(function (x) { return x.id === id; }) : null;
    document.getElementById('modalTitle').textContent = s ? 'Edit Staff Member' : 'Add Staff Member';
    document.getElementById('formAlert').innerHTML = '';
    document.getElementById('sId').value = s ? s.id : '';
    document.getElementById('sName').value = s ? s.name : '';
    document.getElementById('sEmail').value = s ? s.email : '';
    document.getElementById('sPhone').value = s ? (s.phone || '') : '';
    document.getElementById('sRole').value = s ? s.role : 'staff';
    document.getElementById('sPass').value = '';
    document.getElementById('sActive').checked = s ? s.active !== false : true;
    document.getElementById('sEmail').disabled = !!s;
    document.getElementById('sPass').required = !s;
    document.getElementById('passReq').style.display = s ? 'none' : 'inline';
    document.getElementById('passHint').textContent = s
      ? 'Leave blank to keep their current password.'
      : 'Share this with them securely — they can change it later.';
    updateRoleHint();
    A.openPanel(document.getElementById('staffModal'));
  }

  function updateRoleHint() {
    document.getElementById('roleHint').textContent = ROLES[document.getElementById('sRole').value] || '';
  }

  async function save(e) {
    e.preventDefault();
    var btn = document.getElementById('saveBtn');
    var id = document.getElementById('sId').value;
    var payload = {
      name: document.getElementById('sName').value.trim(),
      email: document.getElementById('sEmail').value.trim(),
      phone: document.getElementById('sPhone').value.trim(),
      role: document.getElementById('sRole').value,
      active: document.getElementById('sActive').checked,
    };
    var pass = document.getElementById('sPass').value;
    if (pass) payload.password = pass;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      if (id) await A.api.patch('/staff/' + id, payload);
      else await A.api.post('/staff', payload);
      A.toast(id ? 'Staff member updated' : 'Staff member added', 'success');
      A.closePanel();
      load();
    } catch (err) {
      document.getElementById('formAlert').innerHTML =
        '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(err.message) + '</span></div>';
    }
    btn.disabled = false;
    btn.textContent = 'Save';
  }

  async function del(id) {
    var s = state.staff.find(function (x) { return x.id === id; });
    if (!confirm('Remove ' + (s ? s.name : 'this staff member') + '? They will lose access immediately.')) return;
    try {
      await A.api.del('/staff/' + id);
      A.toast('Staff member removed', 'success');
      load();
    } catch (e) { A.toast(e.message, 'error'); }
  }

  async function load() {
    try {
      var d = await A.api.get('/staff');
      state.staff = d.staff;
      render();
    } catch (e) {
      document.getElementById('host').innerHTML =
        '<div class="alert alert-error" style="margin:20px">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  document.getElementById('addBtn').addEventListener('click', function () { openForm(null); });
  shell();
  document.getElementById('sRole').addEventListener('change', updateRoleHint);
  load();
})();
