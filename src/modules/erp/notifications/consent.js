/**
 * Consent and opt-out (N3). The one place that decides whether a message may go to an address.
 *
 *   - Preferences are kept per channel and per address (email / mobile), stored as a hash of
 *     the normalised address (b2b_contact_preferences). Linked to an account when known.
 *   - scope 'promotional': opted_in (recorded consent) or opted_out.
 *   - scope 'all': opted_out stops every message on that channel except one-time codes
 *     (the person asked us to stop; sign-in codes are what they request themselves).
 *     opted_in on 'all' means "resumed".
 *   - Promotional messages need a recorded opt-in on that channel and no opt-out (D4).
 *   - Every change is written to the tamper-evident audit log with the address masked.
 *
 * The outbox worker calls blockReason() for every row just before sending, so the rule holds
 * for new sends, resends, approved sends and workflow messages alike.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const directory = require('./directory.js');
const { fail } = require('../lib/http.js');

const CHANNELS = ['email', 'whatsapp', 'sms'];
const SOURCES = ['portal', 'admin_written', 'admin_call', 'admin_email', 'admin_meeting', 'unsubscribe_link', 'whatsapp_reply', 'provider_report'];
const OTP = /_otp$/;

function normalize(channel, address) {
  const a = String(address == null ? '' : address).trim();
  if (channel === 'email') return directory.validEmail(a) ? a.toLowerCase() : null;
  const d = a.replace(/\D/g, '');
  return d.length >= 10 ? '91' + d.slice(-10) : null;   // Indian mobiles: the last 10 digits decide
}
function hash(channel, address) {
  const n = normalize(channel, address);
  return n ? crypto.createHash('sha256').update('soh-contact:' + channel + ':' + n, 'utf8').digest('hex') : null;
}
function mask(channel, address) { return channel === 'email' ? directory.maskEmail(address) : directory.maskMobile(address); }

/** The decision, pure: prefs = { promotional: state|null, all: state|null }. null = may send. */
function decide(category, prefs, isOtp) {
  if (isOtp) return null;
  if (prefs.all === 'opted_out') return 'opted out of all messages on this channel';
  if (category === 'promotional') {
    if (prefs.promotional === 'opted_out') return 'opted out of promotional messages';
    if (prefs.promotional !== 'opted_in') return 'no recorded consent for promotional messages';
  }
  return null;
}

async function prefsOf(run, channel, h) {
  const out = { promotional: null, all: null };
  if (!h) return out;
  const rows = await (run || db).query('SELECT scope, state FROM b2b_contact_preferences WHERE channel = ? AND address_hash = ?', [channel, h]);
  rows.forEach(function (r) { out[r.scope] = r.state; });
  return out;
}

/** For the outbox worker: why this queue row must not be sent (null = send it). Throws on DB errors (the worker then retries later: fail closed). */
async function blockReason(row) {
  if (CHANNELS.indexOf(row.channel) === -1) return null;
  const isOtp = !!(row.template_name && OTP.test(row.template_name));
  let category = 'transactional';
  try {
    if (row.message_id) {
      const m = await db.queryOne('SELECT category FROM b2b_messages WHERE id = ?', [row.message_id]);
      if (m) category = m.category;
    }
    const prefs = await prefsOf(null, row.channel, hash(row.channel, row.recipient));
    return decide(category, prefs, isOtp);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') return null;   // before migration 016: no preferences can exist
    throw e;
  }
}

/**
 * Record a preference. who = { channel, address, recipient?: {type, ref}, scope, state, source, note }.
 * Staff recording an opt-in must say how the consent was given (source + note).
 */
