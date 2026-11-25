/**
 * /api/erp/core — staff, roles, approvals, audit, monitoring, settings, jobs.
 * Every route below login runs requireStaff (token + live database check) and a
 * permission check before any service code. Hiding a button is never the control.
 */
'use strict';
const { posId } = require('../lib/http.js');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('../../../db/connection.js');
const { h } = require('../../b2b/lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const staff = require('../core/staff.js');
const settings = require('../core/settings.js');
const monitor = require('../core/monitor.js');
const jobs = require('../core/jobs.js');
const mfaPolicy = require('../core/mfa-policy.js');
const rolePolicy = require('../core/role-policy.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const ctx = function (req) { return { ip: String(req.ip || '').slice(0, 45), userAgent: req.headers['user-agent'] }; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };

const loginLimit = rateLimit({ windowMs: 15 * 60000, max: process.env.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' } });

r.post('/login', loginLimit, h(async function (req, res) {
  res.json(await identity.login(req.body.email, req.body.password, req.body.totp, ctx(req)));
}));

r.use(identity.requireStaff);

// ── self ──
// Own record and own credentials: any signed-in staff member, even before a role is granted.
r.get('/me', h(async function (req, res) {
  const p = req.erp;
  res.json({ id: p.id, name: p.name, email: p.email, roles: p.roles, permissions: Array.from(p.permissions).sort(), scopes: p.scopes, mfa: p.mfa,
    mfaRequired: await mfaPolicy.required(p.roles) });
}));
r.post('/me/password', h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return staff.changeOwnPassword(t, req.erp, a, req.body.currentPassword, req.body.newPassword); }));
}));
// ── two-step sign-in policy: off, everyone, or chosen roles (Super Admin) ──
r.get('/security/mfa', h(async function (req, res) {
  const st = await mfaPolicy.status();
  const own = await db.queryOne('SELECT mfa_enabled FROM b2b_staff WHERE id = ?', [req.erp.id]);
  const canChange = req.erp.permissions.has('core.settings.edit') && st.source !== 'server';
  res.json(Object.assign({}, st, { canChange: canChange, appliesToMe: mfaPolicy.appliesTo(st, req.erp.roles),
    ownAuthenticator: !!(own && Number(own.mfa_enabled) === 1), sessionHasCode: !!req.erp.mfa,
    roleOptions: canChange ? await db.query('SELECT code, name FROM b2b_roles WHERE is_active = 1 ORDER BY is_system DESC, name') : undefined }));
}));
r.put('/security/mfa', can('core.settings.edit'), h(async function (req, res) {
  const value = typeof req.body.required === 'boolean' ? req.body.required : { mode: req.body.mode, roles: req.body.roles };
  res.json(await tx(req, function (t, a) { return mfaPolicy.set(t, a, req.erp, value, req.body.reason); }));
}));
// ── who may give roles without a second approver (Super Admin) ──
r.get('/security/role-assignment', can('core.roles.view'), h(async function (req, res) {
  const st = await rolePolicy.status();
  res.json(Object.assign({}, st, { adminPermissions: rolePolicy.ADMIN_PERMISSIONS, canChange: req.erp.permissions.has('core.settings.edit') }));
}));
r.put('/security/role-assignment', can('core.settings.edit'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return rolePolicy.set(t, a, { mode: req.body.mode, approvalRoles: req.body.approvalRoles || [] }, req.body.reason); }));
}));
r.post('/me/mfa/setup', h(async function (req, res) { res.json(await staff.mfaSetup(req.erp)); }));
r.post('/me/mfa/enable', h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return staff.mfaEnable(t, req.erp, a, req.body.code); }));
}));

// ── staff and roles ──
r.get('/staff', can('core.staff.view'), h(async function (req, res) { res.json(await staff.list(req.query)); }));
// The second Super Admin (only while fewer than two exist): see staff.addSecondSuperAdmin.
r.get('/staff-super-admins', can('core.staff.view'), h(async function (req, res) {
  const n = await staff.superAdminCount(db);
  res.json({ count: n, canAddSecond: n < 2 && req.erp.roles.indexOf('super_admin') !== -1 && req.erp.permissions.has('core.staff.create') });
}));
// A salesman, delivery person or event staff member in one step (account + role request [+ salesman record]).
r.post('/field-staff', can('core.staff.create'), h(async function (req, res) {
  res.status(201).json(await tx(req, function (t, a) { return staff.addFieldStaff(t, a, req.erp, req.body); }));
}));
r.post('/staff-super-admins', can('core.staff.create'), h(async function (req, res) {
  res.status(201).json(await tx(req, function (t, a) { return staff.addSecondSuperAdmin(t, a, req.erp, req.body); }));
}));
r.post('/staff', can('core.staff.create'), h(async function (req, res) {
  res.status(201).json(await tx(req, function (t, a) { return staff.create(t, a, req.body); }));
}));
r.patch('/staff/:id', can('core.staff.edit'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return staff.update(t, a, id(req.params.id), req.body, req.erp); }));
}));
// Lost phone: clear a person's authenticator (needs a code-checked session where two-step sign-in applies).
r.post('/staff/:id/mfa/reset', can('core.staff.edit', { mfa: true }), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return staff.resetMfa(t, a, req.erp, id(req.params.id), req.body.reason); }));
}));
r.get('/staff/:id/roles/history', can('core.staff.view'), h(async function (req, res) {
  res.json({ items: await staff.roleHistory(id(req.params.id)) });
}));
r.get('/roles', can('core.roles.view'), h(async function (req, res) { res.json({ items: await staff.roles() }); }));
r.post('/roles', can('core.roles.edit'), h(async function (req, res) {
  res.status(201).json(await tx(req, function (t, a) { return staff.createRole(t, a, req.body); }));
}));
r.put('/roles/:id/permissions', can('core.roles.edit'), h(async function (req, res) {
  res.status(202).json(await tx(req, function (t, a) { return staff.requestRolePermissions(t, a, id(req.params.id), req.body.permissions, req.body.reason); }));
}));
r.post('/staff/:id/roles', can('core.roles.edit'), h(async function (req, res) {
  // Given at once (201) when role-policy.js allows it, otherwise sent for approval (202).
  const out = await tx(req, function (t, a) { return staff.requestGrant(t, a, id(req.params.id), req.body, req.erp); });
  res.status(out.status === 'granted' ? 201 : 202).json(out);
}));
r.post('/staff/:id/roles/:grantId/revoke', can('core.roles.edit'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return staff.revokeGrant(t, a, id(req.params.id), id(req.params.grantId), req.body.reason); }));
}));

