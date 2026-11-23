/**
 * Notifications = in-app messages + an outbox queue for email / WhatsApp / SMS.
 *
 * The queue row is written inside the SAME database transaction as the
 * business change, and a background worker delivers it afterwards with
 * retries and back-off. If email or WhatsApp is down, the order is still
 * saved and the message is retried — nothing is lost and nothing blocks.
 *
 * The worker is a plain in-process timer: no Redis, no RabbitMQ, nothing
 * extra to run on Hostinger.
 */
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const settings = require('../lib/settings.js');
const jobsConfig = require('../../../platform/jobs-config.js');

const BACKOFF_MINUTES = [1, 5, 30, 120];
let timer = null;
let running = false;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function emailHtml(title, lines, link) {
  const brand = process.env.BRAND_NAME || 'Sake of Health';
  return '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#16261a">' +
    '<div style="background:#2f5d1f;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0;font-size:17px;font-weight:700">' + esc(brand) + ' — Business</div>' +
    '<div style="border:1px solid #e4e8e0;border-top:0;padding:22px;border-radius:0 0 10px 10px">' +
    '<h2 style="margin:0 0 12px;font-size:18px">' + esc(title) + '</h2>' +
    lines.map(function (l) { return '<p style="margin:0 0 10px;line-height:1.55;font-size:14px">' + esc(l) + '</p>'; }).join('') +
    (link ? '<p style="margin:18px 0 0"><a href="' + esc(link) + '" style="background:#2f5d1f;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px">Open business portal</a></p>' : '') +
    '</div></div>';
}

/** Add one message to the outbox. `q` is a transaction wrapper or null. Returns the queue id. */
async function enqueue(q, msg) {
  if (!msg.recipient) return null;
  const run = q ? q.query.bind(q) : db.query;
  const cols = ['channel', 'recipient', 'subject', 'body', 'ref_type', 'ref_id'];
  const vals = [msg.channel, String(msg.recipient).slice(0, 190), msg.subject ? String(msg.subject).slice(0, 200) : null,
    String(msg.body), msg.refType || null, msg.refId || null];
  if (msg.templateName) { cols.push('template_name', 'template_params_json'); vals.push(String(msg.templateName).slice(0, 80), msg.templateParams == null ? null : JSON.stringify(msg.templateParams)); }
  if (msg.messageId) { cols.push('message_id', 'send_id', 'message_recipient_id'); vals.push(msg.messageId, msg.sendId || null, msg.messageRecipientId || null); }
  const r = await run('INSERT INTO b2b_notification_queue (' + cols.join(', ') + ') VALUES (' + cols.map(function () { return '?'; }).join(', ') + ')', vals);
  await history(run, r.insertId, 'queued', { source: msg.source || 'system', actor: msg.actor });
  // JOBS_MODE=cron has no sender timer: hand the message over as soon as it is committed (an order code
  // must not wait for the next cron run). The cron run remains the safety net if this attempt fails.
  if (jobsConfig.mode() === 'cron') {
    if (q && typeof q.afterCommit === 'function') q.afterCommit(kickSoon);
    else if (!q) kickSoon();
  }
  return r.insertId;
}

let kickPending = false, kickOff = false;
/** Send what is due, once, shortly (debounced). Errors are logged; the row stays queued for the next run. */
function kickSoon() {
  if (kickOff || kickPending || !db.isConfigured()) return;
  kickPending = true;
  setImmediate(function () {
    kickPending = false;
    processDue(50).catch(function (e) { if (e.code !== 'ER_NO_SUCH_TABLE') console.error('[B2B NOTIFY] immediate send:', e.code || e.message); });
  });
}
/** The cron runner sends in its own step and then closes the pool: no immediate sends in that process. */
function disableImmediateSend() { kickOff = true; }

/**
 * Append-only status history (table from migration 016). Every status change of a queued
 * message adds one row; rows are never updated or deleted. Before 016 is applied the
 * table does not exist and the history is simply not kept (the queue still works).
 */
async function history(run, queueId, status, f) {
  if (!queueId) return;
  f = f || {};
  try {
    await (run || db.query)('INSERT INTO b2b_notification_events (queue_id, status, detail, provider, provider_ref, source, actor_label) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [queueId, status, f.detail ? String(f.detail).slice(0, 300) : null, f.provider || null, f.providerRef ? String(f.providerRef).slice(0, 120) : null,
        f.source || 'worker', f.actor ? String(f.actor).slice(0, 190) : null]);
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
}

