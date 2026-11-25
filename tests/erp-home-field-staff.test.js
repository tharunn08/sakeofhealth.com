/**
 * ERP Home (every ERP module in one place, under the ERP menu section), the field app offered to
 * delivery and event staff at sign-in, and adding a salesman / delivery person / event staff member
 * in one step. Database-free: sign-in sources, transaction, approvals and DOM are stand-ins.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

/* ── ERP Home ── */
test('menu: an ERP section with ERP Home, open to every business staff member', () => {
  const reg = require('../src/platform/registry.js');
  const ids = reg.GROUPS.map((g) => g.id);
  assert.equal(ids[1], 'business'); assert.equal(reg.GROUPS[1].label, 'ERP');
  const p = reg.PAGES.find((x) => x.id === 'erp-erphome');
  assert.equal(p.path, '/admin/business/erp'); assert.equal(p.perm, 'core.self.view'); assert.equal(p.group, 'business');
  reg.PAGES.filter((x) => x.module === 'erp').forEach((x) => assert.ok(x.scripts.includes('/admin/erp/home.js'), x.id));
  const d = reg.navFor(null, true, { enabled: true, permissions: new Set(['deliveries.update', 'core.self.view']) });
  assert.equal(d.home, '/admin/business/erp', 'delivery staff land on ERP Home, not a blank page');
  assert.match(fs.readFileSync(path.join(ROOT, 'erp-web/admin/index.html'), 'utf8'), /\/admin\/erp\/home\.js/);
});

test('ERP Home lists every ERP screen in the menu, with the same permission', () => {
  const reg = require('../src/platform/registry.js');
  const src = fs.readFileSync(path.join(ROOT, 'erp-web/admin/home.js'), 'utf8');
  const listed = [...src.matchAll(/\['([a-z]+)', '([^']+)', '([a-z0-9_.]+)', '([^']+)', '/g)].map((m) => ({ view: m[1], label: m[2], perm: m[3], group: m[4] }));
  const pages = reg.PAGES.filter((x) => x.module === 'erp' && x.view !== 'erphome');
  assert.equal(listed.length, pages.length, 'one card per ERP screen');
  for (const p of pages) {
    const l = listed.find((x) => x.view === p.view);
    assert.ok(l, p.view + ' is on ERP Home');
    assert.equal(l.perm, p.perm, p.view + ' permission');
    assert.equal(l.label, p.label, p.view + ' label');
    assert.equal(l.group, reg.GROUPS.find((g) => g.id === p.group).label, p.view + ' menu place');
  }
});

function renderHome(perms) {
  const node = (tag) => ({ tag, kids: [], attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); return c; },
    insertBefore(c, ref) { const i = ref ? this.kids.indexOf(ref) : -1; if (i < 0) this.kids.push(c); else this.kids.splice(i, 0, c); return c; },
    get children() { return this.kids; }, addEventListener(e, f) { this['on' + e] = f; } });
  const el = (tag, attrs, kids) => { const n = node(tag); Object.keys(attrs || {}).forEach((k) => { if (k === 'text') n.textContent = attrs[k]; else if (k === 'on') Object.keys(attrs.on).forEach((e) => n.addEventListener(e, attrs.on[e])); else n.setAttribute(k, attrs[k]); }); (kids || []).forEach((c) => c != null && n.appendChild(c)); return n; };
  const shown = [];
  const window = { ERP_VIEWS: [], ERP: { el, has: (p) => perms.has(p), show: (id) => shown.push(id) } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'erp-web/admin/home.js'), 'utf8'), { window });
  const main = node('main');
  window.ERP_VIEWS[0].render(main);
  const text = (n) => (typeof n === 'string' ? n : (n.textContent || '') + ' ' + n.kids.map(text).join(' '));
  const buttons = [];
  (function walk(n) { if (typeof n !== 'object') return; if (n.tag === 'button') buttons.push(n); n.kids.forEach(walk); })(main);
  return { view: window.ERP_VIEWS[0], text: text(main).replace(/\s+/g, ' '), buttons, shown };
}

