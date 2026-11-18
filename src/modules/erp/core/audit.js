/**
 * Tamper-evident audit trail for the business platform.
 *
 * Writes into the existing b2b_audit_logs table (columns added by migration 004).
 * Every ERP row carries prev_hash and row_hash = SHA-256 over its own fields and
 * the previous ERP row's hash, so editing or deleting any chained row breaks the
 * chain from that point on. Rows written by the older B2B module have no hash and
 * are outside the chain (documented). There is no update or delete path.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');

const MAX = 60000;
function text(v) {
  if (v == null) return null;
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX ? s.slice(0, MAX) + '…[truncated]' : s;
}

function utcNow() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

/** The exact bytes that are hashed. Field order and separators are part of the format. */
function canonical(r) {
  return [r.prev_hash || '', r.actor_type, r.actor_id || '', r.actor_role || '', r.module || '', r.action, r.entity,
    r.entity_id || '', r.old_value || '', r.new_value || '', r.reason || '', r.approval_id == null ? '' : String(r.approval_id),
    r.created_at].join('\u001f');
}
function hashRow(r) { return crypto.createHash('sha256').update(canonical(r), 'utf8').digest('hex'); }

/**
 * @param tx    the business transaction (so the audit row commits or rolls back with the change)
 * @param actor { type: 'staff'|'vendor'|'business'|'system', id, role, ip, sessionId, userAgent }
 * @param e     { module, action, entity, entityId, old, new, reason, approvalId }
 */
async function write(tx, actor, e) {
  if (!tx) return db.transaction(function (t) { return write(t, actor, e); });
  actor = actor || { type: 'system', id: null, role: 'system' };
  // Serialise chain writers: one row lock on a dedicated sequence row.
  await tx.query("INSERT IGNORE INTO b2b_sequences (seq_key, next_val) VALUES ('erp_audit_chain', 1)");
  await tx.query("SELECT next_val FROM b2b_sequences WHERE seq_key = 'erp_audit_chain' FOR UPDATE");
  const last = await tx.queryOne('SELECT row_hash FROM b2b_audit_logs WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1');
  const row = {
    actor_type: actor.type === 'system' ? 'system' : (actor.type === 'vendor' || actor.type === 'business' ? 'business' : 'admin'),
    actor_id: actor.id == null ? null : String(actor.id), actor_role: actor.role || null,
    module: e.module, action: e.action, entity: e.entity, entity_id: e.entityId == null ? null : String(e.entityId),
    old_value: text(e.old), new_value: text(e.new), reason: e.reason ? String(e.reason).slice(0, 500) : null,
    approval_id: e.approvalId == null ? null : Number(e.approvalId), created_at: utcNow(), prev_hash: last ? last.row_hash : null,
  };
  row.row_hash = hashRow(row);
  await tx.query(
    'INSERT INTO b2b_audit_logs (actor_type, actor_id, actor_label, actor_role, action, entity, entity_id, old_value, new_value, ip, ' +
    'module, reason, approval_id, session_id, user_agent, prev_hash, row_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [row.actor_type, row.actor_id, actor.label || null, row.actor_role, row.action, row.entity, row.entity_id, row.old_value, row.new_value,
      actor.ip || null, row.module, row.reason, row.approval_id, actor.sessionId || null,
      actor.userAgent ? String(actor.userAgent).slice(0, 255) : null, row.prev_hash, row.row_hash, row.created_at]);
  await tx.query("UPDATE b2b_sequences SET next_val = next_val + 1 WHERE seq_key = 'erp_audit_chain'");
  return row.row_hash;
}

/** Walks the whole chain in pages. Returns the first break, if any. */
async function verifyChain() {
  let after = 0, prev = null, checked = 0;
  for (;;) {
    const rows = await db.query(
      "SELECT id, actor_type, actor_id, actor_role, module, action, entity, entity_id, old_value, new_value, reason, approval_id, prev_hash, row_hash, " +
      "DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at FROM b2b_audit_logs WHERE row_hash IS NOT NULL AND id > ? ORDER BY id LIMIT 500", [after]);
    if (!rows.length) break;
    for (const r of rows) {
      if ((r.prev_hash || null) !== prev) return { ok: false, checked: checked, brokenAt: Number(r.id), reason: 'prev_hash does not match the previous row' };
      if (hashRow(r) !== r.row_hash) return { ok: false, checked: checked, brokenAt: Number(r.id), reason: 'row content does not match its hash' };
      prev = r.row_hash; checked++; after = Number(r.id);
    }
  }
  return { ok: true, checked: checked };
}

function actorFrom(req) {
  const p = req.erp;
  return { type: 'staff', id: p.id, label: p.email, role: p.roles.join(','), ip: String(req.ip || '').slice(0, 45),
    sessionId: p.sessionId, userAgent: req.headers['user-agent'] };
}

module.exports = { write, verifyChain, hashRow, canonical, actorFrom, SYSTEM: { type: 'system', id: null, role: 'system' } };