/**
 * Notify a business account: in-app message + email + WhatsApp (queued).
 * opts: { title, lines: [..], link: '/b2b/orders/12', refType, refId, channels: ['email','whatsapp'] }
 */
// ── N5: every automatic message is also a message in the notification center ──
// One record per business event (b2b_messages, origin 'workflow'), its recipients and send #1,
// so it appears in the history with every attempt and can be resent one by one. Nothing is
// triggered twice: the record is written by the same call that queues the rows. Before
// migrations 016 / 018 the record is skipped and the rows are queued exactly as before.
let wfProbe = null;
async function workflowSupport() {
  if (wfProbe && wfProbe.until > Date.now()) return wfProbe.value;
  let value = { accounts: false, addresses: false };
  try {
    const r = await db.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_message_recipients' AND COLUMN_NAME = 'recipient_type'");
    if (r.length) value = { accounts: true, addresses: /'address'/.test(String(r[0].t)) };
  } catch (e) { /* no database details: keep the old behaviour */ }
  wfProbe = { value: value, until: Date.now() + (value.addresses ? 3600000 : 60000) };
  return value;
}
/**
 * w = { event, title, text, html, channels, refType, refId, recipients: [{ type, ref, name, email, mobile }] }
 * Returns { messageId, sendId, rows: [recipient row id per recipient] } or null (not recorded).
 */
async function recordWorkflow(q, w) {
  const sup = await workflowSupport();
  if (!sup.accounts || (!sup.addresses && w.recipients.some(function (r) { return r.type === 'address'; }))) return null;
  if (!q) return db.transaction(function (t) { return recordWorkflow(t, w); });
  const no = await require('../../erp/lib/seq.js').next(q, 'MSG');
  const m = await q.query("INSERT INTO b2b_messages (message_no, origin, category, subject, body_text, email_html, channels, audience_json, ref_type, ref_id, status, created_by_type, created_by_label, last_sent_at) " +
    "VALUES (?, 'workflow', 'transactional', ?, ?, ?, ?, ?, ?, ?, 'sent', 'system', ?, UTC_TIMESTAMP())",
    [no, String(w.title).slice(0, 200), String(w.text).slice(0, 10000), w.html || null, w.channels.join(','), JSON.stringify({ event: w.event || null }),
      w.refType ? String(w.refType).slice(0, 40) : null, w.refId == null ? null : String(w.refId).slice(0, 40), ('automatic: ' + (w.event || w.refType || 'notification')).slice(0, 190)]);
  const messageId = Number(m.insertId), rows = [];
  for (const r of w.recipients) {
    const rr = await q.query('INSERT INTO b2b_message_recipients (message_id, recipient_type, recipient_ref, display_name, email, mobile) VALUES (?, ?, ?, ?, ?, ?)',
      [messageId, r.type, r.ref, String(r.name || '').slice(0, 190) || '(no name)', r.email || null, r.mobile || null]);
    rows.push(Number(rr.insertId));
  }
  const sd = await q.query("INSERT INTO b2b_message_sends (message_id, send_no, request_key, initiated_by_type, initiated_by_label, edited, channels, recipient_count, queued_count) VALUES (?, 1, ?, 'system', ?, 0, ?, ?, ?)",
    [messageId, crypto.randomUUID(), ('automatic: ' + (w.event || w.refType || 'notification')).slice(0, 190), w.channels.join(','), w.recipients.length, w.queued || 0]);
  return { messageId: messageId, sendId: Number(sd.insertId), rows: rows };
}
function link(rec, i) { return rec ? { messageId: rec.messageId, sendId: rec.sendId, messageRecipientId: rec.rows[i] } : {}; }

