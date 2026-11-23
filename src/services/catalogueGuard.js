/**
 * Catalogue guard — the shop's products survive redeploys, migrations and a wrong data folder.
 *
 * What it does (called once at start-up from server.js, then runs quietly):
 *  1. If the shop's data folder is COMPLETELY empty (no products, orders, customers, accounts, staff)
 *     and an automatic backup exists, the latest backup is restored in full. This is what happens
 *     when a redeploy or migration points the shop at a new, empty folder.
 *  2. If there are no products, they are restored from the latest catalogue snapshot (your own
 *     edits: prices, stock, images…). With no snapshot at all, the four protected products are
 *     created from the registry (src/catalogue/protected-products.json).
 *  3. Each of the four core products (multivitamin, iron, curcumin, probiotic) must exist. A missing
 *     one is put back — from the latest snapshot if it was there, else from the core file.
 *  4. Every minute, when products.json has changed, a snapshot is written OUTSIDE the site folder
 *     (CATALOGUE_DIR, default ~/sakeofhealth-catalogue; the newest 60 are kept).
 *  5. Once a day (and at start-up) all shop data files are copied to BACKUP_DIR
 *     (default ~/sakeofhealth-backups/auto-YYYYMMDD; the newest 14 days are kept).
 *
 *  6. Integrity: identity drift (name, slug, category, hidden) is set back to the registry and logged;
 *     problems that need a person (a duplicate, a wrong id) are reported. In production the server
 *     then refuses to start (PROTECTED_PRODUCTS_STRICT, default on in production) instead of selling
 *     from a damaged catalogue — fix the data or restore a backup, then start again.
 * The store refuses to delete, deactivate or re-identify a protected product (productProtection.js).
 * Nothing here ever deletes or overwrites a product that exists; it only adds what is missing.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const protection = require('./productProtection.js');
/** The four protected products as restore records: registry identity + the restore values (no invented SKU or stock). */
const CORE = protection.PRODUCTS.map(function (e) {
  return Object.assign({}, e.restore, protection.identityOf(e), { sku: e.sku || '', active: true, upcoming: false });
});
const SHOP_FILES = ['orders', 'products', 'coupons', 'customers', 'accounts', 'reviews', 'staff', 'deliveries', 'settings', 'events'];
const KEEP_SNAPSHOTS = 60, KEEP_BACKUP_DAYS = 14;

const testMode = function () { return process.env.NODE_ENV === 'test'; };
function dataDir() { return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data'); }
/** Outside the site folder by default; under the data folder only while testing (never the tester's home). */
function catalogueDir() {
  if (process.env.CATALOGUE_DIR) return path.resolve(process.env.CATALOGUE_DIR);
  return testMode() ? path.join(dataDir(), '.catalogue-test') : path.join(os.homedir(), 'sakeofhealth-catalogue');
}
function backupDir() {
  if (process.env.BACKUP_DIR) return path.resolve(process.env.BACKUP_DIR);
  return testMode() ? path.join(dataDir(), '.backups-test') : path.join(os.homedir(), 'sakeofhealth-backups');
}
function stamp(d) { return (d || new Date()).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); }
function readJsonArray(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v : null; } catch (e) { return null; }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function sha(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function isCore(product) { return protection.isProtected(product); }

/* ── catalogue snapshots ── */
let lastSnapshotHash = null;
/** The newest valid, non-empty snapshot (array of products), or null. */
function latestSnapshot() {
  const dir = catalogueDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter(function (n) { return /^products-\d{8}-\d{6}\.json$/.test(n); }).sort().reverse(); } catch (e) { return null; }
  for (const n of names) {
    const arr = readJsonArray(path.join(dir, n));
    if (arr && arr.length) return { file: n, products: arr };
  }
  return null;
}
/** Write a snapshot when products.json changed (and is a valid, non-empty list). */
function snapshot() {
  let text;
  try { text = fs.readFileSync(path.join(dataDir(), 'products.json'), 'utf8'); } catch (e) { return { written: false, reason: 'no products file' }; }
  let arr;
  try { arr = JSON.parse(text); } catch (e) { return { written: false, reason: 'products file is not valid JSON' }; }
  if (!Array.isArray(arr) || !arr.length) return { written: false, reason: 'no products' };
  // A snapshot is a restore point: never take one of a catalogue whose protected products are damaged.
  if (!protection.verify(arr).ok) return { written: false, reason: 'protected products failed the integrity check — the last good snapshot is kept' };
  const h = sha(text);
  if (h === lastSnapshotHash) return { written: false, reason: 'unchanged' };
  const dir = catalogueDir();
  const latest = latestSnapshot();
  if (latest && sha(JSON.stringify(latest.products, null, 2)) === sha(JSON.stringify(arr, null, 2))) { lastSnapshotHash = h; return { written: false, reason: 'same as the last snapshot' }; }
  const name = 'products-' + stamp() + '.json';
  writeAtomic(path.join(dir, name), JSON.stringify(arr, null, 2));
  lastSnapshotHash = h;
  try {   // keep the newest KEEP_SNAPSHOTS
    fs.readdirSync(dir).filter(function (n) { return /^products-\d{8}-\d{6}\.json$/.test(n); }).sort().reverse().slice(KEEP_SNAPSHOTS)
      .forEach(function (n) { fs.unlinkSync(path.join(dir, n)); });
  } catch (e) { /* pruning is best effort */ }
  return { written: true, file: name, products: arr.length };
}

