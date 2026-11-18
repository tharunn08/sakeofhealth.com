/**
 * Customer authentication — email + password signup/login for shoppers.
 * Completely separate from admin auth: its own required secret
 * (CUSTOMER_JWT_SECRET), its own token type ("customer"), its own collection. Logging in is optional: guest
 * checkout continues to work whether or not a customer is signed in.
 */
const { createHmac, timingSafeEqual, scryptSync, randomBytes } = require('crypto');
const { db } = require('../services/db.js');

const TOKEN_TTL_MS = Number(process.env.CUSTOMER_SESSION_DAYS || 30) * 24 * 3600 * 1000;

const MIN_SECRET_LENGTH = 48;
const UNAVAILABLE = 'Account sign-in is temporarily unavailable. You can still check out as a guest.';

/*
 * The customer token secret must be configured separately
 * (CUSTOMER_JWT_SECRET, 48+ characters, different from ADMIN_JWT_SECRET).
 * There is deliberately NO derivation and NO fallback to another secret or
 * a constant. Without it, account sign-in answers 503 and guest checkout
 * keeps working.
 */
function secret() {
  const s = process.env.CUSTOMER_JWT_SECRET || '';
  if (s.length < MIN_SECRET_LENGTH) return null;
  if (s === (process.env.ADMIN_JWT_SECRET || '')) return null;
  return s;
}
function isConfigured() { return secret() !== null; }
if (!isConfigured()) {
  console.warn('[security] CUSTOMER_JWT_SECRET is missing, shorter than ' + MIN_SECRET_LENGTH + ' characters, or equal to ADMIN_JWT_SECRET: shopper accounts are disabled until it is set (guest checkout still works).');
}

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

function signToken(payload) {
  const key = secret();
  if (!key) throw new Error('CUSTOMER_JWT_SECRET is not configured');
  const body = Object.assign({}, payload, { typ: 'customer', exp: Date.now() + TOKEN_TTL_MS });
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = createHmac('sha256', key).update(encoded).digest('base64url');
  return encoded + '.' + sig;
}

/* Accepts typ "customer", or an untyped token issued before Phase 0.5 with
   the same (separate) customer secret; rejects any other token type. */
function verifyToken(token) {
  const key = secret();
  if (!key || !token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  const expected = createHmac('sha256', key).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1] || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    if (payload.typ !== undefined && payload.typ !== 'customer') return null;
    return payload;
  } catch { return null; }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function signup(email, password, name) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  name = String(name || '').trim();

  if (!isConfigured()) return { ok: false, unavailable: true, error: UNAVAILABLE };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'A valid email is required' };
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters' };

  if (db.accounts.findOne({ email: email })) {
    return { ok: false, error: 'An account with this email already exists' };
  }

  const account = db.accounts.insert({
    email: email,
    name: name || email.split('@')[0],
    passwordHash: hashPassword(password),
    active: true,
  });

  return {
    ok: true,
    token: signToken({ sub: account.id, email: account.email, role: 'customer' }),
    user: { id: account.id, email: account.email, name: account.name },
  };
}

function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!isConfigured()) return { ok: false, unavailable: true, error: UNAVAILABLE };
  if (!email || !password) return { ok: false, error: 'Email and password required' };

  const account = db.accounts.findOne({ email: email });
  if (!account || account.active === false) return { ok: false, error: 'Invalid email or password' };
  if (!verifyPassword(password, account.passwordHash)) return { ok: false, error: 'Invalid email or password' };

  db.accounts.update(account.id, { lastLogin: new Date().toISOString() });
  return {
    ok: true,
    token: signToken({ sub: account.id, email: account.email, role: 'customer' }),
    user: { id: account.id, email: account.email, name: account.name },
  };
}

/* Attaches req.customer if a valid token is present; never blocks the request. */
function optionalCustomerAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyToken(token);
  req.customer = payload || null;
  next();
}

/* Blocks the request unless a valid customer token is present. */
function requireCustomerAuth(req, res, next) {
  if (!isConfigured()) return res.status(503).json({ error: UNAVAILABLE });
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Please log in to continue' });
  req.customer = payload;
  next();
}

module.exports = {
  signup, login, verifyToken, hashPassword, verifyPassword,
  optionalCustomerAuth, requireCustomerAuth, isConfigured,
};
