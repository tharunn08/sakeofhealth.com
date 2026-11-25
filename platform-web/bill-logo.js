/* Puts the logo chosen in Admin → Logos & Bills on every printed bill.
   The print page builds its bills after loading the orders, so this watches the page and adds the
   logo to each bill header (.bill-seller) as it appears. The bill itself is not otherwise changed.
   If the choice cannot be read, the shop's own logo is used. */
(function () {
  'use strict';
  var FALLBACK = { url: '/assets/images/logo-mark.png', label: 'Sake of Health' };
  var logo = null;
  var style = document.createElement('style');
  style.textContent = '.bill-logo{display:block;max-height:60px;max-width:200px;object-fit:contain;margin:0 0 8px}' +
    '@media print{.bill-logo{-webkit-print-color-adjust:exact;print-color-adjust:exact}}';
  document.head.appendChild(style);

  function place() {
    if (!logo) return;
    var heads = document.querySelectorAll('.bill-seller');
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].querySelector('.bill-logo')) continue;
      var img = document.createElement('img');
      img.className = 'bill-logo';
      img.src = logo.url;
      img.alt = logo.label || 'Logo';
      heads[i].insertBefore(img, heads[i].firstChild);
    }
  }
  fetch('/api/platform/branding/bill-logo', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : FALLBACK; })
    .catch(function () { return FALLBACK; })
    .then(function (b) { logo = b && b.url ? b : FALLBACK; place(); });
  new MutationObserver(place).observe(document.documentElement, { childList: true, subtree: true });
})();