/* ── whole-shop automatic backups ── */
function latestBackup() {
  const dir = backupDir();
  let names = [];
  // auto-YYYYMMDD (this guard, daily) and backup-YYYYMMDD-HHMMSS/b2c-data (npm run backup): newest first
  const key = function (n) { return n.replace(/\D/g, '').padEnd(14, '0'); };
  try { names = fs.readdirSync(dir).filter(function (n) { return /^(auto|backup)-\d{8}/.test(n); }).sort(function (a, b) { return key(b).localeCompare(key(a)); }); } catch (e) { return null; }
  for (const n of names) {
    const p = /^backup-/.test(n) ? path.join(dir, n, 'b2c-data') : path.join(dir, n);
    const prods = readJsonArray(path.join(p, 'products.json'));
    if (prods && prods.length) return p;
  }
  return null;
}
/** Copy every shop data file to BACKUP_DIR/auto-YYYYMMDD (once per day; the newest KEEP_BACKUP_DAYS kept). */
function autoBackup(force) {
  const dir = path.join(backupDir(), 'auto-' + stamp().slice(0, 8));
  if (!force && fs.existsSync(path.join(dir, 'DONE'))) return { written: false, reason: 'already backed up today' };
  const src = dataDir();
  const present = SHOP_FILES.filter(function (n) { return fs.existsSync(path.join(src, n + '.json')); });
  const prods = readJsonArray(path.join(src, 'products.json'));
  if (!present.length || !prods || !prods.length) return { written: false, reason: 'nothing worth backing up (no products)' };
  fs.mkdirSync(dir, { recursive: true });
  present.forEach(function (n) { fs.copyFileSync(path.join(src, n + '.json'), path.join(dir, n + '.json')); });
  fs.writeFileSync(path.join(dir, 'DONE'), new Date().toISOString() + '\n' + src + '\n');
  try {
    fs.readdirSync(backupDir()).filter(function (n) { return /^auto-\d{8}$/.test(n); }).sort().reverse().slice(KEEP_BACKUP_DAYS)
      .forEach(function (n) { fs.rmSync(path.join(backupDir(), n), { recursive: true, force: true }); });
  } catch (e) { /* pruning is best effort */ }
  return { written: true, dir: dir, files: present.length };
}

/** A file that exists but is not a valid list is kept aside (never overwritten) before anything is restored over it. */
function keepAside(file, log) {
  if (!fs.existsSync(file)) return null;
  const a = readJsonArray(file);
  if (a && !a.length) return null;
  if (a) return null;
  const to = file + '.unreadable-' + stamp();
  fs.copyFileSync(file, to);
  log.warn('[CATALOGUE] ' + file + ' could not be read; a copy was kept as ' + to + '.');
  return to;
}

/**
 * Start-up check. db = the shop's JSON store. Returns what was done (also logged).
 * Never removes or overwrites an existing record.
 */
