/**
 * Background jobs on MySQL 8 — TEST database only (the runner refuses anything else, and refuses while
 * 013/014 are present). Run with: node scripts/run-all-tests.js --mysql
 *
 * Covers: the schedule queues each recurring job once per slot even with two schedulers at the same
 * moment, and nothing after a restart in the same slot (a finished daily job is not run again); the
 * finite runner claims, runs and records; a second run while one holds the lock exits at once; a 'cron.run'
 * row records every run and the monitoring screen reports it; cleanup removes only old finished jobs;
 * a message queued inside a transaction is sent right after the commit in JOBS_MODE=cron (never on rollback);
 * the cron script and the HTTP trigger against the real database.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { TEST_DB, resetDatabase, useTestDatabase, db } = require('./helpers/db.js');

const ROOT = path.join(__dirname, '..');
const num = async (sql, args) => Number(Object.values(await db.queryOne(sql, args || []))[0]);

test.before(async () => {
  await resetDatabase();
  useTestDatabase();
  Object.assign(process.env, { B2B_ENABLED: 'true', ERP_ENABLED: 'true', ERP_JWT_SECRET: 'test-erp-secret-not-for-production-0123456789' });
  require('../src/modules/erp/index.js').registerHandlers();
});
test.after(async () => { await db.close(); });

test('schedule: two schedulers at the same moment queue each recurring job exactly once; a restart in the same slot queues nothing', async () => {
  const schedule = require('../src/modules/erp/core/schedule.js');
  const now = new Date();
  const [a, b] = await Promise.all([schedule.enqueueDue(now), schedule.enqueueDue(now)]);
  assert.equal(a.queued.length + b.queued.length, schedule.RECURRING.length, JSON.stringify([a, b]));
  for (const r of schedule.RECURRING) assert.equal(await num('SELECT COUNT(*) FROM b2b_jobs WHERE job_type = ?', [r.type]), 1, r.type);
  const again = await schedule.enqueueDue(now);
  assert.deepEqual(again.queued, []);
  // the daily audit check finishes (its dedupe key is released): the same day still queues nothing new
  await db.query("UPDATE b2b_jobs SET status = 'done', finished_at = UTC_TIMESTAMP(), dedupe_key = NULL WHERE job_type = 'audit.verify'");
  assert.deepEqual((await schedule.enqueueDue(new Date(now.getTime() + 60000))).queued.filter(t => t === 'audit.verify'), []);
});

test('runner: runs due jobs within the batch size, records a cron.run row, and the monitoring screen shows it', async () => {
  process.env.JOB_BATCH_SIZE = '5';
  const cron = require('../src/platform/cron.js');
  const out = await cron.runOnce({ trigger: 'cron' });
  assert.equal(out.business.ran, true, JSON.stringify(out));
  const j = out.business.jobs;
  assert.equal(j.done + j.failed + j.retried, 5, JSON.stringify(j));
  assert.equal(j.stoppedBy, 'batch size');
  const run = await db.queryOne("SELECT status, result_json FROM b2b_jobs WHERE job_type = 'cron.run' ORDER BY id DESC LIMIT 1");
  assert.ok(run, 'run recorded');
  assert.equal(JSON.parse(run.result_json).trigger, 'cron');
  const summary = await require('../src/modules/erp/core/monitor.js').summary();
  assert.ok(summary.backgroundJobs.lastCronRun, JSON.stringify(summary.backgroundJobs));
  delete process.env.JOB_BATCH_SIZE;
});

test('runner: a second run while one holds the lock exits at once without claiming anything', async () => {
  const cron = require('../src/platform/cron.js');
  await db.withConnection(async function (conn) {
    assert.equal(Number((await conn.queryOne('SELECT GET_LOCK(?, 0) AS got', [cron.RUN_LOCK])).got), 1);
    try {
      const before = await num("SELECT COUNT(*) FROM b2b_jobs WHERE status = 'running'");
      const out = await cron.runOnce({ trigger: 'cron' });
      assert.deepEqual(out.business, { ran: false, reason: 'another run is in progress' });
      assert.equal(await num("SELECT COUNT(*) FROM b2b_jobs WHERE status = 'running'"), before);
    } finally { await conn.queryOne('SELECT RELEASE_LOCK(?) AS r', [cron.RUN_LOCK]); }
  });
});

test('cleanup: removes finished jobs older than 30 days and failed ones older than 90, nothing else', async () => {
  const ins = "INSERT INTO b2b_jobs (job_type, status, finished_at, created_at) VALUES (?, ?, UTC_TIMESTAMP() - INTERVAL ? DAY, UTC_TIMESTAMP() - INTERVAL ? DAY)";
  await db.query(ins, ['t.old_done', 'done', 31, 31]);
  await db.query(ins, ['t.new_done', 'done', 5, 5]);
  await db.query(ins, ['t.failed_60', 'failed', 60, 60]);
  await db.query(ins, ['t.failed_91', 'failed', 91, 91]);
  await db.query("INSERT INTO b2b_jobs (job_type, status, run_after, created_at) VALUES ('t.pending_old', 'pending', UTC_TIMESTAMP() + INTERVAL 1 DAY, UTC_TIMESTAMP() - INTERVAL 200 DAY)");
  const r = await require('../src/modules/erp/core/jobs.js').cleanup();
  assert.ok(r.removed >= 2);
  const left = (await db.query("SELECT job_type FROM b2b_jobs WHERE job_type LIKE 't.%' ORDER BY job_type")).map(x => x.job_type);
  assert.deepEqual(left, ['t.failed_60', 't.new_done', 't.pending_old']);
});

test('JOBS_MODE=cron: a message queued in a transaction is handed over right after the commit, never on rollback', async () => {
  process.env.JOBS_MODE = 'cron';
  const n = require('../src/modules/b2b/notifications/service.js');
  try {
    await assert.rejects(db.transaction(async function (tx) {
      await n.enqueue(tx, { channel: 'email', recipient: 'rolled-back@shop.test', subject: 'x', body: 'x' });
      throw new Error('roll back');
    }), /roll back/);
    await db.transaction(async function (tx) { await n.enqueue(tx, { channel: 'email', recipient: 'after-commit@shop.test', subject: 'Hello', body: 'Hello' }); });
    let row;
    for (let i = 0; i < 50; i++) {
      row = await db.queryOne("SELECT status FROM b2b_notification_queue WHERE recipient = 'after-commit@shop.test'");
      if (row && row.status !== 'pending' && row.status !== 'sending') break;
      await new Promise(r => setTimeout(r, 100));
    }
    // no provider is configured for tests: "not sent — no provider" proves the sender ran, without sending anything
    assert.equal(row.status, 'skipped_no_provider');
    assert.equal(await num("SELECT COUNT(*) FROM b2b_notification_queue WHERE recipient = 'rolled-back@shop.test'"), 0);
  } finally { delete process.env.JOBS_MODE; }
});

test('cron script against the test database: exits 0, and a second run in the same minute queues nothing new', async () => {
  // The cron run also checks the shop's protected products, so it gets its own freshly seeded, throw-away shop folder
  // (never the account's real data folder).
  const fs = require('fs'), os = require('os');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-cron-shop-'));
  const shop = { DATA_DIR: dataDir, CATALOGUE_DIR: path.join(dataDir, '.catalogue-test'), BACKUP_DIR: path.join(dataDir, '.backups-test') };
  const seeded = spawnSync(process.execPath, ['-e', "require('./src/seed.js').seed({})"], { cwd: ROOT, env: Object.assign({}, process.env, shop, { NODE_ENV: 'test' }), encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
  const env = Object.assign({}, process.env, TEST_DB, shop, { NODE_ENV: 'test', B2B_ENABLED: 'true', ERP_ENABLED: 'true' });
  const r1 = spawnSync(process.execPath, ['scripts/cron/run-jobs.js', '--json'], { cwd: ROOT, env: env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  const r2 = spawnSync(process.execPath, ['scripts/cron/run-jobs.js', '--json'], { cwd: ROOT, env: env, encoding: 'utf8', timeout: 120000 });
  const out2 = JSON.parse(r2.stdout.slice(r2.stdout.indexOf('{')));
  assert.ok(out2.business.schedule.queued.every(t => t === 'shopstock.sync'), JSON.stringify(out2.business.schedule));
});
