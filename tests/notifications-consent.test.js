/**
 * N3 — consent, opt-out, promotional rules, approval hold, groups, WhatsApp STOP, unsubscribe
 * links. Database-free checks of the real code (pure functions, and the approvals engine with a
 * recording stand-in for the transaction). The worker-side gate and provider throughput run in
 * tests/notifications-reliability.test.js; the full flows on MySQL 8 are in
 * tests/notifications-consent.mysql.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-n3-'));
process.env.ERP_JWT_SECRET = 'n3-test-secret-0123456789abcdefghijklmnop';
process.env.ERP_MFA_REQUIRED = 'true';   // these checks expect two-step sign-in switched on
const ROOT = path.join(__dirname, '..');
const read = function (f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); };
const consent = require('../src/modules/erp/notifications/consent.js');
const svc = require('../src/modules/erp/notifications/service.js');
const groups = require('../src/modules/erp/notifications/groups.js');
const approvals = require('../src/modules/erp/core/approvals.js');
const webhooks = require('../src/modules/erp/core/webhooks.js');
const P = function (perms) { return { id: 5, permissions: new Set(perms), mfa: true }; };

test('consent decision: offers need a recorded opt-in; any opt-out wins; "stop all" stops everything except one-time codes', () => {
  const d = consent.decide;
  assert.equal(d('promotional', { promotional: null, all: null }, false), 'no recorded consent for promotional messages');
  assert.equal(d('promotional', { promotional: 'opted_in', all: null }, false), null);
  assert.equal(d('promotional', { promotional: 'opted_out', all: null }, false), 'opted out of promotional messages');
  assert.equal(d('promotional', { promotional: 'opted_in', all: 'opted_out' }, false), 'opted out of all messages on this channel');
  assert.equal(d('promotional', { promotional: 'opted_in', all: 'opted_in' }, false), null, 'START after STOP resumes');
  assert.equal(d('transactional', { promotional: null, all: null }, false), null, 'order messages need no opt-in');
  assert.equal(d('transactional', { promotional: 'opted_out', all: null }, false), null, 'saying no to offers does not stop order messages');
  assert.equal(d('service', { promotional: null, all: 'opted_out' }, false), 'opted out of all messages on this channel');
  assert.equal(d('transactional', { promotional: null, all: 'opted_out' }, true), null, 'a sign-in code the person asked for still goes');
});

test('addresses: matched however they are written; stored only as a hash; channels kept apart', () => {
  assert.equal(consent.normalize('email', '  Ravi@Shop.IN '), 'ravi@shop.in');
  assert.equal(consent.normalize('email', 'not an email'), null);
  assert.equal(consent.normalize('whatsapp', '+91 98450-00011'), '919845000011');
  assert.equal(consent.normalize('whatsapp', '09845000011'), '919845000011');
  assert.equal(consent.normalize('sms', '12345'), null);
  const h = consent.hash('email', 'ravi@shop.in');
  assert.match(h, /^[0-9a-f]{64}$/); assert.equal(h, consent.hash('email', 'RAVI@shop.in'));
  assert.notEqual(consent.hash('whatsapp', '9845000011'), consent.hash('sms', '9845000011'));
  assert.equal(consent.hash('email', ''), null);
  assert.doesNotMatch(read('src/db/migrations/sql/016_notification_center.sql').match(/CREATE TABLE IF NOT EXISTS b2b_contact_preferences[\s\S]*?;/)[0], /\b(email|mobile|address)\s+VARCHAR/, 'no address column in clear');
});

test('unsubscribe links: signed; a changed or foreign link is refused; the link holds no address', () => {
  const t = consent.unsubscribeToken('email', 'ravi@shop.in');
  const o = consent.readToken(t);
  assert.deepEqual(o, { c: 'email', h: consent.hash('email', 'ravi@shop.in'), s: 'promotional' });
  assert.doesNotMatch(Buffer.from(t.split('.')[0], 'base64url').toString(), /ravi|shop/);
  const parts = t.split('.');
  const other = Buffer.from(JSON.stringify({ c: 'email', h: consent.hash('email', 'someone@else.in'), s: 'promotional' })).toString('base64url');
  assert.equal(consent.readToken(other + '.' + parts[1]), null, 'a signature does not carry over to another address');
  assert.equal(consent.readToken(parts[0] + '.' + parts[1].slice(0, -2) + 'AA'), null);
  assert.equal(consent.readToken('garbage'), null);
  const saved = process.env.ERP_JWT_SECRET; process.env.ERP_JWT_SECRET = 'a-different-secret-0123456789abcdefghij';
  try { assert.equal(consent.readToken(t), null, 'signed with another secret'); } finally { process.env.ERP_JWT_SECRET = saved; }
  // the footer the email carries
  process.env.PUBLIC_SITE_URL = 'https://shop.example/';
  try {
    const f = svc.unsubscribeFooter('ravi@shop.in');
    assert.match(f, /href="https:\/\/shop\.example\/api\/erp\/public\/unsubscribe\?t=[A-Za-z0-9_\-.%]+"/);
    assert.match(f, /Order and account messages are not affected/);
  } finally { delete process.env.PUBLIC_SITE_URL; }
});

test('promotional rules (D4/D8): permission, business accounts only, no SMS, unsubscribe link must be possible', () => {
  const ok = P(['notifications.send.trade', 'notifications.send.promotional']);
  const code = function (fn) { try { fn(); return null; } catch (e) { return e.code; } };
  assert.equal(code(function () { svc.promoRules(ok, 'transactional', ['supplier'], ['sms']); }), null, 'the rules apply to promotions only');
  assert.equal(code(function () { svc.promoRules(P(['notifications.send.trade']), 'promotional', ['retailer'], ['whatsapp']); }), 'promotional_forbidden');
  assert.equal(code(function () { svc.promoRules(ok, 'promotional', ['retailer', 'supplier'], ['whatsapp']); }), 'promotional_business_only');
  assert.equal(code(function () { svc.promoRules(ok, 'promotional', ['staff'], ['whatsapp']); }), 'promotional_business_only');
  assert.equal(code(function () { svc.promoRules(ok, 'promotional', ['retailer'], ['whatsapp', 'sms']); }), 'promotional_no_sms');
  delete process.env.PUBLIC_SITE_URL; delete process.env.SITE_URL;
  assert.equal(code(function () { svc.promoRules(ok, 'promotional', ['distributor'], ['email']); }), 'unsubscribe_unavailable', 'no site address → no unsubscribe link → no promotional email');
  process.env.PUBLIC_SITE_URL = 'https://shop.example';
  try { assert.equal(code(function () { svc.promoRules(ok, 'promotional', ['retailer', 'distributor'], ['email', 'whatsapp']); }), null); } finally { delete process.env.PUBLIC_SITE_URL; }
  assert.deepEqual(svc.PROMO_TYPES, ['retailer', 'distributor']);
});

test('approval threshold (D5): more than the limit waits for a second person; the limit itself does not', () => {
  const lim = { promo_approval_over: 100 };
  assert.equal(svc.needsApproval('promotional', 100, lim), false);
  assert.equal(svc.needsApproval('promotional', 101, lim), true);
  assert.equal(svc.needsApproval('transactional', 5000, lim), false);
  assert.equal(svc.needsApproval('promotional', 1, { promo_approval_over: 0 }), true, 'a recorded decision of 0 sends every promotion for approval');
});

/* A recording stand-in for a transaction: enough for approvals.request/decide/withdraw and the audit chain. */
function fakeTx(request) {
  const log = [];
  return {
    log: log,
    query: async function (sql, args) { log.push([sql, args]); if (/^INSERT INTO b2b_approval_requests/.test(sql)) return { insertId: 41, affectedRows: 1 }; if (/^SELECT approver_id FROM b2b_approval_steps/.test(sql)) return []; return { affectedRows: 1, insertId: 1 }; },
    queryOne: async function (sql, args) { log.push([sql, args]); if (/FROM b2b_approval_rules/.test(sql)) return null; if (/FROM b2b_approval_requests WHERE id = \? FOR UPDATE/.test(sql)) return request; if (/FROM b2b_message_sends WHERE id = \? FOR UPDATE/.test(sql)) return { id: 9, message_id: 3, send_no: 1 }; return null; },
  };
}

