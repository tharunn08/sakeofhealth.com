/** Integer-paise money helpers (no floating-point sums). */
'use strict';
function paise(v) {
  const s = String(v == null ? '0' : v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw Object.assign(new Error('Invalid amount: ' + s), { status: 400, expose: true });
  const neg = s[0] === '-', t = neg ? s.slice(1) : s;
  const [i, f = ''] = t.split('.');
  const frac = (f + '000').slice(0, 3);
  let p = Number(i) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return neg ? -p : p;
}
/** Value in 1/10000 rupee (4 decimals, half-up beyond) — for unit prices. */
function p4(v) {
  const s = String(v == null ? '0' : v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw Object.assign(new Error('Invalid price: ' + s), { status: 400, expose: true });
  const [i, f = ''] = s.split('.');
  const frac = (f + '00000').slice(0, 5);
  return Number(i) * 10000 + Number(frac.slice(0, 4)) + (Number(frac[4]) >= 5 ? 1 : 0);
}
function rupees(p) { const neg = p < 0; p = Math.abs(Math.round(p)); return (neg ? '-' : '') + Math.floor(p / 100) + '.' + String(p % 100).padStart(2, '0'); }
/** round(a * b / c) half-up for non-negative integers. */
function mulDiv(a, b, c) { return Math.floor((2 * a * b + c) / (2 * c)); }
/** One GST line: qty × rate less discount% → taxable, tax, split. Rates in percent (e.g. 5, 0.25). */
function line(qty, unitPrice, discountPct, gstRate, interstate) {
  const gross = mulDiv(qty, p4(unitPrice), 100);                // unit prices may carry 4 decimals; the line rounds once to paise
  const discBp = Math.round(Number(discountPct || 0) * 100);
  const discount = mulDiv(gross, discBp, 10000);
  const taxable = gross - discount;
  const tax = mulDiv(taxable, Math.round(Number(gstRate) * 100), 10000);
  const cgst = interstate ? 0 : Math.floor(tax / 2), sgst = interstate ? 0 : tax - cgst, igst = interstate ? tax : 0;
  return { gross: gross, discount: discount, taxable: taxable, tax: tax, cgst: cgst, sgst: sgst, igst: igst, total: taxable + tax };
}
module.exports = { paise, p4, rupees, mulDiv, line };
