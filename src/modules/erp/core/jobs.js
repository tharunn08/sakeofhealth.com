/**
 * Background jobs (b2b_jobs). Same claim pattern as the existing notification
 * outbox: rows are claimed atomically with a unique marker, so two workers never
 * run the same job. Handlers must be idempotent; a failed job retries with
 * back-off and is then marked failed (visible on the monitoring screen).
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const monitor = require('./monitor.js');
const config = require('../config.js');

const handlers = {};
let timer = null, running = false;
const WORKER_ID = 'w-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');

function register(type, fn) { handlers[type] = fn; }

async function enqueue(q, type, payload, opts) {
  opts = opts || {};
  const run = q ? q.query.bind(q) : db.query;
  try {
    const r = await run('INSERT INTO b2b_jobs (job_type, payload_json, priority, run_after, dedupe_key, max_attempts, created_by) ' +
      'VALUES (?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? SECOND, ?, ?, ?)',
      [type, JSON.stringify(payload || {}), opts.priority || 5, Math.max(0, opts.delaySeconds || 0), opts.dedupeKey || null, opts.maxAttempts || 3, opts.createdBy || null]);
    return { jobId: r.insertId };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return { jobId: null, duplicate: true };
    throw e;
  }
}

async function runDue(limit) {
  if (running) return { skipped: true };
  running = true;
  const out = { done: 0, failed: 0, retried: 0 };
  try {
    // A worker that died mid-job leaves 'running' rows: release them after 30 minutes.
    await db.query("UPDATE b2b_jobs SET status = 'pending', claimed_by = NULL WHERE status = 'running' AND claimed_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE");
    const marker = WORKER_ID + ':' + crypto.randomBytes(4).toString('hex');
    const n = db.int(limit, 5, 1, 50);
    const claimed = await db.query("UPDATE b2b_jobs SET status = 'running', claimed_by = ?, claimed_at = UTC_TIMESTAMP(), attempts = attempts + 1 " +
      "WHERE status = 'pending' AND run_after <= UTC_TIMESTAMP() ORDER BY priority, id LIMIT " + n, [marker.slice(0, 40)]);
    if (!claimed.affectedRows) return out;
    const rows = await db.query("SELECT * FROM b2b_jobs WHERE status = 'running' AND claimed_by = ?", [marker.slice(0, 40)]);
    for (const job of rows) {
      const h = handlers[job.job_type];
      try {
        if (!h) throw new Error('no handler for ' + job.job_type);
        let payload = {}; try { payload = JSON.parse(job.payload_json || '{}'); } catch (e) { /* empty */ }
        const result = await h(payload, job);
        await db.query("UPDATE b2b_jobs SET status = 'done', finished_at = UTC_TIMESTAMP(), result_json = ?, last_error = NULL, dedupe_key = NULL WHERE id = ?",
          [JSON.stringify(result == null ? null : result).slice(0, 60000), job.id]);
        out.done++;
      } catch (e) {
        const msg = String(e && e.message || e).slice(0, 500);
        if (Number(job.attempts) >= Number(job.max_attempts)) {
          await db.query("UPDATE b2b_jobs SET status = 'failed', finished_at = UTC_TIMESTAMP(), last_error = ?, dedupe_key = NULL WHERE id = ?", [msg, job.id]);
          await monitor.event('job', 'warning', 'job_failed', job.job_type + ' #' + job.id + ': ' + msg, { refType: 'job', refId: job.id });
          out.failed++;
        } else {
          await db.query("UPDATE b2b_jobs SET status = 'pending', claimed_by = NULL, last_error = ?, run_after = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id = ?",
            [msg, Math.pow(4, Number(job.attempts)), job.id]);
          out.retried++;
        }
      }
    }
    return out;
  } finally { running = false; }
}

function start() {
  if (timer) return;
  timer = setInterval(function () { runDue().catch(function (e) { console.warn('[ERP JOBS]', e.code || e.message); }); }, config.workerIntervalMs());
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

async function get(id) { return db.queryOne('SELECT id, job_type, status, attempts, last_error, result_json, created_by, created_at, finished_at FROM b2b_jobs WHERE id = ?', [id]); }

module.exports = { register, enqueue, runDue, start, stop, get };
