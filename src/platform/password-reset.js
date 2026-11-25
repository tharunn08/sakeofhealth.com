/**
 * "Forgot password?" on /login, for business (ERP) staff accounts.
 *
 *   request(email)          always answers the same, whether or not the account exists. For an
 *                           active staff account it e-mails a link valid for 30 minutes.
 *   complete(token, pass)   sets the new password, ends every open session, clears the lock-out
 *                           and the "choose a new password" flag. Two-step sign-in is unchanged.
 *
 * The link carries no stored secret: it is signed with ERP_JWT_SECRET over the account id, the
 * expiry time, the CURRENT password hash and the session version. Using it changes the hash, so a
 * link works once; signing out everywhere or changing the password also kills it. The link puts the
 * token after "#", so it is never sent to the server in a URL, logged, or leaked in a Referer header.
 * Shop customers, trade buyers and suppliers keep their existing reset routes.
 */
'use strict';
const crypto = require('crypto');

const VALID_MS = 30 * 60 * 1000;
const RESEND_GAP_MS = 2 * 60 * 1000;          // one e-mail per account every 2 minutes
const recent = new Map();                      // staffId → last sent (this process)
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,180}\.[^@\s]{2,}$/;

function fail(status, msg, code) { return Object.assign(new Error(msg), { status: status, expose: true, code: code }); }
function secret() { return require('../modules/erp/config.js').tokenSecret(); }

function signature(id, exp, passwordHash, tokenVersion) {
  return crypto.createHmac('sha256', secret()).update(['erp-reset', id, exp, passwordHash, tokenVersion].join('|')).digest('base64url');
}

/** Pure: builds the token for a staff row ({ id, password_hash, token_version }). */
function makeToken(s, now) {
  const exp = (now || Date.now()) + VALID_MS;
  return Buffer.from(Number(s.id) + '.' + exp).toString('base64url') + '.' + signature(Number(s.id), exp, s.password_hash, Number(s.token_version));
}

/** Pure: → { id, exp } or null when the token is not well formed or has expired. */
function readToken(token, now) {
  const t = String(token || '');
  const dot = t.indexOf('.');
  if (dot < 1 || t.length > 400) return null;
  let head;
  try { head = Buffer.from(t.slice(0, dot), 'base64url').toString('utf8'); } catch (e) { return null; }
  const m = /^(\d{1,12})\.(\d{13})$/.exec(head);
  if (!m) return null;
  const exp = Number(m[2]);
  if ((now || Date.now()) > exp) return null;
  return { id: Number(m[1]), exp: exp, sig: t.slice(dot + 1) };
}

/** Pure: does the signature match this staff row as it is now? */
function matches(parsed, s) {
  if (!parsed || !s) return false;
  const want = Buffer.from(signature(parsed.id, parsed.exp, s.password_hash, Number(s.token_version)));
  const got = Buffer.from(parsed.sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function siteUrl() { return (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'https://www.sakeofhealth.com').replace(/\/$/, ''); }
const escHtml = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

function mail(name, link) {
  const site = siteUrl();
  const html = (/^https:\/\//.test(site) ? '<p><img src="' + escHtml(site + '/assets/images/logo-mark.png') + '" alt="Sake of Health" width="40" height="46"></p>' : '') +
    '<p>Hello ' + escHtml(name || '') + ',</p>' +
    '<p>Someone asked to reset the password for your Sake of Health business account. If it was you, open this link within 30 minutes:</p>' +
    '<p><a href="' + escHtml(link) + '">Choose a new password</a></p>' +
    '<p>The link works once. If you did not ask for this, ignore this e-mail: your password stays the same.</p>' +
    '<p>Sake of Health</p>';
  const text = 'Hello ' + (name || '') + ',\n\nSomeone asked to reset the password for your Sake of Health business account. ' +
    'If it was you, open this link within 30 minutes:\n\n' + link + '\n\nThe link works once. If you did not ask for this, ignore this e-mail: your password stays the same.\n\nSake of Health';
  return { subject: 'Reset your Sake of Health password', html: html, text: text };
}

/**
 * deps (tests): { db, send(to, subject, html, text), audit(entry, staffId), now }
 * → { sent: boolean } for the caller's logs only; the HTTP answer never says.
 */
async function request(email, ctx, deps) {
  deps = deps || {};
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) return { sent: false };
  const db = deps.db || require('../db/connection.js');
  const s = await db.queryOne('SELECT id, name, email, status, password_hash, token_version FROM b2b_staff WHERE email = ?', [email]);
  if (!s || s.status !== 'active' || !s.password_hash) return { sent: false };
  const now = deps.now || Date.now();
  const last = recent.get(Number(s.id));
  if (last && now - last < RESEND_GAP_MS) return { sent: false, throttled: true };
  recent.set(Number(s.id), now);
  const link = siteUrl() + '/login#reset=' + makeToken(s, now);
  const m = mail(s.name, link);
  const send = deps.send || require('../services/notify.js').sendEmail;
  const r = await send(s.email, m.subject, m.html, m.text);
  await (deps.audit || auditWrite)({ action: 'staff.password_reset_requested', ok: !!(r && r.ok), ip: ctx && ctx.ip }, Number(s.id));
  return { sent: !!(r && r.ok) };
}

async function complete(token, newPassword, ctx, deps) {
  deps = deps || {};
  const parsed = readToken(token, deps.now);
  const expired = fail(400, 'This reset link has expired or was already used. Ask for a new one.', 'bad_link');
  if (!parsed) throw expired;
  const security = require('../modules/erp/core/security.js');
  const hash = security.hashPassword(newPassword);              // 12+ characters, else 400
  const db = deps.db || require('../db/connection.js');
  const run = deps.transaction || function (fn) { return db.transaction(fn); };
  return run(async function (tx) {
    const s = await tx.queryOne('SELECT id, email, name, status, password_hash, token_version FROM b2b_staff WHERE id = ? FOR UPDATE', [parsed.id]);
    if (!s || s.status !== 'active' || !matches(parsed, s)) throw expired;
    await tx.query('UPDATE b2b_staff SET password_hash = ?, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?', [hash, s.id]);
    await (deps.clearMustChange || function (id, q) { return require('../db/mustChange.js').clear('staff', id, q); })(s.id, tx);
    await (deps.audit || auditWrite)({ action: 'staff.password_reset', ip: ctx && ctx.ip }, Number(s.id), tx);
    return { ok: true, email: s.email };
  });
}

async function auditWrite(e, staffId, tx) {
  const audit = require('../modules/erp/core/audit.js');
  await audit.write(tx || null, { type: 'staff', id: staffId, label: 'self-service', role: 'password_reset', ip: e.ip },
    { module: 'core', action: e.action, entity: 'staff', entityId: staffId, new: e.ok === undefined ? null : { emailAccepted: e.ok } });
}

function forget() { recent.clear(); }

module.exports = { request, complete, makeToken, readToken, matches, VALID_MS, forget };
