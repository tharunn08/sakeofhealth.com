/**
 * Password hashing (scrypt — built into Node, no native add-ons to compile on
 * shared hosting) and HMAC-signed session tokens for business users.
 *
 * Business tokens use their own secret, so an admin or customer token can
 * never be replayed against the B2B portal, or the other way round.
 */
const { createHmac, timingSafeEqual, scryptSync, randomBytes } = require('crypto');
const config = require('../config.js');

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return 'scrypt:' + salt + ':' + scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const test = scryptSync(String(password), parts[1], 64);
    const ref = Buffer.from(parts[2], 'hex');
    return test.length === ref.length && timingSafeEqual(test, ref);
  } catch (e) { return false; }
}

function signToken(payload) {
  const body = Object.assign({}, payload, { exp: Date.now() + config.sessionHours() * 3600 * 1000, aud: 'b2b' });
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  return encoded + '.' + createHmac('sha256', config.tokenSecret()).update(encoded).digest('base64url');
}

function verifyToken(token) {
  token = String(token || '');
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const encoded = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = createHmac('sha256', config.tokenSecret()).update(encoded).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (payload.aud !== 'b2b' || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}

function randomId(bytes) { return randomBytes(bytes || 16).toString('hex'); }

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, randomId };
