#!/usr/bin/env node
'use strict';
/**
 * Runs every check of this project in one go and writes the results to test-results/<time>/.
 *
 *   node scripts/run-all-tests.js            → checks that need no database
 *   node scripts/run-all-tests.js --mysql    → the same, then the MySQL 8 suites on the throw-away
 *                                              test database named by TEST_DB_HOST / TEST_DB_USER /
 *                                              TEST_DB_NAME (password asked for, hidden; never stored)
 *
 * Nothing here touches production: the MySQL runner refuses anything that is not a dedicated
 * *_test database with a test-only account (see scripts/run-mysql-tests.js). Failures are never
 * hidden — the exit code is non-zero if any step failed, and every log is kept.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const wantMysql = process.argv.includes('--mysql');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(ROOT, 'test-results', stamp);
fs.mkdirSync(OUT, { recursive: true });

const steps = [];
function run(name, args, opts) {
  opts = opts || {};
  process.stdout.write('\n▶ ' + name + ' … ');
  const started = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: opts.interactive ? 'inherit' : 'pipe',
    env: Object.assign({}, process.env, opts.env || {}),
  });
  const log = opts.interactive ? '(output shown on screen; full logs are in ' + (opts.logDir || OUT) + ')\n' : (r.stdout || '') + (r.stderr || '');
  const file = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.log';
  fs.writeFileSync(path.join(OUT, file), log);
  const ok = r.status === 0;
  const detail = opts.summary ? opts.summary(log) : '';
  steps.push({ name: name, ok: ok, code: r.status, seconds: Math.round((Date.now() - started) / 1000), detail: detail, log: file });
  console.log((ok ? 'PASS' : 'FAIL') + (detail ? '  ' + detail : '') + '  (' + file + ')');
  return ok;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test-results') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const tapSummary = function (log) {
  const g = function (k) { const m = log.match(new RegExp('^# ' + k + ' (\\d+)', 'm')); return m ? m[1] : '?'; };
  return 'tests ' + g('tests') + ', pass ' + g('pass') + ', fail ' + g('fail') + ', skipped ' + g('skipped');
};

console.log('Sake of Health — all checks. Results folder: ' + OUT);
console.log('Node ' + process.version + (Number(process.versions.node.split('.')[0]) < 18 ? '  ← Node 18 or newer is required' : ''));

// 1. B2C protection
run('B2C guard', ['scripts/b2c-guard.js'], { summary: function (l) { return (l.trim().split('\n').pop() || '').slice(0, 110); } });
// 2. Build check
run('Build check', ['scripts/build.js'], { summary: function (l) { const m = l.match(/Build check passed[^\n]*/); return m ? m[0].slice(0, 110) : ''; } });
// 3. Syntax of every JavaScript file
{
  const files = walk(ROOT, []);
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(path.relative(ROOT, f) + '\n' + r.stderr);
  }
  fs.writeFileSync(path.join(OUT, 'syntax-check.log'), files.length + ' files checked\n' + (bad.length ? bad.join('\n') : 'no syntax errors\n'));
  steps.push({ name: 'Syntax check', ok: bad.length === 0, code: bad.length ? 1 : 0, seconds: 0, detail: bad.length + ' errors in ' + files.length + ' files', log: 'syntax-check.log' });
  console.log('\n▶ Syntax check … ' + (bad.length ? 'FAIL' : 'PASS') + '  ' + bad.length + ' errors in ' + files.length + ' files');
}
// 4. Every test that needs no database (the MySQL suites are listed in run-mysql-tests.js)
const mysqlSuites = new Set(require('./run-mysql-tests.js').SUITES.map(function (s) { return s + '.test.js'; }));
const dbFree = fs.readdirSync(path.join(ROOT, 'tests')).filter(function (f) { return f.endsWith('.test.js') && !mysqlSuites.has(f); }).sort()
  .map(function (f) { return path.join('tests', f); });
run('Tests without a database', ['--test', '--test-concurrency=1'].concat(dbFree), { summary: tapSummary });
// 5. Online shop regression (scenario 12)
run('Online shop regression', ['--test', 'tests/b2c-regression.test.js'], { summary: tapSummary });
// 6. MySQL 8 suites on the throw-away test database
if (wantMysql) {
  const missing = ['TEST_DB_HOST', 'TEST_DB_USER', 'TEST_DB_NAME'].filter(function (k) { return !process.env[k]; });
  if (missing.length) {
    fs.writeFileSync(path.join(OUT, 'mysql-8-suites.log'), 'Not started: set ' + missing.join(', ') + ' first (see START-HERE.txt).\n');
    steps.push({ name: 'MySQL 8 suites', ok: false, code: null, seconds: 0, detail: 'not started — set ' + missing.join(', '), log: 'mysql-8-suites.log' });
    console.log('\n▶ MySQL 8 suites … NOT STARTED  set ' + missing.join(', ') + ' first');
  } else {
    const dir = path.join(OUT, 'mysql');
    run('MySQL 8 suites', ['scripts/run-mysql-tests.js', '--out', dir], { interactive: true, logDir: dir });
  }
} else {
  steps.push({ name: 'MySQL 8 suites', ok: null, code: null, seconds: 0, detail: 'NOT RUN (add --mysql; needs the throw-away test database)', log: '' });
}

// Summary
const failed = steps.filter(function (s) { return s.ok === false; });
const notRun = steps.filter(function (s) { return s.ok === null; });
const lines = ['Sake of Health — all checks', 'When: ' + new Date().toISOString(), 'Node: ' + process.version, 'Folder: ' + ROOT, ''];
for (const s of steps) lines.push((s.ok === true ? 'PASS    ' : s.ok === false ? 'FAIL    ' : 'NOT RUN ') + s.name + (s.detail ? ' — ' + s.detail : '') + (s.log ? '  [' + s.log + ']' : ''));
lines.push('', failed.length ? 'RESULT: FAILED (' + failed.length + ' step(s)) — send the whole test-results folder' :
  notRun.length ? 'RESULT: PASSED without a database; MySQL 8 suites NOT RUN — the platform is not fully validated' :
  'RESULT: ALL PASSED, including the MySQL 8 suites');
fs.writeFileSync(path.join(OUT, 'SUMMARY.txt'), lines.join('\n') + '\n');
console.log('\n' + lines.slice(5).join('\n'));
console.log('\nResults: ' + OUT);
process.exit(failed.length ? 1 : 0);
