/**
 * N5 — automatic (workflow) notifications in the notification center. Database-free checks of
 * the real code: one sending service, one trigger per event, codes never resent, automatic
 * messages resendable one by one. The outbox side runs in notifications-reliability.test.js;
 * the full flow on MySQL 8 is in notifications-workflow.mysql.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-n5-'));
const ROOT = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };
const code = function (src) { return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); };
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (d) { const f = path.join(dir, d.name); return d.isDirectory() ? walk(f) : (/\.js$/.test(d.name) ? [f] : []); }); }

test('one sending service: only the outbox writes the queue (codes included); no second notification system', () => {
  const writers = walk(path.join(ROOT, 'src')).filter(function (f) { return /INSERT INTO b2b_notification_queue/.test(code(fs.readFileSync(f, 'utf8'))); }).map(function (f) { return path.relative(ROOT, f); });
  assert.deepEqual(writers, ['src/modules/b2b/notifications/service.js']);
  assert.match(read('src/modules/erp/sales/service.js'), /notifications\.queueCode\(tx, \{ channel: 'sms'/);
  assert.match(read('src/modules/erp/sales/service.js'), /notifications\.queueCode\(tx, \{ channel: 'whatsapp'/);
});

test('payments: told once per payment, from the single place a payment is applied; a repeated gateway confirmation does not reach it', () => {
  const src = code(read('src/modules/b2b/payments/service.js'));
  assert.equal((src.match(/notifyAccount\(/g) || []).length, 1);
  const apply = src.slice(src.indexOf('async function applyToOrder'), src.indexOf('async function recordManual'));
  assert.match(apply, /notifyAccount\(tx, order\.buyer_account_id, \{ event: 'payment\.received'/);
  const confirm = src.slice(src.indexOf('async function gatewayConfirm'), src.indexOf('async function refundOrder'));
  const dup = confirm.indexOf("if (pending.status === 'received') return { duplicate: true"), call = confirm.indexOf('applyToOrder(');
  assert.ok(dup > 0 && call > dup, 'duplicates return before the payment (and its message) is applied');
});

test('events covered without new duplicate triggers: orders, status (dispatch, delivery, invoice line), accounts, returns, recalls, payments, passwords, stock alerts, codes', () => {
  const orders = read('src/modules/b2b/orders/service.js');
  ['dispatched', 'out_for_delivery', 'delivered', 'cancelled', 'refunded'].forEach(function (k) { assert.match(orders, new RegExp('  ' + k + ": \\[")); });
  assert.match(orders, /Invoice ' \+ extra\.invoice\.invoice_no \+ ' is available in your portal/, 'the invoice is announced in the dispatch / delivery message, not by a second trigger');
  assert.match(read('src/modules/b2b/accounts/service.js'), /notifyAccount\(tx, accountId, \{ title: copy\[0\]/, 'account approval / rejection');
  assert.match(read('src/modules/b2b/returns/service.js'), /notifyAccount\(tx, r\.buyer_account_id/);
  assert.match(read('src/modules/erp/returns/service.js'), /PRODUCT RECALL/);
  assert.match(read('src/modules/b2b/routes/portal.js'), /event: 'security\.password_changed', channels: \['email'\]/);
  assert.match(read('src/modules/b2b/accounts/service.js'), /event: 'security\.password_reset', channels: \['email'\]/);
  const erp = read('src/modules/erp/index.js');
  assert.match(erp, /jobs\.enqueue\(null, 'notifications\.stock_alerts', \{\}, \{ dedupeKey: 'notifications\.stock_alerts:' \+ day \}\)/, 'one stock alert a day');
  assert.match(erp, /jobs\.register\('notifications\.stock_alerts'/);
  // security notices never block the password change itself
  assert.match(read('src/modules/b2b/routes/portal.js'), /password_changed[\s\S]{0,400}\.catch\(function \(e\)/);
});

/* The real resend code, with the connection stubbed */
function stub(rows) {
  const db = require('../src/db/connection.js');
  const saved = { query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  const log = [];
  db.queryOne = async function (sql, args) {
    log.push(sql);
    if (/FROM b2b_message_sends WHERE request_key/.test(sql)) return null;
    if (/SELECT \* FROM b2b_messages WHERE id = \?/.test(sql)) return rows.message;
    if (/COUNT\(\*\) AS n FROM b2b_message_sends/.test(sql)) return { n: 0 };
    if (/COALESCE\(MAX\(send_no\), 0\) \+ 1/.test(sql)) return { n: 2 };
    if (/FROM b2b_messages WHERE id = \?/.test(sql)) return { id: rows.message.id, message_no: rows.message.message_no, channels: rows.message.channels, resend_count: 1 };
    if (/FROM b2b_message_sends WHERE message_id = \?/.test(sql)) return { send_no: 2, queued_count: 1, skipped_count: 0 };
    return null;
  };
  db.query = async function (sql, args) { log.push(sql); if (/FROM b2b_message_recipients WHERE message_id/.test(sql)) return rows.recipients; return []; };
  db.transaction = async function (fn) { const tx = { query: async function (sql, args) { log.push([sql, args]); if (/^INSERT INTO b2b_notification_queue/.test(sql)) return { insertId: 77 }; return { insertId: 1, affectedRows: 1 }; }, queryOne: db.queryOne }; return fn(tx); };
  return { log: log, restore: function () { Object.assign(db, saved); } };
}
const svc = require('../src/modules/erp/notifications/service.js');
const KEY = '1b8d6f5e-3c1a-4e2b-9f7d-1a2b3c4d5e6f';

test('codes are never resent from the notification center', async () => {
  const st = stub({ message: { id: 5, message_no: 'MSG/2627/00005', origin: 'workflow', category: 'transactional', ref_type: 'otp', status: 'sent', channels: 'whatsapp' }, recipients: [] });
  try {
    await assert.rejects(svc.resend({ type: 'staff', id: 1, label: 'a' }, { id: 1, permissions: new Set(['notifications.send.staff', 'notifications.send.trade']) }, 5, { requestKey: KEY }),
      function (e) { return e.status === 409 && e.code === 'otp_never_resent'; });
  } finally { st.restore(); }
  assert.match(read('erp-web/admin/modules.js'), /m\.ref_type === 'otp'\) body\.appendChild\(section\('Resend', \[msg\('warn', 'One-time codes are never resent/);
});

test('an automatic message is resent as it first went out: the original email (with its link) to the alert address, needing the staff audience', async () => {
  const message = { id: 6, message_no: 'MSG/2627/00006', origin: 'workflow', category: 'transactional', ref_type: 'order', status: 'sent', channels: 'email',
    subject: 'New B2B order SO/2', body_text: 'New B2B order SO/2\n\nNeeds approval', email_html: '<div>ORIGINAL HTML <a href="https://shop/x">Open</a></div>', whatsapp_template_id: null, sms_template_id: null, template_params_json: null };
  const recipients = [{ id: 61, recipient_type: 'address', recipient_ref: 1, display_name: 'Admin alerts: owner@trial.local', email: 'owner@trial.local', mobile: null }];
  let st = stub({ message: message, recipients: recipients });
  try {
    await assert.rejects(svc.resend({ type: 'staff', id: 1, label: 'a' }, { id: 1, permissions: new Set(['notifications.send.trade']) }, 6, { requestKey: KEY }),
      function (e) { return e.code === 'audience_forbidden'; }, 'alert addresses count as staff');
  } finally { st.restore(); }
  st = stub({ message: message, recipients: recipients });
  try {
    const r = await svc.resend({ type: 'staff', id: 1, label: 'admin@x' }, { id: 1, permissions: new Set(['notifications.send.staff']) }, 6, { requestKey: KEY });
    assert.equal(r.sendNo, 2);
    const q = st.log.find(function (x) { return Array.isArray(x) && /^INSERT INTO b2b_notification_queue/.test(x[0]); });
    assert.ok(q, 'queued');
    assert.ok(q[1].indexOf('owner@trial.local') !== -1, 'to the stored alert address');
    assert.ok(q[1].some(function (v) { return /ORIGINAL HTML/.test(String(v)); }), 'the original email, not a re-rendered one');
  } finally { st.restore(); }
});
