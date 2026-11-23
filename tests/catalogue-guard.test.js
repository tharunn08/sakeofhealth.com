/**
 * The shop's products survive redeploys and migrations (src/services/catalogueGuard.js).
 * Uses the real JSON store in temporary folders: empty folder → core products; edits kept in snapshots
 * outside the data folder; a new empty folder → restored from the latest snapshot (with the edits);
 * a protected product removed from the file comes back; a completely empty folder is restored from the
 * daily backup; nothing existing is ever overwritten. (The protection rules themselves:
 * tests/protected-products.test.js.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const quiet = { log() {}, warn() {}, error() {} };

/** Run a few lines against the real store with DATA_DIR / CATALOGUE_DIR / BACKUP_DIR set (fresh process each time). */
function run(env, body) {
  const code = "const { db } = require('./src/services/db.js'); const g = require('./src/services/catalogueGuard.js'); const quiet = { log() {}, warn() {}, error() {} };\n" +
    'const out = (function () {' + body + '})();\nprocess.stdout.write(JSON.stringify(out === undefined ? null : out));';
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: Object.assign({}, process.env, { NODE_ENV: 'production' }, env), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const lines = r.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

test('an empty shop gets the four protected products (registry ids, the product pages\' names and prices, on sale, no invented SKU or stock)', () => {
  const env = { DATA_DIR: tmp('cg-data-'), CATALOGUE_DIR: tmp('cg-cat-'), BACKUP_DIR: tmp('cg-bak-') };
  const r = run(env, 'const d = g.ensure(db, quiet); return { d: d, p: db.products.all().map(function (p) { return [p.id, p.slug, p.name, p.price, p.active, p.upcoming, p.stock, p.sku]; }) };');
  assert.equal(r.d.restoredFrom, 'protected-products registry');
  assert.equal(r.d.integrity.ok, true);
  assert.deepEqual(r.p, [
    ['soh-core-multivitamin', 'multivitamin', 'Multivitamin Gummies', 621, true, false, null, ''],
    ['soh-core-iron', 'iron', 'Iron Gummies', 581, true, false, null, ''],
    ['soh-core-curcumin', 'curcumin', 'Curcumin Gummies', 576, true, false, null, ''],
    ['soh-core-probiotic', 'probiotic', 'Probiotic & Prebiotic Gummies', 626, true, false, null, '']]);
  assert.equal(fs.readdirSync(env.CATALOGUE_DIR).filter(n => /^products-/.test(n)).length, 1, 'a snapshot was taken');
});

test('the product pages\' cart IDs (multivitamin, iron, curcumin, probiotic) price correctly at checkout after a restore', () => {
  const env = { DATA_DIR: tmp('cg-data-'), CATALOGUE_DIR: tmp('cg-cat-'), BACKUP_DIR: tmp('cg-bak-') };
  const r = run(env, "g.ensure(db, quiet); const { priceCart } = require('./src/services/checkoutPricing.js'); return priceCart({ items: [{ id: 'iron', qty: 1, price: 581 }, { id: 'probiotic', qty: 2, price: 626 }] });");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.lines.map(l => [l.id, l.price, l.qty, l.priceChanged]), [['soh-core-iron', 581, 1, false], ['soh-core-probiotic', 626, 2, false]]);
});

