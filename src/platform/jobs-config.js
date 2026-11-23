/**
 * How background work runs (docs/unified/BACKGROUND-JOBS.md).
 *
 *   JOBS_MODE=cron       (production default) nothing runs on timers inside the web process except two
 *                        cheap per-process cache refreshes; Hostinger Cron Jobs run scripts/cron/run-jobs.js,
 *                        a finite script that schedules, runs and records the work, then exits.
 *   JOBS_MODE=inprocess  (development default) timers in the web process do the same work.
 *
 * JOB_BATCH_SIZE caps the jobs one run claims; JOB_TIME_BUDGET_SECONDS stops a run from claiming new
 * work after that long (the HTTP trigger caps it at 90 s, below Hostinger's 120 s request limit).
 * CRON_SECRET (32+ characters) switches on POST /api/internal/cron/run; empty = that URL answers 404.
 */
'use strict';

const HTTP_CAP_SECONDS = 90;

function mode(env) {
  env = env || process.env;
  const v = String(env.JOBS_MODE || '').trim().toLowerCase();
  if (v === 'cron' || v === 'inprocess') return v;
  return env.NODE_ENV === 'production' ? 'cron' : 'inprocess';
}
function int(v, def, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}
function batchSize(env) {
  env = env || process.env;
  return int(env.JOB_BATCH_SIZE, 50, 1, 1000);
}
function timeBudgetSeconds(env, trigger) {
  env = env || process.env;
  const s = int(env.JOB_TIME_BUDGET_SECONDS, 240, 10, 1500);
  return trigger === 'http' ? Math.min(s, HTTP_CAP_SECONDS) : s;
}
/** The secret for the HTTP trigger, or null when it is switched off (unset or too short to be safe). */
function cronSecret(env) {
  env = env || process.env;
  const s = String(env.CRON_SECRET || '');
  return s.length >= 32 ? s : null;
}

module.exports = { mode, batchSize, timeBudgetSeconds, cronSecret, HTTP_CAP_SECONDS };