async function record(tx, actor, who) {
  if (!tx) return db.transaction(function (t) { return record(t, actor, who); });
  const channel = who.channel, scope = who.scope, state = who.state, source = who.source;
  if (CHANNELS.indexOf(channel) === -1) throw fail(400, 'channel must be email, whatsapp or sms');
  if (['promotional', 'all'].indexOf(scope) === -1) throw fail(400, 'scope must be promotional or all');
  if (['opted_in', 'opted_out'].indexOf(state) === -1) throw fail(400, 'state must be opted_in or opted_out');
  if (SOURCES.indexOf(source) === -1) throw fail(400, 'source must be one of ' + SOURCES.join(', '));
  const h = hash(channel, who.address);
  if (!h) throw fail(400, 'A valid ' + (channel === 'email' ? 'email address' : 'mobile number') + ' is needed', 'no_address');
  const note = who.note ? String(who.note).trim().slice(0, 300) : '';
  if (state === 'opted_in' && scope === 'promotional' && /^admin_/.test(source) && note.length < 5)
    throw fail(400, 'Say how and when the person agreed (at least 5 characters)', 'consent_evidence');
  const old = await tx.queryOne('SELECT id, state, source FROM b2b_contact_preferences WHERE channel = ? AND address_hash = ? AND scope = ? FOR UPDATE', [channel, h, scope]);
  const rt = who.recipient && directory.TYPES.indexOf(who.recipient.type) !== -1 ? who.recipient.type : null;
  const rr = rt ? Number(who.recipient.ref) || null : null;
  let id;
  if (old) {
    if (old.state === state && old.source === source && !note) return { id: Number(old.id), state: state, changed: false };
    await tx.query('UPDATE b2b_contact_preferences SET state = ?, source = ?, recorded_by_label = ?, recipient_type = COALESCE(?, recipient_type), recipient_ref = COALESCE(?, recipient_ref) WHERE id = ?',
      [state, source, actor && actor.label ? String(actor.label).slice(0, 190) : null, rt, rr, old.id]);
    id = Number(old.id);
  } else {
    const ins = await tx.query('INSERT INTO b2b_contact_preferences (channel, address_hash, scope, state, recipient_type, recipient_ref, source, recorded_by_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [channel, h, scope, state, rt, rr, source, actor && actor.label ? String(actor.label).slice(0, 190) : null]);
    id = Number(ins.insertId);
  }
  await audit.write(tx, actor, { module: 'notifications', action: 'consent.' + state, entity: 'contact_preference', entityId: id,
    old: old ? { state: old.state, source: old.source } : null,
    new: { channel: channel, scope: scope, state: state, source: source, address: mask(channel, who.address), recipient: rt ? rt + ':' + rr : null }, reason: note || null });
  return { id: id, state: state, changed: true };
}

/** Preferences of these people on these channels, by their CURRENT addresses: [{ type, ref, channel, promotional, all, hasAddress }]. */
async function forRecipients(people, channels) {
  const out = [];
  for (const p of people) {
    for (const ch of channels) {
      const addr = ch === 'email' ? p.email : p.mobile;
      const prefs = await prefsOf(null, ch, hash(ch, addr));
      out.push({ type: p.type, ref: p.ref, channel: ch, hasAddress: !!normalize(ch, addr), promotional: prefs.promotional, all: prefs.all });
    }
  }
  return out;
}

/** The list for the Consent screen (addresses are never stored in clear; names come from the linked account). */
async function list(q) {
  const where = [], args = [];
  if (q.channel && CHANNELS.indexOf(q.channel) !== -1) { where.push('p.channel = ?'); args.push(q.channel); }
  if (q.scope && ['promotional', 'all'].indexOf(q.scope) !== -1) { where.push('p.scope = ?'); args.push(q.scope); }
  if (q.state && ['opted_in', 'opted_out'].indexOf(q.state) !== -1) { where.push('p.state = ?'); args.push(q.state); }
  const rows = await db.query(
    'SELECT p.id, p.channel, p.scope, p.state, p.recipient_type, p.recipient_ref, p.source, p.recorded_by_label, p.updated_at, ' +
    "COALESCE(a.business_name, a.shop_name, s.name, v.trade_name, v.legal_name) AS name FROM b2b_contact_preferences p " +
    "LEFT JOIN b2b_accounts a ON p.recipient_type IN ('retailer','distributor') AND a.id = p.recipient_ref " +
    "LEFT JOIN b2b_staff s ON p.recipient_type = 'staff' AND s.id = p.recipient_ref " +
    "LEFT JOIN b2b_vendors v ON p.recipient_type IN ('supplier','manufacturer') AND v.id = p.recipient_ref " +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY p.updated_at DESC, p.id DESC LIMIT 500', args);
  return rows.map(function (r) {
    return { id: Number(r.id), channel: r.channel, scope: r.scope, state: r.state, recipient: r.recipient_type ? { type: r.recipient_type, ref: Number(r.recipient_ref), name: r.name || '(removed)' } : null,
      source: r.source, recordedBy: r.recorded_by_label, updatedAt: r.updated_at };
  });
}

// ── Unsubscribe links in promotional emails (signed, no expiry: an old email must still work) ──
function secret() { return process.env.ERP_JWT_SECRET || process.env.B2B_JWT_SECRET || ''; }
function b64(s) { return Buffer.from(s, 'utf8').toString('base64url'); }
function unsubscribeToken(channel, address) {
  const h = hash(channel, address); const k = secret();
  if (!h || !k) return null;
  const body = b64(JSON.stringify({ c: channel, h: h, s: 'promotional' }));
  return body + '.' + crypto.createHmac('sha256', k).update('unsubscribe:' + body).digest('base64url');
}
function readToken(t) {
  const parts = String(t || '').split('.'); const k = secret();
  if (parts.length !== 2 || !k) return null;
  const want = crypto.createHmac('sha256', k).update('unsubscribe:' + parts[0]).digest('base64url');
  const a = Buffer.from(want), b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); return CHANNELS.indexOf(o.c) !== -1 && /^[0-9a-f]{64}$/.test(o.h) ? o : null; } catch (e) { return null; }
}
/** Opt-out from a link: only the hash is known (no address in the link or the database). */
async function unsubscribe(token) {
  const o = readToken(token);
  if (!o) throw fail(400, 'This unsubscribe link is not valid', 'bad_token');
  return db.transaction(async function (tx) {
    const old = await tx.queryOne("SELECT id, state FROM b2b_contact_preferences WHERE channel = ? AND address_hash = ? AND scope = 'promotional' FOR UPDATE", [o.c, o.h]);
    let id;
    if (old) {
      if (old.state === 'opted_out') return { id: Number(old.id), changed: false };
      await tx.query("UPDATE b2b_contact_preferences SET state = 'opted_out', source = 'unsubscribe_link', recorded_by_label = NULL WHERE id = ?", [old.id]);
      id = Number(old.id);
    } else {
      id = Number((await tx.query("INSERT INTO b2b_contact_preferences (channel, address_hash, scope, state, source) VALUES (?, ?, 'promotional', 'opted_out', 'unsubscribe_link')", [o.c, o.h])).insertId);
    }
    await audit.write(tx, { type: 'system', id: null, role: 'system', label: 'unsubscribe link' }, { module: 'notifications', action: 'consent.opted_out', entity: 'contact_preference', entityId: id,
      old: old ? { state: old.state } : null, new: { channel: o.c, scope: 'promotional', state: 'opted_out', source: 'unsubscribe_link' } });
    return { id: id, changed: true };
  });
}

module.exports = { CHANNELS, SOURCES, normalize, hash, decide, blockReason, record, forRecipients, list, unsubscribeToken, readToken, unsubscribe, prefsOf };
