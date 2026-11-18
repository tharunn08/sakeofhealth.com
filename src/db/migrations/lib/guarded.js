/**
 * Guarded, idempotent schema changes for migrations 004–012 (DRAFT — not yet
 * approved; lives in the design pack, not in the live repository).
 *
 * Every change checks information_schema first:
 *   - already present with the SAME definition → skipped (safe to re-run)
 *   - present with a DIFFERENT definition       → throws, nothing changed
 *   - absent                                    → applied
 * Nothing here can drop, rename, truncate, delete or narrow anything.
 * MySQL DDL is not transactional; the guards are what make a half-finished
 * run safe to repeat.
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

// A statement that starts with a data/destructive verb, or an ALTER clause that removes or renames.
// ("ON UPDATE CURRENT_TIMESTAMP" inside a column definition is fine and is not matched.)
const FORBIDDEN = /^\s*(DROP|TRUNCATE|DELETE|RENAME|UPDATE|REPLACE|INSERT|LOAD)\b|\bDROP\s+(TABLE|DATABASE|SCHEMA|COLUMN|INDEX|KEY|FOREIGN|PRIMARY|CONSTRAINT|CHECK)\b|\bRENAME\s+(TO|AS|COLUMN|INDEX|KEY)\b|\bTRUNCATE\b/i;

function normType(t) {
  t = String(t).toLowerCase().replace(/\s+/g, ' ').trim();
  // information_schema prints ENUM/SET lists without spaces; reviewed SQL may wrap them across lines.
  t = t.replace(/'\s*,\s*'/g, "','");
  // MariaDB / older MySQL print integer display widths; MySQL 8.0.19+ does not (except tinyint(1)).
  t = t.replace(/\b(bigint|int|smallint|mediumint)\(\d+\)/g, '$1');
  t = t.replace(/\btinyint\((?!1\))\d+\)/g, 'tinyint');
  return t;
}

/** "ENUM('a','b') NOT NULL DEFAULT 'a'" → { type: "enum('a','b')", nullable: false } */
function parseDef(def) {
  const m = String(def).match(/^\s*([a-z]+(?:\s*\([^)]*\))?(?:\s+unsigned)?)/i);
  if (!m) throw new Error('cannot parse column definition: ' + def);
  return { type: normType(m[1]), nullable: !/\bNOT\s+NULL\b/i.test(def) };
}

function enumValues(type) {
  const m = String(type).match(/^enum\((.*)\)$/i);
  if (!m) return null;
  return (m[1].match(/'((?:[^']|'')*)'/g) || []).map(function (v) { return v.slice(1, -1); });
}

function assertSafeSql(sql, where) {
  if (FORBIDDEN.test(sql)) throw new Error('Refused: forbidden statement in ' + where + ': ' + sql.slice(0, 120));
}

async function q(conn, sql, params) {
  const [rows] = await conn.raw.query(sql, params || []);
  return rows;
}

