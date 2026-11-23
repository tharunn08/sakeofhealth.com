#!/usr/bin/env node
/**
 * Restore the online shop's data files from a backup — deliberately manual and two-step.
 *
 *   node scripts/restore-shop.js <backup folder>          shows what would be restored (nothing changes)
 *   node scripts/restore-shop.js <backup folder> --yes    does it
 *
 * <backup folder> = BACKUP_DIR/backup-YYYYMMDD-HHMMSS (npm run backup), its b2c-data subfolder, or a daily
 * BACKUP_DIR/auto-YYYYMMDD copy. Stop the app first.
 *
 * Before anything is replaced, the current files are copied to BACKUP_DIR/pre-restore-YYYYMMDD-HHMMSS, so a
 * restore can itself be undone. Afterwards the four protected products are checked; a backup that would
 * lose one of them is refused (unless --allow-missing-protected, in which case the app puts them back at
 * the next start).
 */
'use strict';
try { require('dotenv').config(); } catch (e) { /* optional */ }
const fs = require('fs');
const os = require('os');
const path = require('path');
const protection = require('../src/services/productProtection.js');

const SHOP_FILES = ['orders', 'products', 'coupons', 'customers', 'accounts', 'reviews', 'staff', 'deliveries', 'settings', 'events'];
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data');
const backupDir = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(os.homedir(), 'sakeofhealth-backups');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function readList(f) { try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(v) ? v : null; } catch (e) { return null; } }

function main(argv) {
  const src0 = argv[0];
  if (!src0) { console.error('Usage: node scripts/restore-shop.js <backup folder> [--yes]'); return 2; }
  let src = path.resolve(src0);
  if (fs.existsSync(path.join(src, 'b2c-data'))) src = path.join(src, 'b2c-data');
  const files = SHOP_FILES.filter(function (n) { return fs.existsSync(path.join(src, n + '.json')); });
  if (!files.length) { console.error('No shop data files in ' + src); return 1; }
  const bad = files.filter(function (n) { return !readList(path.join(src, n + '.json')); });
  if (bad.length) { console.error('Refusing: unreadable file(s) in the backup: ' + bad.join(', ')); return 1; }
  if (path.resolve(src) === path.resolve(dataDir)) { console.error('Refusing: the backup folder is the live data folder.'); return 1; }

  const products = readList(path.join(src, 'products.json')) || [];
  const check = protection.verify(products);
  console.log('Restore ' + files.length + ' file(s) from ' + src + ' into ' + dataDir + ':');
  files.forEach(function (n) { console.log('  ' + n + '.json — ' + readList(path.join(src, n + '.json')).length + ' record(s)'); });
  console.log('Protected products in this backup: ' + (check.ok ? 'all four, intact' : check.problems.map(function (p) { return p.slug + ' ' + p.problem; }).join('; ')));
  if (!check.ok && argv.indexOf('--allow-missing-protected') === -1 && check.problems.some(function (p) { return p.problem !== 'missing'; })) {
    console.error('Refusing: this backup holds damaged protected products. Pick another backup.'); return 1;
  }
  if (argv.indexOf('--yes') === -1) { console.log('\nNothing changed. Stop the app, then run again with --yes.'); return 0; }

  const keep = path.join(backupDir, 'pre-restore-' + stamp);
  fs.mkdirSync(keep, { recursive: true });
  SHOP_FILES.forEach(function (n) { const f = path.join(dataDir, n + '.json'); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(keep, n + '.json')); });
  fs.writeFileSync(path.join(keep, 'DONE'), 'Current files kept before restoring ' + src + ' at ' + new Date().toISOString() + '\n');
  fs.mkdirSync(dataDir, { recursive: true });
  files.forEach(function (n) {
    const tmp = path.join(dataDir, n + '.json.restore-tmp');
    fs.copyFileSync(path.join(src, n + '.json'), tmp);
    fs.renameSync(tmp, path.join(dataDir, n + '.json'));
  });
  console.log('\nRestored. The previous files are in ' + keep + '.');
  console.log(check.ok ? 'Protected products: OK.' : 'Protected products will be put back at the next start (they were missing from this backup).');
  console.log('Start the app, then run: npm run verify:products');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
