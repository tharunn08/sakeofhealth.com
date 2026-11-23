/**
 * Unit tests for lib/guarded.js — the refusal paths that protect a live database.
 * Uses a fake connection (no MySQL needed):  node --test tests/guarded.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const g = require('../src/db/migrations/lib/guarded.js');

/** A fake connection: one table with given columns/indexes/fks; records executed DDL. */
function fakeConn(state) {
  const ran = [];
  return { ran: ran, raw: { query: async function (sql, p) {
    p = p || [];
    if (/information_schema\.TABLES/.test(sql)) return [state.tables.indexOf(p[0]) !== -1 ? [{}] : []];
    if (/information_schema\.COLUMNS/.test(sql)) { const c = (state.cols || {})[p[0] + '.' + p[1]]; return [c ? [{ t: c[0], n: c[1] ? 'YES' : 'NO' }] : []]; }
    if (/information_schema\.STATISTICS/.test(sql)) { const i = (state.idx || {})[p[0] + '.' + p[1]]; return [i ? i.cols.map(function (c) { return { c: c, nu: i.unique ? 0 : 1 }; }) : []]; }
    if (/KEY_COLUMN_USAGE/.test(sql)) { const f = (state.fks || {})[p[0]]; return [f ? [f] : []]; }
    if (/LEFT JOIN/.test(sql)) return [[{ n: state.orphans || 0 }]];
    ran.push(sql); return [{}];
  } } };
}

test('enum change that is not an append is refused', async function () {
  const c = fakeConn({ tables: ['b2b_orders'], cols: { 'b2b_orders.channel': ["enum('a','b','c')", false] } });
  await assert.rejects(g.apply(c, [{ op: 'extendEnum', table: 'b2b_orders', column: 'channel', def: "ENUM('a','c','d') NOT NULL" }]), /not a prefix/);
  assert.strictEqual(c.ran.length, 0);
});

test('enum append is applied; identical enum is skipped', async function () {
  const c = fakeConn({ tables: ['b2b_x'], cols: { 'b2b_x.s': ["enum('a','b')", false] } });
  const r = await g.apply(c, [{ op: 'extendEnum', table: 'b2b_x', column: 's', def: "ENUM('a','b','z') NOT NULL DEFAULT 'a'" }]);
  assert.deepStrictEqual(r, { applied: 1, skipped: 0 });
  const c2 = fakeConn({ tables: ['b2b_x'], cols: { 'b2b_x.s': ["enum('a','b','z')", false] } });
  assert.deepStrictEqual(await g.apply(c2, [{ op: 'extendEnum', table: 'b2b_x', column: 's', def: "ENUM('a','b','z') NOT NULL DEFAULT 'a'" }]), { applied: 0, skipped: 1 });
});

test('live schema drift: column already present with another type is refused', async function () {
  const c = fakeConn({ tables: ['b2b_products'], cols: { 'b2b_products.sap_code': ['varchar(20)', true] } });
  await assert.rejects(g.apply(c, [{ op: 'addColumn', table: 'b2b_products', column: 'sap_code', def: 'VARCHAR(30) NULL' }]), /exists as varchar\(20\)/);
});

test('MariaDB-style int display widths are treated as the same type', async function () {
  const c = fakeConn({ tables: ['b2b_x'], cols: { 'b2b_x.n': ['bigint(20) unsigned', true] } });
  assert.deepStrictEqual(await g.apply(c, [{ op: 'addColumn', table: 'b2b_x', column: 'n', def: 'BIGINT UNSIGNED NULL' }]), { applied: 0, skipped: 1 });
});

test('NOT NULL column without DEFAULT is refused (would fail on existing rows)', async function () {
  const c = fakeConn({ tables: ['b2b_x'] });
  await assert.rejects(g.apply(c, [{ op: 'addColumn', table: 'b2b_x', column: 'k', def: 'INT NOT NULL' }]), /without DEFAULT/);
});

test('index name already used for other columns is refused', async function () {
  const c = fakeConn({ tables: ['b2b_x'], idx: { 'b2b_x.ix_a': { cols: ['b'], unique: false } } });
  await assert.rejects(g.apply(c, [{ op: 'addIndex', table: 'b2b_x', name: 'ix_a', columns: ['a'] }]), /exists on \(b\)/);
});

test('foreign key that existing rows would violate is refused', async function () {
  const c = fakeConn({ tables: ['b2b_x'], orphans: 3 });
  await assert.rejects(g.apply(c, [{ op: 'addForeignKey', table: 'b2b_x', name: 'fk_x', column: 'y_id', refTable: 'b2b_y', refColumn: 'id' }]), /3 rows would violate/);
});

