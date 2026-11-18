/**
 * Input validation & normalisation for Indian business data.
 */
const RX = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  mobile: /^[6-9]\d{9}$/,
  pincode: /^[1-9]\d{5}$/,
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  gstin: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  sku: /^[A-Za-z0-9][A-Za-z0-9._\-\/]{0,63}$/,
  hsn: /^\d{4}(\d{2})?(\d{2})?$/,
};

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Official GSTIN check-digit algorithm (mod-36). */
function gstinCheckDigit(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36];
}

function isGstin(v) {
  v = String(v || '').toUpperCase();
  return RX.gstin.test(v) && gstinCheckDigit(v.slice(0, 14)) === v[14];
}

const isEmail = v => RX.email.test(String(v || '')) && String(v).length <= 190;
const isMobile = v => RX.mobile.test(String(v || ''));
const isPincode = v => RX.pincode.test(String(v || ''));
const isPan = v => RX.pan.test(String(v || '').toUpperCase());
const isSku = v => RX.sku.test(String(v || ''));
const isHsn = v => RX.hsn.test(String(v || ''));

/** '+91 98765-43210' → '9876543210' */
function mobile(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/** Trim, collapse whitespace, strip control characters, cap the length. */
function text(v, max) {
  if (v == null) return '';
  // eslint-disable-next-line no-control-regex
  let s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function upper(v, max) { return text(v, max).toUpperCase(); }
function email(v) { return text(v, 190).toLowerCase(); }

/** Positive integer or null. */
function posInt(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function intOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Non-negative decimal with at most `dp` decimals, as a string — or null if invalid. */
function decimal(v, dp, max) {
  if (v === '' || v == null) return null;
  const s = String(v).trim().replace(/,/g, '').replace(/^₹\s*/, '').replace(/%$/, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || (max != null && n > max)) return null;
  return n.toFixed(dp == null ? 2 : dp);
}

function lat(v) { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n >= -90 && n <= 90 ? n.toFixed(7) : null; }
function lng(v) { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n >= -180 && n <= 180 ? n.toFixed(7) : null; }

/** 'YYYY-MM-DD' or null. Accepts Date objects, ISO strings and DD/MM/YYYY. */
function date(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) { const d = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s); if (d) m = [0, d[3], d[2].padStart(2, '0'), d[1].padStart(2, '0')]; }
  if (!m) return null;
  const iso = m[1] + '-' + m[2] + '-' + m[3];
  const t = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso ? null : iso;
}

function bool(v, dflt) {
  if (v == null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'active', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'inactive', 'off'].includes(s)) return false;
  return dflt;
}

function slug(v) {
  return text(v, 120).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

/** Password policy for business accounts. Returns an error string or null. */
function passwordProblem(p) {
  p = String(p || '');
  if (p.length < 8) return 'Password must be at least 8 characters';
  if (p.length > 128) return 'Password is too long';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Password must contain at least one letter and one number';
  return null;
}

module.exports = {
  RX, isEmail, isMobile, isPincode, isPan, isGstin, isSku, isHsn, gstinCheckDigit,
  mobile, text, upper, email, posInt, intOrNull, decimal, lat, lng, date, bool, slug, passwordProblem,
};
