#!/usr/bin/env node
/**
 * Validates migrations 004–012 against a RESTORED COPY of the real MySQL 8 database.
 * Never point it at production. It refuses unless:
 *   - VALIDATION_TARGET=restored-copy
 *   - DB_NAME ends with _restore, _restored, _validation or _staging (optionally + _suffix)
 *   - NODE_ENV is not "production"
 *
 * Usage (from a SCRATCH checkout of the repo that has the pack's migration files copied in):
 *   node <pack>/migrations/tools/validate-restored-copy.js --repo <scratch-checkout> [--precheck-only]
 *
 * Steps: 1 safety checks · 2 read-only pre-checks (version, applied migrations + checksums,
 * live schema vs expected 001–003 baseline, name collisions, grants, sizes, data checks)
 * · 3 fingerprint every existing table's data · 4 run the project's own migrate.up()
 * · 5 compare live schema with the expected after-012 schema · 6 re-fingerprint (existing
 * data must be identical) · 7 run every migration again (must apply 0 changes)
 * · 8 write validation-report-<time>.json and .md in the current folder.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const repo = path.resolve(args[args.indexOf('--repo') + 1] || '.');
const precheckOnly = args.indexOf('--precheck-only') !== -1;
const pack = path.join(__dirname, '..');
process.chdir(repo);
require(path.join(repo, 'node_modules', 'dotenv')).config({ path: path.join(repo, '.env') });

const report = { startedAt: new Date().toISOString(), target: null, steps: [], errors: [], warnings: [] };
function step(name, data) { report.steps.push(Object.assign({ step: name }, data || {})); console.log('✓ ' + name); }
function fail(msg) { report.errors.push(msg); console.error('✗ ' + msg); }
function warn(msg) { report.warnings.push(msg); console.warn('! ' + msg); }

// ── 1 safety ─────────────────────────────────────────────────────────────
const dbName = process.env.DB_NAME || '';
if (process.env.VALIDATION_TARGET !== 'restored-copy') { console.error('Refused: set VALIDATION_TARGET=restored-copy'); process.exit(2); }
if (!/_(restore|restored|validation|staging)(_[a-z0-9]+)?$/i.test(dbName)) { console.error('Refused: DB_NAME "' + dbName + '" does not look like a restored copy'); process.exit(2); }
if (process.env.NODE_ENV === 'production') { console.error('Refused: NODE_ENV=production'); process.exit(2); }
report.target = { host: process.env.DB_HOST, database: dbName };

const db = require(path.join(repo, 'src', 'db', 'connection.js'));
const migrate = require(path.join(repo, 'src', 'db', 'migrate.js'));
const guarded = require(path.join(repo, 'src', 'db', 'migrations', 'lib', 'guarded.js'));
const baseline = JSON.parse(fs.readFileSync(path.join(pack, 'expected', 'baseline_001_003.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(pack, 'expected', 'after_012.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'migration-manifest.json'), 'utf8'));
const sha = function (f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); };

async function liveSchema() {
  const cols = await db.query('SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty, IS_NULLABLE n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION');
  const idx = await db.query('SELECT TABLE_NAME t, INDEX_NAME i, COLUMN_NAME c, NON_UNIQUE nu FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX');
  const fks = await db.query('SELECT TABLE_NAME t, CONSTRAINT_NAME n, COLUMN_NAME c, REFERENCED_TABLE_NAME rt, REFERENCED_COLUMN_NAME rc FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
  const s = {};
  cols.forEach(function (r) { (s[r.t] = s[r.t] || { cols: {}, idx: {}, fks: {} }).cols[r.c] = { type: guarded.normType(r.ty), nullable: r.n === 'YES' }; });
  idx.forEach(function (r) { const t = s[r.t]; if (!t) return; (t.idx[r.i] = t.idx[r.i] || []).push(r.c); });
  fks.forEach(function (r) { const t = s[r.t]; if (t) t.fks[r.n] = { col: r.c, ref: r.rt, refcol: r.rc }; });
  return s;
}

function compare(live, want, label, onlyTables) {
  const diffs = [];
  for (const [t, v] of Object.entries(want)) {
    if (onlyTables && onlyTables.indexOf(t) === -1) continue;
    const L = live[t];
    if (!L) { diffs.push(label + ': missing table ' + t); continue; }
    for (const [c, d] of Object.entries(v.cols)) {
      const w = guarded.parseDef(d), g = L.cols[c];
      if (!g) diffs.push(label + ': missing column ' + t + '.' + c);
      else if (g.type !== w.type || g.nullable !== w.nullable) diffs.push(label + ': ' + t + '.' + c + ' is ' + g.type + (g.nullable ? ' NULL' : ' NOT NULL') + ', expected ' + w.type + (w.nullable ? ' NULL' : ' NOT NULL'));
    }
    for (const c of Object.keys(L.cols)) if (!v.cols[c]) diffs.push(label + ': extra column ' + t + '.' + c + ' (not in the reviewed schema)');
    for (const [i, cols] of Object.entries(v.indexes)) {
      if (!L.idx[i]) diffs.push(label + ': missing index ' + t + '.' + i);
      else if (L.idx[i].join(',') !== cols.join(',')) diffs.push(label + ': index ' + t + '.' + i + ' is (' + L.idx[i] + ') expected (' + cols + ')');
    }
    for (const f of v.fks) {
      const g = L.fks[f.name];
      if (!g) diffs.push(label + ': missing foreign key ' + f.name);
      else if (g.col !== f.col || g.ref !== f.ref || g.refcol !== f.refcol) diffs.push(label + ': foreign key ' + f.name + ' differs');
    }
  }
  return diffs;
}

async function fingerprint(tables) {
  const out = {};
  for (const t of tables) {
    const cols = Object.keys(baseline[t].cols);  // ORIGINAL columns only, so added columns don't change the print
    const expr = 'CONCAT_WS(\'|\',' + cols.map(function (c) { return 'IFNULL(CAST(`' + c + '` AS CHAR),\'\\0\')'; }).join(',') + ')';
    const r = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(' + expr + ')),0) AS s1, COALESCE(BIT_XOR(CRC32(REVERSE(' + expr + '))),0) AS s2 FROM `' + t + '`');
    out[t] = { rows: Number(r.n), sum: String(r.s1), xor: String(r.s2) };
  }
  return out;
}

(async function main() {
  try {
    // ── 2 pre-checks (read-only) ─────────────────────────────────────────
    const v = await db.queryOne('SELECT VERSION() AS v, @@sql_mode AS m, @@lower_case_table_names AS l, @@character_set_server AS cs, @@default_storage_engine AS e');
    if (!/^8\./.test(v.v) || /mariadb/i.test(v.v)) fail('Server is ' + v.v + ': validation must run on MySQL 8 (the production engine)');
    if (!/STRICT_TRANS_TABLES/.test(v.m)) warn('sql_mode lacks STRICT_TRANS_TABLES: ' + v.m);
    step('server', { version: v.v, sql_mode: v.m, lower_case_table_names: v.l, charset: v.cs, engine: v.e });

    const applied = await db.query('SELECT version, name, checksum FROM b2b_schema_migrations ORDER BY version');
    const shipped = ['001_core_schema.sql', '002_seed_reference_data.js', '003_performance_indexes.js'];
    const want = shipped.map(function (f) { return { version: f.slice(0, 3), name: f, checksum: sha(path.join(repo, 'src', 'db', 'migrations', f)) }; });
    const extra = applied.filter(function (a) { return want.every(function (w) { return w.version !== a.version; }); });
    want.forEach(function (w) {
      const a = applied.find(function (x) { return x.version === w.version; });
      if (!a) fail('Migration ' + w.name + ' is not applied on this copy');
      else if (a.checksum !== w.checksum) fail('Migration ' + w.name + ' was applied with a different checksum (' + a.checksum.slice(0, 12) + '…) — live schema may differ from the repo');
    });
    if (extra.length) fail('Unexpected applied migrations: ' + extra.map(function (e) { return e.name; }).join(', '));
    step('applied-migrations', { applied: applied.map(function (a) { return a.name; }) });

    manifest.forEach(function (m) {
      const p = path.join(repo, 'src', 'db', 'migrations', m.sql);
      if (!fs.existsSync(p)) fail('Pack file missing in checkout: ' + m.sql);
      else if (sha(p) !== m.sql_sha256) fail('Pack file changed: ' + m.sql);
    });
    step('pack-files', { migrations: manifest.length });

    let live = await liveSchema();
    const drift = compare(live, baseline, 'drift', Object.keys(baseline));
    drift.forEach(fail);
    const newTables = Object.keys(expected).filter(function (t) { return !baseline[t]; });
    newTables.forEach(function (t) { if (live[t]) fail('Name collision: table ' + t + ' already exists'); });
    const otherTables = Object.keys(live).filter(function (t) { return !baseline[t] && t !== 'b2b_schema_migrations'; });
    if (otherTables.length) warn('Other tables in this database (left untouched): ' + otherTables.join(', '));
    step('schema-vs-baseline', { driftCount: drift.length, newTables: newTables.length });

    const grants = (await db.query('SHOW GRANTS')).map(function (r) { return Object.values(r)[0]; }).join(' | ');
    ['CREATE', 'ALTER', 'INDEX', 'REFERENCES'].forEach(function (p) { if (!new RegExp('ALL PRIVILEGES|\\b' + p + '\\b').test(grants)) warn('Grant may be missing: ' + p); });
    const sizes = await db.query("SELECT TABLE_NAME t, TABLE_ROWS r, ROUND((DATA_LENGTH+INDEX_LENGTH)/1048576,2) mb FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'b2b\\_%' ORDER BY (DATA_LENGTH+INDEX_LENGTH) DESC");
    step('grants-and-sizes', { largest: sizes.slice(0, 8) });

    // data checks that inform later backfills (no changes made)
    const batchConflicts = await db.queryOne('SELECT COUNT(*) AS n FROM (SELECT product_id, batch_no FROM b2b_batches GROUP BY product_id, batch_no HAVING COUNT(DISTINCT IFNULL(expiry_date,\'0000-00-00\')) > 1) x');
    const nullEmails = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_accounts WHERE email IS NULL OR email = \'\'');
    step('data-checks', { batchesSameNumberDifferentExpiry: Number(batchConflicts.n), accountsWithoutEmail: Number(nullEmails.n) });

    if (report.errors.length) throw new Error('Pre-checks failed — nothing was changed');
    if (precheckOnly) { step('stopped (precheck only)'); return; }

    // ── 3 fingerprint ─────────────────────────────────────────────────────
    const before = await fingerprint(Object.keys(baseline));
    step('fingerprint-before', { tables: Object.keys(before).length, rows: Object.values(before).reduce(function (n, x) { return n + x.rows; }, 0) });

    // ── 4 migrate with the project's own runner ─────────────────────────
    const t0 = Date.now();
    const res = await migrate.up(function (l) { console.log('  ' + l); });
    step('migrate-up', { applied: res.applied, seconds: (Date.now() - t0) / 1000 });

    // ── 5 schema after ────────────────────────────────────────────────────
    live = await liveSchema();
    const after = compare(live, expected, 'after', Object.keys(expected));
    after.forEach(fail);
    step('schema-vs-expected', { differences: after.length, tables: Object.keys(live).length });

    // ── 6 existing data unchanged ─────────────────────────────────────────
    const fp2 = await fingerprint(Object.keys(baseline));
    Object.keys(before).forEach(function (t) {
      if (JSON.stringify(before[t]) !== JSON.stringify(fp2[t])) fail('Existing data changed in ' + t + ': ' + JSON.stringify(before[t]) + ' → ' + JSON.stringify(fp2[t]));
    });
    step('fingerprint-after', { identical: Object.keys(before).every(function (t) { return JSON.stringify(before[t]) === JSON.stringify(fp2[t]); }) });

    // ── 7 idempotency ─────────────────────────────────────────────────────
    const again = await migrate.up();
    let reapplied = 0;
    for (const m of manifest) {
      const mod = require(path.join(repo, 'src', 'db', 'migrations', m.file));
      const r = await db.withConnection(function (conn) { return mod.up(conn); });
      reapplied += r.applied;
    }
    if (again.applied.length || reapplied) fail('Re-run changed something: runner ' + again.applied.length + ', guarded ops ' + reapplied);
    const ver = await migrate.verify();
    step('idempotency-and-verify', { runnerApplied: again.applied.length, guardedOpsApplied: reapplied, verify: ver });
  } catch (e) {
    if (!report.errors.length || e.message.indexOf('Pre-checks') !== 0) fail(e.message);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.ok = report.errors.length === 0;
    const stamp = report.finishedAt.replace(/[:.]/g, '-');
    fs.writeFileSync('validation-report-' + stamp + '.json', JSON.stringify(report, null, 2));
    fs.writeFileSync('validation-report-' + stamp + '.md',
      '# Migration validation on ' + dbName + '\n\nResult: **' + (report.ok ? 'PASSED' : 'FAILED') + '**\n\n' +
      report.steps.map(function (s) { return '- ' + s.step + ': `' + JSON.stringify(Object.assign({}, s, { step: undefined })) + '`'; }).join('\n') +
      '\n\n## Errors\n' + (report.errors.map(function (e) { return '- ' + e; }).join('\n') || 'none') +
      '\n\n## Warnings\n' + (report.warnings.map(function (e) { return '- ' + e; }).join('\n') || 'none') + '\n');
    console.log(report.ok ? '\nPASSED — report written' : '\nFAILED — see report');
    await db.close();
    process.exit(report.ok ? 0 : 1);
  }
})();
