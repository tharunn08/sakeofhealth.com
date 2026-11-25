/**
 * ERP foundation — unit tests (no database). Run: node --test tests/erp-unit.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

process.env.ERP_JWT_SECRET = 'unit-test-erp-secret-0123456789abcdef';
const security = require('../src/modules/erp/core/security.js');
const audit = require('../src/modules/erp/core/audit.js');
const approvals = require('../src/modules/erp/core/approvals.js');
const settings = require('../src/modules/erp/core/settings.js');
const webhooks = require('../src/modules/erp/core/webhooks.js');
const identity = require('../src/modules/erp/core/identity.js');
const config = require('../src/modules/erp/config.js');
const ref = require('../src/modules/erp/catalog/reference-data.json');
const ROOT = path.join(__dirname, '..');

test('ERP is inert unless B2B_ENABLED and ERP_ENABLED are both true', () => {
  const save = [process.env.B2B_ENABLED, process.env.ERP_ENABLED];
  try {
    process.env.B2B_ENABLED = 'true'; process.env.ERP_ENABLED = 'false'; assert.equal(config.enabled(), false);
    process.env.B2B_ENABLED = 'false'; process.env.ERP_ENABLED = 'true'; assert.equal(config.enabled(), false);
    process.env.B2B_ENABLED = 'true'; process.env.ERP_ENABLED = 'true'; assert.equal(config.enabled(), true);
  } finally { process.env.B2B_ENABLED = save[0]; process.env.ERP_ENABLED = save[1]; }
});

test('passwords: scrypt, 12+ characters, wrong password fails', () => {
  assert.throws(() => security.hashPassword('short'), /12 characters/);
  const h = security.hashPassword('correct horse battery');
  assert.match(h, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(security.verifyPassword('correct horse battery', h), true);
  assert.equal(security.verifyPassword('correct horse batterx', h), false);
  assert.equal(security.verifyPassword('x', 'garbage'), false);
});

test('tokens: signed, audience-bound, expire, tamper-proof', () => {
  const now = Date.now();
  const t = security.sign({ sid: 7, tv: 3 }, now);
  assert.equal(security.verify(t, now).sid, 7);
  assert.equal(security.verify(t, now + 25 * 3600 * 1000), null, 'expired');
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(body, 'base64url')), { sid: 1 }))).toString('base64url') + '.' + sig;
  assert.equal(security.verify(forged, now), null, 'edited payload');
  const other = Buffer.from(JSON.stringify({ sid: 7, tv: 3, aud: 'b2b', exp: now + 1e6 })).toString('base64url');
  const sig2 = crypto.createHmac('sha256', process.env.ERP_JWT_SECRET).update(other).digest('base64url');
  assert.equal(security.verify(other + '.' + sig2, now), null, 'another audience');
});

test('TOTP matches the RFC 6238 reference vectors and tolerates one step of drift only', () => {
  const secret = security.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(security.totpAt(secret, Math.floor(59 / 30)), '287082');            // RFC 6238 T=59 → 94287082
  assert.equal(security.totpAt(secret, Math.floor(1111111109 / 30)), '081804');    // → 07081804
  assert.equal(security.totpAt(secret, Math.floor(2000000000 / 30)), '279037');    // → 69279037
  const now = 1793900000000, code = security.totpAt(secret, Math.floor(now / 30000));
  assert.equal(security.verifyTotp(secret, code, now), true);
  assert.equal(security.verifyTotp(secret, code, now + 30000), true);
  assert.equal(security.verifyTotp(secret, code, now + 90000), false);
  assert.equal(security.verifyTotp(secret, 'abcdef', now), false);
});

test('MFA secrets are encrypted at rest and tamper-evident', () => {
  const blob = security.encrypt('JBSWY3DPEHPK3PXP');
  assert.doesNotMatch(blob, /JBSWY3DPEHPK3PXP/);
  assert.equal(security.decrypt(blob), 'JBSWY3DPEHPK3PXP');
  const p = blob.split(':'); p[3] = Buffer.from('tampered').toString('base64');
  assert.equal(security.decrypt(p.join(':')), null);
});

test('audit hash: deterministic, and any field change or reordering changes it', () => {
  const row = { prev_hash: 'a'.repeat(64), actor_type: 'admin', actor_id: '3', actor_role: 'super_admin', module: 'core', action: 'role.granted',
    entity: 'staff', entity_id: '9', old_value: null, new_value: '{"role":"auditor"}', reason: 'new auditor', approval_id: 12, created_at: '2026-11-06 10:00:00' };
  const h1 = audit.hashRow(row);
  assert.equal(audit.hashRow(Object.assign({}, row)), h1);
  for (const k of Object.keys(row)) {
    const changed = Object.assign({}, row, { [k]: k === 'approval_id' ? 13 : String(row[k] || '') + 'x' });
    assert.notEqual(audit.hashRow(changed), h1, k);
  }
});

test('maker-checker rules', () => {
  const p = { id: 5, permissions: new Set(['core.approvals.unconfigured']), mfa: true };
  const req = { status: 'pending', requested_by: 4 };
  const pay = { approverPermission: 'core.approvals.unconfigured' };
  assert.doesNotThrow(() => approvals.checkDecider(p, req, [], pay));
  assert.throws(() => approvals.checkDecider(p, { status: 'pending', requested_by: 5 }, [], pay), /own request/);
  assert.throws(() => approvals.checkDecider(p, req, [{ approver_id: 5 }], pay), /already decided/);
  assert.throws(() => approvals.checkDecider(Object.assign({}, p, { mfa: false }), req, [], pay), /two-factor/);
  assert.throws(() => approvals.checkDecider(Object.assign({}, p, { permissions: new Set() }), req, [], pay), /not an approver/);
  assert.throws(() => approvals.checkDecider(p, { status: 'approved', requested_by: 4 }, [], pay), /no longer pending/);
});

// Two-step sign-in switch (core/mfa-policy.js). The database and audit log are replaced by stand-ins.
function mfaHarness(t) {
  const db = require('../src/db/connection.js');
  const monitor = require('../src/modules/erp/core/monitor.js');
  const policy = require('../src/modules/erp/core/mfa-policy.js');
  const saved = { env: process.env.ERP_MFA_REQUIRED, isConfigured: db.isConfigured, queryOne: db.queryOne, query: db.query, write: audit.write, event: monitor.event };
  const h = { db: db, policy: policy, row: undefined, fail: false, writes: [], audits: [] };
  db.isConfigured = function () { return true; };
  db.queryOne = async function (sql, args) {
    if (/FROM b2b_settings/.test(sql)) { if (h.fail) throw new Error('db down'); return h.row ? Object.assign({}, h.row) : null; }
    return h.staff ? Object.assign({}, h.staff) : null;
  };
  db.query = async function (sql, args) { h.writes.push({ sql: sql, args: args }); return { affectedRows: 1 }; };
  audit.write = async function (tx, actor, e) { h.audits.push(e); return 'hash'; };
  monitor.event = async function () { return {}; };
  delete process.env.ERP_MFA_REQUIRED; policy.reset();
  t.after(() => {
    if (saved.env === undefined) delete process.env.ERP_MFA_REQUIRED; else process.env.ERP_MFA_REQUIRED = saved.env;
    db.isConfigured = saved.isConfigured; db.queryOne = saved.queryOne; db.query = saved.query; audit.write = saved.write; monitor.event = saved.event;
    policy.reset();
  });
  h.setRow = function (v) { h.row = v === undefined ? undefined : { setting_value: JSON.stringify(v), updated_by: 'owner@test', updated_at: new Date() }; policy.reset(); };
  return h;
}

test('two-step sign-in switch: server override, then the in-app switch, never switched = off, unreadable = on', async (t) => {
  const h = mfaHarness(t);
  const { policy } = h;
  assert.deepEqual(await policy.status(), { required: false, mode: 'off', roles: [], source: 'default' }, 'never switched → off');
  h.setRow(true); assert.equal((await policy.status()).required, true);
  assert.equal((await policy.status()).source, 'switch');
  h.setRow(false); assert.equal(await policy.required(), false);
  h.setRow(true); h.fail = true; policy.reset();
  assert.deepEqual(await policy.status(), { required: true, mode: 'all', roles: [], source: 'fail-safe' }, 'settings unreadable → on');
  h.fail = false;
  for (const [v, want] of [['true', true], ['TRUE', true], [' false ', false], ['false', false]]) {
    process.env.ERP_MFA_REQUIRED = v; h.setRow(!want);
    assert.deepEqual(await policy.status(), { required: want, mode: want ? 'all' : 'off', roles: [], source: 'server' }, 'override ' + JSON.stringify(v) + ' beats the switch');
  }
  process.env.ERP_MFA_REQUIRED = 'maybe'; h.setRow(true);
  assert.equal((await policy.status()).source, 'switch', 'anything but true/false is ignored');
  delete process.env.ERP_MFA_REQUIRED;
  h.db.isConfigured = function () { return false; }; policy.reset();
  assert.deepEqual(await policy.status(), { required: true, mode: 'all', roles: [], source: 'fail-safe' }, 'no database → on');
});

test('two-step sign-in switch: approvals and sensitive permissions follow it; maker-checker and permissions never change', async (t) => {
  const h = mfaHarness(t);
  const p = { id: 5, permissions: new Set(['core.approvals.unconfigured', 'core.approvals.decide', 'core.staff.view']), mfa: false };
  const req = { status: 'pending', requested_by: 4 };
  const pay = { approverPermission: 'core.approvals.unconfigured' };
  function guard(principal, perm) {
    return new Promise(function (resolve) {
      const out = { status: 200, nextCalled: false };
      identity.can(perm || 'core.approvals.decide')({ erp: principal },
        { status: function (s) { out.status = s; return { json: function (b) { out.body = b; resolve(out); } }; } },
        function (e) { out.nextCalled = !e; out.err = e; resolve(out); });
    });
  }
  // switched on
  h.setRow(true);
  assert.throws(() => approvals.checkDecider(p, req, [], pay, true), /two-factor/);
  assert.throws(() => approvals.checkDecider(p, req, [], pay), /two-factor/, 'omitted = on');
  let g = await guard(p);
  assert.equal(g.status, 403); assert.equal(g.body.code, 'mfa_required'); assert.equal(g.nextCalled, false);
  assert.equal((await guard(Object.assign({}, p, { mfa: true }))).nextCalled, true, 'a code-checked session passes');
  assert.equal((await guard(p, 'core.staff.view')).nextCalled, true, 'non-sensitive permission never needs a code');
  // switched off
  h.setRow(false);
  assert.doesNotThrow(() => approvals.checkDecider(p, req, [], pay, false));
  assert.equal((await guard(p)).nextCalled, true);
  assert.throws(() => approvals.checkDecider(p, { status: 'pending', requested_by: 5 }, [], pay, false), /own request/);
  assert.throws(() => approvals.checkDecider(Object.assign({}, p, { permissions: new Set() }), req, [], pay, false), /not an approver/);
  g = await guard(Object.assign({}, p, { permissions: new Set() }));
  assert.equal(g.status, 403); assert.equal(g.nextCalled, false);
});

test('two-step sign-in switch: sign-in asks for the code only while on; the session claims MFA only when a code was checked', async (t) => {
  const h = mfaHarness(t);
  const secret = security.newTotpSecret();
  h.staff = { id: 7, name: 'T', email: 'mfa@test.local', status: 'active', password_hash: security.hashPassword('correct-horse-battery'),
    mfa_enabled: 1, mfa_secret_enc: security.encrypt(secret), token_version: 3, must_change_password: 0, failed_logins: 0, locked_until: null };
  const ctx = { ip: '127.0.0.1', userAgent: 'test' };
  const code = security.totpAt(secret, Math.floor(Date.now() / 30000));

  h.setRow(true);
  await assert.rejects(identity.login(h.staff.email, 'correct-horse-battery', '', ctx), (e) => e.code === 'mfa_required');
  const withCode = await identity.login(h.staff.email, 'correct-horse-battery', code, ctx);
  assert.equal(security.verify(withCode.token).mfa, true);

  h.setRow(false);
  const noCode = await identity.login(h.staff.email, 'correct-horse-battery', '', ctx);
  assert.equal(security.verify(noCode.token).mfa, false, 'no code checked → session never claims MFA');
  h.setRow(undefined);
  assert.ok(await identity.login(h.staff.email, 'correct-horse-battery', '', ctx), 'never switched → no code asked');
  h.writes.length = 0;
  await assert.rejects(identity.login(h.staff.email, 'wrong-password-123', '', ctx), (e) => e.code === 'bad_credentials');
  assert.ok(h.writes.some((w) => /failed_logins = failed_logins \+ 1/.test(w.sql)), 'a wrong password is still counted');
});

test('two-step sign-in switch: a Super Admin turns it on (own authenticator first) and off; audited; server override locks it', async (t) => {
  const h = mfaHarness(t);
  const { policy } = h;
  const after = [];
  const tx = { queryOne: h.db.queryOne, query: h.db.query, afterCommit: function (fn) { after.push(fn); } };
  const actor = { type: 'staff', id: 9, label: 'owner@test' };
  h.setRow(undefined);
  h.staff = { mfa_enabled: 0 };
  await assert.rejects(policy.set(tx, actor, { id: 9 }, true, 'x'), (e) => e.code === 'own_mfa_first');
  await assert.rejects(policy.set(tx, actor, { id: 9 }, 'yes', 'x'), (e) => e.status === 400);
  h.staff = { mfa_enabled: 1 };
  assert.deepEqual(await policy.set(tx, actor, { id: 9 }, true, 'audit season'), { required: true, mode: 'all', roles: [] });
  const up = h.writes.find((w) => /INSERT INTO b2b_settings/.test(w.sql));
  assert.deepEqual(up.args, [policy.KEY, 'true', 'owner@test']);
  assert.equal(h.audits[0].action, 'security.mfa_switched_on'); assert.equal(h.audits[0].reason, 'audit season');
  after.forEach((fn) => fn());
  assert.deepEqual(await policy.status().then((s) => [s.required, s.source]), [true, 'switch'], 'visible at once after commit');
  h.staff = { mfa_enabled: 0 };
  assert.deepEqual(await policy.set(tx, actor, { id: 9 }, false, ''), { required: false, mode: 'off', roles: [] }, 'switching off needs no authenticator check');
  assert.equal(h.audits[1].action, 'security.mfa_switched_off');
  process.env.ERP_MFA_REQUIRED = 'false';
  await assert.rejects(policy.set(tx, actor, { id: 9 }, true, 'x'), (e) => e.code === 'fixed_by_server');
});

test('two-step sign-in switch: routes and screen are wired (switch needs core.settings.edit; nothing else reads the old env-only check)', () => {
  const core = fs.readFileSync(path.join(ROOT, 'src/modules/erp/routes/core.js'), 'utf8');
  assert.match(core, /r\.put\('\/security\/mfa', can\('core\.settings\.edit'\)/);
  assert.match(core, /r\.get\('\/security\/mfa'/);
  assert.equal(identity.needsMfa('core.settings.edit'), true, 'switching it off while on needs a code-checked session');
  const app = fs.readFileSync(path.join(ROOT, 'erp-web/admin/app.js'), 'utf8');
  assert.match(app, /'\/security\/mfa'/);
  for (const f of ['src/modules/erp/core/identity.js', 'src/modules/erp/core/approvals.js', 'src/platform/passwords.js', 'src/modules/erp/config.js', 'src/modules/erp/routes/core.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /mfaRequired\(\)/, f);
  }
});

test('business settings: no defaults, strict validation', () => {
  assert.equal(settings.validate('inventory.grn.min_shelf_life_pct', 60), 60);
  assert.throws(() => settings.validate('inventory.grn.min_shelf_life_pct', 101));
  assert.throws(() => settings.validate('inventory.grn.min_shelf_life_pct', '60'));
  assert.throws(() => settings.validate('tax.invoice_hsn_source', 'guess'));
  assert.deepEqual(settings.validate('pricing.tiers_enabled', ['retailer', 'retailer', 'distributor']), ['retailer', 'distributor']);
  assert.throws(() => settings.validate('pricing.tiers_enabled', ['wholesale']));
  assert.throws(() => settings.validate('sales.otp', { length: 4, expiry_min: 10, max_attempts: 5, resend_cooldown_s: 60, max_resends: 3, stock_hold_min: 30 }), /length/);
  assert.throws(() => settings.validate('no.such.key', 1), /Unknown setting/);
  // the catalogue gives every setting a documented fail-safe and no setting is applied by code defaults
  settings.CATALOG.forEach(function (s) { assert.ok(s.while_unset && s.while_unset.length > 20, s.key); });
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src/modules/erp/core/settings.js'), 'utf8'), /DEFAULTS\s*=/);
});

test('WhatsApp webhook: signature over raw bytes, handshake, status parsing', () => {
  const secret = 'whatsapp-app-secret-1234567890';
  const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.X', status: 'delivered', timestamp: '1793900000' }] } }] }] }));
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(webhooks.verifySignature(raw, good, secret).ok, true);
  assert.equal(webhooks.verifySignature(Buffer.from(raw.toString().replace('delivered', 'read')), good, secret).ok, false);
  assert.equal(webhooks.verifySignature(raw, '', secret).reason, 'missing_or_malformed');
  assert.equal(webhooks.verifySignature(raw, good, '').reason, 'not_configured');
  assert.equal(webhooks.verifySignature(JSON.parse(raw), good, secret).reason, 'raw_body_required');
  assert.equal(webhooks.handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 't0k', 'hub.challenge': '99' }, 't0k'), '99');
  assert.equal(webhooks.handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '99' }, 't0k'), null);
  assert.equal(webhooks.handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '99' }, ''), null);
  assert.deepEqual(webhooks.statuses(JSON.parse(raw)), [{ id: 'wamid.X', status: 'delivered', ts: 1793900000 }]);
});

test('every permission a route checks exists in the reference data; sensitive ones need MFA', () => {
  const dir = path.join(ROOT, 'src/modules/erp/routes');
  const src = fs.readdirSync(dir).map(function (f) { return fs.readFileSync(path.join(dir, f), 'utf8'); }).join('\n');
  const used = Array.from(new Set((src.match(/can\('([a-z_.]+)'\)/g) || []).map(function (m) { return m.slice(5, -2); })));
  const known = new Set(ref.permissions.map(function (p) { return p.code; }));
  used.concat(['core.approvals.unconfigured', 'core.jobs.view']).forEach(function (p) { assert.ok(known.has(p), p); });
  ref.permissions.forEach(function (p) { assert.equal(p.is_sensitive, identity.needsMfa(p.code) || p.code === 'core.approvals.unconfigured', p.code); });
});

test('reference roles: Super Admin holds everything; fail-safe approver is Super Admin only; nobody else can change settings', () => {
  const roles = {}; ref.roles.forEach(function (r) { roles[r.code] = new Set(r.permissions); });
  assert.equal(roles.super_admin.size, ref.permissions.length);
  Object.keys(roles).filter(function (k) { return k !== 'super_admin'; }).forEach(function (k) {
    assert.ok(!roles[k].has('core.approvals.unconfigured'), k);
    assert.ok(!roles[k].has('core.settings.edit'), k);
  });
  ['catalog.pricing.edit', 'returns.approve', 'core.approvals.decide'].forEach(function (p) { assert.ok(!roles.salesman.has(p), 'salesman: ' + p); });
  roles.auditor.forEach(function (p) { assert.match(p, /\.view$|^reports\.export$|^inventory\.trace$/, 'auditor is read-only: ' + p); });
});

test('B2C protection: protected files unchanged and no business code reaches into B2C', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'b2c-guard.js'), '--repo', ROOT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /108 protected files unchanged/);
});

test('migration 004 is the reviewed file and contains no destructive or data statements', () => {
  const m = require('../src/db/migrations/004_core_governance.js');
  const sqlFile = path.join(ROOT, 'src/db/migrations/sql/004_core_governance.sql');
  const src = fs.readFileSync(path.join(ROOT, 'src/db/migrations/004_core_governance.js'), 'utf8');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(sqlFile)).digest('hex'), src.match(/SQL_SHA256 = '([0-9a-f]{64})'/)[1]);
  const sql = fs.readFileSync(sqlFile, 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE|UPDATE\s+\w|INSERT|RENAME)\b/i);
  assert.equal(m.NEW_TABLES.length, 12);
  m.OPS.forEach(function (o) { assert.ok(['addColumn', 'extendEnum', 'makeNullable', 'addIndex', 'addForeignKey'].indexOf(o.op) !== -1); });
});
