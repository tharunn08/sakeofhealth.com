/**
 * The counter invoice as a printable page (3b.5): the browser's Print (or "Save as PDF") gives
 * the paper or PDF copy; no PDF library is needed. Every value is escaped. A voided invoice
 * says so across the top; returns are listed below the lines (the invoice itself never changes).
 */
'use strict';
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
const m = function (n) { return Number(n || 0).toFixed(2); };
const day = function (v) { try { return new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); } catch (e) { return String(v || ''); } };

/** sale = events.saleView(...), seller = invoices.sellerCard('company'). */
function render(sale, seller) {
  const t = sale.totals, s = seller || {};
  const taxCols = sale.interstate ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>';
  const rows = sale.items.map(function (i, n) {
    const tax = sale.interstate ? '<td class="n">' + m(i.igst) + '</td>' : '<td class="n">' + m(i.cgst) + '</td><td class="n">' + m(i.sgst) + '</td>';
    return '<tr><td>' + (n + 1) + '</td><td>' + esc(i.name) + '<div class="sub">' + esc(i.sku) + (i.batchNo ? ' · Batch ' + esc(i.batchNo) : '') + (i.expiry ? ' · Exp ' + esc(day(i.expiry)) : '') +
      '</div></td><td>' + esc(i.hsn || '') + '</td><td class="n">' + i.qty + '</td><td class="n">' + m(i.unitPrice) + '</td><td class="n">' + m(i.discount) + '</td><td class="n">' + m(i.taxable) +
      '</td><td class="n">' + m(i.gstRate) + '%</td>' + tax + '<td class="n">' + m(i.total) + '</td></tr>';
  }).join('');
  const taxRows = sale.interstate ? '<tr><th>IGST</th><td>' + m(t.igst) + '</td></tr>' : '<tr><th>CGST</th><td>' + m(t.cgst) + '</td></tr><tr><th>SGST</th><td>' + m(t.sgst) + '</td></tr>';
  const pays = sale.payments.length ? '<h3>Payments</h3><table><tr><th>Date</th><th>Method</th><th>Reference</th><th class="n">Amount</th></tr>' + sale.payments.map(function (p) {
    return '<tr><td>' + esc(day(p.at)) + '</td><td>' + esc(p.method.replace('_', ' ')) + (p.direction === 'refund' ? ' (refund)' : '') + '</td><td>' + esc(p.reference || '') + '</td><td class="n">' + (p.direction === 'refund' ? '−' : '') + m(p.amount) + '</td></tr>';
  }).join('') + '</table>' : '';
  const rets = sale.returns.length ? '<h3>Returns</h3><table><tr><th>No.</th><th>Date</th><th>Reason</th><th class="n">Refund</th></tr>' + sale.returns.map(function (r) {
    return '<tr><td>' + esc(r.returnNo) + '</td><td>' + esc(day(r.at)) + '</td><td>' + esc(r.reason) + '</td><td class="n">' + m(r.refund) + '</td></tr>';
  }).join('') + '</table>' : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>Invoice ' + esc(sale.invoiceNo) + '</title><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#16261a;margin:0;padding:24px;background:#fff}main{max-width:900px;margin:0 auto}' +
    'h1{font-size:20px;margin:0}h3{font-size:14px;margin:18px 0 6px}.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:2px solid #2f5d1f;padding-bottom:12px}' +
    '.muted,.sub{color:#5b6b5e;font-size:12px}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}th,td{border:1px solid #d9dfd4;padding:5px 6px;text-align:left;vertical-align:top}' +
    'th{background:#f3f6f0}.n{text-align:right;white-space:nowrap}.totals{width:auto;margin-left:auto}.totals th{text-align:left}.totals td{text-align:right;min-width:110px}' +
    '.void{background:#fbebeb;color:#8a1c1c;border:1px solid #e3a3a3;padding:8px 10px;font-weight:bold;margin:10px 0}.bar{margin:12px 0}' +
    '@media print{.bar{display:none}body{padding:0}}</style></head><body><main>' +
    '<div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div>' +
    (sale.voided ? '<div class="void">VOID — cancelled on ' + esc(day(sale.voided.at)) + ': ' + esc(sale.voided.reason) + '</div>' : '') +
    '<div class="top"><div><h1>' + esc(s.brand || s.name || 'Sake of Health') + '</h1><div class="muted">' + esc(s.name || '') + '<br>' + esc(s.address || '') +
    (s.gstin ? '<br>GSTIN ' + esc(s.gstin) : '') + (s.phone ? '<br>' + esc(s.phone) : '') + '</div></div>' +
    '<div><strong>Tax invoice</strong><br>No. ' + esc(sale.invoiceNo) + '<br>Date ' + esc(day(sale.soldAt)) + '<br><span class="muted">' + esc(sale.event.name) + ' (' + esc(sale.event.code) + ')</span></div></div>' +
    '<h3>Bill to</h3><div class="muted">' + esc(sale.customer.name || 'Walk-in customer') + (sale.customer.mobile ? ' · ' + esc(sale.customer.mobile) : '') +
    (sale.customer.gstin ? '<br>GSTIN ' + esc(sale.customer.gstin) : '') + '<br>Place of supply: ' + (sale.interstate ? 'outside ' : '') + esc(s.state || '') + '</div>' +
    '<table><tr><th>#</th><th>Item</th><th>HSN</th><th class="n">Qty</th><th class="n">Rate (MRP)</th><th class="n">Discount</th><th class="n">Taxable</th><th class="n">GST</th>' + taxCols + '<th class="n">Amount</th></tr>' + rows + '</table>' +
    '<table class="totals"><tr><th>Taxable value</th><td>' + m(t.taxable) + '</td></tr>' + taxRows + (t.discount ? '<tr><th>Discount (included above)</th><td>' + m(t.discount) + '</td></tr>' : '') +
    '<tr><th>Round off</th><td>' + m(t.roundOff) + '</td></tr><tr><th>Total</th><td><strong>₹ ' + m(t.grand) + '</strong></td></tr><tr><th>Paid</th><td>' + m(t.paid) + '</td></tr></table>' +
    pays + rets + (s.footer ? '<p class="muted">' + esc(s.footer) + '</p>' : '') + '<p class="muted">Prices include GST. This is a computer-generated invoice.</p></main></body></html>';
}

module.exports = { render, esc };
