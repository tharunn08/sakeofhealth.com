/**
 * N1 — notification reliability on MySQL 8 (TEST database only: name must end in _test;
 * its b2b_* tables are wiped). Refuses while migrations 013/014 are present (D5).
 * Real outbox, real schema (migrations up to 016), local fake providers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { resetDatabase, db } = require('./helpers/db.js');
const { fakeSmtp, fakeMsg91, fakeMeta } = require('./helpers/fake-providers.js');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-n1m-'));
const PROVIDER_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'MSG91_AUTH_KEY', 'MSG91_BASE_URL', 'MSG91_TEMPLATE_ORDER_OTP', 'MSG91_WEBHOOK_TOKEN', 'WHATSAPP_TEMPLATE_ORDER_UPDATE'];
function svc() {
  ['../src/modules/b2b/notifications/service.js', '../src/services/notify.js', '../src/modules/b2b/lib/sms-msg91.js'].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  return require('../src/modules/b2b/notifications/service.js');
}
function noProviders() { PROVIDER_ENV.forEach(function (k) { delete process.env[k]; }); }
async function row(id) { return db.queryOne('SELECT * FROM b2b_notification_queue WHERE id = ?', [id]); }
async function hist(id) { return (await db.query('SELECT status, source, provider, provider_ref, actor_label FROM b2b_notification_events WHERE queue_id = ? ORDER BY id', [id])); }
async function drain(s) { await db.query("UPDATE b2b_notification_queue SET next_attempt_at = UTC_TIMESTAMP() WHERE status = 'pending'"); return s.processDue(50); }

test.before(async () => { await resetDatabase(); });
test.after(async () => { await db.close(); });

test('schema: migration 016 adds the history table, queue links and "not sent" statuses', async () => {
  const cols = (await db.query("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_notification_queue'")).map(r => r.c);
  ['message_id', 'send_id', 'message_recipient_id'].forEach(c => assert.ok(cols.includes(c), c));
  const st = await db.queryOne("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_notification_queue' AND COLUMN_NAME = 'status'");
  assert.match(st.t, /skipped_no_contact.*skipped_opt_out/);
  for (const t of ['b2b_notification_events', 'b2b_messages', 'b2b_message_recipients', 'b2b_message_sends', 'b2b_message_templates', 'b2b_contact_preferences', 'b2b_recipient_groups', 'b2b_recipient_group_members']) {
    assert.ok(await db.queryOne('SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]), t);
  }
});

test('no provider: queued rows end as skipped_no_provider with history, never sent', async () => {
  noProviders(); const s = svc();
  const ids = [];
  await db.transaction(async function (tx) {
    ids.push(await s.enqueue(tx, { channel: 'email', recipient: 'r1@trial.local', subject: 'Approved', body: '<p>x</p>' }));
    ids.push(await s.enqueue(tx, { channel: 'whatsapp', recipient: '9845000011', body: 'x' }));
  });
  await drain(s);
  for (const id of ids) {
    assert.equal((await row(id)).status, 'skipped_no_provider');
    assert.deepEqual((await hist(id)).map(h => h.status), ['queued', 'sending', 'skipped_no_provider']);
  }
});

test('SMTP, WhatsApp template and MSG91: accepted with provider ids; SMS delivery report recorded', async (t) => {
  const smtp = await fakeSmtp(), gw = await fakeMsg91(); const meta = fakeMeta();
  t.after(async () => { meta.restore(); await smtp.close(); await gw.close(); });
  noProviders();
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false',
    WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_TEMPLATE_ORDER_UPDATE: 'order_status_v2', MSG91_AUTH_KEY: 'k', MSG91_BASE_URL: gw.url, MSG91_TEMPLATE_ORDER_OTP: 'DLT9', MSG91_WEBHOOK_TOKEN: crypto.randomBytes(24).toString('hex') });
  const s = svc();
  const e = await s.enqueue(null, { channel: 'email', recipient: 'r2@trial.local', subject: 'Shipped', body: '<p>Shipped</p>' });
  const w = await s.enqueue(null, { channel: 'whatsapp', recipient: '9845000011', body: 'x', templateName: 'order_update', templateParams: ['Asha', 'SO-1', 'Shipped'] });
  const m = await s.enqueue(null, { channel: 'sms', recipient: '9845000011', body: '[code]', templateName: 'order_otp', templateParams: { otp: '123456' } });
  await drain(s);
  assert.equal((await row(e)).status, 'sent'); assert.match((await row(e)).provider_message_id, /^<.+>$/);
  assert.equal(meta.calls[0].body.template.name, 'order_status_v2');
  assert.equal((await row(w)).status, 'sent'); assert.equal((await row(w)).provider_message_id, null);
  const sms = await row(m);
  assert.equal(sms.status, 'sent'); assert.equal(sms.provider_message_id, 'REQ1'); assert.equal(sms.template_params_json, null, 'code erased');
  assert.deepEqual((await hist(m)).map(h => h.status), ['queued', 'sending', 'accepted']);
  // delivery report through the real MSG91 webhook handler: recorded once, never backwards
  const hooks = require('../src/modules/erp/core/webhooks.js');
  const tok = process.env.MSG91_WEBHOOK_TOKEN;
  assert.deepEqual((await hooks.processMsg91([{ requestId: 'REQ1', status: 'delivered' }], tok)).outcomes, ['processed']);
  assert.deepEqual((await hooks.processMsg91([{ requestId: 'REQ1', status: 'delivered' }], tok)).outcomes, ['duplicate']);
  assert.deepEqual((await hooks.processMsg91([{ requestId: 'REQ1', status: 'sent' }], tok)).outcomes, ['stale'], 'a late "sent" never overwrites "delivered"');
  assert.equal((await row(m)).delivery_status, 'delivered');
  const h = await hist(m);
  assert.deepEqual(h.map(x => x.status), ['queued', 'sending', 'accepted', 'delivered']);
  assert.equal(h[3].source, 'webhook'); assert.equal(h[3].provider_ref, 'REQ1');
});

test('failures: back-off kept, final failure after the last attempt; status never goes backwards', async (t) => {
  const smtp = await fakeSmtp({ refuse: true }); t.after(() => smtp.close());
  noProviders(); Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false' });
  const s = svc();
  const id = await s.enqueue(null, { channel: 'email', recipient: 'x@trial.local', subject: 'x', body: 'x' });
  await drain(s);
  const r1 = await row(id);
  assert.equal(r1.status, 'pending'); assert.equal(r1.attempts, 1);
  const wait = await db.queryOne('SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), next_attempt_at) AS s FROM b2b_notification_queue WHERE id = ?', [id]);
  assert.ok(wait.s >= 50 && wait.s <= 70, 'next try in about 1 minute');
  for (let i = 0; i < 3; i++) await drain(s);
  assert.equal((await row(id)).status, 'failed'); assert.equal((await row(id)).attempts, 4);
  // a late answer for a row that is no longer "sending" changes nothing
  await s.settle(await row(id), { ok: true, provider: 'smtp' });
  assert.equal((await row(id)).status, 'failed');
  const h = (await hist(id)).map(x => x.status);
  assert.deepEqual(h, ['queued', 'sending', 'retry_scheduled', 'sending', 'retry_scheduled', 'sending', 'retry_scheduled', 'sending', 'failed']);
});

test('admin retry: only failed / not-sent rows, never one-time codes, each recorded with who', async () => {
  noProviders(); const s = svc();
  const a = await s.enqueue(null, { channel: 'email', recipient: 'y@trial.local', subject: 'x', body: 'x' });
  const otp = await s.enqueue(null, { channel: 'sms', recipient: '9845000011', body: '[c]', templateName: 'order_otp', templateParams: { otp: '1' } });
  await drain(s);
  const r = await s.requeue([a, otp], 'Admin (admin@trial.local)');
  assert.deepEqual(r.requeued, [a]); assert.equal(r.refused[0].id, otp);
  assert.equal((await hist(a)).filter(h => h.status === 'requeued' && h.actor_label === 'Admin (admin@trial.local)').length, 1);
});

test('history is insert-only and the outbox touches no business table', async () => {
  const before = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_notification_events');
  noProviders(); const s = svc();
  await s.enqueue(null, { channel: 'email', recipient: 'z@trial.local', subject: 'x', body: 'x' });
  await drain(s);
  const after = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_notification_events');
  assert.ok(Number(after.n) > Number(before.n));
  for (const t of ['b2b_orders', 'b2b_payments', 'b2b_invoices', 'b2b_stock', 'b2b_stock_movements']) {
    const c = await db.queryOne('SELECT COUNT(*) AS n FROM ' + t);
    assert.equal(Number(c.n), 0, t + ' untouched');
  }
});
