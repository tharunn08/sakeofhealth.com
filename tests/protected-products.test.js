/**
 * The four protected shop products — acceptance tests.
 *
 * They must survive: (1) application restart, (2) production redeployment, (3) database migration,
 * (4) backup and restore, (5) CSV import, (6) bulk product updates, (7) admin deletion attempts,
 * (8) product synchronisation — and the application must fail safely when the integrity check fails.
 * Enforcement is in the store (src/services/productProtection.js wraps db.products), so every path —
 * Admin API, scripts, seed, importers — is covered, not only the Delete button.
 *
 * Runs the real store in temporary folders (a fresh Node process per step = a real restart) and the
 * real server over HTTP. Nothing here touches a real data folder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { startServer, bearer, ROOT, prodEnv, PROD_ADMIN_PASSWORD } = require('./helpers/server.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const env3 = () => ({ DATA_DIR: tmp('pp-data-'), CATALOGUE_DIR: tmp('pp-cat-'), BACKUP_DIR: tmp('pp-bak-') });
const IDS = ['soh-core-multivitamin', 'soh-core-iron', 'soh-core-curcumin', 'soh-core-probiotic'];

/** A few lines against the real store in a fresh process (NODE_ENV=production unless given). */
function run(env, body) {
  const code = "const { db } = require('./src/services/db.js'); const g = require('./src/services/catalogueGuard.js'); const P = require('./src/services/productProtection.js'); const quiet = { log() {}, warn() {}, error() {} };\n" +
    'function attempt(fn) { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, status: e.status, code: e.code, message: e.message }; } }\n' +
    'const out = (function () {' + body + '})();\nprocess.stdout.write("\\n" + JSON.stringify(out === undefined ? null : out));';
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: Object.assign({}, process.env, { NODE_ENV: 'production' }, env), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  const lines = r.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}
const products = (env) => JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, 'products.json'), 'utf8'));
const protectedOf = (list) => list.filter(p => IDS.includes(p.id)).map(p => [p.id, p.slug, p.name, p.category, p.active]).sort();
const EXPECTED = [
  ['soh-core-curcumin', 'curcumin', 'Curcumin Gummies', 'athletic', true],
  ['soh-core-iron', 'iron', 'Iron Gummies', 'iron', true],
  ['soh-core-multivitamin', 'multivitamin', 'Multivitamin Gummies', 'multivitamins', true],
  ['soh-core-probiotic', 'probiotic', 'Probiotic & Prebiotic Gummies', 'multivitamins', true]];
