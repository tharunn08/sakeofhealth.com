/* Admin panel: say so when the business (ERP) pages are missing from this session.
   A shop/trade session can open without its business part (the 6-digit code was skipped, or the
   business sign-in failed). The menu then simply lacks the ERP pages; this banner explains it and
   offers a fresh sign-in. Loaded after /admin/admin.js on every shell page.
   It also shows the shop's logo in the sidebar corner instead of the letter "S". */
(function () {
  'use strict';
  if (typeof document.querySelector !== 'function' || typeof MutationObserver === 'undefined') return;
  function logo() {
    var box = document.querySelector('.sb-logo');
    if (!box || box.querySelector('img')) return !!box;
    box.textContent = '';
    box.style.background = '#fff';
    box.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,.08)';
    var img = document.createElement('img');
    img.src = '/assets/images/logo-mark.svg'; img.alt = 'Sake of Health';
    img.style.cssText = 'width:26px;height:26px;object-fit:contain;display:block';
    box.appendChild(img);
    return true;
  }
  if (logo()) return;
  var mo = new MutationObserver(function () { if (logo()) mo.disconnect(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(function () { mo.disconnect(); }, 15000);
})();
(function () {
  'use strict';
  var A = window.Admin;
  if (!A || !A.Auth || !A.Auth.token() || A.Auth.erpToken()) return;   // no shop session, or ERP already open
  if (sessionStorage.getItem('soh_erp_banner_hidden') === '1') return;
  fetch('/api/platform/nav', { headers: { Authorization: 'Bearer ' + A.Auth.token() } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (nav) {
      if (!nav || !nav.erpSignInNeeded) return;
      var bar = document.createElement('div');
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;display:flex;gap:12px;align-items:center;justify-content:center;' +
        'flex-wrap:wrap;padding:10px 16px;background:#fff7e6;border-bottom:1px solid #f0c36d;color:#5c3d00;font:500 14px/1.4 Inter,system-ui,sans-serif';
      var text = document.createElement('span');
      text.textContent = 'Your business (ERP) pages — approvals, stock, finance, two-step sign-in — are not open in this session.';
      var again = document.createElement('button');
      again.type = 'button';
      again.textContent = 'Sign in again to open them';
      again.style.cssText = 'padding:6px 12px;border-radius:6px;border:0;background:#5c3d00;color:#fff;font:inherit;cursor:pointer';
      again.addEventListener('click', function () { A.Auth.logout(); });
      var later = document.createElement('button');
      later.type = 'button';
      later.textContent = 'Not now';
      later.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid #c9a24a;background:transparent;color:inherit;font:inherit;cursor:pointer';
      later.addEventListener('click', function () { sessionStorage.setItem('soh_erp_banner_hidden', '1'); bar.remove(); });
      bar.appendChild(text); bar.appendChild(again); bar.appendChild(later);
      document.body.appendChild(bar);
    })
    .catch(function () { /* the menu reports its own errors */ });
})();