test('ERP Home: explains ERP; a Super Admin sees every module, delivery staff only theirs; Open goes to the module', () => {
  const ref = require('../src/modules/erp/catalog/reference-data.json');
  const all = renderHome(new Set(ref.roles.find((r) => r.code === 'super_admin').permissions));
  assert.deepEqual([all.view.id, all.view.perm], ['erphome', 'core.self.view']);
  assert.match(all.text, /What is ERP\? ERP \(Enterprise Resource Planning\) is the business side of Sake of Health/);
  assert.match(all.text, /Your role can open 33 of the 33 ERP modules/);
  assert.equal(all.buttons.length, 33);
  all.buttons.find((b) => b.attrs['aria-label'] === 'Open Stock & Batches').onclick();
  assert.deepEqual(all.shown, ['stock']);
  const del = renderHome(new Set(ref.roles.find((r) => r.code === 'delivery_staff').permissions));
  assert.match(del.text, /Your role can open 1 of the 33 ERP modules/);
  assert.deepEqual(del.buttons.map((b) => b.attrs['aria-label']), ['Open My Password & 2FA']);
  assert.match(del.text, /Field app on their phone: sakeofhealth\.com\/sales-app\//);
});

/* ── Field app at sign-in ── */
test('sign-in: delivery and event staff get the field app too; a salesman keeps "Field sales app"', async () => {
  const { signIn } = require('../src/platform/auth.js');
  const NO = () => ({ ok: false });
  const erp = (extra) => async () => Object.assign({ token: 'erp-token', staff: { id: 3, name: 'D', email: 'd@x.y' } }, extra);
  const input = { email: 'd@x.y', password: 'pw-123456789' };
  let r = await signIn(input, { staff: NO, customer: NO, erp: erp({ isFieldStaff: true }) });
  assert.deepEqual(r.body.workspaces.map((w) => [w.type, w.label, w.home]), [['admin', 'Admin panel', '/admin'], ['sales', 'Delivery & event app', '/sales-app/']]);
  r = await signIn(input, { staff: NO, customer: NO, erp: erp({ isSalesman: true, isFieldStaff: false }) });
  assert.equal(r.body.workspaces[1].label, 'Field sales app');
  r = await signIn(input, { staff: NO, customer: NO, erp: erp({}) });
  assert.deepEqual(r.body.workspaces.map((w) => w.type), ['admin'], 'office staff: no field app');
  const routes = fs.readFileSync(path.join(ROOT, 'src/platform/routes.js'), 'utf8');
  assert.match(routes, /permission_code IN \('deliveries\.update', 'events\.sell'\)/);
});

/* ── One-step field staff ── */
const ROLE_PERMS = { 11: ['sales.orders.create', 'sales.visits.log'], 12: ['deliveries.view', 'deliveries.update'], 13: ['events.sell'] };
function fakeTx(state) {
  return {
    async queryOne(sql, args) {
      if (/FROM b2b_roles WHERE code = \?/.test(sql)) return { id: { salesman: 11, delivery_staff: 12, event_staff: 13 }[args[0]], name: args[0] };
      if (/FROM b2b_roles WHERE id = \?/.test(sql)) return { id: args[0], code: { 11: 'salesman', 12: 'delivery_staff', 13: 'event_staff' }[args[0]], name: 'Role ' + args[0] };
      if (/FROM b2b_staff WHERE id = \? AND status = 'active'/.test(sql)) return { id: args[0] };
      return null;
    },
    async query(sql, args) {
      (state.sql = state.sql || []).push(sql);
      if (/FROM b2b_role_permissions WHERE role_id = \?/.test(sql)) return (ROLE_PERMS[args[0]] || []).map((p) => ({ permission_code: p }));
      if (/INSERT INTO b2b_staff \(/.test(sql)) { if (state.dup) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' }); state.insert = args; return { insertId: 77 }; }
      if (/INSERT INTO b2b_staff_roles/.test(sql)) { (state.grants = state.grants || []).push(args); return { insertId: 300 }; }
      if (/UPDATE b2b_staff SET must_change_password = 1/.test(sql)) { state.mustChange = args; return { affectedRows: 1 }; }
      return { affectedRows: 1 };
    },
  };
}

test('add a salesman, delivery person or event staff in one step: account, role (direct or approval by policy), salesman record', async (t) => {
  const staff = require('../src/modules/erp/core/staff.js');
  const approvals = require('../src/modules/erp/core/approvals.js');
  const audit = require('../src/modules/erp/core/audit.js');
  const sales = require('../src/modules/erp/sales/service.js');
  const rolePolicy = require('../src/modules/erp/core/role-policy.js');
  const saved = { request: approvals.request, write: audit.write, add: sales.addSalesman, status: rolePolicy.status };
  const asked = [], salesmen = [], audits = [];
  let policy = { mode: 'direct', approvalRoles: [] };
  approvals.request = async (tx, actor, r) => { asked.push(r); return { approvalId: 501, status: 'pending' }; };
  audit.write = async (tx, actor, e) => { audits.push(e); return 'h'; };
  sales.addSalesman = async (tx, actor, b) => { salesmen.push(b); return { salesmanId: 9 }; };
  rolePolicy.status = async () => policy;
  t.after(() => { approvals.request = saved.request; audit.write = saved.write; sales.addSalesman = saved.add; rolePolicy.status = saved.status; });
  const ALL = { territory: 'all', warehouse: 'all', state: 'all' };
  const owner = { id: 1, roles: ['super_admin'], scopes: ALL, permissions: new Set(['core.staff.create', 'core.roles.edit', 'core.staff.edit',
    'deliveries.view', 'deliveries.update', 'sales.orders.create', 'sales.visits.log', 'events.sell']) };
  const actor = { type: 'staff', id: 1, label: 'owner@x.y' };
  const base = { name: 'Ravi', email: 'ravi@example.com', mobile: '9876543210', password: 'Delivery-2026!', confirmPassword: 'Delivery-2026!' };

  // One admin, direct mode (the default): the role is given at once, no second person.
  let st = {};
  let r = await staff.addFieldStaff(fakeTx(st), actor, owner, Object.assign({ kind: 'delivery' }, base));
  assert.deepEqual([r.id, r.role, r.approval.status, r.approval.grantId, r.salesman, r.mustChangePassword], [77, 'delivery_staff', 'granted', 300, null, true]);
  assert.deepEqual(st.grants[0], [77, 12, 'all', null, 1], 'grant row: staff 77, role 12, scope all, given by 1');
  assert.equal(asked.length, 0, 'no approval request');
  assert.deepEqual(st.mustChange, [77], 'temporary password: changed at first sign-in');
  const g = audits.find((e) => e.action === 'role.granted');
  assert.equal(g.new.direct, true); assert.equal(g.approvalId, undefined);
  assert.equal(salesmen.length, 0, 'no salesman record for delivery staff');

  st = {};
  r = await staff.addFieldStaff(fakeTx(st), actor, owner, Object.assign({ kind: 'salesman', employeeCode: 'S-01', homeTerritoryId: 4, defaultWarehouseId: 2, cashLimit: '' }, base));
  assert.equal(st.grants[0][1], 11);
  assert.deepEqual(salesmen[0], { staffId: 77, employeeCode: 'S-01', homeTerritoryId: 4, defaultWarehouseId: 2, cashLimit: 20000 });
  assert.deepEqual(r.salesman, { salesmanId: 9 });

  // Approval mode: the same request waits for a second person.
  policy = { mode: 'approval', approvalRoles: [] };
  r = await staff.addFieldStaff(fakeTx({}), actor, owner, Object.assign({ kind: 'event' }, base));
  assert.equal(r.role, 'event_staff'); assert.equal(r.approval.approvalId, 501);
  assert.equal(asked[0].type, 'core.role_grant'); assert.equal(asked[0].payload.roleId, 13); assert.equal(asked[0].entityId, 77);
  assert.ok(asked[0].reason.length >= 5);

  // Direct mode, but the giver lacks a permission the role carries: approval.
  policy = { mode: 'direct', approvalRoles: [] };
  const narrow = Object.assign({}, owner, { permissions: new Set(['core.staff.create', 'core.roles.edit', 'deliveries.view']) });
  r = await staff.addFieldStaff(fakeTx({}), actor, narrow, Object.assign({ kind: 'delivery' }, base));
  assert.equal(r.approval.approvalId, 501); assert.match(r.approval.why, /cannot/);

  const noRoles = { id: 1, roles: [], permissions: new Set(['core.staff.create']) };
  await assert.rejects(staff.addFieldStaff(fakeTx({}), actor, noRoles, Object.assign({ kind: 'delivery' }, base)), /core\.roles\.edit/);
  const noEdit = { id: 1, roles: [], permissions: new Set(['core.staff.create', 'core.roles.edit']) };
  await assert.rejects(staff.addFieldStaff(fakeTx({}), actor, noEdit, Object.assign({ kind: 'salesman' }, base)), /core\.staff\.edit/);
  await assert.rejects(staff.addFieldStaff(fakeTx({}), actor, owner, Object.assign({}, base, { kind: 'manager' })), /Choose salesman, delivery or event staff/);
  await assert.rejects(staff.addFieldStaff(fakeTx({}), actor, owner, Object.assign({ kind: 'delivery' }, base, { confirmPassword: 'x' })), /do not match/);
  await assert.rejects(staff.addFieldStaff(fakeTx({}), actor, owner, Object.assign({ kind: 'delivery' }, base, { password: 'TeMP@2026', confirmPassword: 'TeMP@2026' })), /at least 12 characters/);
  await assert.rejects(staff.addFieldStaff(fakeTx({ dup: true }), actor, owner, Object.assign({ kind: 'delivery' }, base)), /already exists/);
});

test('one-step field staff: route and screen are wired', () => {
  const core = fs.readFileSync(path.join(ROOT, 'src/modules/erp/routes/core.js'), 'utf8');
  assert.match(core, /r\.post\('\/field-staff', can\('core\.staff\.create'\)/);
  const app = fs.readFileSync(path.join(ROOT, 'erp-web/admin/app.js'), 'utf8');
  assert.match(app, /Add a salesman, delivery person or event staff/);
  assert.match(app, /api\('POST', '\/field-staff', body\)/);
  assert.match(app, /rawApi\('GET', '\/api\/erp\/sales\/salesmen\/lookups'\)/);
});
