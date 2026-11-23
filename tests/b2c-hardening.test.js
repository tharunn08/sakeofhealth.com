/**
 * Phase 0.5.8–0.5.10 — seeding, /health, CSV downloads, blog
 * (BUG-007, BUG-008, BUG-016, BUG-018). Written BEFORE the fixes.
 * Every server uses a throw-away DATA_DIR; the repository's own data/ and
 * frontend/blog/ folders are checked to be left exactly as they were.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, bearer, ROOT, prodEnv } = require('./helpers/server.js');

const ip = () => '10.7.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);
function spread(srv) {
  for (const m of ['post', 'patch', 'put']) { const f = srv[m]; srv[m] = (u, b, h) => f(u, b, Object.assign({ 'X-Forwarded-For': ip() }, h || {})); }
  for (const m of ['get', 'del']) { const f = srv[m]; srv[m] = (u, h) => f(u, Object.assign({ 'X-Forwarded-For': ip() }, h || {})); }
  return srv;
}
function snapshot(dir) {
  if (!fs.existsSync(dir)) return '(missing)';
  return fs.readdirSync(dir).sort().map(f => f + ':' + fs.statSync(path.join(dir, f)).size).join('|');
}
const REPO_DATA = path.join(ROOT, 'data'), REPO_BLOG = path.join(ROOT, 'frontend', 'blog');
const before = { data: snapshot(REPO_DATA), blog: snapshot(REPO_BLOG) };
test.after(() => {
  assert.strictEqual(snapshot(REPO_DATA), before.data, 'repository data/ unchanged');
  assert.strictEqual(snapshot(REPO_BLOG), before.blog, 'repository frontend/blog/ unchanged');
});

/* ── 0.5.8 seeding (BUG-008) ── */
// Changed deliberately (owner's request, Nov 2026): the four real products must always be in the shop, so a
// production server with an empty data folder now gets exactly those four (src/catalogue/core-products.json,
// the product pages' names and prices) — still no demo catalogue, no demo coupons and no staff.
test('BUG-008: a production server with an empty data folder seeds no demo data and no staff (only the four real products)', async (t) => {
  const s = await startServer(prodEnv({ AUTO_SEED: 'true' }));
  t.after(() => s.stop());
  const staff = fs.existsSync(path.join(s.dataDir, 'staff.json')) ? JSON.parse(fs.readFileSync(path.join(s.dataDir, 'staff.json'), 'utf8')) : [];
  assert.strictEqual(staff.length, 0, 'no staff accounts');
  const products = (await s.get('/api/shop/products')).data.products;
  assert.deepStrictEqual(products.map(p => p.slug).sort(), ['curcumin', 'iron', 'multivitamin', 'probiotic'], 'only the four real products, no demo catalogue');
  assert.ok(products.every(p => /^soh-core-/.test(p.id)), 'the real products, not the demo seed');
  const coupons = fs.existsSync(path.join(s.dataDir, 'coupons.json')) ? JSON.parse(fs.readFileSync(path.join(s.dataDir, 'coupons.json'), 'utf8')) : [];
  assert.strictEqual(coupons.length, 0, 'no demo coupons');
  assert.match(s.log(), /empty|not seeding|refus/i, 'the log says why the shop is empty');
  const li = await s.post('/api/admin/login', { email: 'manager@sakeofhealth.com', password: 'manager@1234' });
  assert.notStrictEqual(li.status, 200, 'published demo password does not work');
});

test('BUG-008: in development, auto-seed creates the catalogue but no staff with published passwords', async (t) => {
  const s = await startServer({ AUTO_SEED: 'true' });
  t.after(() => s.stop());
  assert.ok((await s.get('/api/shop/products')).data.products.length > 0, 'catalogue seeded');
  const li = await s.post('/api/admin/login', { email: 'manager@sakeofhealth.com', password: 'manager@1234' });
  assert.notStrictEqual(li.status, 200);
});