test('approvals: a promotion names its approver permission while no rule is configured; maker cannot check; rejection and withdrawal reach the module', async () => {
  const tx = fakeTx(null);
  const r = await approvals.request(tx, { type: 'staff', id: 5, label: 'maker@x' }, { type: 'notifications.promotional', entity: 'message_send', entityId: 9, reason: 'Diwali offer to all retailers', defaultPermission: 'notifications.promotional.approve', payload: { recipients: 140 } });
  assert.equal(r.approverPermission, 'notifications.promotional.approve'); assert.equal(r.ruleConfigured, false);
  const ins = tx.log.find(function (x) { return /^INSERT INTO b2b_approval_requests/.test(x[0]); });
  assert.equal(JSON.parse(ins[1][6]).approverPermission, 'notifications.promotional.approve');
  // types without a default keep the Super Admin fail-safe
  approvals.register('test.nodefault', async function () { return null; });
  const r2 = await approvals.request(fakeTx(null), { type: 'staff', id: 5 }, { type: 'test.nodefault', entity: 'x', entityId: 1, reason: 'because' });
  assert.equal(r2.approverPermission, approvals.FALLBACK_PERMISSION);
  // decide: maker refused; non-approver refused; approver without two-factor refused
  const pending = { id: 41, approval_type: 'notifications.promotional', entity: 'message_send', entity_id: '9', status: 'pending', steps_required: 1, steps_done: 0, requested_by: 5,
    payload_json: JSON.stringify({ data: { recipientIds: [1] }, approverPermission: 'notifications.promotional.approve' }) };
  const codeOf = async function (p) { try { await approvals.decide(fakeTx(Object.assign({}, pending)), p, { type: 'staff', id: p.id, label: 'x' }, 41, 'rejected', 'no'); return null; } catch (e) { return e.code; } };
  assert.equal(await codeOf(P(['notifications.promotional.approve'])), 'maker_cannot_check');
  assert.equal(await codeOf({ id: 6, permissions: new Set(['notifications.send.promotional']), mfa: true }), 'not_approver');
  assert.equal(await codeOf({ id: 6, permissions: new Set(['notifications.promotional.approve']), mfa: false }), 'mfa_required');
  // a rejection by a real approver runs the module's close hook in the same transaction
  const tx2 = fakeTx(Object.assign({}, pending));
  const out = await approvals.decide(tx2, { id: 6, permissions: new Set(['notifications.promotional.approve']), mfa: true }, { type: 'staff', id: 6, label: 'checker@x' }, 41, 'rejected', 'Not this week');
  assert.equal(out.status, 'rejected');
  assert.ok(tx2.log.some(function (x) { return /UPDATE b2b_messages SET status = 'rejected' WHERE id = \? AND status = 'awaiting_approval'/.test(x[0]); }), 'the held message is closed as not approved');
  assert.ok(!tx2.log.some(function (x) { return /INSERT INTO b2b_notification_queue/.test(x[0]); }), 'nothing queued');
  // withdrawal by the maker closes it too
  const tx3 = fakeTx(Object.assign({}, pending));
  await approvals.withdraw(tx3, { id: 5, permissions: new Set() }, { type: 'staff', id: 5, label: 'maker@x' }, 41);
  assert.ok(tx3.log.some(function (x) { return /UPDATE b2b_messages SET status = 'rejected'/.test(x[0]); }));
});

