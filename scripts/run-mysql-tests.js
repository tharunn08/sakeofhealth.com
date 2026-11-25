#!/usr/bin/env node
/**
 * Runs the MySQL-backed test suites against a DEDICATED, DISPOSABLE MySQL 8 test
 * database and saves the raw output — the evidence for database-backed milestones.
 * The suites WIPE and rebuild the project tables in that database.
 *
 * Refuses before connecting when:
 *  - files numbered 013/014 are present in this checkout (retired copies of 004 — decision D5);
 *  - TEST_DB_NAME does not end in _test (only a dedicated test database; _dev/_local are refused);
 *  - TEST_DB_USER is missing or is root;
 *  - NODE_ENV is production.
 * Refuses after connecting (read-only checks, nothing changed) when:
 *  - the server is not MySQL 8;
 *  - the account has ANY privilege outside the test database (it must be able to
 *    touch nothing else on the server);
 *  - the test database contains tables that are not this project's (b2b_*),
 *    i.e. it is not a dedicated test database.
 * DB_* settings inherited from your shell are removed before the suites start, so
 * they can only ever reach TEST_DB_*.
 *
 * Usage (PowerShell or bash, from a fresh copy of the project; the password is asked for, hidden):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_USER=soh_test TEST_DB_NAME=sakeofhealth_test node scripts/run-mysql-tests.js --out test-results-mysql
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUITES = ['b2b-platform', 'erp-foundation', 'erp-catalog', 'erp-procurement', 'erp-operations', 'erp-integrations', 'erp-federation.mysql', 'identity-seed.mysql', 'notifications-reliability.mysql', 'inventory-ledger.mysql', 'notifications-center.mysql', 'notifications-consent.mysql', 'notifications-workflow.mysql', 'operations-channels.mysql', 'manufacturing-delivery.mysql', 'suppliers-salesmen-delivery.mysql', 'jobs-cron.mysql', 'field-app.mysql'];

/** Reasons not to run, before connecting. Pure (tested without a database). */
function preflight(env, migrationFiles) {
  const why = [];
  const held = migrationFiles.filter(f => /^01[34]_/.test(f));
  if (held.length) why.push('Migrations ' + held.join(', ') + ' are retired by decision D5 (copies of 004) and must not be in this checkout. Remove them or use a clean checkout.');
  const name = env.TEST_DB_NAME || '';
  if (!/^[A-Za-z0-9_]+_test$/.test(name)) why.push('TEST_DB_NAME "' + name + '" must be set to a dedicated test database whose name ends in _test (e.g. sakeofhealth_test). _dev and _local databases are refused — the suites wipe this database.');
  const user = env.TEST_DB_USER || '';
  if (!user) why.push('TEST_DB_USER must be set to the dedicated test account (e.g. soh_test).');
  else if (user.toLowerCase() === 'root') why.push('TEST_DB_USER is root. Use a dedicated account that only has rights on the test database.');
  if (env.NODE_ENV === 'production') why.push('NODE_ENV is production.');
  return why;
}

/** Privileges outside the test database, from SHOW GRANTS lines. Pure. */
function grantProblems(lines, dbName) {
  const db = String(dbName).replace(/_/g, '\\\\?_');   // SHOW GRANTS may print the name with escaped underscores
  const onTestDb = new RegExp('^GRANT .+ ON `' + db + '`\\.\\* TO ', 'i');
  return lines.filter(l => !/^GRANT USAGE ON \*\.\* TO /i.test(l) && !onTestDb.test(l));
}

/** Tables in the test database that are not this project's. Pure. */
function foreignTables(tableNames) {
  return tableNames.filter(t => !/^b2b_/.test(t));
}

