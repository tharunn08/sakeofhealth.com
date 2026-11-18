/**
 * WhatsApp Cloud API webhooks: GET subscription handshake and POST delivery
 * statuses. Signature over the RAW body (X-Hub-Signature-256, app secret),
 * replay refusal via b2b_webhook_events (unique provider + event id), and
 * status never moves backwards. Only notification delivery status is updated —
 * never orders, stock or money.
 */
'use strict';
const crypto = require('crypto');
const express = require('express');
const db = require('../../../db/connection.js');
const config = require('../config.js');
const monitor = require('./monitor.js');

/** Append the accepted report to the message's status history (migration 016). */
async function recordHistory(providerId, status, provider, detail) {
  const q = await db.queryOne('SELECT id FROM b2b_notification_queue WHERE provider_message_id = ? ORDER BY id DESC LIMIT 1', [providerId]);
  if (q) await require('../../b2b/notifications/service.js').history(null, q.id, status, { source: 'webhook', provider: provider, providerRef: providerId, detail: detail });
}

function verifySignature(raw, header, secret) {
  if (!secret || secret.length < 16) return { ok: false, reason: 'not_configured' };
  if (!Buffer.isBuffer(raw)) return { ok: false, reason: 'raw_body_required' };
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  if (!m) return { ok: false, reason: 'missing_or_malformed' };
  const given = Buffer.from(m[1].toLowerCase(), 'hex'), want = crypto.createHmac('sha256', secret).update(raw).digest();
  return given.length === want.length && crypto.timingSafeEqual(given, want) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

function handshake(q, token) {
  if (!token) return null;
  const given = Buffer.from(String(q['hub.verify_token'] || '')), want = Buffer.from(token);
  if (q['hub.mode'] !== 'subscribe' || !q['hub.challenge'] || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return String(q['hub.challenge']).slice(0, 200);
}

function statuses(payload) {
  const out = [];
  ((payload && payload.entry) || []).forEach(function (e) {
    (e.changes || []).forEach(function (c) {
      ((c.value && c.value.statuses) || []).forEach(function (s) {
        if (!s || !s.id || !s.status) return;
        const item = { id: String(s.id).slice(0, 120), status: String(s.status), ts: s.timestamp ? Number(s.timestamp) : null };
        const err = Array.isArray(s.errors) && s.errors[0];
        if (err) item.errorTitle = String(err.title || err.message || err.code || '').slice(0, 200);   // only when Meta gives a reason
        out.push(item);
      });
    });
  });
  return out;
}

/**
 * Replies people send to our WhatsApp number that change their preferences (N3):
 * STOP / UNSUBSCRIBE → stop all WhatsApp messages; START → resume. Other text is ignored here.
 */
const STOP_WORDS = ['STOP', 'UNSUBSCRIBE', 'STOP ALL', 'OPT OUT', 'OPTOUT'];
const START_WORDS = ['START', 'UNSTOP', 'OPT IN', 'OPTIN'];
function inbound(payload) {
  const out = [];
  ((payload && payload.entry) || []).forEach(function (e) {
    (e.changes || []).forEach(function (c) {
      ((c.value && c.value.messages) || []).forEach(function (m) {
        if (!m || !m.id || !m.from) return;
        const text = m.type === 'text' && m.text ? m.text.body
          : m.type === 'button' && m.button ? m.button.text
          : m.type === 'interactive' && m.interactive && m.interactive.button_reply ? m.interactive.button_reply.title : '';
        const t = String(text || '').trim().toUpperCase().replace(/[.!]+$/, '');
        const word = STOP_WORDS.indexOf(t) !== -1 ? 'stop' : (START_WORDS.indexOf(t) !== -1 ? 'start' : null);
        if (word) out.push({ id: String(m.id).slice(0, 120), from: String(m.from).slice(0, 20), word: word });
      });
    });
  });
  return out;
}

const RANK = { unknown: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

async function processMeta(raw, header) {
  const sig = verifySignature(raw, header, config.whatsappAppSecret());
  const sha = crypto.createHash('sha256').update(Buffer.isBuffer(raw) ? raw : Buffer.from('')).digest('hex');
  if (!sig.ok) {
    await db.query("INSERT IGNORE INTO b2b_webhook_events (provider, event_id, payload_sha256, outcome) VALUES ('whatsapp_meta', ?, ?, 'bad_signature')", ['badsig:' + sha, sha]);
    await monitor.event('notification', 'warning', 'webhook_bad_signature', 'WhatsApp webhook refused (' + sig.reason + ')');
    return { status: 401, outcomes: ['bad_signature'] };
  }
  let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch (e) { return { status: 400, outcomes: ['ignored'] }; }
  const outcomes = [];
  for (const s of statuses(payload)) {
    const eventId = s.id + ':' + s.status;
    const at = s.ts ? new Date(s.ts * 1000).toISOString().slice(0, 19).replace('T', ' ') : null;
    const ins = await db.query('INSERT IGNORE INTO b2b_webhook_events (provider, event_id, payload_sha256, event_time, outcome) VALUES (?, ?, ?, ?, ?)',
      ['whatsapp_meta', eventId, sha, at, 'processed']);
    if (!ins.affectedRows) { outcomes.push('duplicate'); continue; }
    const st = RANK[s.status] == null ? null : s.status;
    if (!st) { await db.query("UPDATE b2b_webhook_events SET outcome = 'ignored' WHERE provider = 'whatsapp_meta' AND event_id = ?", [eventId]); outcomes.push('ignored'); continue; }
    // Only move forward: a late "delivered" never overwrites "read".
    const allowedFrom = Object.keys(RANK).filter(function (k) { return RANK[k] < RANK[st]; });
    const upd = await db.query('UPDATE b2b_notification_queue SET delivery_status = ? WHERE provider_message_id = ? AND delivery_status IN (' + db.placeholders(allowedFrom) + ')',
      [st, s.id].concat(allowedFrom));
    if (!upd.affectedRows) {
      await db.query("UPDATE b2b_webhook_events SET outcome = 'stale' WHERE provider = 'whatsapp_meta' AND event_id = ?", [eventId]);
      outcomes.push('stale');
    } else { outcomes.push('processed'); await recordHistory(s.id, st, 'whatsapp_meta', s.errorTitle || null); }
    if (st === 'failed') await monitor.event('notification', 'warning', 'whatsapp_failed', 'WhatsApp message ' + s.id + ' failed', { refType: 'provider_message', refId: s.id });
  }
  for (const m of inbound(payload)) {
    const ins = await db.query('INSERT IGNORE INTO b2b_webhook_events (provider, event_id, payload_sha256, outcome) VALUES (?, ?, ?, ?)', ['whatsapp_meta', 'in:' + m.id, sha, 'processed']);
    if (!ins.affectedRows) { outcomes.push('duplicate'); continue; }
    await require('../notifications/consent.js').record(null, { type: 'system', id: null, role: 'system', label: 'WhatsApp reply ' + m.word.toUpperCase() },
      { channel: 'whatsapp', address: m.from, scope: 'all', state: m.word === 'stop' ? 'opted_out' : 'opted_in', source: 'whatsapp_reply' });
    outcomes.push(m.word === 'stop' ? 'opted_out' : 'opted_in');
  }
  return { status: 200, outcomes: outcomes.length ? outcomes : ['ignored'] };
}

/** Mounted before the JSON body parser (raw body needed for the signature). */
function mount(app) {
  mountSms(app);
  app.get('/api/webhooks/whatsapp', function (req, res) {
    const ch = handshake(req.query, config.whatsappVerifyToken());
    if (ch == null) return res.status(403).send('forbidden');
    res.type('text/plain').send(ch);
  });
  app.post('/api/webhooks/whatsapp', express.raw({ type: '*/*', limit: '512kb' }), function (req, res) {
    processMeta(req.body, req.headers['x-hub-signature-256']).then(function (r) {
      res.status(r.status).json({ ok: r.status === 200 });
    }).catch(function (e) {
      console.error('[ERP WEBHOOK]', e.code || e.message);
      res.status(500).json({ ok: false });   // provider retries; the replay table makes the retry safe
    });
  });
}

// ── MSG91 SMS delivery reports ──
// MSG91 does not sign its webhooks. The URL carries a long secret token (MSG91_WEBHOOK_TOKEN,
// compared in constant time); replays are refused by (provider, requestId:status); statuses never go backwards.
const SMS_RANK = { unknown: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
function tokenOk(given) {
  const want = process.env.MSG91_WEBHOOK_TOKEN || '';
  if (want.length < 24) return false;
  const a = Buffer.from(String(given || '')), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function processMsg91(body, token) {
  if (!tokenOk(token)) return { status: 401, outcomes: ['bad_token'] };
  const msg91 = require('../../b2b/lib/sms-msg91.js');
  const sha = crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
  const outcomes = [];
  for (const r of msg91.reports(body)) {
    const ins = await db.query("INSERT IGNORE INTO b2b_webhook_events (provider, event_id, payload_sha256, outcome) VALUES ('msg91', ?, ?, 'processed')", [r.id + ':' + r.status, sha]);
    if (!ins.affectedRows) { outcomes.push('duplicate'); continue; }
    const lower = Object.keys(SMS_RANK).filter(function (k) { return SMS_RANK[k] < SMS_RANK[r.status]; });
    const upd = await db.query('UPDATE b2b_notification_queue SET delivery_status = ? WHERE provider_message_id = ? AND delivery_status IN (' + db.placeholders(lower) + ')', [r.status, r.id].concat(lower));
    if (!upd.affectedRows) { await db.query("UPDATE b2b_webhook_events SET outcome = 'stale' WHERE provider = 'msg91' AND event_id = ?", [r.id + ':' + r.status]); outcomes.push('stale'); continue; }
    await recordHistory(r.id, r.status, 'msg91', 'report: ' + r.raw);
    // a code that could not be delivered is visible to the salesman screen and monitoring
    const q = await db.queryOne("SELECT ref_type, ref_id FROM b2b_notification_queue WHERE provider_message_id = ? LIMIT 1", [r.id]);
    if (q && q.ref_type === 'otp' && (r.status === 'delivered' || r.status === 'failed')) {
      await db.query("UPDATE b2b_otp_challenges SET delivery_status = ? WHERE id = ?", [r.status, q.ref_id]);
      if (r.status === 'failed') await monitor.event('otp', 'warning', 'otp_sms_failed', 'Order code SMS failed (' + r.raw + ')', { refType: 'otp', refId: q.ref_id });
    }
    outcomes.push('processed');
  }
  return { status: 200, outcomes: outcomes.length ? outcomes : ['ignored'] };
}
function mountSms(app) {
  app.post('/api/webhooks/msg91', express.json({ limit: '256kb', type: '*/*' }), function (req, res) {
    processMsg91(req.body, req.query.token).then(function (r) { res.status(r.status).json({ ok: r.status === 200 }); })
      .catch(function (e) { console.error('[ERP WEBHOOK msg91]', e.code || e.message); res.status(500).json({ ok: false }); });
  });
}

module.exports = { mount, mountSms, processMeta, processMsg91, verifySignature, handshake, statuses, inbound };
