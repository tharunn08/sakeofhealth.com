/**
 * The business (ERP) pages in the admin panel are never missing without a reason, and a business
 * with one Super Admin can add the second one from the panel. Database-free: the sign-in sources,
 * the transaction and the browser are stand-ins.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { signIn } = require('../src/platform/auth.js');

const OK_STAFF = () => ({ ok: true, token: 'staff-token', user: { name: 'M', email: 'm@x.y', role: 'admin' } });
const NO = () => ({ ok: false });
const err = (status, code, message) => Object.assign(new Error(message || code || 'x'), { status: status, code: code, expose: true });
const erpFails = (e) => async () => { throw e; };
const input = () => ({ email: 'm@x.y', password: 'pw-123456789' });
const has = (yes) => async () => yes;

test('sign-in: the shop part opened but the business part did not → the person is told why', async () => {
  let r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: erpFails(err(401, 'bad_credentials')), erpHasAccount: has(true) });
  assert.equal(r.status, 200);
  assert.equal(r.body.workspaces[0].erpToken, null);
  assert.match(r.body.erpNotice, /business \(ERP\) pages were not opened: your business account uses a different password/);

  r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: erpFails(err(401, 'bad_credentials')), erpHasAccount: has(false) });
  assert.equal(r.body.erpNotice, undefined, 'no business account for this e-mail: nothing to say');

  r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: erpFails(err(423, 'locked', 'Too many failed attempts. Try again in 15 minutes.')) });
  assert.match(r.body.erpNotice, /Try again in 15 minutes/);

  r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: erpFails(err(403, 'disabled')) });
  assert.match(r.body.erpNotice, /disabled/);

  r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: erpFails(Object.assign(new Error('ECONNREFUSED'), { status: undefined })) });
  assert.match(r.body.erpNotice, /could not be reached/);
  assert.equal(r.body.erpUnavailable, true);

  r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: erpFails(err(401, 'mfa_required')) });
  assert.equal(r.body.erpNeedsCode, true);
  assert.equal(r.body.erpNotice, undefined, 'the code prompt already explains it');

  r = await signIn(input(), { staff: OK_STAFF, customer: NO, erp: async () => ({ token: 'erp-token', staff: { id: 1, name: 'M', email: 'm@x.y' } }) });
  assert.equal(r.body.workspaces[0].erpToken, 'erp-token');
  assert.equal(r.body.erpNotice, undefined);

  // a stranger whose password opened nothing learns nothing about business accounts
  let asked = false;
  r = await signIn(input(), { staff: NO, customer: NO, erp: erpFails(err(401, 'bad_credentials')), erpHasAccount: async () => { asked = true; return true; } });
  assert.equal(r.status, 401);
  assert.equal(asked, false);
});

test('login page shows the notice and lets the person continue; every admin page loads the session check', () => {
  const login = fs.readFileSync(path.join(ROOT, 'platform-web/login.js'), 'utf8');
  assert.match(login, /if \(data\.erpNotice\) \{[\s\S]*show\(data\.erpNotice, 'warn'\)[\s\S]*skipBtn\.hidden = false/);
  const routes = require('../src/platform/routes.js');
  const reg = require('../src/platform/registry.js');
  for (const p of reg.PAGES) assert.match(routes.pageHtml(p), /<script src="\/platform\/session-check\.js"><\/script>\n<\/body>/, p.id);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/platform/routes.js'), 'utf8'), /'shell\.css', 'session-check\.js'\]/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/platform/routes.js'), 'utf8'), /erpSignInNeeded/);
});

async function runSessionCheck(opts) {
  const appended = [];
  const store = {};
  const el = () => ({ style: {}, setAttribute() {}, appendChild(c) { (this.kids = this.kids || []).push(c); }, addEventListener(ev, fn) { this['on' + ev] = fn; }, remove() { this.removed = true; } });
  let fetched = null, loggedOut = false;
  const ctx = {
    window: { Admin: { Auth: { token: () => opts.shop || null, erpToken: () => opts.erp || null, logout: () => { loggedOut = true; } } } },
    sessionStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    document: { createElement: el, body: { appendChild: (n) => appended.push(n) } },
    fetch: async (url, o) => { fetched = { url, o }; return { ok: true, json: async () => opts.nav }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'platform-web/session-check.js'), 'utf8'), ctx);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  return { appended, fetched, store, loggedOut: () => loggedOut };
}

test('admin pages: a shop session without the business part, for someone who has a business account, shows a sign-in-again banner', async () => {
  let r = await runSessionCheck({ shop: 'staff-token', nav: { erpSignInNeeded: true } });
  assert.equal(r.fetched.url, '/api/platform/nav');
  assert.equal(r.fetched.o.headers.Authorization, 'Bearer staff-token');
  assert.equal(r.appended.length, 1);
  const bar = r.appended[0];
  assert.match(bar.kids[0].textContent, /business \(ERP\) pages/);
  bar.kids[1].onclick(); assert.equal(r.loggedOut(), true, '"Sign in again" signs out and goes to /login');
  bar.kids[2].onclick(); assert.equal(r.store.soh_erp_banner_hidden, '1'); assert.equal(bar.removed, true);

  r = await runSessionCheck({ shop: 'staff-token', nav: { erpSignInNeeded: false } });
  assert.equal(r.appended.length, 0, 'no business account: no banner');
  r = await runSessionCheck({ shop: 'staff-token', erp: 'erp-token', nav: { erpSignInNeeded: true } });
  assert.equal(r.fetched, null, 'business pages already open: nothing to check');
  r = await runSessionCheck({ nav: { erpSignInNeeded: true } });
  assert.equal(r.fetched, null, 'not signed in: nothing to check');
});

/* ── The second Super Admin ── */
function fakeTx(state) {
  const calls = [];
  return {
    calls,
    async queryOne(sql) {
      calls.push(sql);
      if (/FROM b2b_roles WHERE code = 'super_admin'/.test(sql)) return state.role === false ? null : { id: 1 };
      if (/COUNT\(DISTINCT sr\.staff_id\)/.test(sql)) return { n: state.count };
      return null;
    },
    async query(sql, args) {
      calls.push(sql);
      if (/INSERT INTO b2b_staff \(/.test(sql)) {
        if (state.dup) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
        state.staffInsert = args; return { insertId: 42 };
      }
      if (/INSERT INTO b2b_staff_roles/.test(sql)) { state.grant = args; return { insertId: 7 }; }
      return { affectedRows: 1 };
    },
  };
}

test('second Super Admin: only a Super Admin, only while fewer than two exist; 12+ characters; must change at first sign-in; audited', async (t) => {
  const audit = require('../src/modules/erp/core/audit.js');
  const staff = require('../src/modules/erp/core/staff.js');
  const security = require('../src/modules/erp/core/security.js');
  const saved = audit.write; const audits = [];
  audit.write = async (tx, actor, e) => { audits.push(e); return 'h'; };
  t.after(() => { audit.write = saved; });
  const owner = { id: 9, roles: ['super_admin'], permissions: new Set(['core.staff.create']) };
  const actor = { type: 'staff', id: 9, label: 'owner@x.y' };
  const body = { name: 'Second Admin', email: 'Second@Example.com ', password: 'TeMP@2026-Soh', confirmPassword: 'TeMP@2026-Soh', reason: 'approvals need two people' };

  let st = { count: 1 };
  const r = await staff.addSecondSuperAdmin(fakeTx(st), actor, owner, body);
  assert.deepEqual(r, { id: 42, email: 'second@example.com', mustChangePassword: true });
  assert.equal(st.staffInsert[0], 'Second Admin'); assert.equal(st.staffInsert[1], 'second@example.com'); assert.equal(st.staffInsert[3], 9);
  assert.ok(security.verifyPassword('TeMP@2026-Soh', st.staffInsert[2]), 'stored as a hash of the given password');
  assert.deepEqual(st.grant, [42, 1, 9], 'super_admin, scope all, granted by the owner');
  assert.equal(audits[0].action, 'staff.second_super_admin'); assert.equal(audits[0].entityId, 42);
  assert.equal(JSON.stringify(audits[0]).includes('TeMP'), false, 'the password never reaches the audit log');

  await assert.rejects(staff.addSecondSuperAdmin(fakeTx({ count: 2 }), actor, owner, body), /Two Super Admins already exist/);
  await assert.rejects(staff.addSecondSuperAdmin(fakeTx({ count: 1 }), actor, { id: 9, roles: ['business_admin'], permissions: new Set(['core.staff.create']) }, body), /Only a Super Admin/);
  await assert.rejects(staff.addSecondSuperAdmin(fakeTx({ count: 1 }), actor, owner, Object.assign({}, body, { password: 'TeMP@2026', confirmPassword: 'TeMP@2026' })), /at least 12 characters/);
  await assert.rejects(staff.addSecondSuperAdmin(fakeTx({ count: 1 }), actor, owner, Object.assign({}, body, { confirmPassword: 'other-password-1' })), /do not match/);
  await assert.rejects(staff.addSecondSuperAdmin(fakeTx({ count: 1 }), actor, owner, Object.assign({}, body, { email: 'not-an-email' })), /valid e-mail/);
  await assert.rejects(staff.addSecondSuperAdmin(fakeTx({ count: 1, dup: true }), actor, owner, body), /already exists/);
});

test('second Super Admin: routes and screen are wired', () => {
  const core = fs.readFileSync(path.join(ROOT, 'src/modules/erp/routes/core.js'), 'utf8');
  assert.match(core, /r\.get\('\/staff-super-admins', can\('core\.staff\.view'\)/);
  assert.match(core, /r\.post\('\/staff-super-admins', can\('core\.staff\.create'\)/);
  const app = fs.readFileSync(path.join(ROOT, 'erp-web/admin/app.js'), 'utf8');
  assert.match(app, /api\('GET', '\/staff-super-admins'\)/);
  assert.match(app, /Add the second Super Admin/);
});
