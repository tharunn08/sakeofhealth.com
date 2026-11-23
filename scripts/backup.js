#!/usr/bin/env node
/**
 * Backup command — pure Node.js, so it works on Hostinger shared hosting
 * where mysqldump may not be available.
 *
 *   npm run backup              create a backup
 *   npm run backup -- list      list existing backups
 *
 * Each backup is a folder  <BACKUP_DIR>/backup-YYYYMMDD-HHMMSS/  containing
 *   b2c-data/*.json           the customer website's data (orders, products…)
 *   b2b-database.sql.gz       every b2b_ table: structure + rows
 *   private-files/            uploaded business documents and import files
 *   manifest.json             row counts and file sizes, for verification
 *
 * BACKUP_DIR defaults to ~/sakeofhealth-backups — outside the site folder, so
 * redeploys never touch it. The newest BACKUP_KEEP (default 14) are kept.
 *
 * This script only READS the live data. Restoring is a deliberate, manual
 * step — see docs/BACKUP-RESTORE.md.
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const mysql = require('mysql2');

const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(os.homedir(), 'sakeofhealth-backups');
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data');

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function copyTree(from, to) {
  let files = 0, bytes = 0;
  if (!fs.existsSync(from)) return { files, bytes };
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name), b = path.join(to, name), st = fs.statSync(a);
    if (st.isDirectory()) { const r = copyTree(a, b); files += r.files; bytes += r.bytes; }
    else if (st.isFile()) { fs.copyFileSync(a, b); files++; bytes += st.size; }
  }
  return { files, bytes };
}
function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return mysql.escape(v, false, 'Z');
  if (Buffer.isBuffer(v)) return mysql.escape(v);
  if (typeof v === 'object') return mysql.escape(JSON.stringify(v));
  return mysql.escape(v);
}

async function dumpDatabase(file) {
  const db = require('../src/db/connection.js');
  const counts = {};
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(file, { mode: 0o600 });
  gz.pipe(out);
  const write = s => new Promise(resolve => { if (gz.write(s)) resolve(); else gz.once('drain', resolve); });

  await db.withConnection(async function (conn) {
    const q = async (sql, params) => (await conn.raw.query(sql, params))[0];
    // One consistent snapshot of every table, without blocking the live site.
    await q('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await q('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    try {
      const tables = (await q("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'b2b\\_%' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")).map(r => r.t);
      await write('-- Sake of Health B2B backup\n-- Created: ' + new Date().toISOString() + '\n-- Database: ' + db.config().database +
        '\n-- Restore into an EMPTY database. See docs/BACKUP-RESTORE.md\n\nSET NAMES utf8mb4;\nSET time_zone = \'+00:00\';\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\n\n');
      for (const t of tables) {
        const create = (await q('SHOW CREATE TABLE `' + t + '`'))[0]['Create Table'];
        await write('-- ' + t + '\n' + create.replace(/^CREATE TABLE/, 'CREATE TABLE IF NOT EXISTS') + ';\n\n');
        const cols = (await q('SELECT COLUMN_NAME AS c, EXTRA AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [t]))
          .filter(c => !/GENERATED/i.test(c.x || '')).map(c => c.c);
        const pk = (await q("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION", [t])).map(r => '`' + r.c + '`');
        const colList = cols.map(c => '`' + c + '`').join(', ');
        const order = pk.length ? ' ORDER BY ' + pk.join(', ') : '';
        let offset = 0; counts[t] = 0;
        for (;;) {
          const rows = await q('SELECT ' + colList + ' FROM `' + t + '`' + order + ' LIMIT ? OFFSET ?', [1000, offset]);
          if (!rows.length) break;
          for (let i = 0; i < rows.length; i += 200) {
            const chunk = rows.slice(i, i + 200);
            await write('INSERT INTO `' + t + '` (' + colList + ') VALUES\n' +
              chunk.map(r => '(' + cols.map(c => sqlValue(r[c])).join(',') + ')').join(',\n') + ';\n');
          }
          counts[t] += rows.length; offset += rows.length;
          if (rows.length < 1000) break;
        }
        await write('\n');
      }
      await write('SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n');
    } finally { await q('COMMIT'); }
  });
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.end(); });
  await db.close().catch(() => {});
  return counts;
}

function list() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(n => /^backup-\d{8}-\d{6}$/.test(n)).sort();
}

async function main() {
  if (process.argv[2] === 'list') {
    const all = list();
    console.log('Backups in ' + BACKUP_DIR + ':');
    if (!all.length) console.log('  (none yet)');
    for (const n of all) {
      let m = {}; try { m = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, n, 'manifest.json'), 'utf8')); } catch (e) { /* incomplete */ }
      console.log('  ' + n + (m.completed ? '   b2c files: ' + m.b2c.files + '   b2b rows: ' + (m.b2b ? m.b2b.totalRows : 'not included') : '   ⚠ incomplete'));
    }
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const dir = path.join(BACKUP_DIR, 'backup-' + stamp());
  fs.mkdirSync(dir, { mode: 0o700 });
  const manifest = { startedAt: new Date().toISOString(), completed: false };

  // 1. Customer website (JSON store)
  manifest.b2c = copyTree(DATA_DIR, path.join(dir, 'b2c-data'));
  manifest.b2c.source = DATA_DIR;
  console.log('✓ Customer site data: ' + manifest.b2c.files + ' files');

  // 2. B2B database
  const db = require('../src/db/connection.js');
  if (db.isConfigured()) {
    const file = path.join(dir, 'b2b-database.sql.gz');
    const counts = await dumpDatabase(file);
    manifest.b2b = { file: 'b2b-database.sql.gz', bytes: fs.statSync(file).size, tables: counts, totalRows: Object.values(counts).reduce((a, b) => a + b, 0) };
    console.log('✓ B2B database: ' + Object.keys(counts).length + ' tables, ' + manifest.b2b.totalRows + ' rows');

    // 3. Private uploads
    const cfg = require('../src/modules/b2b/config.js');
    manifest.privateFiles = copyTree(cfg.privateDir(), path.join(dir, 'private-files'));
    console.log('✓ Private documents: ' + manifest.privateFiles.files + ' files');
    const storage = require('../src/platform/storage.js');
    manifest.storage = storage.info();
    if (storage.provider() === 's3') {
      manifest.storage.note = 'Documents uploaded since the switch to the bucket are NOT in this backup: keep versioning (or a lifecycle copy) switched on for the bucket.';
      console.log('! Documents in the bucket (' + (manifest.storage.bucket || '?') + ') are not copied by this backup — keep bucket versioning on.');
    }
  } else {
    console.log('· B2B database not configured — skipped.');
  }

  manifest.completed = true;
  manifest.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  // 4. Retention — only ever removes our own complete backup folders
  const all = list();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    console.log('· Removed old backup ' + old);
  }
  console.log('\nBackup saved to ' + dir + '\nCopy this folder off the server (hPanel File Manager → download) for a real off-site backup.');
}

main().catch(function (e) { console.error('✗ Backup failed: ' + e.message); process.exit(1); });
