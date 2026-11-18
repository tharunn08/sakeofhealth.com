#!/usr/bin/env node
/**
 * D5 — READ-ONLY, least-privilege inspection of migrations 013/014.
 *
 * Three steps (commands in docs/phase-1/RUN-ON-WINDOWS.txt):
 *
 *  1. INVENTORY (server owner, as root, in the mysql client):
 *       scripts/d5/inventory.sql — reads table NAMES/COUNTS from information_schema
 *       only, saved as a tab-separated file. Lists every database containing this
 *       project's tables (b2b_*), whether it has b2b_schema_migrations, and how many
 *       ERP core tables it has. Databases with project tables but no migration
 *       table are reported from this file.
 *
 *  2. GRANTS:   node scripts/d5-inspect.js grants --inventory d5-inventory.tsv
 *       Prints one statement per database that HAS the migration table:
 *         GRANT SELECT ON `<db>`.`b2b_schema_migrations` TO 'soh_d5'@'127.0.0.1';
 *       Nothing else: no global privilege, no SHOW DATABASES, no other table.
 *
 *  3. INSPECT:  node scripts/d5-inspect.js --inventory d5-inventory.tsv --out d5-report.md
 *       Connects as the D5 account and FIRST checks its own grants: it refuses to
 *       continue if the account holds anything beyond USAGE plus SELECT on
 *       b2b_schema_migrations tables (e.g. SELECT ON *.*). The session is READ ONLY;
 *       only these statements are ever sent:
 *         SET SESSION TRANSACTION READ ONLY
 *         SHOW GRANTS FOR CURRENT_USER()
 *         SELECT VERSION(), @@sql_mode, @@lower_case_table_names
 *         SELECT version, name, checksum, applied_at FROM `<db>`.b2b_schema_migrations
 *       The password is asked at a hidden prompt, goes only to the driver, and is
 *       never printed or written.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS = path.join(__dirname, '..', 'src', 'db', 'migrations');
const ERP_TABLES = ['b2b_staff', 'b2b_roles', 'b2b_permissions', 'b2b_approval_requests', 'b2b_jobs'];
const D5_ACCOUNT = "'soh_d5'@'127.0.0.1'";
const FIXED = ['SET SESSION TRANSACTION READ ONLY', 'SHOW GRANTS FOR CURRENT_USER()'];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

/** Only the two fixed statements or a single SELECT may be sent. */
function assertReadOnly(sql) {
  const s = String(sql).trim().replace(/;\s*$/, '');
  if (FIXED.indexOf(s) !== -1) return s;
  if (!/^SELECT\b/i.test(s) || s.indexOf(';') !== -1) throw new Error('d5-inspect only runs single SELECT statements; refused: ' + s.slice(0, 60));
  return s;
}

/** A database name as a MySQL identifier. Names with control characters are refused. */
function ident(name) {
  if (typeof name !== 'string' || !name || /[\u0000-\u001f]/.test(name)) throw new Error('unusable database name in the inventory: ' + JSON.stringify(name));
  return '`' + name.replace(/`/g, '``') + '`';
}

/** Text of a file saved by PowerShell (UTF-16 with BOM) or anything else (UTF-8, BOM optional). */
function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  return buf.toString('utf8');
}

/** Parse the mysql --batch output of scripts/d5/inventory.sql (tab-separated, header row). */
function parseInventory(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const head = lines[0].split('\t').map(h => h.trim());
  const want = ['db', 'project_tables', 'has_migration_table', 'erp_core_tables'];
  if (want.some((w, i) => head[i] !== w)) throw new Error('This is not the output of scripts/d5/inventory.sql (expected columns: ' + want.join(', ') + ').');
  return lines.slice(1).map(l => {
    const c = l.split('\t');
    const unesc = s => s.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    return { db: unesc(c[0]), tables: Number(c[1]), hasMigrationTable: Number(c[2]) > 0, erp: Number(c[3] === 'NULL' ? 0 : c[3]) };
  });
}

/** The exact GRANT statements for the D5 account: SELECT on each migration-history table, nothing else. */
function grantStatements(inventory, account) {
  return inventory.filter(d => d.hasMigrationTable)
    .map(d => 'GRANT SELECT ON ' + ident(d.db) + '.`b2b_schema_migrations` TO ' + (account || D5_ACCOUNT) + ';');
}

