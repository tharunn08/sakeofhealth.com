/**
 * N2 — notification center on MySQL 8 (TEST database only; refuses while 013/014 are present).
 * Real server + schema up to 017 + a local fake SMTP server. Covers: send, history, detail,
 * repeated resends after delivery, double-click protection, edited copies, subsets, changed
 * contacts (D3), permissions per audience, masking, rate limit (D5), audit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup } = require('./helpers/erp.js');
const { fakeSmtp } = require('./helpers/fake-providers.js');

let c, s, smtp;
const S = {};
const key = () => crypto.randomUUID();
async function settle(id) {   // wait until the worker has handled every attempt of a message
  for (let i = 0; i < 60; i++) {
    const d = (await s.get('/api/erp/notifications/messages/' + id, c.maker.h)).data;
    if (d.attempts.length && d.attempts.every(a => a.status !== 'pending' && a.status !== 'sending')) return d;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('attempts did not settle');
}

test.before(async () => {
  smtp = await fakeSmtp();
  c = await setup({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false', B2B_NOTIFY_INTERVAL_SECONDS: '5' });
  s = c.s;
  const ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  const acct = async (name, email, mobile) => Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, shop_name, contact_person, mobile, email, address_line1, city, pincode, state_id, district_name, approved_at) " +
    "VALUES ('retailer', 'approved', ?, ?, 'Owner', ?, ?, 'MG Road', 'Bengaluru', '560001', ?, 'Bengaluru Urban', UTC_TIMESTAMP())", [name, name, mobile, email, ka])).insertId);
  S.r1 = await acct('Ganesh Stores', 'ganesh@trial.local', '9845011111');
  S.r2 = await acct('Lakshmi Medicals', 'lakshmi@trial.local', '9845022222');
  S.r3 = await acct('No Email Mart', null, '9845033333');
  S.sales = await c.person('salesmgr', ['sales_manager']);
  S.proc = await c.person('procmgr', ['procurement_manager']);
  S.aud = await c.person('auditor1', ['auditor']);
  S.support = await c.person('support1', ['customer_support']);   // may see full contacts
});
test.after(async () => { if (c) await c.stop(); if (smtp) await smtp.close(); });

test('send: one message, one send, one queue row per recipient × channel; accepted by the provider; audited', async () => {
  const k = key();
  const r = await s.post('/api/erp/notifications/messages', { requestKey: k, category: 'transactional', channels: ['email'], subject: 'Price update', body: 'New prices apply from Monday.',
    recipients: [{ type: 'retailer', ref: S.r1 }, { type: 'retailer', ref: S.r2 }, { type: 'retailer', ref: S.r3 }] }, S.sales.h);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.queued, 3);
  S.m = r.data.messageId;
  const d = await settle(S.m);
  assert.deepEqual(d.attempts.map(a => a.status).sort(), ['sent', 'sent', 'skipped_no_contact']);
  assert.ok(d.attempts.filter(a => a.status === 'sent').every(a => /^<.+>$/.test(a.providerRef)), 'mail server ids stored');
  assert.deepEqual(d.attempts.find(a => a.status === 'sent').history.map(h => h.status), ['queued', 'sending', 'accepted']);
  assert.equal(smtp.mails.length, 2);
  // double-click / network retry: the same key returns the same send
  const again = await s.post('/api/erp/notifications/messages', { requestKey: k, category: 'transactional', channels: ['email'], subject: 'Price update', body: 'New prices apply from Monday.', recipients: [{ type: 'retailer', ref: S.r1 }] }, S.sales.h);
  assert.equal(again.data.duplicate, true); assert.equal(again.data.messageId, S.m);
  assert.equal(Number((await c.db.queryOne('SELECT COUNT(*) AS n FROM b2b_messages')).n), 1);
  assert.ok(await c.db.queryOne("SELECT id FROM b2b_audit_logs WHERE action = 'message.sent' AND entity_id = ?", [String(S.m)]));
});

test('resend after delivery, three times: each a new send with new attempts; earlier results kept', async () => {
  const before = (await settle(S.m)).attempts.length;
  for (let i = 0; i < 3; i++) {
    const r = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: key() }, S.sales.h);
    assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.sendNo, i + 2);
  }
  const d = await settle(S.m);
  assert.equal(d.sends.length, 4); assert.equal(d.message.resend_count, 3);
  assert.equal(d.attempts.length, before + 9);
  assert.ok(d.sends.every(x => x.initiated_by_label === 'salesmgr@test.local'));
  assert.equal(Number((await c.db.queryOne("SELECT COUNT(*) AS n FROM b2b_audit_logs WHERE action = 'message.resent' AND entity_id = ?", [String(S.m)])).n), 3);
});

test('resend double-click: one key, one send', async () => {
  const k = key();
  const [a, b] = await Promise.all([1, 2].map(() => s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: k }, S.sales.h)));
  const sends = Number((await c.db.queryOne('SELECT COUNT(*) AS n FROM b2b_message_sends WHERE request_key = ?', [k])).n);
  assert.equal(sends, 1);
  assert.deepEqual([a.status, b.status], [201, 201], 'the losing press answers with the first result, not an error');
  const own = Number((await c.db.queryOne('SELECT send_no FROM b2b_message_sends WHERE request_key = ?', [k])).send_no);
  assert.equal(a.data.sendNo, own); assert.equal(b.data.sendNo, own);
  assert.equal([a.data.duplicate, b.data.duplicate].filter(Boolean).length, 1);
  await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: key() }, S.sales.h);   // a later send
  const late = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: k }, S.sales.h);
  assert.equal(late.data.sendNo, own, 'a repeat reports its own send, not the latest');
});

test('edited copy and subset: the original stays as written', async () => {
  const one = (await s.get('/api/erp/notifications/messages/' + S.m, S.sales.h)).data.recipients.find(r => r.name === 'Ganesh Stores');
  const r = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: key(), recipientIds: [one.id], edit: { subject: 'Price update (corrected)', body: 'New prices apply from Tuesday.' } }, S.sales.h);
  assert.equal(r.status, 201);
  const d = await settle(S.m);
  assert.equal(d.message.subject, 'Price update'); assert.equal(d.message.body_text, 'New prices apply from Monday.');
  const last = d.sends[d.sends.length - 1];
  assert.equal(last.edited, 1); assert.equal(last.subject, 'Price update (corrected)'); assert.equal(last.recipient_count, 1);
  const bad = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: key(), recipientIds: [999999] }, S.sales.h);
  assert.equal(bad.status, 400); assert.equal(bad.data.code, 'not_original_recipient');
});

test('changed contact (D3): old and new shown, sent only after confirmation, to the current address', async () => {
  await c.db.query("UPDATE b2b_accounts SET email = 'ganesh.new@trial.local' WHERE id = ?", [S.r1]);
  const k = key();
  const r = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: k }, S.sales.h);
  assert.equal(r.status, 409); assert.equal(r.data.code, 'contact_changed');
  // masked for the sales manager, but the change is never hidden by the mask
  assert.equal(r.data.changes[0].old.email, 'g•••@trial.local'); assert.equal(r.data.changes[0].new.email, 'g•••@trial.local (changed)');
  // full old and new for someone allowed to see contacts
  const full = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: key() }, S.support.h);
  assert.equal(full.status, 409);
  assert.equal(full.data.changes[0].old.email, 'ganesh@trial.local');
  assert.equal(full.data.changes[0].new.email, 'ganesh.new@trial.local');
  const ok = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: k, confirmChanged: true }, S.sales.h);
  assert.equal(ok.status, 201);
  await settle(S.m);
  assert.ok(smtp.mails.some(m => /ganesh\.new@trial\.local/.test(m.to.join(','))));
});

test('permissions and masking: audience rules; auditors look but cannot send; contacts masked without the right', async () => {
  const p = await s.post('/api/erp/notifications/messages', { requestKey: key(), channels: ['email'], subject: 'Hello there', body: 'A message to a retailer', recipients: [{ type: 'retailer', ref: S.r2 }] }, S.proc.h);
  assert.equal(p.status, 403); assert.equal(p.data.code, 'audience_forbidden');
  assert.equal((await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: key() }, S.aud.h)).status, 403);
  const view = await s.get('/api/erp/notifications/messages/' + S.m, S.aud.h);
  assert.equal(view.status, 200);
  assert.ok(view.data.recipients.every(r => !r.email || /•••/.test(r.email)), 'masked for the auditor');
  const full = await s.get('/api/erp/notifications/messages/' + S.m, c.maker.h);
  assert.ok(full.data.recipients.some(r => r.email === 'lakshmi@trial.local'), 'super admin sees contacts');
  const list = await s.get('/api/erp/notifications/messages?recipient=Lakshmi&channel=email&status=accepted', S.aud.h);
  assert.equal(list.data.total, 1);
});

test('rate limit (D5, configurable): the 21st send in an hour by one person is refused', async () => {
  const sent = Number((await c.db.queryOne('SELECT COUNT(*) AS n FROM b2b_message_sends WHERE initiated_by_id = ?', [S.sales.id])).n);
  for (let i = sent; i < 20; i++) {
    const r = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: key(), recipientIds: [(await s.get('/api/erp/notifications/messages/' + S.m, S.sales.h)).data.recipients[1].id] }, S.sales.h);
    assert.equal(r.status, 201, 'send ' + (i + 1));
  }
  const over = await s.post('/api/erp/notifications/messages/' + S.m + '/resend', { requestKey: key() }, S.sales.h);
  assert.equal(over.status, 429); assert.equal(over.data.code, 'send_limit');
});

test('analytics and isolation: counts from the outbox; no order, payment, invoice or stock row touched', async () => {
  const a = await s.get('/api/erp/notifications/analytics?days=1', S.aud.h);
  assert.ok(a.data.byChannel.some(r => r.channel === 'email' && r.status === 'sent'));
  for (const t of ['b2b_orders', 'b2b_payments', 'b2b_invoices', 'b2b_stock_movements']) assert.equal(Number((await c.db.queryOne('SELECT COUNT(*) AS n FROM ' + t)).n), 0, t);
});