test('BUG-008: in production, active demo staff left over from an old seed are reported at start-up (no passwords shown)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-test-prodstaff-'));
  fs.writeFileSync(path.join(dir, 'staff.json'), JSON.stringify([
    { id: 'st1', name: 'Operations Manager', email: 'manager@sakeofhealth.com', role: 'manager', passwordHash: 'x', active: true, createdBy: 'seed' },
    { id: 'st2', name: 'Real Person', email: 'real@shop.test', role: 'staff', passwordHash: 'y', active: true, createdBy: 'admin@shop.test' },
    { id: 'st3', name: 'Old Rider', email: 'ravi@sakeofhealth.com', role: 'delivery', passwordHash: 'z', active: false, createdBy: 'seed' },
    { id: 'st4', name: 'Support Desk', email: 'support@sakeofhealth.com', role: 'staff', passwordHash: 'w', active: true, createdBy: 'seed', passwordChangedAt: '2026-01-01T00:00:00Z' },
  ]));
  const s = await startServer(prodEnv({ DATA_DIR: dir }));
  t.after(() => s.stop());
  const log = s.log();
  assert.match(log, /manager@sakeofhealth\.com/, 'active seeded account named');
  assert.ok(!/real@shop\.test/.test(log.split('[SECURITY]')[1] || ''), 'real accounts not listed');
  assert.ok(!/ravi@sakeofhealth\.com/.test(log), 'inactive account not listed');
  assert.ok(!/support@sakeofhealth\.com/.test(log), 'account whose password was changed not listed');
  assert.ok(!/manager@1234|delivery@1234|support@1234/.test(log), 'no password in the log');
  const staff = JSON.parse(fs.readFileSync(path.join(dir, 'staff.json'), 'utf8'));
  assert.strictEqual(staff.length, 4, 'accounts are not changed or removed');
  assert.strictEqual(staff[0].active, true);
});

function runSeed(env, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-seed-'));
  const r = spawnSync(process.execPath, ['src/seed.js'].concat(args || []), { cwd: ROOT, env: Object.assign({}, process.env, { DATA_DIR: dir }, env), encoding: 'utf8' });
  const read = n => fs.existsSync(path.join(dir, n + '.json')) ? JSON.parse(fs.readFileSync(path.join(dir, n + '.json'), 'utf8')) : [];
  return { code: r.status, out: r.stdout + r.stderr, staff: read('staff'), products: read('products') };
}

test('BUG-008: "npm run seed" refuses to run in production', () => {
  const r = runSeed({ NODE_ENV: 'production' });
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual(r.products.length, 0);
  assert.strictEqual(r.staff.length, 0);
});

test('BUG-008: the seed script creates demo staff only with --with-staff, outside production', () => {
  const plain = runSeed({ NODE_ENV: 'development' });
  assert.strictEqual(plain.code, 0, plain.out);
  assert.ok(plain.products.length > 0);
  assert.strictEqual(plain.staff.length, 0, 'no staff by default');
  assert.ok(!/manager@1234/.test(plain.out), 'no passwords printed');
  const withStaff = runSeed({ NODE_ENV: 'development' }, ['--with-staff']);
  assert.strictEqual(withStaff.code, 0, withStaff.out);
  assert.ok(withStaff.staff.length > 0, 'explicit opt-in still works for local development');
  const prodStaff = runSeed({ NODE_ENV: 'production' }, ['--with-staff']);
  assert.notStrictEqual(prodStaff.code, 0);
  assert.strictEqual(prodStaff.staff.length, 0);
});

/* ── 0.5.8 /health (BUG-018) ── */
let s, admin;
test.before(async () => {
  s = spread(await startServer());
  admin = (await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' })).data.token;
});
test.after(() => s && s.stop());

test('BUG-018: /health returns status only — no counts, environment or payment mode', async () => {
  const r = await s.get('/health');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.data).sort(), ['ok']);
  assert.strictEqual(r.data.ok, true);
});

