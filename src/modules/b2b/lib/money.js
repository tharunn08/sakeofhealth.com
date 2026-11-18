/**
 * Money helpers. Every amount is an INTEGER number of paise while in
 * JavaScript and a DECIMAL(…,2) string at the database boundary — rupee
 * values are never held in binary floating point.
 */

/** '1234.50' | 1234.5 | null → 123450 (paise). Rejects junk. */
function toPaise(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Invalid amount');
    return Math.round(v * 100);
  }
  const s = String(v).trim().replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,}))?$/.exec(s);
  if (!m) throw new Error('Invalid amount: ' + v);
  const whole = Number(m[2]);
  let frac = (m[3] || '').padEnd(3, '0');
  let paise = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) paise += 1; // round half up on the third decimal
  return m[1] ? -paise : paise;
}

/** 123450 → '1234.50' (for DECIMAL columns and JSON output). */
function fromPaise(p) {
  p = Math.round(Number(p) || 0);
  const neg = p < 0;
  p = Math.abs(p);
  const s = Math.floor(p / 100) + '.' + String(p % 100).padStart(2, '0');
  return neg ? '-' + s : s;
}

/** Percent with up to 3 decimals → integer thousandths of a percent. '12.5' → 12500 */
function toMilliPct(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Invalid percentage: ' + v);
  return Math.round(n * 1000);
}

/** paise × pct (half-up). pctOf(10000, 12500) → 1250 */
function pctOf(paise, milliPct) {
  const x = paise * milliPct;
  if (!Number.isSafeInteger(x)) throw new Error('Amount too large');
  return Math.round(x / 100000);
}

function sum(list, fn) {
  let t = 0;
  for (let i = 0; i < list.length; i++) t += fn ? fn(list[i]) : list[i];
  return t;
}

/** Round a paise total to the nearest rupee; returns { rounded, roundOff } (both paise). */
function roundToRupee(paise) {
  const rounded = Math.round(paise / 100) * 100;
  return { rounded: rounded, roundOff: rounded - paise };
}

/** For display in server-generated text (emails, CSV). */
function inr(paise) {
  const s = fromPaise(paise);
  const parts = s.split('.');
  let n = parts[0].replace('-', '');
  // Indian digit grouping: 12,34,567
  if (n.length > 3) n = n.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + n.slice(-3);
  return (s[0] === '-' ? '-' : '') + '₹' + n + '.' + parts[1];
}

module.exports = { toPaise, fromPaise, toMilliPct, pctOf, sum, roundToRupee, inr };
