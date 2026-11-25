/**
 * Approval engine (maker-checker).
 *
 *   request()  — the maker asks; the rule for the type and amount decides how many
 *                steps and which permission an approver needs. With NO rule
 *                configured (thresholds are a pending business decision, D6) the
 *                fail-safe applies: one step by someone holding
 *                core.approvals.unconfigured (Super Admin only).
 *   decide()   — the checker approves/rejects. Refused for the requester and for
 *                anyone who already decided a step of the same request.
 *   When the last step is approved, the handler registered for the type runs in
 *   the SAME transaction, so "approved" and "done" can never disagree.
 */
'use strict';
const db = require('../../../db/connection.js');
const audit = require('./audit.js');

const FALLBACK_PERMISSION = 'core.approvals.unconfigured';
const handlers = {};
const closers = {};   // optional: what happens when a request is rejected or withdrawn
function fail(status, msg, code) { return Object.assign(new Error(msg), { status: status, expose: true, code: code }); }

/**
 * Modules register what happens when a request of their type is fully approved, and optionally
 * (opts.onClosed) when it is rejected or withdrawn — in the same transaction as the decision.
 */
function register(type, onApproved, opts) { handlers[type] = onApproved; if (opts && opts.onClosed) closers[type] = opts.onClosed; }

async function ruleFor(tx, type, amount) {
  const r = await tx.queryOne(
    'SELECT steps_required, approver_permission FROM b2b_approval_rules WHERE approval_type = ? AND is_active = 1 AND min_amount <= ? ORDER BY min_amount DESC LIMIT 1',
    [type, amount == null ? 0 : String(amount)]);
  return r ? { steps: Number(r.steps_required), permission: r.approver_permission, configured: true }
    : { steps: 1, permission: FALLBACK_PERMISSION, configured: false };
}

async function request(tx, actor, o) {
  if (!handlers[o.type]) throw new Error('No handler registered for approval type ' + o.type);
  if (!o.reason || String(o.reason).trim().length < 5) throw fail(400, 'A reason of at least 5 characters is required', 'reason_required');
  const rule = await ruleFor(tx, o.type, o.amount);
  // A module may name who approves while no rule is configured (an owner decision for that type);
  // otherwise the Super Admin fail-safe applies.
  if (!rule.configured && o.defaultPermission) rule.permission = String(o.defaultPermission);
  const openKey = (o.type + ':' + o.entity + ':' + o.entityId).slice(0, 120);
  let res;
  try {
    res = await tx.query(
      'INSERT INTO b2b_approval_requests (approval_type, entity, entity_id, status, amount, steps_required, reason, payload_json, requested_by, open_key) ' +
      "VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
      [o.type, o.entity, o.entityId, o.amount == null ? null : String(o.amount), rule.steps, String(o.reason).slice(0, 500),
        JSON.stringify({ data: o.payload || null, approverPermission: rule.permission, ruleConfigured: rule.configured }), actor.id, openKey]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'There is already an open approval request for this item', 'already_pending');
    throw e;
  }
  await audit.write(tx, actor, { module: 'core', action: 'approval.requested', entity: o.entity, entityId: o.entityId,
    new: { type: o.type, amount: o.amount, steps: rule.steps, approverPermission: rule.permission }, reason: o.reason, approvalId: res.insertId });
  return { approvalId: res.insertId, status: 'pending', stepsRequired: rule.steps, approverPermission: rule.permission, ruleConfigured: rule.configured };
}

function parse(row) { try { return JSON.parse(row.payload_json || '{}'); } catch (e) { return {}; } }

/**
 * The pure checks, separated so they can be unit-tested without a database.
 * mfaRequired: whether two-step sign-in is switched on (mfa-policy.js); omitted = on.
 */
function checkDecider(principal, req, steps, payload, mfaRequired) {
  if (req.status !== 'pending') throw fail(409, 'This request is no longer pending', 'not_pending');
  if (Number(req.requested_by) === Number(principal.id)) throw fail(403, 'You cannot approve your own request', 'maker_cannot_check');
  if (steps.some(function (s) { return Number(s.approver_id) === Number(principal.id); })) throw fail(403, 'You have already decided a step of this request', 'already_decided');
  if (!principal.permissions.has(payload.approverPermission)) throw fail(403, 'You are not an approver for this request', 'not_approver');
  if (!principal.mfa && mfaRequired !== false) throw fail(403, 'Approving needs two-factor sign-in', 'mfa_required');
}