/** SHOW GRANTS lines that go beyond USAGE + SELECT on b2b_schema_migrations tables. Pure. */
function grantProblems(lines) {
  return lines.filter(l => !/^GRANT USAGE ON \*\.\* TO /i.test(l) &&
    !/^GRANT SELECT ON `(?:[^`]|``)+`\.`b2b_schema_migrations` TO /i.test(l));
}

/** Migration files here, with checksums of the exact bytes and of both line-ending variants. */
function localFiles(dir) {
  return fs.readdirSync(dir || MIGRATIONS).filter(f => /^\d{3}_[a-z0-9_]+\.(sql|js)$/.test(f)).sort().map(f => {
    const b = fs.readFileSync(path.join(dir || MIGRATIONS, f));
    const lf = b.toString('utf8').replace(/\r\n/g, '\n');
    return { version: f.slice(0, 3), name: f, exact: sha(b), lf: sha(Buffer.from(lf, 'utf8')), crlf: sha(Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8')) };
  });
}

/** Compare one database's recorded migrations with the files. Pure. */
function analyse(recorded, files) {
  const rows = recorded.map(r => {
    const f = files.find(x => x.name === r.name) || files.find(x => x.version === String(r.version).padStart(3, '0'));
    let match = 'no file with this name here';
    if (f) match = r.checksum === f.exact ? 'exact' : r.checksum === f.lf ? 'same file, Unix line endings' : r.checksum === f.crlf ? 'same file, Windows line endings' : 'DIFFERENT content';
    return { version: r.version, name: r.name, applied_at: r.applied_at, checksum: r.checksum, match };
  });
  const v = rows.map(r => String(r.version).padStart(3, '0'));
  return { rows, applied013: v.includes('013'), applied014: v.includes('014'), highest: v.length ? v[v.length - 1] : null };
}

const SQL = {
  server: 'SELECT VERSION() AS v, @@sql_mode AS m, @@lower_case_table_names AS l',
  migrations: dbIdent => 'SELECT version, name, checksum, applied_at FROM ' + dbIdent + '.b2b_schema_migrations ORDER BY version',
};

/**
 * Runs the inspection on an open connection ({query(sql)}). Checks the account's
 * own grants BEFORE reading any migration table. Returns the report text.
 */
async function inspect(conn, label, inventory, files) {
  const q = async sql => (await conn.query(assertReadOnly(sql)))[0];
  await q('SET SESSION TRANSACTION READ ONLY');
  const grants = (await q('SHOW GRANTS FOR CURRENT_USER()')).map(r => Object.values(r)[0]);
  const extra = grantProblems(grants);
  if (extra.length) {
    throw Object.assign(new Error('The D5 account has more rights than it needs, so the inspection stops here. Remove these and run again:\n  ' + extra.join('\n  ')), { exit: 5 });
  }
  const s = (await q(SQL.server))[0];
  const withMig = [], withoutMig = [];
  for (const d of inventory) {
    const entry = { name: d.db, tables: d.tables, erp: d.erp };
    if (d.hasMigrationTable) { entry.analysis = analyse(await q(SQL.migrations(ident(d.db))), files || localFiles()); withMig.push(entry); }
    else withoutMig.push(entry);
  }
  return report({ label, version: s.v, sqlMode: s.m, lctn: s.l, grants: grants.length - 1 }, withMig, withoutMig);
}

function report(server, withMig, withoutMig) {
  const out = ['# D5 inspection — ' + server.label, '',
    'Generated ' + new Date().toISOString() + ' by scripts/d5-inspect.js. Read-only. The D5 account held only USAGE plus SELECT on ' + server.grants + ' migration-history table(s) (checked before reading).',
    'Project-table names and counts come from the root-run inventory (scripts/d5/inventory.sql).', '',
    'MySQL ' + server.version + ' · sql_mode `' + server.sqlMode + '` · lower_case_table_names ' + server.lctn, '', '## Summary', ''];
  if (!withMig.length && !withoutMig.length) out.push('**No database on this server contains this project\'s tables** (b2b_*).');
  withMig.forEach(d => out.push('- `' + d.name + '`: migration table present · 013 applied: **' + (d.analysis.applied013 ? 'YES' : 'no') + '** · 014 applied: **' + (d.analysis.applied014 ? 'YES' : 'no') + '** · highest recorded ' + (d.analysis.highest || '—')));
  withoutMig.forEach(d => out.push('- `' + d.name + '`: **project tables WITHOUT a migration table** — ' + d.tables + ' b2b_* tables, ERP core tables ' + d.erp + ' of ' + ERP_TABLES.length + ' (created outside the migration runner)'));
  out.push('');
  withMig.forEach(d => {
    out.push('## Database `' + d.name + '` — migration history', '', '- Project tables (`b2b_*`): ' + d.tables + ' · ERP core tables present: ' + d.erp + ' of ' + ERP_TABLES.length, '');
    out.push('| Version | File | Applied at | Recorded checksum | Compared with this folder |', '|---|---|---|---|---|');
    d.analysis.rows.forEach(r => out.push('| ' + r.version + ' | ' + r.name + ' | ' + (r.applied_at ? new Date(r.applied_at).toISOString() : '—') + ' | `' + String(r.checksum).slice(0, 16) + '…` | ' + r.match + ' |'));
    out.push('');
  });
  if (withoutMig.length) {
    out.push('## Databases with project tables but no migration table', '', 'Their tables were not created by the migration runner, so there is no history to say which migrations they match. Please tell me how they were created (SQL import, phpMyAdmin, copy of another database…).', '');
    withoutMig.forEach(d => out.push('- `' + d.name + '`: ' + d.tables + ' b2b_* tables · ERP core tables: ' + d.erp + ' of ' + ERP_TABLES.length));
    out.push('');
  }
  return out.join('\n') + '\n';
}

/** deps (for tests): createConnection, prompt, env, argv, read, write, log. */
async function main(deps) {
  deps = deps || {};
  const env = deps.env || process.env, argv = deps.argv || process.argv;
  const arg = n => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };
  const log = deps.log || (t => process.stdout.write(t.endsWith('\n') ? t : t + '\n'));
  const invFile = arg('--inventory');
  if (!invFile) throw Object.assign(new Error('Give the inventory file from step 1: --inventory d5-inventory.tsv'), { exit: 2 });
  const inventory = parseInventory((deps.read || (f => decode(fs.readFileSync(f))))(invFile));

  if (argv[2] === 'grants') {                         // step 2: print the exact grants; no connection
    const g = grantStatements(inventory, arg('--account') || undefined);
    const text = (g.length ? g.join('\n') : '-- No database has a migration-history table: nothing to grant.') + '\n';
    const out = arg('--out');
    if (out) { (deps.write || fs.writeFileSync)(out, text); log(g.length + ' GRANT statement(s) written to ' + out + ' — review it before applying.'); }   // UTF-8, no BOM
    else log(text);
    return g;
  }

  const host = env.D5_HOST, user = env.D5_USER, port = Number(arg('--port') || env.D5_PORT || 3306);
  if (!host || !user) throw Object.assign(new Error('Set D5_HOST and D5_USER (the password is asked for).'), { exit: 2 });
  const password = env.D5_PASSWORD != null ? env.D5_PASSWORD : await (deps.prompt || require('./lib/hidden-prompt.js'))('MySQL password for ' + user + '@' + host + ' (hidden): ');
  const createConnection = deps.createConnection || require('mysql2/promise').createConnection;
  const conn = await createConnection({ host, port, user, password, connectTimeout: 15000 });
  try {
    const text = await inspect(conn, host + ':' + port, inventory);
    const out = arg('--out');
    if (out) { (deps.write || fs.writeFileSync)(out, text); log('Report written to ' + out); }
    else log(text);
    return text;
  } finally { await conn.end(); }
}

if (require.main === module) {
  main().catch(e => { console.error('d5-inspect: ' + e.message); process.exit(e.exit || 1); });
}
module.exports = { decode, assertReadOnly, ident, parseInventory, grantStatements, grantProblems, localFiles, analyse, report, inspect, main, SQL, ERP_TABLES, D5_ACCOUNT };
