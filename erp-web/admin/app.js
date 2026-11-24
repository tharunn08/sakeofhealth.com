/* Business platform admin — core screens. All text is inserted with
   textContent; nothing from the server is ever written as HTML. The server
   enforces every permission; the menu only hides what would be refused. */
(function () {
  'use strict';
  var API = '/api/erp/core';
  var state = { token: null, me: null, view: 'overview' };
  try { state.token = sessionStorage.getItem('erp.token'); } catch (e) { /* storage blocked */ }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function api(method, path, body) { return rawApi(method, API + path, body); }
  /** Any /api/erp/... call; body may be FormData (uploads). */
  function rawApi(method, url, body) {
    var h = {};
    var form = typeof FormData !== 'undefined' && body instanceof FormData;
    if (!form) h['Content-Type'] = 'application/json';
    if (state.token) h.Authorization = 'Bearer ' + state.token;
    var path = url;
    return fetch(url, { method: method, headers: h, body: body ? (form ? body : JSON.stringify(body)) : undefined }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && !/\/login$/.test(path)) { logout(); }
        if (!r.ok) { var e = new Error(j.error || ('Request failed (' + r.status + ')')); e.code = j.code; e.status = r.status; e.data = j; throw e; }
        return j;
      });
    });
  }
  function has(p) { return state.me && state.me.permissions.indexOf(p) !== -1; }
  function msg(kind, text) { return el('div', { class: 'msg ' + kind, role: kind === 'err' ? 'alert' : 'status', text: text }); }
  function fmt(d) { if (!d) return '—'; var x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleString(); }
  /* Embedded in the central Admin Panel (window.ERP_EMBED set by /platform/erp-host.js):
     the shell owns sign-in, menu and navigation; this file only draws the one screen. */
  function embed() { return window.ERP_EMBED || null; }
  function logout() {
    state.token = null; state.me = null;
    if (embed()) { embed().onEnded(); return; }
    try { sessionStorage.removeItem('erp.token'); } catch (e) { /* */ } render();
  }
  var root = document.getElementById('app');

  // ── Login ──
  function loginView(error, needCode, keep) {
    var email = el('input', { type: 'email', autocomplete: 'username', required: true, value: keep ? keep.email : false });
    var pw = el('input', { type: 'password', autocomplete: 'current-password', required: true, value: keep ? keep.pw : false });
    var code = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '6-digit code' });
    var form = el('form', { class: 'panel login', on: { submit: function (ev) {
      ev.preventDefault();
      api('POST', '/login', { email: email.value, password: pw.value, totp: code.value || undefined }).then(function (r) {
        state.token = r.token; try { sessionStorage.setItem('erp.token', r.token); } catch (e) { /* */ } boot();
      }).catch(function (e) {
        var mfa = e.code === 'mfa_required';
        root.replaceChildren(loginView(mfa ? 'Enter the 6-digit code from your authenticator app' : e.message, mfa || needCode, mfa ? { email: email.value, pw: pw.value } : { email: email.value, pw: '' }));
        var c = root.querySelector('input[autocomplete=one-time-code]'); if (mfa && c) c.focus();
      });
    } } }, [
      el('h1', { text: 'Business platform sign-in' }),
      error ? msg('err', error) : null,
      el('label', {}, ['E-mail', email]), el('label', {}, ['Password', pw]),
      needCode ? el('label', {}, ['Authenticator code', code]) : null,
      el('button', { class: 'btn primary', type: 'submit', text: 'Sign in' }),
      el('p', { class: 'note', text: 'This is separate from the online-shop admin login.' })
    ]);
    return form;
  }

  // ── Views ──
  var VIEWS = [
    { id: 'overview', label: 'Overview', perm: 'core.monitoring.view', render: overview },
    { id: 'approvals', label: 'Approvals', perm: 'core.approvals.view', render: approvalsView },
    { id: 'decisions', label: 'Business decisions', perm: 'core.settings.view', render: decisionsView },
    { id: 'staff', label: 'Staff & roles', perm: 'core.staff.view', render: staffView },
    { id: 'audit', label: 'Audit log', perm: 'core.audit.view', render: auditView },
    { id: 'account', label: 'My account', perm: 'core.self.view', render: accountView }
  ];

  function overview(main) {
    main.appendChild(el('h1', { text: 'Overview' }));
    api('GET', '/monitoring').then(function (s) {
      var q = s.notificationQueue || {}, j = s.jobs || {}, bg = s.backgroundJobs || {};
      if (bg.warning) main.appendChild(msg('err', bg.warning));
      main.appendChild(el('div', { class: 'grid' }, [
        kpi('Background jobs', (bg.mode === 'cron' ? 'Hostinger Cron Jobs' : 'in the web process') + (bg.lastCronRun ? ' · last run ' + fmt(bg.lastCronRun.at) + (bg.lastCronRun.status === 'done' ? '' : ' (problem)') : '')),
        kpi('Database', s.database), kpi('Open critical events', String(s.openCritical)),
        kpi('Messages failed / skipped', (q.failed || 0) + ' / ' + (q.skipped_no_provider || 0)), kpi('Jobs failed', String(j.failed || 0)),
        kpi('Last backup (worker)', s.lastBackup.at ? fmt(s.lastBackup.at) : s.lastBackup.status), kpi('Stock reconciliation', typeof s.inventoryReconciliation === 'string' ? s.inventoryReconciliation : (s.inventoryReconciliation.result ? s.inventoryReconciliation.result.issues + ' issue(s) · ' + fmt(s.inventoryReconciliation.at) : s.inventoryReconciliation.status))
      ]));
      var t = table(['Category', 'Event', 'Last 24 h'], (s.events24h || []).map(function (e) { return [e.category, e.code, String(e.count)]; }));
      main.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Events in the last 24 hours' }), t]));
      main.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Database migrations applied' }), el('p', { class: 'note', text: (s.migrations || []).join(' · ') })]));
    }).catch(function (e) { main.appendChild(msg('err', e.message)); });
  }
  function kpi(l, v) { return el('div', { class: 'panel kpi' }, [el('div', { class: 'l', text: l }), el('div', { class: 'v', text: v == null ? '—' : String(v) })]); }
  function table(head, rows) {
    return el('div', { class: 'table-wrap' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, head.map(function (x) { return el('th', { scope: 'col', text: x }); }))]),
      el('tbody', {}, rows.length ? rows.map(function (r) { return el('tr', {}, r.map(function (c) { return el('td', {}, [typeof c === 'string' ? c : c]); })); })
        : [el('tr', {}, [el('td', { colspan: String(head.length), class: 'note', text: 'Nothing here.' })])])
    ])]);
  }

  function approvalsView(main) {
    main.appendChild(el('h1', { text: 'Approvals waiting for you' }));
    main.appendChild(el('p', { class: 'note', text: 'Requests you raised yourself never appear here. Approving needs two-factor sign-in.' }));
    var box = el('div'); main.appendChild(box);
    api('GET', '/approvals').then(function (r) {
      box.appendChild(table(['Request', 'Raised by', 'Reason', 'Details', 'Step', ''], r.items.map(function (a) {
        var comment = el('input', { 'aria-label': 'Comment for request ' + a.id, placeholder: 'Comment' });
        var act = function (d) { return function () {
          api('POST', '/approvals/' + a.id + '/decide', { decision: d, comment: comment.value }).then(function () { show('approvals'); })
            .catch(function (e) { box.prepend(msg('err', e.message)); });
        }; };
        return [a.type + ' #' + a.id + (a.ruleConfigured ? '' : ' (no threshold set — Super Admin)'), a.requestedBy + ' · ' + fmt(a.requestedAt), a.reason,
          el('pre', { text: JSON.stringify(a.details, null, 1) }), a.step + ' of ' + a.stepsRequired,
          el('div', { class: 'row' }, [comment, el('button', { class: 'btn primary', type: 'button', text: 'Approve', on: { click: act('approved') } }),
            el('button', { class: 'btn danger', type: 'button', text: 'Reject', on: { click: act('rejected') } })])];
      })));
    }).catch(function (e) { box.appendChild(msg('err', e.message)); });
  }

  function decisionsView(main) {
    main.appendChild(el('h1', { text: 'Business decisions' }));
    main.appendChild(el('p', { class: 'note', text: 'Nothing here is applied until it is decided and approved by a second person. Until then the platform uses the safe behaviour shown.' }));
    var box = el('div'); main.appendChild(box);
    api('GET', '/settings/pending-decisions').then(function (r) {
      box.appendChild(table(['Decision', 'Setting', 'Status', 'Value', 'Until decided'], r.items.map(function (s) {
        var cell = el('div', { class: 'row' }, [el('span', { text: s.value == null ? '—' : JSON.stringify(s.value) })]);
        if (has('core.settings.edit')) {
          var v = el('input', { 'aria-label': 'New value for ' + s.key, placeholder: s.proposal == null ? 'JSON value' : 'e.g. ' + JSON.stringify(s.proposal) });
          var why = el('input', { 'aria-label': 'Reason for ' + s.key, placeholder: 'Reason' });
          cell.appendChild(v); cell.appendChild(why);
          cell.appendChild(el('button', { class: 'btn', type: 'button', text: 'Request change', on: { click: function () {
            var val; try { val = JSON.parse(v.value); } catch (e) { cell.appendChild(msg('err', 'Enter a JSON value, e.g. 60, true or "text"')); return; }
            api('PUT', '/settings/' + encodeURIComponent(s.key), { value: val, reason: why.value }).then(function () { cell.appendChild(msg('ok', 'Sent for approval')); })
              .catch(function (e) { cell.appendChild(msg('err', e.message)); });
          } } }));
        }
        return [s.decision, s.key, el('span', { class: 'tag ' + (s.status === 'decided' ? 'ok' : 'pending'), text: s.status.replace(/_/g, ' ') }), cell, s.whileUnset];
      })));
    }).catch(function (e) { box.appendChild(msg('err', e.message)); });
  }

  function staffView(main) {
    main.appendChild(el('h1', { text: 'Staff & roles' }));
    var box = el('div'); main.appendChild(box);
    Promise.all([api('GET', '/staff'), has('core.roles.view') ? api('GET', '/roles') : Promise.resolve({ items: [] })]).then(function (res) {
      var roles = res[1].items;
      box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'People' }), table(['Name', 'E-mail', 'Roles', 'Status', 'MFA', 'Last login', ''], res[0].items.map(function (s) {
        var act = el('div', { class: 'row' });
        if (has('core.staff.edit') && s.status === 'active' && s.id !== state.me.id) act.appendChild(el('button', { class: 'btn danger', type: 'button', text: 'Disable', on: { click: function () {
          api('PATCH', '/staff/' + s.id, { status: 'disabled', reason: 'Disabled from staff screen' }).then(function () { show('staff'); }).catch(function (e) { act.appendChild(msg('err', e.message)); });
        } } }));
        if (has('core.roles.edit') && roles.length) {
          var sel = el('select', { 'aria-label': 'Role to grant to ' + s.name }, roles.map(function (r) { return el('option', { value: String(r.id), text: r.name }); }));
          var why = el('input', { 'aria-label': 'Reason', placeholder: 'Reason' });
          act.appendChild(sel); act.appendChild(why);
          act.appendChild(el('button', { class: 'btn', type: 'button', text: 'Request role', on: { click: function () {
            api('POST', '/staff/' + s.id + '/roles', { roleId: Number(sel.value), scopeType: 'all', reason: why.value }).then(function () { act.appendChild(msg('ok', 'Sent for approval')); })
              .catch(function (e) { act.appendChild(msg('err', e.message)); });
          } } }));
        }
        return [s.name, s.email, s.roles.join(', ') || '—', s.status, s.mfa_enabled ? 'on' : 'off', fmt(s.last_login_at), act];
      }))]));
      if (has('core.staff.create')) {
        var n = el('input', { 'aria-label': 'Name' }), e = el('input', { type: 'email', 'aria-label': 'E-mail' }), m = el('input', { inputmode: 'numeric', 'aria-label': 'Mobile' }),
          p = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Initial password' }), out = el('div');
        box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Add a staff member' }), el('div', { class: 'row' }, [
          el('label', {}, ['Name', n]), el('label', {}, ['E-mail', e]), el('label', {}, ['Mobile (optional)', m]), el('label', {}, ['Initial password (12+ characters)', p]),
          el('button', { class: 'btn primary', type: 'button', text: 'Add', on: { click: function () {
            api('POST', '/staff', { name: n.value, email: e.value, mobile: m.value || null, password: p.value }).then(function () { show('staff'); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
          } } })]), out, el('p', { class: 'note', text: 'New people have no access until a role is granted and approved.' })]));
      }
      if (roles.length) box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Roles' }), table(['Role', 'Type', 'Permissions'], roles.map(function (r) {
        return [r.name, r.is_system ? 'system' : 'custom', el('pre', { text: r.permissions.join('\n') || '—' })];
      }))]));
    }).catch(function (e) { box.appendChild(msg('err', e.message)); });
  }

  function auditView(main) {
    main.appendChild(el('h1', { text: 'Audit log' }));
    var status = el('div'); main.appendChild(status);
    var btn = el('button', { class: 'btn', type: 'button', text: 'Verify tamper-evidence chain', on: { click: function () {
      btn.disabled = true;
      api('GET', '/audit/verify').then(function (r) {
        status.replaceChildren(r.ok ? msg('ok', 'Chain intact — ' + r.checked + ' rows checked') : msg('err', 'Chain broken at row ' + r.brokenAt + ': ' + r.reason));
      }).catch(function (e) { status.replaceChildren(msg('err', e.message)); }).then(function () { btn.disabled = false; });
    } } });
    main.appendChild(btn);
    var box = el('div'); main.appendChild(box);
    api('GET', '/audit?limit=100').then(function (r) {
      box.appendChild(table(['When', 'Who', 'Action', 'Record', 'Before → after', 'Reason'], r.items.map(function (a) {
        return [fmt(a.created_at), (a.actor_label || a.actor_type) + (a.actor_role ? ' (' + a.actor_role + ')' : ''), (a.module ? a.module + ': ' : '') + a.action,
          a.entity + (a.entity_id ? ' #' + a.entity_id : ''), el('pre', { text: (a.old_value || '') + (a.new_value ? '\n→ ' + a.new_value : '') }), a.reason || ''];
      })));
    }).catch(function (e) { box.appendChild(msg('err', e.message)); });
  }

  function accountView(main) {
    main.appendChild(el('h1', { text: 'My account' }));
    var out = el('div'); main.appendChild(out);
    var cur = el('input', { type: 'password', autocomplete: 'current-password' }), nw = el('input', { type: 'password', autocomplete: 'new-password' });
    main.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Password' }), el('div', { class: 'row' }, [el('label', {}, ['Current password', cur]), el('label', {}, ['New password (12+ characters)', nw]),
      el('button', { class: 'btn', type: 'button', text: 'Change', on: { click: function () {
        api('POST', '/me/password', { currentPassword: cur.value, newPassword: nw.value }).then(function () { logout(); }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
      } } })])]));
    var mfaBox = el('section', { class: 'panel' }, [el('h2', { text: 'My two-step sign-in' })]);
    var siteBox = el('section', { class: 'panel' }, [el('h2', { text: 'Two-step sign-in for everyone' })]);
    main.appendChild(mfaBox); main.appendChild(siteBox);
    api('GET', '/security/mfa').then(function (st) { drawOwn(st); drawSite(st); })
      .catch(function (e) { siteBox.appendChild(msg('err', e.message)); });

    // Own authenticator: set up once; asked for at sign-in only while the site switch is on.
    function drawOwn(st) {
      if (state.me.mfa) { mfaBox.appendChild(msg('ok', 'On: you signed in with your 6-digit code.')); return; }
      if (st.ownAuthenticator) {
        mfaBox.appendChild(el('p', { class: 'note', text: st.required
          ? 'Your authenticator is set up. Sign out and sign in again with your 6-digit code to approve or change sensitive settings.'
          : 'Your authenticator is set up. It is not asked for while two-step sign-in is switched off for everyone.' }));
        return;
      }
      mfaBox.appendChild(el('p', { class: 'note', text: 'Set up an authenticator app on your phone. It is needed before two-step sign-in can be switched on for everyone.' }));
      mfaBox.appendChild(el('button', { class: 'btn primary', type: 'button', text: 'Set up', on: { click: function () {
        api('POST', '/me/mfa/setup').then(function (r) {
          var code = el('input', { inputmode: 'numeric', maxlength: '6', 'aria-label': 'Code from the app' });
          mfaBox.appendChild(el('p', { text: 'Add this key to an authenticator app (Google Authenticator, Microsoft Authenticator…):' }));
          mfaBox.appendChild(el('pre', { text: r.secret + '\n' + r.otpauth }));
          mfaBox.appendChild(el('div', { class: 'row' }, [el('label', {}, ['6-digit code', code]), el('button', { class: 'btn primary', type: 'button', text: 'Turn on', on: { click: function () {
            api('POST', '/me/mfa/enable', { code: code.value }).then(function () { logout(); }).catch(function (e) { mfaBox.appendChild(msg('err', e.message)); });
          } } })]));
        }).catch(function (e) { mfaBox.appendChild(msg('err', e.message)); });
      } } }));
    }

    // The site-wide switch (Super Admin). Every change is written to the audit log.
    function drawSite(st) {
      siteBox.replaceChildren(el('h2', { text: 'Two-step sign-in for everyone' }));
      siteBox.appendChild(el('p', { text: st.required
        ? 'ON — staff who set up an authenticator must enter the 6-digit code at sign-in, and approvals and sensitive actions need it.'
        : 'OFF — nobody is asked for a code at sign-in, and no action needs one.' }));
      var src = { server: 'Fixed by the server setting ERP_MFA_REQUIRED in Hostinger. Remove that setting there to use this switch.',
        'default': 'It has never been switched, so it is off.',
        'fail-safe': 'The settings could not be read, so it is on for safety.' }[st.source];
      if (st.source === 'switch') src = 'Last changed' + (st.changedBy ? ' by ' + st.changedBy : '') + (st.changedAt ? ' on ' + fmt(st.changedAt) : '') + '.';
      if (src) siteBox.appendChild(el('p', { class: 'note', text: src }));
      if (!st.canChange) return;
      var turnOn = !st.required;
      if (turnOn && !st.ownAuthenticator) {
        siteBox.appendChild(el('p', { class: 'note', text: 'To switch it on, first set up your own authenticator above, so you can still sign in and switch it off later.' }));
        return;
      }
      if (!turnOn && !st.sessionHasCode) {
        siteBox.appendChild(el('p', { class: 'note', text: 'To switch it off, sign out and sign in again with your 6-digit code.' }));
        return;
      }
      var why = el('input', { 'aria-label': 'Reason', placeholder: 'Reason (optional)' }), out = el('div');
      siteBox.appendChild(el('div', { class: 'row' }, [why, el('button', { class: turnOn ? 'btn primary' : 'btn danger', type: 'button',
        text: turnOn ? 'Switch on for everyone' : 'Switch off for everyone', on: { click: function () {
          api('PUT', '/security/mfa', { required: turnOn, reason: why.value }).then(function () {
            return api('GET', '/security/mfa').then(function (st2) {
              drawSite(st2);
              siteBox.appendChild(msg('ok', turnOn ? 'Switched on. Sign out and sign in again with your code before approving anything.' : 'Switched off. Nobody is asked for a code now.'));
            });
          }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
        } } })]));
      siteBox.appendChild(out);
    }
  }

  function show(id) {
    if (embed()) { embed().navigate(id); return; }
    state.view = id; render();
  }
  // Module screens (modules.js) register here; they use the same helpers and the same server checks.
  window.ERP = { el: el, api: rawApi, msg: msg, fmt: fmt, table: table, kpi: kpi, has: has, show: show, state: state };
  window.ERP_VIEWS = window.ERP_VIEWS || [];
  function renderEmbedded() {
    var E = embed(), all = VIEWS.concat(window.ERP_VIEWS || []);
    var v = all.find(function (x) { return x.id === E.view; });
    var main = el('div', { class: 'erp-main' });
    if (!v) main.appendChild(msg('err', 'Unknown screen.'));
    else if (!has(v.perm)) main.appendChild(msg('err', 'You do not have permission to open this screen.'));
    else {
      if (!state.me.roles.length) main.appendChild(msg('warn', 'You have no role yet. Ask an administrator to grant one (it needs a second person to approve).'));
      v.render(main);
    }
    E.container.replaceChildren(main);
  }
  function render() {
    if (embed()) { if (state.me) renderEmbedded(); return; }
    if (!state.token || !state.me) { root.replaceChildren(loginView()); return; }
    var all = VIEWS.slice(0, VIEWS.length - 1).concat(window.ERP_VIEWS || []).concat([VIEWS[VIEWS.length - 1]]);
    var allowed = all.filter(function (v) { return has(v.perm); });
    if (!allowed.some(function (v) { return v.id === state.view; })) state.view = allowed.length ? allowed[0].id : 'account';
    var nav = el('nav', { class: 'side', 'aria-label': 'Sections' }, [el('div', { class: 'brand', text: 'Sake of Health · Business' })]
      .concat(allowed.map(function (v) { return el('button', { type: 'button', 'aria-current': v.id === state.view ? 'page' : false, text: v.label, on: { click: function () { show(v.id); } } }); }))
      .concat([el('div', { class: 'who' }, [state.me.name + ' · ' + (state.me.roles.join(', ') || 'no role yet') + ' · ', el('a', { href: '#', text: 'Sign out', on: { click: function (e) { e.preventDefault(); logout(); } } })])]));
    var main = el('main', { id: 'main' });
    if (!state.me.roles.length) main.appendChild(msg('warn', 'You have no role yet. Ask an administrator to grant one (it needs a second person to approve).'));
    var v = all.find(function (x) { return x.id === state.view; });
    if (v && has(v.perm)) v.render(main);
    root.replaceChildren(el('div', { class: 'shell' }, [nav, main]));
  }
  function boot() {
    if (embed()) {
      state.token = embed().token;
      if (!state.token) { embed().onEnded(); return; }
      api('GET', '/me').then(function (me) { state.me = me; render(); }).catch(function (e) { if (e.status !== 401) embed().onError(e); });
      return;
    }
    if (!state.token) { render(); return; }
    api('GET', '/me').then(function (me) { state.me = me; render(); }).catch(function () { logout(); });
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