function ensure(db, log) {
  log = log || console;
  const done = { restoredBackup: null, restoredFrom: null, restoredCore: [], keptAside: [] };
  const src = dataDir();
  SHOP_FILES.forEach(function (n) { const k = keepAside(path.join(src, n + '.json'), log); if (k) done.keptAside.push(k); });

  // 1. a completely empty data folder with a backup available: restore the whole shop
  const empty = SHOP_FILES.every(function (n) { const a = readJsonArray(path.join(src, n + '.json')); return !a || !a.length; });
  if (empty) {
    const b = latestBackup();
    if (b) {
      SHOP_FILES.forEach(function (n) {
        const f = path.join(b, n + '.json');
        if (fs.existsSync(f) && readJsonArray(f)) fs.copyFileSync(f, path.join(src, n + '.json'));
      });
      done.restoredBackup = b;
      log.warn('[CATALOGUE] The data folder ' + src + ' was empty: restored the whole shop from the backup ' + b + '.');
    }
  }

  protection.run({ system: true, actor: 'system:catalogue-guard', reason: 'Start-up restore of missing products', via: 'catalogueGuard.ensure' }, function () {
    // 2. no products: the latest snapshot, else the protected products from the registry
    if (db.products.count() === 0) {
      const snap = latestSnapshot();
      if (snap) {
        snap.products.forEach(function (p) {
          try { db.products.insert(p); } catch (e) { if (e.code !== 'protected_duplicate') throw e; }   // a snapshot holding two copies keeps the first
        });
        done.restoredFrom = 'snapshot ' + snap.file;
      } else {
        CORE.forEach(function (p) { db.products.insert(Object.assign({}, p)); });
        done.restoredFrom = 'protected-products registry';
      }
      log.warn('[CATALOGUE] The product list was empty: restored ' + db.products.count() + ' product(s) from the ' + done.restoredFrom + '. Check prices and stock in Admin → Online Products.');
    }

    // 3. every protected product present (matched by id, slug, legacy id or confirmed SKU)
    const all = db.products.all();
    const snap = latestSnapshot();
    CORE.forEach(function (c) {
      if (all.some(function (p) { return protection.entryFor(p) && protection.entryFor(p).id === c.id; })) return;
      const fromSnap = snap && snap.products.filter(function (p) { return protection.entryFor(p) && protection.entryFor(p).id === c.id; })[0];
      db.products.insert(Object.assign({}, fromSnap || c, { active: true }));
      done.restoredCore.push(c.slug);
    });
  });
  if (done.restoredCore.length) log.warn('[CATALOGUE] Protected product(s) were missing and have been put back: ' + done.restoredCore.join(', ') + '.');

  // 4. integrity: repair identity drift, then check
  if (db.products.raw) done.repaired = protection.repair(db.products, log);
  done.integrity = protection.verify(db.products.all());
  if (!done.integrity.ok) {
    log.error('[PROTECTED] Protected-product integrity check FAILED: ' + done.integrity.problems.map(function (p) { return p.slug + ' — ' + p.problem; }).join('; ') +
      '. Fix the products file or restore a backup (docs/unified/PROTECTED-PRODUCTS.md), then start again.');
  }

  try { snapshot(); } catch (e) { log.error('[CATALOGUE] snapshot failed: ' + e.message); }
  try { autoBackup(false); } catch (e) { log.error('[CATALOGUE] backup failed: ' + e.message); }
  log.log('[CATALOGUE] Snapshots: ' + catalogueDir() + ' · daily backups: ' + backupDir());
  return done;
}

let timer = null;
/** Snapshot on change (every minute) and the daily backup. The timer never keeps the process alive. */
function watch() {
  if (timer) return;
  timer = setInterval(function () {
    try { snapshot(); } catch (e) { console.error('[CATALOGUE] snapshot failed: ' + e.message); }
    try { autoBackup(false); } catch (e) { console.error('[CATALOGUE] backup failed: ' + e.message); }
  }, 60000);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; lastSnapshotHash = null; }

/** Production refuses to run with a damaged protected catalogue unless PROTECTED_PRODUCTS_STRICT=false. */
function strict() {
  const v = process.env.PROTECTED_PRODUCTS_STRICT;
  if (v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  return process.env.NODE_ENV === 'production';
}

module.exports = { CORE, isCore, ensure, strict, watch, stop, snapshot, latestSnapshot, autoBackup, latestBackup, catalogueDir, backupDir, dataDir };