test('makeNullable refuses a type change', async function () {
  const c = fakeConn({ tables: ['b2b_accounts'], cols: { 'b2b_accounts.email': ['varchar(190)', false] } });
  await assert.rejects(g.apply(c, [{ op: 'makeNullable', table: 'b2b_accounts', column: 'email', def: 'VARCHAR(100) NULL' }]), /differs/);
  const ok = await g.apply(c, [{ op: 'makeNullable', table: 'b2b_accounts', column: 'email', def: 'VARCHAR(190) NULL' }]);
  assert.strictEqual(ok.applied, 1);
});

test('missing table is refused', async function () {
  await assert.rejects(g.apply(fakeConn({ tables: [] }), [{ op: 'addColumn', table: 'b2b_nope', column: 'a', def: 'INT NULL' }]), /does not exist/);
});

test('SQL file changed after review is refused; destructive SQL is refused', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-'));
  const f = path.join(dir, 'x.sql');
  fs.writeFileSync(f, 'CREATE TABLE IF NOT EXISTS b2b_t (id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB;\n');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  await assert.rejects(g.runSqlFile(fakeConn({ tables: [] }), f, 'deadbeef'), /changed since it was reviewed/);
  assert.strictEqual(await g.runSqlFile(fakeConn({ tables: [] }), f, sha), 1);
  fs.writeFileSync(f, 'DROP TABLE b2b_orders;\n');
  const sha2 = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  await assert.rejects(g.runSqlFile(fakeConn({ tables: [] }), f, sha2), /Refused/);
});

test('the forbidden-statement guard', function () {
  ['DROP TABLE b2b_x', 'ALTER TABLE b2b_x DROP COLUMN a', 'TRUNCATE b2b_x', 'DELETE FROM b2b_x', 'UPDATE b2b_x SET a=1',
   'INSERT INTO b2b_x VALUES (1)', 'ALTER TABLE b2b_x RENAME TO b2b_y', 'ALTER TABLE b2b_x DROP FOREIGN KEY f']
    .forEach(function (s) { assert.ok(g.FORBIDDEN.test(s), s); });
  ['CREATE TABLE IF NOT EXISTS b2b_x (u DATETIME ON UPDATE CURRENT_TIMESTAMP)', 'ALTER TABLE b2b_x ADD COLUMN a INT NULL']
    .forEach(function (s) { assert.ok(!g.FORBIDDEN.test(s), s); });
});

test('every generated migration pins its SQL file and only uses allowed operations', function () {
  const dir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const files = fs.readdirSync(dir).filter(function (f) { return /^\d{3}_[a-z0-9_]+\.js$/.test(f) && Number(f.slice(0, 3)) >= 4; });   // 001–003 are the existing B2B migrations
  // Exactly the ERP migrations 004–012 and 015 (013/014 are reserved and never reused).
  // Anything else in the folder (e.g. the untracked 013/014 under the D5 inspection) fails here, by name.
  const EXPECTED = ['004_core_governance.js', '005_products_pricing.js', '006_vendors.js', '007_procurement_lots.js', '008_inventory.js',
    '009_network.js', '010_field_sales.js', '011_returns_recalls.js', '012_finance.js', '015_identity_bootstrap.js', '016_notification_center.js', '017_inventory_ledger.js', '018_notification_workflow.js', '019_operations_channels.js', '020_manufacturing_delivery.js'];
  const unexpected = files.filter(function (f) { return EXPECTED.indexOf(f) === -1; });
  const missing = EXPECTED.filter(function (f) { return files.indexOf(f) === -1; });
  assert.deepStrictEqual({ unexpected: unexpected, missing: missing }, { unexpected: [], missing: [] },
    'migration files differ from 004–012 + 015–020' + (unexpected.length ? ' — unexpected: ' + unexpected.join(', ') + ' (D5: do not run, edit or delete without the owner\'s decision)' : ''));
  files.forEach(function (f) {
    const m = require(path.join(dir, f));
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const sqlName = src.match(/'sql', '([^']+)'/)[1];
    const pinned = src.match(/SQL_SHA256 = '([0-9a-f]{64})'/)[1];
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'sql', sqlName))).digest('hex');
    assert.strictEqual(actual, pinned, f + ' pin');
    m.OPS.forEach(function (o) { assert.ok(['addColumn', 'extendEnum', 'makeNullable', 'addIndex', 'addForeignKey'].indexOf(o.op) !== -1, f); });
  });
});
