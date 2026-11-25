/**
 * Versioned, forward-only migration runner.
 *
 * Rules that keep production safe:
 *  - Files in src/db/migrations run once each, in filename order, and are
 *    recorded in b2b_schema_migrations with a checksum.
 *  - Every statement must be idempotent (CREATE TABLE IF NOT EXISTS,
 *    INSERT IGNORE …) because MySQL DDL cannot be rolled back — a migration
 *    that stops half-way can simply be run again.
 *  - Destructive statements (DROP TABLE / DROP DATABASE / TRUNCATE / DELETE
 *    without WHERE) are refused unless the file opts in with a
 *    `-- allow-destructive` header AND ALLOW_DESTRUCTIVE_MIGRATIONS=true.
 *  - A named lock stops two processes migrating at the same time.
 *  - Nothing runs automatically on deploy unless DB_AUTO_MIGRATE=true.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./connection.js');

const DIR = path.join(__dirname, 'migrations');
const TABLE = 'b2b_schema_migrations';
const LOCK = 'soh_b2b_migrate';

/**
 * Decision D5 (25 Nov 2026): versions 013 and 014 are retired and never applied. The two files that once
 * carried those numbers (013/014_erp_governance.js) were byte-identical wrappers that re-ran migration 004
 * under new numbers; 004 is applied everywhere it is needed and neither number was ever recorded (production
 * u935782097_sohplatform: 001–012, 015–020; the old sakeofhealth.in database: 001–003). A file numbered 013 or
 * 014 placed in the folder is skipped with a warning; the next new migration takes 021.
 */
const RETIRED = { '013': 'retired by decision D5 (a copy of 004)', '014': 'retired by decision D5 (a copy of 004)' };

function allFiles() {
  return fs.readdirSync(DIR).filter(function (f) { return /^\d{3}_[a-z0-9_]+\.(sql|js)$/.test(f); }).sort();
}
function listFiles() {
  return allFiles().filter(function (f) { return !RETIRED[f.slice(0, 3)]; });
}
/** Files in the folder under a retired number (never applied). */
function retiredFiles() {
  return allFiles().filter(function (f) { return !!RETIRED[f.slice(0, 3)]; }).map(function (f) { return { file: f, why: RETIRED[f.slice(0, 3)] }; });
}

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, file))).digest('hex');
}

/** Split a .sql file into statements. No stored procedures/triggers are used, so `;` at end of line is a safe delimiter. */
function splitSql(text) {
  const withoutComments = text.split('\n').filter(function (l) { return !/^\s*--/.test(l); }).join('\n');
  return withoutComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

const DESTRUCTIVE = /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s|DELETE\s+FROM\s+\S+\s*(;|$))/i;

function assertSafe(file, text) {
  if (!DESTRUCTIVE.test(text)) return;
  const optedIn = /^--\s*allow-destructive/m.test(text) && process.env.ALLOW_DESTRUCTIVE_MIGRATIONS === 'true';
  if (!optedIn) {
    throw new Error('Migration ' + file + ' contains a destructive statement and was refused. ' +
      'Destructive migrations need a "-- allow-destructive" header and ALLOW_DESTRUCTIVE_MIGRATIONS=true after explicit review.');
  }
}

