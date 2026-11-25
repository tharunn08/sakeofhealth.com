/**
 * Backup codes for two-step sign-in: 10 one-time codes (like 7KQ2-M9XA) a person keeps on paper, to sign in
 * when their phone is lost. Each works once, in place of the 6-digit code.
 *
 * Storage: b2b_settings, one row per person (security.recovery.<staffId>), holding only keyed hashes
 * (HMAC-SHA256 with ERP_JWT_SECRET) — never the codes. No new table is needed. The trade settings page does
 * not list security.* keys. Making new codes replaces the old set; every use and every new set is audited.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');

const COUNT = 10;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
const SHAPE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;

function key(staffId) { return 'security.recovery.' + Number(staffId); }
function secret() { return require('../config.js').tokenSecret(); }
function normalise(code) { return String(code || '').toUpperCase().replace(/\s+/g, '').replace(/^([A-Z0-9]{4})([A-Z0-9]{4})$/, '$1-$2'); }
function hash(staffId, code) { return crypto.createHmac('sha256', secret()).update('recovery|' + Number(staffId) + '|' + normalise(code)).digest('base64url'); }

/** Pure: does this look like a backup code (and not a 6-digit authenticator code)? */
function looksLikeCode(code) { const c = String(code || '').toUpperCase().replace(/\s+/g, ''); return SHAPE.test(c) && !/^\d{6}$/.test(c); }

function makeCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

async function read(q, staffId) {
  const r = await (q || db).queryOne('SELECT setting_value FROM b2b_settings WHERE setting_key = ?', [key(staffId)]);
  if (!r) return null;
  try { const v = JSON.parse(r.setting_value); return v && Array.isArray(v.hashes) ? v : null; } catch (e) { return null; }
}

/** → { left, createdAt } or { left: 0 } when none were made. */
async function status(staffId) {
  const v = await read(null, staffId);
  return v ? { left: v.hashes.length, createdAt: v.createdAt || null } : { left: 0, createdAt: null };
}

/** New set for the signed-in person (who has an authenticator). → the 10 codes, shown once. */
async function generate(tx, actor, staffId) {
  const me = await tx.queryOne('SELECT mfa_enabled FROM b2b_staff WHERE id = ? FOR UPDATE', [staffId]);
  if (!me || Number(me.mfa_enabled) !== 1) {
    throw Object.assign(new Error('Set up your authenticator first; backup codes go with it.'), { status: 409, expose: true, code: 'no_authenticator' });
  }
  const codes = [];
  while (codes.length < COUNT) { const c = makeCode(); if (codes.indexOf(c) === -1) codes.push(c); }
  const value = JSON.stringify({ hashes: codes.map(function (c) { return hash(staffId, c); }), createdAt: new Date().toISOString() });
  await tx.query('INSERT INTO b2b_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
    [key(staffId), value, String(actor.label || ('staff #' + staffId)).slice(0, 190)]);
  await require('./audit.js').write(tx, actor, { module: 'core', action: 'security.recovery_codes_created', entity: 'staff', entityId: staffId, new: { count: COUNT } });
  return { codes: codes };
}

/**
 * Uses a code at sign-in: true when it matched an unused code, which is then struck off (in one transaction,
 * so the same code cannot be used twice at once). q: an open transaction or the pool.
 */
async function consume(staffId, code) {
  if (!looksLikeCode(code)) return false;
  const h = hash(staffId, code);
  return db.transaction(async function (tx) {
    const r = await tx.queryOne('SELECT setting_value FROM b2b_settings WHERE setting_key = ? FOR UPDATE', [key(staffId)]);
    if (!r) return false;
    let v; try { v = JSON.parse(r.setting_value); } catch (e) { return false; }
    const list = (v && Array.isArray(v.hashes)) ? v.hashes : [];
    const hit = list.findIndex(function (x) { const a = Buffer.from(String(x)), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); });
    if (hit === -1) return false;
    list.splice(hit, 1);
    await tx.query('UPDATE b2b_settings SET setting_value = ? WHERE setting_key = ?', [JSON.stringify({ hashes: list, createdAt: v.createdAt || null }), key(staffId)]);
    await require('./audit.js').write(tx, { type: 'staff', id: staffId, label: 'sign-in', role: 'recovery' },
      { module: 'core', action: 'security.recovery_code_used', entity: 'staff', entityId: staffId, new: { left: list.length } });
    return true;
  });
}

/** When an admin clears someone's authenticator, their backup codes go too. */
async function clear(tx, staffId) { await tx.query('DELETE FROM b2b_settings WHERE setting_key = ?', [key(staffId)]); }

module.exports = { status, generate, consume, clear, looksLikeCode, normalise, makeCode, hash, COUNT };