async function notifyAccount(q, accountId, opts) {
  const run = q ? q.query.bind(q) : db.query;
  const rows = await run('SELECT email, mobile, account_type, business_name, shop_name FROM b2b_accounts WHERE id = ?', [accountId]);
  if (!rows.length) return;
  const lines = opts.lines || [];
  await run('INSERT INTO b2b_notifications (account_id, title, body, link) VALUES (?, ?, ?, ?)',
    [accountId, String(opts.title).slice(0, 160), lines.join(' ').slice(0, 500) || null, opts.link || null]);
  const site = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  const absolute = opts.link && site ? site + opts.link : '';
  const channels = (opts.channels || ['email', 'whatsapp']).filter(function (c) { return c === 'email' || c === 'whatsapp'; });
  const html = emailHtml(opts.title, lines, absolute);
  const text = opts.title + '\n\n' + lines.join('\n') + (absolute ? '\n\n' + absolute : '');
  const a = rows[0];
  const willQueue = (channels.indexOf('email') !== -1 && a.email ? 1 : 0) + (channels.indexOf('whatsapp') !== -1 && a.mobile ? 1 : 0);
  const rec = willQueue ? await recordWorkflow(q, { event: opts.event, title: opts.title, text: text, html: html, channels: channels, refType: opts.refType, refId: opts.refId, queued: willQueue,
    recipients: [{ type: a.account_type, ref: Number(accountId), name: a.business_name || a.shop_name, email: a.email, mobile: a.mobile }] }) : null;
  if (channels.indexOf('email') !== -1) {
    await enqueue(q, Object.assign({ channel: 'email', recipient: a.email, subject: opts.title, body: html, refType: opts.refType, refId: opts.refId }, link(rec, 0)));
  }
  if (channels.indexOf('whatsapp') !== -1) {
    await enqueue(q, Object.assign({ channel: 'whatsapp', recipient: a.mobile, body: text, refType: opts.refType, refId: opts.refId }, link(rec, 0)));
  }
}

async function adminRecipients() {
  const list = [];
  const extra = String((await settings.get('notify.admin_emails')) || '');
  extra.split(/[,;\s]+/).forEach(function (e) { if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) list.push(e.toLowerCase()); });
  [process.env.OWNER_EMAIL, process.env.ADMIN_EMAIL].forEach(function (e) {
    e = String(e || '').trim().toLowerCase();
    if (e && list.indexOf(e) === -1) list.push(e);
  });
  return list.slice(0, 20);
}

/** Email the back-office team (queued). */
async function notifyAdmins(q, opts) {
  const recipients = await adminRecipients();
  if (!recipients.length) return;
  const site = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  const absolute = opts.link && site ? site + opts.link : '';
  const html = emailHtml(opts.title, opts.lines || [], absolute);
  const rec = await recordWorkflow(q, { event: opts.event, title: opts.title, text: opts.title + '\n\n' + (opts.lines || []).join('\n') + (absolute ? '\n\n' + absolute : ''), html: html,
    channels: ['email'], refType: opts.refType, refId: opts.refId, queued: recipients.length,
    recipients: recipients.map(function (to, i) { return { type: 'address', ref: i + 1, name: 'Admin alerts: ' + to, email: to }; }) });
  for (let i = 0; i < recipients.length; i++) {
    await enqueue(q, Object.assign({ channel: 'email', recipient: recipients[i], subject: opts.title, body: html, refType: opts.refType, refId: opts.refId }, link(rec, i)));
  }
}

/** Field-sales one-time codes (N5): one record per code so it shows in the history; the code itself is never stored there and never resent. */
async function queueCode(q, o) {
  const rec = await recordWorkflow(q, { event: 'sales.order_code', title: 'Order confirmation code for ' + o.orderNo, text: '[one-time code for order ' + o.orderNo + ' — not stored, never resent]',
    html: null, channels: [o.channel], refType: 'otp', refId: o.challengeId, queued: 1, recipients: [{ type: 'address', ref: 1, name: 'Retailer mobile', mobile: o.mobile }] });
  return enqueue(q, Object.assign({ channel: o.channel, recipient: o.mobile, subject: null, body: o.body, refType: 'otp', refId: o.challengeId, templateName: o.templateName, templateParams: o.templateParams }, link(rec, 0)));
}

function params(row) {
  if (!row.template_params_json) return null;
  try { return JSON.parse(row.template_params_json); } catch (e) { return null; }
}

