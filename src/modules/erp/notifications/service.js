/**
 * Notification center (N2): compose, send, resend, history, detail, analytics.
 *
 * One pipeline: a message is written once (b2b_messages + b2b_message_recipients), every press
 * of Send / Resend is one insert-only b2b_message_sends row, and each send queues one row per
 * recipient × channel in the EXISTING outbox (b2b_notification_queue), delivered by the existing
 * worker with its retries and its append-only status history. Nothing here writes orders,
 * payments, invoices or stock (a test scans this file).
 *
 * Resend rules (owner instructions): always available, even after delivery; each confirmed
 * resend is a new send with new queue rows; the original message is never changed (an edited
 * copy is stored on that send only); only original recipients, or some of them; a recipient
 * whose contact changed needs confirmation first (D3); a repeated request key returns the
 * same send (double-click / network retry).
 */
'use strict';
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const seq = require('../lib/seq.js');
const settings = require('../core/settings.js');
const outbox = require('../../b2b/notifications/service.js');
const directory = require('./directory.js');
const templates = require('./templates.js');
const consent = require('./consent.js');
const groups = require('./groups.js');
const approvals = require('../core/approvals.js');
const { fail, posId } = require('../lib/http.js');

const CHANNELS = ['email', 'whatsapp', 'sms'];
const CATEGORIES = ['transactional', 'service', 'promotional'];
// Owner decision D5 (16 Nov 2026); replaced by the recorded decision notifications.limits when set.
const D5 = { max_recipients: 500, max_sends_per_hour: 20, promo_approval_over: 100 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function need(c, m, code) { if (!c) throw fail(400, m, code); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

async function limits() {
  const v = await settings.get('notifications.limits').catch(function () { return undefined; });
  const out = Object.assign({}, D5);
  if (v && typeof v === 'object') {
    if (Number.isInteger(v.max_recipients) && v.max_recipients >= 1 && v.max_recipients <= 5000) out.max_recipients = v.max_recipients;
    if (Number.isInteger(v.max_sends_per_hour) && v.max_sends_per_hour >= 1 && v.max_sends_per_hour <= 500) out.max_sends_per_hour = v.max_sends_per_hour;
    if (Number.isInteger(v.promo_approval_over) && v.promo_approval_over >= 0 && v.promo_approval_over <= 5000) out.promo_approval_over = v.promo_approval_over;
  }
  return out;
}

/** May this person send to this recipient type? */
function canSendTo(principal, type) { return principal.permissions.has('notifications.send.' + directory.AUDIENCE[type]); }
function canSee(principal) { return principal.permissions.has('notifications.contacts.view'); }

/** Approved provider template of a channel, by id (WhatsApp / SMS). */
async function template(q, channel, id, category) {
  const t = await q.queryOne('SELECT * FROM b2b_message_templates WHERE id = ? AND channel = ?', [posId(id), channel]);
  need(t, 'Choose an approved ' + channel + ' template', 'template_required');
  need(Number(t.active) === 1 && Number(t.approved_at_provider) === 1, 'Template ' + t.name + ' is not active and approved at the provider', 'template_not_approved');
  // Meta prices and polices marketing and utility templates differently: the template must match the message.
  if (category) need((t.category === 'promotional') === (category === 'promotional'),
    category === 'promotional' ? 'A promotional message needs a template approved as promotional (Meta: marketing)' : 'A promotional template cannot carry a ' + category + ' message', 'template_category');
  return t;
}

// ── Promotional messages (D4): business accounts that consented, by email or WhatsApp, approved above the threshold ──
const PROMO_TYPES = ['retailer', 'distributor'];
function siteUrl() { return (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, ''); }
/** The rules a promotional send must meet before anything is written. Pure apart from the environment. */
function promoRules(principal, category, types, channels) {
  if (category !== 'promotional') return;
  if (!principal.permissions.has('notifications.send.promotional')) throw fail(403, 'You may not send promotional messages', 'promotional_forbidden');
  need(types.every(function (t) { return PROMO_TYPES.indexOf(t) !== -1; }), 'Promotional messages go only to retailers and distributors (who must also have agreed to receive them)', 'promotional_business_only');
  need(channels.indexOf('sms') === -1, 'SMS is kept for one-time codes and service messages (D8). Send promotions by email or WhatsApp.', 'promotional_no_sms');
  if (channels.indexOf('email') !== -1) need(/^https?:\/\//.test(siteUrl()) && consent.unsubscribeToken('email', 'check@example.com'),
    'Promotional email needs an unsubscribe link: set PUBLIC_SITE_URL (and the ERP secret) first', 'unsubscribe_unavailable');
}
function needsApproval(category, count, lim) { return category === 'promotional' && count > lim.promo_approval_over; }
function unsubscribeFooter(address) {
  const t = consent.unsubscribeToken('email', address);
  if (!t) return '';
  const url = siteUrl() + '/api/erp/public/unsubscribe?t=' + encodeURIComponent(t);
  return '<p style="font-family:Arial,sans-serif;max-width:560px;margin:12px auto 0;font-size:12px;color:#5b6b5e;line-height:1.5">You receive offers from us because you agreed to. ' +
    '<a href="' + esc(url) + '" style="color:#2f5d1f">Stop receiving offers by email</a>. Order and account messages are not affected.</p>';
}

function emailHtml(subject, body) {
  // Plain text the admin wrote, shown safely inside the existing business email layout.
  return outbox.emailHtml(subject, String(body).split(/\n{2,}/).map(function (p) { return p.replace(/\n/g, ' '); }), '');
}

async function rateCheck(tx, actor, lim) {
  const r = await tx.queryOne("SELECT COUNT(*) AS n FROM b2b_message_sends WHERE initiated_by_type = 'staff' AND initiated_by_id = ? AND created_at > (UTC_TIMESTAMP() - INTERVAL 1 HOUR)", [actor.id]);
  if (Number(r.n) >= lim.max_sends_per_hour) throw fail(429, 'You have sent ' + r.n + ' messages in the last hour (limit ' + lim.max_sends_per_hour + '). Try again later.', 'send_limit');
}

/**
 * Queue one send: one outbox row per recipient × channel. Recipients without the address a
 * channel needs still get a row, which the worker marks "Not sent: no contact" (visible).
 */
async function queueSend(tx, actor, msg, sendId, recipients, content) {
  let queued = 0;
  const params = content.params || null;
  for (const r of recipients) {
    for (const ch of content.channels) {
      const row = { channel: ch, subject: null, body: '', messageId: msg.id, sendId: sendId, messageRecipientId: r.recipientRowId, source: 'admin', actor: actor.label,
        refType: 'message', refId: msg.id };
      if (ch === 'email') { row.recipient = r.email || 'no-address'; row.subject = content.subject; row.body = (content.html || emailHtml(content.subject, content.body)) + (msg.category === 'promotional' && r.email ? unsubscribeFooter(r.email) : ''); }
      if (ch === 'whatsapp' && !content.whatsapp) { row.recipient = r.mobile || '0'; row.body = content.body; }   // an automatic message resent as it first went out
      if (ch === 'whatsapp' && content.whatsapp) { row.recipient = r.mobile || '0'; row.body = content.body || content.whatsapp.sample_text || content.whatsapp.name; row.templateName = templates.outboxName(content.whatsapp); row.templateParams = params && params.whatsapp ? params.whatsapp : []; }
      if (ch === 'sms') { row.recipient = r.mobile || '0'; row.body = '[SMS template ' + content.sms.name + ']'; row.templateName = templates.outboxName(content.sms); row.templateParams = params && params.sms ? params.sms : {}; }
      await outbox.enqueue(tx, row);
      queued++;
    }
  }
  return queued;
}

function readContent(b, base) {
  const channels = Array.isArray(b.channels) ? Array.from(new Set(b.channels.map(String))) : (base ? base.channels : []);
  need(channels.length && channels.every(function (c) { return CHANNELS.indexOf(c) !== -1; }), 'Choose at least one channel: email, whatsapp or sms');
  const subject = String(b.subject != null ? b.subject : (base ? base.subject : '') || '').trim();
  const body = String(b.body != null ? b.body : (base ? base.body : '') || '').trim();
  if (channels.indexOf('email') !== -1) { need(subject.length >= 3 && subject.length <= 200, 'An email needs a subject (3–200 characters)'); need(body.length >= 5 && body.length <= 10000, 'An email needs a message (5–10,000 characters)'); }
  return { channels: channels, subject: subject.slice(0, 200), body: body.slice(0, 10000) };
}

/**
 * The result of an earlier press with the same requestKey (double click, network retry, or two
 * presses racing each other). Reports THAT send, not the latest one. A key used for another
 * message is refused rather than silently answered with the wrong message.
 */
async function replay(requestKey, messageId) {
  const prior = await db.queryOne('SELECT message_id, send_no FROM b2b_message_sends WHERE request_key = ?', [requestKey]);
  if (!prior) return null;
  if (messageId != null && Number(prior.message_id) !== Number(messageId)) throw fail(409, 'This request key was already used for another message', 'request_key_reused');
  return Object.assign(await summary(Number(prior.message_id), Number(prior.send_no)), { duplicate: true });
}
function dupKey(e) { return !!e && e.code === 'ER_DUP_ENTRY' && /uq_b2b_ms_key|request_key/.test(String(e.sqlMessage || e.message || '')); }

/** Compose and send a new message. */
async function send(actor, principal, b) {
  const requestKey = String(b.requestKey || '');
  need(UUID.test(requestKey), 'requestKey (a new UUID per press of Send) is required', 'request_key');
  const first = await replay(requestKey, null);
  if (first) return first;
  const category = CATEGORIES.indexOf(b.category) !== -1 ? b.category : 'transactional';
  const content = readContent(b);
  const lim = await limits();
  const picked = (Array.isArray(b.recipients) ? b.recipients : []).concat(Array.isArray(b.groups) && b.groups.length ? await groups.expand(principal, b.groups, lim.max_recipients) : []);
  const once = {};
  const list = picked.filter(function (x) { const k = x && x.type + ':' + Number(x.ref); if (!x || once[k]) return false; once[k] = true; return true; });
  need(list.length, 'Choose at least one recipient');
  need(list.length <= lim.max_recipients, 'At most ' + lim.max_recipients + ' recipients per send (you chose ' + list.length + ')', 'too_many_recipients');
  promoRules(principal, category, Array.from(new Set(list.map(function (x) { return x.type; }))), content.channels);
  list.forEach(function (x) { if (!canSendTo(principal, x.type)) throw fail(403, 'You may not send messages to ' + x.type + 's', 'audience_forbidden'); });
  const people = await directory.resolve(list);
  const seen = {};
  const recipients = people.filter(function (p) { const k = p.type + ':' + p.ref; if (seen[k]) return false; seen[k] = true; return p.active; });
  need(recipients.length, 'None of the chosen recipients is active', 'no_active_recipients');
  let res;
  try { res = await db.transaction(async function (tx) {
    await rateCheck(tx, actor, lim);
    if (content.channels.indexOf('whatsapp') !== -1) content.whatsapp = await template(tx, 'whatsapp', b.whatsappTemplateId, category);
    if (content.channels.indexOf('sms') !== -1) content.sms = await template(tx, 'sms', b.smsTemplateId, category);
    content.params = b.params && typeof b.params === 'object' ? b.params : null;
    const hold = needsApproval(category, recipients.length, lim);
    if (hold) need(String(b.reason || '').trim().length >= 5, 'Say why this promotion should go out (at least 5 characters): an approver reads it', 'reason_required');
    const no = await seq.next(tx, 'MSG');
    const m = await tx.query('INSERT INTO b2b_messages (message_no, origin, category, subject, body_text, email_html, whatsapp_template_id, sms_template_id, template_params_json, channels, audience_json, status, created_by_type, created_by_id, created_by_label, last_sent_at) ' +
      "VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', 'staff', ?, ?, UTC_TIMESTAMP())",
      [no, category, content.subject || null, content.body || null, content.channels.indexOf('email') !== -1 ? emailHtml(content.subject, content.body) : null,
        content.whatsapp ? content.whatsapp.id : null, content.sms ? content.sms.id : null, content.params ? JSON.stringify(content.params) : null,
        content.channels.join(','), JSON.stringify(list.map(function (x) { return { type: x.type, ref: Number(x.ref) }; }).slice(0, 1000)), actor.id, actor.label]);
    const msg = { id: Number(m.insertId), no: no, category: category };
    for (const r of recipients) {
      const rr = await tx.query('INSERT INTO b2b_message_recipients (message_id, recipient_type, recipient_ref, display_name, email, mobile) VALUES (?, ?, ?, ?, ?, ?)',
        [msg.id, r.type, r.ref, String(r.name).slice(0, 190), r.email || null, r.mobile || null]);
      r.recipientRowId = Number(rr.insertId);
    }
    const sd = await tx.query("INSERT INTO b2b_message_sends (message_id, send_no, request_key, initiated_by_type, initiated_by_id, initiated_by_label, edited, channels, recipient_count, reason) VALUES (?, 1, ?, 'staff', ?, ?, 0, ?, ?, ?)",
      [msg.id, requestKey, actor.id, actor.label, content.channels.join(','), recipients.length, hold ? String(b.reason).trim().slice(0, 300) : null]);
    if (hold) {
      msg.approval = await holdForApproval(tx, actor, msg, Number(sd.insertId), 1, recipients.map(function (r) { return r.recipientRowId; }), content, b.reason);
      await tx.query("UPDATE b2b_messages SET status = 'awaiting_approval', approval_id = ?, last_sent_at = NULL WHERE id = ?", [msg.approval.approvalId, msg.id]);
      return msg;
    }
    const queued = await queueSend(tx, actor, msg, Number(sd.insertId), recipients, content);
    await tx.query('UPDATE b2b_message_sends SET queued_count = ? WHERE id = ?', [queued, sd.insertId]);
    await audit.write(tx, actor, { module: 'notifications', action: 'message.sent', entity: 'message', entityId: msg.id,
      new: { messageNo: no, category: category, channels: content.channels, recipients: recipients.length, queued: queued, sendNo: 1 } });
    return msg;
  }); } catch (e) {
    // two presses raced past the check above: the unique key let only one through
    if (dupKey(e)) { const r = await replay(requestKey, null); if (r) return r; }
    throw e;
  }
  if (res.approval) return Object.assign(await summary(res.id), { awaitingApproval: true, approvalId: res.approval.approvalId });
  kick();
  return summary(res.id);
}

/**
 * A promotional send above the threshold waits for a second person (D5): the send row exists
 * (it counts towards the sender's hourly limit and shows in history) but nothing is queued
 * until approval. The approver sees the subject, size and channels.
 */
async function holdForApproval(tx, actor, msg, sendId, sendNo, recipientRowIds, content, reason) {
  const a = await approvals.request(tx, actor, { type: 'notifications.promotional', entity: 'message_send', entityId: sendId, defaultPermission: 'notifications.promotional.approve',
    reason: String(reason).trim().slice(0, 500),
    payload: { messageNo: msg.no, sendNo: sendNo, subject: content.subject || null, channels: content.channels, recipients: recipientRowIds.length, recipientIds: recipientRowIds } });
  await audit.write(tx, actor, { module: 'notifications', action: 'message.held_for_approval', entity: 'message', entityId: msg.id,
    new: { messageNo: msg.no, sendNo: sendNo, recipients: recipientRowIds.length, approvalId: a.approvalId }, approvalId: a.approvalId });
  return a;
}

/** Approved: queue the held send now, to the recipients' current details (the worker checks consent again per row). */
approvals.register('notifications.promotional', async function (tx, req, actor) {
  const s = await tx.queryOne('SELECT * FROM b2b_message_sends WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!s) throw fail(409, 'This send no longer exists');
  const already = await tx.queryOne('SELECT COUNT(*) AS n FROM b2b_notification_queue WHERE send_id = ?', [s.id]);
  if (Number(already.n) > 0) throw fail(409, 'This send was already queued', 'already_queued');
  const m = await tx.queryOne('SELECT * FROM b2b_messages WHERE id = ? FOR UPDATE', [s.message_id]);
  const ids = (req.data && Array.isArray(req.data.recipientIds) ? req.data.recipientIds : []).map(Number).filter(Boolean);
  const rows = ids.length ? await tx.query('SELECT * FROM b2b_message_recipients WHERE message_id = ? AND id IN (' + db.placeholders(ids) + ')', [m.id].concat(ids)) : [];
  const now = await directory.resolve(rows.map(function (r) { return { type: r.recipient_type, ref: Number(r.recipient_ref) }; }));
  const cur = {}; now.forEach(function (p) { cur[p.type + ':' + p.ref] = p; });
  const targets = [], gone = [];
  rows.forEach(function (r) {
    const p = cur[r.recipient_type + ':' + r.recipient_ref];
    if (!p || !p.active) { gone.push(r.display_name); return; }
    targets.push({ recipientRowId: Number(r.id), name: r.display_name, type: r.recipient_type, ref: Number(r.recipient_ref), email: p.email, mobile: p.mobile });
  });
  const content = { channels: s.channels.split(','), subject: Number(s.edited) ? s.subject : m.subject, body: Number(s.edited) ? s.body_text : m.body_text };
  if (content.channels.indexOf('whatsapp') !== -1) content.whatsapp = await template(tx, 'whatsapp', m.whatsapp_template_id, m.category);
  try { content.params = m.template_params_json ? JSON.parse(m.template_params_json) : null; } catch (e) { content.params = null; }
  const queued = await queueSend(tx, actor, { id: Number(m.id), no: m.message_no, category: m.category }, Number(s.id), targets, content);
  await tx.query('UPDATE b2b_message_sends SET queued_count = ?, skipped_count = skipped_count + ? WHERE id = ?', [queued, gone.length, s.id]);
  await tx.query("UPDATE b2b_messages SET status = 'sent', last_sent_at = UTC_TIMESTAMP(), resend_count = resend_count + ? WHERE id = ?", [Number(s.send_no) > 1 ? 1 : 0, m.id]);
  await audit.write(tx, actor, { module: 'notifications', action: 'message.approved_sent', entity: 'message', entityId: m.id,
    new: { messageNo: m.message_no, sendNo: Number(s.send_no), queued: queued, notActive: gone }, approvalId: req.id });
  setTimeout(kick, 500);   // after the approval commits
  return { messageId: Number(m.id), sendNo: Number(s.send_no), queued: queued };
}, {
  onClosed: async function (tx, req, how, actor) {
    const s = await tx.queryOne('SELECT id, message_id, send_no FROM b2b_message_sends WHERE id = ? FOR UPDATE', [req.entityId]);
    if (!s) return null;
    await tx.query("UPDATE b2b_messages SET status = 'rejected' WHERE id = ? AND status = 'awaiting_approval'", [s.message_id]);
    await audit.write(tx, actor, { module: 'notifications', action: 'message.' + how, entity: 'message', entityId: s.message_id, new: { sendNo: Number(s.send_no) }, approvalId: req.id });
    return { messageId: Number(s.message_id), sendNo: Number(s.send_no), status: how };
  },
});

/**
 * Old and new contact details for the confirmation (D3). Full details for people who may see
 * contacts; masked otherwise, and a change the mask would hide (e.g. middle digits of a mobile)
 * is marked so the two sides never look identical.
 */
function contactChange(r, was, is, see) {
  const side = { old: {}, new: {} };
  [['email', directory.maskEmail], ['mobile', directory.maskMobile]].forEach(function (f) {
    const k = f[0], mask = f[1];
    side.old[k] = see ? was[k] : mask(was[k]);
    side.new[k] = see ? is[k] : mask(is[k]);
    if (was[k] !== is[k] && side.old[k] === side.new[k]) side.new[k] = (side.new[k] || '') + ' (changed)';
  });
  return { recipientId: Number(r.id), name: r.display_name, old: side.old, new: side.new };
}

/**
 * Resend a message: a NEW send of the same message (or an edited copy) to all or some of its
 * original recipients. Earlier sends and their results are kept unchanged.
 * b = { requestKey, recipientIds?: [b2b_message_recipients.id], edit?: { subject, body }, confirmChanged?: bool, reason? }
 */
async function resend(actor, principal, messageId, b) {
  const requestKey = String(b.requestKey || '');
  need(UUID.test(requestKey), 'requestKey (a new UUID per press of Resend) is required', 'request_key');
  const first = await replay(requestKey, posId(messageId));
  if (first) return first;
  const m = await db.queryOne('SELECT * FROM b2b_messages WHERE id = ?', [posId(messageId)]);
  if (!m) throw fail(404, 'Message not found');
  if (m.ref_type === 'otp') throw fail(409, 'One-time codes are never resent: they expire. The salesman asks for a new code.', 'otp_never_resent');
  if (m.status === 'awaiting_approval') throw fail(409, 'This message is waiting for approval; it can be resent once it has gone out', 'awaiting_approval');
  if (m.status === 'rejected') throw fail(409, 'This message was not approved and never went out; write a new message instead', 'message_rejected');
  const all = await db.query('SELECT * FROM b2b_message_recipients WHERE message_id = ? ORDER BY id', [m.id]);
  let chosen = all;
  if (Array.isArray(b.recipientIds) && b.recipientIds.length) {
    const want = b.recipientIds.map(Number);
    chosen = all.filter(function (r) { return want.indexOf(Number(r.id)) !== -1; });
    need(chosen.length === want.length, 'A resend goes only to this message\'s own recipients; to reach someone new, write a new message', 'not_original_recipient');
  }
  need(chosen.length, 'This message has no recipients');
  chosen.forEach(function (r) { if (!canSendTo(principal, r.recipient_type)) throw fail(403, 'You may not send messages to ' + r.recipient_type + 's', 'audience_forbidden'); });
  const lim = await limits();
  need(chosen.length <= lim.max_recipients, 'At most ' + lim.max_recipients + ' recipients per send', 'too_many_recipients');
  // current details of the same people (D3: changed contacts need confirmation)
  const now = await directory.resolve(chosen.filter(function (r) { return r.recipient_type !== 'address'; }).map(function (r) { return { type: r.recipient_type, ref: r.recipient_ref }; }));
  const cur = {}; now.forEach(function (p) { cur[p.type + ':' + p.ref] = p; });
  // a plain address (administrators' alert emails on automatic messages) is its own current detail
  chosen.forEach(function (r) { if (r.recipient_type === 'address') cur['address:' + r.recipient_ref] = { active: true, email: r.email, mobile: r.mobile }; });
  const changes = [], skipped = [], targets = [], see = canSee(principal);
  chosen.forEach(function (r) {
    const p = cur[r.recipient_type + ':' + r.recipient_ref];
    if (!p || !p.active) { skipped.push({ recipientId: Number(r.id), name: r.display_name, reason: p ? 'no longer active' : 'no longer exists' }); return; }
    const was = { email: r.email || null, mobile: r.mobile || null }, is = { email: p.email || null, mobile: p.mobile || null };
    if (was.email !== is.email || was.mobile !== is.mobile) changes.push(contactChange(r, was, is, see));
    targets.push({ recipientRowId: Number(r.id), name: r.display_name, type: r.recipient_type, ref: r.recipient_ref, email: is.email, mobile: is.mobile });
  });
  if (changes.length && b.confirmChanged !== true) {
    throw Object.assign(fail(409, 'Contact details changed since this message was sent. Confirm to send to the current details.', 'contact_changed'), { extra: { changes: changes } });
  }
  need(targets.length, 'None of the chosen recipients can receive messages any more', 'no_active_recipients');
  const edit = b.edit && typeof b.edit === 'object' ? b.edit : null;
  const base = { channels: m.channels.split(','), subject: m.subject, body: m.body_text };
  const content = readContent(edit ? { subject: edit.subject, body: edit.body, channels: b.channels } : { channels: b.channels }, base);
  content.channels = content.channels.filter(function (c) { return base.channels.indexOf(c) !== -1; });
  need(content.channels.length, 'A resend uses this message\'s own channels');
  const edited = !!edit && (content.subject !== (m.subject || '') || content.body !== (m.body_text || ''));
  promoRules(principal, m.category, Array.from(new Set(targets.map(function (t) { return t.type; }))), content.channels);
  const hold = needsApproval(m.category, targets.length, lim);
  if (hold) need(String(b.reason || '').trim().length >= 5, 'Say why this promotion should go out again (at least 5 characters): an approver reads it', 'reason_required');
  let held = null;
  try { await db.transaction(async function (tx) {
    await tx.queryOne('SELECT id FROM b2b_messages WHERE id = ? FOR UPDATE', [m.id]);
    await rateCheck(tx, actor, lim);
    const auto = m.origin === 'workflow';
    if (content.channels.indexOf('whatsapp') !== -1 && !(auto && !m.whatsapp_template_id)) content.whatsapp = await template(tx, 'whatsapp', m.whatsapp_template_id, m.category);
    if (content.channels.indexOf('sms') !== -1) content.sms = await template(tx, 'sms', m.sms_template_id, m.category);
    if (auto && !edited && m.email_html) content.html = m.email_html;   // the original email, with its portal link
    try { content.params = m.template_params_json ? JSON.parse(m.template_params_json) : null; } catch (e) { content.params = null; }
    const no = await tx.queryOne('SELECT COALESCE(MAX(send_no), 0) + 1 AS n FROM b2b_message_sends WHERE message_id = ?', [m.id]);
    const sd = await tx.query("INSERT INTO b2b_message_sends (message_id, send_no, request_key, initiated_by_type, initiated_by_id, initiated_by_label, edited, subject, body_text, channels, recipient_count, skipped_count, reason) " +
      "VALUES (?, ?, ?, 'staff', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [m.id, no.n, requestKey, actor.id, actor.label, edited ? 1 : 0, edited ? content.subject : null, edited ? content.body : null, content.channels.join(','), targets.length, skipped.length,
        b.reason ? String(b.reason).slice(0, 300) : (skipped.length ? skipped.map(function (s) { return s.name + ': ' + s.reason; }).join('; ').slice(0, 300) : null)]);
    if (hold) {
      held = await holdForApproval(tx, actor, { id: Number(m.id), no: m.message_no }, Number(sd.insertId), Number(no.n), targets.map(function (t) { return t.recipientRowId; }), content, b.reason);
      return;
    }
    const queued = await queueSend(tx, actor, m, Number(sd.insertId), targets, content);
    await tx.query('UPDATE b2b_message_sends SET queued_count = ? WHERE id = ?', [queued, sd.insertId]);
    await tx.query('UPDATE b2b_messages SET resend_count = resend_count + 1, last_sent_at = UTC_TIMESTAMP() WHERE id = ?', [m.id]);
    await audit.write(tx, actor, { module: 'notifications', action: 'message.resent', entity: 'message', entityId: m.id,
      new: { messageNo: m.message_no, sendNo: Number(no.n), recipients: targets.length, skipped: skipped.length, edited: edited, contactChangesConfirmed: changes.length } });
  }); } catch (e) {
    if (dupKey(e)) { const r = await replay(requestKey, m.id); if (r) return r; }
    throw e;
  }
  if (held) return Object.assign(await summary(m.id), { skipped: skipped, awaitingApproval: true, approvalId: held.approvalId });
  kick();
  return Object.assign(await summary(m.id), { skipped: skipped });
}

/**
 * What a send would do, before it is made: who is active, how many on each channel have an
 * address, how many would be stopped by an opt-out or missing consent, and whether a second
 * person must approve. Nothing is written.
 */
async function preview(principal, b) {
  const category = CATEGORIES.indexOf(b.category) !== -1 ? b.category : 'transactional';
  const channels = (Array.isArray(b.channels) ? b.channels : []).filter(function (c) { return CHANNELS.indexOf(c) !== -1; });
  need(channels.length, 'Choose at least one channel');
  const lim = await limits();
  const picked = (Array.isArray(b.recipients) ? b.recipients : []).concat(Array.isArray(b.groups) && b.groups.length ? await groups.expand(principal, b.groups, lim.max_recipients) : []);
  const once = {};
  const list = picked.filter(function (x) { const k = x && x.type + ':' + Number(x.ref); if (!x || once[k]) return false; once[k] = true; return true; });
  list.forEach(function (x) { if (!canSendTo(principal, x.type)) throw fail(403, 'You may not send messages to ' + x.type + 's', 'audience_forbidden'); });
  let problem = null;
  try { promoRules(principal, category, Array.from(new Set(list.map(function (x) { return x.type; }))), channels); } catch (e) { problem = { code: e.code, error: e.message }; }
  const people = list.length && list.length <= lim.max_recipients ? (await directory.resolve(list)).filter(function (p) { return p.active; }) : [];
  const prefs = people.length ? await consent.forRecipients(people, channels) : [];
  const per = {};
  channels.forEach(function (ch) { per[ch] = { recipients: people.length, withAddress: 0, optedOut: 0, noConsent: 0, willSend: 0 }; });
  prefs.forEach(function (x) {
    const c = per[x.channel];
    if (!x.hasAddress) return;
    c.withAddress++;
    const why = consent.decide(category, { promotional: x.promotional, all: x.all }, false);
    if (!why) c.willSend++; else if (/no recorded consent/.test(why)) c.noConsent++; else c.optedOut++;
  });
  return { category: category, chosen: list.length, active: people.length, tooMany: list.length > lim.max_recipients, limit: lim.max_recipients,
    needsApproval: needsApproval(category, people.length, lim), approvalOver: lim.promo_approval_over, channels: per, problem: problem };
}

/** Short answer after Send / Resend. */
async function summary(id, sendNo) {
  const m = await db.queryOne('SELECT id, message_no, subject, category, channels, resend_count, created_at FROM b2b_messages WHERE id = ?', [id]);
  const s = sendNo ? await db.queryOne('SELECT send_no, queued_count, skipped_count FROM b2b_message_sends WHERE message_id = ? AND send_no = ?', [id, sendNo])
    : await db.queryOne('SELECT send_no, queued_count, skipped_count FROM b2b_message_sends WHERE message_id = ? ORDER BY send_no DESC LIMIT 1', [id]);
  return { messageId: Number(m.id), messageNo: m.message_no, sendNo: Number(s.send_no), queued: Number(s.queued_count), skippedCount: Number(s.skipped_count), resendCount: Number(m.resend_count) };
}

/** Deliver promptly after a send (the worker would also pick it up within its interval). */
function kick() { setImmediate(function () { outbox.processDue(50).catch(function () { /* the worker retries */ }); }); }

const STATUS_FILTER = { queued: ['pending', 'sending'], accepted: ['sent'], failed: ['failed'], not_sent: ['skipped_no_provider', 'skipped_no_contact', 'skipped_opt_out'] };

/** History list with search and filters. */
async function list(principal, q) {
  const where = [], params = [];
  if (q.q) { where.push('(m.message_no LIKE ? OR m.subject LIKE ? OR m.body_text LIKE ?)'); const t = '%' + String(q.q).slice(0, 80) + '%'; params.push(t, t, t); }
  if (q.recipient) { where.push('EXISTS (SELECT 1 FROM b2b_message_recipients r WHERE r.message_id = m.id AND (r.display_name LIKE ? OR r.email LIKE ? OR r.mobile LIKE ?))'); const t = '%' + String(q.recipient).slice(0, 80) + '%'; params.push(t, t, t); }
  if (q.channel && CHANNELS.indexOf(q.channel) !== -1) { where.push('FIND_IN_SET(?, m.channels)'); params.push(q.channel); }
  if (q.category && CATEGORIES.indexOf(q.category) !== -1) { where.push('m.category = ?'); params.push(q.category); }
  if (q.origin && ['manual', 'workflow'].indexOf(q.origin) !== -1) { where.push('m.origin = ?'); params.push(q.origin); }
  if (q.messageStatus && ['awaiting_approval', 'rejected', 'sent'].indexOf(q.messageStatus) !== -1) { where.push('m.status = ?'); params.push(q.messageStatus); }
  if (q.sender) { where.push('m.created_by_label LIKE ?'); params.push('%' + String(q.sender).slice(0, 80) + '%'); }
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { where.push('m.created_at >= ?'); params.push(q.from); }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { where.push('m.created_at < (? + INTERVAL 1 DAY)'); params.push(q.to); }
  if (q.status && STATUS_FILTER[q.status]) { where.push('EXISTS (SELECT 1 FROM b2b_notification_queue nq WHERE nq.message_id = m.id AND nq.status IN (' + db.placeholders(STATUS_FILTER[q.status]) + '))'); params.push.apply(params, STATUS_FILTER[q.status]); }
  const page = Math.max(1, db.int(q.page, 1, 1, 100000)), size = db.int(q.size, 25, 5, 100);
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_messages m' + w, params);
  const rows = await db.query('SELECT m.id, m.message_no, m.subject, m.category, m.origin, m.channels, m.created_by_label, m.created_at, m.resend_count, m.last_sent_at, m.status AS message_status, ' +
    '(SELECT COUNT(*) FROM b2b_message_recipients r WHERE r.message_id = m.id) AS recipients, ' +
    '(SELECT r.display_name FROM b2b_message_recipients r WHERE r.message_id = m.id ORDER BY r.id LIMIT 1) AS first_recipient, ' +
    '(SELECT COUNT(*) FROM b2b_notification_queue nq WHERE nq.message_id = m.id) AS attempts, ' +
    "(SELECT COUNT(*) FROM b2b_notification_queue nq WHERE nq.message_id = m.id AND nq.status = 'sent') AS accepted, " +
    "(SELECT COUNT(*) FROM b2b_notification_queue nq WHERE nq.message_id = m.id AND nq.delivery_status IN ('delivered','read')) AS delivered, " +
    "(SELECT COUNT(*) FROM b2b_notification_queue nq WHERE nq.message_id = m.id AND nq.status = 'failed') AS failed, " +
    "(SELECT COUNT(*) FROM b2b_notification_queue nq WHERE nq.message_id = m.id AND nq.status LIKE 'skipped%') AS not_sent, " +
    "(SELECT COUNT(*) FROM b2b_notification_queue nq WHERE nq.message_id = m.id AND nq.status IN ('pending','sending')) AS queued " +
    'FROM b2b_messages m' + w + ' ORDER BY m.id DESC LIMIT ' + size + ' OFFSET ' + ((page - 1) * size), params);
  return { items: rows.map(function (r) { ['recipients', 'attempts', 'accepted', 'delivered', 'failed', 'not_sent', 'queued', 'resend_count'].forEach(function (k) { r[k] = Number(r[k]); }); return r; }), total: Number(total.n), page: page, size: size };
}

/** One message: original, recipients, every send, every attempt with its full history. */
async function detail(principal, id) {
  const m = await db.queryOne('SELECT id, message_no, origin, category, subject, body_text, channels, ref_type, ref_id, created_by_label, created_at, resend_count, last_sent_at, whatsapp_template_id, sms_template_id, template_params_json, body_purged_at, status, approval_id FROM b2b_messages WHERE id = ?', [posId(id)]);
  if (!m) throw fail(404, 'Message not found');
  const see = canSee(principal);
  const recipients = (await db.query('SELECT id, recipient_type, recipient_ref, display_name, email, mobile FROM b2b_message_recipients WHERE message_id = ? ORDER BY id', [m.id])).map(function (r) {
    return { id: Number(r.id), type: r.recipient_type, ref: Number(r.recipient_ref), name: r.display_name, email: see ? r.email : directory.maskEmail(r.email), mobile: see ? r.mobile : directory.maskMobile(r.mobile), canSend: canSendTo(principal, r.recipient_type) };
  });
  const sends = await db.query('SELECT id, send_no, initiated_by_label, edited, subject, body_text, channels, recipient_count, queued_count, skipped_count, reason, created_at FROM b2b_message_sends WHERE message_id = ? ORDER BY send_no', [m.id]);
  const rows = await db.query('SELECT id, send_id, message_recipient_id, channel, recipient, status, delivery_status, attempts, max_attempts, last_error, provider_message_id, template_name, created_at, sent_at FROM b2b_notification_queue WHERE message_id = ? ORDER BY id', [m.id]);
  const hist = rows.length ? await db.query('SELECT queue_id, status, detail, provider, provider_ref, source, actor_label, created_at FROM b2b_notification_events WHERE queue_id IN (' + db.placeholders(rows.map(function (r) { return r.id; })) + ') ORDER BY id', rows.map(function (r) { return r.id; })) : [];
  const byQ = {}; hist.forEach(function (h) { (byQ[h.queue_id] = byQ[h.queue_id] || []).push(h); });
  const attempts = rows.map(function (r) {
    return { id: Number(r.id), sendId: Number(r.send_id), recipientId: r.message_recipient_id == null ? null : Number(r.message_recipient_id), channel: r.channel,
      to: see ? r.recipient : (r.channel === 'email' ? directory.maskEmail(r.recipient) : directory.maskMobile(r.recipient)), status: r.status, deliveryStatus: r.delivery_status,
      tries: Number(r.attempts), maxTries: Number(r.max_attempts), error: r.last_error, providerRef: r.provider_message_id, template: r.template_name, createdAt: r.created_at, sentAt: r.sent_at,
      history: byQ[r.id] || [] };
  });
  // approval state of held promotional sends (D5)
  const held = await db.query("SELECT r.id, r.entity_id, r.status, r.reason, r.requested_at, r.decided_at FROM b2b_approval_requests r WHERE r.approval_type = 'notifications.promotional' AND r.entity = 'message_send' AND r.entity_id IN (" +
    (sends.length ? db.placeholders(sends.map(function (x) { return x.id; })) : 'NULL') + ') ORDER BY r.id', sends.map(function (x) { return String(x.id); }));
  const approvalOf = {}; held.forEach(function (h) { approvalOf[Number(h.entity_id)] = { id: Number(h.id), status: h.status, reason: h.reason, requestedAt: h.requested_at, decidedAt: h.decided_at }; });
  return {
    message: m, recipients: recipients, attempts: attempts, approvals: held.length,
    sends: sends.map(function (s) { return Object.assign(s, { id: Number(s.id), send_no: Number(s.send_no), approval: approvalOf[Number(s.id)] || null, attempts: attempts.filter(function (a) { return a.sendId === Number(s.id); }).map(function (a) { return a.id; }) }); }),
  };
}

/** Delivery analytics over the last N days (only what providers confirmed). */
async function analytics(days) {
  const d = db.int(days, 30, 1, 365);
  const byChannel = await db.query('SELECT channel, status, delivery_status, COUNT(*) AS n FROM b2b_notification_queue WHERE created_at >= (UTC_TIMESTAMP() - INTERVAL ' + d + ' DAY) GROUP BY channel, status, delivery_status', []);
  const byDay = await db.query("SELECT DATE(created_at) AS day, SUM(status = 'sent') AS accepted, SUM(status = 'failed') AS failed, SUM(status LIKE 'skipped%') AS not_sent, SUM(delivery_status IN ('delivered','read')) AS delivered FROM b2b_notification_queue WHERE created_at >= (UTC_TIMESTAMP() - INTERVAL " + d + ' DAY) GROUP BY DATE(created_at) ORDER BY day', []);
  const reasons = await db.query("SELECT last_error AS reason, COUNT(*) AS n FROM b2b_notification_queue WHERE status IN ('failed','skipped_no_provider','skipped_no_contact','skipped_opt_out') AND created_at >= (UTC_TIMESTAMP() - INTERVAL " + d + ' DAY) GROUP BY last_error ORDER BY n DESC LIMIT 10', []);
  const messages = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(resend_count), 0) AS resends FROM b2b_messages WHERE created_at >= (UTC_TIMESTAMP() - INTERVAL ' + d + ' DAY)', []);
  return { days: d, byChannel: byChannel.map(function (r) { return { channel: r.channel, status: r.status, deliveryStatus: r.delivery_status, n: Number(r.n) }; }),
    byDay: byDay.map(function (r) { return { day: r.day, accepted: Number(r.accepted), failed: Number(r.failed), notSent: Number(r.not_sent), delivered: Number(r.delivered) }; }),
    topReasons: reasons.map(function (r) { return { reason: r.reason, n: Number(r.n) }; }), messages: Number(messages.n), resends: Number(messages.resends),
    note: 'Email shows "accepted" only: mail servers do not report delivery. WhatsApp shows accepted until delivery tracking is approved (D2). SMS delivery comes from MSG91 reports.' };
}

module.exports = { send, resend, list, detail, analytics, limits, canSendTo, CHANNELS, CATEGORIES, D5, emailHtml, esc, contactChange, promoRules, needsApproval, unsubscribeFooter, preview, PROMO_TYPES };
