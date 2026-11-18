/**
 * N3 — consent, opt-out, promotional approval, groups and provider throughput on MySQL 8
 * (TEST database only; refuses while 013/014 are present). Real server + schema up to 017 +
 * a local fake SMTP server; the WhatsApp webhook is called with Meta's signature scheme.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup, bearer } = require('./helpers/erp.js');
const { fakeSmtp } = require('./helpers/fake-providers.js');
const b2bSecurity = require('../src/modules/b2b/lib/security.js');

const SITE = 'http://127.0.0.1';
let c, s, smtp;
const S = {};
const key = () => crypto.randomUUID();
const qp = t => t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
async function settle(id) {
  for (let i = 0; i < 60; i++) {
    const d = (await s.get('/api/erp/notifications/messages/' + id, c.maker.h)).data;
    if (d.attempts.length && d.attempts.every(a => a.status !== 'pending' && a.status !== 'sending')) return d;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('attempts did not settle');
}
const statusOf = (d, name) => d.attempts.filter(a => a.recipientId === d.recipients.find(r => r.name === name).id).map(a => a.status);

test.before(async () => {
  smtp = await fakeSmtp();
  c = await setup({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false', B2B_NOTIFY_INTERVAL_SECONDS: '5', PUBLIC_SITE_URL: SITE });
  s = c.s;
  S.ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  const acct = async (type, name, email, mobile) => {
    const id = Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, shop_name, contact_person, mobile, email, address_line1, city, pincode, state_id, district_name, approved_at) " +
      "VALUES (?, 'approved', ?, ?, 'Owner', ?, ?, 'MG Road', 'Bengaluru', '560001', ?, 'Bengaluru Urban', UTC_TIMESTAMP())", [type, name, name, mobile, email, S.ka])).insertId);
    await c.db.query("INSERT INTO b2b_users (account_id, name, mobile, email, password_hash, role, is_primary, status) VALUES (?, 'Owner', ?, ?, ?, ?, 1, 'active')", [id, mobile, email, b2bSecurity.hashPassword('Retailer!2345'), type]);
    return id;
  };
  S.yes = await acct('retailer', 'Agreed Stores', 'agreed@trial.local', '9845011111');
  S.none = await acct('retailer', 'Never Asked Mart', 'never@trial.local', '9845022222');
  S.no = await acct('distributor', 'Said No Traders', 'saidno@trial.local', '9845033333');
  S.sales = await c.person('salesmgr', ['sales_manager']);            // trade + salesmen, no promotions
  S.support = await c.person('support1', ['customer_support']);       // records consent
  S.proc = await c.person('procmgr', ['procurement_manager']);
});
test.after(async () => { if (c) await c.stop(); if (smtp) await smtp.close(); });

test('business portal: the account turns offers on itself; recorded with the address, audited as the business', async () => {
  const login = await s.post('/api/b2b/auth/login', { identifier: '9845011111', password: 'Retailer!2345', role: 'retailer' });
  assert.equal(login.status, 200);
  S.portal = bearer(login.data.token);
  const before = await s.get('/api/b2b/me/communication', S.portal);
  assert.equal(before.data.available, true); assert.equal(before.data.channels.email.offers, false);
  const on = await s.put('/api/b2b/me/communication', { email: true, whatsapp: true }, S.portal);
  assert.equal(on.status, 200); assert.equal(on.data.channels.email.offers, true); assert.equal(on.data.channels.whatsapp.offers, true);
  const rows = await c.db.query("SELECT channel, scope, state, source, recipient_type, recipient_ref, address_hash FROM b2b_contact_preferences ORDER BY id");
  assert.deepEqual(rows.map(r => [r.channel, r.scope, r.state, r.source, r.recipient_type, Number(r.recipient_ref)]), [['email', 'promotional', 'opted_in', 'portal', 'retailer', S.yes], ['whatsapp', 'promotional', 'opted_in', 'portal', 'retailer', S.yes]]);
  assert.ok(rows.every(r => /^[0-9a-f]{64}$/.test(r.address_hash)), 'addresses kept only as hashes');
  const a = await c.db.queryOne("SELECT actor_type, new_value, row_hash FROM b2b_audit_logs WHERE action = 'consent.opted_in' ORDER BY id LIMIT 1");
  assert.equal(a.actor_type, 'business'); assert.match(a.new_value, /a•••@trial\.local/); assert.doesNotMatch(a.new_value, /agreed@trial\.local/); assert.ok(a.row_hash);
});

test('admin records consent: evidence required for an opt-in; promotional consent only for business accounts; opt-outs always accepted', async () => {
  const rec = (b, who) => s.post('/api/erp/notifications/consent', b, (who || S.support).h);
  const noNote = await rec({ recipient: { type: 'retailer', ref: S.none }, channel: 'email', scope: 'promotional', state: 'opted_in', source: 'admin_call' });
  assert.equal(noNote.status, 400); assert.equal(noNote.data.code, 'consent_evidence');
  const staffPromo = await rec({ recipient: { type: 'staff', ref: S.sales.id }, channel: 'email', scope: 'promotional', state: 'opted_in', source: 'admin_written', note: 'signed form' });
  assert.equal(staffPromo.status, 400); assert.equal(staffPromo.data.code, 'promotional_business_only');
  const out = await rec({ recipient: { type: 'distributor', ref: S.no }, channel: 'email', scope: 'promotional', state: 'opted_out', source: 'admin_email' });
  assert.equal(out.status, 201);
  assert.equal((await rec({ recipient: { type: 'retailer', ref: S.none }, channel: 'email', scope: 'promotional', state: 'opted_out', source: 'admin_call' }, S.sales)).status, 403, 'needs notifications.optout.manage');
  const list = await s.get('/api/erp/notifications/consent?state=opted_out', S.support.h);
  assert.ok(list.data.items.some(x => x.recipient && x.recipient.name === 'Said No Traders' && x.recordedBy === 'support1@test.local'));
});

test('promotional send: only consented addresses get it, with an unsubscribe link; the rest are "not sent: opted out"; SMS and non-business recipients refused', async () => {
  const base = { requestKey: key(), category: 'promotional', channels: ['email'], subject: 'Diwali offer', body: 'Ten percent off on brown sugar this week.',
    recipients: [{ type: 'retailer', ref: S.yes }, { type: 'retailer', ref: S.none }, { type: 'distributor', ref: S.no }] };
  const salesTry = await s.post('/api/erp/notifications/messages', Object.assign({}, base, { requestKey: key() }), S.sales.h);
  assert.equal(salesTry.status, 403); assert.equal(salesTry.data.code, 'promotional_forbidden');
  const sms = await s.post('/api/erp/notifications/messages', Object.assign({}, base, { requestKey: key(), channels: ['sms'] }), c.maker.h);
  assert.equal(sms.data.code, 'promotional_no_sms');
  const staff = await s.post('/api/erp/notifications/messages', Object.assign({}, base, { requestKey: key(), recipients: [{ type: 'staff', ref: S.sales.id }] }), c.maker.h);
  assert.equal(staff.data.code, 'promotional_business_only');
  const pv = await s.post('/api/erp/notifications/preview', base, c.maker.h);
  assert.deepEqual(pv.data.channels.email, { recipients: 3, withAddress: 3, optedOut: 1, noConsent: 1, willSend: 1 });
  assert.equal(pv.data.needsApproval, false);
  const mailsBefore = smtp.mails.length;
  const r = await s.post('/api/erp/notifications/messages', base, c.maker.h);
  assert.equal(r.status, 201); assert.equal(r.data.queued, 3);
  S.promo = r.data.messageId;
  const d = await settle(S.promo);
  assert.deepEqual(statusOf(d, 'Agreed Stores'), ['sent']);
  assert.deepEqual(statusOf(d, 'Never Asked Mart'), ['skipped_opt_out']);
  assert.deepEqual(statusOf(d, 'Said No Traders'), ['skipped_opt_out']);
  const mine = smtp.mails.slice(mailsBefore);
  assert.equal(mine.length, 1, 'the provider saw only the consented address'); assert.match(mine[0].to[0], /agreed@trial\.local/);
  const link = qp(mine[0].data).match(/href="(http:\/\/127\.0\.0\.1\/api\/erp\/public\/unsubscribe\?t=[^"]+)"/);
  assert.ok(link, 'unsubscribe link in the email');
  S.unsub = link[1].replace(SITE, '').replace(/&amp;/g, '&');
});

test('unsubscribe link: opening it changes nothing; the button opts out; the next resend skips that address', async () => {
  const page = await s.get(S.unsub);
  assert.equal(page.status, 200); assert.match(page.data, /Stop offers by email/);
  const pref = () => c.db.queryOne("SELECT state, source FROM b2b_contact_preferences WHERE channel = 'email' AND scope = 'promotional' AND recipient_ref = ? AND recipient_type = 'retailer'", [S.yes]);
  assert.equal((await pref()).state, 'opted_in', 'opening the link is not an opt-out');
  const t = decodeURIComponent(S.unsub.split('t=')[1]);
  const res = await fetch(s.base + '/api/erp/public/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 't=' + encodeURIComponent(t) });
  assert.equal(res.status, 200);
  assert.deepEqual(await pref(), { state: 'opted_out', source: 'unsubscribe_link' });
  const forged = await fetch(s.base + '/api/erp/public/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 't=' + encodeURIComponent(t.slice(0, -3) + 'abc') });
  assert.equal(forged.status, 400);
  const again = await s.post('/api/erp/notifications/messages/' + S.promo + '/resend', { requestKey: key(), recipientIds: [(await s.get('/api/erp/notifications/messages/' + S.promo, c.maker.h)).data.recipients.find(x => x.name === 'Agreed Stores').id] }, c.maker.h);
  assert.equal(again.status, 201);
  const d = await settle(S.promo);
  assert.deepEqual(statusOf(d, 'Agreed Stores'), ['sent', 'skipped_opt_out'], 'earlier result kept; the new send respects the opt-out');
});

test('approval above the threshold (D5): nothing is queued until a second person approves; the writer cannot approve', async () => {
  await c.setting('notifications.limits', { max_recipients: 500, max_sends_per_hour: 20, promo_approval_over: 1 });
  const portal2 = bearer((await s.post('/api/b2b/auth/login', { identifier: '9845022222', password: 'Retailer!2345', role: 'retailer' })).data.token);
  await s.put('/api/b2b/me/communication', { email: true }, portal2);
  const b = { requestKey: key(), category: 'promotional', channels: ['email'], subject: 'New product', body: 'Jaggery powder is now available.', recipients: [{ type: 'retailer', ref: S.yes }, { type: 'retailer', ref: S.none }] };
  const noReason = await s.post('/api/erp/notifications/messages', Object.assign({}, b, { requestKey: key() }), c.maker.h);
  assert.equal(noReason.data.code, 'reason_required');
  const r = await s.post('/api/erp/notifications/messages', Object.assign({}, b, { reason: 'Launch announcement to consenting retailers' }), c.maker.h);
  assert.equal(r.status, 201); assert.equal(r.data.awaitingApproval, true); assert.equal(r.data.queued, 0);
  const id = r.data.messageId;
  assert.equal(Number((await c.db.queryOne('SELECT COUNT(*) AS n FROM b2b_notification_queue WHERE message_id = ?', [id])).n), 0);
  const resendWhileHeld = await s.post('/api/erp/notifications/messages/' + id + '/resend', { requestKey: key(), reason: 'again please' }, c.maker.h);
  assert.equal(resendWhileHeld.data.code, 'awaiting_approval');
  const self = await s.post('/api/erp/core/approvals/' + r.data.approvalId + '/decide', { decision: 'approved', comment: 'mine' }, c.maker.h);
  assert.equal(self.status, 403); assert.equal(self.data.code, 'maker_cannot_check');
  const req = await c.db.queryOne('SELECT payload_json FROM b2b_approval_requests WHERE id = ?', [r.data.approvalId]);
  assert.equal(JSON.parse(req.payload_json).approverPermission, 'notifications.promotional.approve');
  await c.approve(r.data.approvalId);
  const d = await settle(id);
  assert.deepEqual(statusOf(d, 'Never Asked Mart'), ['sent'], 'consented in the portal');
  assert.deepEqual(statusOf(d, 'Agreed Stores'), ['skipped_opt_out'], 'unsubscribed earlier');
  assert.equal(d.message.status, 'sent'); assert.equal(d.sends[0].approval.status, 'approved');
  assert.ok(await c.db.queryOne("SELECT id FROM b2b_audit_logs WHERE action = 'message.approved_sent' AND entity_id = ?", [String(id)]));
  // a rejected one never goes out and cannot be resent
  const r2 = await s.post('/api/erp/notifications/messages', Object.assign({}, b, { requestKey: key(), subject: 'Second offer', reason: 'Weekend offer for consenting retailers' }), c.maker.h);
  const rej = await s.post('/api/erp/core/approvals/' + r2.data.approvalId + '/decide', { decision: 'rejected', comment: 'Not this week' }, c.checker.h);
  assert.equal(rej.status, 200);
  const d2 = (await s.get('/api/erp/notifications/messages/' + r2.data.messageId, c.maker.h)).data;
  assert.equal(d2.message.status, 'rejected'); assert.equal(d2.attempts.length, 0); assert.equal(d2.sends[0].approval.status, 'rejected');
  assert.equal((await s.post('/api/erp/notifications/messages/' + r2.data.messageId + '/resend', { requestKey: key(), reason: 'try again' }, c.maker.h)).data.code, 'message_rejected');
  await c.setting('notifications.limits', { max_recipients: 500, max_sends_per_hour: 20, promo_approval_over: 100 });
});

test('WhatsApp STOP: recorded once per reply; stops order messages on WhatsApp, never sign-in codes; START resumes', async () => {
  const hook = async (messages) => {
    const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: messages } }] }] }));
    const sig = 'sha256=' + crypto.createHmac('sha256', 'whatsapp-app-secret-1234567890').update(body).digest('hex');
    return (await fetch(s.base + '/api/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: body })).status;
  };
  assert.equal(await hook([{ id: 'wamid.STOP1', from: '919845033333', type: 'text', text: { body: 'STOP' } }]), 200);
  assert.equal(await hook([{ id: 'wamid.STOP1', from: '919845033333', type: 'text', text: { body: 'STOP' } }]), 200);
  const p = await c.db.query("SELECT state, source FROM b2b_contact_preferences WHERE channel = 'whatsapp' AND scope = 'all'");
  assert.deepEqual(p.map(x => [x.state, x.source]), [['opted_out', 'whatsapp_reply']]);
  assert.equal(Number((await c.db.queryOne("SELECT COUNT(*) AS n FROM b2b_audit_logs WHERE action = 'consent.opted_out' AND new_value LIKE '%whatsapp_reply%'")).n), 1, 'a replayed webhook is not recorded twice');
  // an automatic WhatsApp order update and a sign-in code to the same number
  await c.db.query("INSERT INTO b2b_notification_queue (channel, recipient, body, status, template_name) VALUES ('whatsapp', '9845033333', 'Order shipped', 'pending', NULL), ('whatsapp', '9845033333', 'code', 'pending', 'whatsapp_otp')");
  for (let i = 0; i < 40; i++) {
    const rows = await c.db.query("SELECT status, template_name FROM b2b_notification_queue WHERE recipient = '9845033333' ORDER BY id");
    if (rows.every(r => r.status !== 'pending' && r.status !== 'sending')) {
      assert.equal(rows[0].status, 'skipped_opt_out');
      assert.notEqual(rows[1].status, 'skipped_opt_out', 'the sign-in code is not stopped by the opt-out (no WhatsApp provider here, so it is "not sent: no provider")');
      break;
    }
    if (i === 39) throw new Error('queue did not settle');
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(await hook([{ id: 'wamid.START1', from: '919845033333', type: 'text', text: { body: 'start' } }]), 200);
  assert.equal((await c.db.queryOne("SELECT state FROM b2b_contact_preferences WHERE channel = 'whatsapp' AND scope = 'all'")).state, 'opted_in');
});

test('groups: a rule group is worked out at send time; audience rules apply to groups; changes audited', async () => {
  const g = await s.post('/api/erp/notifications/groups', { name: 'All Karnataka retailers', kind: 'rule', rule: { type: 'retailer', stateId: S.ka } }, S.sales.h);
  assert.equal(g.status, 201);
  const forbidden = await s.post('/api/erp/notifications/groups', { name: 'Retailers (procurement)', kind: 'rule', rule: { type: 'retailer' } }, S.proc.h);
  assert.equal(forbidden.status, 403);
  const list = await s.get('/api/erp/notifications/groups', S.sales.h);
  const mine = list.data.items.find(x => x.id === g.data.id);
  assert.equal(mine.size, 2); assert.equal(mine.usable, true);
  assert.equal((await s.get('/api/erp/notifications/groups', S.proc.h)).data.items.find(x => x.id === g.data.id).usable, false);
  await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, contact_person, mobile, email, address_line1, city, pincode, state_id, approved_at) VALUES ('retailer', 'approved', 'New Shop', 'Owner', '9845044444', 'new@trial.local', 'x', 'Bengaluru', '560001', ?, UTC_TIMESTAMP())", [S.ka]);
  const r = await s.post('/api/erp/notifications/messages', { requestKey: key(), category: 'service', channels: ['email'], subject: 'Holiday hours', body: 'We are closed on Monday.', groups: [g.data.id] }, S.sales.h);
  assert.equal(r.status, 201); assert.equal(r.data.queued, 3, 'the new shop is included');
  const off = await s.put('/api/erp/notifications/groups/' + g.data.id, { active: false }, S.sales.h);
  assert.equal(off.status, 200);
  assert.equal((await s.post('/api/erp/notifications/messages', { requestKey: key(), category: 'service', channels: ['email'], subject: 'Holiday hours', body: 'Closed Monday.', groups: [g.data.id] }, S.sales.h)).data.code, 'group_inactive');
  assert.equal(Number((await c.db.queryOne("SELECT COUNT(*) AS n FROM b2b_audit_logs WHERE action IN ('group.created', 'group.updated')")).n), 2);
});

test('provider throughput on MySQL: with 1 email per minute, one goes now and the rest wait without using an attempt', async () => {
  await c.setting('notifications.provider_rates', { email: 1, whatsapp: 60, sms: 60 });
  await new Promise(r => setTimeout(r, 61000));   // let the last minute's hand-overs age out
  const r = await s.post('/api/erp/notifications/messages', { requestKey: key(), category: 'service', channels: ['email'], subject: 'Rate test', body: 'Rate test body.', recipients: [{ type: 'retailer', ref: S.yes }, { type: 'retailer', ref: S.none }, { type: 'distributor', ref: S.no }] }, S.sales.h);
  assert.equal(r.status, 201);
  await new Promise(r => setTimeout(r, 4000));
  const rows = await c.db.query('SELECT status, attempts FROM b2b_notification_queue WHERE message_id = ? ORDER BY id', [r.data.messageId]);
  assert.equal(rows.filter(x => x.status === 'sent').length, 1);
  assert.deepEqual(rows.filter(x => x.status === 'pending').map(x => Number(x.attempts)), [0, 0]);
  await c.setting('notifications.provider_rates', { email: 30, whatsapp: 60, sms: 60 });
});