/** Meta template name for a logical template: WHATSAPP_TEMPLATE_<NAME> if set, else the name itself. */
function whatsappTemplate(name) {
  return process.env['WHATSAPP_TEMPLATE_' + String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')] || name;
}

/**
 * Hand one queue row to its provider. The answer says what really happened:
 *   { ok: true, provider, providerMessageId? }   a provider accepted it
 *   { ok: false, noProvider: true, reason }      nothing was sent: no provider configured
 *   { ok: false, noContact: true, reason }       nothing was sent: no usable address
 *   { ok: false, permanent: true, reason }       refused for good: retrying will not help
 *   { ok: false, reason }                        failed now; retried with back-off
 * The shop's sender logs messages and answers "ok" with `mock: true` when no provider is
 * configured; that is treated as NOT sent.
 */
async function deliver(row) {
  const notify = require('../../../services/notify.js');
  if (row.channel === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row.recipient || ''))) return { ok: false, noContact: true, reason: 'no valid email address' };
    const r = await notify.sendEmail(row.recipient, row.subject || 'Notification', row.body);
    if (r && r.mock) return { ok: false, noProvider: true, reason: 'No email provider (SMTP) is configured — the message was not sent' };
    if (r && r.ok) return { ok: true, provider: 'smtp', providerMessageId: r.id ? String(r.id).slice(0, 120) : null };
    return { ok: false, reason: (r && r.reason) || 'email failed' };
  }
  if (row.channel === 'whatsapp') {
    if (String(row.recipient || '').replace(/\D/g, '').length < 10) return { ok: false, noContact: true, reason: 'no valid mobile number' };
    const opts = {};
    if (row.template_name) {
      const p = params(row);
      opts.templateName = whatsappTemplate(row.template_name);
      opts.templateParams = Array.isArray(p) ? p : (p && typeof p === 'object' ? Object.keys(p).map(function (k) { return p[k]; }) : []);
    }
    const r = await notify.sendWhatsApp(row.recipient, row.body, opts);
    if (r && r.mock) return { ok: false, noProvider: true, reason: 'No WhatsApp provider is configured — the message was not sent' };
    // The shop sender does not return Meta's message id (owner decision D2), so WhatsApp
    // stays "accepted by provider" until delivery tracking is separately approved.
    if (r && r.ok) return { ok: true, provider: r.provider || 'whatsapp' };
    const reason = (r && r.reason) || 'WhatsApp failed';
    // Meta answers these for good: wrong token, template missing/unapproved, number not allowed.
    const permanent = /template problem|not in your allowed list|access token is invalid|rejected the request parameters/i.test(reason);
    return { ok: false, permanent: permanent, reason: reason };
  }
  if (row.channel === 'sms') {
    // SMS only through MSG91 with a DLT template. Without a gateway the row is marked
    // 'skipped_no_provider' — it is never reported as sent.
    if (!row.template_name) return { ok: false, noProvider: true, reason: 'SMS needs a DLT template (template_name)' };
    const r = await require('../lib/sms-msg91.js').sendTemplate(row.recipient, row.template_name, params(row) || {});
    if (r && r.ok) return { ok: true, provider: 'msg91', providerMessageId: r.providerMessageId || null };
    if (r && !r.noProvider && /invalid Indian mobile/.test(r.reason || '')) return { ok: false, noContact: true, reason: r.reason };
    return r;
  }
  return { ok: false, permanent: true, reason: 'unknown channel ' + row.channel };
}

const OTP = /_otp$/;
async function eraseCode(row, note) {
  if (row.template_name && OTP.test(row.template_name)) {
    await db.query('UPDATE b2b_notification_queue SET template_params_json = NULL, body = ? WHERE id = ?', [note, row.id]);
  }
}

/**
 * Move a claimed row to its outcome. Only a row still in "sending" moves (status never goes
 * backwards), and history is written only when the row really changed.
 */