/** Read-only checks on the server; returns {version, problems}. Nothing is created or changed. */
async function serverChecks(conn, dbName) {
  const version = (await conn.query('SELECT VERSION() AS v'))[0][0].v;
  const problems = [];
  if (!/^8\./.test(version)) problems.push('the server is MySQL ' + version + '; the project targets MySQL 8.');
  const grants = (await conn.query('SHOW GRANTS FOR CURRENT_USER()'))[0].map(r => Object.values(r)[0]);
  const extra = grantProblems(grants, dbName);
  if (extra.length) problems.push('the account has privileges outside ' + dbName + ' — it must only have rights on the test database:\n     ' + extra.join('\n     '));
  const tables = (await conn.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'))[0].map(r => r.t);
  const foreign = foreignTables(tables);
  if (foreign.length) problems.push(dbName + ' contains tables that are not this project\'s (' + foreign.slice(0, 5).join(', ') + (foreign.length > 5 ? ', …' : '') + ') — it is not a dedicated test database.');
  return { version, problems };
}

/** Environment for the suites: inherited DB_* removed, TEST_DB_* (with the password) set. */
function childEnv(env, password) {
  const out = Object.assign({}, env);
  Object.keys(out).forEach(k => { if (/^DB_/.test(k) || k === 'TEST_FRESH_DB_NAME') delete out[k]; });
  out.TEST_DB_PASSWORD = password;
  out.NODE_ENV = 'test';
  return out;
}

async function main() {
  const why = preflight(process.env, fs.readdirSync(path.join(ROOT, 'src', 'db', 'migrations')));
  if (why.length) { console.error('Refusing to run the MySQL suites:\n - ' + why.join('\n - ')); process.exit(2); }
  const env = process.env;
  const password = env.TEST_DB_PASSWORD != null ? env.TEST_DB_PASSWORD : await require('./lib/hidden-prompt.js')('Password for ' + env.TEST_DB_USER + ' (test account): ');
  let checks;
  try {
    const conn = await require('mysql2/promise').createConnection({ host: env.TEST_DB_HOST || '127.0.0.1', port: Number(env.TEST_DB_PORT || 3306), user: env.TEST_DB_USER,
      password, database: env.TEST_DB_NAME, connectTimeout: 10000 });
    try { checks = await serverChecks(conn, env.TEST_DB_NAME); } finally { await conn.end(); }
  } catch (e) { console.error('Cannot reach the test database: ' + e.message); process.exit(3); }
  if (checks.problems.length) { console.error('Refusing to run the MySQL suites:\n - ' + checks.problems.join('\n - ')); process.exit(4); }

  const i = process.argv.indexOf('--out');
  const out = path.resolve(i !== -1 ? process.argv[i + 1] : 'test-results-mysql');
  fs.mkdirSync(out, { recursive: true });
  const summary = ['MySQL test run — server ' + checks.version + ', database ' + env.TEST_DB_NAME + ' (dedicated test account ' + env.TEST_DB_USER + '), ' + new Date().toISOString(), ''];
  let failed = 0;
  for (const s of SUITES) {
    process.stdout.write('running ' + s + ' …\n');
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', 'tests/' + s + '.test.js'], { cwd: ROOT, env: childEnv(env, password), encoding: 'utf8', timeout: 20 * 60000 });
    const tap = (r.stdout || '') + (r.stderr || '');
    // Never write the password, even if a library echoed it.
    fs.writeFileSync(path.join(out, s + '.tap.txt'), password && password.length >= 4 ? tap.split(password).join('***') : tap);
    const n = k => (tap.match(new RegExp('^# ' + k + ' (\\d+)', 'm')) || [0, '?'])[1];
    if (r.status !== 0) failed++;
    summary.push(s.padEnd(22) + ' tests ' + n('tests') + '  pass ' + n('pass') + '  fail ' + n('fail') + '  skipped ' + n('skipped') + '  exit ' + r.status);
  }
  fs.writeFileSync(path.join(out, 'SUMMARY.txt'), summary.join('\n') + '\n');
  console.log('\n' + summary.join('\n') + '\n\nRaw output: ' + out);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
module.exports = { preflight, grantProblems, foreignTables, serverChecks, childEnv, SUITES };
