/**
 * One finite background run — used by scripts/cron/run-jobs.js (Hostinger Cron Jobs) and by
 * POST /api/internal/cron/run. Steps, each independent (one failing does not stop the others):
 *
 *   1. shop catalogue: snapshot of the products file when it changed, the daily backup, and the
 *      integrity check of the four protected products (files only — works without MySQL);
 *   2. business platform (B2B_ENABLED, database configured, migration 004 applied):
 *        a. one run at a time (MySQL named lock; a second run exits at once),
 *        b. queue the recurring jobs whose slot has started (src/modules/erp/core/schedule.js),
 *        c. run due jobs until none are due, JOB_BATCH_SIZE were claimed or the time budget ran out,
 *        d. hand due messages from the notification outbox to the providers (same budget),
 *        e. record the run in b2b_jobs as job_type 'cron.run' (shown on the monitoring screen).
 *
 * Nothing is sent or changed beyond what the existing job handlers and outbox already do.
 * Resolves a summary; never throws.
 */
'use strict';
const jobsConfig = require('./jobs-config.js');

const RUN_LOCK = 'soh_cron_run';

async function runOnce(opts) {
  opts = opts || {};
  const trigger = opts.trigger || 'cron';
  const started = Date.now();
  const deadline = started + jobsConfig.timeBudgetSeconds(process.env, trigger) * 1000;
  const out = { trigger: trigger, mode: jobsConfig.mode(), startedAt: new Date(started).toISOString(), catalogue: null, business: null, errors: [] };

  // 1. shop catalogue (B2C files)
  try {
    const guard = require('../services/catalogueGuard.js');
    const protection = require('../services/productProtection.js');
    const { db } = require('../services/db.js');
    const snap = guard.snapshot();
    const backup = guard.autoBackup(false);
    const integrity = protection.verify(db.products.all());
    out.catalogue = { snapshot: snap.written ? 'written' : snap.reason, backup: backup.written ? 'written' : backup.reason, protectedProducts: integrity.ok ? 'ok' : 'FAILED' };
    if (!integrity.ok) out.errors.push('protected products: ' + integrity.problems.map(function (p) { return p.slug + ' — ' + p.problem; }).join('; '));
  } catch (e) { out.errors.push('catalogue: ' + e.message); }

  // 2. business platform (MySQL)
  try { out.business = await business(deadline); } catch (e) { out.errors.push('business: ' + (e.code || e.message)); out.business = { ran: false, reason: 'error' }; }

  out.finishedAt = new Date().toISOString();
  out.seconds = Math.round((Date.now() - started) / 100) / 10;
  out.ok = out.errors.length === 0;
  await record(out);
  return out;
}

async function business(deadline) {
  if (!require('../modules/b2b/config.js').enabled()) return { ran: false, reason: 'B2B_ENABLED is not true' };
  const db = require('../db/connection.js');
  if (!db.isConfigured()) return { ran: false, reason: 'database not configured' };
  const erp = require('../modules/erp/index.js');
  const erpOn = require('../modules/erp/config.js').enabled();
  const hasJobs = erpOn && (await erp.schemaReady());
  return db.withConnection(async function (lockConn) {
    const got = await lockConn.queryOne('SELECT GET_LOCK(?, 0) AS got', [RUN_LOCK]);
    if (!got || Number(got.got) !== 1) return { ran: false, reason: 'another run is in progress' };
    try {
      const r = { ran: true, schedule: null, jobs: null, notifications: null };
      if (hasJobs) {
        erp.registerHandlers();
        const jobs = require('../modules/erp/core/jobs.js');
        r.schedule = await require('../modules/erp/core/schedule.js').enqueueDue(new Date());
        r.jobs = await jobs.runFor({ deadline: deadline, max: jobsConfig.batchSize() });
      } else {
        r.schedule = erpOn ? 'migration 004 not applied' : 'ERP_ENABLED is not true';
      }
      r.notifications = await sendDue(deadline);
      return r;
    } finally {
      await lockConn.queryOne('SELECT RELEASE_LOCK(?) AS released', [RUN_LOCK]);
    }
  });
}

/** The outbox, in rounds of 15 (the outbox's own provider rate limits apply), until nothing is due or time is up. */
async function sendDue(deadline) {
  const n = require('../modules/b2b/notifications/service.js');
  const t = { processed: 0, sent: 0, failed: 0 };
  while (Date.now() < deadline) {
    let r;
    try { r = await n.processDue(15); } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return 'outbox table missing'; throw e; }
    if (r.skipped) break;
    t.processed += r.processed; t.sent += r.sent; t.failed += r.failed;
    if (!r.processed) break;
  }
  return t;
}

/** Observability: one 'cron.run' row per run with the summary (never secrets); a failed run is also a monitor event. */
async function record(out) {
  if (!out.business || !out.business.ran || !out.business.jobs) return;   // no ERP job table to write to
  const db = require('../db/connection.js');
  try {
    await db.query("INSERT INTO b2b_jobs (job_type, status, priority, payload_json, result_json, attempts, max_attempts, run_after, claimed_by, claimed_at, finished_at, last_error) " +
      "VALUES ('cron.run', ?, 9, ?, ?, 1, 1, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)",
      [out.ok ? 'done' : 'failed', JSON.stringify({ trigger: out.trigger, startedAt: out.startedAt }), JSON.stringify(out).slice(0, 60000),
        ('cron-' + process.pid).slice(0, 40), out.ok ? null : out.errors.join(' | ').slice(0, 500)]);
    if (!out.ok) await require('../modules/erp/core/monitor.js').event('job', 'warning', 'cron_run_problem', out.errors.join(' | '));
  } catch (e) { out.errors.push('record: ' + (e.code || e.message)); }
}

/** For the monitoring screen and the HTTP trigger: the last recorded run (null if none). */
async function lastRun() {
  const db = require('../db/connection.js');
  const r = await db.queryOne("SELECT status, finished_at, last_error FROM b2b_jobs WHERE job_type = 'cron.run' ORDER BY id DESC LIMIT 1");
  return r ? { status: r.status, at: r.finished_at, problem: r.last_error || null } : null;
}

module.exports = { runOnce, lastRun, RUN_LOCK };
