/* Central Admin Panel — hosts one ERP screen (erp-web/admin) inside the shared shell.
   The shell (admin.js) draws the one sidebar and checks the session; the ERP screen
   code draws only its content and calls /api/erp/* with the person's ERP session,
   where every permission is checked against MySQL as before. */
(function () {
  'use strict';
  var A = window.Admin, P = window.SOH_PAGE || {};
  if (!A.initShell(P.id, P.label)) return;
  var content = document.getElementById('content');
  content.classList.add('erp-embed');

  function notice(kind, text, link) {
    var box = document.createElement('div');
    box.className = 'alert alert-' + kind;
    box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    box.innerHTML = A.icon('alert');
    var span = document.createElement('span');
    span.textContent = text + ' ';
    if (link) { var a = document.createElement('a'); a.href = link.href; a.textContent = link.text; span.appendChild(a); }
    box.appendChild(span);
    content.replaceChildren(box);
  }

  window.ERP_EMBED = {
    view: P.view,
    container: content,
    token: A.Auth.erpToken(),
    navigate: function (id) { var p = P.erpPaths && P.erpPaths[id]; if (p) location.href = p; },
    onEnded: function () {
      A.Auth.clearErp();
      notice('warn', 'Your business-platform session has ended.', { href: '/login?expired=1', text: 'Sign in again' });
    },
    onError: function (e) {
      notice('error', e.status === 503 ? 'The business platform is not available right now (database not reachable). Please try again later.' : (e.message || 'Something went wrong.'));
    },
  };
})();
