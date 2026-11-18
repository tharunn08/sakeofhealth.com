/**
 * N2 — notification center, database-free checks of the real code. The behaviour on
 * MySQL 8 (send, resend, double-click, changed contacts, permissions, rate limit,
 * audit) is in tests/notifications-center.mysql.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-n2-'));
const ROOT = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };
const directory = require('../src/modules/erp/notifications/directory.js');
const svc = require('../src/modules/erp/notifications/service.js');
const templates = require('../src/modules/erp/notifications/templates.js');

test('recipients: business types and ERP staff only — no shop customers (D1), no staff.json (D9)', () => {
  assert.deepEqual(directory.TYPES, ['retailer', 'distributor', 'salesman', 'supplier', 'manufacturer', 'staff']);
  const code = function (f) { return read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); };   // the code, not its comments
  const src = code('src/modules/erp/notifications/directory.js') + code('src/modules/erp/notifications/service.js');
  assert.doesNotMatch(src, /customers\.json|staff\.json|services\/db\.js|DATA_DIR/);
});

test('contacts are masked unless the person may see them', () => {
  assert.equal(directory.maskEmail('retailer@trial.local'), 'r•••@trial.local');
  assert.equal(directory.maskMobile('9845000011'), '98•••••011');
  assert.equal(directory.maskMobile(''), null);
  const src = read('src/modules/erp/notifications/service.js');
  assert.match(src, /see \? r\.email : directory\.maskEmail\(r\.email\)/);
  assert.match(src, /function canSee\(principal\) \{ return principal\.permissions\.has\('notifications\.contacts\.view'\)/);
});

test('who may send to whom: one permission per audience', () => {
  const p = function (perms) { return { permissions: new Set(perms) }; };
  assert.equal(svc.canSendTo(p(['notifications.send.trade']), 'retailer'), true);
  assert.equal(svc.canSendTo(p(['notifications.send.trade']), 'distributor'), true);
  assert.equal(svc.canSendTo(p(['notifications.send.trade']), 'supplier'), false);
  assert.equal(svc.canSendTo(p(['notifications.send.vendors']), 'manufacturer'), true);
  assert.equal(svc.canSendTo(p(['notifications.send.salesmen']), 'staff'), false);
  const ref = require('../src/modules/erp/catalog/reference-data.json');
  const grants = function (role) { return ref.roles.find(function (r) { return r.code === role; }).permissions.filter(function (x) { return /^notifications\./.test(x); }).sort(); };
  assert.equal(grants('super_admin').length, 10);
  const identity = require('../src/modules/erp/core/identity.js');
  assert.equal(identity.needsMfa('notifications.promotional.approve'), true, 'approving promotional sends needs two-factor sign-in');
  assert.equal(identity.needsMfa('notifications.send.promotional'), false);
  const approvers = ref.roles.filter(function (r) { return r.permissions.indexOf('notifications.promotional.approve') >= 0; }).map(function (r) { return r.code; }).sort();
  assert.deepEqual(approvers, ['business_admin', 'super_admin']);
  assert.deepEqual(grants('procurement_manager'), ['notifications.send.vendors', 'notifications.view']);
  assert.deepEqual(grants('auditor'), ['notifications.view'], 'auditors can look, not send');
  for (const role of ['salesman', 'warehouse_manager', 'quality_control', 'inventory_executive']) assert.deepEqual(grants(role), [], role + ' gets nothing');
});

test('limits: the owner\'s D5 values apply until a recorded decision changes them', () => {
  assert.deepEqual(svc.D5, { max_recipients: 500, max_sends_per_hour: 20, promo_approval_over: 100 });
  const cat = require('../src/modules/erp/core/settings-catalog.json').settings.find(function (s) { return s.key === 'notifications.limits'; });
  assert.deepEqual(cat.proposal, svc.D5);
  const src = read('src/modules/erp/notifications/service.js');
  assert.match(src, /too_many_recipients/); assert.match(src, /send_limit/);
});

test('resend rules are in the code: new send each time, original kept, only original recipients, changed contacts confirmed, one key = one send', () => {
  const src = read('src/modules/erp/notifications/service.js');
  assert.match(src, /INSERT INTO b2b_message_sends/);
  assert.doesNotMatch(src, /UPDATE b2b_message_sends SET (?!queued_count)/, 'a send row is never rewritten (only its queued count, in the same transaction)');
  assert.doesNotMatch(src, /DELETE FROM/);
  assert.doesNotMatch(src, /UPDATE b2b_messages SET (subject|body_text|email_html)/, 'the original message text is never changed');
  assert.match(src, /not_original_recipient/); assert.match(src, /contact_changed/); assert.match(src, /confirmChanged !== true/);
  assert.match(src, /SELECT message_id(, send_no)? FROM b2b_message_sends WHERE request_key = \?/);
  assert.match(src, /UNIQUE|request_key/);
  assert.match(read('src/db/migrations/sql/016_notification_center.sql'), /UNIQUE KEY uq_b2b_ms_key \(request_key\)/, 'the database itself refuses a second send with one key');
});

test('Resend is always offered; the screen never disables it because of an earlier success', () => {
  const ui = read('erp-web/admin/modules.js');
  const block = ui.slice(ui.indexOf('// Resend: always available'), ui.indexOf("body.appendChild(section('Sends'"));
  assert.match(block, /var rb = btn\('Resend now'/);
  assert.doesNotMatch(block, /delivered|status === 'sent'|accepted/, 'no status decides whether Resend appears');
  assert.match(block, /rkey = uuid\(\)/, 'one key per opened resend panel');
  assert.match(block, /rb\.disabled = true/, 'disabled only while a request runs');
  const compose = ui.slice(ui.indexOf('function compose()'), ui.indexOf('function history()'));
  assert.match(compose, /key = uuid\(\); sendBtn\.disabled/, 'a new key only when the admin previews again');
  assert.match(compose, /b\.requestKey = key/);
});

test('templates: approved provider templates only; SMS DLT ids travel as dlt:<id>', () => {
  assert.equal(templates.outboxName({ channel: 'whatsapp', name: 'order_update', provider_template: 'order_status_v2' }), 'order_status_v2');
  assert.equal(templates.outboxName({ channel: 'sms', name: 'order_update', provider_template: '1107161234567890' }), 'dlt:1107161234567890');
  assert.equal(templates.outboxName({ channel: 'sms', name: 'order_otp', provider_template: null }), 'order_otp');
  const sms = require('../src/modules/b2b/lib/sms-msg91.js');
  assert.equal(sms.templateId('dlt:1107161234567890'), '1107161234567890');
  assert.equal(sms.templateId('dlt:x'), '', 'too short to be an id');
  assert.match(read('src/modules/erp/notifications/service.js'), /template_not_approved/);
});

test('isolation: the notification center writes only notification tables', () => {
  const files = ['src/modules/erp/notifications/service.js', 'src/modules/erp/notifications/templates.js', 'src/modules/erp/notifications/directory.js', 'src/modules/erp/routes/notifications.js',
    'src/modules/erp/notifications/consent.js', 'src/modules/erp/notifications/groups.js', 'src/modules/erp/routes/public-notifications.js'];
  const tables = new Set();
  files.forEach(function (f) { (read(f).match(/(INSERT INTO|UPDATE|DELETE FROM|REPLACE INTO)\s+(\w+)/g) || []).forEach(function (w) { tables.add(w.split(/\s+/).pop()); }); });
  assert.deepEqual(Array.from(tables).sort(), ['b2b_contact_preferences', 'b2b_message_recipients', 'b2b_message_sends', 'b2b_message_templates', 'b2b_messages', 'b2b_recipient_group_members', 'b2b_recipient_groups']);
  // the only DELETE is replacing a fixed group's member list; no message, send or preference is ever deleted
  files.forEach(function (f) { (read(f).match(/DELETE FROM\s+\w+/g) || []).forEach(function (d) { assert.equal(d, 'DELETE FROM b2b_recipient_group_members', f); }); });
});

test('routes: every notification route checks a permission; the page sits in /admin', () => {
  const r = read('src/modules/erp/routes/notifications.js');
  const routes = r.match(/r\.(get|post|put|delete)\('[^']+', [^,]+/g);
  assert.ok(routes.length >= 10);
  routes.forEach(function (x) { assert.match(x, /, (can\('notifications\.[a-z.]+'\)|anySend)$/, x); });
  assert.match(r, /r\.use\(identity\.requireStaff\)/);
  assert.match(read('src/modules/erp/index.js'), /api\.use\('\/notifications', require\('\.\/routes\/notifications\.js'\)\)/);
  const reg = require('../src/platform/registry.js');
  const page = reg.available(true, true).find(function (p) { return p.id === 'erp-notifications'; });
  assert.equal(page.path, '/admin/administration/notifications'); assert.equal(page.perm, 'notifications.view');
});

/* The real send/resend code, with the database connection stubbed: what a repeated or racing key returns. */
test('one key = one send: a repeat reports the send that key made, a race returns the first result, a key cannot be reused for another message', async () => {
  const db = require('../src/db/connection.js');
  const saved = { query: db.query, queryOne: db.queryOne, transaction: db.transaction };
  const K = '0b8d6f5e-3c1a-4e2b-9f7d-1a2b3c4d5e6f';
  const p = { permissions: new Set(['notifications.send.trade']) };
  const actor = { type: 'staff', id: 1, label: 'tester' };
  let keyRow = null, txError = null, txCalls = 0;
  db.queryOne = async function (sql, args) {
    if (/FROM b2b_message_sends WHERE request_key/.test(sql)) return keyRow;
    if (/FROM b2b_messages WHERE id/.test(sql)) return { id: args[0], message_no: 'MSG/2627/0000' + args[0], channels: 'email', resend_count: 2 };
    if (/AND send_no = \?/.test(sql)) return { send_no: args[1], queued_count: 1, skipped_count: 0 };
    if (/ORDER BY send_no DESC/.test(sql)) return { send_no: 3, queued_count: 1, skipped_count: 0 };
    return null;   // settings: unset → D5 defaults
  };
  db.query = async function () { return [{ id: 5, name: 'R', email: 'r@x.in', mobile: '9800000011', active: 1 }]; };
  db.transaction = async function () { txCalls++; if (keyRow === null && txError) { const e = txError; keyRow = { message_id: 7, send_no: 1 }; throw e; } throw new Error('unexpected transaction'); };
  const body = { requestKey: K, category: 'transactional', channels: ['email'], subject: 'Price update', body: 'New prices apply.', recipients: [{ type: 'retailer', ref: 5 }] };
  try {
    // 1. the key's own send (#1) is reported even though the message has since been resent (#3)
    keyRow = { message_id: 7, send_no: 1 };
    const again = await svc.send(actor, p, body);
    assert.equal(again.duplicate, true); assert.equal(again.messageId, 7); assert.equal(again.sendNo, 1);
    assert.equal(txCalls, 0, 'nothing written for a repeat');
    // 2. two presses raced past the check: the unique key stops the second, which answers with the first's result
    keyRow = null; txError = Object.assign(new Error("Duplicate entry '" + K + "' for key 'b2b_message_sends.uq_b2b_ms_key'"), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry '" + K + "' for key 'b2b_message_sends.uq_b2b_ms_key'" });
    const raced = await svc.send(actor, p, body);
    assert.equal(raced.duplicate, true); assert.equal(raced.messageId, 7); assert.equal(raced.sendNo, 1);
    // 3. any other duplicate error is not mistaken for a repeat
    keyRow = null; txError = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry for key 'uq_b2b_mr_one'" });
    db.transaction = async function () { throw txError; };
    await assert.rejects(svc.send(actor, p, body), function (e) { return e.code === 'ER_DUP_ENTRY'; });
    // 4. a key already used for message 7 cannot resend message 8
    keyRow = { message_id: 7, send_no: 2 };
    await assert.rejects(svc.resend(actor, p, 8, { requestKey: K }), function (e) { return e.status === 409 && e.code === 'request_key_reused'; });
    const same = await svc.resend(actor, p, 7, { requestKey: K });
    assert.equal(same.duplicate, true); assert.equal(same.sendNo, 2);
  } finally { Object.assign(db, saved); }
});

test('changed contact (D3): full old and new for people who may see contacts; masked otherwise, but a change is never hidden by the mask', () => {
  const r = { id: 4, display_name: 'Ganesh Stores' };
  const was = { email: 'g@shop.in', mobile: '9845000011' }, is = { email: 'g@shop.in', mobile: '9845123011' };   // middle digits only
  const full = svc.contactChange(r, was, is, true);
  assert.deepEqual(full, { recipientId: 4, name: 'Ganesh Stores', old: { email: 'g@shop.in', mobile: '9845000011' }, new: { email: 'g@shop.in', mobile: '9845123011' } });
  const masked = svc.contactChange(r, was, is, false);
  assert.equal(masked.old.mobile, '98•••••011');
  assert.equal(masked.new.mobile, '98•••••011 (changed)', 'the two sides must not look identical');
  assert.equal(masked.new.email, 'g•••@shop.in', 'an unchanged field is not marked');
  const added = svc.contactChange(r, { email: null, mobile: null }, { email: 'n@x.in', mobile: null }, false);
  assert.equal(added.old.email, null); assert.equal(added.new.email, 'n•••@x.in');
});
