(function () {
  'use strict';
  var A = window.Admin;
  if (!A.initShell('settings', 'Settings')) return;

  var content = document.getElementById('content');

  function statusRow(label, ok, hint) {
    return '<div class="detail-row" style="align-items:center">' +
      '<dt>' + A.esc(label) + '<div class="hint" style="margin-top:2px">' + A.esc(hint) + '</div></dt>' +
      '<dd><span class="badge ' + (ok ? 'badge-delivered' : 'badge-neutral') + '">' +
      (ok ? 'Connected' : 'Not configured') + '</span></dd></div>';
  }

  async function load() {
    content.innerHTML = A.loadingState();
    try {
      var d = await A.api.get('/settings');
      var s = d.settings || {};
      var ig = d.integrations;

      content.innerHTML =
        (ig.paymentMock
          ? '<div class="alert alert-warn mb-20">' + A.icon('alert') +
            '<span><strong>Test payment mode is on.</strong> Orders complete without charging real money. ' +
            'Set <code>PAYMENT_MOCK=false</code> in your .env file and add live Razorpay keys before going live.</span></div>'
          : '<div class="alert alert-success mb-20">' + A.icon('check') +
            '<span><strong>Live payments are enabled.</strong> Real payments are being processed.</span></div>') +

        '<div class="grid-2">' +
        '<div class="card"><div class="card-head"><h2>Store Details</h2></div><div class="card-body">' +
          '<div class="field"><label for="stName">Store name</label>' +
            '<input class="input" id="stName" value="' + A.esc(s.storeName || '') + '"/></div>' +
          '<div class="field"><label for="stEmail">Support email</label>' +
            '<input class="input" type="email" id="stEmail" value="' + A.esc(s.supportEmail || '') + '"/></div>' +
          '<div class="field"><label for="stPhone">Support phone</label>' +
            '<input class="input" id="stPhone" value="' + A.esc(s.supportPhone || '') + '"/></div>' +
          '<div class="field"><label for="stAddress">Business address</label>' +
            '<textarea class="textarea" id="stAddress">' + A.esc(s.address || '') + '</textarea></div>' +
          '<div class="field"><label for="stCoupon">Show coupons on storefront</label>' +
            '<select class="select" id="stCoupon">' +
            [['off', 'Do not show coupons'], ['homepage', 'Show on homepage (below banner)'], ['products', 'Show below products']]
              .map(function (o) {
                return '<option value="' + o[0] + '"' + ((s.couponDisplay || 'off') === o[0] ? ' selected' : '') + '>' +
                  A.esc(o[1]) + '</option>';
              }).join('') +
            '</select>' +
            '<div class="hint" style="margin-top:4px">Only coupons marked “Show on storefront” will appear. Choose “Do not show” to hide all.</div></div>' +
          '<button class="btn btn-primary" id="saveBtn">Save settings</button>' +
        '</div></div>' +

        '<div class="card"><div class="card-head"><h2>Integrations</h2></div><div class="card-body"><dl>' +
          statusRow('Email (SMTP)', ig.email, 'Order confirmations and status updates by email') +
          statusRow('WhatsApp', ig.whatsapp, 'Order alerts sent to customer WhatsApp numbers') +
          statusRow('Razorpay', ig.razorpay, 'Online card, UPI and netbanking payments') +
          statusRow('Google Maps', ig.maps, 'Address autocomplete and reverse geocoding') +
        '</dl>' +
        (ig.emailStatus ?
          '<div class="alert alert-' + (ig.emailStatus.ok ? 'success' : (ig.emailStatus.configured ? 'error' : 'warn')) + ' mt-16">' +
          A.icon(ig.emailStatus.ok ? 'check' : 'alert') +
          '<span><strong>Email: </strong>' + A.esc(ig.emailStatus.reason) + '</span></div>' : '') +
        '<div class="alert alert-info mt-16">' + A.icon('alert') +
          '<span>Integrations are configured in your <code>.env</code> file. ' +
          'Restart the server after changing it.</span></div>' +
        '</div></div>' +
        '</div>' +

        '<div class="card mt-20"><div class="card-head"><h2>Test Notifications</h2></div><div class="card-body">' +
          '<p class="text-muted mb-20">Send yourself a test message to confirm your email and WhatsApp credentials work.</p>' +
          '<div class="field-row">' +
            '<div class="field"><label for="testEmail">Email address</label>' +
              '<input class="input" type="email" id="testEmail" placeholder="you@example.com"/></div>' +
            '<div class="field"><label for="testPhone">WhatsApp number</label>' +
              '<input class="input" id="testPhone" placeholder="9876543210"/></div>' +
          '</div>' +
          '<button class="btn btn-ghost mt-16" id="testBtn">Send test messages</button>' +
          '<div id="testResult" class="mt-16"></div>' +
        '</div></div>' +

        // Staff Order Notifications — only rendered for admin/manager (see below).
        '<div id="notifyEmailsCard"></div>';

      // ── Staff order-notification emails (admin + manager only) ──
      var role = (A.Auth.user() || {}).role;
      if (role === 'admin' || role === 'manager') {
        renderNotifyEmails();
      }

      document.getElementById('saveBtn').addEventListener('click', async function () {
        var btn = this;
        btn.disabled = true;
        try {
          await A.api.put('/settings', {
            storeName: document.getElementById('stName').value.trim(),
            supportEmail: document.getElementById('stEmail').value.trim(),
            supportPhone: document.getElementById('stPhone').value.trim(),
            address: document.getElementById('stAddress').value.trim(),
            couponDisplay: document.getElementById('stCoupon').value,
          });
          A.toast('Settings saved — refresh the storefront to see coupon changes', 'success');
        } catch (e) { A.toast(e.message, 'error'); }
        btn.disabled = false;
      });

      document.getElementById('testBtn').addEventListener('click', async function () {
        var btn = this;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner dark"></span> Sending…';
        try {
          var r = await A.api.post('/test-notification', {
            email: document.getElementById('testEmail').value.trim(),
            phone: document.getElementById('testPhone').value.trim(),
          });
          var lines = [];
          if (r.email) lines.push('Email: ' + (r.email.ok ? (r.email.mock ? 'logged to console (no SMTP configured)' : 'sent') : r.email.reason));
          if (r.whatsapp) lines.push('WhatsApp: ' + (r.whatsapp.ok ? (r.whatsapp.mock ? 'logged to console (no provider configured)' : 'sent') : r.whatsapp.reason));
          document.getElementById('testResult').innerHTML =
            '<div class="alert alert-info">' + A.icon('check') + '<span>' + A.esc(lines.join(' · ')) + '</span></div>';
        } catch (e) {
          document.getElementById('testResult').innerHTML =
            '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
        }
        btn.disabled = false;
        btn.textContent = 'Send test messages';
      });
    } catch (e) {
      content.innerHTML = '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
  }

  /* ── Staff Order Notifications card ──
     Lets admin/manager add or remove email addresses that receive a copy of
     every new order, on top of the built-in ADMIN_EMAIL. Backed by the
     manager-only /notify-emails endpoints. */
  var notifyEmails = [];

  function notifyChip(email) {
    return '<span class="badge badge-neutral" style="display:inline-flex;align-items:center;gap:6px;margin:0 6px 6px 0;padding:6px 10px;font-size:13px">' +
      A.esc(email) +
      '<button type="button" class="ne-remove" data-email="' + A.esc(email) + '" ' +
      'style="border:0;background:none;cursor:pointer;font-size:15px;line-height:1;color:inherit;padding:0" ' +
      'aria-label="Remove ' + A.esc(email) + '">&times;</button></span>';
  }

  function paintChips() {
    var wrap = document.getElementById('neList');
    if (!wrap) return;
    wrap.innerHTML = notifyEmails.length
      ? notifyEmails.map(notifyChip).join('')
      : '<span class="text-muted" style="font-size:14px">No staff emails yet. Only the main admin email is notified.</span>';
    wrap.querySelectorAll('.ne-remove').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = this.getAttribute('data-email');
        notifyEmails = notifyEmails.filter(function (x) { return x !== e; });
        paintChips();
      });
    });
  }

  async function renderNotifyEmails() {
    var host = document.getElementById('notifyEmailsCard');
    if (!host) return;
    host.innerHTML =
      '<div class="card mt-20"><div class="card-head"><h2>Staff Order Notifications</h2></div><div class="card-body">' +
        '<p class="text-muted mb-20">Add email addresses that should receive an alert for every new order — for example your ' +
        'packing or operations staff. These are notified in addition to the main admin email. ' +
        '<strong>Only admins and managers can change this list.</strong></p>' +
        '<div id="neList" style="margin-bottom:14px">' + A.loadingState() + '</div>' +
        '<div class="field-row" style="align-items:flex-end">' +
          '<div class="field" style="flex:1"><label for="neInput">Add staff email</label>' +
            '<input class="input" type="email" id="neInput" placeholder="staff@sakeofhealth.in"/></div>' +
          '<button class="btn btn-ghost" id="neAdd" type="button">Add</button>' +
        '</div>' +
        '<button class="btn btn-primary mt-16" id="neSave">Save staff emails</button>' +
        '<div id="neMsg" class="mt-16"></div>' +
      '</div></div>';

    try {
      var d = await A.api.get('/notify-emails');
      notifyEmails = Array.isArray(d.emails) ? d.emails.slice() : [];
    } catch (e) {
      notifyEmails = [];
      document.getElementById('neMsg').innerHTML =
        '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
    }
    paintChips();

    var RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function addFromInput() {
      var input = document.getElementById('neInput');
      var val = (input.value || '').trim().toLowerCase();
      var msg = document.getElementById('neMsg');
      msg.innerHTML = '';
      if (!val) return;
      if (!RX.test(val)) {
        msg.innerHTML = '<div class="alert alert-error">' + A.icon('alert') + '<span>That does not look like a valid email address.</span></div>';
        return;
      }
      if (notifyEmails.indexOf(val) !== -1) {
        msg.innerHTML = '<div class="alert alert-info">' + A.icon('alert') + '<span>That email is already in the list.</span></div>';
        return;
      }
      notifyEmails.push(val);
      input.value = '';
      paintChips();
    }

    document.getElementById('neAdd').addEventListener('click', addFromInput);
    document.getElementById('neInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); addFromInput(); }
    });

    document.getElementById('neSave').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true;
      var msg = document.getElementById('neMsg');
      msg.innerHTML = '';
      try {
        var r = await A.api.put('/notify-emails', { emails: notifyEmails });
        notifyEmails = Array.isArray(r.emails) ? r.emails.slice() : notifyEmails;
        paintChips();
        A.toast('Staff notification emails saved', 'success');
      } catch (e) {
        msg.innerHTML = '<div class="alert alert-error">' + A.icon('alert') + '<span>' + A.esc(e.message) + '</span></div>';
      }
      btn.disabled = false;
    });
  }

  load();
})();
