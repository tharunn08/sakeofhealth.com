/**
 * Monitoring: security and operations events (b2b_monitor_events) and the
 * summary shown on the monitoring screen. Writing an event never throws —
 * monitoring must not break the action being monitored.
 */
'use strict';
const db = require('../../../db/connection.js');

const CATEGORIES = ['auth', 'otp', 'api', 'notification', 'database', 'job', 'backup', 'storage', 'inventory', 'staff', 'migration', 'b2c'];

async function event(category, severity, code, message, ctx) {
  ctx = ctx || {};
  if (CATEGORIES.indexOf(category) === -1) category = 'api';
  try {
    await db.query(
      'INSERT INTO b2b_monitor_events (category, severity, code, message, actor_type, actor_id, ip, ref_type, ref_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [category, severity, String(code).slice(0, 60), String(message).slice(0, 500), ctx.actorType || null,
        ctx.actorId == null ? null : String(ctx.actorId), ctx.ip || null, ctx.refType || null, ctx.refId == null ? null : String(ctx.refId)]);
  } catch (e) {
    console.error('[ERP MONITOR] could not record event', code, e.code || e.message);
  }
}

/** Only real figures from the database; anything not yet built is reported as not available. */
async function summary() {
  const out = { generatedAt: new Date().toISOString() };
  const ping = await db.ping(0);
  out.database = ping.ok ? 'up' : 'down';
  const last24 = 'created_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY';
  const ev = await db.query('SELECT category, code, COUNT(*) AS n FROM b2b_monitor_events WHERE ' + last24 + ' GROUP BY category, code ORDER BY n DESC LIMIT 50');
  out.events24h = ev.map(function (r) { return { category: r.category, code: r.code, count: Number(r.n) }; });
  const open = await db.queryOne("SELECT COUNT(*) AS n FROM b2b_monitor_events WHERE acknowledged_at IS NULL AND severity = 'critical'");
  out.openCritical = Number(open.n);
  const q = await db.query("SELECT status, COUNT(*) AS n FROM b2b_notification_queue GROUP BY status");
  out.notificationQueue = {}; q.forEach(function (r) { out.notificationQueue[r.status] = Number(r.n); });
  const jobs = await db.query("SELECT status, COUNT(*) AS n FROM b2b_jobs GROUP BY status");
  out.jobs = {}; jobs.forEach(function (r) { out.jobs[r.status] = Number(r.n); });
  const backup = await db.queryOne("SELECT finished_at, status FROM b2b_jobs WHERE job_type = 'backup.run' ORDER BY id DESC LIMIT 1");
  out.lastBackup = backup ? { at: backup.finished_at, status: backup.status } : { status: 'none recorded by the ERP worker' };
  const migs = await db.query('SELECT version, name, applied_at FROM b2b_schema_migrations ORDER BY version');
  out.migrations = migs.map(function (m) { return m.name; });
  const rec = await db.queryOne("SELECT finished_at, status, result_json FROM b2b_jobs WHERE job_type = 'inventory.reconcile' ORDER BY id DESC LIMIT 1");
  out.inventoryReconciliation = rec ? { at: rec.finished_at, status: rec.status, result: rec.result_json ? JSON.parse(rec.result_json) : null } : 'not run yet (daily job, or GET /api/erp/inventory/reconciliation)';
  return out;
}

async function list(q) {
  const where = ['1=1'], params = [];
  if (q.category) { where.push('category = ?'); params.push(String(q.category)); }
  if (q.severity) { where.push('severity = ?'); params.push(String(q.severity)); }
  if (q.open === 'true') where.push('acknowledged_at IS NULL');
  const limit = db.int(q.limit, 50, 1, 200);
  const before = db.int(q.before, 0, 0, Number.MAX_SAFE_INTEGER);
  if (before) { where.push('id < ?'); params.push(before); }
  return db.query('SELECT * FROM b2b_monitor_events WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ' + limit, params);
}

async function acknowledge(id, staffId) {
  const r = await db.query('UPDATE b2b_monitor_events SET acknowledged_by = ?, acknowledged_at = UTC_TIMESTAMP() WHERE id = ? AND acknowledged_at IS NULL', [staffId, id]);
  return r.affectedRows === 1;
}

module.exports = { event, summary, list, acknowledge, CATEGORIES };