test('edits survive a move to a new, empty data folder (restored from the snapshot outside the site folder)', () => {
  const cat = tmp('cg-cat-'), bak = tmp('cg-bak-');
  run({ DATA_DIR: tmp('cg-data-'), CATALOGUE_DIR: cat, BACKUP_DIR: bak }, "g.ensure(db, quiet); const p = db.products.findOne({ slug: 'iron' }); require('./src/services/productProtection.js').run({ actor: 'test', reason: 'New price agreed' }, function () { db.products.update(p.id, { price: 599, stock: 42 }); }); db.products.insert({ name: 'Vitamin D3 Gummies', slug: 'vitamin-d3', price: 499, active: true }); g.stop(); g.snapshot(); return null;");
  // a redeploy / migration points the shop at a new, empty folder and the backup folder is gone too
  const r = run({ DATA_DIR: tmp('cg-data2-'), CATALOGUE_DIR: cat, BACKUP_DIR: tmp('cg-bak-empty-') },
    "const d = g.ensure(db, quiet); return { d: d, iron: db.products.findOne({ slug: 'iron' }), d3: !!db.products.findOne({ slug: 'vitamin-d3' }), n: db.products.count() };");
  assert.match(r.d.restoredFrom, /^snapshot products-/);
  assert.equal(r.iron.price, 599); assert.equal(r.iron.stock, 42, 'the admin\'s edits, not the core defaults');
  assert.equal(r.d3, true, 'products added in Admin come back too'); assert.equal(r.n, 5);
});

