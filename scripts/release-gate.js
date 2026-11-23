#!/usr/bin/env node
/**
 * RELEASE GATE — a release may go out only when this exits 0. Used by CI (.github/workflows/quality-gate.yml)
 * and before any deployment by hand. It runs every check and BLOCKS when:
 *   - any check fails (B2C protection, build, syntax, every database-free test, shop regression);
 *   - the MySQL 8 suites did not run, or did not all pass (a release is never validated without them);
 *   - the environment templates are out of date with src/config/env-schema.js;
 *   - the four protected shop products fail the integrity check on a fresh shop;
 *   - migrations 013/014 (held back, decision D5) are present in the checkout.
 *
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_USER=soh_test TEST_DB_NAME=sakeofhealth_test [TEST_DB_PASSWORD=…] node scripts/release-gate.js
 *
 * The MySQL suites only ever use the dedicated *_test database and test-only account (scripts/run-mysql-tests.js
 * refuses anything else). Nothing here touches production. Results: test-results/<time>/ and RELEASE-GATE.txt.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const blocks = [], passes = [];
const run = function (args, opts) { return spawnSync(process.execPath, args, Object.assign({ cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, opts || {})); };

// 1. held-back migrations must not be in a release
const held = fs.readdirSync(path.join(ROOT, 'src', 'db', 'migrations')).filter(function (f) { return /^01[34]_/.test(f); });
if (held.length) blocks.push('migrations ' + held.join(', ') + ' are present (D5 pending) — they must not ship'); else passes.push('no held-back migration (013/014) in the checkout');

// 2. environment templates generated from the schema
const tpl = run(['scripts/env-templates.js', '--check']);
if (tpl.status !== 0) blocks.push('environment templates are out of date: ' + (tpl.stderr || tpl.stdout).trim().split('\n')[0]); else passes.push('environment templates match src/config/env-schema.js');

// 3. the four protected products on a fresh shop (the real seed, a throw-away folder)
const shop = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-gate-shop-'));
const seedEnv = Object.assign({}, process.env, { DATA_DIR: shop, NODE_ENV: 'test' });
const seeded = run(['-e', "require('./src/seed.js').seed({})"], { env: seedEnv });
const verify = seeded.status === 0 ? run(['scripts/protected-products.js', 'verify'], { env: seedEnv }) : seeded;
if (verify.status !== 0) blocks.push('protected products integrity check failed on a fresh shop: ' + (verify.stdout + verify.stderr).trim().split('\n').slice(-2).join(' ')); else passes.push('the four protected products pass the integrity check on a fresh shop');
fs.rmSync(shop, { recursive: true, force: true });

// 4. every check, including the MySQL 8 suites
const missing = ['TEST_DB_HOST', 'TEST_DB_USER', 'TEST_DB_NAME'].filter(function (k) { return !process.env[k]; });
if (missing.length) blocks.push('the MySQL 8 suites cannot run: ' + missing.join(', ') + ' not set (a release is never validated without them)');
const before = new Set(fs.existsSync(path.join(ROOT, 'test-results')) ? fs.readdirSync(path.join(ROOT, 'test-results')) : []);
const all = spawnSync(process.execPath, ['scripts/run-all-tests.js'].concat(missing.length ? [] : ['--mysql']), { cwd: ROOT, stdio: 'inherit', env: process.env });
const created = (fs.existsSync(path.join(ROOT, 'test-results')) ? fs.readdirSync(path.join(ROOT, 'test-results')) : []).filter(function (d) { return !before.has(d); }).sort();
const folder = created.length ? path.join(ROOT, 'test-results', created[created.length - 1]) : null;
const summary = folder && fs.existsSync(path.join(folder, 'SUMMARY.txt')) ? fs.readFileSync(path.join(folder, 'SUMMARY.txt'), 'utf8') : '';
const result = (summary.match(/^RESULT: .*$/m) || ['RESULT: no summary written'])[0];
if (all.status !== 0) blocks.push('checks failed — ' + result);
else if (!/ALL PASSED, including the MySQL 8 suites/.test(result)) blocks.push('not every check ran — ' + result);
else passes.push('all checks passed, including the MySQL 8 suites');

const lines = ['Sake of Health — release gate', 'When: ' + new Date().toISOString(), 'Node: ' + process.version, 'Results: ' + (folder || 'none'), ''];
passes.forEach(function (p) { lines.push('PASS     ' + p); });
blocks.forEach(function (b) { lines.push('BLOCKED  ' + b); });
lines.push('', blocks.length ? 'RELEASE BLOCKED (' + blocks.length + ' reason(s)). Do not deploy.' : 'RELEASE ALLOWED — every check passed, including the MySQL 8 suites.');
if (folder) fs.writeFileSync(path.join(folder, 'RELEASE-GATE.txt'), lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
process.exit(blocks.length ? 1 : 0);
