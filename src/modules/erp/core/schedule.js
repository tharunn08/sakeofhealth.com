/**
 * Recurring background work — ONE schedule for both JOBS_MODE values. Each run of the scheduler
 * (the cron script, the HTTP trigger, or the 60-second timer with JOBS_MODE=inprocess) queues every
 * recurring job whose time slot has started and has no job yet, into the existing queue (b2b_jobs).
 *
 * Idempotent: the last job of each type is read from b2b_jobs (index ix_b2b_jobs_type), under a MySQL
 * named lock so two schedulers never queue the same slot, and the dedupe key "<type>:<slot>" refuses a
 * second copy while one is still queued. A restart, a redeploy or a second cron run in the same slot
 * therefore queues nothing new; a missed slot (the site was asleep) is queued once on the next run.
 */
'use strict';
const db = require('../../../db/connection.js');
const jobs = require('./jobs.js');

const MINUTE = 60 * 1000;
/** every = minutes. Daily slots start at 00:00 UTC. */
const RECURRING = [
  { type: 'shopstock.sync', every: 1, what: 'shop stock catch-up (does nothing while the mode is off)' },
  { type: 'shopstock.auto_refunds', every: 10, what: 'refunds that fell due' },
  { type: 'catalog.publish_due', every: 10, what: 'approved price lists whose start time has come' },
  { type: 'sales.expire_holds', every: 10, what: 'salesman stock holds that expired' },
  { type: 'b2c.feed', every: 10, what: 'read-only shop sales feed (when switched on)' },
  { type: 'deliveries.sync', every: 10, what: 'shipments catch up with orders moved elsewhere' },
  { type: 'deliveries.alert_late', every: 10, what: 'late shipments and late manufacturer deliveries, alerted once' },
  { type: 'audit.verify', every: 1440, what: 'audit chain check' },
  { type: 'inventory.reconcile', every: 1440, what: 'stock balances against the ledger and batches' },
  { type: 'notifications.stock_alerts', every: 1440, what: 'one reorder alert a day' },
  { type: 'customers.import', every: 1440, what: 'shop customers linked to business accounts (when switched on)' },
  { type: 'inventory.expire_batches', every: 1440, what: 'expired batches leave available stock' },
  { type: 'jobs.cleanup', every: 1440, what: 'finished jobs older than 30 days are removed (failed: 90 days)' },
];
const LOCK = 'soh_jobs_schedule';

/** Start of the slot that contains `now` (UTC). */
function slotStart(now, everyMinutes) {
  const t = now.getTime();
  return new Date(t - (t % (everyMinutes * MINUTE)));
}
/** "2026-11-19T10:40Z" — part of the dedupe key (max 120 characters with the type). */
function slotLabel(d) { return d.toISOString().slice(0, 16) + 'Z'; }

/** Pure: which recurring jobs are due, given the time of the last job of each type (Date or null). */
function dueJobs(lastByType, now) {
  return RECURRING.filter(function (r) {
    const last = lastByType[r.type];
    return !last || new Date(last).getTime() < slotStart(now, r.every).getTime();
  }).map(function (r) { const s = slotStart(now, r.every); return { type: r.type, slot: slotLabel(s), dedupeKey: r.type + ':' + slotLabel(s) }; });
}

/**
 * Queue what is due. Resolves { queued: [types], duplicates, skipped? }. Only one scheduler at a time
 * (GET_LOCK); a scheduler that cannot get the lock within 5 s does nothing — the other one is queueing.
 */
async function enqueueDue(now) {
  now = now || new Date();
  return db.withConnection(async function (conn) {
    const got = await conn.queryOne('SELECT GET_LOCK(?, 5) AS got', [LOCK]);
    if (!got || Number(got.got) !== 1) return { queued: [], duplicates: 0, skipped: 'another scheduler is queueing' };
    try {
      const types = RECURRING.map(function (r) { return r.type; });
      const rows = await conn.query('SELECT job_type, MAX(created_at) AS last_at FROM b2b_jobs WHERE job_type IN (' + db.placeholders(types) + ') GROUP BY job_type', types);
      const last = {};
      rows.forEach(function (r) { last[r.job_type] = r.last_at; });
      const out = { queued: [], duplicates: 0 };
      for (const d of dueJobs(last, now)) {
        const r = await jobs.enqueue(conn, d.type, { slot: d.slot }, { dedupeKey: d.dedupeKey });
        if (r.duplicate) out.duplicates++; else out.queued.push(d.type);
      }
      return out;
    } finally {
      await conn.queryOne('SELECT RELEASE_LOCK(?) AS released', [LOCK]);
    }
  });
}

module.exports = { RECURRING, slotStart, slotLabel, dueJobs, enqueueDue, LOCK };
