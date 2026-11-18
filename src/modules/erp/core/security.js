/**
 * ERP credentials: scrypt password hashes (same format as the B2B portal), HMAC
 * session tokens bound to token_version, and RFC 6238 TOTP for MFA.
 * Nothing here touches the database.
 */
'use strict';
const crypto = require('crypto');
const config = require('../config.js');

function hashPassword(password) {
  const p = String(password || '');
  if (p.length < 12) throw Object.assign(new Error('Password must be at least 12 characters'), { status: 400, expose: true });
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt:' + salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const test = crypto.scryptSync(String(password), parts[1], 64);
    const ref = Buffer.from(parts[2], 'hex');
    return test.length === ref.length && crypto.timingSafeEqual(test, ref);
  } catch (e) { return false; }
}

/** A dummy verify so an unknown e-mail takes as long as a wrong password. */
const DUMMY = 'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(128);
function burnTime(password) { verifyPassword(password, DUMMY); }

/** aud: 'erp' (staff, default) or 'vendor' (vendor portal). A token for one audience is refused by the other. */
function sign(payload, now, aud) {
  now = now || Date.now();
  const body = Object.assign({}, payload, { aud: aud || 'erp', iat: now, exp: now + config.sessionHours() * 3600 * 1000 });
  const enc = Buffer.from(JSON.stringify(body)).toString('base64url');
  return enc + '.' + crypto.createHmac('sha256', config.tokenSecret()).update(enc).digest('base64url');
}

function verify(token, now, aud) {
  token = String(token || '');
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const enc = token.slice(0, dot), sig = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(crypto.createHmac('sha256', config.tokenSecret()).update(enc).digest('base64url'));
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(enc, 'base64url').toString('utf8'));
    if (p.aud !== (aud || 'erp') || !p.exp || (now || Date.now()) > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

// ── TOTP (RFC 6238, SHA-1, 30 s, 6 digits — what authenticator apps use) ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  s = String(s).replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of s) { const i = B32.indexOf(c); if (i < 0) throw new Error('bad base32'); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totpAt(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000;
  return String(code).padStart(6, '0');
}
function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
/** Accepts the current 30-second step and one either side (clock drift). */
function verifyTotp(secretB32, code, now) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const step = Math.floor((now || Date.now()) / 30000);
  for (const d of [-1, 0, 1]) {
    const a = Buffer.from(totpAt(secretB32, step + d)), b = Buffer.from(String(code));
    if (crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

// MFA secrets are stored encrypted (AES-256-GCM, key derived from the token secret).
function key() { return crypto.createHash('sha256').update('erp-mfa:' + config.tokenSecret()).digest(); }
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + enc.toString('base64');
}
function decrypt(blob) {
  const p = String(blob || '').split(':');
  if (p[0] !== 'v1' || p.length !== 4) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(p[1], 'base64'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

module.exports = { hashPassword, verifyPassword, burnTime, sign, verify, newTotpSecret, verifyTotp, totpAt, base32Encode, base32Decode, encrypt, decrypt };
