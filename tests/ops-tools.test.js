/**
 * D5 inspection tool and MySQL test runner — the safety rules that must hold
 * before either is ever pointed at a database. DB-free: the database is a
 * recording stand-in that returns rows shaped like mysql2's.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const d5 = require('../scripts/d5-inspect.js');
const runner = require('../scripts/run-mysql-tests.js');
const ROOT = path.join(__dirname, '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const HAS_013 = fs.readdirSync(path.join(ROOT, 'src/db/migrations')).some(f => /^01[34]_/.test(f));

/** A stand-in connection: records every statement, answers from `answer(sql)`. */
function fakeConn(answer) {
  const log = [];
  return { log, ended: false,
    query: async (sql, params) => { log.push(sql); return [answer(sql, params) || [], []]; },
    escapeId: n => '`' + String(n).replace(/`/g, '``') + '`',
    end: async function () { this.ended = true; } };
}

/* ═════ D5 inspector (least privilege) ═════ */
const FILES = d5.localFiles();
const fileOf = n => FILES.find(f => f.name === n);
const INVENTORY_TSV = 'db\tproject_tables\thas_migration_table\terp_core_tables\nold_import\t12\t0\t3\nshop_local\t40\t1\t5\n';
const INVENTORY = d5.parseInventory(INVENTORY_TSV);
const NARROW = ['GRANT USAGE ON *.* TO `soh_d5`@`127.0.0.1`', 'GRANT SELECT ON `shop_local`.`b2b_schema_migrations` TO `soh_d5`@`127.0.0.1`'];
function serverAnswer(grants) {
  return function (sql) {
    if (/^SHOW GRANTS/.test(sql)) return grants.map(g => ({ ['Grants for soh_d5@127.0.0.1']: g }));
    if (/VERSION\(\)/.test(sql)) return [{ v: '8.0.39', m: 'STRICT_TRANS_TABLES', l: 1 }];
    if (/`shop_local`\.b2b_schema_migrations/.test(sql)) return [
      { version: 4, name: '004_core_governance.js', checksum: fileOf('004_core_governance.js').exact, applied_at: '2026-11-10T00:00:00Z' },
      { version: 13, name: '013_erp_governance.js', checksum: 'a'.repeat(64), applied_at: '2026-11-11T16:10:00Z' },
    ];
    return [];
  };
}

test('D5: only the two fixed statements or a single SELECT can be sent', () => {
  assert.strictEqual(d5.assertReadOnly('SET SESSION TRANSACTION READ ONLY'), 'SET SESSION TRANSACTION READ ONLY');
  assert.strictEqual(d5.assertReadOnly('SHOW GRANTS FOR CURRENT_USER()'), 'SHOW GRANTS FOR CURRENT_USER()');
  assert.strictEqual(d5.assertReadOnly(' SELECT 1; '), 'SELECT 1');
  for (const bad of ['UPDATE b2b_staff SET x=1', 'DROP TABLE b2b_schema_migrations', 'SELECT 1; DROP TABLE t', 'SHOW DATABASES', 'SHOW TABLES', 'GRANT SELECT ON *.* TO x', 'SET SESSION TRANSACTION READ WRITE', 'CALL p()']) {
    assert.throws(() => d5.assertReadOnly(bad), /refused/, bad);
  }
});

test('D5 grants: only SELECT on b2b_schema_migrations, one per database that has it — never a global or database-wide grant', () => {
  const g = d5.grantStatements(INVENTORY);
  assert.deepStrictEqual(g, ["GRANT SELECT ON `shop_local`.`b2b_schema_migrations` TO 'soh_d5'@'127.0.0.1';"]);
  const tricky = d5.parseInventory('db\tproject_tables\thas_migration_table\terp_core_tables\nweird`name\t3\t1\t0\n');
  assert.deepStrictEqual(d5.grantStatements(tricky), ["GRANT SELECT ON `weird``name`.`b2b_schema_migrations` TO 'soh_d5'@'127.0.0.1';"], 'backtick escaped');
  assert.throws(() => d5.grantStatements([{ db: 'x\ny', hasMigrationTable: true }]), /unusable database name/);
  for (const line of g) {
    assert.doesNotMatch(line, /ON \*\.\*/);
    assert.doesNotMatch(line, /ON `[^`]+`\.\*/);
    assert.match(line, /^GRANT SELECT ON `(?:[^`]|``)+`\.`b2b_schema_migrations` TO 'soh_d5'@'127\.0\.0\.1';$/);
  }
});

test('D5 account: any right beyond USAGE + SELECT on migration tables is refused — including global SELECT', () => {
  assert.deepStrictEqual(d5.grantProblems(NARROW), []);
  for (const extra of [
    'GRANT SELECT ON *.* TO `soh_d5`@`127.0.0.1`',
    'GRANT SHOW DATABASES ON *.* TO `soh_d5`@`127.0.0.1`',
    'GRANT SELECT ON `shop_local`.* TO `soh_d5`@`127.0.0.1`',
    'GRANT SELECT ON `shop_local`.`b2b_orders` TO `soh_d5`@`127.0.0.1`',
    'GRANT SELECT, INSERT ON `shop_local`.`b2b_schema_migrations` TO `soh_d5`@`127.0.0.1`',
    'GRANT ALL PRIVILEGES ON *.* TO `soh_d5`@`127.0.0.1` WITH GRANT OPTION',
    'GRANT `reader`@`%` TO `soh_d5`@`127.0.0.1`',
  ]) assert.deepStrictEqual(d5.grantProblems(NARROW.concat([extra])), [extra], extra);
});

test('D5: with global SELECT the inspection stops after checking grants — nothing else is read', async () => {
  const c = fakeConn(serverAnswer(NARROW.concat(['GRANT SELECT ON *.* TO `soh_d5`@`127.0.0.1`'])));
  await assert.rejects(d5.inspect(c, 'local:3306', INVENTORY, FILES), e => e.exit === 5 && /more rights than it needs/.test(e.message));
  assert.deepStrictEqual(c.log, ['SET SESSION TRANSACTION READ ONLY', 'SHOW GRANTS FOR CURRENT_USER()']);
});

test('D5: with narrow grants it reads only server facts and the migration table of databases that have one', async () => {
  const c = fakeConn(serverAnswer(NARROW));
  const text = await d5.inspect(c, 'local:3306', INVENTORY, FILES);
  assert.deepStrictEqual(c.log.slice(0, 2), ['SET SESSION TRANSACTION READ ONLY', 'SHOW GRANTS FOR CURRENT_USER()']);
  c.log.slice(2).forEach(sql => {
    d5.assertReadOnly(sql);
    const from = [...sql.matchAll(/\bFROM\s+(\S+)/gi)].map(m => m[1]);
    from.forEach(t => assert.match(t, /^`(?:[^`]|``)+`\.b2b_schema_migrations$/, 'reads only migration tables: ' + t));
  });
  assert.ok(!c.log.some(sql => /old_import/.test(sql)), 'a database without the migration table is not queried');
  assert.match(text, /`shop_local`: migration table present · 013 applied: \*\*YES\*\* · 014 applied: \*\*no\*\*/);
  assert.match(text, /`old_import`: \*\*project tables WITHOUT a migration table\*\* — 12 b2b_\* tables, ERP core tables 3 of 5/);
  assert.match(text, /held only USAGE plus SELECT on 1 migration-history table/);
});

test('D5 inventory: the root-run query reads only information_schema.TABLES (names and counts)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'scripts/d5/inventory.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.deepStrictEqual([...sql.matchAll(/\bFROM\s+(\S+)/gi)].map(m => m[1]), ['information_schema.TABLES']);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|CREATE|GRANT|ALTER)\b/i);
  assert.match(sql, /ESCAPE '!'/);
});

test('D5 inventory file: mysql --batch output, UTF-8 or the UTF-16 PowerShell writes; wrong files refused', () => {
  assert.deepStrictEqual(INVENTORY.map(d => [d.db, d.tables, d.hasMigrationTable, d.erp]), [['old_import', 12, false, 3], ['shop_local', 40, true, 5]]);
  const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(INVENTORY_TSV.replace(/\n/g, '\r\n'), 'utf16le')]);
  assert.deepStrictEqual(d5.parseInventory(d5.decode(utf16)), INVENTORY);
  assert.deepStrictEqual(d5.parseInventory(d5.decode(Buffer.from('﻿' + INVENTORY_TSV, 'utf8'))), INVENTORY);
  assert.throws(() => d5.parseInventory('a\tb\n1\t2\n'), /not the output of scripts\/d5\/inventory\.sql/);
});

test('Windows instructions: no global grant at all; test account only on sakeofhealth_test; D5 account only via the generated grants', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'docs/phase-1/RUN-ON-WINDOWS.txt'), 'utf8');
  const grants = txt.split(/\r?\n/).map(l => l.trim()).filter(l => /^GRANT\b/i.test(l));
  assert.ok(grants.length >= 2);
  grants.forEach(g => assert.doesNotMatch(g, /ON \*\.\*/, 'no global grant: ' + g));
  grants.filter(g => /soh_test/.test(g)).forEach(g => assert.strictEqual(g, "GRANT ALL PRIVILEGES ON sakeofhealth_test.* TO 'soh_test'@'127.0.0.1';"));
  grants.filter(g => /soh_d5/.test(g)).forEach(g => assert.match(g, /^GRANT SELECT ON `<database>`\.`b2b_schema_migrations` TO 'soh_d5'@'127\.0\.0\.1';$/, g));
  assert.doesNotMatch(txt, /SHOW DATABASES ON/i);
  assert.match(txt, /DROP USER 'soh_d5'@'127\.0\.0\.1';/);
});

test('D5: the password goes only to the database driver — never into the report, the console or a file', async () => {
  const SECRET = 'S3cret-Do-Not-Print-91';
  let opts; const printed = []; const written = {};
  const text = await d5.main({
    env: { D5_HOST: '127.0.0.1', D5_USER: 'soh_d5' }, argv: ['node', 'd5', '--inventory', 'inv.tsv', '--out', 'r.md'],
    read: () => INVENTORY_TSV, prompt: async () => SECRET,
    createConnection: async o => { opts = o; return fakeConn(serverAnswer(NARROW)); },
    write: (f, t) => { written[f] = t; }, log: t => printed.push(t),
  });
  assert.strictEqual(opts.password, SECRET);
  assert.ok(!text.includes(SECRET) && !written['r.md'].includes(SECRET) && !printed.join('').includes(SECRET));
});

test('D5 grants step: writes the file itself (UTF-8, no BOM) and never connects', async () => {
  const written = {};
  await d5.main({ argv: ['node', 'd5', 'grants', '--inventory', 'inv.tsv', '--out', 'g.sql'], read: () => INVENTORY_TSV,
    createConnection: () => { throw new Error('must not connect'); }, write: (f, t) => { written[f] = t; }, log: () => {} });
  assert.strictEqual(written['g.sql'], "GRANT SELECT ON `shop_local`.`b2b_schema_migrations` TO 'soh_d5'@'127.0.0.1';\n");
  assert.notStrictEqual(written['g.sql'].charCodeAt(0), 0xFEFF);
});

test('D5: checksums of the exact bytes and of both line-ending variants', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd5-'));
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'a\nb\n');
  const [f] = d5.localFiles(dir);
  assert.deepStrictEqual([f.exact, f.lf, f.crlf], [sha('a\nb\n'), sha('a\nb\n'), sha('a\r\nb\r\n')]);
  const a = d5.analyse([{ version: 5, name: '005_products_pricing.js', checksum: fileOf('005_products_pricing.js').crlf }, { version: 6, name: '006_vendors.js', checksum: 'f'.repeat(64) }], FILES);
  assert.deepStrictEqual(a.rows.map(r => r.match), ['same file, Windows line endings', 'DIFFERENT content']);
});

test('D5: without an inventory file or a server it explains and exits', () => {
  const env = Object.assign({}, process.env); delete env.D5_HOST; delete env.D5_USER;
  const r = spawnSync(process.execPath, ['scripts/d5-inspect.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--inventory/);
});

/* ═════ MySQL test runner ═════ */
const clean = ['001_x.sql', '012_finance.js'];
const ok = { TEST_DB_NAME: 'sakeofhealth_test', TEST_DB_USER: 'soh_test' };

test('runner: only a database named *_test; _dev and _local are refused', () => {
  assert.deepStrictEqual(runner.preflight(ok, clean), []);
  for (const name of ['sakeofhealth_dev', 'sakeofhealth_local', 'sakeofhealth', 'sakeofhealth_test_backup', 'x_test;drop', '']) {
    assert.match(runner.preflight(Object.assign({}, ok, { TEST_DB_NAME: name }), clean).join(), /_test/, name);
  }
});

test('runner: refuses root, a missing account, production, and a checkout with 013/014', () => {
  assert.match(runner.preflight(Object.assign({}, ok, { TEST_DB_USER: 'root' }), clean).join(), /root/);
  assert.match(runner.preflight({ TEST_DB_NAME: 'sakeofhealth_test' }, clean).join(), /TEST_DB_USER/);
  assert.match(runner.preflight(Object.assign({}, ok, { NODE_ENV: 'production' }), clean).join(), /production/);
  assert.match(runner.preflight(ok, clean.concat(['013_erp_governance.js'])).join(), /013_erp_governance\.js.*D5/);
});

test('runner: an account with ANY right outside the test database is refused', () => {
  const mine = ['GRANT USAGE ON *.* TO `soh_test`@`localhost`', 'GRANT ALL PRIVILEGES ON `sakeofhealth_test`.* TO `soh_test`@`localhost`'];
  assert.deepStrictEqual(runner.grantProblems(mine, 'sakeofhealth_test'), []);
  assert.deepStrictEqual(runner.grantProblems(['GRANT USAGE ON *.* TO `soh_test`@`localhost`', 'GRANT ALL PRIVILEGES ON `sakeofhealth\\_test`.* TO `soh_test`@`localhost`'], 'sakeofhealth_test'), [], 'escaped underscore form');
  for (const extra of [
    'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP ON *.* TO `root`@`localhost` WITH GRANT OPTION',
    'GRANT SELECT ON `sakeofhealth`.* TO `soh_test`@`localhost`',
    'GRANT ALL PRIVILEGES ON `sakeofhealth_dev`.* TO `soh_test`@`localhost`',
    'GRANT `app_admin`@`%` TO `soh_test`@`localhost`',
    'GRANT SELECT ON `sakeofhealth_test2`.* TO `soh_test`@`localhost`',
  ]) assert.deepStrictEqual(runner.grantProblems(mine.concat([extra]), 'sakeofhealth_test'), [extra], extra);
});

test('runner: server checks — MySQL 8 only, own rights only, project tables only (read-only statements)', async () => {
  const mk = (v, grants, tables) => fakeConn(sql => /VERSION/.test(sql) ? [{ v }] : /SHOW GRANTS/.test(sql) ? grants.map(g => ({ g })) : tables.map(t => ({ t })));
  const good = ['GRANT USAGE ON *.* TO `soh_test`@`localhost`', 'GRANT ALL PRIVILEGES ON `sakeofhealth_test`.* TO `soh_test`@`localhost`'];
  const c = mk('8.0.39', good, ['b2b_orders', 'b2b_schema_migrations']);
  assert.deepStrictEqual((await runner.serverChecks(c, 'sakeofhealth_test')).problems, []);
  c.log.forEach(sql => assert.match(sql, /^(SELECT|SHOW) /, 'read-only: ' + sql));
  assert.match((await runner.serverChecks(mk('5.7.44', good, []), 'sakeofhealth_test')).problems.join(), /MySQL 8/);
  assert.match((await runner.serverChecks(mk('8.0.39', good.concat(['GRANT SELECT ON *.* TO `soh_test`@`localhost`']), []), 'sakeofhealth_test')).problems.join(), /outside sakeofhealth_test/);
  assert.match((await runner.serverChecks(mk('8.0.39', good, ['orders', 'b2b_orders']), 'sakeofhealth_test')).problems.join(), /not a dedicated test database/);
});

test('runner: the suites never see inherited DB_* settings — only TEST_DB_*', () => {
  const e = runner.childEnv({ DB_HOST: 'prod.example', DB_NAME: 'sakeofhealth', DB_PASSWORD: 'x', TEST_DB_NAME: 'sakeofhealth_test', TEST_FRESH_DB_NAME: 'y', PATH: '/bin', NODE_ENV: 'production' }, 'pw');
  assert.deepStrictEqual(Object.keys(e).filter(k => /^DB_/.test(k)), []);
  assert.strictEqual(e.TEST_FRESH_DB_NAME, undefined);
  assert.strictEqual(e.TEST_DB_PASSWORD, 'pw');
  assert.strictEqual(e.NODE_ENV, 'test');
});

test('runner, in a checkout that has 013/014: stops before connecting', { skip: HAS_013 ? false : 'clean checkout' }, () => {
  const r = spawnSync(process.execPath, ['scripts/run-mysql-tests.js'], { cwd: ROOT, env: Object.assign({}, process.env, ok, { TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '1' }), encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /D5 pending/);
});

test('test helper: refuses a database not named *_test, before connecting', async () => {
  const r = spawnSync(process.execPath, ['-e', "require('./tests/helpers/db.js').resetDatabase().then(()=>process.exit(0), e => { console.error(e.message); process.exit(7); })"],
    { cwd: ROOT, env: Object.assign({}, process.env, { TEST_DB_NAME: 'sakeofhealth_dev', TEST_DB_PORT: '1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'h-')) }), encoding: 'utf8' });
  assert.strictEqual(r.status, 7);
  assert.match(r.stderr, HAS_013 ? /D5 pending/ : /only use a dedicated database whose name ends in _test/);
});
