/**
 * Milestone 3b.1 — one ledger, duplicate-proof movements, warehouse restrictions,
 * approved adjustments (decision 5). Database-free checks of the real code; the MySQL 8
 * behaviour is in tests/inventory-ledger.mysql.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-3b1-'));
const ROOT = path.join(__dirname, '..');
const ledger = require('../src/modules/erp/inventory/ledger.js');

/** A transaction stand-in: records SQL, answers the few reads the ledger makes. */
function fakeTx(o) {
  o = o || {};
  const sql = [];
  return {
    sql: sql,
    queryOne: async function (q, p) { sql.push([q, p]); if (/WHERE idem_key = \?/.test(q)) return o.posted && o.posted.indexOf(p[0]) !== -1 ? { id: 1 } : null; return null; },
    query: async function (q, p) {
      sql.push([q, p]);
      if (/^UPDATE b2b_stock SET/.test(q)) return { affectedRows: o.enough === false ? 0 : 1 };
      if (/^INSERT INTO b2b_stock_movements/.test(q) && o.dupOnInsert) { const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e; }
      return { affectedRows: 1, insertId: 7 };
    },
  };
}
const MOVE = { warehouseId: 1, productId: 2, type: 'adjustment', qty: 5, from: 'available', actor: { type: 'staff', id: 9, label: 'wm@trial.local' } };

test('one write path: only ledger.js writes stock balances and the movement ledger', () => {
  const offenders = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) return walk(f);
      if (!/\.js$/.test(e.name)) return;
      const t = fs.readFileSync(f, 'utf8');
      if (/INSERT INTO b2b_stock_movements|UPDATE b2b_stock SET|INSERT INTO b2b_stock[ (]|DELETE FROM b2b_stock\b/.test(t)) offenders.push(path.relative(ROOT, f));
    });
  })(path.join(ROOT, 'src'));
  assert.deepEqual(offenders, ['src/modules/erp/inventory/ledger.js']);
});

test('keyed movement: posted once; the same key again moves nothing; mustMove stops the action', async () => {
  const tx = fakeTx();
  assert.equal(await ledger.move(tx, Object.assign({ idemKey: 'adj:41' }, MOVE)), true);
  const ins = tx.sql.find(function (x) { return /^INSERT INTO b2b_stock_movements/.test(x[0]); });
  assert.match(ins[0], /idem_key/); assert.equal(ins[1][ins[1].length - 1], 'adj:41');
  const again = fakeTx({ posted: ['adj:41'] });
  assert.equal(await ledger.move(again, Object.assign({ idemKey: 'adj:41' }, MOVE)), 'duplicate');
  assert.ok(!again.sql.some(function (x) { return /^UPDATE b2b_stock SET|^INSERT INTO b2b_stock/.test(x[0]); }), 'no balance touched');
  await assert.rejects(ledger.mustMove(fakeTx({ posted: ['adj:41'] }), Object.assign({ idemKey: 'adj:41' }, MOVE)), function (e) { return e.status === 409 && e.code === 'duplicate_movement'; });
});

test('two concurrent posts with one key: the database refuses the second (whole transaction rolls back)', async () => {
  await assert.rejects(ledger.move(fakeTx({ dupOnInsert: true }), Object.assign({ idemKey: 'grn:3:9:accepted' }, MOVE)), function (e) { return e.status === 409 && e.code === 'duplicate_movement'; });
  // without a key, a database duplicate error is not hidden
  await assert.rejects(ledger.move(fakeTx({ dupOnInsert: true }), MOVE), function (e) { return e.code === 'ER_DUP_ENTRY'; });
});

test('guarded update: not enough stock returns false and writes no ledger row; mustMove answers 409', async () => {
  const tx = fakeTx({ enough: false });
  assert.equal(await ledger.move(tx, MOVE), false);
  assert.ok(!tx.sql.some(function (x) { return /^INSERT INTO b2b_stock_movements/.test(x[0]); }));
  await assert.rejects(ledger.mustMove(fakeTx({ enough: false }), MOVE), function (e) { return e.status === 409 && e.code === 'insufficient_stock'; });
});

test('actors: staff recorded as admin, business and system kept; unkeyed rows carry no key column', async () => {
  const tx = fakeTx();
  await ledger.move(tx, MOVE);
  await ledger.move(tx, Object.assign({}, MOVE, { actor: { type: 'business', label: 'distributor 4' } }));
  await ledger.move(tx, Object.assign({}, MOVE, { actor: null }));
  const rows = tx.sql.filter(function (x) { return /^INSERT INTO b2b_stock_movements/.test(x[0]); });
  assert.deepEqual(rows.map(function (r) { return r[1][11]; }), ['admin', 'business', 'system']);
  rows.forEach(function (r) { assert.doesNotMatch(r[0], /idem_key/); });
  await assert.rejects(ledger.move(tx, Object.assign({}, MOVE, { qty: 0 })), /positive whole number/);
  await assert.rejects(ledger.move(tx, Object.assign({}, MOVE, { from: 'shelf' })), /Unknown stock bucket/);
});