test('WhatsApp replies: STOP and START change preferences; other text is ignored; replays are refused by message id', () => {
  const payload = { entry: [{ changes: [{ value: { messages: [
    { id: 'wamid.1', from: '919845000011', type: 'text', text: { body: ' stop. ' } },
    { id: 'wamid.2', from: '919845000012', type: 'text', text: { body: 'Please stop sending me the bill' } },
    { id: 'wamid.3', from: '919845000013', type: 'button', button: { text: 'Unsubscribe' } },
    { id: 'wamid.4', from: '919845000014', type: 'interactive', interactive: { button_reply: { title: 'START' } } },
    { id: 'wamid.5', from: '919845000015', type: 'image' },
  ] } }] }] };
  assert.deepEqual(webhooks.inbound(payload), [{ id: 'wamid.1', from: '919845000011', word: 'stop' }, { id: 'wamid.3', from: '919845000013', word: 'stop' }, { id: 'wamid.4', from: '919845000014', word: 'start' }]);
  assert.deepEqual(webhooks.inbound({}), []);
  const src = read('src/modules/erp/core/webhooks.js');
  assert.match(src, /'in:' \+ m\.id/, 'each reply is processed once (replay table)');
  assert.match(src, /scope: 'all', state: m\.word === 'stop' \? 'opted_out' : 'opted_in', source: 'whatsapp_reply'/);
});

