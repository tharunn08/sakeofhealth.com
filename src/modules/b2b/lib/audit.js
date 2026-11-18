/**
 * Audit trail. Append-only: this module only ever INSERTs, and no route in
 * the application updates or deletes b2b_audit_logs.
 */
const db = require('../../../db/connection.js');

function trim(value) {
  if (value == null) return null;
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length > 60000) s = s.slice(0, 60000) + '…[truncated]';
  return s;
}

/**
 * @param q      a transaction wrapper (tx) or null to use the pool
 * @param actor  { type: 'admin'|'business'|'system', id, label, role, ip }
 */
async function log(q, actor, action, entity, entityId, oldValue, newValue) {
  const run = q ? q.query.bind(q) : db.query;
  actor = actor || { type: 'system', label: 'system' };
  await run(
    'INSERT INTO b2b_audit_logs (actor_type, actor_id, actor_label, actor_role, action, entity, entity_id, old_value, new_value, ip) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [actor.type || 'system', actor.id == null ? null : String(actor.id), actor.label || null, actor.role || null,
      action, entity, entityId == null ? null : String(entityId), trim(oldValue), trim(newValue), actor.ip || null]);
}

/** Best-effort variant for places where an audit failure must not fail the request. */
function logSoft(actor, action, entity, entityId, oldValue, newValue) {
  log(null, actor, action, entity, entityId, oldValue, newValue).catch(function (e) {
    console.error('[B2B AUDIT] failed to write audit row:', e.code || e.message);
  });
}

const SYSTEM = { type: 'system', id: null, label: 'system', role: 'system' };

function adminActor(req) {
  return { type: 'admin', id: req.admin.sub, label: req.admin.email, role: req.admin.role, ip: String(req.ip || '').slice(0, 45) };
}
function businessActor(req) {
  return { type: 'business', id: req.b2b.user.id, label: req.b2b.user.email, role: req.b2b.account.account_type,
    ip: String(req.ip || '').slice(0, 45), accountId: req.b2b.account.id };
}

module.exports = { log, logSoft, SYSTEM, adminActor, businessActor };