// ── approvals ──
r.get('/approvals', can('core.approvals.view'), h(async function (req, res) { res.json({ items: await approvals.queue(req.erp, req.query) }); }));
r.post('/approvals/:id/decide', can('core.approvals.view'), h(async function (req, res) {
  // The engine checks the approver permission for THIS request, maker ≠ checker and MFA.
  res.json(await tx(req, function (t, a) { return approvals.decide(t, req.erp, a, id(req.params.id), req.body.decision, req.body.comment); }));
}));
r.post('/approvals/:id/withdraw', h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return approvals.withdraw(t, req.erp, a, id(req.params.id)); }));
}));

// ── audit (read-only: there is no update or delete route) ──
r.get('/audit', can('core.audit.view'), h(async function (req, res) {
  const where = ['1=1'], params = [];
  ['module', 'entity', 'action'].forEach(function (k) { if (req.query[k]) { where.push(k + ' = ?'); params.push(String(req.query[k]).slice(0, 80)); } });
  if (req.query.entityId) { where.push('entity_id = ?'); params.push(String(req.query.entityId).slice(0, 64)); }
  if (req.query.actorId) { where.push('actor_id = ?'); params.push(String(req.query.actorId).slice(0, 64)); }
  const before = db.int(req.query.before, 0, 0, Number.MAX_SAFE_INTEGER);
  if (before) { where.push('id < ?'); params.push(before); }
  const limit = db.int(req.query.limit, 50, 1, 200);
  const rows = await db.query('SELECT id, actor_type, actor_id, actor_label, actor_role, module, action, entity, entity_id, old_value, new_value, reason, approval_id, ip, created_at, ' +
    '(row_hash IS NOT NULL) AS chained FROM b2b_audit_logs WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ' + limit, params);
  res.json({ items: rows, next: rows.length === limit ? Number(rows[rows.length - 1].id) : null });
}));
r.get('/audit/verify', can('core.audit.view'), h(async function (req, res) { res.json(await audit.verifyChain()); }));

// ── monitoring ──
r.get('/monitoring', can('core.monitoring.view'), h(async function (req, res) { res.json(await monitor.summary()); }));
r.get('/monitoring/events', can('core.monitoring.view'), h(async function (req, res) { res.json({ items: await monitor.list(req.query) }); }));
r.post('/monitoring/events/:id/acknowledge', can('core.monitoring.view'), h(async function (req, res) {
  const ok = await monitor.acknowledge(id(req.params.id), req.erp.id);
  if (ok) await audit.write(null, audit.actorFrom(req), { module: 'core', action: 'monitor.acknowledged', entity: 'monitor_event', entityId: req.params.id });
  res.json({ ok: ok });
}));

// ── business decisions (settings) ──
r.get('/settings/pending-decisions', can('core.settings.view'), h(async function (req, res) { res.json({ items: await settings.list() }); }));
r.put('/settings/:key', can('core.settings.edit'), h(async function (req, res) {
  const key = String(req.params.key);
  if (!/^[a-z0-9_.]{3,80}$/.test(key)) return res.status(404).json({ error: 'Unknown setting' });
  res.status(202).json(await tx(req, function (t, a) { return settings.requestChange(t, a, key, req.body.value, req.body.reason); }));
}));

// ── jobs: own jobs, or anyone's with core.jobs.view ──
r.get('/jobs/:id', h(async function (req, res) {
  const j = await jobs.get(id(req.params.id));
  if (!j || (Number(j.created_by) !== req.erp.id && !req.erp.permissions.has('core.jobs.view'))) return res.status(404).json({ error: 'Not found' });
  res.json(j);
}));

module.exports = r;