async function column(conn, table, col) {
  const rows = await q(conn,
    'SELECT COLUMN_TYPE AS t, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, col]);
  return rows.length ? { type: normType(rows[0].t), nullable: rows[0].n === 'YES' } : null;
}

async function indexCols(conn, table, name) {
  const rows = await q(conn,
    'SELECT COLUMN_NAME AS c, NON_UNIQUE AS nu FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX',
    [table, name]);
  return rows.length ? { cols: rows.map(function (r) { return r.c; }), unique: Number(rows[0].nu) === 0 } : null;
}

async function fk(conn, name) {
  const rows = await q(conn,
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc FROM information_schema.KEY_COLUMN_USAGE ' +
    'WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL', [name]);
  return rows.length ? rows[0] : null;
}

async function tableExists(conn, table) {
  const rows = await q(conn, 'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  return rows.length > 0;
}

/** Run a CREATE-TABLE-only SQL file after checking its SHA-256 matches the one pinned in the migration. */
async function runSqlFile(conn, file, expectedSha256, log) {
  const text = fs.readFileSync(file, 'utf8');
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  if (sha !== expectedSha256) throw new Error('Refused: ' + file + ' changed since it was reviewed (sha256 ' + sha + ')');
  const body = text.split('\n').filter(function (l) { return !/^\s*--/.test(l); }).join('\n');
  const stmts = body.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
  for (const s of stmts) {
    if (!/^CREATE TABLE IF NOT EXISTS b2b_\w+ \(/.test(s)) throw new Error('Refused: only CREATE TABLE IF NOT EXISTS b2b_… is allowed in ' + file);
    assertSafeSql(s.replace(/--[^\n]*/g, ''), file);  // judge the SQL, not its comments
    await conn.raw.query(s);
    if (log) log('  table ' + s.match(/b2b_\w+/)[0]);
  }
  return stmts.length;
}

/**
 * ops: [{ op: 'addColumn', table, column, def }
 *       { op: 'extendEnum', table, column, def }        new list must start with the current list
 *       { op: 'makeNullable', table, column, def }      same type, NOT NULL → NULL only
 *       { op: 'addIndex', table, name, columns:[…], unique }
 *       { op: 'addForeignKey', table, name, column, refTable, refColumn }]
 */
async function apply(conn, ops, log) {
  log = log || function () {};
  const out = { applied: 0, skipped: 0 };
  for (const o of ops) {
    if (!(await tableExists(conn, o.table))) throw new Error('Refused: table ' + o.table + ' does not exist');
    const tag = o.op + ' ' + o.table + '.' + (o.column || o.name);
    if (o.op === 'addColumn') {
      const cur = await column(conn, o.table, o.column);
      const want = parseDef(o.def);
      if (cur) {
        if (cur.type !== want.type || cur.nullable !== want.nullable) throw new Error('Refused: ' + tag + ' exists as ' + cur.type + (cur.nullable ? ' NULL' : ' NOT NULL'));
        out.skipped++; continue;
      }
      if (!want.nullable && !/\bDEFAULT\b/i.test(o.def)) throw new Error('Refused: ' + tag + ' NOT NULL without DEFAULT');
      await runAlter(conn, 'ALTER TABLE `' + o.table + '` ADD COLUMN `' + o.column + '` ' + o.def);
    } else if (o.op === 'extendEnum') {
      const cur = await column(conn, o.table, o.column);
      if (!cur) throw new Error('Refused: ' + tag + ' column missing');
      const want = parseDef(o.def), a = enumValues(cur.type), b = enumValues(want.type);
      if (!a || !b) throw new Error('Refused: ' + tag + ' is not an ENUM');
      if (cur.nullable !== want.nullable) throw new Error('Refused: ' + tag + ' nullability would change');
      if (JSON.stringify(a) === JSON.stringify(b)) { out.skipped++; continue; }
      if (JSON.stringify(b.slice(0, a.length)) !== JSON.stringify(a)) {
        throw new Error('Refused: ' + tag + ' live values ' + JSON.stringify(a) + ' are not a prefix of ' + JSON.stringify(b));
      }
      await runAlter(conn, 'ALTER TABLE `' + o.table + '` MODIFY COLUMN `' + o.column + '` ' + o.def);
    } else if (o.op === 'makeNullable') {
      const cur = await column(conn, o.table, o.column);
      const want = parseDef(o.def);
      if (!cur) throw new Error('Refused: ' + tag + ' column missing');
      if (cur.type !== want.type) throw new Error('Refused: ' + tag + ' live type ' + cur.type + ' differs from ' + want.type);
      if (cur.nullable) { out.skipped++; continue; }
      if (!want.nullable) throw new Error('Refused: ' + tag + ' definition is not nullable');
      await runAlter(conn, 'ALTER TABLE `' + o.table + '` MODIFY COLUMN `' + o.column + '` ' + o.def);
    } else if (o.op === 'addIndex') {
      const cur = await indexCols(conn, o.table, o.name);
      if (cur) {
        if (cur.cols.join(',') !== o.columns.join(',') || cur.unique !== !!o.unique) throw new Error('Refused: ' + tag + ' exists on (' + cur.cols.join(',') + ')');
        out.skipped++; continue;
      }
      await runAlter(conn, 'ALTER TABLE `' + o.table + '` ADD ' + (o.unique ? 'UNIQUE ' : '') + 'INDEX `' + o.name + '` (' + o.columns.map(function (c) { return '`' + c + '`'; }).join(', ') + ')');
    } else if (o.op === 'addForeignKey') {
      const cur = await fk(conn, o.name);
      if (cur) {
        if (cur.t !== o.table || cur.c !== o.column || cur.rt !== o.refTable || cur.rc !== o.refColumn) throw new Error('Refused: constraint ' + o.name + ' exists on ' + cur.t + '.' + cur.c);
        out.skipped++; continue;
      }
      // Existing rows must already satisfy the key (new columns are NULL, so this is a safety net).
      const orphans = await q(conn, 'SELECT COUNT(*) AS n FROM `' + o.table + '` x LEFT JOIN `' + o.refTable + '` r ON r.`' + o.refColumn + '` = x.`' + o.column + '` ' +
        'WHERE x.`' + o.column + '` IS NOT NULL AND r.`' + o.refColumn + '` IS NULL');
      if (Number(orphans[0].n) > 0) throw new Error('Refused: ' + tag + ' — ' + orphans[0].n + ' rows would violate the key');
      await runAlter(conn, 'ALTER TABLE `' + o.table + '` ADD CONSTRAINT `' + o.name + '` FOREIGN KEY (`' + o.column + '`) REFERENCES `' + o.refTable + '` (`' + o.refColumn + '`)');
    } else {
      throw new Error('Refused: unknown op ' + o.op);
    }
    out.applied++; log('  ' + tag);
  }
  return out;
}

async function runAlter(conn, sql) {
  assertSafeSql(sql, 'alter');
  if (!/^ALTER TABLE `b2b_\w+` (ADD |MODIFY COLUMN )/.test(sql)) throw new Error('Refused: unexpected ALTER ' + sql.slice(0, 100));
  await conn.raw.query(sql);
}

module.exports = { runSqlFile, apply, parseDef, normType, enumValues, FORBIDDEN };
