/**
 * Admin authentication — email + password login issuing HMAC-signed tokens.
 * Supports a root admin from .env plus staff accounts stored in the DB.
 */
const { createHmac, timingSafeEqual, scryptSync, randomBytes } = require('crypto');
const { db } = require('../services/db.js');

const TOKEN_TTL_MS = Number(process.env.ADMIN_SESSION_HOURS || 12) * 3600 * 1000;
const MIN_SECRET_LENGTH = 48;
const UNAVAILABLE = 'Admin sign-in is temporarily unavailable: the server is not configured for it. Contact the site owner.';

/*
 * The admin token secret must be configured explicitly (ADMIN_JWT_SECRET,
 * 48+ characters). There is deliberately NO fallback to the admin password
 * or to a built-in constant: without a proper secret, admin sign-in is
 * refused (503) while the shop itself keeps working.
 */
function secret() {
  const s = process.env.ADMIN_JWT_SECRET || '';
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}
function isConfigured() { return secret() !== null; }
if (!isConfigured()) {
  console.warn('[security] ADMIN_JWT_SECRET is missing or shorter than ' + MIN_SECRET_LENGTH + ' characters: admin sign-in is disabled until it is set.');
}

/* ── Password hashing ── */
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const parts = stored.split(':');
  try {
    const test = scryptSync(password, parts[0], 64);
    const ref = Buffer.from(parts[1], 'hex');
    return test.length === ref.length && timingSafeEqual(test, ref);
  } catch { return false; }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

/* ── Tokens ── */
function signToken(payload) {
  const key = secret();
  if (!key) throw new Error('ADMIN_JWT_SECRET is not configured');
  const body = Object.assign({}, payload, { typ: 'staff', exp: Date.now() + TOKEN_TTL_MS });
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = createHmac('sha256', key).update(encoded).digest('base64url');
  return encoded + '.' + sig;
}

/*
 * Accepts only staff tokens:
 *  - typ "staff" (issued from Phase 0.5 on), or
 *  - an untyped token issued before Phase 0.5, ONLY if it carries a staff
 *    role (never "customer") and its lifetime is within one staff session.
 *    These expire on their own within ADMIN_SESSION_HOURS, so no one is
 *    forced to sign in again by the upgrade.
 */
function verifyToken(token) {
  const key = secret();
  if (!key || !token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  const expected = createHmac('sha256', key).update(parts[0]).digest('base64url');
  if (!safeEqual(parts[1], expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return null; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  if (payload.typ === 'staff') return payload;
  if (payload.typ !== undefined) return null;
  const role = typeof payload.role === 'string' ? payload.role : '';
  if (!role || role === 'customer') return null;
  if (payload.exp - Date.now() > TOKEN_TTL_MS + 60 * 1000) return null;
  return payload;
}

/* ── Login ── */
function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!isConfigured()) return { ok: false, unavailable: true, error: UNAVAILABLE };
  if (!email || !password) return { ok: false, error: 'Email and password required' };

  const rootEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const rootPass = process.env.ADMIN_PASSWORD || '';


  if (rootEmail && rootPass && email === rootEmail) {
    if (!safeEqual(password, rootPass)) return { ok: false, error: 'Invalid credentials' };
    return {
      ok: true,
      token: signToken({ sub: 'root', email: rootEmail, name: 'Administrator', role: 'admin' }),
      user: { email: rootEmail, name: 'Administrator', role: 'admin' },
    };
  }

  const staff = db.staff.findOne({ email: email });
  if (!staff || staff.active === false) return { ok: false, error: 'Invalid credentials' };
  if (!verifyPassword(password, staff.passwordHash)) return { ok: false, error: 'Invalid credentials' };

  db.staff.update(staff.id, { lastLogin: new Date().toISOString() });
  return {
    ok: true,
    token: signToken({ sub: staff.id, email: staff.email, name: staff.name, role: staff.role || 'staff' }),
    user: { email: staff.email, name: staff.name, role: staff.role || 'staff' },
  };
}

/* ── Middleware ── */
function adminAuth(req, res, next) {
  if (!isConfigured()) return res.status(503).json({ error: UNAVAILABLE });
  const auth = req.headers['authorization'] || '';
  // Header only: tokens in URLs leak into logs and browser history (Phase 0.5.9, BUG-016).
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized — please log in again' });
  req.admin = payload;
  next();
}

function requireRole() {
  const roles = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.admin) return res.status(401).json({ error: 'Unauthorized' });
    if (req.admin.role === 'admin') return next();
    if (roles.indexOf(req.admin.role) === -1) {
      return res.status(403).json({ error: 'Forbidden — insufficient permissions' });
    }
    next();
  };
}

module.exports = { adminAuth, requireRole, login, signToken, verifyToken, hashPassword, verifyPassword, isConfigured };