async function decide(tx, principal, actor, id, decision, comment) {
  if (['approved', 'rejected'].indexOf(decision) === -1) throw fail(400, 'Decision must be approved or rejected');
  const req = await tx.queryOne('SELECT * FROM b2b_approval_requests WHERE id = ? FOR UPDATE', [id]);
  if (!req) throw fail(404, 'Not found');
  const steps = await tx.query('SELECT approver_id FROM b2b_approval_steps WHERE request_id = ?', [id]);
  const payload = parse(req);
  checkDecider(principal, req, steps, payload, await require('./mfa-policy.js').required(principal.roles));
  const stepNo = Number(req.steps_done) + 1;
  await tx.query('INSERT INTO b2b_approval_steps (request_id, step_no, decision, approver_id, comment) VALUES (?, ?, ?, ?, ?)',
    [id, stepNo, decision, principal.id, comment ? String(comment).slice(0, 500) : null]);
  let status = 'pending';
  if (decision === 'rejected') status = 'rejected';
  else if (stepNo >= Number(req.steps_required)) status = 'approved';
  await tx.query('UPDATE b2b_approval_requests SET steps_done = ?, status = ?, decided_at = IF(? = \'pending\', NULL, UTC_TIMESTAMP()), ' +
    'open_key = IF(? = \'pending\', open_key, NULL) WHERE id = ?', [stepNo, status, status, status, id]);
  await audit.write(tx, actor, { module: 'core', action: 'approval.' + decision, entity: req.entity, entityId: req.entity_id,
    new: { step: stepNo, of: Number(req.steps_required), status: status }, reason: comment, approvalId: id });
  let result = null;
  if (status === 'rejected' && closers[req.approval_type]) {
    result = await closers[req.approval_type](tx, { id: Number(id), entity: req.entity, entityId: Number(req.entity_id), data: payload.data, requestedBy: Number(req.requested_by) }, 'rejected', actor);
  }
  if (status === 'approved') {
    const h = handlers[req.approval_type];
    if (!h) throw new Error('No handler for ' + req.approval_type);
    result = await h(tx, { id: Number(id), entity: req.entity, entityId: Number(req.entity_id), data: payload.data, requestedBy: Number(req.requested_by) }, actor);
  }
  return { approvalId: Number(id), status: status, step: stepNo, stepsRequired: Number(req.steps_required), result: result };
}

async function withdraw(tx, principal, actor, id) {
  const req = await tx.queryOne('SELECT * FROM b2b_approval_requests WHERE id = ? FOR UPDATE', [id]);
  if (!req || Number(req.requested_by) !== Number(principal.id)) throw fail(404, 'Not found');
  if (req.status !== 'pending') throw fail(409, 'This request is no longer pending');
  await tx.query("UPDATE b2b_approval_requests SET status = 'withdrawn', decided_at = UTC_TIMESTAMP(), open_key = NULL WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'core', action: 'approval.withdrawn', entity: req.entity, entityId: req.entity_id, approvalId: id });
  if (closers[req.approval_type]) await closers[req.approval_type](tx, { id: Number(id), entity: req.entity, entityId: Number(req.entity_id), data: parse(req).data, requestedBy: Number(req.requested_by) }, 'withdrawn', actor);
  return { approvalId: Number(id), status: 'withdrawn' };
}

/** The caller's queue: pending, not their own, and they hold the approver permission. */
async function queue(principal, q) {
  const limit = db.int(q.limit, 25, 1, 100);
  const after = db.int(q.after, 0, 0, Number.MAX_SAFE_INTEGER);
  const rows = await db.query(
    "SELECT r.id, r.approval_type, r.entity, r.entity_id, r.amount, r.steps_required, r.steps_done, r.reason, r.payload_json, r.requested_at, " +
    "s.name AS requested_by_name, r.requested_by FROM b2b_approval_requests r JOIN b2b_staff s ON s.id = r.requested_by " +
    "WHERE r.status = 'pending' AND r.requested_by <> ? AND r.id > ? ORDER BY r.id LIMIT 500", [principal.id, after]);
  const mine = rows.filter(function (r) { return principal.permissions.has(parse(r).approverPermission); }).slice(0, limit);
  return mine.map(function (r) {
    const p = parse(r);
    return { id: Number(r.id), type: r.approval_type, entity: r.entity, entityId: Number(r.entity_id), amount: r.amount, step: Number(r.steps_done) + 1,
      stepsRequired: Number(r.steps_required), reason: r.reason, requestedBy: r.requested_by_name, requestedAt: r.requested_at,
      ruleConfigured: !!p.ruleConfigured, details: p.data };
  });
}

module.exports = { register, request, decide, withdraw, queue, checkDecider, ruleFor, FALLBACK_PERMISSION };
