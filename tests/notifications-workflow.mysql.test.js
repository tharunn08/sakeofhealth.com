/**
 * N5 — automatic notifications in the notification center, on MySQL 8 (TEST database only;
 * refuses while 013/014 are present). Real server + schema up to 018 + a local fake SMTP server.
 * Security events (admin password reset, own password change) create one record each, appear in
 * the history with every attempt, and can be resent one by one — without repeating the event.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { setup, bearer } = require('./helpers/erp.js');
const { fakeSmtp } = require('./helpers/fake-providers.js');
const b2bSecurity = require('../src/modules/b2b/lib/security.js');

let c, s, smtp, admin;
const S = {};
const key = () => crypto.randomUUID();
async function settle(id) {
  for (let i = 0; i < 60; i++) {
    const d = (await s.get('/api/erp/notifications/messages/' + id, c.maker.h)).data;
    if (d.attempts.length && d.attempts.every(a => a.status !== 'pending' && a.status !== 'sending')) return d;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('attempts did not settle');
}
async function workflowMessages() { return (await s.get('/api/erp/notifications/messages?origin=workflow', c.maker.h)).data.items; }

test.before(async () => {
  smtp = await fakeSmtp();
  c = await setup({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false', B2B_NOTIFY_INTERVAL_SECONDS: '5' });
  s = c.s;
  admin = bearer((await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token);
  const ka = Number((await c.db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'")).id);
  S.r1 = Number((await c.db.query("INSERT INTO b2b_accounts (account_type, status, business_name, contact_person, mobile, email, address_line1, city, pincode, state_id, approved_at) " +
    "VALUES ('retailer', 'approved', 'Ganesh Stores', 'Owner', '9845011111', 'ganesh@trial.local', 'MG Road', 'Bengaluru', '560001', ?, UTC_TIMESTAMP())", [ka])).insertId);
  await c.db.query("INSERT INTO b2b_users (account_id, name, mobile, email, password_hash, role, is_primary, status) VALUES (?, 'Owner', '9845011111', 'ganesh@trial.local', ?, 'retailer', 1, 'active')", [S.r1, b2bSecurity.hashPassword('Retailer!2345')]);
  S.sales = await c.person('salesmgr', ['sales_manager']);
});
test.after(async () => { if (c) await c.stop(); if (smtp) await smtp.close(); });

test('admin password reset: one automatic record, email only, delivered; listed under automatic messages', async () => {
  const r = await s.post('/api/admin/b2b/accounts/' + S.r1 + '/reset-password', { password: 'NewPassw0rd!x' }, admin);
  assert.equal(r.status, 200);
  let items = [];
  for (let i = 0; i < 20 && !items.length; i++) { items = await workflowMessages(); if (!items.length) await new Promise(r => setTimeout(r, 200)); }
  assert.equal(items.length, 1);
  assert.equal(items[0].subject, 'Your password was reset by our team'); assert.equal(items[0].origin, 'workflow'); assert.equal(items[0].channels, 'email');
  S.reset = items[0].id;
  const d = await settle(S.reset);
  assert.equal(d.message.created_by_label, 'automatic: security.password_reset');
  assert.deepEqual(d.recipients.map(r => [r.type, r.name]), [['retailer', 'Ganesh Stores']]);
  assert.deepEqual(d.attempts.map(a => a.status), ['sent']);
  assert.deepEqual(d.attempts[0].history.map(h => h.status), ['queued', 'sending', 'accepted']);
  assert.equal(d.sends.length, 1); assert.equal(d.sends[0].initiated_by_label, 'automatic: security.password_reset');
  assert.doesNotMatch(JSON.stringify(d), /NewPassw0rd/, 'the new password is never in a message');
});

test('individual resend of an automatic message: a new send to the same person, the original email; the event itself is not repeated', async () => {
  const tokenVersion = Number((await c.db.queryOne('SELECT token_version FROM b2b_users WHERE account_id = ?', [S.r1])).token_version);
  const mails = smtp.mails.length;
  const r = await s.post('/api/erp/notifications/messages/' + S.reset + '/resend', { requestKey: key() }, S.sales.h);
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.sendNo, 2);
  const d = await settle(S.reset);
  assert.deepEqual(d.attempts.map(a => a.status), ['sent', 'sent']);
  assert.equal(d.sends[1].initiated_by_label, 'salesmgr@test.local');
  assert.equal(smtp.mails.length, mails + 1); assert.match(smtp.mails[mails].to[0], /ganesh@trial\.local/);
  assert.equal(Number((await c.db.queryOne('SELECT token_version FROM b2b_users WHERE account_id = ?', [S.r1])).token_version), tokenVersion, 'no second password reset');
  assert.equal((await workflowMessages()).length, 1, 'no new automatic record');
  assert.ok(await c.db.queryOne("SELECT id FROM b2b_audit_logs WHERE action = 'message.resent' AND entity_id = ?", [String(S.reset)]));
});

test('own password change: told by email, recorded once; the change works even with no email provider problem in the way', async () => {
  const login = await s.post('/api/b2b/auth/login', { identifier: '9845011111', password: 'NewPassw0rd!x', role: 'retailer' });
  assert.equal(login.status, 200);
  const ch = await s.post('/api/b2b/me/password', { current_password: 'NewPassw0rd!x', new_password: 'Another1pass!' }, bearer(login.data.token));
  assert.equal(ch.status, 200);
  let items = [];
  for (let i = 0; i < 20 && items.length < 2; i++) { items = await workflowMessages(); if (items.length < 2) await new Promise(r => setTimeout(r, 200)); }
  assert.deepEqual(items.map(x => x.subject).sort(), ['Your password was changed', 'Your password was reset by our team']);
});

test('history filters: automatic messages separate from written ones; workflow records never touch orders, payments, invoices or stock', async () => {
  const before = await c.db.query("SELECT (SELECT COUNT(*) FROM b2b_orders) AS o, (SELECT COUNT(*) FROM b2b_payments) AS p, (SELECT COUNT(*) FROM b2b_invoices) AS i, (SELECT COUNT(*) FROM b2b_stock_movements) AS m");
  await s.post('/api/erp/notifications/messages/' + S.reset + '/resend', { requestKey: key() }, S.sales.h);
  const after = await c.db.query("SELECT (SELECT COUNT(*) FROM b2b_orders) AS o, (SELECT COUNT(*) FROM b2b_payments) AS p, (SELECT COUNT(*) FROM b2b_invoices) AS i, (SELECT COUNT(*) FROM b2b_stock_movements) AS m");
  assert.deepEqual(after, before);
  assert.equal((await s.get('/api/erp/notifications/messages?origin=manual', c.maker.h)).data.items.length, 0);
});