async function settle(row, result) {
  const reason = String((result && result.reason) || 'delivery failed').slice(0, 300);
  if (result && result.ok) {
    const upd = await db.query("UPDATE b2b_notification_queue SET status = 'sent', sent_at = UTC_TIMESTAMP(), last_error = NULL, provider_message_id = COALESCE(?, provider_message_id) WHERE id = ? AND status = 'sending'",
      [result.providerMessageId || null, row.id]);
    if (!upd.affectedRows) return 'unchanged';
    await history(null, row.id, 'accepted', { provider: result.provider, providerRef: result.providerMessageId });
    // one-time codes are removed from the queue as soon as the gateway has them
    await eraseCode(row, '[code removed after sending]');
    return 'sent';
  }
  if (result && (result.noProvider || result.noContact || result.optOut)) {
    const status = result.noProvider ? 'skipped_no_provider' : (result.optOut ? 'skipped_opt_out' : 'skipped_no_contact');
    let upd;
    try {
      upd = await db.query('UPDATE b2b_notification_queue SET status = ?, last_error = ? WHERE id = ? AND status = \'sending\'', [status, reason, row.id]);
    } catch (e) {   // before migrations 004 / 016 the status list is shorter
      if (e.errno !== 1265 && e.errno !== 1366 && e.code !== 'WARN_DATA_TRUNCATED') throw e;
      upd = await db.query("UPDATE b2b_notification_queue SET status = 'failed', last_error = ? WHERE id = ? AND status = 'sending'", [reason, row.id]);
    }
    if (!upd.affectedRows) return 'unchanged';
    await history(null, row.id, status, { detail: reason });
    await eraseCode(row, '[code removed: not sent]');
    return 'skipped';
  }
  if ((result && result.permanent) || row.attempts >= row.max_attempts) {
    const upd = await db.query("UPDATE b2b_notification_queue SET status = 'failed', last_error = ? WHERE id = ? AND status = 'sending'", [reason, row.id]);
    if (!upd.affectedRows) return 'unchanged';
    await history(null, row.id, 'failed', { detail: reason });
    await eraseCode(row, '[code removed: not sent]');
    return 'failed';
  }
  const mins = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)];
  const upd = await db.query("UPDATE b2b_notification_queue SET status = 'pending', last_error = ?, next_attempt_at = (UTC_TIMESTAMP() + INTERVAL " + db.int(mins, 5, 1, 1440) + " MINUTE) WHERE id = ? AND status = 'sending'",
    [reason, row.id]);
  if (!upd.affectedRows) return 'unchanged';
  await history(null, row.id, 'retry_scheduled', { detail: reason + ' — next try in ' + mins + ' min' });
  return 'retry';
}

/** Process messages that are due. Safe to run from several processes at once. */
function consent() { return require('../../erp/notifications/consent.js'); }   // lazy: the ERP notification center owns consent

const PROVIDER_RATES = { email: 30, whatsapp: 60, sms: 60 };
/** Messages per minute per channel: the setting erp.notifications.provider_rates, else the defaults above. */
async function providerRates() {
  const out = Object.assign({}, PROVIDER_RATES);
  try {
    const v = await require('../../erp/core/settings.js').get('notifications.provider_rates');
    if (v && typeof v === 'object') Object.keys(out).forEach(function (k) { if (Number.isInteger(v[k]) && v[k] >= 1 && v[k] <= 6000) out[k] = v[k]; });
  } catch (e) { /* settings unavailable: defaults */ }
  return out;
}
/** How many rows of each channel this run may claim: the per-minute rate minus what was handed over in the last minute, capped by the batch size. */
async function allowance(batch) {
  const rates = await providerRates();
  const used = { email: 0, whatsapp: 0, sms: 0 };
  try {
    const rows = await db.query("SELECT q.channel, COUNT(*) AS n FROM b2b_notification_events e JOIN b2b_notification_queue q ON q.id = e.queue_id " +
      "WHERE e.status = 'sending' AND e.created_at >= (UTC_TIMESTAMP(3) - INTERVAL 60 SECOND) GROUP BY q.channel");
    rows.forEach(function (r) { if (used[r.channel] != null) used[r.channel] = Number(r.n); });
  } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }   // before migration 016 there is no history to count
  const out = {};
  Object.keys(rates).forEach(function (ch) { out[ch] = Math.max(0, Math.min(batch, rates[ch] - used[ch])); });
  return out;
}