const changes = (env) => {
  try { return fs.readFileSync(path.join(env.CATALOGUE_DIR, 'protected-products-changes.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch (e) { return []; }
};
const verifyCli = (env) => spawnSync(process.execPath, ['scripts/protected-products.js', 'verify', '--json'], { cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8' });

/* ── the registry itself ── */
test('the registry holds exactly the four products, identity pinned (a change must be deliberate and reviewed)', () => {
  const reg = require('../src/catalogue/protected-products.json');
  const identity = reg.products.map(p => [p.id, p.slug, p.name, p.category, p.sku, p.legacyIds]);
  assert.deepEqual(identity.map(x => x[0]), ['soh-core-multivitamin', 'soh-core-iron', 'soh-core-curcumin', 'soh-core-probiotic']);
  // Pin: changing a protected identity must change this test too, on purpose.
  // 25 Nov 2026: pin moved from d7bf787998b59c5e to f4ddc0f2a4ca5a4b. The only change is the reviewed repair that added
  // each product's original live id to legacyIds (docs/unified/PROTECTED-PRODUCTS.md, the adopt step); id, slug,
  // name, category and sku are unchanged, and the state before it is kept in protected-products.before-repair.json.
  assert.deepEqual(reg.products.map(p => p.legacyIds.length), [1, 1, 1, 1], 'one original id per product');
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16), 'f4ddc0f2a4ca5a4b',
    'the protected identities changed: if this was intended, update this pin in the same reviewed change');
  reg.products.forEach(p => {
    const page = fs.readFileSync(path.join(ROOT, p.page), 'utf8');
    assert.ok(page.includes("sohCartClick(event,'" + p.slug + "','" + p.name.replace('&', '&amp;') + "'," + p.restore.price), p.slug + ': the product page sells this id, name and price');
    assert.ok(page.includes('₹' + p.restore.mrp), p.slug + ': MRP on the page');
    assert.equal(p.restore.stock, null, 'no invented stock');
    assert.equal(p.sku, null, 'no SKU until the owner confirms it');
    assert.deepEqual(p.toConfirm, ['sku', 'hsnCode', 'gstRate']);
    [p.restore.image].concat(p.restore.images).forEach(img => assert.ok(fs.existsSync(path.join(ROOT, 'frontend', img)), img + ' ships with the code'));
  });
});

/* ── store-level rules (every caller) ── */
test('the store refuses to delete, hide, archive, mark upcoming or re-identify a protected product — and logs the attempt', () => {
  const env = env3();
  const r = run(env, `g.ensure(db, quiet);
    const ctx = { actor: 'test:bulk-script', reason: 'testing the rules' };
    return P.run(ctx, function () { return {
      del: attempt(() => db.products.remove('soh-core-iron')),
      hide: attempt(() => db.products.update('soh-core-iron', { active: false })),
      upcoming: attempt(() => db.products.update('soh-core-iron', { upcoming: true })),
      archive: attempt(() => db.products.update('soh-core-iron', { archived: true })),
      rename: attempt(() => db.products.update('soh-core-iron', { name: 'Iron Max' })),
      reslug: attempt(() => db.products.update('soh-core-iron', { slug: 'iron-2' })),
      recat: attempt(() => db.products.update('soh-core-iron', { category: 'general' })),
      dup: attempt(() => db.products.insert({ name: 'Iron Gummies', slug: 'iron', price: 1 })),
      other: attempt(() => { const x = db.products.insert({ name: 'Test Gummy', slug: 'test-gummy', price: 99 }); db.products.update(x.id, { active: false }); return db.products.remove(x.id); }),
    }; });`);
  assert.deepEqual([r.del.status, r.del.code], [409, 'protected_delete']);
  for (const k of ['hide', 'upcoming', 'archive']) assert.deepEqual([r[k].status, r[k].code], [409, 'protected_active'], k);
  for (const k of ['rename', 'reslug', 'recat']) assert.deepEqual([r[k].status, r[k].code], [409, 'protected_identity'], k);
  assert.deepEqual([r.dup.status, r.dup.code], [409, 'protected_duplicate']);
  assert.equal(r.other.ok, true, 'ordinary products are not affected');
  assert.deepEqual(protectedOf(products(env)), EXPECTED);
  assert.ok(changes(env).some(c => c.op === 'delete_refused' && c.productId === 'soh-core-iron' && c.actor === 'test:bulk-script'));
});

test('price, MRP, stock and text changes need a reason; each is logged with who, when, why and before → after', () => {
  const env = env3();
  const r = run(env, `g.ensure(db, quiet);
    const none = attempt(() => db.products.update('soh-core-curcumin', { price: 599 }));
    const short = P.run({ actor: 'admin:a@b.c', reason: 'ok' }, () => attempt(() => db.products.update('soh-core-curcumin', { price: 599 })));
    const good = P.run({ actor: 'admin:a@b.c', reason: 'Festival price agreed with sales' }, () => attempt(() => db.products.update('soh-core-curcumin', { price: 599, stock: 120, shortDescription: 'New copy' })));
    const same = attempt(() => db.products.update('soh-core-curcumin', { price: 599 }));
    const sku1 = P.run({ actor: 'admin:a@b.c', reason: 'SKU confirmed by owner' }, () => attempt(() => db.products.update('soh-core-curcumin', { sku: 'SOH-CU-60' })));
    const sku2 = P.run({ actor: 'admin:a@b.c', reason: 'typo fix' }, () => attempt(() => db.products.update('soh-core-curcumin', { sku: 'SOH-CU-61' })));
    return { none, short, good, same, sku1, sku2, p: db.products.findById('soh-core-curcumin') };`);
  assert.deepEqual([r.none.status, r.none.code], [400, 'reason_required']);
  assert.deepEqual([r.short.status, r.short.code], [400, 'reason_required'], 'a real reason, not two letters');
  assert.equal(r.good.ok, true); assert.equal(r.same.ok, true, 'saving without changes needs no reason');
  assert.equal(r.sku1.ok, true, 'an empty SKU may be set once, with a reason');
  assert.deepEqual([r.sku2.status, r.sku2.code], [409, 'protected_identity'], 'then it is locked');
  assert.equal(r.p.price, 599); assert.equal(r.p.stock, 120); assert.equal(r.p.sku, 'SOH-CU-60');
  const log = changes(env).filter(c => c.op === 'update' && c.productId === 'soh-core-curcumin');
  assert.equal(log.length, 2);
  assert.equal(log[0].actor, 'admin:a@b.c'); assert.equal(log[0].reason, 'Festival price agreed with sales');
  assert.deepEqual(log[0].before, { price: 576, stock: null, shortDescription: require('../src/catalogue/protected-products.json').products[2].restore.shortDescription });
  assert.deepEqual(log[0].after, { price: 599, stock: 120, shortDescription: 'New copy' });
  assert.ok(!Number.isNaN(Date.parse(log[0].at)));
});

test('an insert of a protected product under another id (seed, import, old backup) is stored under its registry id and registry identity', () => {
  const env = env3();
  const r = run(env, `return P.run({ system: true, actor: 'test:importer' }, () => db.products.insert({ id: 'b7e1-old-uuid', name: 'Iron + Folic Acid Gummies', slug: 'iron', price: 549, active: false }));`);
  assert.deepEqual([r.id, r.name, r.slug, r.active, r.price], ['soh-core-iron', 'Iron Gummies', 'iron', true, 549]);
  const log = changes(env).filter(c => c.op === 'insert');
  assert.deepEqual(log[0].normalised.id, { given: 'b7e1-old-uuid', stored: 'soh-core-iron' });
});

/* ── 1. application restart ── */
test('acceptance 1 — restart: the four products and their edits are there after the server restarts', async () => {
  const env = env3();
  let s = await startServer(env);
  const tok = (await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token;
  const p = await s.patch('/api/admin/products/soh-core-probiotic', { price: 649, reason: 'Price review November' }, bearer(tok));
  assert.equal(p.status, 200, JSON.stringify(p.data));
  await s.stop();
  s = await startServer(env);
  try {
    const list = (await s.get('/api/shop/products')).data.products;
    assert.deepEqual(list.filter(x => IDS.includes(x.id)).map(x => x.id).sort(), IDS.slice().sort());
    assert.equal(list.find(x => x.id === 'soh-core-probiotic').price, 649);
    const h = await s.get('/api/health');
    assert.equal(h.data.protectedProducts, true);
  } finally { await s.stop(); }
});

/* ── 2. production redeployment ── */
test('acceptance 2 — redeploy in production: a new empty data folder gets the products back from the snapshot outside the site folder, same ids, edits kept', async () => {
  const first = env3();
  let s = await startServer(prodEnv(Object.assign({ AUTO_SEED: 'false' }, first)));
  const tok = (await s.post('/api/admin/login', { email: 'admin@test.local', password: PROD_ADMIN_PASSWORD })).data.token;
  assert.equal((await s.patch('/api/admin/products/soh-core-iron', { price: 599, reason: 'Redeploy test price' }, bearer(tok))).status, 200);
  await s.stop();
  run(first, 'g.stop(); return g.snapshot();');   // the minute timer would have done this
  // the new deployment: fresh site folder, and (worst case) an empty data folder — snapshots survive outside
  const second = { DATA_DIR: tmp('pp-data-redeploy-'), CATALOGUE_DIR: first.CATALOGUE_DIR, BACKUP_DIR: tmp('pp-bak-empty-') };
  s = await startServer(prodEnv(Object.assign({ AUTO_SEED: 'true' }, second)));
  try {
    const list = (await s.get('/api/shop/products')).data.products;
    assert.deepEqual(protectedOf(list.map(x => Object.assign({ active: true }, x))), EXPECTED);
    assert.equal(list.find(x => x.id === 'soh-core-iron').price, 599, 'the edit survived the redeploy');
    assert.match(s.log(), /restored 4 product\(s\) from the snapshot/);
  } finally { await s.stop(); }
  assert.equal(verifyCli(second).status, 0);
});

/* ── 3. database migration ── */
test('acceptance 3 — migrations: no migration or migration tool touches the shop store; a start after migrating still verifies', () => {
  const dir = path.join(ROOT, 'src/db/migrations');
  const files = fs.readdirSync(dir).concat(fs.readdirSync(path.join(dir, 'sql')).map(f => 'sql/' + f)).filter(f => /\.(js|sql)$/.test(f));
  assert.ok(files.length >= 18);
  for (const f of files) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/services\/db\.js|products\.json|DATA_DIR|sakeofhealth-data/.test(t), f + ' must not reach the shop store');
  }
  for (const f of ['scripts/migrate.js', 'src/db/migrate.js']) {
    if (fs.existsSync(path.join(ROOT, f))) assert.ok(!/services\/db\.js|products\.json/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
  }
  // the business platform reads shop products only through the read-only adapter
  const adapter = require('../src/modules/erp/b2cfeed/readonly-adapter.js');
  assert.ok(!Object.keys(adapter).some(k => /write|save|update|insert|remove|delete/i.test(k)), 'the adapter has no write function');
  assert.throws(() => adapter.readShop('staff'), /Not a readable shop collection/);
  const env = env3();
  run(env, 'g.ensure(db, quiet); return null;');
  assert.equal(verifyCli(env).status, 0);
});

/* ── 4. backup and restore ── */
test('acceptance 4 — backup and restore: npm run backup, a lost data folder, npm run restore:shop → the same four products, same ids', () => {
  const env = env3();
  run(env, "g.ensure(db, quiet); P.run({ actor: 'test', reason: 'Backup test price' }, () => db.products.update('soh-core-multivitamin', { price: 649 })); return null;");
  const b = spawnSync(process.execPath, ['scripts/backup.js'], { cwd: ROOT, env: Object.assign({}, process.env, env, { DB_HOST: '', DB_NAME: '', B2B_ENABLED: 'false', ERP_ENABLED: 'false' }), encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr + b.stdout);
  const backup = fs.readdirSync(env.BACKUP_DIR).filter(n => /^backup-/.test(n))[0];
  assert.ok(backup);
  fs.rmSync(env.DATA_DIR, { recursive: true, force: true });          // the data folder is lost
  fs.mkdirSync(env.DATA_DIR);
  const dry = spawnSync(process.execPath, ['scripts/restore-shop.js', path.join(env.BACKUP_DIR, backup)], { cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8' });
  assert.equal(dry.status, 0); assert.match(dry.stdout, /Nothing changed/); assert.ok(!fs.existsSync(path.join(env.DATA_DIR, 'products.json')), 'the first run only shows');
  const go = spawnSync(process.execPath, ['scripts/restore-shop.js', path.join(env.BACKUP_DIR, backup), '--yes'], { cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8' });
  assert.equal(go.status, 0, go.stderr + go.stdout);
  assert.deepEqual(protectedOf(products(env)), EXPECTED);
  assert.equal(products(env).find(p => p.id === 'soh-core-multivitamin').price, 649);
  assert.equal(verifyCli(env).status, 0);
  // a backup with a damaged protected product is refused
  const bad = path.join(env.BACKUP_DIR, 'damaged'); fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'products.json'), JSON.stringify(products(env).map(p => p.id === 'soh-core-iron' ? Object.assign({}, p, { active: false }) : p)));
  const refused = spawnSync(process.execPath, ['scripts/restore-shop.js', bad, '--yes'], { cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.match(refused.stderr, /damaged protected products/);
});

/* ── 5. CSV import ── */
test('acceptance 5 — CSV import: rows for the protected products cannot rename, hide or duplicate them; other rows import; the trade import never reaches the shop', () => {
  const env = env3();
  const csv = 'slug,name,price,active\niron,Iron Max,1,false\nprobiotic,Probiotic & Prebiotic Gummies,640,true\nvitamin-d3,Vitamin D3 Gummies,499,true\n';
  fs.writeFileSync(path.join(env.DATA_DIR, 'import.csv'), csv);
  const r = run(env, `g.ensure(db, quiet);
    const rows = require('fs').readFileSync(process.env.DATA_DIR + '/import.csv', 'utf8').trim().split('\\n').slice(1).map(l => { const c = l.split(','); return { slug: c[0], name: c[1], price: Number(c[2]), active: c[3] === 'true' }; });
    return P.run({ actor: 'import:products.csv', reason: 'Bulk price import November', via: 'csv-import' }, () => rows.map(row => {
      const existing = db.products.findOne({ slug: row.slug });
      return [row.slug, attempt(() => existing ? db.products.update(existing.id, row) : db.products.insert(row))];
    }));`);
  const res = Object.fromEntries(r.map(([k, v]) => [k, v]));
  assert.deepEqual([res.iron.status, res.iron.code], [409, 'protected_identity'], 'the iron row is refused as a whole');
  assert.equal(res.probiotic.ok, true, 'a valid price update to a protected product is accepted (with the import reason)');
  assert.equal(res['vitamin-d3'].ok, true);
  const list = products(env);
  assert.deepEqual(protectedOf(list), EXPECTED);
  assert.equal(list.find(p => p.id === 'soh-core-iron').price, 581);
  assert.equal(list.find(p => p.id === 'soh-core-probiotic').price, 640);
  assert.ok(changes(env).some(c => c.actor === 'import:products.csv' && c.reason === 'Bulk price import November'));
  // the trade (B2B) Excel/CSV import writes to the business database only
  const importDir = path.join(ROOT, 'src/modules/b2b/imports');
  for (const f of fs.readdirSync(importDir)) assert.ok(!/services\/db\.js|products\.json/.test(fs.readFileSync(path.join(importDir, f), 'utf8')), f);
});

/* ── 6. bulk product updates ── */
test('acceptance 6 — bulk updates: hiding every product hides the others but not the four; a bulk price change applies to all with one reason, logged per product', () => {
  const env = env3();
  const r = run(env, `g.ensure(db, quiet);
    ['A', 'B'].forEach(n => db.products.insert({ name: 'Other ' + n, slug: 'other-' + n.toLowerCase(), price: 100 }));
    const hide = db.products.all().map(p => [p.id, attempt(() => db.products.update(p.id, { active: false })).ok]);
    const price = P.run({ actor: 'admin:bulk', reason: 'GST revision: +2% on all products' }, () => db.products.all().map(p => attempt(() => db.products.update(p.id, { price: Math.round(p.price * 1.02) })).ok));
    return { hide, price, list: db.products.all() };`);
  assert.deepEqual(r.hide.filter(x => !x[1]).map(x => x[0]).sort(), IDS.slice().sort());
  assert.ok(r.price.every(Boolean));
  assert.deepEqual(protectedOf(r.list), EXPECTED);
  assert.equal(r.list.find(p => p.id === 'soh-core-multivitamin').price, Math.round(621 * 1.02));
  assert.equal(changes(env).filter(c => c.op === 'update' && c.reason === 'GST revision: +2% on all products').length, 4);
});

/* ── 7. admin deletion attempts ── */
test('acceptance 7 — Admin: delete, hide and rename are refused by the API (not just a hidden button); edits need a reason; the change log is readable', async () => {
  const s = await startServer();
  try {
    const tok = (await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token;
    const h = bearer(tok);
    const list = (await s.get('/api/admin/products', h)).data.products;
    assert.deepEqual(list.filter(p => p.protected).map(p => p.id).sort(), IDS.slice().sort());
    const del = await s.del('/api/admin/products/soh-core-iron', h);
    assert.deepEqual([del.status, del.data.code], [409, 'protected_delete']);
    const hide = await s.patch('/api/admin/products/soh-core-iron', { active: false, reason: 'Testing hide' }, h);
    assert.deepEqual([hide.status, hide.data.code], [409, 'protected_active']);
    const rename = await s.patch('/api/admin/products/soh-core-iron', { name: 'Iron Plus', reason: 'Testing rename' }, h);
    assert.deepEqual([rename.status, rename.data.code], [409, 'protected_identity']);
    const noReason = await s.patch('/api/admin/products/soh-core-iron', { price: 590 }, h);
    assert.deepEqual([noReason.status, noReason.data.code], [400, 'reason_required']);
    const ok = await s.patch('/api/admin/products/soh-core-iron', { price: 590, reason: 'Price review November' }, h);
    assert.equal(ok.status, 200);
    const dup = await s.post('/api/admin/products', { name: 'Iron Gummies', slug: 'iron', price: 10 }, h);
    assert.deepEqual([dup.status, dup.data.code], [409, 'protected_duplicate']);
    const hist = await s.get('/api/admin/products/soh-core-iron/history', h);
    assert.equal(hist.status, 200);
    const last = hist.data.changes[0];
    assert.equal(last.reason, 'Price review November'); assert.match(last.actor, /^admin:admin@test\.local/);
    assert.deepEqual(last.after, { price: 590 });
    assert.ok(hist.data.changes.some(c => c.op === 'delete_refused'));
    // the shop still sells all four
    const shop = (await s.get('/api/shop/products')).data.products;
    assert.equal(shop.filter(p => IDS.includes(p.id)).length, 4);
    // admin page: no delete button and locked fields for protected products
    const page = fs.readFileSync(path.join(ROOT, 'frontend/admin/page-products.js'), 'utf8');
    assert.match(page, /p\.protected \? '' : '<button class="btn btn-ghost btn-icon" data-del=/);
    assert.match(page, /\['pName', 'pCategory', 'pActive', 'pUpcoming'\]\.forEach\(function \(k\) \{ document\.getElementById\(k\)\.disabled = locked; \}\)/);
  } finally { await s.stop(); }
});

/* ── 8. product synchronisation ── */
test('acceptance 8 — synchronisation: the business platform\'s shop-stock sync only reads the shop; the four products are unchanged by it', () => {
  const svc = fs.readFileSync(path.join(ROOT, 'src/modules/erp/shopstock/service.js'), 'utf8');
  assert.ok(!/services\/db\.js|writeFileSync|products\.json/.test(svc), 'shop-stock sync does not write the shop store');
  assert.ok(/adapter\.readShop\('products'\)/.test(svc), 'it reads through the read-only adapter');
  const env = env3();
  run(env, 'g.ensure(db, quiet); return null;');
  const before = fs.readFileSync(path.join(env.DATA_DIR, 'products.json'), 'utf8');
  const r = spawnSync(process.execPath, ['-e', "const a = require('./src/modules/erp/b2cfeed/readonly-adapter.js'); const x = a.readShop('products'); process.stdout.write(JSON.stringify(x.items.length))"],
    { cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim().split('\n').pop(), '4');
  assert.equal(fs.readFileSync(path.join(env.DATA_DIR, 'products.json'), 'utf8'), before);
});

/* ── integrity and failing safely ── */
test('integrity: identity edited in the file by hand is repaired at start and logged; npm run verify:products reports OK / FAIL with an exit code', () => {
  const env = env3();
  run(env, 'g.ensure(db, quiet); return null;');
  const f = path.join(env.DATA_DIR, 'products.json');
  fs.writeFileSync(f, JSON.stringify(products(env).map(p => p.id === 'soh-core-curcumin' ? Object.assign({}, p, { name: 'Curcumin XL', active: false }) : p)));
  assert.equal(verifyCli(env).status, 1, 'damaged → exit 1');
  const r = run(env, 'const d = g.ensure(db, quiet); return d;');
  assert.deepEqual(r.repaired, ['curcumin']); assert.equal(r.integrity.ok, true);
  assert.deepEqual(protectedOf(products(env)), EXPECTED);
  assert.ok(changes(env).some(c => c.op === 'repair' && c.before.name === 'Curcumin XL'));
  const ok = verifyCli(env); assert.equal(ok.status, 0); assert.equal(JSON.parse(ok.stdout).ok, true);
});

test('fail safe: in production a damaged catalogue that cannot be repaired automatically (a duplicate) stops the server before it takes orders', async () => {
  const env = env3();
  run(env, 'g.ensure(db, quiet); return null;');
  const list = products(env);
  list.push(Object.assign({}, list.find(p => p.id === 'soh-core-iron'), { id: 'copied-by-hand' }));
  fs.writeFileSync(path.join(env.DATA_DIR, 'products.json'), JSON.stringify(list));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['index.js'], { cwd: ROOT, env: Object.assign({}, process.env, env, prodEnv({
    PORT: String(port), AUTO_SEED: 'false', ADMIN_EMAIL: 'admin@test.local',
    ADMIN_JWT_SECRET: 'test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz', CUSTOMER_JWT_SECRET: 'test-customer-secret-0123456789-abcdefghijklmnopqrstuv' })), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const code = await new Promise(resolve => { child.on('exit', resolve); setTimeout(() => { child.kill(); resolve('still running'); }, 15000); });
  assert.equal(code, 78, log);
  assert.match(log, /Not starting: the four protected products failed the integrity check/);
  assert.match(log, /iron — stored 2 times/);
  // nothing was changed in the file: a person decides
  assert.equal(products(env).length, list.length);
  // explicitly allowed to run anyway: starts, and says so on /api/health
  const s = await startServer(prodEnv(Object.assign({ AUTO_SEED: 'false', PROTECTED_PRODUCTS_STRICT: 'false' }, env)));
  try { assert.equal((await s.get('/api/health')).data.protectedProducts, false); } finally { await s.stop(); }
});
