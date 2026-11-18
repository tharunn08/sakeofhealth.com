/* ═══════════ Sake of Health — Print centre ═══════════
 * Delivery labels (to stick on the parcel) and bills / tax invoices.
 *
 * One script serves four callers, selected with ?src=
 *   b2c         customer orders          (admin token → /api/admin/orders/:id)
 *   b2b         business orders          (admin token → /api/admin/b2b/print)
 *   b2b-seller  a distributor's retailer orders (business token → /api/b2b/retailer-orders-print)
 *   b2b-buyer   a business's own orders  (business token → /api/b2b/print)
 *
 * ?ids=a,b,c  orders to print      ?doc=label|bill      ?auto=1  open the print dialog when ready
 *
 * Every value written into the page goes through esc() — order data is
 * customer-supplied text and must never be interpreted as HTML.
 */
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  var SRC = ['b2c', 'b2b', 'b2b-seller', 'b2b-buyer'].indexOf(qs.get('src')) !== -1 ? qs.get('src') : 'b2c';
  var IDS = String(qs.get('ids') || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 100);
  var PREF_KEY = 'soh_print_prefs';

  var prefs = { doc: 'label', labelPaper: 'label', billPaper: 'a4', showItems: true, showAmount: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* defaults */ }
  if (qs.get('doc') === 'bill' || qs.get('doc') === 'label') prefs.doc = qs.get('doc');
  if (SRC === 'b2b-buyer') prefs.doc = 'bill';

  var stage = document.getElementById('stage');
  var docs = [];
  var sender = null;       // B2C sender details (editable by admin/manager)

  /* ─────────── helpers ─────────── */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(v, dp) {
    return '₹' + num(v).toLocaleString('en-IN', { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp });
  }
  function plain(v) { return num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function date(d) {
    if (!d) return '';
    var t = new Date(String(d).length === 10 ? d + 'T00:00:00' : d);
    return isNaN(t) ? '' : t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function phone(p) { p = String(p || '').replace(/\D/g, '').slice(-10); return p.length === 10 ? p.slice(0, 5) + ' ' + p.slice(5) : p; }
  function join(parts, sep) { return parts.filter(function (x) { return x != null && String(x).trim() !== ''; }).join(sep || ', '); }

  /** 1234567.50 → "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees and Fifty Paise Only" */
  function inWords(amount) {
    var ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
      'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    var tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    function two(n) { return n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : ''); }
    function three(n) { return (n >= 100 ? ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + two(n % 100); }
    var paise = Math.round(num(amount) * 100), rupees = Math.floor(paise / 100); paise = paise % 100;
    if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
    var out = [], crore = Math.floor(rupees / 10000000), lakh = Math.floor(rupees / 100000) % 100, thousand = Math.floor(rupees / 1000) % 100, rest = rupees % 1000;
    if (crore) out.push((crore > 99 ? inWordsInt(crore) : two(crore)) + ' Crore');
    if (lakh) out.push(two(lakh) + ' Lakh');
    if (thousand) out.push(two(thousand) + ' Thousand');
    if (rest) out.push(three(rest));
    var text = out.length ? out.join(' ') + ' Rupees' : '';
    if (paise) text += (text ? ' and ' : '') + two(paise) + ' Paise';
    return text + ' Only';
    function inWordsInt(n) { return three(Math.floor(n / 1000)) + ' Thousand ' + three(n % 1000); }
  }

  /* ─────────── Code 128 (set B) barcode → SVG ─────────── */

  var C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
    '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
    '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
    '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
    '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
    '114131 311141 411131 211412 211214 211232 2331112').split(' ');

  function code128Values(text) {
    var clean = String(text).replace(/[^\x20-\x7E]/g, '?');
    var values = [104], sum = 104;                    // Start B
    for (var i = 0; i < clean.length; i++) { var v = clean.charCodeAt(i) - 32; values.push(v); sum += v * (i + 1); }
    values.push(sum % 103); values.push(106);         // checksum, stop
    return values;
  }
  function barcodeSvg(text, cls) {
    var values = code128Values(text), x = 10, rects = '';
    values.forEach(function (v) {
      var pattern = C128[v];
      for (var i = 0; i < pattern.length; i++) {
        var w = Number(pattern[i]);
        if (i % 2 === 0) rects += '<rect x="' + x + '" y="0" width="' + w + '" height="40"/>';
        x += w;
      }
    });
    return '<svg class="' + (cls || '') + '" viewBox="0 0 ' + (x + 10) + ' 40" preserveAspectRatio="none" role="img" aria-label="Barcode ' + esc(text) + '" fill="#000">' + rects + '</svg>';
  }

  /* ─────────── QR code → SVG ─────────── */

  function qrSvg(text) {
    if (typeof window.qrcode !== 'function') return '';
    try {
      var q = window.qrcode(0, 'M'); q.addData(String(text)); q.make();
      var n = q.getModuleCount(), d = '';
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + 2) + ' ' + (r + 2) + 'h1v1h-1z';
      return '<svg viewBox="0 0 ' + (n + 4) + ' ' + (n + 4) + '" shape-rendering="crispEdges" role="img" aria-label="QR code for directions"><path fill="#000" d="' + d + '"/></svg>';
    } catch (e) { return ''; }
  }
  function mapsUrl(to) {
    if (to.lat != null && to.lng != null && to.lat !== '' && to.lng !== '' && isFinite(Number(to.lat)) && isFinite(Number(to.lng))) {
      return 'https://www.google.com/maps/dir/?api=1&destination=' + Number(to.lat).toFixed(6) + ',' + Number(to.lng).toFixed(6);
    }
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(join([to.line1, to.line2, to.city, to.state, to.pincode]));
  }

  /* ─────────── data loading → one common document shape ─────────── */

  function adminToken() { return localStorage.getItem('soh_admin_token') || ''; }
  function businessToken() { try { return (JSON.parse(localStorage.getItem('soh_b2b') || '{}')).token || ''; } catch (e) { return ''; } }
  var isBusiness = SRC === 'b2b-seller' || SRC === 'b2b-buyer';

  async function api(path) {
    var token = isBusiness ? businessToken() : adminToken();
    if (!token) throw new Error('Please sign in again, then reopen this page.');
    var res = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (res.status === 401) throw new Error('Your session has expired. Please sign in again, then reopen this page.');
    if (!res.ok) throw new Error((data && data.error) || 'Could not load the orders (' + res.status + ')');
    return data;
  }

  function fromB2C(o, s) {
    var a = o.address || {}, c = o.customer || {}, p = o.payment || {};
    var paid = p.status === 'paid';
    return {
      kind: 'b2c', orderNo: o.orderId, date: o.createdAt, units: (o.items || []).reduce(function (n, i) { return n + num(i.qty); }, 0),
      to: { name: c.name, contact: '', phone: c.phone, email: c.email, line1: join([a.doorNo, a.line1]), line2: a.line2, landmark: a.landmark, city: a.city,
        district: '', state: a.state, pincode: a.pincode, lat: o.location && o.location.lat, lng: o.location && o.location.lng, gstin: '' },
      from: { name: s.businessName, address: s.address, phone: s.phone, email: s.email, gstin: s.gstin, state: '', stateCode: '' },
      items: (o.items || []).map(function (i) { return { sku: '', name: i.name, hsn: '', pack: '', qty: num(i.qty), rate: num(i.price), total: num(i.price) * num(i.qty) }; }),
      totals: { subtotal: num(o.subtotal), discount: num(o.discount), shipping: num(o.shipping), grand: num(o.total), paid: paid ? num(o.total) : 0 },
      payment: { method: p.method === 'cod' ? 'Cash on delivery' : 'Online', status: paid ? 'paid' : 'pending', reference: p.paymentId || '' },
      coupon: o.couponCode || '', invoice: null, notes: '', footer: s.footer, bankDetails: '', agent: o.assignedTo && o.assignedTo.name,
    };
  }

  function fromB2B(d) {
    var o = d.order, inv = d.invoice, s = d.seller;
    var grand = num(o.grand_total), paid = num(o.amount_paid);
    return {
      kind: 'b2b', orderNo: o.order_no, date: o.created_at, units: num(o.total_qty),
      to: { name: o.ship_name, contact: o.ship_contact, phone: o.ship_phone, line1: o.ship_line1, line2: o.ship_line2, landmark: o.ship_landmark, city: o.ship_city,
        district: o.ship_district, state: o.ship_state, pincode: o.ship_pincode, lat: o.ship_lat, lng: o.ship_lng, gstin: o.buyer_gstin, legalName: o.buyer_name },
      from: { name: s.name, brand: s.brand, address: inv ? inv.seller_address : s.address, phone: s.phone, email: s.email, gstin: inv ? inv.seller_gstin : s.gstin,
        pan: s.pan, state: s.state, stateCode: s.stateCode },
      items: d.items.map(function (i) {
        return { sku: i.sku, name: i.name, hsn: i.hsn_code, pack: i.pack_size, qty: num(i.qty), rate: num(i.list_price), discount: num(i.discount_amount), taxable: num(i.taxable_amount),
          gstRate: num(i.gst_rate), cgst: num(i.cgst_amount), sgst: num(i.sgst_amount), igst: num(i.igst_amount), total: num(i.line_total) };
      }),
      totals: { subtotal: num(o.subtotal), discount: num(o.discount_total), taxable: num(o.taxable_total), cgst: num(o.cgst_total), sgst: num(o.sgst_total), igst: num(o.igst_total),
        tax: num(o.tax_total), roundOff: num(o.round_off), grand: grand, paid: paid },
      payment: { method: { credit: 'Credit', gateway: 'Online', upi: 'UPI', bank_transfer: 'Bank transfer', prepaid: 'Prepaid' }[o.payment_method] || o.payment_method,
        status: paid >= grand ? 'paid' : (o.payment_method === 'credit' ? 'credit' : 'pending'), reference: '' },
      invoice: inv ? { no: inv.invoice_no, date: inv.invoice_date, dueDate: inv.due_date, placeOfSupply: inv.place_of_supply, interstate: !!num(inv.is_interstate) } : null,
      coupon: '', notes: o.buyer_notes || '', footer: s.footer || '', bankDetails: s.bankDetails || '', orderStatus: o.status,
    };
  }

  async function load() {
    if (!IDS.length) throw new Error('No orders were selected to print.');
    if (SRC === 'b2c') {
      var settings = await api('/api/admin/print-settings');
      sender = settings.sender; sender.canEdit = settings.canEdit;
      var out = [];
      // Small batches keep well inside the admin API rate limit.
      for (var i = 0; i < IDS.length; i += 8) {
        var batch = await Promise.all(IDS.slice(i, i + 8).map(function (id) {
          return api('/api/admin/orders/' + encodeURIComponent(id)).catch(function () { return null; });
        }));
        batch.forEach(function (o) { if (o) out.push(o); });
      }
      if (!out.length) throw new Error('Those orders could not be found.');
      return out.map(function (o) { return fromB2C(o, sender); });
    }
    var url = { 'b2b': '/api/admin/b2b/print', 'b2b-seller': '/api/b2b/retailer-orders-print', 'b2b-buyer': '/api/b2b/print' }[SRC];
    var data = await api(url + '?ids=' + encodeURIComponent(IDS.join(',')));
    return data.documents.map(fromB2B);
  }

  /* ─────────── delivery label ─────────── */

  function labelHtml(d) {
    var due = Math.max(0, d.totals.grand - d.totals.paid);
    var pay;
    if (d.payment.status === 'paid') pay = '<div class="lbl-pay">PREPAID<small>Nothing to collect</small></div>';
    else if (d.payment.status === 'credit') pay = '<div class="lbl-pay">CREDIT<small>Do not collect</small></div>';
    else pay = '<div class="lbl-pay collect">COLLECT<small>' + esc(money(due, 0)) + '</small></div>';

    var max = 7, shown = d.items.slice(0, max);
    var items = shown.map(function (i) { return '<li><b>' + esc(i.qty) + ' ×</b><span>' + esc(i.name) + (i.pack ? ' · ' + esc(i.pack) : '') + '</span></li>'; }).join('') +
      (d.items.length > max ? '<li class="more">+ ' + (d.items.length - max) + ' more item' + (d.items.length - max === 1 ? '' : 's') + ' — see bill</li>' : '');

    var hasPin = d.to.lat != null && d.to.lat !== '' && isFinite(Number(d.to.lat));
    var brand = d.from.brand && d.from.brand !== d.from.name ? d.from.brand : d.from.name;

    return '<div class="lbl">' +
      '<div class="lbl-head"><div class="lbl-brand">' + esc(brand || 'Sake of Health') + '<small>' + (d.kind === 'b2b' ? 'Trade delivery' : 'Customer delivery') + '</small></div>' + pay + '</div>' +
      '<div class="lbl-to"><div class="lbl-cap">Deliver to</div>' +
        '<div class="lbl-name">' + esc(d.to.name || '—') + '</div>' +
        (d.to.contact && d.to.contact !== d.to.name ? '<div class="lbl-attn">Attn: ' + esc(d.to.contact) + '</div>' : '') +
        '<div class="lbl-addr">' + esc(join([d.to.line1, d.to.line2])) + '<br/>' + esc(join([d.to.city, d.to.district && d.to.district !== d.to.city ? d.to.district : '', d.to.state])) + '</div>' +
        (d.to.landmark ? '<div class="lbl-landmark">Landmark: <span>' + esc(d.to.landmark) + '</span></div>' : '') +
        '<div class="lbl-pinrow"><div class="lbl-pin"><small>PIN CODE</small>' + esc(d.to.pincode || '——') + '</div>' +
        '<div class="lbl-phone"><small>PHONE</small>' + esc(phone(d.to.phone)) + '</div></div>' +
      '</div>' +
      '<div class="lbl-mid"><div class="lbl-order"><div class="lbl-cap">Order</div><div class="lbl-orderno">' + esc(d.orderNo) + '</div>' +
        barcodeSvg(d.orderNo) +
        '<div class="lbl-meta"><span>' + esc(date(d.date)) + '</span>' + (d.invoice ? '<span>Inv ' + esc(d.invoice.no) + '</span>' : '') +
        (d.agent ? '<span>Rider: ' + esc(d.agent) + '</span>' : '') + '</div></div>' +
        '<div class="lbl-qr">' + qrSvg(mapsUrl(d.to)) + '<span>Scan for ' + (hasPin ? 'directions' : 'map') + '</span></div></div>' +
      (prefs.showItems ? '<div class="lbl-items"><div class="lbl-cap">Contents · ' + d.items.length + ' item' + (d.items.length === 1 ? '' : 's') + ' · ' + esc(d.units) + ' unit' + (d.units === 1 ? '' : 's') + '</div><ul>' + items + '</ul></div>'
        : '<div class="lbl-items"><div class="lbl-cap">Contents</div>' + d.items.length + ' item' + (d.items.length === 1 ? '' : 's') + ' · ' + esc(d.units) + ' unit' + (d.units === 1 ? '' : 's') + '</div>') +
      (prefs.showAmount ? '<div class="lbl-amt"><div><div class="lbl-cap">Order value</div><b>' + esc(money(d.totals.grand, 0)) + '</b></div>' +
        '<div><div class="lbl-cap">' + (d.payment.status === 'paid' ? 'Paid' : d.payment.status === 'credit' ? 'On credit' : 'To collect') + '</div><b>' +
        esc(d.payment.status === 'paid' ? d.payment.method : d.payment.status === 'credit' ? 'Bill to account' : money(due, 0)) + '</b></div></div>' : '') +
      '<div class="lbl-pod"><span><span class="box"></span>Delivered</span><span>Name</span><i></i><span>Sign</span><i></i></div>' +
      '<div class="lbl-from"><span class="lbl-cap">From </span><b>' + esc(d.from.name || '') + '</b>' + (d.from.phone ? ' · ' + esc(d.from.phone) : '') +
        (d.from.address ? '<br/>' + esc(d.from.address) : '') +
        (d.notes ? '<div class="lbl-note">Note: ' + esc(String(d.notes).slice(0, 110)) + '</div>' : '') + '</div>' +
      '</div>';
  }

  /* ─────────── bill / tax invoice ─────────── */

  function billHtml(d) {
    var b2b = d.kind === 'b2b', inv = d.invoice;
    var title = b2b ? (inv ? 'Tax Invoice' : 'Order Summary') : 'Bill';
    var due = Math.max(0, d.totals.grand - d.totals.paid);
    var tag = d.payment.status === 'paid' ? '<span class="tag">PAID</span>' : '<span class="tag due">' + (d.payment.status === 'credit' ? 'ON CREDIT' : 'PAYMENT DUE') + '</span>';
    var kv = '';
    if (inv) kv += '<dt>Invoice No</dt><dd>' + esc(inv.no) + '</dd><dt>Invoice date</dt><dd>' + esc(date(inv.date)) + '</dd>';
    kv += '<dt>Order No</dt><dd>' + esc(d.orderNo) + '</dd><dt>Order date</dt><dd>' + esc(date(d.date)) + '</dd>';
    if (inv && inv.placeOfSupply) kv += '<dt>Place of supply</dt><dd>' + esc(inv.placeOfSupply) + '</dd>';
    if (inv && inv.dueDate && d.payment.status !== 'paid') kv += '<dt>Due date</dt><dd>' + esc(date(inv.dueDate)) + '</dd>';
    kv += '<dt>Payment</dt><dd>' + esc(d.payment.method) + '</dd>';

    var interstate = inv ? inv.interstate : (d.totals.igst > 0);
    var head, rows;
    if (b2b) {
      head = '<th>#</th><th class="l">Item</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Disc.</th><th>Taxable</th><th>GST</th>' +
        (interstate ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>') + '<th>Amount</th>';
      rows = d.items.map(function (i, n) {
        return '<tr><td>' + (n + 1) + '</td><td class="l">' + esc(i.name) + '<small>' + esc(join([i.sku, i.pack], ' · ')) + '</small></td><td>' + esc(i.hsn || '—') + '</td><td>' + esc(i.qty) +
          '</td><td>' + plain(i.rate) + '</td><td>' + (i.discount ? plain(i.discount) : '—') + '</td><td>' + plain(i.taxable) + '</td><td>' + esc(i.gstRate) + '%</td>' +
          (interstate ? '<td>' + plain(i.igst) + '</td>' : '<td>' + plain(i.cgst) + '</td><td>' + plain(i.sgst) + '</td>') + '<td>' + plain(i.total) + '</td></tr>';
      }).join('');
    } else {
      head = '<th>#</th><th class="l">Item</th><th>Qty</th><th>Rate</th><th>Amount</th>';
      rows = d.items.map(function (i, n) {
        return '<tr><td>' + (n + 1) + '</td><td class="l">' + esc(i.name) + '</td><td>' + esc(i.qty) + '</td><td>' + plain(i.rate) + '</td><td>' + plain(i.total) + '</td></tr>';
      }).join('');
    }

    var t = d.totals, totals = '';
    if (b2b) {
      if (t.discount) totals += '<tr><td>Gross value</td><td>' + plain(t.subtotal) + '</td></tr><tr><td>Trade discount</td><td>− ' + plain(t.discount) + '</td></tr>';
      totals += '<tr><td>Taxable value</td><td>' + plain(t.taxable) + '</td></tr>';
      totals += interstate ? '<tr><td>IGST</td><td>' + plain(t.igst) + '</td></tr>' : '<tr><td>CGST</td><td>' + plain(t.cgst) + '</td></tr><tr><td>SGST</td><td>' + plain(t.sgst) + '</td></tr>';
      if (t.roundOff) totals += '<tr><td>Round off</td><td>' + (t.roundOff > 0 ? '+ ' : '− ') + plain(Math.abs(t.roundOff)) + '</td></tr>';
    } else {
      totals += '<tr><td>Subtotal</td><td>' + plain(t.subtotal) + '</td></tr>';
      if (t.discount) totals += '<tr><td>Discount' + (d.coupon ? ' (' + esc(d.coupon) + ')' : '') + '</td><td>− ' + plain(t.discount) + '</td></tr>';
      totals += '<tr><td>Delivery</td><td>' + (t.shipping ? plain(t.shipping) : 'Free') + '</td></tr>';
    }
    totals += '<tr class="grand"><td>Total</td><td>' + esc(money(t.grand)) + '</td></tr>';
    if (t.paid > 0 && due > 0) totals += '<tr><td>Paid</td><td>' + plain(t.paid) + '</td></tr>';
    if (due > 0) totals += '<tr class="due"><td>Balance due</td><td>' + esc(money(due)) + '</td></tr>';

    var taxSummary = '';
    if (b2b) {
      var byRate = {};
      d.items.forEach(function (i) { var k = i.gstRate; byRate[k] = byRate[k] || { taxable: 0, cgst: 0, sgst: 0, igst: 0 }; byRate[k].taxable += i.taxable; byRate[k].cgst += i.cgst; byRate[k].sgst += i.sgst; byRate[k].igst += i.igst; });
      taxSummary = '<table class="bill-tax"><thead><tr><th class="l">GST rate</th><th>Taxable</th>' + (interstate ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>') + '<th>Total tax</th></tr></thead><tbody>' +
        Object.keys(byRate).sort(function (a, b) { return a - b; }).map(function (k) {
          var r = byRate[k];
          return '<tr><td class="l">' + esc(k) + '%</td><td>' + plain(r.taxable) + '</td>' + (interstate ? '<td>' + plain(r.igst) + '</td>' : '<td>' + plain(r.cgst) + '</td><td>' + plain(r.sgst) + '</td>') +
            '<td>' + plain(r.cgst + r.sgst + r.igst) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    var buyerName = d.to.legalName && d.to.legalName !== d.to.name ? esc(d.to.legalName) + ' (' + esc(d.to.name) + ')' : esc(d.to.name || '—');
    var shipAddr = esc(join([d.to.line1, d.to.line2])) + '<br/>' + (d.to.landmark ? 'Landmark: ' + esc(d.to.landmark) + '<br/>' : '') +
      esc(join([d.to.city, d.to.district && d.to.district !== d.to.city ? d.to.district : '', d.to.state])) + ' ' + esc(d.to.pincode || '');
    var terms = join([d.bankDetails ? 'Bank details:\n' + d.bankDetails : '', b2b ? '' : 'Prices are inclusive of all applicable taxes.', d.footer], '\n\n');
    if (b2b && !inv) terms = 'This is an order summary, not a tax invoice. The tax invoice is issued when the order is dispatched.' + (terms ? '\n\n' + terms : '');

    return '<div class="bill">' +
      '<div class="bill-top"><div class="bill-seller"><h2>' + esc(d.from.name || 'Sake of Health') + '</h2><p>' + esc(d.from.address || '') + '</p>' +
        '<p>' + esc(join([d.from.phone ? 'Ph: ' + d.from.phone : '', d.from.email], ' · ')) + '</p>' +
        (d.from.gstin ? '<p><b>GSTIN:</b> ' + esc(d.from.gstin) + (d.from.pan ? ' &nbsp; <b>PAN:</b> ' + esc(d.from.pan) : '') + '</p>' : '') +
        (d.from.state && d.from.stateCode ? '<p>State: ' + esc(d.from.state) + ' (' + esc(d.from.stateCode) + ')</p>' : '') + '</div>' +
        '<div class="bill-title"><h1>' + title + '</h1>' + tag + '<dl class="bill-kv">' + kv + '</dl></div></div>' +
      '<div class="bill-parties"><div><h3>Bill to</h3><strong>' + buyerName + '</strong>' + (d.to.contact && d.to.contact !== d.to.name ? esc(d.to.contact) + '<br/>' : '') +
        (d.to.gstin ? 'GSTIN: ' + esc(d.to.gstin) + '<br/>' : (b2b ? 'GSTIN: Unregistered<br/>' : '')) + 'Ph: ' + esc(phone(d.to.phone)) + (d.to.email ? '<br/>' + esc(d.to.email) : '') + '</div>' +
        '<div><h3>Ship to</h3><strong>' + esc(d.to.name || '—') + '</strong>' + shipAddr + '</div></div>' +
      '<table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="bill-foot"><div><div class="bill-words">Amount in words<b>' + esc(inWords(t.grand)) + '</b></div>' + taxSummary +
        (d.notes ? '<p style="margin-top:3mm"><b>Buyer note:</b> ' + esc(d.notes) + '</p>' : '') + '</div>' +
        '<div><table class="bill-totals"><tbody>' + totals + '</tbody></table>' +
        '<div style="text-align:right;font-size:.86em;margin-top:1mm">' + esc(d.units) + ' unit' + (d.units === 1 ? '' : 's') + ' in ' + d.items.length + ' line' + (d.items.length === 1 ? '' : 's') + '</div></div></div>' +
      '<div class="bill-bottom"><div><div class="terms">' + esc(terms) + '</div><div class="bill-codes">' + barcodeSvg(d.orderNo, 'bc') + '</div></div>' +
        '<div class="bill-sign"><i></i>For ' + esc(d.from.name || '') + '<br/>Authorised signatory</div></div>' +
      '</div>';
  }

  /* ─────────── page assembly ─────────── */

  function setPageSize(css) {
    var el = document.getElementById('pageRule');
    if (!el) { el = document.createElement('style'); el.id = 'pageRule'; document.head.appendChild(el); }
    el.textContent = '@page{' + css + '}';
  }

  function render() {
    var html = '';
    if (prefs.doc === 'label') {
      if (prefs.labelPaper === 'a4') {
        setPageSize('size:A4 portrait;margin:0;');
        for (var i = 0; i < docs.length; i += 4) html += '<section class="sheet a4 grid4">' + docs.slice(i, i + 4).map(labelHtml).join('') + '</section>';
      } else {
        setPageSize('size:100mm 150mm;margin:0;');
        html = docs.map(function (d) { return '<section class="sheet label">' + labelHtml(d) + '</section>'; }).join('');
      }
    } else {
      var a5 = prefs.billPaper === 'a5';
      setPageSize(a5 ? 'size:A5 portrait;margin:0;' : 'size:A4 portrait;margin:0;');
      html = docs.map(function (d) { return '<section class="sheet ' + (a5 ? 'a5' : 'a4') + '">' + billHtml(d) + '</section>'; }).join('');
    }
    stage.innerHTML = html;
    document.title = (prefs.doc === 'label' ? 'Delivery labels' : 'Bills') + ' — ' + (docs.length === 1 ? docs[0].orderNo : docs.length + ' orders');
    syncBar();
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  function syncBar() {
    document.querySelectorAll('[data-pref]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(prefs[b.dataset.pref] === b.dataset.value));
    });
    document.getElementById('labelOpts').style.display = prefs.doc === 'label' ? '' : 'none';
    document.getElementById('billOpts').style.display = prefs.doc === 'bill' ? '' : 'none';
    document.getElementById('showItems').checked = !!prefs.showItems;
    document.getElementById('showAmount').checked = !!prefs.showAmount;
    document.getElementById('count').textContent = docs.length + (docs.length === 1 ? ' order' : ' orders');
    var hint = document.getElementById('hint');
    hint.innerHTML = prefs.doc === 'label'
      ? (prefs.labelPaper === 'label'
        ? 'Paper: <strong>4 × 6 inch (100 × 150 mm) label</strong>. In the print dialog choose your label printer, set margins to <strong>None</strong> and scale to <strong>100%</strong>.'
        : 'Paper: <strong>A4, four labels per sheet</strong>. Print at <strong>100%</strong> with margins <strong>None</strong>, cut along the dashed lines and stick one on each parcel.')
      : 'Paper: <strong>' + (prefs.billPaper === 'a5' ? 'A5' : 'A4') + '</strong>. Set margins to <strong>None</strong> and switch off "Headers and footers" for a clean bill.';
  }

  function wireBar() {
    document.querySelectorAll('[data-pref]').forEach(function (b) {
      b.addEventListener('click', function () { prefs[b.dataset.pref] = b.dataset.value; render(); });
    });
    document.getElementById('showItems').addEventListener('change', function (e) { prefs.showItems = e.target.checked; render(); });
    document.getElementById('showAmount').addEventListener('change', function (e) { prefs.showAmount = e.target.checked; render(); });
    document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
    document.getElementById('closeBtn').addEventListener('click', function () { if (history.length > 1) history.back(); else window.close(); });
    if (SRC === 'b2b-buyer') document.getElementById('docSeg').style.display = 'none';

    var senderBtn = document.getElementById('senderBtn'), panel = document.getElementById('senderPanel');
    if (SRC !== 'b2c') { senderBtn.style.display = 'none'; return; }
    senderBtn.addEventListener('click', function () { panel.classList.toggle('open'); });
    document.getElementById('senderSave').addEventListener('click', async function () {
      var body = {};
      ['businessName', 'address', 'phone', 'email', 'gstin', 'footer'].forEach(function (k) { body[k] = document.getElementById('s_' + k).value; });
      var msg = document.getElementById('senderMsg');
      try {
        var res = await fetch('/api/admin/print-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken() }, body: JSON.stringify(body) });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save');
        Object.assign(sender, data.sender);
        docs.forEach(function (d) { d.from = { name: sender.businessName, address: sender.address, phone: sender.phone, email: sender.email, gstin: sender.gstin }; d.footer = sender.footer; });
        msg.textContent = 'Saved — used on every label and bill from now on.';
        render();
      } catch (e) { msg.textContent = e.message; }
    });
  }

  function fillSender() {
    if (!sender) return;
    ['businessName', 'address', 'phone', 'email', 'gstin', 'footer'].forEach(function (k) { document.getElementById('s_' + k).value = sender[k] || ''; });
    if (!sender.canEdit) {
      document.getElementById('senderSave').disabled = true;
      document.getElementById('senderMsg').textContent = 'Only an admin or manager can change the sender details.';
    }
    if (!sender.address) document.getElementById('senderPanel').classList.add('open');
  }

  wireBar();
  syncBar();
  load().then(function (list) {
    docs = list;
    fillSender();
    render();
    if (IDS.length > docs.length) {
      var note = document.createElement('div');
      note.className = 'pc-alert info';
      note.textContent = (IDS.length - docs.length) + ' of the selected orders could not be loaded and were skipped.';
      stage.parentNode.insertBefore(note, stage);
    }
    if (qs.get('auto') === '1') setTimeout(function () { window.print(); }, 350);
  }).catch(function (e) {
    document.getElementById('printBtn').disabled = true;
    stage.innerHTML = '<div class="pc-alert">' + esc(e.message) + '</div>';
  });

  // Exposed for automated checks of the barcode encoder.
  window.SohPrint = { code128Values: code128Values, C128: C128, inWords: inWords };
})();
