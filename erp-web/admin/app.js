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
    var t = el('table', {}, [
      el('thead', {}, [el('tr', {}, head.map(function (x) { return el('th', { scope: 'col', text: x }); }))]),
      el('tbody', {}, rows.length ? rows.map(function (r) { return el('tr', {}, r.map(function (c) { return el('td', {}, [typeof c === 'string' ? c : c]); })); })
        : [el('tr', {}, [el('td', { colspan: String(head.length), class: 'note', text: 'Nothing here.' })])])
    ]);
    var wrap = el('div', { class: 'table-wrap' }, [t]);
    if (!rows.length || typeof Blob === 'undefined') return wrap;
    // Download what is on screen. Cells are read when the button is pressed, so later updates are included.
    function grid() {
      var cols = head.map(function (h, i) { return i; }).filter(function (i) { return String(head[i] || '').trim() !== ''; });   // action columns have no heading
      var body = Array.prototype.map.call(t.tBodies[0].rows, function (tr) { return cols.map(function (i) { return tr.cells[i] ? Exports.cellText(tr.cells[i]) : ''; }); });
      return [cols.map(function (i) { return String(head[i]); })].concat(body);
    }
    function name() {
      var h = wrap.closest && wrap.closest('section') && wrap.closest('section').querySelector('h2,h3');
      var top = document.querySelector('main h1, .erp-main h1');
      return Exports.fileName((h && h.textContent) || (top && top.textContent) || 'export');
    }
    // Longer tables: a search box that hides rows without the words, and click a heading to sort.
    var search = null;
    if (rows.length > 8) {
      search = el('input', { type: 'search', placeholder: 'Search this table', 'aria-label': 'Search this table', class: 'table-search' });
      search.addEventListener('input', function () {
        var words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
        Array.prototype.forEach.call(t.tBodies[0].rows, function (tr) { var txt = tr.textContent.toLowerCase(); tr.hidden = !words.every(function (w) { return txt.indexOf(w) !== -1; }); });
      });
    }
    Array.prototype.forEach.call(t.tHead.rows[0].cells, function (th, i) {
      if (!String(head[i] || '').trim()) return;
      th.style.cursor = 'pointer'; th.title = 'Sort by ' + head[i];
      th.addEventListener('click', function () {
        var dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
        Array.prototype.forEach.call(t.tHead.rows[0].cells, function (o) { o.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        var key = function (tr) { var v = Exports.cellText(tr.cells[i] || { childNodes: [] }), n = Number(v.replace(/[₹,%\s]|days?/g, '')); return v !== '' && isFinite(n) && /\d/.test(v) ? n : v.toLowerCase(); };
        var list = Array.prototype.slice.call(t.tBodies[0].rows);
        list.sort(function (x, y) { var a = key(x), b = key(y); if (typeof a === typeof b) return (a > b ? 1 : a < b ? -1 : 0) * dir; return (typeof a === 'number' ? -1 : 1) * dir; });
        list.forEach(function (tr) { t.tBodies[0].appendChild(tr); });
      });
    });
    var bar = el('div', { class: 'table-tools' }, [search, el('span', { class: 'note', text: 'Download:' }),
      el('button', { class: 'linkish', type: 'button', text: 'CSV', 'aria-label': 'Download this table as CSV', on: { click: function () { Exports.save(Exports.csv(grid()), name() + '.csv', 'text/csv;charset=utf-8'); } } }),
      el('button', { class: 'linkish', type: 'button', text: 'Excel', 'aria-label': 'Download this table as an Excel file', on: { click: function () {
        Exports.save(Exports.xlsx(grid()), name() + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); } } })]);
    return el('div', {}, [bar, wrap]);
  }

  /** CSV and real .xlsx files made in the browser from the table on screen; nothing is sent to the server. */
  var Exports = (function () {
    function cellText(td) {
      var parts = [];
      td.childNodes.forEach(function (n) { if (n.nodeType === 3) parts.push(n.textContent); else if (!/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(n.tagName)) parts.push(n.textContent); else if (n.tagName === 'SELECT' && n.selectedOptions && n.selectedOptions[0]) parts.push(n.selectedOptions[0].text); });
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }
    function guard(v) { var s = String(v == null ? '' : v); return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s; }   // no formulas from data
    function csv(rows) {
      return '\ufeff' + rows.map(function (r) { return r.map(function (v) { var s = guard(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(','); }).join('\r\n') + '\r\n';
    }
    function x(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
    function colName(i) { var n = ''; i += 1; while (i > 0) { var m = (i - 1) % 26; n = String.fromCharCode(65 + m) + n; i = Math.floor((i - 1) / 26); } return n; }
    function sheet(rows) {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        rows.map(function (r, ri) {
          return '<row r="' + (ri + 1) + '">' + r.map(function (v, ci) {
            var ref = colName(ci) + (ri + 1), s = String(v == null ? '' : v), num = s.replace(/[,₹\s]/g, '');
            if (ri > 0 && /^-?\d+(\.\d+)?$/.test(num) && num.length < 16 && !/^0\d/.test(num)) return '<c r="' + ref + '"><v>' + num + '</v></c>';
            return '<c r="' + ref + '" t="inlineStr"' + (ri === 0 ? ' s="1"' : '') + '><is><t xml:space="preserve">' + x(s) + '</t></is></c>';
          }).join('') + '</row>';
        }).join('') + '</sheetData></worksheet>';
    }
    var CRC = (function () { var t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
    function zip(files) {   // stored (no compression): every spreadsheet program reads it
      var enc = new TextEncoder(), out = [], dir = [], off = 0;
      function u16(v) { return [v & 255, (v >>> 8) & 255]; }
      function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
      files.forEach(function (f) {
        var nm = enc.encode(f[0]), data = enc.encode(f[1]), c = crc32(data);
        var head = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(c), u32(data.length), u32(data.length), u16(nm.length), u16(0));
        out.push(new Uint8Array(head), nm, data);
        dir.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(c), u32(data.length), u32(data.length),
          u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off))), nm);
        off += head.length + nm.length + data.length;
      });
      var size = dir.reduce(function (a, d) { return a + d.length; }, 0);
      var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(size), u32(off), u16(0)));
      return out.concat(dir, [end]);
    }
    function xlsx(rows) {
      return zip([
        ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
        ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
        ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
        ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
        ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
        ['xl/worksheets/sheet1.xml', sheet(rows)]
      ]);
    }
    function fileName(t) { return (String(t).trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'export') + '-' + new Date().toISOString().slice(0, 10); }
    function save(parts, filename, type) {
      var blob = new Blob(typeof parts === 'string' ? [parts] : parts, { type: type });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    return { cellText: cellText, csv: csv, xlsx: xlsx, zip: zip, crc32: crc32, fileName: fileName, save: save, guard: guard };
  })();

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
    var second = el('div'); main.appendChild(second);
    var box = el('div'); main.appendChild(box);
    // The second Super Admin: offered only while fewer than two exist (approvals need two people).
    api('GET', '/staff-super-admins').then(function (sa) {
      if (!sa.canAddSecond) return;
      var f = { name: el('input', { autocomplete: 'off' }), email: el('input', { type: 'email', autocomplete: 'off' }),
        password: el('input', { type: 'password', autocomplete: 'new-password', minlength: '12' }),
        confirmPassword: el('input', { type: 'password', autocomplete: 'new-password', minlength: '12' }), reason: el('input', { placeholder: 'Optional' }) };
      var out = el('div');
      second.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Add the second Super Admin' }),
        el('p', { class: 'note', text: 'You are the only Super Admin, and nobody can approve their own request. Ordinary roles you can give yourself below; ' +
          'giving the Super Admin role, and other admin-level changes, needs a second Super Admin. Add one here, a person you trust. ' +
          'Their password must be at least 12 characters; they choose their own at first sign-in. This is recorded in the audit log.' }),
        el('div', { class: 'row' }, [el('label', {}, ['Name', f.name]), el('label', {}, ['E-mail', f.email])]),
        el('div', { class: 'row' }, [el('label', {}, ['Temporary password (12+ characters)', f.password]), el('label', {}, ['Repeat password', f.confirmPassword])]),
        el('div', { class: 'row' }, [el('label', {}, ['Reason', f.reason]), el('button', { class: 'btn primary', type: 'button', text: 'Add Super Admin', on: { click: function () {
          if (f.password.value !== f.confirmPassword.value) { out.replaceChildren(msg('err', 'The two passwords do not match.')); return; }
          if (f.password.value.length < 12) { out.replaceChildren(msg('err', 'The password must be at least 12 characters.')); return; }
          api('POST', '/staff-super-admins', { name: f.name.value, email: f.email.value, password: f.password.value, confirmPassword: f.confirmPassword.value, reason: f.reason.value })
            .then(function (r) { f.password.value = ''; f.confirmPassword.value = ''; out.replaceChildren(msg('ok', 'Super Admin added: ' + r.email + '. They sign in at /login and choose their own password.')); setTimeout(function () { show('staff'); }, 2500); })
            .catch(function (e) { out.replaceChildren(msg('err', e.message)); });
        } } })]), out]));
    }).catch(function () { /* the people list below shows its own errors */ });
    // A salesman, delivery person or event staff member in one step.
    if (has('core.staff.create') && has('core.roles.edit')) {
      var fs = el('div'); main.insertBefore(fs, box);
      var kind = el('select', { 'aria-label': 'Job' }, [['salesman', 'Salesman'], ['delivery', 'Delivery staff'], ['event', 'Event staff']]
        .filter(function (o) { return o[0] !== 'salesman' || has('core.staff.edit'); }).map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      var g = { name: el('input', { autocomplete: 'off' }), email: el('input', { type: 'email', autocomplete: 'off' }), mobile: el('input', { inputmode: 'numeric', maxlength: '10' }),
        password: el('input', { type: 'password', autocomplete: 'new-password', minlength: '12' }), confirmPassword: el('input', { type: 'password', autocomplete: 'new-password', minlength: '12' }),
        employeeCode: el('input', {}), terr: el('select', { 'aria-label': 'Home territory' }, [el('option', { value: '', text: 'None' })]),
        wh: el('select', { 'aria-label': 'Ships from warehouse' }, [el('option', { value: '', text: 'Default' })]), cash: el('input', { inputmode: 'decimal', value: '20000' }) };
      var salesRow = el('div', { class: 'row' }, [el('label', {}, ['Employee code', g.employeeCode]), el('label', {}, ['Home territory', g.terr]), el('label', {}, ['Ships from warehouse', g.wh]), el('label', {}, ['Cash limit (₹)', g.cash])]);
      var lookups = has('core.staff.edit') ? rawApi('GET', '/api/erp/sales/salesmen/lookups').catch(function () { return null; }) : Promise.resolve(null);
      lookups.then(function (l) {
        if (!l) return;
        l.territories.forEach(function (x) { g.terr.appendChild(el('option', { value: String(x.id), text: x.name + ' (' + x.level + ')' })); });
        l.warehouses.forEach(function (x) { g.wh.appendChild(el('option', { value: String(x.id), text: x.code + ' — ' + x.name })); });
      });
      var fout = el('div');
      kind.addEventListener('change', function () { salesRow.hidden = kind.value !== 'salesman'; });
      salesRow.hidden = kind.value !== 'salesman';
      fs.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Add a salesman, delivery person or event staff' }),
        el('p', { class: 'note', text: 'Creates the account, gives the role and, for a salesman, the salesman record. The role is given at once when your own access covers it; ' +
          'otherwise it waits under Administration → Approvals. They sign in at sakeofhealth.com/login and open the Field app on their phone. ' +
          'The temporary password must be 12+ characters; they choose their own at first sign-in.' }),
        el('div', { class: 'row' }, [el('label', {}, ['Job', kind]), el('label', {}, ['Name', g.name]), el('label', {}, ['E-mail', g.email]), el('label', {}, ['Mobile', g.mobile])]),
        el('div', { class: 'row' }, [el('label', {}, ['Temporary password (12+ characters)', g.password]), el('label', {}, ['Repeat password', g.confirmPassword])]),
        salesRow,
        el('div', { class: 'row' }, [el('button', { class: 'btn primary', type: 'button', text: 'Add', on: { click: function () {
          if (g.password.value !== g.confirmPassword.value) { fout.replaceChildren(msg('err', 'The two passwords do not match.')); return; }
          if (g.password.value.length < 12) { fout.replaceChildren(msg('err', 'The password must be at least 12 characters.')); return; }
          var body = { kind: kind.value, name: g.name.value, email: g.email.value, mobile: g.mobile.value || undefined, password: g.password.value, confirmPassword: g.confirmPassword.value };
          if (kind.value === 'salesman') Object.assign(body, { employeeCode: g.employeeCode.value, homeTerritoryId: Number(g.terr.value) || null, defaultWarehouseId: Number(g.wh.value) || null, cashLimit: g.cash.value });
          api('POST', '/field-staff', body).then(function (r) {
            g.password.value = ''; g.confirmPassword.value = '';
            fout.replaceChildren(msg('ok', r.approval && r.approval.status === 'granted'
              ? 'Added ' + body.email + ' with the role. They can sign in now at sakeofhealth.com/login.'
              : 'Added ' + body.email + '. The role is waiting for approval (request #' + r.approval.approvalId + ')' + (r.approval.why ? ': ' + r.approval.why : '.')));
            setTimeout(function () { show('staff'); }, 4000);
          }).catch(function (e) { fout.replaceChildren(msg('err', e.message)); });
        } } })]), fout]));
    }
    if (has('core.roles.view')) { var pol = el('div'); main.insertBefore(pol, box); rolePolicyPanel(pol); }
    var hist = el('div');
    Promise.all([api('GET', '/staff'), has('core.roles.view') ? api('GET', '/roles') : Promise.resolve({ items: [] })]).then(function (res) {
      var roles = res[1].items;
      box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'People' }), hist, table(['Name', 'E-mail', 'Roles', 'Status', 'MFA', 'Last login', ''], res[0].items.map(function (s) {
        var act = el('div', { class: 'row' }), note = el('div');
        function done(text) { return function () { note.replaceChildren(msg('ok', text)); setTimeout(function () { show('staff'); }, 1500); }; }
        function oops(e) { note.replaceChildren(msg('err', e.message)); }
        if (has('core.staff.edit') && s.status === 'active' && s.id !== state.me.id) act.appendChild(el('button', { class: 'btn danger', type: 'button', text: 'Disable', on: { click: function () {
          api('PATCH', '/staff/' + s.id, { status: 'disabled', reason: 'Disabled from staff screen' }).then(function () { show('staff'); }).catch(oops);
        } } }));
        if (has('core.staff.edit') && s.status === 'disabled') act.appendChild(el('button', { class: 'btn', type: 'button', text: 'Re-activate', on: { click: function () {
          api('PATCH', '/staff/' + s.id, { status: 'active', reason: 'Re-activated from staff screen' }).then(function (r) {
            if (r && r.status === 'active') done('Active again.')(); else note.replaceChildren(msg('ok', 'Sent for approval (request #' + r.approvalId + ').'));
          }).catch(oops);
        } } }));
        if (has('core.roles.edit') && roles.length && s.status === 'active') {
          var sel = el('select', { 'aria-label': 'Role to give ' + s.name }, roles.filter(function (r) { return r.is_active !== 0; }).map(function (r) { return el('option', { value: String(r.id), text: r.name }); }));
          var why = el('input', { 'aria-label': 'Reason', placeholder: 'Reason (optional)' });
          act.appendChild(sel); act.appendChild(why);
          act.appendChild(el('button', { class: 'btn', type: 'button', text: 'Give role', on: { click: function () {
            api('POST', '/staff/' + s.id + '/roles', { roleId: Number(sel.value), scopeType: 'all', reason: why.value }).then(function (r) {
              if (r.status === 'granted') done(r.alreadyGranted ? 'They already have this role.' : 'Role given. Their open sessions were ended so it applies at once.')();
              else note.replaceChildren(msg('ok', 'Sent for approval (request #' + r.approvalId + ')' + (r.why ? ': ' + r.why : '.')));
            }).catch(oops);
          } } }));
        }
        if (has('core.staff.edit') && s.mfa_enabled && s.id !== state.me.id) act.appendChild(el('button', { class: 'btn', type: 'button', text: 'Clear 2FA', on: { click: function () {
          var r2 = el('input', { 'aria-label': 'Reason for clearing two-step sign-in', placeholder: 'Why? e.g. lost phone' });
          note.replaceChildren(el('div', { class: 'row' }, [r2, el('button', { class: 'btn danger', type: 'button', text: 'Clear their authenticator', on: { click: function () {
            api('POST', '/staff/' + s.id + '/mfa/reset', { reason: r2.value }).then(done('Cleared. They sign in with their password and set up a new authenticator.')).catch(oops);
          } } })]));
        } } }));
        if (has('core.staff.view')) act.appendChild(el('button', { class: 'btn', type: 'button', text: 'Role history', on: { click: function () {
          api('GET', '/staff/' + s.id + '/roles/history').then(function (h) {
            hist.replaceChildren(el('h3', { text: 'Role history: ' + s.name }), table(['Role', 'Scope', 'Given', 'By', 'Ended'], h.items.map(function (g) {
              return [g.role_name, g.scope_type + (g.scope_id ? ' #' + g.scope_id : ''), fmt(g.granted_at), g.granted_by_name || '—', g.revoked_at ? fmt(g.revoked_at) : 'current'];
            })));
            hist.scrollIntoView({ block: 'nearest' });
          }).catch(oops);
        } } }));
        return [s.name, s.email, s.roles.join(', ') || '—', s.status, s.mfa_enabled ? 'on' : 'off', fmt(s.last_login_at), el('div', {}, [act, note])];
      }))]));
      if (has('core.staff.create')) {
        var n = el('input', { 'aria-label': 'Name' }), e = el('input', { type: 'email', 'aria-label': 'E-mail' }), m = el('input', { inputmode: 'numeric', 'aria-label': 'Mobile' }),
          p = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Initial password' }), out = el('div');
        box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Add a staff member' }), el('div', { class: 'row' }, [
          el('label', {}, ['Name', n]), el('label', {}, ['E-mail', e]), el('label', {}, ['Mobile (optional)', m]), el('label', {}, ['Initial password (12+ characters)', p]),
          el('button', { class: 'btn primary', type: 'button', text: 'Add', on: { click: function () {
            api('POST', '/staff', { name: n.value, email: e.value, mobile: m.value || null, password: p.value }).then(function () { show('staff'); }).catch(function (x) { out.replaceChildren(msg('err', x.message)); });
          } } })]), out, el('p', { class: 'note', text: 'New people have no access until they are given a role.' })]));
      }
      if (roles.length) box.appendChild(el('section', { class: 'panel' }, [el('h2', { text: 'Roles' }), table(['Role', 'Type', 'Permissions'], roles.map(function (r) {
        return [r.name, r.is_system ? 'system' : 'custom', el('pre', { text: r.permissions.join('\n') || '—' })];
      }))]));
    }).catch(function (e) { box.appendChild(msg('err', e.message)); });
  }

  // Who may give roles without a second approver (role-policy.js on the server decides; this only shows it).
  function rolePolicyPanel(box) {
    api('GET', '/security/role-assignment').then(function (st) {
      var sec = el('section', { class: 'panel' }, [el('h2', { text: 'Giving roles' })]);
      box.replaceChildren(sec);
      sec.appendChild(el('p', { text: st.mode === 'direct'
        ? 'One admin gives ordinary roles at once. A second person approves: the Super Admin role, roles that can change roles or settings, roles listed below, roles you give yourself, and roles with more access than your own.'
        : 'Every role waits for a second person to approve it.' }));
      if (st.mode === 'direct' && st.approvalRoles.length) sec.appendChild(el('p', { class: 'note', text: 'Also need approval: ' + st.approvalRoles.join(', ') }));
      if (st.source === 'fail-safe') sec.appendChild(el('p', { class: 'note', text: 'The setting could not be read, so every role needs approval for now.' }));
      if (!st.canChange) return;
      api('GET', '/roles').then(function (rr) {
        var mode = el('select', { 'aria-label': 'How roles are given' }, [el('option', { value: 'direct', text: 'One admin gives ordinary roles' }), el('option', { value: 'approval', text: 'Every role needs approval' })]);
        mode.value = st.mode;
        var picks = rr.items.filter(function (r) { return r.code !== 'super_admin'; }).map(function (r) {
          var c = el('input', { type: 'checkbox', value: r.code }); c.checked = st.approvalRoles.indexOf(r.code) !== -1;
          return el('label', { class: 'row' }, [c, r.name]);
        });
        var why = el('input', { 'aria-label': 'Reason', placeholder: 'Reason (optional)' }), out = el('div');
        sec.appendChild(el('div', { class: 'row' }, [el('label', {}, ['How roles are given', mode]), why, el('button', { class: 'btn primary', type: 'button', text: 'Save', on: { click: function () {
          var list = picks.map(function (l) { return l.querySelector('input'); }).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
          api('PUT', '/security/role-assignment', { mode: mode.value, approvalRoles: list, reason: why.value }).then(function () { rolePolicyPanel(box); }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
        } } })]));
        sec.appendChild(el('details', {}, [el('summary', { text: 'Roles that always need approval (in addition to admin-level roles)' })].concat(picks)));
        sec.appendChild(out);
      }).catch(function (e) { sec.appendChild(msg('err', e.message)); });
    }).catch(function (e) { box.replaceChildren(msg('err', e.message)); });
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

    // Own authenticator: set up once; asked for at sign-in only where the policy applies to this person.
    // Backup codes: 10 one-time codes for a lost phone, shown once when made.
    function drawBackup() {
      var box = el('div', { class: 'panel' }, [el('h3', { text: 'Backup codes' })]);
      mfaBox.appendChild(box);
      api('GET', '/me/recovery-codes').then(function (rc) {
        box.appendChild(el('p', { class: 'note', text: rc.left
          ? rc.left + ' unused backup codes (made ' + fmt(rc.createdAt) + '). Each works once, instead of the 6-digit code, if your phone is lost.'
          : 'No backup codes yet. Make a set and keep it on paper, away from your phone.' }));
        var out = el('div');
        box.appendChild(el('button', { class: 'btn', type: 'button', text: rc.left ? 'Make a new set (the old codes stop working)' : 'Make backup codes', on: { click: function () {
          api('POST', '/me/recovery-codes').then(function (r) {
            out.replaceChildren(el('p', { text: 'Write these down or print this page now. They are shown only once.' }),
              el('pre', { text: r.codes.join('\n'), style: 'font-size:16px;letter-spacing:1px' }));
          }).catch(function (e) { out.replaceChildren(msg('err', e.status === 403 ? 'Sign out and sign in again with your 6-digit code first.' : e.message)); });
        } } }));
        box.appendChild(out);
      }).catch(function (e) { box.appendChild(msg('err', e.message)); });
    }
    function drawOwn(st) {
      if (state.me.mfa) { mfaBox.appendChild(msg('ok', 'On: you signed in with your 6-digit code.')); drawBackup(); return; }
      if (st.ownAuthenticator) {
        mfaBox.appendChild(el('p', { class: 'note', text: st.appliesToMe
          ? 'Your authenticator is set up. Sign out and sign in again with your 6-digit code to approve or change sensitive settings.'
          : 'Your authenticator is set up. It is not asked for while two-step sign-in does not apply to your role.' }));
        drawBackup();
        return;
      }
      mfaBox.appendChild(el('p', { class: 'note', text: 'Set up an authenticator app on your phone. It is needed before two-step sign-in can be switched on for a role you hold.' }));
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

    // The two-step sign-in policy (Super Admin): off, everyone, or chosen roles. Every change is in the audit log.
    function drawSite(st) {
      siteBox.replaceChildren(el('h2', { text: 'Two-step sign-in for everyone' }));
      siteBox.appendChild(el('p', { text: st.mode === 'all'
        ? 'ON for everyone — staff who set up an authenticator enter the 6-digit code at sign-in, and approvals and sensitive actions need it.'
        : st.mode === 'roles' ? 'ON for these roles only: ' + st.roles.join(', ') + '. Everyone else signs in with a password.'
          : 'OFF — nobody is asked for a code at sign-in, and no action needs one.' }));
      var src = { server: 'Fixed by the server setting ERP_MFA_REQUIRED in Hostinger. Remove that setting there to use this switch.',
        'default': 'It has never been switched, so it is off.',
        'fail-safe': 'The settings could not be read, so it is on for safety.' }[st.source];
      if (st.source === 'switch') src = 'Last changed' + (st.changedBy ? ' by ' + st.changedBy : '') + (st.changedAt ? ' on ' + fmt(st.changedAt) : '') + '.';
      if (src) siteBox.appendChild(el('p', { class: 'note', text: src }));
      if (!st.canChange) return;
      if (st.appliesToMe && !st.sessionHasCode) {
        siteBox.appendChild(el('p', { class: 'note', text: 'To change it, sign out and sign in again with your 6-digit code.' }));
        return;
      }
      var mode = el('select', { 'aria-label': 'Who needs two-step sign-in' }, [el('option', { value: 'off', text: 'Nobody (off)' }),
        el('option', { value: 'all', text: 'Everyone' }), el('option', { value: 'roles', text: 'Only the roles I choose' })]);
      mode.value = st.mode;
      var picks = (st.roleOptions || []).map(function (r) {
        var c = el('input', { type: 'checkbox', value: r.code }); c.checked = st.roles.indexOf(r.code) !== -1;
        return el('label', { class: 'row' }, [c, r.name]);
      });
      var list = el('div', {}, picks);
      function sync() { list.hidden = mode.value !== 'roles'; }
      mode.addEventListener('change', sync); sync();
      var why = el('input', { 'aria-label': 'Reason', placeholder: 'Reason (optional)' }), out = el('div');
      if (!st.ownAuthenticator) siteBox.appendChild(el('p', { class: 'note', text: 'If the setting you choose includes your own role, set up your own authenticator above first, so you can still sign in.' }));
      siteBox.appendChild(el('div', { class: 'row' }, [el('label', {}, ['Who needs it', mode]), why, el('button', { class: 'btn primary', type: 'button', text: 'Save', on: { click: function () {
        var roles = picks.map(function (l) { return l.querySelector('input'); }).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
        api('PUT', '/security/mfa', { mode: mode.value, roles: roles, reason: why.value }).then(function () {
          return api('GET', '/security/mfa').then(function (st2) {
            drawSite(st2);
            siteBox.appendChild(msg('ok', st2.appliesToMe ? 'Saved. Sign out and sign in again with your code before approving anything.' : 'Saved.'));
          });
        }).catch(function (e) { out.replaceChildren(msg('err', e.message)); });
      } } })]));
      siteBox.appendChild(list);
      siteBox.appendChild(out);
    }
  }

  function show(id) {
    if (embed()) { embed().navigate(id); return; }
    state.view = id; render();
  }
  // Module screens (modules.js) register here; they use the same helpers and the same server checks.
  window.ERP = { el: el, api: rawApi, msg: msg, fmt: fmt, table: table, kpi: kpi, has: has, show: show, state: state, exports: Exports };
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