/* ── 0.5.9 CSV downloads (BUG-016) ── */
test('BUG-016: an admin token in the URL is no longer accepted', async () => {
  const r = await s.get('/api/admin/reports/customers.csv?token=' + encodeURIComponent(admin));
  assert.strictEqual(r.status, 401);
  const ok = await s.get('/api/admin/reports/customers.csv', bearer(admin));
  assert.strictEqual(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/csv/);
  assert.match(ok.headers.get('content-disposition'), /attachment; filename="customers-/);
});

test('BUG-016: the admin pages download CSVs with the token in a header, never in the address', () => {
  for (const f of ['page-customers.js', 'page-reports.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'frontend', 'admin', f), 'utf8');
    assert.ok(!/[?&]token=/.test(src), f + ' puts no token in a URL');
    assert.match(src, /Authorization/, f + ' sends the Authorization header');
  }
});

/* ── 0.5.10 blog (BUG-007) ── */
const XSS = '<script>window.__xss = 1</script>';
const body = 'First paragraph about gummies and daily routines, written to be long enough for review. ' + XSS +
  '\nSecond line of the first paragraph <img src=x onerror="window.__xss=2">.\n\n' +
  'Second paragraph: sleep, water, sunlight and a balanced plate do most of the work; supplements fill gaps. ' +
  'This sentence pads the article past the two hundred character minimum.';
let post;

test('BUG-007: blog moderation works with the normal admin session; delivery and customers are refused', async () => {
  const sub = await s.post('/api/blog/submit', { title: 'Gummies & <b>Habits</b>', category: 'Wellness', authorName: 'Tester', authorEmail: 't@test.local', content: body });
  assert.strictEqual(sub.status, 200, JSON.stringify(sub.data));
  const pending = await s.get('/api/blog/pending', bearer(admin));
  assert.strictEqual(pending.status, 200);
  post = pending.data.find(p => p.id === sub.data.id);
  assert.ok(post);
  await s.post('/api/admin/staff', { name: 'Rider', email: 'rider@blog.test', phone: '9000000002', role: 'delivery', password: 'rider-pass-123' }, bearer(admin));
  const rider = (await s.post('/api/admin/login', { email: 'rider@blog.test', password: 'rider-pass-123' })).data.token;
  assert.strictEqual((await s.get('/api/blog/pending', bearer(rider))).status, 403, 'delivery cannot moderate the blog');
  assert.strictEqual((await s.post('/api/blog/approve/' + post.id, {}, bearer(rider))).status, 403);
  const su = await s.post('/api/auth/signup', { name: 'Blog Reader', email: 'reader@blog.test', phone: '9000000004', password: 'reader-pass-123' });
  assert.ok(su.data && su.data.token, 'customer signed up: ' + su.status);
  assert.strictEqual((await s.get('/api/blog/pending', bearer(su.data.token))).status, 401, 'customer token refused');
  assert.strictEqual((await s.get('/api/blog/pending')).status, 401, 'no token refused');
});

test('BUG-007: an approved article shows submitted HTML as text (no script runs); paragraphs kept', async () => {
  const ap = await s.post('/api/blog/approve/' + post.id, {}, bearer(admin));
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.data));
  const page = await s.get('/blog/' + post.slug + '.html');
  assert.strictEqual(page.status, 200);
  const html = page.data;
  assert.ok(!html.includes(XSS), 'raw script tag not present');
  assert.ok(!/<img src=x/i.test(html), 'raw img tag not present');
  assert.ok(html.includes('&lt;script&gt;window.__xss = 1&lt;/script&gt;'), 'shown as text');
  assert.strictEqual((html.match(/<p>/g) || []).length >= 2, true, 'two paragraphs');
  assert.ok(/<br\/>/.test(html), 'line break kept');
});

test('BUG-007: blog data and articles live in DATA_DIR and survive a redeploy', async (t) => {
  assert.ok(fs.existsSync(path.join(s.dataDir, 'blog', 'articles', post.slug + '.html')), 'article stored in DATA_DIR');
  assert.ok(!fs.existsSync(path.join(REPO_BLOG, post.slug + '.html')), 'not written into the code folder');
  // "redeploy": a fresh server process on the same data folder
  const s2 = spread(await startServer({ DATA_DIR: s.dataDir }));
  t.after(() => s2.stop());
  assert.strictEqual((await s2.get('/blog/' + post.slug + '.html')).status, 200);
  assert.ok((await s2.get('/api/blog/posts')).data.some(p => p.id === post.id));
});

test('BUG-007: existing blog data in the old folder is copied (never moved) on first start', () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-legacy-blog-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-blog-target-'));
  const old = [{ id: 'old-1', title: 'Old post', slug: 'old-post-abc123', category: 'Wellness', authorName: 'A', content: 'x', excerpt: 'x', readTime: '1 min read', publishedAt: new Date().toISOString(), status: 'published' }];
  fs.writeFileSync(path.join(legacy, 'blog-published.json'), JSON.stringify(old));
  const r = spawnSync(process.execPath, ['-e', `
    const s = require('./src/services/blogStore.js');
    s.copyLegacy(${JSON.stringify(legacy)});
    console.log(JSON.stringify(s.getPublished().map(p => p.id)));`],
  { cwd: ROOT, env: Object.assign({}, process.env, { DATA_DIR: target }), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /"old-1"/);
  assert.ok(fs.existsSync(path.join(legacy, 'blog-published.json')), 'original left in place');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(legacy, 'blog-published.json'), 'utf8')), old, 'original unchanged');
});

test('BUG-007: the blog admin page uses the admin login session instead of a typed password', () => {
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'admin', 'blog.html'), 'utf8');
  assert.ok(!/id="login-pass"/.test(src), 'no password box that becomes the token');
  assert.match(src, /localStorage\.getItem\('soh_admin_token'\)/);
});

test('BUG-008: changing a staff password records when it was changed (clears the demo-account warning)', async () => {
  const c = await s.post('/api/admin/staff', { name: 'Pw Change', email: 'pw@hardening.test', phone: '9000000005', role: 'staff', password: 'first-pass-123' }, bearer(admin));
  const id = c.data.id;
  assert.ok(id, JSON.stringify(c.data));
  assert.strictEqual((await s.patch('/api/admin/staff/' + id, { password: 'second-pass-456' }, bearer(admin))).status, 200);
  const rec = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'staff.json'), 'utf8')).find(x => x.id === id);
  assert.ok(rec.passwordChangedAt, 'passwordChangedAt set');
  assert.strictEqual((await s.post('/api/admin/login', { email: 'pw@hardening.test', password: 'second-pass-456' })).status, 200);
});
