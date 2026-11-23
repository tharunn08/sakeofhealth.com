/**
 * Background work for Hostinger Business (no always-running worker): JOBS_MODE, the one schedule,
 * the finite job runner, the cron script and the secret-protected HTTP trigger. Database-free:
 * the MySQL behaviour (slot idempotency across processes, run lock, cleanup, after-commit sending)
 * is in jobs-cron.mysql.test.js.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, ROOT } = require('./helpers/server.js');

const jobsConfig = require('../src/platform/jobs-config.js');
const schedule = require('../src/modules/erp/core/schedule.js');
const jobs = require('../src/modules/erp/core/jobs.js');

test('JOBS_MODE: cron by default in production, inprocess otherwise; an explicit value wins', function () {
  assert.equal(jobsConfig.mode({ NODE_ENV: 'production' }), 'cron');
  assert.equal(jobsConfig.mode({ NODE_ENV: 'development' }), 'inprocess');
  assert.equal(jobsConfig.mode({}), 'inprocess');
  assert.equal(jobsConfig.mode({ NODE_ENV: 'production', JOBS_MODE: 'inprocess' }), 'inprocess');
  assert.equal(jobsConfig.mode({ NODE_ENV: 'development', JOBS_MODE: 'CRON' }), 'cron');
  assert.equal(jobsConfig.mode({ NODE_ENV: 'production', JOBS_MODE: 'nonsense' }), 'cron');
});

test('budgets and the HTTP trigger secret: bounds, the 90 s HTTP cap, short secrets switch the URL off', function () {
  assert.equal(jobsConfig.batchSize({}), 50);
  assert.equal(jobsConfig.batchSize({ JOB_BATCH_SIZE: '200' }), 200);
  assert.equal(jobsConfig.batchSize({ JOB_BATCH_SIZE: '0' }), 50);
  assert.equal(jobsConfig.timeBudgetSeconds({}), 240);
  assert.equal(jobsConfig.timeBudgetSeconds({}, 'http'), 90);
  assert.equal(jobsConfig.timeBudgetSeconds({ JOB_TIME_BUDGET_SECONDS: '60' }, 'http'), 60);
  assert.equal(jobsConfig.timeBudgetSeconds({ JOB_TIME_BUDGET_SECONDS: '5000' }), 240, 'out of range → default (Hostinger stops cron jobs at 30 min)');
  assert.equal(jobsConfig.cronSecret({}), null);
  assert.equal(jobsConfig.cronSecret({ CRON_SECRET: 'short' }), null);
  assert.equal(jobsConfig.cronSecret({ CRON_SECRET: 'x'.repeat(32) }), 'x'.repeat(32));
});

test('schedule: slots are UTC (1, 10 minutes, daily at 00:00) and labels fit the dedupe key', function () {
  const now = new Date('2026-11-19T10:47:31.250Z');
  assert.equal(schedule.slotStart(now, 1).toISOString(), '2026-11-19T10:47:00.000Z');
  assert.equal(schedule.slotStart(now, 10).toISOString(), '2026-11-19T10:40:00.000Z');
  assert.equal(schedule.slotStart(now, 1440).toISOString(), '2026-11-19T00:00:00.000Z');
  assert.equal(schedule.slotLabel(schedule.slotStart(now, 10)), '2026-11-19T10:40Z');
  for (const r of schedule.RECURRING) assert.ok((r.type + ':' + '2026-11-19T10:40Z').length <= 120 && r.type.length <= 40, r.type);
});

test('schedule: what is due depends only on the last job of each type — restarts and repeat runs queue nothing', function () {
  const now = new Date('2026-11-19T10:47:31Z');
  const all = schedule.dueJobs({}, now);
  assert.equal(all.length, schedule.RECURRING.length, 'nothing ever ran: everything is due once');
  assert.ok(all.every(function (d) { return d.dedupeKey === d.type + ':' + d.slot; }));

  // every type ran in its current slot → nothing is due (a second cron run, a restart, a redeploy)
  const ranNow = {};
  schedule.RECURRING.forEach(function (r) { ranNow[r.type] = schedule.slotStart(now, r.every); });
  assert.deepEqual(schedule.dueJobs(ranNow, now), []);

  // the daily jobs ran this morning; 10-minute jobs last ran at 10:39; the minute job at 10:46
  const last = {};
  schedule.RECURRING.forEach(function (r) {
    last[r.type] = r.every === 1440 ? new Date('2026-11-19T00:00:05Z') : r.every === 10 ? new Date('2026-11-19T10:39:00Z') : new Date('2026-11-19T10:46:10Z');
  });
  const due = schedule.dueJobs(last, now).map(function (d) { return d.type; }).sort();
  const expected = schedule.RECURRING.filter(function (r) { return r.every !== 1440; }).map(function (r) { return r.type; }).sort();
  assert.deepEqual(due, expected, 'daily jobs are not run again the same day');

  // the site slept for two days: each missed job is queued once, for the current slot only
  const stale = {}; schedule.RECURRING.forEach(function (r) { stale[r.type] = new Date('2026-11-17T08:00:00Z'); });
  const after = schedule.dueJobs(stale, now);
  assert.equal(after.length, schedule.RECURRING.length);
  assert.equal(after.find(function (d) { return d.type === 'audit.verify'; }).slot, '2026-11-19T00:00Z');
});

test('every scheduled job has a handler, and nothing registered is left unscheduled by accident', function () {
  require('../src/modules/erp/index.js').registerHandlers();
  const handlers = jobs.handlers();
  const scheduled = schedule.RECURRING.map(function (r) { return r.type; });
  assert.deepEqual(scheduled.filter(function (t) { return handlers.indexOf(t) === -1; }), []);
  assert.deepEqual(handlers.filter(function (t) { return scheduled.indexOf(t) === -1; }), [], 'a handler without a schedule must be queued by its own feature — add it here when that is intended');
});

test('runFor: stops when nothing is due, at the batch size, at the time budget, and never claims after the deadline', async function () {
  const fake = function (perRound, rounds) {
    const calls = [];
    return { calls: calls, step: async function (n) { calls.push(n); return calls.length > rounds ? { done: 0, failed: 0, retried: 0 } : { done: Math.min(n, perRound), failed: 0, retried: 0 }; } };
  };
  let f = fake(5, 2);
  let r = await jobs.runFor({ max: 50, deadline: Date.now() + 60000, step: f.step });
  assert.deepEqual([r.done, r.stoppedBy, f.calls.length], [10, 'nothing due', 3]);

  f = fake(5, 100);
  r = await jobs.runFor({ max: 12, deadline: Date.now() + 60000, step: f.step });
  assert.deepEqual([r.done, r.stoppedBy], [12, 'batch size']);
  assert.deepEqual(f.calls, [5, 5, 2], 'claims a few at a time, never more than the batch size');

  f = fake(5, 100);
  r = await jobs.runFor({ max: 1000, deadline: Date.now() - 1, step: f.step });
  assert.deepEqual([r.done, r.stoppedBy, f.calls.length], [0, 'time budget', 0], 'nothing is claimed after the deadline');

  const mixed = [{ done: 1, failed: 1, retried: 1 }, { done: 0, failed: 0, retried: 0 }];
  r = await jobs.runFor({ max: 50, deadline: Date.now() + 60000, step: async function () { return mixed.shift(); } });
  assert.deepEqual([r.done, r.failed, r.retried], [1, 1, 1]);
  r = await jobs.runFor({ step: async function () { return { skipped: true }; } });
  assert.equal(r.stoppedBy, 'another worker in this process');
});

test('JOBS_MODE=cron starts no scheduler or job worker in the web process; inprocess starts both', function () {
  const erp = require('../src/modules/erp/index.js');
  try {
    assert.deepEqual(erp.startTimers('cron'), ['shopstock.warm']);
  } finally { erp.stop(); }
  const warn = console.warn; console.warn = function () {};   // the first schedule tick finds no database here
  try {
    assert.deepEqual(erp.startTimers('inprocess'), ['schedule', 'jobs.worker', 'shopstock.warm']);
  } finally { erp.stop(); console.warn = warn; }
  // the trade portal's message sender follows the same rule
  const src = fs.readFileSync(path.join(ROOT, 'src/modules/b2b/index.js'), 'utf8');
  assert.match(src, /mode\(\) === 'inprocess'\) require\('\.\/notifications\/service\.js'\)\.startWorker\(\)/);
});

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function shopFolder() {
  const data = tmp('soh-cron-data-');
  // the real seed: the four protected products as the app creates them
  const r = spawnSync(process.execPath, ['-e', "require('./src/seed.js').seed({})"], { cwd: ROOT, env: Object.assign({}, process.env, { DATA_DIR: data, NODE_ENV: 'test' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return data;
}

test('cron script: one finite run — catalogue snapshot, daily backup, protected-product check — then it exits', function () {
  const data = shopFolder();
  const env = Object.assign({}, process.env, { NODE_ENV: 'test', DATA_DIR: data, CATALOGUE_DIR: path.join(data, 'cat'), BACKUP_DIR: path.join(data, 'bak'), B2B_ENABLED: 'false' });
  const r = spawnSync(process.execPath, ['scripts/cron/run-jobs.js', '--json'], { cwd: ROOT, env: env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(out.ok, true);
  assert.equal(out.trigger, 'cron');
  assert.deepEqual(out.catalogue, { snapshot: 'written', backup: 'written', protectedProducts: 'ok' });
  assert.deepEqual(out.business, { ran: false, reason: 'B2B_ENABLED is not true' });
  assert.ok(fs.readdirSync(path.join(data, 'cat')).some(function (n) { return /^products-.*\.json$/.test(n); }));
  // run again: idempotent — nothing new is written
  const again = spawnSync(process.execPath, ['scripts/cron/run-jobs.js', '--json'], { cwd: ROOT, env: env, encoding: 'utf8', timeout: 60000 });
  const out2 = JSON.parse(again.stdout.slice(again.stdout.indexOf('{')));
  assert.equal(out2.catalogue.backup, 'already backed up today');
  assert.match(out2.catalogue.snapshot, /same as the last snapshot|unchanged/);
});

test('cron script: a damaged protected catalogue is reported (exit 1), and production refuses an unsafe configuration (exit 78)', function () {
  const data = shopFolder();
  const file = path.join(data, 'products.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  list.find(function (p) { return p.id === 'soh-core-iron'; }).active = false;   // switched off behind the app's back
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  const env = Object.assign({}, process.env, { NODE_ENV: 'test', DATA_DIR: data, CATALOGUE_DIR: path.join(data, 'cat'), BACKUP_DIR: path.join(data, 'bak'), B2B_ENABLED: 'false' });
  const r = spawnSync(process.execPath, ['scripts/cron/run-jobs.js'], { cwd: ROOT, env: env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /protected products FAILED/);
  assert.match(r.stdout, /catalogue: protected products failed the integrity check — the last good snapshot is kept/);
  assert.ok(!fs.existsSync(path.join(data, 'cat')) || !fs.readdirSync(path.join(data, 'cat')).some(function (n) { return /^products-/.test(n); }), 'no snapshot of the damaged catalogue');
  assert.match(r.stderr, /protected products: .*iron/i);

  const bad = spawnSync(process.execPath, ['scripts/cron/run-jobs.js'], { cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { NODE_ENV: 'production', DATA_DIR: data, ADMIN_JWT_SECRET: 'short', SITE_URL: '', ADMIN_PASSWORD: '', CONFIG_STRICT: '' }) });
  assert.equal(bad.status, 78, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /Cron run refused/);
  assert.ok(!/short/.test(bad.stderr.replace(/shorter|too short/g, '')), 'secret values are never printed');
});

test('HTTP trigger: 404 without CRON_SECRET, 403 with a wrong secret, a run summary with the right one', async function () {
  const off = await startServer({ CRON_SECRET: '' });
  try {
    const r = await off.post('/api/internal/cron/run', undefined, { 'X-Cron-Secret': 'anything' });
    assert.equal(r.status, 404);
  } finally { await off.stop(); }

  const secret = 'cron-secret-for-tests-0123456789-abcdef';
  const on = await startServer({ CRON_SECRET: secret });
  try {
    assert.equal((await on.post('/api/internal/cron/run')).status, 403);
    assert.equal((await on.post('/api/internal/cron/run', undefined, { 'X-Cron-Secret': secret + 'x' })).status, 403);
    assert.equal((await on.get('/api/internal/cron/run', { 'X-Cron-Secret': secret })).status, 404, 'POST only');
    const r = await on.post('/api/internal/cron/run', undefined, { 'X-Cron-Secret': secret });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.trigger, 'http');
    assert.equal(r.data.catalogue.protectedProducts, 'ok');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(r.data).includes(secret), 'the secret is never echoed');
  } finally { await on.stop(); }
});
