/* One sign-in (/login) for staff (shop/trade and ERP accounts) and shop customers.
   The server decides which workspaces an e-mail/password (and, for ERP accounts with
   two-factor on, a 6-digit code) opens; this page only stores the chosen session the
   way that workspace expects it. */
(function () {
  'use strict';
  var A = window.Admin;
  var form = document.getElementById('loginForm');
  var btn = document.getElementById('submitBtn');
  var box = document.getElementById('alertBox');
  var codeField = document.getElementById('codeField');
  var skipBtn = document.getElementById('skipCode');
  var pending = null;   // workspaces the password already opened while the code is asked for

  function show(msg, type) {
    box.innerHTML = '<div class="alert alert-' + type + '">' + A.icon(type === 'error' ? 'alert' : 'check') + '<span>' + A.esc(msg) + '</span></div>';
  }
  function resetButton() { btn.disabled = false; btn.textContent = 'Sign in'; }

  var q = new URLSearchParams(location.search);
  if (q.get('expired')) show('Your session expired. Please sign in again.', 'warn');

  // Already signed in to the admin panel? Go straight through.
  if ((A.Auth.token() || A.Auth.erpToken()) && !q.get('expired')) {
    A.fetchNav().then(function () { location.replace('/admin'); }).catch(function () { A.Auth.clear(); });
  }

  /** Store the chosen session where that workspace's own pages look for it. */
  function open(w) {
    if (w.type === 'admin') A.Auth.setSession(w.token, w.erpToken, w.user);
    else if (w.type === 'customer') localStorage.setItem('soh_customer', JSON.stringify({ token: w.token, user: w.user }));
    else if (w.type === 'business') localStorage.setItem('soh_b2b', JSON.stringify({ token: w.token, user: w.user }));
    else if (w.type === 'supplier') sessionStorage.setItem('vendor.token', w.token);
    else if (w.type === 'sales') sessionStorage.setItem('sales.token', w.token);
    location.href = w.home;
  }

  // ── Temporary password: choose a new one before any workspace opens ──
  var changeBox = document.getElementById('changeBox');
  function askNewPassword(voluntary) {
    document.getElementById('credentials').hidden = true;
    changeBox.hidden = false;
    if (voluntary) document.getElementById('changeWhy').textContent = 'Choose your new password (at least 12 characters, letters and a number). It replaces the current one for every part of your account.';
    show(voluntary ? 'Changing the password for ' + document.getElementById('email').value.trim() + '.' : 'Please choose your own password to continue.', 'warn');
    document.getElementById('newPassword').focus();
  }
  // Any team, business or supplier account can change its password here at any time
  document.getElementById('changeLink').addEventListener('click', function (e) {
    e.preventDefault();
    if (!document.getElementById('email').value.trim() || !document.getElementById('password').value) { show('Enter your e-mail address and current password first.', 'error'); return; }
    askNewPassword(true);
  });
  document.getElementById('changeBtn').addEventListener('click', async function () {
    var b = this, n1 = document.getElementById('newPassword').value, n2 = document.getElementById('newPassword2').value;
    if (n1 !== n2) { show('The two new passwords do not match.', 'error'); return; }
    b.disabled = true; b.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      var res = await fetch('/api/platform/auth/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('email').value.trim(), currentPassword: document.getElementById('password').value,
          newPassword: n1, totp: codeField.hidden ? undefined : document.getElementById('totp').value.trim() || undefined }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Could not change the password');
      document.getElementById('password').value = n1;
      show('Password changed.', 'success');
      proceed(data.workspaces || []);
    } catch (err) {
      show(err.message, 'error'); b.disabled = false; b.textContent = 'Set new password and continue';
    }
  });

  function proceed(ws) {
    if (ws.length === 1) { btn.innerHTML = A.icon('check') + ' Welcome back'; open(ws[0]); return; }
    // More than one: let the person choose (nothing is stored until they do).
    document.getElementById('credentials').hidden = true;
    var list = document.getElementById('chooserList');
    list.innerHTML = '';
    ws.forEach(function (w) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-ghost btn-block btn-lg';
      b.textContent = w.label;
      b.addEventListener('click', function () { open(w); });
      list.appendChild(b);
    });
    document.getElementById('chooser').hidden = false;
  }

  function askCode(message, canSkip) {
    codeField.hidden = false;
    var t = document.getElementById('totp');
    t.value = ''; t.required = !canSkip; t.focus();
    skipBtn.hidden = !canSkip;
    show(message, 'warn');
  }
  skipBtn.addEventListener('click', function () { if (pending) proceed(pending); });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    // Enter while choosing a new password saves it (not a second sign-in)
    if (!changeBox.hidden) { document.getElementById('changeBtn').click(); return; }
    box.innerHTML = '';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';
    try {
      var totp = codeField.hidden ? '' : document.getElementById('totp').value.trim();
      var res = await fetch(form.dataset.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('email').value.trim(), password: document.getElementById('password').value, totp: totp || undefined }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 401 && data.code === 'mfa_required') {
        resetButton();
        askCode(totp ? 'That code was not accepted. Enter the current 6-digit code.' : 'Enter the 6-digit code from your authenticator app.', false);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Sign in failed');
      if (data.erpNeedsCode) {
        pending = data.workspaces || [];
        resetButton();
        askCode(totp ? 'That code was not accepted. Try the current code, or continue without the business modules.'
          : 'Password accepted. Enter your 6-digit code to also open the business modules, or continue without them.', true);
        return;
      }
      if (data.mustChangePassword) { pending = data.workspaces || []; resetButton(); askNewPassword(); return; }
      if (data.erpNotice) {
        // The shop part opened but the business part did not: say why before going on.
        pending = data.workspaces || [];
        resetButton();
        show(data.erpNotice, 'warn');
        skipBtn.hidden = false;
        return;
      }
      proceed(data.workspaces || []);
    } catch (err) {
      show(err.message, 'error');
      resetButton();
      if (codeField.hidden) { document.getElementById('password').value = ''; document.getElementById('password').focus(); }
    }
  });
})();
