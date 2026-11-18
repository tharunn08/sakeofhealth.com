#!/usr/bin/env node
/**
 * B2C protection check (design pack; becomes part of `npm run build` and CI in Phase 2).
 *
 *   node b2c-guard.js --repo <checkout> [--write-manifest]
 *
 * Fails (exit 1) when:
 *   1. any protected B2C file differs from b2c-manifest.json (or is missing / new under frontend/);
 *   2. any business-platform code imports the B2C JSON store (src/services/db.js) or other
 *      B2C services, except the one approved read-only adapter;
 *   3. any business-platform code writes files via DATA_DIR or imports B2C payment/order services.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const repo = path.resolve(args[args.indexOf('--repo') + 1] || '.');
const manifestPath = path.join(__dirname, 'b2c-manifest.json');
exports.run = null; // CLI only

// Protected = the customer website and everything it runs on.
const PROTECTED_DIRS = ['frontend'];
const PROTECTED_FILES = ['index.js', 'main.css', 'package.json', 'package-lock.json', 'src/server.js', 'src/seed.js',
  'src/routes/admin.js', 'src/routes/auth.js', 'src/routes/blog.js', 'src/routes/checkout.js', 'src/routes/shop.js', 'src/routes/track.js',
  'src/services/analytics.js', 'src/services/blogStore.js', 'src/services/blogTemplate.js', 'src/services/coupons.js', 'src/services/db.js',
  'src/services/notify.js', 'src/services/orders.js', 'src/services/payments.js', 'src/services/reports.js', 'src/services/store.js',
  'src/middleware/adminAuth.js', 'src/middleware/customerAuth.js', 'src/middleware/idempotency.js',
  'tests/b2c-regression.test.js'];
// The only business-platform file allowed to READ B2C data, once decision D12 approves it.
const ADAPTER_ALLOWLIST = ['src/modules/erp/b2cfeed/readonly-adapter.js'];
// Couplings that ALREADY exist in the shipped B2B module (found in the audit). They are
// frozen: allowed exactly as they are, reported every run, and no new ones may be added.
const GRANDFATHERED = {
  'src/modules/b2b/catalogue/service.js': ['services/db.js'],        // read-only "sync from B2C" catalogue import
  'src/modules/b2b/notifications/service.js': ['services/notify.js'], // shared email/WhatsApp sender (called, never edited)
  'src/modules/b2b/payments/service.js': ['services/payments.js'],    // gateway order + signature check (inherits B2C mock rules — see report)
  'src/modules/b2b/index.js': ['middleware/adminAuth.js'],            // B2B back office uses the existing admin login
  'src/modules/b2b/routes/admin.js': ['middleware/adminAuth.js'],
};

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push.apply(out, walk(p)); else out.push(p);
  });
  return out;
}
const rel = function (p) { return path.relative(repo, p).split(path.sep).join('/'); };
// Text files are hashed with CRLF normalised to LF, so a Windows checkout (git autocrlf)
// does not look like a change; binary files (images, fonts) are hashed as they are.
const TEXT = /\.(html?|css|js|json|md|txt|svg|xml)$/i;
const sha = function (p) {
  let buf = fs.readFileSync(p);
  if (TEXT.test(p)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
};

function currentList() {
  const files = PROTECTED_FILES.map(function (f) { return path.join(repo, f); });
  PROTECTED_DIRS.forEach(function (d) { files.push.apply(files, walk(path.join(repo, d))); });
  return files.filter(function (f) { return fs.existsSync(f); }).map(rel).sort();
}

if (args.indexOf('--write-manifest') !== -1) {
  const m = {};
  currentList().forEach(function (f) { m[f] = sha(path.join(repo, f)); });
  fs.writeFileSync(manifestPath, JSON.stringify({ createdFrom: path.basename(repo), files: m }, null, 1));
  console.log('manifest written: ' + Object.keys(m).length + ' protected files');
  process.exit(0);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files;
const problems = [], notes = [];
Object.keys(manifest).forEach(function (f) {
  const p = path.join(repo, f);
  if (!fs.existsSync(p)) problems.push('protected file missing: ' + f);
  else if (sha(p) !== manifest[f]) problems.push('protected file changed: ' + f);
});
currentList().forEach(function (f) { if (!manifest[f]) problems.push('new file inside protected area: ' + f); });

// Business-platform code must not reach into B2C.
// Any require() that RESOLVES to B2C code (routes, services, middleware of the customer site).
const B2C_TARGETS = PROTECTED_FILES.filter(function (f) { return /^src\/(routes|services|middleware)\//.test(f); });
const REQ = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
function b2cImports(file, text) {
  const out = []; let m; REQ.lastIndex = 0;
  while ((m = REQ.exec(text))) {
    if (m[1][0] !== '.') continue;
    let target = rel(path.resolve(path.dirname(file), m[1]));
    if (!/\.js$/.test(target)) target += '.js';
    if (B2C_TARGETS.indexOf(target) !== -1) out.push(target);
  }
  return out;
}
const DATA_DIR_WRITE = /(DATA_DIR|sakeofhealth-data)[\s\S]{0,200}(writeFile|appendFile|rename|unlink|rm\(|rmSync|mkdir|createWriteStream)/;
walk(path.join(repo, 'src', 'modules')).filter(function (f) { return /\.js$/.test(f); }).forEach(function (f) {
  const r = rel(f), text = fs.readFileSync(f, 'utf8');
  const allowed = ADAPTER_ALLOWLIST.indexOf(r) !== -1;
  const hits = b2cImports(f, text).map(function (t) { return t.replace(/^src\//, ''); });
  hits.forEach(function (h) {
    if (allowed) return;
    if ((GRANDFATHERED[r] || []).indexOf(h) !== -1) { notes.push('existing coupling (frozen): ' + r + ' → ' + h); return; }
    problems.push('business code imports B2C code: ' + r + ' → ' + h);
  });
  if (DATA_DIR_WRITE.test(text)) problems.push('business code may write into the B2C data folder: ' + r);
});

notes.forEach(function (n) { console.log('  note: ' + n); });
console.log(problems.length ? 'B2C PROTECTION FAILED\n  ' + problems.join('\n  ') : 'B2C protection OK — ' + Object.keys(manifest).length + ' protected files unchanged, no business code reaches into B2C');
process.exit(problems.length ? 1 : 0);