test('a protected product removed from the file by hand comes back as last saved; other products and edits are never overwritten', () => {
  const env = { DATA_DIR: tmp('cg-data-'), CATALOGUE_DIR: tmp('cg-cat-'), BACKUP_DIR: tmp('cg-bak-') };
  run(env, "g.ensure(db, quiet); const p = db.products.findOne({ slug: 'curcumin' }); require('./src/services/productProtection.js').run({ actor: 'test', reason: 'Copy update' }, function () { db.products.update(p.id, { shortDescription: 'Edited copy' }); }); g.stop(); g.snapshot(); return null;");
  // the store refuses to delete it, so this is someone editing products.json directly
  const f = path.join(env.DATA_DIR, 'products.json');
  fs.writeFileSync(f, JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')).filter(p => p.slug !== 'curcumin'), null, 2));
  const r = run(env, "const d = g.ensure(db, quiet); return { d: d, c: db.products.findOne({ slug: 'curcumin' }), n: db.products.count() };");
  assert.deepEqual(r.d.restoredCore, ['curcumin']);
  assert.equal(r.c.id, 'soh-core-curcumin', 'same id as before');
  assert.equal(r.c.shortDescription, 'Edited copy', 'put back as last saved, from the snapshot'); assert.equal(r.c.active, true); assert.equal(r.n, 4);
  const again = run(env, 'return g.ensure(db, quiet);');
  assert.deepEqual(again.restoredCore, [], 'nothing to do when everything is there');
});

test('a completely empty data folder is restored in full (orders, customers…) from the latest daily backup', () => {
  const cat = tmp('cg-cat-'), bak = tmp('cg-bak-');
  run({ DATA_DIR: tmp('cg-data-'), CATALOGUE_DIR: cat, BACKUP_DIR: bak }, "g.ensure(db, quiet); db.orders.insert({ orderNo: 'SOH-1001', total: 581 }); db.customers.insert({ name: 'Meena' }); g.autoBackup(true); return null;");
  const r = run({ DATA_DIR: tmp('cg-data2-'), CATALOGUE_DIR: cat, BACKUP_DIR: bak }, 'const d = g.ensure(db, quiet); return { d: d, orders: db.orders.all().map(function (o) { return o.orderNo; }), customers: db.customers.count(), products: db.products.count() };');
  assert.ok(r.d.restoredBackup, 'restored from the backup');
  assert.deepEqual(r.orders, ['SOH-1001']); assert.equal(r.customers, 1); assert.equal(r.products, 4);
  // a folder that already has data is never replaced by a backup
  const env = { DATA_DIR: tmp('cg-data3-'), CATALOGUE_DIR: cat, BACKUP_DIR: bak };
  run(env, "db.orders.insert({ orderNo: 'NEW-1' }); return null;");
  const r2 = run(env, 'const d = g.ensure(db, quiet); return { d: d, orders: db.orders.all().map(function (o) { return o.orderNo; }) };');
  assert.equal(r2.d.restoredBackup, null); assert.deepEqual(r2.orders, ['NEW-1']);
});

test('a backup made with "npm run backup" (backup-…/b2c-data) is used too, and the newest backup wins', () => {
  const bak = tmp('cg-bak-'), old = path.join(bak, 'auto-20260101'), newer = path.join(bak, 'backup-20261117-090000', 'b2c-data');
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(newer, { recursive: true });
  fs.writeFileSync(path.join(old, 'products.json'), JSON.stringify([{ id: 'p-old', slug: 'old', name: 'Old', price: 1 }]));
  fs.writeFileSync(path.join(newer, 'products.json'), JSON.stringify([{ id: 'p-new', slug: 'iron', name: 'Iron Gummies', price: 581 }]));
  fs.writeFileSync(path.join(newer, 'orders.json'), JSON.stringify([{ id: 'o1', orderNo: 'SOH-7' }]));
  const r = run({ DATA_DIR: tmp('cg-data-'), CATALOGUE_DIR: tmp('cg-cat-'), BACKUP_DIR: bak }, 'const d = g.ensure(db, quiet); return { d: d, ids: db.products.all().map(function (p) { return p.id; }), orders: db.orders.count() };');
  assert.equal(r.d.restoredBackup, newer);
  assert.ok(r.ids.includes('p-new') && !r.ids.includes('p-old')); assert.equal(r.orders, 1);
  assert.equal(r.ids.length, 4, 'the three missing core products are put back next to the restored one');
});

test('a corrupt products file is kept aside (never overwritten) and is not snapshotted over the good snapshots', () => {
  const env = { DATA_DIR: tmp('cg-data-'), CATALOGUE_DIR: tmp('cg-cat-'), BACKUP_DIR: tmp('cg-bak-') };
  run(env, 'g.ensure(db, quiet); return null;');
  fs.writeFileSync(path.join(env.DATA_DIR, 'products.json'), '{ broken');
  const r = run(env, 'g.stop(); return g.snapshot();');
  assert.equal(r.written, false);
  const r2 = run(env, 'const d = g.ensure(db, quiet); return { d: d, n: db.products.count() };');
  assert.ok(r2.d.restoredBackup || /^snapshot/.test(r2.d.restoredFrom), 'the products come back from the backup or the snapshot');
  assert.equal(r2.n, 4);
  assert.equal(r2.d.keptAside.length, 1);
  assert.equal(fs.readFileSync(r2.d.keptAside[0], 'utf8'), '{ broken', 'the unreadable file is kept as it was');
});

test('protected products are recognised; the server calls the guard after the demo seed and before listening; snapshots never go to the tester\'s home folder', () => {
  const g = require('../src/services/catalogueGuard.js');
  assert.equal(g.isCore({ id: 'x', slug: 'iron' }), true);
  assert.equal(g.isCore({ id: 'soh-core-probiotic', slug: 'renamed' }), true);
  assert.equal(g.isCore({ id: 'y', slug: 'vitamin-d3' }), false);
  const admin = fs.readFileSync(path.join(ROOT, 'src/routes/admin.js'), 'utf8');
  assert.match(admin, /router\.delete\('\/products\/:id'[\s\S]{0,400}protection\.run\([\s\S]{0,200}db\.products\.remove\(req\.params\.id\)[\s\S]{0,120}protectedError\(res, e\)/, 'the delete route reports the store\'s refusal');
  const server = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert.ok(server.indexOf("catalogueGuard.ensure(db)") > server.indexOf("seed();"), 'after the demo seed, before listening');
  assert.ok(server.indexOf("catalogueGuard.ensure(db)") < server.indexOf('app.listen('));
  const saved = process.env.NODE_ENV, savedCat = process.env.CATALOGUE_DIR;
  process.env.NODE_ENV = 'test'; delete process.env.CATALOGUE_DIR;
  try { assert.ok(g.catalogueDir().indexOf(os.homedir() + path.sep + 'sakeofhealth-catalogue') !== 0); } finally { process.env.NODE_ENV = saved; if (savedCat) process.env.CATALOGUE_DIR = savedCat; }
});