async function processDue(limit) {
  if (running) return { processed: 0, skipped: true };
  running = true;
  let processed = 0, sent = 0, failed = 0;
  try {
    // Recover rows a crashed worker left in "sending".
    const stale = await db.query("SELECT id FROM b2b_notification_queue WHERE status = 'sending' AND next_attempt_at < (UTC_TIMESTAMP() - INTERVAL 10 MINUTE)");
    for (const r of stale) {
      const u = await db.query("UPDATE b2b_notification_queue SET status = 'pending' WHERE id = ? AND status = 'sending'", [r.id]);
      if (u.affectedRows) await history(null, r.id, 'requeued', { detail: 'worker stopped while sending; tried again', source: 'system' });
    }
    // Claim a batch atomically with a unique marker (works on every MySQL/MariaDB version).
    const claim = 'claim:' + crypto.randomBytes(8).toString('hex');
    const n = db.int(limit, 15, 1, 100);
    // Provider throughput (N3): at most the configured number per channel per minute is handed
    // over; the rest stay pending without using up an attempt.
    const allow = await allowance(n);
    let claimed = 0;
    for (const ch of Object.keys(allow)) {
      const take = Math.min(allow[ch], n - claimed);
      if (take <= 0) continue;
      const res = await db.query(
        "UPDATE b2b_notification_queue SET status = 'sending', attempts = attempts + 1, last_error = ?, next_attempt_at = UTC_TIMESTAMP() " +
        "WHERE status = 'pending' AND channel = ? AND next_attempt_at <= UTC_TIMESTAMP() ORDER BY id LIMIT " + db.int(take, 1, 1, 100), [claim, ch]);
      claimed += res.affectedRows;
    }
    if (!claimed) return { processed: 0, sent: 0, failed: 0 };
    const rows = await db.query("SELECT * FROM b2b_notification_queue WHERE status = 'sending' AND last_error = ?", [claim]);
    for (const row of rows) {
      processed++;
      await history(null, row.id, 'sending', { detail: 'attempt ' + row.attempts + ' of ' + row.max_attempts });
      let result;
      try {
        // consent and opt-out (N3), checked at the last moment for every row; a lookup error retries later (fail closed)
        const block = await consent().blockReason(row);
        result = block ? { ok: false, optOut: true, reason: 'Not sent: ' + block } : await deliver(row);
      } catch (e) { result = { ok: false, reason: e.message }; }
      const out = await settle(row, result);
      if (out === 'sent') sent++; else if (out === 'skipped' || out === 'failed') failed++;
    }
    return { processed: processed, sent: sent, failed: failed };
  } finally {
    running = false;
  }
}

/**
 * Put messages that were NOT sent back in the queue (admin action). One-time codes are never
 * re-sent: they expire, and the salesman asks for a new one. Sent messages are not touched:
 * sending again is a new send (notification center), never a reset of this row.
 */
const RETRYABLE = ['failed', 'skipped_no_provider', 'skipped_no_contact'];
async function requeue(ids, actorLabel) {
  const rows = ids === 'all-failed'
    ? await db.query("SELECT id, status, template_name FROM b2b_notification_queue WHERE status = 'failed'")
    : await db.query('SELECT id, status, template_name FROM b2b_notification_queue WHERE id IN (' + db.placeholders(ids) + ')', ids);
  const done = [], refused = [];
  for (const r of rows) {
    if (r.template_name && OTP.test(r.template_name)) { refused.push({ id: Number(r.id), reason: 'one-time codes are never re-sent; ask for a new code' }); continue; }
    if (RETRYABLE.indexOf(r.status) === -1) { refused.push({ id: Number(r.id), reason: 'status is ' + r.status }); continue; }
    const u = await db.query("UPDATE b2b_notification_queue SET status = 'pending', attempts = 0, next_attempt_at = UTC_TIMESTAMP() WHERE id = ? AND status = ?", [r.id, r.status]);
    if (u.affectedRows) { done.push(Number(r.id)); await history(null, r.id, 'requeued', { detail: 'retry requested by an administrator', source: 'admin', actor: actorLabel }); }
  }
  return { requeued: done, refused: refused };
}

/** Status history of one queue row, oldest first ([] before migration 016). */
async function historyOf(queueId) {
  try {
    return await db.query('SELECT status, detail, provider, provider_ref, source, actor_label, created_at FROM b2b_notification_events WHERE queue_id = ? ORDER BY id', [queueId]);
  } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return []; throw e; }
}

function startWorker() {
  if (timer) return;
  const every = Math.max(5, Number(process.env.B2B_NOTIFY_INTERVAL_SECONDS || 30)) * 1000;
  timer = setInterval(function () {
    processDue().catch(function (e) { if (e.code !== 'ER_NO_SUCH_TABLE') console.error('[B2B NOTIFY] worker:', e.code || e.message); });
  }, every);
  if (timer.unref) timer.unref();
}

function stopWorker() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { enqueue, kickSoon, disableImmediateSend, notifyAccount, notifyAdmins, processDue, startWorker, stopWorker, emailHtml, deliver, settle, requeue, history, historyOf, RETRYABLE, allowance, providerRates, PROVIDER_RATES, recordWorkflow, queueCode, workflowSupport };
