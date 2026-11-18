/* Business portal — login and registration */
(function () {
  'use strict';
  var KEY = 'soh_b2b';
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var qs = new URLSearchParams(location.search);
  var role = qs.get('type') === 'distributor' ? 'distributor' : 'retailer';
  var msg = $('#msg'), form = $('#form');
  function alertBox(text, kind) { msg.innerHTML = text ? '<div class="alert ' + (kind || 'err') + '">' + esc(text) + '</div>' : ''; }

  function setRole(r) {
    role = r;
    document.querySelectorAll('[data-role]').forEach(function (b) { b.classList.toggle('on', b.dataset.role === r); });
    var reg = $('#regLink'); if (reg) reg.href = '/b2b/register?type=' + r;
    if (isRegister) buildForm();
  }
  document.querySelectorAll('[data-role]').forEach(function (b) { b.addEventListener('click', function () { setRole(b.dataset.role); }); });
  var isRegister = !!$('#box');

  /* ─────────── Login ─────────── */
  if (!isRegister) {
    try { if (JSON.parse(localStorage.getItem(KEY) || 'null')) { /* already signed in → the app validates the session */ location.replace('/b2b/dashboard'); return; } } catch (e) { /* ignore */ }
    if (qs.get('expired')) alertBox('Your session has ended. Please log in again.', 'warn');
    if (qs.get('registered')) alertBox('Registration received. You can log in to check your approval status.', 'ok');
    setRole(role);
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = $('#go'); alertBox('');
      btn.disabled = true; btn.textContent = 'Logging in…';
      try {
        var res = await fetch('/api/b2b/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: $('#identifier').value.trim(), password: $('#password').value, role: role }) });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || 'Login failed');
        localStorage.setItem(KEY, JSON.stringify({ token: data.token, user: data.user }));
        location.href = '/b2b/dashboard';
      } catch (err) { alertBox(err.message); btn.disabled = false; btn.textContent = 'Log in'; $('#password').value = ''; }
    });
    return;
  }

  /* ─────────── Registration ─────────── */
  var cfg = { businessTypes: [], requiredDocuments: { retailer: ['shop_proof'], distributor: ['gst_certificate', 'business_proof', 'address_proof'] }, documentLabels: {}, maxUploadMb: 5 };
  var states = [];
  var saved = {};   // keeps what the user typed when they switch Retailer ⇄ Distributor

  function f(id, label, attrs, hint, req) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + (req ? ' *' : '') + '</label><input class="in" id="' + id + '" name="' + id + '" value="' + esc(saved[id] || '') + '" ' + (attrs || '') + '/>' +
      (hint ? '<div class="hint">' + esc(hint) + '</div>' : '') + '<div class="err" data-err="' + id + '"></div></div>';
  }
  function fileField(id, label, req) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + (req ? ' *' : ' (optional)') + '</label><div class="file"><input type="file" id="' + id + '" name="' + id + '" accept=".pdf,.jpg,.jpeg,.png,.webp"/></div>' +
      '<div class="err" data-err="' + id + '"></div></div>';
  }

  function buildForm() {
    form.querySelectorAll('input:not([type=file]):not([type=password]),select').forEach(function (el) { saved[el.id] = el.value; });
    var d = role === 'distributor', req = cfg.requiredDocuments[role] || [];
    var docs = ['gst_certificate', 'business_proof', 'address_proof', 'shop_proof', 'pan_card'].filter(function (k) { return d ? k !== 'shop_proof' : (k === 'shop_proof' || k === 'gst_certificate' || k === 'pan_card'); });
    var label = { gst_certificate: 'GST certificate', business_proof: 'Business proof (incorporation / trade licence)', address_proof: 'Address proof', shop_proof: 'Shop / business proof (licence, shop photo with board)', pan_card: 'PAN card' };
    form.innerHTML =
      '<div class="sect">Business</div><div class="frow">' +
        f(d ? 'distributor_name' : 'retailer_name', d ? 'Distributor name' : 'Retailer name', 'maxlength="160" autocomplete="organization"', d ? 'Legal name as on your GST certificate' : 'Your name or the owner’s firm name', true) +
        (d ? '' : f('shop_name', 'Shop name', 'maxlength="160"', 'As written on your shop board', true)) +
        f('contact_person', 'Contact person', 'maxlength="120" autocomplete="name"', '', true) +
        '<div class="field"><label for="business_type">Business type' + (d ? ' *' : '') + '</label><select class="sel" id="business_type" name="business_type"><option value="">Select…</option>' +
          cfg.businessTypes.map(function (t) { return '<option' + (saved.business_type === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select><div class="err" data-err="business_type"></div></div>' +
        f('mobile', 'Mobile number', 'inputmode="numeric" maxlength="10" autocomplete="tel-national" placeholder="10-digit mobile"', 'Used for login and order updates on WhatsApp', true) +
        f('email', 'Email', 'type="email" autocomplete="email"', '', true) +
        f('gstin', 'GSTIN', 'maxlength="15" style="text-transform:uppercase" placeholder="29ABCDE1234F1Z5"', d ? '' : 'If you are GST registered', d) +
        f('pan', 'PAN', 'maxlength="10" style="text-transform:uppercase" placeholder="ABCDE1234F"', d ? '' : 'If available', d) +
      '</div>' +
      '<div class="sect">Address</div>' + f('address', 'Address', 'maxlength="200" autocomplete="street-address" placeholder="Door no, street, area"', '', true) +
      '<div class="frow">' + f('landmark', 'Landmark', 'maxlength="160"', 'Helps the delivery person find you') +
        '<div class="field"><label for="state_id">State *</label><select class="sel" id="state_id" name="state_id">' + states.map(function (s) { return '<option value="' + s.id + '"' + (String(saved.state_id || '') === String(s.id) ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select><div class="err" data-err="state_id"></div></div>' +
        '<div class="field"><label for="district_id">District *</label><span id="distWrap"></span><div class="err" data-err="district"></div></div>' +
        f('city', 'City / town', 'maxlength="80" autocomplete="address-level2"', '', true) +
        f('pincode', 'Pincode', 'inputmode="numeric" maxlength="6" autocomplete="postal-code"', '', true) +
      '</div>' +
      '<div class="field"><label>Shop location on the map</label><div class="btn-row"><button type="button" class="btn" id="locBtn">Use my current location</button><span class="muted small" id="locMsg" style="align-self:center">' +
        (saved.latitude ? 'Location saved: ' + esc(saved.latitude) + ', ' + esc(saved.longitude) : 'Stand at your shop and tap the button — it helps us match you to the nearest distributor.') + '</span></div>' +
        '<input type="hidden" id="latitude" name="latitude" value="' + esc(saved.latitude || '') + '"/><input type="hidden" id="longitude" name="longitude" value="' + esc(saved.longitude || '') + '"/><div class="err" data-err="latitude"></div></div>' +
      '<div class="sect">Documents</div><p class="muted small" style="margin-bottom:12px">PDF, JPG, PNG or WEBP, up to ' + cfg.maxUploadMb + ' MB each. Documents are stored privately and only seen by our verification team.</p>' +
      '<div class="frow">' + docs.map(function (k) { return fileField(k, label[k], req.indexOf(k) !== -1); }).join('') + '</div>' +
      '<div class="sect">Password</div><div class="frow">' +
        '<div class="field"><label for="password">Password *</label><input class="in" id="password" name="password" type="password" autocomplete="new-password" minlength="8"/><div class="hint">At least 8 characters, with a letter and a number</div><div class="err" data-err="password"></div></div>' +
        '<div class="field"><label for="confirm_password">Confirm password *</label><input class="in" id="confirm_password" name="confirm_password" type="password" autocomplete="new-password"/><div class="err" data-err="confirm_password"></div></div>' +
      '</div><button class="btn pri lg block" id="go" type="submit">Submit registration</button>' +
      '<p class="small muted" style="margin-top:10px;text-align:center">You cannot order until your account is approved.</p>';
    $('#state_id').addEventListener('change', loadDistricts);
    loadDistricts();
    $('#locBtn').addEventListener('click', function () {
      var m = $('#locMsg');
      if (!navigator.geolocation) { m.textContent = 'Your browser cannot share location. You can skip this.'; return; }
      m.textContent = 'Finding your location…';
      navigator.geolocation.getCurrentPosition(function (p) {
        $('#latitude').value = p.coords.latitude.toFixed(7); $('#longitude').value = p.coords.longitude.toFixed(7);
        m.textContent = 'Location saved (accurate to about ' + Math.round(p.coords.accuracy) + ' m).';
      }, function () { m.textContent = 'Could not get your location. You can skip this and continue.'; }, { enableHighAccuracy: true, timeout: 12000 });
    });
  }

  async function loadDistricts() {
    var wrap = $('#distWrap'), stateId = $('#state_id').value;
    var list = [];
    try { list = (await (await fetch('/api/b2b/geo/districts?state_id=' + encodeURIComponent(stateId))).json()).districts || []; } catch (e) { /* fall back to free text */ }
    wrap.innerHTML = list.length
      ? '<select class="sel" id="district_id" name="district_id"><option value="">Select…</option>' + list.map(function (x) { return '<option value="' + x.id + '"' + (String(saved.district_id || '') === String(x.id) ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select>'
      : '<input class="in" id="district" name="district" maxlength="80" placeholder="District name" value="' + esc(saved.district || '') + '"/>';
  }

  function showErrors(fields) {
    form.querySelectorAll('[data-err]').forEach(function (e) { e.textContent = ''; });
    form.querySelectorAll('.bad').forEach(function (e) { e.classList.remove('bad'); });
    var alias = { business_name: role === 'distributor' ? 'distributor_name' : 'retailer_name', district: 'district' };
    var first = null;
    Object.keys(fields || {}).forEach(function (k) {
      var id = alias[k] || k, slot = form.querySelector('[data-err="' + id + '"]'), input = document.getElementById(id === 'district' ? (document.getElementById('district_id') ? 'district_id' : 'district') : id);
      if (slot) slot.textContent = fields[k];
      if (input) { input.classList.add('bad'); first = first || input; }
    });
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('#go'); alertBox('');
    var fd = new FormData(form);
    // Drop empty file inputs so the server sees only real uploads.
    form.querySelectorAll('input[type=file]').forEach(function (i) { if (!i.files.length) fd.delete(i.name); else if (i.files[0].size > cfg.maxUploadMb * 1048576) fd.set('__too_big', i.name); });
    if (fd.get('__too_big')) { var o = {}; o[fd.get('__too_big')] = 'This file is larger than ' + cfg.maxUploadMb + ' MB'; showErrors(o); return; }
    btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      var res = await fetch('/api/b2b/auth/register/' + role, { method: 'POST', body: fd });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) { showErrors(data.fields); throw new Error(data.error || 'Registration failed'); }
      localStorage.setItem(KEY, JSON.stringify({ token: data.token, user: data.user }));
      $('#box').innerHTML = '<div class="alert ok" style="font-size:15px"><b>Registration received.</b><br/>' + esc(data.message) + '</div>' +
        '<p style="margin:14px 0">We will notify you by email and WhatsApp as soon as your account is approved. You can check the status any time.</p>' +
        '<a class="btn pri lg block" href="/b2b/dashboard">View my application status</a>';
      window.scrollTo(0, 0);
    } catch (err) { alertBox(err.message); btn.disabled = false; btn.textContent = 'Submit registration'; if (!form.querySelector('.bad')) window.scrollTo(0, 0); }
  });

  Promise.all([
    fetch('/api/b2b/config').then(function (r) { return r.json(); }).then(function (c) { if (c && c.businessTypes) cfg = c; }).catch(function () {}),
    fetch('/api/b2b/geo/states').then(function (r) { return r.json(); }).then(function (d) { states = d.states || []; }).catch(function () {}),
  ]).then(function () {
    if (!states.length) alertBox('The registration form could not be loaded. Please try again in a moment.');
    setRole(role);
  });
})();