test('groups: rules and lists are validated; geography only for business accounts', () => {
  const code = function (fn) { try { fn(); return null; } catch (e) { return e.code || e.message; } };
  assert.deepEqual(groups.readRule({ type: 'retailer', stateId: '29' }), { type: 'retailer', stateId: 29 });
  assert.equal(code(function () { groups.readRule({ type: 'customer' }); }), 'rule_type', 'no shop customers (D1)');
  assert.match(code(function () { groups.readRule({ type: 'supplier', stateId: 1 }); }), /Only retailers and distributors/);
  assert.deepEqual(groups.readMembers([{ type: 'retailer', ref: 3 }, { type: 'retailer', ref: '3' }, { type: 'staff', ref: 2 }]), [{ type: 'retailer', ref: 3 }, { type: 'staff', ref: 2 }]);
  assert.equal(code(function () { groups.readMembers([]); }), 'no_members');
});

test('one gate: the worker asks consent for every row, so resends, approved sends and automatic messages obey it too', () => {
  const outbox = read('src/modules/b2b/notifications/service.js');
  assert.match(outbox, /const block = await consent\(\)\.blockReason\(row\);\s*result = block \? \{ ok: false, optOut: true/);
  assert.match(outbox, /result\.optOut \? 'skipped_opt_out'/);
  assert.doesNotMatch(outbox.match(/const RETRYABLE = \[[^\]]*\]/)[0], /skipped_opt_out/, 'an opted-out row is never offered for retry');
  const svcSrc = read('src/modules/erp/notifications/service.js');
  assert.doesNotMatch(svcSrc, /promotional_not_here/, 'the N2 stop-gap is gone: promotions now go through consent');
  assert.match(svcSrc, /approvals\.register\('notifications\.promotional'/);
});

test('screens: Consent & groups tab works (no placeholder); the business portal lets an account turn offers on and off', () => {
  const ui = read('erp-web/admin/modules.js');
  assert.doesNotMatch(ui, /Consent management arrives with the promotional flow/);
  assert.match(ui, /'\/notifications\/consent'/); assert.match(ui, /'\/notifications\/groups'/); assert.match(ui, /'\/notifications\/preview'/);
  assert.match(ui, /Promotions waiting for approval/);
  const portal = read('b2b-web/portal/app.js');
  assert.match(portal, /\/me\/communication/); assert.match(portal, /Offers and promotions/);
  const routes = read('src/modules/b2b/routes/portal.js');
  assert.match(routes, /router\.put\('\/me\/communication', writeLimit/);
  assert.match(routes, /source: 'portal'/);
});

test('public unsubscribe page: opening the link changes nothing; only the button records the opt-out', () => {
  const src = read('src/modules/erp/routes/public-notifications.js');
  const get = src.slice(src.indexOf("r.get('/unsubscribe'"), src.indexOf("r.post('/unsubscribe'"));
  assert.doesNotMatch(get, /consent\.unsubscribe\(/);
  assert.match(src, /r\.post\('\/unsubscribe'[\s\S]*consent\.unsubscribe\(/);
  assert.match(read('src/modules/erp/index.js'), /api\.use\('\/public', require\('\.\/routes\/public-notifications\.js'\)\)/);
});
