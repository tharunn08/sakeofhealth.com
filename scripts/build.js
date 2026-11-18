#!/usr/bin/env node
/**
 * Build step for Hostinger ("npm run build").
 *
 * The site ships plain HTML/CSS/JS, so there is nothing to compile. This
 * script is a pre-flight check instead: it fails the deploy early — before
 * Hostinger restarts the app — if a file has a syntax error, a required
 * dependency is missing or a migration file is malformed.
 *
 * It never connects to a database and never changes any data.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const problems = [];
let checked = 0;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'vendor') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.js$/.test(name)) out.push(full);
  }
  return out;
}

// 1. Node version
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) problems.push('Node.js 18 or newer is required (found ' + process.versions.node + '). Set the Node version to 20 or 22 in Hostinger.');

// 2. Syntax-check every JavaScript file we ship
const files = [path.join(ROOT, 'index.js')];
for (const d of ['src', 'scripts', 'frontend', 'b2b-web']) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walk(full, files);
}
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  checked++;
  if (r.status !== 0) problems.push('Syntax error in ' + path.relative(ROOT, f) + '\n' + String(r.stderr).split('\n').slice(0, 6).join('\n'));
}

// 3. Runtime dependencies resolve
const pkg = require(path.join(ROOT, 'package.json'));
for (const dep of Object.keys(pkg.dependencies || {})) {
  try { require.resolve(dep, { paths: [ROOT] }); }
  catch (e) { problems.push('Dependency "' + dep + '" is not installed — run npm install.'); }
}

// 4. Migrations: numbered, unique, ordered
const migDir = path.join(ROOT, 'src', 'db', 'migrations');
const migs = fs.existsSync(migDir) ? fs.readdirSync(migDir).filter(f => /\.(sql|js)$/.test(f)).sort() : [];
const seen = new Set();
for (const m of migs) {
  const match = /^(\d{3})_[a-z0-9_]+\.(sql|js)$/.exec(m);
  if (!match) { problems.push('Migration "' + m + '" must be named NNN_description.sql|js'); continue; }
  if (seen.has(match[1])) problems.push('Two migrations share the number ' + match[1]);
  seen.add(match[1]);
}

// 5. Pages the server serves must exist
for (const f of ['frontend/index.html', 'frontend/admin/index.html', 'frontend/admin/print.html',
  'b2b-web/portal/login.html', 'b2b-web/portal/register.html', 'b2b-web/portal/app.html', 'b2b-web/admin/dashboard.html']) {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push('Missing page: ' + f);
}

// 6. Secrets must never be part of the build
for (const f of ['.env']) {
  if (fs.existsSync(path.join(ROOT, f))) {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', f], { cwd: ROOT, encoding: 'utf8' });
    if (tracked.status === 0) problems.push(f + ' is committed to git. Remove it (git rm --cached ' + f + ') and rotate every secret in it.');
  }
}

// 7. The customer website must be byte-for-byte unchanged and no business code may reach into it
const guard = spawnSync(process.execPath, [path.join(__dirname, 'b2c-guard.js'), '--repo', ROOT], { encoding: 'utf8' });
if (guard.status !== 0) problems.push('B2C protection check failed:\n' + String(guard.stdout).split('\n').filter(function (l) { return /^\s{2}(?!note)/.test(l); }).join('\n'));

if (problems.length) {
  console.error('\nBuild check FAILED:\n');
  for (const p of problems) console.error(' ✗ ' + p + '\n');
  process.exit(1);
}
console.log('Build check passed — ' + checked + ' JavaScript files, ' + Object.keys(pkg.dependencies || {}).length +
  ' dependencies, ' + migs.length + ' migrations. Nothing to compile; start with "npm start".');
