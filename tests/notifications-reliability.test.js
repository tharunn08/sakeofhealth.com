/**
 * N1 — notification reliability, without a database: the real outbox code
 * (src/modules/b2b/notifications/service.js) runs against an in-memory stand-in for
 * the queue table and against local fake providers (SMTP server, Meta API, MSG91).
 * The same behaviour on MySQL 8 is in tests/notifications-reliability.mysql.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeSmtp, fakeMsg91, fakeMeta } = require('./helpers/fake-providers.js');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-n1-'));   // the shop sender loads the JSON store
const ROOT = path.join(__dirname, '..');

/* ── an in-memory stand-in for b2b_notification_queue + b2b_notification_events ── */
function fakeDb() {
  const rows = new Map(); const events = []; const sql = []; let nextId = 1; let historyTable = true;
  const prefs = []; const messages = new Map(); const settings = new Map();
  const wf = { column: null, accounts: new Map(), inapp: [], msgs: [], recips: [], sends: [], seq: 0 };
  const pick = function (r) { return { id: r.id, status: r.status, template_name: r.template_name }; };
  const upd = function (id, need, fn) { const r = rows.get(Number(id)); if (!r || (need && r.status !== need)) return { affectedRows: 0 }; fn(r); return { affectedRows: 1 }; };
  const api = {
    rows: rows, events: events, sql: sql, prefs: prefs, messages: messages, settings: settings, wf: wf,
    ageEvents: function () { events.forEach(function (e) { e.old = true; }); },
    dropHistoryTable: function () { historyTable = false; },
    add: function (r) {
      const row = Object.assign({ id: nextId++, status: 'pending', attempts: 0, max_attempts: 4, last_error: null, template_name: null, template_params_json: null,
        provider_message_id: null, subject: null, body: 'Hello', due: true }, r);
      rows.set(row.id, row); return row;
    },
    placeholders: function (l) { return l.map(function () { return '?'; }).join(', '); },
    int: function (n, f, min, max) { let v = parseInt(n, 10); if (!Number.isFinite(v)) v = f; if (min != null && v < min) v = min; if (max != null && v > max) v = max; return v; },
    queryOne: async function (q, p) { const r = await api.query(q, p); return r[0] || null; },
    query: async function (q, p) {
      p = p || []; sql.push(q);
      if (/^INSERT INTO b2b_notification_events/.test(q)) {
        if (!historyTable) { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
        events.push({ queue_id: Number(p[0]), status: p[1], detail: p[2], provider: p[3], provider_ref: p[4], source: p[5], actor: p[6], channel: (rows.get(Number(p[0])) || {}).channel }); return { affectedRows: 1, insertId: events.length };
      }
      if (/^SELECT id FROM b2b_notification_queue WHERE status = 'sending' AND next_attempt_at </.test(q)) return [...rows.values()].filter(function (r) { return r.status === 'sending' && r.stale; }).map(function (r) { return { id: r.id }; });
      if (/^UPDATE b2b_notification_queue SET status = 'pending' WHERE id = \? AND status = 'sending'$/.test(q)) return upd(p[0], 'sending', function (r) { r.status = 'pending'; r.stale = false; });
      if (/SET status = 'sending', attempts = attempts \+ 1/.test(q)) {
        const lim = Number(q.match(/LIMIT (\d+)$/)[1]); let n = 0;
        for (const r of rows.values()) if (n < lim && r.status === 'pending' && r.due && r.channel === p[1]) { r.status = 'sending'; r.attempts++; r.last_error = p[0]; n++; }
        return { affectedRows: n };
      }
      if (/^SELECT q\.channel, COUNT\(\*\) AS n FROM b2b_notification_events e JOIN b2b_notification_queue q/.test(q)) {
        if (!historyTable) { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
        const c = {}; events.forEach(function (e) { if (e.status === 'sending' && !e.old) c[e.channel] = (c[e.channel] || 0) + 1; });
        return Object.keys(c).map(function (k) { return { channel: k, n: c[k] }; });
      }
      if (/^SELECT scope, state FROM b2b_contact_preferences WHERE channel = \? AND address_hash = \?$/.test(q)) {
        if (!historyTable) { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
        return prefs.filter(function (x) { return x.channel === p[0] && x.address_hash === p[1]; });
      }
      // N5: workflow records
      if (/^SELECT COLUMN_TYPE AS t FROM information_schema\.COLUMNS/.test(q)) return wf.column ? [{ t: wf.column }] : [];
      if (/^SELECT email, mobile, account_type, business_name, shop_name FROM b2b_accounts WHERE id = \?$/.test(q)) return wf.accounts.has(Number(p[0])) ? [wf.accounts.get(Number(p[0]))] : [];
      if (/^INSERT INTO b2b_notifications /.test(q)) { wf.inapp.push(p); return { affectedRows: 1, insertId: wf.inapp.length }; }
      if (/^SELECT setting_key, setting_value FROM b2b_settings$/.test(q)) return [];
      if (/^INSERT IGNORE INTO b2b_sequences/.test(q)) return { affectedRows: 0 };
      if (/^SELECT next_val FROM b2b_sequences WHERE seq_key = \? FOR UPDATE$/.test(q)) return [{ next_val: wf.seq + 1 }];
      if (/^UPDATE b2b_sequences SET next_val = next_val \+ 1/.test(q)) { wf.seq++; return { affectedRows: 1 }; }
      if (/^INSERT INTO b2b_messages /.test(q)) { wf.msgs.push(p); return { affectedRows: 1, insertId: 100 + wf.msgs.length }; }
      if (/^INSERT INTO b2b_message_recipients /.test(q)) { if (p[1] === 'address' && !/'address'/.test(wf.column || '')) { const e = new Error('Data truncated'); e.errno = 1265; throw e; } wf.recips.push(p); return { affectedRows: 1, insertId: 500 + wf.recips.length }; }
      if (/^INSERT INTO b2b_message_sends /.test(q)) { wf.sends.push(p); return { affectedRows: 1, insertId: 900 + wf.sends.length }; }
      if (/^SELECT category FROM b2b_messages WHERE id = \?$/.test(q)) return messages.has(Number(p[0])) ? [{ category: messages.get(Number(p[0])) }] : [];
      if (/^SELECT setting_value FROM b2b_settings WHERE setting_key = \?$/.test(q)) return settings.has(p[0]) ? [{ setting_value: settings.get(p[0]) }] : [];
      if (/^SELECT \* FROM b2b_notification_queue WHERE status = 'sending' AND last_error = \?/.test(q)) return [...rows.values()].filter(function (r) { return r.status === 'sending' && r.last_error === p[0]; }).map(function (r) { return Object.assign({}, r); });
      if (/SET status = 'sent', sent_at/.test(q)) return upd(p[1], 'sending', function (r) { r.status = 'sent'; r.last_error = null; if (p[0]) r.provider_message_id = p[0]; });
      if (/SET status = \?, last_error = \? WHERE id = \? AND status = 'sending'/.test(q)) return upd(p[2], 'sending', function (r) { r.status = p[0]; r.last_error = p[1]; });
      if (/SET status = 'failed', last_error = \? WHERE id = \? AND status = 'sending'/.test(q)) return upd(p[1], 'sending', function (r) { r.status = 'failed'; r.last_error = p[0]; });
      if (/SET status = 'pending', last_error = \?, next_attempt_at/.test(q)) return upd(p[1], 'sending', function (r) { r.status = 'pending'; r.last_error = p[0]; r.due = false; r.backoffMinutes = Number(q.match(/INTERVAL (\d+) MINUTE/)[1]); });
      if (/SET template_params_json = NULL, body = \? WHERE id = \?/.test(q)) return upd(p[1], null, function (r) { r.template_params_json = null; r.body = p[0]; });
      if (/^SELECT id, status, template_name FROM b2b_notification_queue WHERE status = 'failed'/.test(q)) return [...rows.values()].filter(function (r) { return r.status === 'failed'; }).map(pick);
      if (/^SELECT id, status, template_name FROM b2b_notification_queue WHERE id IN/.test(q)) return p.map(function (id) { return rows.get(Number(id)); }).filter(Boolean).map(pick);
      if (/SET status = 'pending', attempts = 0, next_attempt_at = UTC_TIMESTAMP\(\) WHERE id = \? AND status = \?/.test(q)) return upd(p[0], p[1], function (r) { r.status = 'pending'; r.attempts = 0; r.due = true; });
      if (/^INSERT INTO b2b_notification_queue/.test(q)) {
        const cols = q.match(/\(([^)]+)\) VALUES/)[1].split(',').map(function (c) { return c.trim(); });
        const r = {}; cols.forEach(function (c, i) { r[c] = p[i]; }); const row = api.add(r); return { affectedRows: 1, insertId: row.id };
      }
      throw new Error('fake db: unexpected SQL: ' + q);
    },
  };
  return api;
}

let db;
function fresh() {
  db = fakeDb();
  require.cache[require.resolve('../src/db/connection.js')] = { id: 'fake-db', filename: require.resolve('../src/db/connection.js'), loaded: true, exports: db };
  ['../src/modules/b2b/notifications/service.js', '../src/modules/b2b/lib/settings.js', '../src/services/notify.js', '../src/modules/b2b/lib/sms-msg91.js',
    '../src/modules/erp/notifications/consent.js', '../src/modules/erp/notifications/directory.js', '../src/modules/erp/core/audit.js', '../src/modules/erp/core/settings.js'].forEach(function (m) { delete require.cache[require.resolve(m)]; });
  return require('../src/modules/b2b/notifications/service.js');
}
const PROVIDER_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'MSG91_AUTH_KEY', 'MSG91_BASE_URL', 'MSG91_TEMPLATE_ORDER_OTP', 'WHATSAPP_TEMPLATE_ORDER_UPDATE', 'WHATSAPP_TEMPLATE_WHATSAPP_OTP'];
function noProviders() { PROVIDER_ENV.forEach(function (k) { delete process.env[k]; }); }
const statusesOf = function (id) { return db.events.filter(function (e) { return e.queue_id === id; }).map(function (e) { return e.status; }); };

test('no provider configured: email and WhatsApp are "not sent", never "sent"', async () => {
  noProviders(); const svc = fresh();
  const e = db.add({ channel: 'email', recipient: 'r1@trial.local', subject: 'Order approved' });
  const w = db.add({ channel: 'whatsapp', recipient: '9845000011' });
  const s = db.add({ channel: 'sms', recipient: '9845000011', template_name: 'order_update' });
  const out = await svc.processDue(10);
  assert.deepEqual([out.sent, out.failed], [0, 3]);
  for (const r of [e, w, s]) {
    assert.equal(db.rows.get(r.id).status, 'skipped_no_provider', r.channel);
    assert.match(db.rows.get(r.id).last_error, /not (configured|sent)|no SMS gateway|DLT/i);
    assert.deepEqual(statusesOf(r.id), ['sending', 'skipped_no_provider']);
  }
  assert.ok(!db.sql.some(function (q) { return /status = 'sent'/.test(q); }), 'no statement marked anything sent');
});

test('email through a real SMTP conversation: accepted, message id stored, history kept', async (t) => {
  const smtp = await fakeSmtp(); t.after(function () { return smtp.close(); });
  noProviders(); Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false', SMTP_FROM: 'Sake of Health <noreply@trial.local>' });
  const svc = fresh();
  const r = db.add({ channel: 'email', recipient: 'retailer@trial.local', subject: 'Your order shipped', body: '<p>Shipped</p>' });
  const out = await svc.processDue(5);
  assert.equal(out.sent, 1);
  const row = db.rows.get(r.id);
  assert.equal(row.status, 'sent');
  assert.match(row.provider_message_id, /^<.+@.+>$/, 'the mail server message id is kept');
  assert.equal(smtp.mails.length, 1); assert.match(smtp.mails[0].to[0], /retailer@trial\.local/);
  assert.deepEqual(statusesOf(r.id), ['sending', 'accepted']);
  assert.equal(db.events.find(function (x) { return x.status === 'accepted'; }).provider, 'smtp');
});

test('provider failure: retried with the existing back-off, then failed after the last attempt', async (t) => {
  const smtp = await fakeSmtp({ refuse: true }); t.after(function () { return smtp.close(); });
  noProviders(); Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false' });
  const svc = fresh();
  const a = db.add({ channel: 'email', recipient: 'a@trial.local' });
  const b = db.add({ channel: 'email', recipient: 'b@trial.local', attempts: 3 });
  await svc.processDue(5);
  assert.equal(db.rows.get(a.id).status, 'pending'); assert.equal(db.rows.get(a.id).backoffMinutes, 1, 'first retry after 1 minute (unchanged back-off)');
  assert.equal(db.rows.get(b.id).status, 'failed', 'fourth attempt of four is final');
  assert.deepEqual(statusesOf(a.id), ['sending', 'retry_scheduled']);
  assert.deepEqual(statusesOf(b.id), ['sending', 'failed']);
});

test('WhatsApp rows go out as their approved template, with their parameters', async (t) => {
  noProviders(); Object.assign(process.env, { WHATSAPP_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_TEMPLATE_ORDER_UPDATE: 'order_status_v2' });
  const meta = fakeMeta(); t.after(function () { meta.restore(); });
  const svc = fresh();
  const r = db.add({ channel: 'whatsapp', recipient: '9845000011', template_name: 'order_update', template_params_json: JSON.stringify(['Asha', 'SO-0012', 'Shipped']) });
  const otp = db.add({ channel: 'whatsapp', recipient: '9845000012', template_name: 'whatsapp_otp', template_params_json: JSON.stringify(['482913']), body: 'Your code 482913 confirms order' });
  await svc.processDue(5);
  assert.equal(meta.calls.length, 2);
  const c = meta.calls[0].body;
  assert.equal(c.type, 'template'); assert.equal(c.template.name, 'order_status_v2', 'WHATSAPP_TEMPLATE_<NAME> maps to the Meta template');
  assert.deepEqual(c.template.components[0].parameters.map(function (x) { return x.text; }), ['Asha', 'SO-0012', 'Shipped']);
  assert.equal(c.to, '919845000011');
  assert.equal(meta.calls[1].body.template.name, 'whatsapp_otp'); assert.deepEqual(meta.calls[1].body.template.components[0].parameters.map(function (x) { return x.text; }), ['482913']);
  assert.equal(db.rows.get(r.id).status, 'sent');
  assert.equal(db.rows.get(r.id).provider_message_id, null, 'WhatsApp id not available without the approved notify.js change (D2)');
  assert.deepEqual(statusesOf(r.id), ['sending', 'accepted']);
  assert.equal(db.rows.get(otp.id).template_params_json, null, 'one-time code erased after sending');
  assert.doesNotMatch(db.rows.get(otp.id).body, /482913/);
});

test('WhatsApp: a template Meta refuses fails at once (no pointless retries); no number = not sent', async (t) => {
  noProviders(); Object.assign(process.env, { WHATSAPP_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890' });
  const meta = fakeMeta({ answer: function () { return { error: { code: 132001, message: 'Template name does not exist in the translation' } }; } }); t.after(function () { meta.restore(); });
  const svc = fresh();
  const bad = db.add({ channel: 'whatsapp', recipient: '9845000011', template_name: 'missing_template', template_params_json: '[]' });
  const none = db.add({ channel: 'whatsapp', recipient: '' });
  await svc.processDue(5);
  assert.equal(db.rows.get(bad.id).status, 'failed'); assert.equal(db.rows.get(bad.id).attempts, 1);
  assert.match(db.rows.get(bad.id).last_error, /template problem/);
  assert.equal(db.rows.get(none.id).status, 'skipped_no_contact');
  assert.equal(meta.calls.length, 1, 'nothing was sent for the row without a number');
});

test('SMS through MSG91: DLT template, request id kept, code erased; refused SMS retried', async (t) => {
  const gw = await fakeMsg91(); t.after(function () { return gw.close(); });
  noProviders(); Object.assign(process.env, { MSG91_AUTH_KEY: 'k', MSG91_BASE_URL: gw.url, MSG91_TEMPLATE_ORDER_OTP: 'DLT123' });
  const svc = fresh();
  const r = db.add({ channel: 'sms', recipient: '9845000011', template_name: 'order_otp', template_params_json: JSON.stringify({ otp: '551234', order: 'SO-1' }), body: '[order code]' });
  await svc.processDue(5);
  assert.equal(gw.calls.length, 1); assert.equal(gw.calls[0].body.template_id, 'DLT123'); assert.equal(gw.calls[0].body.recipients[0].otp, '551234');
  const row = db.rows.get(r.id);
  assert.equal(row.status, 'sent'); assert.equal(row.provider_message_id, 'REQ1'); assert.equal(row.template_params_json, null);
  assert.deepEqual(statusesOf(r.id), ['sending', 'accepted']);
});

test('status never moves backwards: a row that is no longer "sending" is left alone', async () => {
  noProviders(); const svc = fresh();
  const r = db.add({ channel: 'email', recipient: 'x@trial.local', status: 'sent' });
  await svc.settle(Object.assign({}, r), { ok: false, noProvider: true, reason: 'late answer' });
  await svc.settle(Object.assign({}, r), { ok: false, reason: 'late failure' });
  assert.equal(db.rows.get(r.id).status, 'sent');
  assert.ok(!db.events.some(function (e) { return e.queue_id === r.id && e.status === 'retry_scheduled'; }));
});

test('admin retry: failed and not-sent rows only; sent rows and one-time codes never; each retry recorded', async () => {
  noProviders(); const svc = fresh();
  const f = db.add({ channel: 'email', recipient: 'f@trial.local', status: 'failed', attempts: 4 });
  const sk = db.add({ channel: 'email', recipient: 's@trial.local', status: 'skipped_no_provider' });
  const sent = db.add({ channel: 'email', recipient: 'd@trial.local', status: 'sent' });
  const otp = db.add({ channel: 'sms', recipient: '9845000011', status: 'failed', template_name: 'order_otp' });
  const one = await svc.requeue([f.id, sk.id, sent.id, otp.id], 'Admin (admin@trial.local)');
  assert.deepEqual(one.requeued.sort(), [f.id, sk.id].sort());
  assert.deepEqual(one.refused.map(function (x) { return x.id; }).sort(), [sent.id, otp.id].sort());
  assert.equal(db.rows.get(f.id).attempts, 0); assert.equal(db.rows.get(sent.id).status, 'sent');
  assert.equal(db.events.filter(function (e) { return e.status === 'requeued' && e.source === 'admin' && e.actor === 'Admin (admin@trial.local)'; }).length, 2);
  db.rows.get(f.id).status = 'failed';
  const all = await svc.requeue('all-failed', 'Admin');
  assert.deepEqual(all.requeued, [f.id], 'retry-all kept (D10), one-time code still skipped');
});

test('before migration 016 the history table is missing: sending still works', async (t) => {
  const smtp = await fakeSmtp(); t.after(function () { return smtp.close(); });
  noProviders(); Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false' });
  const svc = fresh(); db.dropHistoryTable();
  const r = db.add({ channel: 'email', recipient: 'old@trial.local' });
  await svc.processDue(5);
  assert.equal(db.rows.get(r.id).status, 'sent');
});

test('enqueue writes the "queued" history row and keeps template name and parameters', async () => {
  noProviders(); const svc = fresh();
  const id = await svc.enqueue(null, { channel: 'whatsapp', recipient: '9845000011', body: 'x', templateName: 'order_update', templateParams: ['A', 'B'] });
  assert.equal(db.rows.get(id).template_name, 'order_update'); assert.equal(db.rows.get(id).template_params_json, '["A","B"]');
  assert.deepEqual(statusesOf(id), ['queued']);
});

test('the outbox writes only notification tables, and never rewrites history', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/modules/b2b/notifications/service.js'), 'utf8');
  const writes = src.match(/(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+(\w+)/g) || [];
  const tables = Array.from(new Set(writes.map(function (w) { return w.split(/\s+/).pop(); })));
  assert.deepEqual(tables.sort(), ['b2b_message_recipients', 'b2b_message_sends', 'b2b_messages', 'b2b_notification_events', 'b2b_notification_queue', 'b2b_notifications'].sort(), 'no order, payment, invoice or stock table is written');
  assert.doesNotMatch(src, /(UPDATE|DELETE FROM)\s+b2b_message(s|_sends|_recipients)\b/, 'workflow records (N5) are only ever inserted by the outbox');
  assert.doesNotMatch(src, /(UPDATE|DELETE FROM)\s+b2b_notification_events/, 'history is insert-only');
  const hooks = fs.readFileSync(path.join(ROOT, 'src/modules/erp/core/webhooks.js'), 'utf8');
  assert.doesNotMatch(hooks, /(UPDATE|DELETE FROM)\s+b2b_notification_events/);
});

/* ── N3: consent and opt-out at the moment of sending; provider throughput ── */
function smtpEnv(port) { noProviders(); Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_SECURE: 'false', SMTP_FROM: 'Sake of Health <noreply@trial.local>' }); }

test('promotional email: sent only with recorded consent; opted-out or unconsented addresses are "not sent: opted out" and never reach the provider', async (t) => {
  const smtp = await fakeSmtp(); t.after(function () { return smtp.close(); });
  smtpEnv(smtp.port);
  const svc = fresh(); const consent = require('../src/modules/erp/notifications/consent.js');
  db.messages.set(70, 'promotional');
  const pref = function (addr, scope, state) { db.prefs.push({ channel: 'email', address_hash: consent.hash('email', addr), scope: scope, state: state }); };
  pref('Yes@Trial.local', 'promotional', 'opted_in');              // case does not matter
  pref('no@trial.local', 'promotional', 'opted_out');
  pref('stop@trial.local', 'promotional', 'opted_in'); pref('stop@trial.local', 'all', 'opted_out');   // a later "stop everything" wins
  const yes = db.add({ channel: 'email', recipient: 'yes@trial.local', message_id: 70, subject: 'Offer', body: '<p>Offer</p>' });
  const none = db.add({ channel: 'email', recipient: 'none@trial.local', message_id: 70 });
  const no = db.add({ channel: 'email', recipient: 'no@trial.local', message_id: 70 });
  const stop = db.add({ channel: 'email', recipient: 'stop@trial.local', message_id: 70 });
  await svc.processDue(10);
  assert.equal(db.rows.get(yes.id).status, 'sent');
  for (const r of [none, no, stop]) {
    assert.equal(db.rows.get(r.id).status, 'skipped_opt_out', r.recipient);
    assert.deepEqual(statusesOf(r.id), ['sending', 'skipped_opt_out']);
  }
  assert.match(db.rows.get(none.id).last_error, /no recorded consent/);
  assert.match(db.rows.get(no.id).last_error, /opted out of promotional/);
  assert.match(db.rows.get(stop.id).last_error, /opted out of all messages/);
  assert.equal(smtp.mails.length, 1, 'only the consented address reached the mail server');
  assert.match(smtp.mails[0].to[0], /yes@trial\.local/);
  // opted-out rows are not offered for retry
  const back = await svc.requeue([no.id], 'admin@trial.local');
  assert.deepEqual(back.requeued, []);
});

test('opt-out of all messages on a channel stops order updates too, but never one-time sign-in codes', async (t) => {
  const smtp = await fakeSmtp(); t.after(function () { return smtp.close(); });
  smtpEnv(smtp.port);
  const svc = fresh(); const consent = require('../src/modules/erp/notifications/consent.js');
  db.prefs.push({ channel: 'email', address_hash: consent.hash('email', 'x@trial.local'), scope: 'all', state: 'opted_out' });
  db.prefs.push({ channel: 'whatsapp', address_hash: consent.hash('whatsapp', '+91 98450 00011'), scope: 'all', state: 'opted_out' });
  const update = db.add({ channel: 'email', recipient: 'x@trial.local', subject: 'Order shipped' });            // workflow message: no message_id
  const unrelated = db.add({ channel: 'email', recipient: 'y@trial.local', subject: 'Order shipped' });
  const otp = db.add({ channel: 'whatsapp', recipient: '9845000011', template_name: 'whatsapp_otp', template_params_json: '["123456"]' });
  await svc.processDue(10);
  assert.equal(db.rows.get(update.id).status, 'skipped_opt_out');
  assert.equal(db.rows.get(unrelated.id).status, 'sent');
  assert.equal(db.rows.get(otp.id).status, 'skipped_no_provider', 'the code was not blocked by the opt-out (it stopped only because no WhatsApp provider is set here)');
  // the same mobile on another channel is a different preference
  assert.notEqual(consent.hash('sms', '9845000011'), consent.hash('whatsapp', '9845000011'));
  assert.equal(consent.hash('whatsapp', '+91 98450 00011'), consent.hash('whatsapp', '09845000011'));
});

test('consent lookup failure: the row is retried later, never sent blind (fail closed)', async (t) => {
  const smtp = await fakeSmtp(); t.after(function () { return smtp.close(); });
  smtpEnv(smtp.port);
  const svc = fresh();
  db.messages.set(71, 'promotional');
  const realQuery = db.query;
  db.query = async function (q, p) { if (/b2b_contact_preferences/.test(q)) { const e = new Error('lock wait timeout'); e.code = 'ER_LOCK_WAIT_TIMEOUT'; throw e; } return realQuery(q, p); };
  const r = db.add({ channel: 'email', recipient: 'yes@trial.local', message_id: 71 });
  await svc.processDue(5);
  db.query = realQuery;
  assert.equal(db.rows.get(r.id).status, 'pending'); assert.equal(db.rows.get(r.id).backoffMinutes, 1);
  assert.equal(smtp.mails.length, 0);
});

test('provider throughput: at most the configured number per channel per minute; the rest wait without using an attempt', async (t) => {
  const smtp = await fakeSmtp(); t.after(function () { return smtp.close(); });
  smtpEnv(smtp.port);
  const svc = fresh();
  db.settings.set('erp.notifications.provider_rates', JSON.stringify({ email: 2, whatsapp: 60, sms: 60 }));
  const ids = [1, 2, 3, 4, 5].map(function (i) { return db.add({ channel: 'email', recipient: 'r' + i + '@trial.local' }).id; });
  await svc.processDue(15);
  const st = function () { return ids.map(function (id) { return db.rows.get(id).status; }); };
  assert.deepEqual(st(), ['sent', 'sent', 'pending', 'pending', 'pending']);
  assert.deepEqual(ids.slice(2).map(function (id) { return db.rows.get(id).attempts; }), [0, 0, 0], 'waiting rows keep all their attempts');
  await svc.processDue(15);
  assert.deepEqual(st(), ['sent', 'sent', 'pending', 'pending', 'pending'], 'still within the same minute: nothing more');
  db.ageEvents();   // a minute later
  await svc.processDue(15);
  assert.deepEqual(st(), ['sent', 'sent', 'sent', 'sent', 'pending']);
  // defaults when the setting is absent or out of range
  db.settings.set('erp.notifications.provider_rates', JSON.stringify({ email: 0, whatsapp: 'x' }));
  assert.deepEqual(await svc.providerRates(), { email: 30, whatsapp: 60, sms: 60 });
  db.settings.delete('erp.notifications.provider_rates');
  assert.deepEqual(await svc.providerRates(), svc.PROVIDER_RATES);
});


/* ── N5: every automatic message is a record in the notification history, written by the same call that queues it ── */
const ACCOUNT = { email: 'ganesh@trial.local', mobile: '9845011111', account_type: 'retailer', business_name: 'Ganesh Stores', shop_name: null };
const RCPT_ENUM = "enum('retailer','distributor','salesman','supplier','manufacturer','staff','address')";

test('automatic account message: one record (origin workflow), its recipient and send #1; the queued rows point at them', async () => {
  noProviders(); const svc = fresh();
  db.wf.column = RCPT_ENUM; db.wf.accounts.set(7, ACCOUNT);
  await svc.notifyAccount(db, 7, { title: 'Order SO/1 dispatched', lines: ['Your order has been dispatched.'], link: '/b2b/orders/1', refType: 'order', refId: 1 });
  assert.equal(db.wf.inapp.length, 1, 'the in-app note is unchanged');
  assert.equal(db.wf.msgs.length, 1);
  const m = db.wf.msgs[0];
  assert.equal(m[1], 'Order SO/1 dispatched'); assert.match(m[2], /Your order has been dispatched/); assert.equal(m[4], 'email,whatsapp'); assert.equal(m[6], 'order'); assert.equal(m[7], '1');
  assert.equal(m[8], 'automatic: order');
  assert.deepEqual(db.wf.recips.map(function (r) { return [r[0], r[1], r[2], r[3]]; }), [[101, 'retailer', 7, 'Ganesh Stores']]);
  assert.equal(db.wf.sends.length, 1); assert.equal(db.wf.sends[0][4], 1, 'one recipient'); assert.equal(db.wf.sends[0][5], 2, 'two rows queued');
  const q = [...db.rows.values()];
  assert.deepEqual(q.map(function (r) { return [r.channel, r.message_id, r.send_id, r.message_recipient_id]; }), [['email', 101, 901, 501], ['whatsapp', 101, 901, 501]]);
  assert.deepEqual(q.map(function (r) { return statusesOf(r.id); }), [['queued'], ['queued']]);
});

test('administrators\' alerts: one record with each alert address as a recipient (migration 018); before 018 they are queued exactly as before', async () => {
  noProviders(); Object.assign(process.env, { ADMIN_EMAIL: 'admin@trial.local', OWNER_EMAIL: 'owner@trial.local' });
  try {
    let svc = fresh(); db.wf.column = RCPT_ENUM;
    await svc.notifyAdmins(db, { title: 'New B2B order SO/2', lines: ['Needs approval'], refType: 'order', refId: 2, event: 'order.placed' });
    assert.equal(db.wf.msgs.length, 1); assert.equal(db.wf.msgs[0][8], 'automatic: order.placed');
    assert.deepEqual(db.wf.recips.map(function (r) { return [r[1], r[2], r[4]]; }), [['address', 1, 'owner@trial.local'], ['address', 2, 'admin@trial.local']]);
    assert.deepEqual([...db.rows.values()].map(function (r) { return [r.recipient, r.message_recipient_id]; }), [['owner@trial.local', 501], ['admin@trial.local', 502]]);
    // 016 applied, 018 not: account messages are recorded, alert emails are not (and nothing half-written)
    svc = fresh(); db.wf.column = "enum('retailer','distributor','salesman','supplier','manufacturer','staff')"; db.wf.accounts.set(7, ACCOUNT);
    await svc.notifyAdmins(db, { title: 'New B2B order SO/3', lines: [] });
    assert.equal(db.wf.msgs.length, 0); assert.equal(db.rows.size, 2); assert.ok([...db.rows.values()].every(function (r) { return r.message_id == null; }));
    await svc.notifyAccount(db, 7, { title: 'Order SO/3 approved', lines: [] });
    assert.equal(db.wf.msgs.length, 1);
  } finally { delete process.env.ADMIN_EMAIL; delete process.env.OWNER_EMAIL; }
});

test('before migration 016: no record, rows queued exactly as before (production today)', async () => {
  noProviders(); const svc = fresh();
  db.wf.column = null; db.wf.accounts.set(7, ACCOUNT);
  await svc.notifyAccount(db, 7, { title: 'Account approved', lines: ['Welcome'] });
  assert.equal(db.wf.msgs.length, 0); assert.equal(db.wf.sends.length, 0);
  assert.deepEqual([...db.rows.values()].map(function (r) { return [r.channel, r.recipient, r.message_id == null]; }), [['email', 'ganesh@trial.local', true], ['whatsapp', '9845011111', true]]);
  assert.ok(!db.sql.some(function (q) { return /b2b_messages|b2b_sequences/.test(q); }), 'no workflow statements were attempted');
});

test('field-sales codes: recorded in the history without the code; the code travels only in the queue row (and is erased after sending)', async () => {
  noProviders(); const svc = fresh(); db.wf.column = RCPT_ENUM;
  await svc.queueCode(db, { channel: 'whatsapp', mobile: '9845011111', orderNo: 'SO/9', challengeId: 33, body: 'Your code 482913 confirms order SO/9', templateName: 'whatsapp_otp', templateParams: ['482913'] });
  assert.equal(db.wf.msgs.length, 1);
  assert.doesNotMatch(JSON.stringify(db.wf.msgs[0]) + JSON.stringify(db.wf.recips) + JSON.stringify(db.wf.sends), /482913/, 'the code is not in the message record');
  assert.equal(db.wf.msgs[0][6], 'otp');
  const row = [...db.rows.values()][0];
  assert.equal(row.ref_type, 'otp'); assert.equal(row.template_name, 'whatsapp_otp'); assert.equal(row.template_params_json, '["482913"]'); assert.equal(row.message_id, 101);
  assert.deepEqual(statusesOf(row.id), ['queued'], 'codes now get the "queued" history row too');
  await svc.processDue(5);
  assert.doesNotMatch(db.rows.get(row.id).body + String(db.rows.get(row.id).template_params_json), /482913/, 'not sent (no provider) → the code is erased');
});