test('B2B stock code delegates to the one ledger with its existing arguments', async () => {
  const inv = require('../src/modules/b2b/inventory/service.js');
  const tx = fakeTx();
  assert.equal(await inv.move(tx, { warehouse_id: 3, product_id: 4, batch_id: 5, type: 'reservation', qty: 2, from: 'available', to: 'reserved', ref_type: 'order', ref_id: 77 }), true);
  const ins = tx.sql.find(function (x) { return /^INSERT INTO b2b_stock_movements/.test(x[0]); });
  assert.deepEqual(ins[1].slice(0, 10), [3, 4, 5, null, 'reservation', 2, 'available', 'reserved', 'order', 77]);
  await assert.rejects(inv.move(tx, { warehouse_id: 3, product_id: 4, type: 'x', qty: 1, from: 'quarantine' }), /Unknown stock bucket/, 'B2B callers still limited to their six buckets');
});

test('B2B orders are filled only from company warehouses (never event, salesman, shop or distributor)', async () => {
  const inv = require('../src/modules/b2b/inventory/service.js');
  const seen = [];
  await inv.companyWarehouses({ query: async function (q) { seen.push(q); return []; } });
  assert.match(seen[0], /owner_account_id IS NULL/); assert.match(seen[0], /warehouse_type = 'company'/);
});

test('decision 5: direct company stock entry is refused when the ERP runs; distributors keep theirs (M7 open)', async () => {
  const realEnabled = require('../src/modules/erp/config.js').enabled;
  const cfg = require('../src/modules/erp/config.js');
  cfg.enabled = function () { return true; };
  try {
    const inv = require('../src/modules/b2b/inventory/service.js');
    for (const op of ['opening', 'purchase', 'production', 'adjust_increase', 'adjust_decrease', 'damage', 'expiry']) {
      await assert.rejects(inv.manualEntry({ warehouse_id: 1, product_id: 1, operation: op, qty: 5, reason: 'counted again' }, { type: 'admin', label: 'a' }),
        function (e) { return e.status === 409 && e.extra && e.extra.code === 'use_adjustment' && /goods receipt/.test(e.message); }, op);
    }
  } finally { cfg.enabled = realEnabled; }
  const src = fs.readFileSync(path.join(ROOT, 'src/modules/b2b/inventory/service.js'), 'utf8');
  assert.match(src, /ownerAccountId === undefined && require\('\.\.\/\.\.\/erp\/config\.js'\)\.enabled\(\)/, 'only company stock (no owner) is redirected');
});

test('adjustments: proposed by one person, posted by an approval with the key adj:<id>', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/modules/erp/inventory/service.js'), 'utf8');
  assert.match(src, /approvals\.request\(tx, actor, \{ type: 'inventory\.adjustment'/);
  assert.match(src, /approvals\.register\('inventory\.adjustment'/);
  assert.match(src, /key = 'adj:' \+ d\.id/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/modules/erp/routes/inventory.js'), 'utf8'), /r\.post\('\/adjustments', can\('inventory\.adjust\.propose'\)/);
  const approvals = fs.readFileSync(path.join(ROOT, 'src/modules/erp/core/approvals.js'), 'utf8');
  assert.match(approvals, /You cannot approve your own request/, 'the existing engine refuses self-approval');
  const ref = require('../src/modules/erp/catalog/reference-data.json');
  const has = function (role) { return ref.roles.find(function (r) { return r.code === role; }).permissions.indexOf('inventory.adjust.propose') !== -1; };
  assert.ok(ref.permissions.some(function (p) { return p.code === 'inventory.adjust.propose'; }));
  assert.deepEqual(['super_admin', 'warehouse_manager', 'inventory_executive', 'salesman', 'quality_control', 'auditor'].map(has), [true, true, true, false, false, false]);
});

test('keyed events: goods receipts, transfers, dispositions and adjustments carry duplicate-proof keys', () => {
  const proc = fs.readFileSync(path.join(ROOT, 'src/modules/erp/procurement/service.js'), 'utf8');
  const inv = fs.readFileSync(path.join(ROOT, 'src/modules/erp/inventory/service.js'), 'utf8');
  assert.equal((proc.match(/idemKey: 'grn:/g) || []).length, 2);
  assert.equal((inv.match(/idemKey: 'trf:/g) || []).length, 3);
  assert.equal((inv.match(/idemKey: 'disp:/g) || []).length, 2);
});

test('migration 017 refuses before any change when two products claim one shop product', async () => {
  const m = require('../src/db/migrations/017_inventory_ledger.js');
  const calls = [];
  const conn = { raw: { query: async function (q) { calls.push(q); if (/GROUP BY b2c_ref/.test(q)) return [[{ b2c_ref: 'curcumin', ids: '4,9' }]]; return [[]]; } } };
  await assert.rejects(m.up(conn, function () {}), /curcumin → products 4,9/);
  assert.equal(calls.length, 1, 'nothing else ran');
  assert.deepEqual(m.OPS.map(function (o) { return o.op; }), ['addColumn', 'addIndex', 'extendEnum', 'extendEnum', 'addColumn', 'addForeignKey', 'addIndex']);
  assert.match(m.OPS[2].def, /'b2c_reversal','counter_sale','counter_return'\) NOT NULL$/, 'movement types only appended');
  assert.match(m.OPS[3].def, /^ENUM\('company','distributor','online_shop','transit','event','salesman'\)/, 'warehouse types only appended');
});