async function ensureTable(conn) {
  await conn.raw.query(
    'CREATE TABLE IF NOT EXISTS ' + TABLE + ' (' +
    ' version VARCHAR(3) NOT NULL PRIMARY KEY,' +
    ' name VARCHAR(190) NOT NULL,' +
    ' checksum CHAR(64) NOT NULL,' +
    ' applied_at DATETIME NOT NULL,' +
    ' duration_ms INT NOT NULL DEFAULT 0' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
}

async function status() {
  return db.withConnection(async function (conn) {
    await ensureTable(conn);
    const [applied] = await conn.raw.query('SELECT version, name, checksum, applied_at FROM ' + TABLE + ' ORDER BY version');
    const byVersion = {};
    applied.forEach(function (r) { byVersion[r.version] = r; });
    const files = listFiles().map(function (f) {
      const version = f.slice(0, 3);
      const row = byVersion[version];
      return {
        version: version, file: f,
        applied: !!row,
        appliedAt: row ? row.applied_at : null,
        changedSinceApplied: row ? row.checksum !== checksum(f) : false,
      };
    });
    return {
      migrations: files, retired: retiredFiles(),
      pending: files.filter(function (f) { return !f.applied; }).length,
      upToDate: files.every(function (f) { return f.applied; }),
    };
  });
}

async function up(log) {
  log = log || function () {};
  return db.withConnection(async function (conn) {
    const [[lock]] = await conn.raw.query('SELECT GET_LOCK(?, 20) AS got', [LOCK]);
    if (!lock || Number(lock.got) !== 1) throw new Error('Another migration is already running. Try again in a moment.');
    const ran = [];
    try {
      await ensureTable(conn);
      const [applied] = await conn.raw.query('SELECT version FROM ' + TABLE);
      const done = {};
      applied.forEach(function (r) { done[r.version] = true; });

      retiredFiles().forEach(function (r) { log('⚠ skipped ' + r.file + ': ' + r.why + '. Remove the file.'); });
      for (const file of listFiles()) {
        const version = file.slice(0, 3);
        if (done[version]) continue;
        const started = Date.now();
        log('→ applying ' + file);
        if (file.endsWith('.sql')) {
          const text = fs.readFileSync(path.join(DIR, file), 'utf8');
          assertSafe(file, text);
          for (const stmt of splitSql(text)) await conn.raw.query(stmt);
        } else {
          const mod = require(path.join(DIR, file));
          await mod.up(conn);
        }
        await conn.raw.query(
          'INSERT INTO ' + TABLE + ' (version, name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, UTC_TIMESTAMP(), ?)',
          [version, file, checksum(file), Date.now() - started]);
        ran.push(file);
        log('✓ ' + file + ' (' + (Date.now() - started) + ' ms)');
      }
    } finally {
      await conn.raw.query('SELECT RELEASE_LOCK(?)', [LOCK]);
    }
    return { applied: ran };
  });
}

/** The tables the application expects — used by `npm run migrate:verify` and the admin System page. */
const EXPECTED_TABLES = [
  'b2b_states', 'b2b_districts', 'b2b_settings', 'b2b_accounts', 'b2b_users', 'b2b_documents',
  'b2b_account_status_history', 'b2b_service_areas', 'b2b_retailer_distributor_map',
  'b2b_categories', 'b2b_products', 'b2b_pricing_rules',
  'b2b_warehouses', 'b2b_stock', 'b2b_batches', 'b2b_stock_movements',
  'b2b_cart_items', 'b2b_favorites',
  'b2b_orders', 'b2b_order_items', 'b2b_order_item_allocations', 'b2b_order_status_history',
  'b2b_sequences', 'b2b_invoices', 'b2b_invoice_items', 'b2b_credit_notes', 'b2b_credit_note_items',
  'b2b_payments', 'b2b_credit_accounts', 'b2b_credit_transactions',
  'b2b_returns', 'b2b_return_items',
  'b2b_notifications', 'b2b_notification_queue',
  'b2b_imports', 'b2b_import_rows', 'b2b_audit_logs',
];

async function verify() {
  const rows = await db.query(
    'SELECT TABLE_NAME AS t, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  const have = {};
  rows.forEach(function (r) { have[String(r.t).toLowerCase()] = r.e; });
  const missing = EXPECTED_TABLES.filter(function (t) { return !have[t]; });
  const notInnoDb = EXPECTED_TABLES.filter(function (t) { return have[t] && String(have[t]).toLowerCase() !== 'innodb'; });
  const st = await status();
  return { ok: !missing.length && !notInnoDb.length && st.upToDate, missing: missing, notInnoDb: notInnoDb, pending: st.pending };
}

module.exports = { up, status, verify, listFiles, retiredFiles, RETIRED, splitSql, EXPECTED_TABLES };
