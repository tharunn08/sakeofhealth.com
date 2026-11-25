/**
 * Decision D5 (25 Nov 2026): migration versions 013 and 014 are retired. The files that carried those numbers
 * were byte-identical wrappers re-running migration 004; no database recorded them (production: 001–012,
 * 015–020). The runner never applies a file numbered 013 or 014, says so, and the next migration is 021.
 * DB-free: the folder listing and the database connection are stand-ins.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const db = require('../src/db/connection.js');
const migrate = require('../src/db/migrate.js');

async function withFolder(names, fn) {
  const real = fs.readdirSync;
  fs.readdirSync = function (dir, opts) { return String(dir).endsWith(path.join('db', 'migrations')) ? names.slice() : real.call(fs, dir, opts); };
  try { return await fn(); } finally { fs.readdirSync = real; }
}

test('013 and 014 are retired: never listed to run, reported apart', async () => {
  assert.deepEqual(Object.keys(migrate.RETIRED), ['013', '014']);
  const names = ['001_core_schema.sql', '004_core_governance.js', '012_finance.js', '013_erp_governance.js', '014_erp_governance.js', '015_identity_bootstrap.js', '020_manufacturing_delivery.js'];
  await withFolder(names, () => {
    assert.deepEqual(migrate.listFiles(), ['001_core_schema.sql', '004_core_governance.js', '012_finance.js', '015_identity_bootstrap.js', '020_manufacturing_delivery.js']);
    assert.deepEqual(migrate.retiredFiles().map((r) => r.file), ['013_erp_governance.js', '014_erp_governance.js']);
    assert.match(migrate.retiredFiles()[0].why, /D5/);
  });
});

test('the runner skips a retired file with a warning and applies nothing for it', async () => {
  const names = ['001_core_schema.sql', '013_erp_governance.js', '014_erp_governance.js', '015_identity_bootstrap.js'];
  const sent = [], logs = [];
  const conn = { raw: { query: async (sql) => {
    sent.push(sql);
    if (/GET_LOCK/.test(sql)) return [[{ got: 1 }]];
    if (/^SELECT version FROM/.test(sql)) return [[{ version: '001' }, { version: '015' }]];
    return [[]];
  } } };
  const real = db.withConnection;
  db.withConnection = async (fn) => fn(conn);
  try {
    const r = await withFolder(names, () => migrate.up((l) => logs.push(l)));   // the folder stand-in stays until up() finishes
    assert.deepEqual(r.applied, [], 'nothing applied: 001 and 015 are done, 013/014 are retired');
    assert.ok(!sent.some((s) => /INSERT INTO b2b_schema_migrations/.test(s)), 'no retired version is recorded');
    assert.deepEqual(logs.filter((l) => /skipped/.test(l)), ['⚠ skipped 013_erp_governance.js: retired by decision D5 (a copy of 004). Remove the file.', '⚠ skipped 014_erp_governance.js: retired by decision D5 (a copy of 004). Remove the file.']);
    assert.ok(sent.some((s) => /RELEASE_LOCK/.test(s)), 'the lock is released');
  } finally { db.withConnection = real; }
});

test('this repository holds no 013/014 files, and the newest migration is 020 (the next one is 021)', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'src', 'db', 'migrations')).filter((f) => /^\d{3}_/.test(f));
  assert.ok(!files.some((f) => /^01[34]_/.test(f)));
  assert.equal(files.sort().pop().slice(0, 3), '020');
});
