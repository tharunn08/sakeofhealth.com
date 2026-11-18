/**
 * End-to-end B2B platform test against a real MySQL/MariaDB test database.
 *
 * Covers: registration → approval → mapping → catalogue → pricing → Excel
 * import → cart/MOQ → idempotent ordering → approval → fulfilment → GST
 * invoice → payments/credit → returns → reports, plus the security cases
 * (data isolation, tampering, injection, uploads, RBAC, concurrency).
 *
 * Database: TEST_DB_* env vars, default soh@127.0.0.1:3306/sakeofhealth_test.
 * The helper refuses to run against any database not ending in _test/_dev/_local.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, bearer } = require('./helpers/server.js');
const { TEST_DB, resetDatabase, gstin, PNG, PDF, db } = require('./helpers/db.js');

let s, admin;
const S = {};   // shared state: ids, tokens

const uid = () => 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36);

function form(fields, files) {
  const f = new FormData();
  Object.keys(fields).forEach(k => f.append(k, String(fields[k])));
  Object.keys(files || {}).forEach(k => f.append(k, new Blob([files[k].data], { type: files[k].type || 'application/octet-stream' }), files[k].name));
  return f;
}

const distributorForm = (o) => Object.assign({
  distributor_name: 'Bengaluru Trade Links', contact_person: 'Ramesh Rao', mobile: '9845000001', email: 'dist1@example.com',
  gstin: gstin('29', 'AAACB1234C'), pan: 'AAACB1234C', business_type: 'Private Limited',
  address: '14 Industrial Layout, Peenya', state_id: S.ka, district_id: S.blrUrban, city: 'Bengaluru', pincode: '560058',
  latitude: '13.0285', longitude: '77.5197', password: 'Distrib8tor!', confirm_password: 'Distrib8tor!',
}, o || {});
const distributorDocs = () => ({
  gst_certificate: { data: PDF, name: 'gst.pdf', type: 'application/pdf' },
  business_proof: { data: PNG, name: 'incorporation.png', type: 'image/png' },
  address_proof: { data: PDF, name: 'address.pdf', type: 'application/pdf' },
});
const retailerForm = (o) => Object.assign({
  retailer_name: 'Lakshmi Stores', shop_name: 'Lakshmi Medicals', contact_person: 'Lakshmi N', mobile: '9845000011', email: 'ret1@example.com',
  business_type: 'Proprietorship', address: '22 MG Road', state_id: S.ka, district_id: S.blrUrban, city: 'Bengaluru', pincode: '560001',
  latitude: '12.9756', longitude: '77.6050', password: 'Retail3r!x', confirm_password: 'Retail3r!x',
}, o || {});
const shopDoc = () => ({ shop_proof: { data: PNG, name: 'shop.png', type: 'image/png' } });

async function login(identifier, password, role) {
  const r = await s.post('/api/b2b/auth/login', { identifier, password, role });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return bearer(r.data.token);
}
async function cartSet(h, productId, qty) { return s.put('/api/b2b/cart/items/' + productId, { qty }, h); }
async function place(h, method, key, extra) {
  return s.post('/api/b2b/orders', Object.assign({ payment_method: method || 'bank_transfer' }, extra || {}), Object.assign({ 'Idempotency-Key': key || uid() }, h));
}
const adminStatus = (id, status, extra) => s.post('/api/admin/b2b/orders/' + id + '/status', Object.assign({ status }, extra || {}), admin);

test.before(async () => {
  await resetDatabase();
  await db.close();
  s = await startServer(Object.assign({ B2B_ENABLED: 'true', B2B_NOTIFY_INTERVAL_SECONDS: '3600', RAZORPAY_WEBHOOK_SECRET: 'whsec_test' }, TEST_DB));
  const r = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' });
  admin = bearer(r.data.token);
});
test.after(async () => { await s.stop(); await db.close(); });

/* ═════════════════ Platform basics ═════════════════ */

test('health: /api/health reports B2B and database status without secrets', async () => {
  const r = await s.get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.service, 'sake-of-health');
  assert.deepEqual(r.data.b2b, { enabled: true, database: 'up' });
  assert.doesNotMatch(JSON.stringify(r.data), /password|secret|DB_/i);
});

test('the B2C site still works with B2B switched on', async () => {
  assert.equal((await s.get('/api/shop/products')).data.products.length, 5);
  assert.equal((await s.get('/')).status, 200);
  assert.equal((await s.get('/admin/')).status, 200);
  const cfg = await s.get('/config.js');
  assert.match(cfg.data, /"b2bEnabled":true/);
});

test('geography is database-driven: states with GST codes, Karnataka districts', async () => {
  const st = await s.get('/api/b2b/geo/states');
  assert.ok(st.data.states.length >= 36);
  const ka = st.data.states.find(x => x.name === 'Karnataka');
  const tn = st.data.states.find(x => x.name === 'Tamil Nadu');
  assert.equal(ka.gst_code, '29'); assert.equal(tn.gst_code, '33');
  S.ka = ka.id; S.tn = tn.id;
  const d = await s.get('/api/b2b/geo/districts?state_id=' + ka.id);
  assert.equal(d.data.districts.length, 31);
  S.blrUrban = d.data.districts.find(x => x.name === 'Bengaluru Urban').id;
  S.mysuru = d.data.districts.find(x => x.name === 'Mysuru').id;
});

/* ═════════════════ Registration & approval ═════════════════ */

test('distributor registration: validation, documents, duplicates', async () => {
  let r = await s.post('/api/b2b/auth/register/distributor', form(distributorForm({ gstin: '29AAACB1234C1ZX', mobile: '12345', pincode: '56', confirm_password: 'nope' }), distributorDocs()));
  assert.equal(r.status, 400);
  ['gstin', 'mobile', 'pincode', 'confirm_password'].forEach(k => assert.ok(r.data.fields[k], 'error for ' + k));

  r = await s.post('/api/b2b/auth/register/distributor', form(distributorForm(), { gst_certificate: distributorDocs().gst_certificate }));
  assert.equal(r.status, 400);
  assert.ok(r.data.fields.business_proof && r.data.fields.address_proof, 'missing documents are reported');

  // A Windows executable renamed to .pdf is rejected by its contents.
  const fake = distributorDocs(); fake.gst_certificate = { data: Buffer.from('MZ\x90\x00\x03\x00\x00\x00 fake exe body'), name: 'gst.pdf', type: 'application/pdf' };
  r = await s.post('/api/b2b/auth/register/distributor', form(distributorForm(), fake));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not a supported file/);

  r = await s.post('/api/b2b/auth/register/distributor', form(distributorForm(), distributorDocs()));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.accountStatus, 'pending');
  S.dist1 = r.data.accountId; S.dist1Pending = bearer(r.data.token);

  r = await s.post('/api/b2b/auth/register/distributor', form(distributorForm({ email: 'other@example.com' }), distributorDocs()));
  assert.equal(r.status, 409);
  assert.ok(r.data.fields.mobile && r.data.fields.gstin, 'duplicate mobile and GSTIN detected');
  r = await s.post('/api/b2b/auth/register/retailer', form(retailerForm({ email: 'dist1@example.com' }), shopDoc()));
  assert.equal(r.status, 409);
  assert.ok(r.data.fields.email, 'email is unique across retailers and distributors');
});

test('a pending account can log in but cannot reach the catalogue', async () => {
  const me = await s.get('/api/b2b/me', S.dist1Pending);
  assert.equal(me.status, 200);
  assert.equal(me.data.account.status, 'pending');
  for (const url of ['/api/b2b/products', '/api/b2b/cart', '/api/b2b/orders', '/api/b2b/dashboard']) {
    const r = await s.get(url, S.dist1Pending);
    assert.equal(r.status, 403, url);
    assert.equal(r.data.accountStatus, 'pending');
  }
  const order = await place(S.dist1Pending);
  assert.equal(order.status, 403);
});

test('login: wrong password, wrong role, and unknown users all fail the same way', async () => {
  const bad = [['dist1@example.com', 'wrong-pass1', 'distributor'], ['dist1@example.com', 'Distrib8tor!', 'retailer'], ['nobody@example.com', 'Distrib8tor!', 'distributor']];
  const messages = [];
  for (const b of bad) {
    const r = await s.post('/api/b2b/auth/login', { identifier: b[0], password: b[1], role: b[2] });
    assert.equal(r.status, 401);
    messages.push(r.data.error);
  }
  assert.equal(new Set(messages).size, 1, 'no hint about which part was wrong');
  const byMobile = await s.post('/api/b2b/auth/login', { identifier: '+91 98450 00001', password: 'Distrib8tor!', role: 'distributor' });
  assert.equal(byMobile.status, 200);
});

test('admin reviews the application: details, documents, risk flags, approval history', async () => {
  const list = await s.get('/api/admin/b2b/accounts?status=pending,under_review&type=distributor', admin);
  assert.equal(list.data.total, 1);
  const d = await s.get('/api/admin/b2b/accounts/' + S.dist1, admin);
  assert.equal(d.data.account.gstin, distributorForm().gstin);
  assert.equal(d.data.documents.length, 3);
  assert.deepEqual(d.data.account.risk_flags, []);
  S.dist1Doc = d.data.documents[0].id;

  // Documents are private: no token → 401, business token → 401, admin → the file.
  assert.equal((await s.get('/api/admin/b2b/documents/' + S.dist1Doc + '/file')).status, 401);
  assert.equal((await s.get('/api/admin/b2b/documents/' + S.dist1Doc + '/file', S.dist1Pending)).status, 401);
  const file = await s.get('/api/admin/b2b/documents/' + S.dist1Doc + '/file', admin);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('cache-control'), /no-store/);
  // Guessing a static URL finds nothing.
  for (const guess of ['/documents/', '/uploads/', '/b2b/documents/', '/private/']) {
    const g = await s.get(guess + 'gst.pdf');
    assert.ok(g.status === 404 || !/^%PDF/.test(String(g.data)), guess);
  }

  let r = await s.post('/api/admin/b2b/accounts/' + S.dist1 + '/status', { status: 'under_review' }, admin);
  assert.equal(r.status, 200);
  r = await s.post('/api/admin/b2b/accounts/' + S.dist1 + '/status', { status: 'rejected' }, admin);
  assert.equal(r.status, 400, 'rejection needs a reason');
  r = await s.post('/api/admin/b2b/accounts/' + S.dist1 + '/status', { status: 'blocked', reason: 'testing' }, admin);
  assert.equal(r.status, 400, 'under_review → blocked is not a valid step');
  r = await s.post('/api/admin/b2b/accounts/' + S.dist1 + '/status', { status: 'approved' }, admin);
  assert.equal(r.status, 200);

  const after = await s.get('/api/admin/b2b/accounts/' + S.dist1, admin);
  assert.equal(after.data.account.status, 'approved');
  assert.deepEqual(after.data.history.map(h => h.to_status), ['approved', 'under_review', 'pending']);
  assert.equal(after.data.serviceAreas.length, 1, 'starts with its own pincode as service area');
  assert.equal(after.data.serviceAreas[0].pincode_from, '560058');
  S.d1 = await login('dist1@example.com', 'Distrib8tor!', 'distributor');
  assert.equal((await s.get('/api/b2b/products', S.d1)).status, 200);
});

test('service areas: district, pincode list, range; duplicates refused', async () => {
  let r = await s.post('/api/admin/b2b/distributors/' + S.dist1 + '/service-areas', { area_type: 'district', district_id: S.blrUrban }, admin);
  assert.equal(r.status, 201);
  r = await s.post('/api/admin/b2b/distributors/' + S.dist1 + '/service-areas', { area_type: 'district', district_id: S.blrUrban }, admin);
  assert.equal(r.status, 400);
  r = await s.post('/api/admin/b2b/distributors/' + S.dist1 + '/service-areas', { pincodes: '560001, 560002 560003 abc 123' }, admin);
  assert.equal(r.data.added, 3);
  r = await s.post('/api/admin/b2b/distributors/' + S.dist1 + '/service-areas', { area_type: 'pincode_range', pincode_from: '560100', pincode_to: '560010' }, admin);
  assert.equal(r.status, 400);
});

test('second distributor (Mysuru) and an out-of-state distributor (Tamil Nadu)', async () => {
  let r = await s.post('/api/b2b/auth/register/distributor', form(distributorForm({
    distributor_name: 'Mysuru Wellness Distributors', mobile: '9845000002', email: 'dist2@example.com', gstin: gstin('29', 'AAACM5678D'), pan: 'AAACM5678D',
    district_id: S.mysuru, city: 'Mysuru', pincode: '570001', latitude: '12.2958', longitude: '76.6394' }), distributorDocs()));
  assert.equal(r.status, 201); S.dist2 = r.data.accountId;
  r = await s.post('/api/b2b/auth/register/distributor', form(distributorForm({
    distributor_name: 'Chennai Health Traders', mobile: '9845000003', email: 'dist3@example.com', gstin: gstin('33', 'AAACC9012E'), pan: 'AAACC9012E',
    state_id: S.tn, district_id: '', district: 'Chennai', city: 'Chennai', pincode: '600001', latitude: '13.0827', longitude: '80.2707' }), distributorDocs()));
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.dist3 = r.data.accountId;
  const d3 = await s.get('/api/admin/b2b/accounts/' + S.dist3, admin);
  assert.ok(d3.data.account.risk_flags.includes('state_not_serviceable'));
  for (const id of [S.dist2, S.dist3]) assert.equal((await s.post('/api/admin/b2b/accounts/' + id + '/status', { status: 'approved' }, admin)).status, 200);
  await s.post('/api/admin/b2b/distributors/' + S.dist2 + '/service-areas', { area_type: 'district', district_id: S.mysuru }, admin);
  S.d2 = await login('dist2@example.com', 'Distrib8tor!', 'distributor');
  S.d3 = await login('dist3@example.com', 'Distrib8tor!', 'distributor');
});

test('retailers register; approval auto-maps each to the right distributor', async () => {
  let r = await s.post('/api/b2b/auth/register/retailer', form(retailerForm(), shopDoc()));
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.ret1 = r.data.accountId;
  r = await s.post('/api/b2b/auth/register/retailer', form(retailerForm({ retailer_name: 'Chamundi Pharma', shop_name: 'Chamundi Pharma', mobile: '9845000012', email: 'ret2@example.com',
    district_id: S.mysuru, city: 'Mysuru', pincode: '570004', latitude: '12.3052', longitude: '76.6552' }), shopDoc()));
  assert.equal(r.status, 201); S.ret2 = r.data.accountId;
  r = await s.post('/api/b2b/auth/register/retailer', form(retailerForm({ retailer_name: 'Hubli Health Mart', shop_name: 'Hubli Health Mart', mobile: '9845000013', email: 'ret3@example.com',
    district_id: '', district: 'Dharwad', city: 'Hubballi', pincode: '580020', latitude: '', longitude: '' }), shopDoc()));
  assert.equal(r.status, 201); S.ret3 = r.data.accountId;

  // Before approval the admin already sees ranked candidates.
  const pre = await s.get('/api/admin/b2b/accounts/' + S.ret1, admin);
  assert.equal(pre.data.candidates[0].distributorId, S.dist1);
  assert.equal(pre.data.candidates[0].matchedBy, 'pincode', 'exact pincode beats the district-level match');
  assert.ok(pre.data.account.risk_flags.includes('no_gstin'));

  r = await s.post('/api/admin/b2b/accounts/' + S.ret1 + '/status', { status: 'approved' }, admin);
  assert.equal(r.data.mapping.distributorId, S.dist1);
  r = await s.post('/api/admin/b2b/accounts/' + S.ret2 + '/status', { status: 'approved' }, admin);
  assert.equal(r.data.mapping.distributorId, S.dist2);
  r = await s.post('/api/admin/b2b/accounts/' + S.ret3 + '/status', { status: 'approved' }, admin);
  assert.equal(r.data.mapping, null, 'no distributor covers Hubballi yet');

  S.r1 = await login('ret1@example.com', 'Retail3r!x', 'retailer');
  S.r2 = await login('ret2@example.com', 'Retail3r!x', 'retailer');
  S.r3 = await login('ret3@example.com', 'Retail3r!x', 'retailer');

  const mine = await s.get('/api/b2b/my-distributor', S.r1);
  assert.equal(mine.data.distributor.name, 'Bengaluru Trade Links');
  assert.equal(mine.data.distributor.phone, '9845000001');
  assert.ok(mine.data.distributor.service_area.includes('560001'));
  assert.equal((await s.get('/api/b2b/my-distributor', S.r3)).data.distributor, null);

  const unmapped = await s.get('/api/admin/b2b/accounts?unmapped=1', admin);
  assert.deepEqual(unmapped.data.items.map(a => a.id), [S.ret3]);
});

test('mapping: manual remap keeps history; bulk remap; suspend', async () => {
  let r = await s.post('/api/admin/b2b/retailers/' + S.ret3 + '/mapping', { distributor_id: S.dist1 }, admin);
  assert.equal(r.status, 400, 'reason required');
  r = await s.post('/api/admin/b2b/retailers/' + S.ret3 + '/mapping', { distributor_id: S.dist1, reason: 'Nearest active distributor for now' }, admin);
  assert.equal(r.data.changed, true);
  r = await s.post('/api/admin/b2b/retailers/' + S.ret3 + '/mapping', { distributor_id: S.dist2, reason: 'Moved to Mysuru route' }, admin);
  assert.equal(r.data.previousDistributorId, S.dist1);
  const d = await s.get('/api/admin/b2b/accounts/' + S.ret3, admin);
  assert.equal(d.data.mapping.distributor_id, S.dist2);
  assert.equal(d.data.mappingHistory.length, 2);
  assert.equal(d.data.mappingHistory[1].status, 'ended');
  assert.ok(d.data.mappingHistory[1].ended_at && d.data.mappingHistory[0].reason === 'Moved to Mysuru route');

  r = await s.post('/api/admin/b2b/mapping/bulk', { from_distributor_id: S.dist2, distributor_id: S.dist1, reason: 'Route consolidation test' }, admin);
  assert.equal(r.data.changed, 2);
  r = await s.post('/api/admin/b2b/mapping/bulk', { retailer_ids: [S.ret2], distributor_id: S.dist2, reason: 'Back to Mysuru' }, admin);
  assert.equal(r.data.changed, 1);
  r = await s.post('/api/admin/b2b/retailers/' + S.ret3 + '/mapping', { distributor_id: null, reason: 'Serve directly' }, admin);
  assert.equal(r.status, 200);

  // Approving a not-approved distributor as a target is refused.
  r = await s.post('/api/admin/b2b/retailers/' + S.ret3 + '/mapping', { distributor_id: S.ret1, reason: 'not a distributor' }, admin);
  assert.equal(r.status, 400);
});

test('distributors only see their own retailers', async () => {
  const a = await s.get('/api/b2b/retailers', S.d1);
  assert.deepEqual(a.data.items.map(x => x.id), [S.ret1]);
  assert.equal(a.data.items[0].shop, 'Lakshmi Medicals');
  const b = await s.get('/api/b2b/retailers', S.d2);
  assert.deepEqual(b.data.items.map(x => x.id), [S.ret2]);
  assert.equal((await s.get('/api/b2b/retailers/' + S.ret2, S.d1)).status, 404, "another distributor's retailer looks like it does not exist");
  assert.equal((await s.get('/api/b2b/retailers', S.r1)).status, 403, 'retailers cannot use distributor endpoints');
});

/* ═════════════════ Catalogue, pricing, stock ═════════════════ */

test('catalogue: database-driven categories and products', async () => {
  const cats = await s.get('/api/admin/b2b/categories', admin);
  assert.deepEqual(cats.data.categories.map(c => c.name), ['Gummies', 'Biscuits', 'Energy Drinks']);
  S.catGummies = cats.data.categories[0].id;
  let r = await s.post('/api/admin/b2b/categories', { name: 'Protein Bars' }, admin);
  assert.equal(r.status, 201);
  r = await s.post('/api/admin/b2b/categories', { name: 'Multivitamin', parent_id: S.catGummies }, admin);
  S.subMulti = r.data.id;

  const mk = (o) => s.post('/api/admin/b2b/products', Object.assign({ category_id: S.catGummies, gst_rate: 18, brand: 'Sake of Health', hsn_code: '21069099' }, o), admin);
  r = await mk({ sku: 'GUM001', name: 'SOH Gummies 30 Count', subcategory_id: S.subMulti, mrp: 499, base_price: 250, moq: 10, case_qty: 20, pack_size: '30 gummies', low_stock_threshold: 40 });
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.p1 = r.data.id;
  r = await mk({ sku: 'GUM002', name: 'SOH Gummies 60 Count', mrp: 899, base_price: 450, moq: 5, case_qty: 5 });
  S.p2 = r.data.id;
  r = await mk({ sku: 'GUM003', name: 'SOH Iron Gummies', mrp: 549, base_price: 280, gst_rate: 5, moq: 1, case_qty: 1 });
  S.p3 = r.data.id;
  r = await mk({ sku: 'DIST-ONLY', name: 'Distributor Display Stand', mrp: 2000, base_price: 900, avail_retailer: 0 });
  S.pDistOnly = r.data.id;
  r = await mk({ sku: 'GUM001', name: 'dup', mrp: 1, base_price: 1 });
  assert.equal(r.status, 409);
  r = await mk({ sku: 'BAD GST', name: 'x', mrp: 100, base_price: 50, gst_rate: 17 });
  assert.equal(r.status, 400);
});

test('pricing: default margins 12% / 18% are applied by the server', async () => {
  const list = await s.get('/api/admin/b2b/products?q=GUM001', admin);
  assert.equal(list.data.items[0].computed.distributor.price, '280.00');
  assert.equal(list.data.items[0].computed.retailer.price, '295.00');
  const asRetailer = await s.get('/api/b2b/products?q=GUM001', S.r1);
  assert.equal(asRetailer.data.items[0].unit_price, '295.00');
  const asDistributor = await s.get('/api/b2b/products?q=GUM001', S.d1);
  assert.equal(asDistributor.data.items[0].unit_price, '280.00');
  // The portal never exposes cost or margin fields.
  const leaked = JSON.stringify(asRetailer.data.items[0]);
  ['base_price', 'distributor_price', 'distributor_margin', 'retailer_margin', 'marginPct'].forEach(k => assert.ok(!leaked.includes(k), k + ' must not be sent to buyers'));
  assert.equal(asRetailer.data.items.find(p => p.sku === 'DIST-ONLY'), undefined);
  assert.equal((await s.get('/api/b2b/products?q=DIST-ONLY', S.r1)).data.total, 0, 'channel availability is enforced');
  assert.equal((await s.get('/api/b2b/products?q=DIST-ONLY', S.d1)).data.total, 1);
});

test('pricing: admin changes defaults, category, product, account and customer-specific prices', async () => {
  let r = await s.put('/api/admin/b2b/settings', { 'pricing.default_retailer_margin': '20' }, admin);
  assert.deepEqual(r.data.changed, ['pricing.default_retailer_margin']);
  const sim = (q) => s.get('/api/admin/b2b/pricing/simulate?' + q, admin).then(x => x.data);
  assert.equal((await sim('product_id=' + S.p1 + '&audience=retailer')).unitPrice, '300.00');
  await s.put('/api/admin/b2b/settings', { 'pricing.default_retailer_margin': '18' }, admin);

  r = await s.post('/api/admin/b2b/pricing/rules', { scope: 'category', audience: 'retailer', category_id: S.catGummies, rule_type: 'margin_pct', value: 19 }, admin);
  assert.equal(r.status, 201); S.ruleCat = r.data.id;
  let x = await sim('product_id=' + S.p2 + '&audience=retailer');
  assert.equal(x.unitPrice, '535.50'); assert.equal(x.source, 'category');

  await s.patch('/api/admin/b2b/products/' + S.p2, { retailer_margin: 16 }, admin);
  x = await sim('product_id=' + S.p2 + '&audience=retailer');
  assert.equal(x.unitPrice, '522.00'); assert.equal(x.source, 'product');

  r = await s.post('/api/admin/b2b/pricing/rules', { scope: 'account', audience: 'retailer', account_id: S.ret2, rule_type: 'margin_pct', value: 14 }, admin);
  assert.equal(r.status, 201);
  x = await sim('product_id=' + S.p2 + '&account_id=' + S.ret2);
  assert.equal(x.unitPrice, '513.00'); assert.equal(x.source, 'account');

  r = await s.post('/api/admin/b2b/pricing/rules', { scope: 'account_product', audience: 'retailer', account_id: S.ret2, product_id: S.p2, rule_type: 'fixed_price', value: 500 }, admin);
  x = await sim('product_id=' + S.p2 + '&account_id=' + S.ret2);
  assert.equal(x.unitPrice, '500.00'); assert.equal(x.source, 'account_product');
  assert.equal((await sim('product_id=' + S.p2 + '&account_id=' + S.ret1)).unitPrice, '522.00', "another retailer's special price does not leak");

  // Volume slab for distributors + account type mismatch is refused.
  r = await s.post('/api/admin/b2b/pricing/rules', { scope: 'product', audience: 'distributor', product_id: S.p1, rule_type: 'discount_pct', value: 2, min_qty: 100 }, admin);
  assert.equal(r.status, 201);
  assert.equal((await sim('product_id=' + S.p1 + '&audience=distributor&qty=100')).unitPrice, '274.40');
  r = await s.post('/api/admin/b2b/pricing/rules', { scope: 'account', audience: 'distributor', account_id: S.ret1, rule_type: 'margin_pct', value: 5 }, admin);
  assert.equal(r.status, 400);

  await s.del('/api/admin/b2b/pricing/rules/' + S.ruleCat, admin);
  assert.equal((await sim('product_id=' + S.p1 + '&audience=retailer')).unitPrice, '295.00');
  const retailerView = await s.get('/api/b2b/products?q=GUM002', S.r2);
  assert.equal(retailerView.data.items[0].unit_price, '500.00', 'the portal shows the buyer their own price');
});

test('pricing: bulk margin update with preview → confirm → apply → audit', async () => {
  const sel = { ids: [S.p1, S.p3] };
  const pv = await s.post('/api/admin/b2b/pricing/bulk/preview', { selection: sel, distributor_margin: 10, retailer_margin: 21 }, admin);
  assert.equal(pv.data.count, 2);
  const row = pv.data.sample.find(x => x.sku === 'GUM001');
  assert.equal(row.distributor.oldPrice, '280.00'); assert.equal(row.distributor.newPrice, '275.00');
  assert.equal(row.retailer.newPrice, '302.50');
  // Preview changed nothing.
  assert.equal((await s.get('/api/admin/b2b/products?q=GUM001', admin)).data.items[0].retailer_margin, null);
  let r = await s.post('/api/admin/b2b/pricing/bulk/apply', { selection: sel, distributor_margin: 10, retailer_margin: 21 }, admin);
  assert.equal(r.status, 400, 'needs explicit confirmation');
  r = await s.post('/api/admin/b2b/pricing/bulk/apply', { selection: sel, distributor_margin: 10, retailer_margin: 21, confirm: true }, admin);
  assert.equal(r.data.updated, 2);
  r = await s.post('/api/admin/b2b/pricing/bulk/apply', { selection: {}, retailer_margin: 5, confirm: true }, admin);
  assert.equal(r.status, 400, 'an empty selection never means "everything"');
  const log = await s.get('/api/admin/b2b/audit?action=pricing.bulk_margin_update', admin);
  assert.equal(log.data.total, 1);
  assert.deepEqual(JSON.parse(log.data.items[0].old_value).previous.GUM001, [null, null, null, null]);
  // Put GUM001/GUM003 back to defaults for the rest of the suite.
  await s.patch('/api/admin/b2b/products/' + S.p1, { distributor_margin: '', retailer_margin: '' }, admin);
  await s.patch('/api/admin/b2b/products/' + S.p3, { distributor_margin: '', retailer_margin: '' }, admin);
  assert.equal((await s.get('/api/admin/b2b/products?q=GUM001', admin)).data.items[0].computed.retailer.price, '295.00');
});

test('inventory: warehouses, opening stock with batches, ledger, adjustments', async () => {
  const wh = await s.get('/api/admin/b2b/warehouses', admin);
  const main = wh.data.warehouses.find(w => w.code === 'BLR-MAIN');
  assert.ok(main); S.wh = main.id;
  assert.equal(wh.data.warehouses.filter(w => w.owner_account_id != null).length, 3, 'each approved distributor has its own stock point');
  let r = await s.post('/api/admin/b2b/warehouses', { code: 'MYS-01', name: 'Mysuru Warehouse', state_id: S.ka, city: 'Mysuru', priority: 10 }, admin);
  assert.equal(r.status, 201); S.wh2 = r.data.id;

  const entry = (o) => s.post('/api/admin/b2b/stock/entry', Object.assign({ warehouse_id: S.wh }, o), admin);
  const soon = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  r = await entry({ product_id: S.p1, operation: 'opening', qty: 200, batch_no: 'B-LATE', expiry_date: later });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await entry({ product_id: S.p1, operation: 'purchase', qty: 100, batch_no: 'B-SOON', expiry_date: soon });
  await entry({ product_id: S.p2, operation: 'opening', qty: 10 });
  await entry({ product_id: S.p3, operation: 'production', qty: 500, batch_no: 'FE-1', expiry_date: later });
  await entry({ product_id: S.pDistOnly, operation: 'opening', qty: 50 });

  r = await entry({ product_id: S.p1, operation: 'damage', qty: 5 });
  assert.equal(r.status, 400, 'a reason is required');
  r = await entry({ product_id: S.p1, operation: 'damage', qty: 5, reason: 'Crushed carton' });
  assert.equal(r.data.qty_available, 295); assert.equal(r.data.qty_damaged, 5);
  r = await entry({ product_id: S.p2, operation: 'adjust_decrease', qty: 11, reason: 'count' });
  assert.equal(r.status, 409, 'stock can never go below zero');
  r = await entry({ product_id: S.p1, operation: 'opening', qty: -5 });
  assert.equal(r.status, 400);

  const stock = await s.get('/api/admin/b2b/stock?q=GUM001', admin);
  assert.equal(stock.data.items[0].qty_available, 295);
  const moves = await s.get('/api/admin/b2b/stock/movements?product_id=' + S.p1, admin);
  assert.deepEqual(moves.data.items.map(m => m.movement_type), ['damage', 'purchase', 'opening']);
  assert.equal(moves.data.items[0].actor_label, 'admin@test.local');
  const exp = await s.get('/api/admin/b2b/stock/batches?within=60', admin);
  assert.deepEqual(exp.data.items.map(b => b.batch_no), ['B-SOON']);
  assert.equal(exp.data.summary.within60, 1);
});

/* ═════════════════ Excel import ═════════════════ */

async function xlsx(rows, headers) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');
  ws.addRow(headers);
  rows.forEach(r => ws.addRow(headers.map(h => r[h] === undefined ? '' : r[h])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const HEAD = ['SKU', 'Product Name', 'Category', 'Subcategory', 'Brand', 'HSN', 'GST Rate', 'MRP', 'Base Price', 'Distributor Margin', 'Retailer Margin',
  'MOQ', 'Case Quantity', 'Pack Size', 'Barcode', 'Opening Stock', 'Warehouse', 'Active'];
const upload = (buf, name) => s.post('/api/admin/b2b/imports', form({}, { file: { data: buf, name: name || 'products.xlsx' } }), admin);

test('Excel import: template, upload, column detection, validation report', async () => {
  const tpl = await fetch(s.base + '/api/admin/b2b/imports/template', { headers: admin });
  assert.equal(tpl.status, 200);
  const buf = Buffer.from(await tpl.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK');

  let r = await upload(Buffer.from('MZ not a spreadsheet at all'), 'evil.xlsx');
  assert.equal(r.status, 400);

  const rows = [
    { 'SKU': 'BIS001', 'Product Name': 'Millet Biscuits 200g', 'Category': 'Biscuits', 'Subcategory': 'Millet', 'Brand': 'SOH', 'HSN': '19053100', 'GST Rate': 18, 'MRP': 120, 'Base Price': 60,
      'Distributor Margin': 12, 'Retailer Margin': 18, 'MOQ': 12, 'Case Quantity': 12, 'Pack Size': '200 g', 'Barcode': '8901234500011', 'Opening Stock': 240, 'Warehouse': 'BLR-MAIN', 'Active': 'Yes' },
    { 'SKU': 'NRG001', 'Product Name': 'Energy Drink 250ml', 'Category': 'Energy Drinks', 'GST Rate': 28, 'MRP': 99, 'Base Price': 45, 'MOQ': 24, 'Case Quantity': 24, 'Opening Stock': 480, 'Active': 'Yes' },
    { 'SKU': 'GUM002', 'Product Name': 'SOH Gummies 60 Count (New Pack)', 'MRP': 949 },                                        // update, blanks keep existing values
    { 'SKU': 'BAD001', 'Product Name': 'Bad GST', 'GST Rate': 17, 'MRP': 100, 'Base Price': 50 },                               // invalid GST
    { 'SKU': '', 'Product Name': 'No SKU', 'GST Rate': 18, 'MRP': 100, 'Base Price': 50 },                                      // missing SKU
    { 'SKU': 'BIS001', 'Product Name': 'Duplicate row', 'GST Rate': 18, 'MRP': 100, 'Base Price': 50 },                         // duplicate SKU
    { 'SKU': 'BAD002', 'Product Name': 'Bad margin', 'GST Rate': 18, 'MRP': 100, 'Base Price': 50, 'Retailer Margin': 'abc' },  // invalid margin
    { 'SKU': 'BAD003', 'Product Name': 'Bad warehouse', 'GST Rate': 18, 'MRP': 100, 'Base Price': 50, 'Opening Stock': 5, 'Warehouse': 'NOWHERE' },
    { 'SKU': 'GUM003', 'Active': 'No' },                                                                                        // deactivate
  ];
  r = await upload(await xlsx(rows, HEAD));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  S.imp = r.data.id;
  assert.equal(r.data.total_rows, 9);
  assert.equal(r.data.mapping['GST Rate'], 'gst_rate');
  assert.equal(Object.keys(r.data.mapping).length, 18, 'all 18 template columns detected');

  const before = (await s.get('/api/admin/b2b/products?q=BIS001', admin)).data.total;
  assert.equal(before, 0, 'upload alone changes nothing');

  r = await s.post('/api/admin/b2b/imports/' + S.imp + '/validate', {}, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual({ t: r.data.total_rows, v: r.data.valid, i: r.data.invalid, c: r.data.willCreate, u: r.data.willUpdate, d: r.data.willDeactivate },
    { t: 9, v: 4, i: 5, c: 2, u: 1, d: 1 });

  const bad = await s.get('/api/admin/b2b/imports/' + S.imp + '/rows?filter=invalid', admin);
  const errs = {}; bad.data.items.forEach(x => { errs[x.row] = x.errors.join('; '); });
  assert.match(errs[5], /Invalid GST/);
  assert.match(errs[6], /Missing SKU/);
  assert.match(errs[7], /Duplicate SKU \(also on row 2\)/);
  assert.match(errs[8], /Invalid margin/);
  assert.match(errs[9], /Unknown warehouse/);
  const csv = await s.get('/api/admin/b2b/imports/' + S.imp + '/errors.csv', admin);
  assert.match(csv.data, /5,BAD001,Invalid GST/);
});

test('Excel import: confirm → one transaction → result; re-import never double-counts stock', async () => {
  let r = await s.post('/api/admin/b2b/imports/' + S.imp + '/apply', {}, admin);
  assert.equal(r.status, 400, 'needs confirmation');
  r = await s.post('/api/admin/b2b/imports/' + S.imp + '/apply', { confirm: true, wait: true }, admin);
  assert.equal(r.status, 202);
  const done = await s.get('/api/admin/b2b/imports/' + S.imp, admin);
  assert.equal(done.data.status, 'completed', done.data.error_message || '');
  assert.deepEqual({ c: done.data.created, u: done.data.updated, d: done.data.deactivated }, { c: 2, u: 1, d: 1 });

  const bis = (await s.get('/api/admin/b2b/products?q=BIS001', admin)).data.items[0];
  assert.equal(bis.name, 'Millet Biscuits 200g'); assert.equal(bis.category_name, 'Biscuits'); assert.equal(bis.subcategory_name, 'Millet');
  assert.equal(bis.company_stock, 240); assert.equal(Number(bis.moq), 12);
  S.pBis = bis.id;
  const gum2 = (await s.get('/api/admin/b2b/products?q=GUM002', admin)).data.items[0];
  assert.equal(gum2.name, 'SOH Gummies 60 Count (New Pack)'); assert.equal(gum2.mrp, '949.00');
  assert.equal(gum2.base_price, '450.00', 'blank cells did not overwrite existing data');
  assert.equal(Number(gum2.retailer_margin), 16);
  assert.equal((await s.get('/api/admin/b2b/products?q=GUM003', admin)).data.items[0].is_active, 0);
  assert.equal((await s.get('/api/admin/b2b/products?q=BAD001', admin)).data.total, 0, 'invalid rows were not imported');

  r = await s.post('/api/admin/b2b/imports/' + S.imp + '/apply', { confirm: true, wait: true }, admin);
  assert.equal(r.status, 400, 'an import can only be applied once');

  // Same file again → updates only, stock untouched.
  const again = await upload(await xlsx([{ 'SKU': 'BIS001', 'Product Name': 'Millet Biscuits 200g', 'GST Rate': 18, 'MRP': 125, 'Base Price': 60, 'Opening Stock': 240, 'Warehouse': 'BLR-MAIN' }], HEAD));
  await s.post('/api/admin/b2b/imports/' + again.data.id + '/validate', {}, admin);
  await s.post('/api/admin/b2b/imports/' + again.data.id + '/apply', { confirm: true, wait: true }, admin);
  const bis2 = (await s.get('/api/admin/b2b/products?q=BIS001', admin)).data.items[0];
  assert.equal(bis2.mrp, '125.00'); assert.equal(bis2.company_stock, 240);

  // Roll the second import back → previous value restored.
  r = await s.post('/api/admin/b2b/imports/' + again.data.id + '/rollback', {}, admin);
  assert.equal(r.data.status, 'rolled_back');
  assert.equal((await s.get('/api/admin/b2b/products?q=BIS001', admin)).data.items[0].mrp, '120.00');

  const hist = await s.get('/api/admin/b2b/imports', admin);
  assert.deepEqual(hist.data.items.map(i => i.status), ['rolled_back', 'completed']);
  await s.patch('/api/admin/b2b/products/' + S.p3, { is_active: 1 }, admin);
});

test('Excel import: CSV with custom column names and manual mapping', async () => {
  const csv = 'Item Code,Title,Tax,Max Price,Our Price\r\nPBAR01,"Protein Bar, Choco",18,80,40\r\n';
  let r = await upload(Buffer.from(csv), 'bars.csv');
  assert.equal(r.status, 201);
  assert.equal(r.data.mapping['Item Code'], 'sku');
  r = await s.post('/api/admin/b2b/imports/' + r.data.id + '/validate', { mapping: { 'Item Code': 'sku', 'Title': 'name', 'Tax': 'gst_rate', 'Max Price': 'mrp', 'Our Price': 'base_price' } }, admin);
  assert.equal(r.data.valid, 1);
  await s.post('/api/admin/b2b/imports/' + r.data.id + '/apply', { confirm: true, wait: true }, admin);
  assert.equal((await s.get('/api/admin/b2b/products?q=PBAR01', admin)).data.items[0].name, 'Protein Bar, Choco');
});

/* ═════════════════ Cart, MOQ, ordering ═════════════════ */

test('cart: MOQ and case multiples are enforced by the server', async () => {
  let r = await cartSet(S.r1, S.p1, 15);
  assert.equal(r.status, 400); assert.match(r.data.error, /multiples of 20/);
  r = await cartSet(S.r1, S.p1, 5);
  assert.equal(r.status, 400); assert.match(r.data.error, /Minimum order quantity is 10/);
  r = await cartSet(S.r1, S.pDistOnly, 1);
  assert.equal(r.status, 404, 'a retailer cannot add a distributor-only product even by id');
  r = await cartSet(S.r1, 999999, 1);
  assert.equal(r.status, 404);
  r = await cartSet(S.r1, S.p1, 20);
  assert.equal(r.status, 200);
  assert.equal(r.data.items[0].unit_price, '295.00');

  const quick = await s.post('/api/b2b/cart/bulk', { lines: [{ sku: 'GUM002', qty: 10 }, { sku: 'gum003', qty: 3 }, { sku: 'NOPE', qty: 1 }, { sku: 'BIS001', qty: 7 }] }, S.r1);
  assert.equal(quick.data.added, 2);
  assert.deepEqual(quick.data.errors.map(e => e.sku), ['NOPE', 'BIS001']);
  const cart = quick.data.cart;
  assert.equal(cart.items.length, 3);
  assert.equal(cart.seller.type, 'distributor');
  assert.equal(cart.seller.name, 'Bengaluru Trade Links');
  // 20×295 + 10×522 + 3×330.40 = 5900 + 5220 + 991.20 ; GST 18% on first two, 5% on iron
  assert.equal(cart.totals.taxable, '12111.20');
  assert.equal(cart.totals.cgst, '1025.58'); assert.equal(cart.totals.sgst, '1025.58'); assert.equal(cart.totals.igst, '0.00');
  assert.equal(cart.totals.grand_total, '14162.00'); assert.equal(cart.totals.round_off, '-0.36');
  assert.equal(cart.can_checkout, true);
});

test('ordering: tampered prices/totals are ignored; duplicate submits create ONE order', async () => {
  const key = uid();
  const tamper = { unit_price: 1, grand_total: 1, total: 1, items: [{ product_id: S.p1, qty: 20, unit_price: 0.01 }], seller_account_id: S.dist2, buyer_account_id: S.ret2, status: 'delivered', role: 'admin' };
  const first = await place(S.r1, 'bank_transfer', key, tamper);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.order.grand_total, '14162.00', 'server-calculated total');
  assert.equal(first.data.order.status, 'pending_admin_approval', 'first order needs admin approval');
  S.o1 = first.data.order.id;

  // The retailer clicks "Place Order" again (slow network) — same key.
  const again = await place(S.r1, 'bank_transfer', key, tamper);
  assert.equal(again.status, 200); assert.equal(again.data.duplicate, true); assert.equal(again.data.order.id, S.o1);
  // …and five more times at once.
  const burst = await Promise.all([1, 2, 3, 4, 5].map(() => place(S.r1, 'bank_transfer', key)));
  burst.forEach(b => assert.equal(b.data.order.id, S.o1));
  assert.equal((await s.get('/api/b2b/orders', S.r1)).data.total, 1);
  assert.equal((await s.get('/api/b2b/cart', S.r1)).data.items.length, 0, 'cart cleared');

  assert.equal((await place(S.r1, 'bank_transfer', uid())).status, 400, 'empty cart');
  assert.equal((await s.post('/api/b2b/orders', { payment_method: 'bank_transfer' }, S.r1)).status, 400, 'idempotency key is mandatory');

  const o = await s.get('/api/b2b/orders/' + S.o1, S.r1);
  assert.equal(o.data.order.buyer_account_id, S.ret1, 'buyer comes from the session, not the body');
  assert.equal(o.data.order.seller_account_id, S.dist1, 'seller comes from the mapping, not the body');
  assert.equal(o.data.items.find(i => i.sku === 'GUM001').unit_price, '295.00');
  assert.equal(o.data.order.cost_total, undefined, 'cost is hidden from buyers');
  assert.equal(o.data.items[0].base_price, undefined);
  assert.match(o.data.order.order_no, /^B2B\d{4}-\d{6}$/);
});

test('concurrent first-time checkouts with different keys still serialise per buyer', async () => {
  await s.post('/api/b2b/cart/bulk', { lines: [{ sku: 'GUM003', qty: 2 }] }, S.r2);
  const res = await Promise.all([place(S.r2, 'upi', uid()), place(S.r2, 'upi', uid()), place(S.r2, 'upi', uid())]);
  assert.equal(res.filter(r => r.status === 201).length, 1, 'the cart can only be converted once');
  assert.equal(res.filter(r => r.status === 400).length, 2);
  S.o2 = res.find(r => r.status === 201).data.order.id;
});

test('data isolation: retailers and distributors cannot read each other', async () => {
  // Retailer B → Retailer A's order / invoice / returns / print
  for (const url of ['/api/b2b/orders/' + S.o1, '/api/b2b/print?ids=' + S.o1]) assert.equal((await s.get(url, S.r2)).status, 404, url);
  assert.equal((await s.post('/api/b2b/orders/' + S.o1 + '/cancel', { reason: 'not mine' }, S.r2)).status, 404);
  assert.equal((await s.post('/api/b2b/orders/' + S.o1 + '/reorder', {}, S.r2)).status, 404);
  // Distributor 2 → Distributor 1's retailer order
  assert.equal((await s.get('/api/b2b/retailer-orders/' + S.o1, S.d2)).status, 404);
  assert.equal((await s.post('/api/b2b/retailer-orders/' + S.o1 + '/status', { status: 'accepted' }, S.d2)).status, 404);
  assert.equal((await s.post('/api/b2b/retailer-orders/' + S.o1 + '/payments', { method: 'cash', amount: 1 }, S.d2)).status, 404);
  assert.deepEqual((await s.get('/api/b2b/retailer-orders', S.d2)).data.items.map(o => o.id), [S.o2]);
  // The supplying distributor can see it (but not its cost).
  const mine = await s.get('/api/b2b/retailer-orders/' + S.o1, S.d1);
  assert.equal(mine.status, 200); assert.equal(mine.data.order.cost_total, undefined);
  // A distributor's own order list is its purchases, not its retailers' orders.
  assert.equal((await s.get('/api/b2b/orders', S.d1)).data.total, 0);
  // Tokens do not cross systems.
  assert.equal((await s.get('/api/admin/b2b/orders', S.r1)).status, 401, 'business token on the admin API');
  assert.equal((await s.get('/api/admin/orders', S.r1)).status, 401);
  assert.equal((await s.get('/api/b2b/me', admin)).status, 401, 'admin token on the portal API');
  const cust = await s.post('/api/auth/signup', { email: 'shopper@example.com', password: 'password123' });
  assert.equal((await s.get('/api/b2b/me', bearer(cust.data.token))).status, 401, 'customer token on the portal API');
  assert.equal((await s.get('/api/b2b/orders/' + S.o1)).status, 401);
});

test('first-order approval: admin sees everything, can hold, adjust and change distributor', async () => {
  const d = await s.get('/api/admin/b2b/orders/' + S.o1, admin);
  assert.equal(d.data.order.is_first_order, 1);
  assert.equal(d.data.order.cost_total, '10340.00');
  assert.ok(d.data.candidates.length >= 1); assert.ok(Array.isArray(d.data.buyerRiskFlags));
  assert.deepEqual(d.data.nextStatuses.sort(), ['approved', 'cancelled', 'rejected']);

  // The distributor cannot act before approval, the buyer cannot approve.
  assert.equal((await s.post('/api/b2b/retailer-orders/' + S.o1 + '/status', { status: 'accepted' }, S.d1)).status, 409);
  assert.equal((await adminStatus(S.o1, 'delivered')).status, 409, 'cannot skip the workflow');

  let r = await s.post('/api/admin/b2b/orders/' + S.o1 + '/hold', { hold: true, reason: 'Verify shop address' }, admin);
  assert.equal(r.status, 200);
  assert.equal((await adminStatus(S.o1, 'approved')).status, 400, 'held orders cannot move');
  await s.post('/api/admin/b2b/orders/' + S.o1 + '/hold', { hold: false }, admin);

  const iron = d.data.items.find(i => i.sku === 'GUM003');
  r = await s.post('/api/admin/b2b/orders/' + S.o1 + '/quantities', { items: [{ order_item_id: iron.id, qty: 5 }] }, admin);
  assert.equal(r.status, 400, 'quantities can only be reduced');
  r = await s.post('/api/admin/b2b/orders/' + S.o1 + '/quantities', { items: [{ order_item_id: iron.id, qty: 0 }] }, admin);
  assert.equal(r.data.grand_total, '13122.00');   // 11120 + 18% = 13121.60 → 13122

  // Change distributor to Mysuru and back (same state → still CGST/SGST).
  r = await s.post('/api/admin/b2b/orders/' + S.o1 + '/seller', { distributor_id: S.dist2, reason: 'Capacity test' }, admin);
  assert.equal(r.status, 200); assert.equal(r.data.status, 'pending_admin_approval');
  assert.equal((await s.get('/api/b2b/retailer-orders/' + S.o1, S.d1)).status, 404, 'old distributor loses access');
  assert.equal((await s.get('/api/b2b/retailer-orders/' + S.o1, S.d2)).status, 200);
  await s.post('/api/admin/b2b/orders/' + S.o1 + '/seller', { distributor_id: S.dist1, reason: 'Back to mapped distributor' }, admin);

  r = await adminStatus(S.o1, 'approved', { note: 'Documents verified' });
  assert.equal(r.status, 200); assert.equal(r.data.status, 'assigned', 'approved orders go straight to the distributor');
  const acc = await s.get('/api/admin/b2b/accounts/' + S.ret1, admin);
  assert.equal(acc.data.account.first_order_done, true);
});

test('distributor fulfils: accept → process → pack → dispatch (invoice) → deliver', async () => {
  const step = (status, extra) => s.post('/api/b2b/retailer-orders/' + S.o1 + '/status', Object.assign({ status }, extra || {}), S.d1);
  assert.equal((await step('packed')).status, 409, 'cannot jump from assigned to packed');
  for (const st of ['accepted', 'processing', 'packed']) assert.equal((await step(st)).status, 200, st);
  assert.equal((await s.post('/api/b2b/orders/' + S.o1 + '/cancel', { reason: 'changed my mind' }, S.r1)).status, 409, 'too late for the buyer to cancel');
  const disp = await step('dispatched');
  assert.equal(disp.status, 200);
  assert.match(disp.data.invoiceNo, /^D\d+2\d{3}-00001$/, 'distributor invoice series');
  S.inv1No = disp.data.invoiceNo;
  await step('out_for_delivery');
  const del = await step('delivered');
  assert.equal(del.data.status, 'delivered');

  const o = await s.get('/api/b2b/orders/' + S.o1, S.r1);
  assert.deepEqual(o.data.history.map(h => h.to_status),
    ['submitted', 'pending_admin_approval', 'pending_admin_approval', 'pending_admin_approval', 'pending_admin_approval', 'pending_admin_approval', 'pending_admin_approval',
      'approved', 'assigned', 'accepted', 'processing', 'packed', 'dispatched', 'out_for_delivery', 'delivered']);
  ['submitted_at', 'approved_at', 'assigned_at', 'accepted_at', 'processing_at', 'packed_at', 'dispatched_at', 'out_for_delivery_at', 'delivered_at']
    .forEach(k => assert.ok(o.data.order[k], k + ' timestamp recorded'));
  assert.equal(o.data.invoice.invoice_no, S.inv1No);
  S.inv1 = o.data.invoice.id;
});

test('GST invoice: intra-state CGST+SGST, seller = distributor, buyer scoped', async () => {
  const inv = await s.get('/api/b2b/invoices/' + S.inv1, S.r1);
  assert.equal(inv.status, 200);
  const i = inv.data.invoice;
  assert.equal(i.seller_name, 'Bengaluru Trade Links'); assert.equal(i.seller_gstin, distributorForm().gstin);
  assert.equal(i.seller_state_code, '29'); assert.equal(i.buyer_state_code, '29'); assert.equal(i.is_interstate, 0);
  assert.equal(i.place_of_supply, '29 - Karnataka');
  assert.equal(i.taxable_total, '11120.00'); assert.equal(i.cgst_total, '1000.80'); assert.equal(i.sgst_total, '1000.80'); assert.equal(i.igst_total, '0.00');
  assert.equal(i.grand_total, '13122.00');
  assert.equal(inv.data.items.length, 2);
  assert.equal(inv.data.items[0].hsn_code, '21069099');
  assert.equal((await s.get('/api/b2b/invoices/' + S.inv1, S.r2)).status, 404, 'another retailer cannot open it');
  assert.equal((await s.get('/api/b2b/retailer-invoices/' + S.inv1, S.d2)).status, 404, 'another distributor cannot open it');
  assert.equal((await s.get('/api/b2b/retailer-invoices/' + S.inv1, S.d1)).status, 200);
});

/* ═════════════════ Company-supplied orders: stock, IGST, concurrency ═════════════════ */

test('distributor buys from the company: stock is reserved, FEFO batches, IGST for another state', async () => {
  await s.post('/api/b2b/cart/bulk', { lines: [{ sku: 'GUM001', qty: 120 }] }, S.d3);
  const cart = (await s.get('/api/b2b/cart', S.d3)).data;
  assert.equal(cart.seller.type, 'company');
  assert.equal(cart.items[0].unit_price, '274.40', 'volume discount from 100 units');
  assert.equal(cart.totals.interstate, true);
  assert.equal(cart.totals.igst, '5927.04'); assert.equal(cart.totals.cgst, '0.00');
  const r = await place(S.d3, 'bank_transfer');
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.o3 = r.data.order.id;

  let st = (await s.get('/api/admin/b2b/stock?q=GUM001', admin)).data.items[0];
  assert.equal(st.qty_available, 175); assert.equal(st.qty_reserved, 120);

  await adminStatus(S.o3, 'approved');
  for (const x of ['accepted', 'processing', 'packed']) assert.equal((await adminStatus(S.o3, x)).status, 200, x);
  st = (await s.get('/api/admin/b2b/stock?q=GUM001', admin)).data.items[0];
  assert.equal(st.qty_reserved, 0); assert.equal(st.qty_allocated, 120);
  // First-Expiry-First-Out: B-SOON (95 left after the 5 damaged came off unbatched stock… ) is used before B-LATE.
  const batches = (await s.get('/api/admin/b2b/stock/batches?product_id=' + S.p1, admin)).data.items;
  const soon = batches.find(b => b.batch_no === 'B-SOON'), late = batches.find(b => b.batch_no === 'B-LATE');
  assert.equal(soon, undefined, 'the batch that expires first was fully picked');
  assert.equal(late.qty_on_hand, 180);

  const disp = await adminStatus(S.o3, 'dispatched');
  assert.match(disp.data.invoiceNo, /^SOH2\d{3}-00001$/);
  st = (await s.get('/api/admin/b2b/stock?q=GUM001', admin)).data.items[0];
  assert.equal(st.qty_in_transit, 120);
  await adminStatus(S.o3, 'delivered');
  st = (await s.get('/api/admin/b2b/stock?q=GUM001', admin)).data.items[0];
  assert.deepEqual([st.qty_available, st.qty_reserved, st.qty_allocated, st.qty_in_transit], [175, 0, 0, 0]);

  const inv = (await s.get('/api/b2b/invoices', S.d3)).data.items[0];
  const full = (await s.get('/api/b2b/invoices/' + inv.id, S.d3)).data.invoice;
  assert.equal(full.is_interstate, 1); assert.equal(full.igst_total, '5927.04'); assert.equal(full.cgst_total, '0.00');
  assert.equal(full.place_of_supply, '33 - Tamil Nadu'); assert.equal(full.seller_state_code, '29');

  // The goods (with batch + expiry) are now in the distributor's own stock point.
  const own = await s.get('/api/b2b/stock', S.d3);
  assert.equal(own.data.items[0].sku, 'GUM001'); assert.equal(own.data.items[0].qty_available, 120);
  assert.equal((await s.get('/api/b2b/stock', S.d1)).data.total, 0, 'distributors see only their own stock');
});

test('concurrent stock: stock 10, two buyers order 10 at the same time → exactly one succeeds', async () => {
  // GUM002 has exactly 10 units. Distributors 1 and 2 both try to take all of them.
  for (const h of [S.d1, S.d2]) assert.equal((await cartSet(h, S.p2, 10)).status, 200);
  const [a, b] = await Promise.all([place(S.d1, 'bank_transfer'), place(S.d2, 'bank_transfer')]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [201, 409], 'one order, one "insufficient stock" — never two orders');
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.data.code, 'INSUFFICIENT_STOCK');
  assert.equal(loser.data.shortages[0].sku, 'GUM002');
  const st = (await s.get('/api/admin/b2b/stock?q=GUM002', admin)).data.items[0];
  assert.deepEqual([st.qty_available, st.qty_reserved], [0, 10], 'sold 10, not 20');
  S.o4 = (a.status === 201 ? a : b).data.order.id;
  S.o4Buyer = a.status === 201 ? S.d1 : S.d2;
  S.o4Loser = a.status === 201 ? S.d2 : S.d1;
  assert.equal((await s.get('/api/b2b/cart', S.o4Loser)).data.items[0].problem, 'Out of stock');
});

test('concurrent stock under load: 30 simultaneous checkouts for 240 units never oversell', async () => {
  // BIS001: 240 in stock, MOQ 12. Thirty requests of 12 across 3 buyers = 360 requested.
  const buyers = [S.d1, S.d2, S.d3];
  let ok = 0, short = 0, other = 0;
  for (let round = 0; round < 10; round++) {
    await Promise.all(buyers.map(h => cartSet(h, S.pBis, 36)));
    const res = await Promise.all(buyers.map(h => place(h, 'bank_transfer')));
    res.forEach(r => { if (r.status === 201) ok++; else if (r.status === 409) short++; else other++; });
  }
  assert.equal(other, 0);
  const st = (await s.get('/api/admin/b2b/stock?q=BIS001', admin)).data.items[0];
  assert.equal(st.qty_available + st.qty_reserved, 240, 'stock is conserved');
  assert.equal(st.qty_reserved, ok * 36);
  assert.ok(st.qty_reserved <= 240 && st.qty_available >= 0);
  assert.equal(ok, 6); assert.equal(short, 24);
  for (const h of buyers) await s.del('/api/b2b/cart', h);
});

test('cancelling releases stock; buyers can cancel only early', async () => {
  const before = (await s.get('/api/admin/b2b/stock?q=GUM002', admin)).data.items[0];
  assert.equal(before.qty_reserved, 10);
  // Distributor's first order is awaiting approval → buyer may cancel.
  const r = await s.post('/api/b2b/orders/' + S.o4 + '/cancel', { reason: 'Ordered by mistake' }, S.o4Buyer);
  assert.equal(r.status, 200); assert.equal(r.data.status, 'cancelled');
  const after = (await s.get('/api/admin/b2b/stock?q=GUM002', admin)).data.items[0];
  assert.deepEqual([after.qty_available, after.qty_reserved], [10, 0]);
  assert.equal((await adminStatus(S.o4, 'approved')).status, 409, 'cancelled orders cannot be revived');
  await s.del('/api/b2b/cart', S.o4Loser);
});

/* ═════════════════ Credit & payments ═════════════════ */

test('credit: limit enforced under lock, admin override, distributor-extended credit', async () => {
  // Company credit for distributor 3: limit 1,00,000, used 35,000 → available 65,000.
  let r = await s.put('/api/admin/b2b/credit/' + S.dist3, { credit_limit: 100000, credit_days: 30 }, admin);
  assert.equal(r.status, 200);
  await cartSet(S.d3, S.p3, 100);     // 100 × 313.60 = 31360 + 5% IGST = 32928
  let cart = (await s.get('/api/b2b/cart', S.d3)).data;
  assert.ok(cart.payment.methods.some(m => m.id === 'credit'));
  r = await place(S.d3, 'credit');
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.o5 = r.data.order.id;
  let c = (await s.get('/api/b2b/credit', S.d3)).data.credit;
  assert.deepEqual([c.credit_limit, c.credit_used, c.available], ['100000.00', '32928.00', '67072.00']);

  await cartSet(S.d3, S.p3, 250);     // 82320 > 67072 available
  r = await place(S.d3, 'credit');
  assert.equal(r.status, 409); assert.equal(r.data.code, 'CREDIT_LIMIT'); assert.equal(r.data.available, '67072.00');
  c = (await s.get('/api/b2b/credit', S.d3)).data.credit;
  assert.equal(c.credit_used, '32928.00', 'a refused order leaves the credit line untouched');
  const st = (await s.get('/api/admin/b2b/stock?q=GUM003', admin)).data.items[0];
  assert.equal(st.qty_reserved, 100, '…and reserves no stock');

  // Authorised override lets it through.
  r = await s.post('/api/admin/b2b/credit/' + S.dist3 + '/override', { amount: 20000, hours: 2 }, admin);
  assert.equal(r.status, 400, 'override needs a reason');
  r = await s.post('/api/admin/b2b/credit/' + S.dist3 + '/override', { amount: 20000, hours: 2, reason: 'Festival season, approved by owner' }, admin);
  assert.equal(r.status, 200);
  r = await place(S.d3, 'credit');
  assert.equal(r.status, 201); S.o6 = r.data.order.id;
  c = (await s.get('/api/b2b/credit', S.d3)).data.credit;
  assert.equal(c.credit_used, '115248.00');
  // Two simultaneous credit orders cannot both squeeze under what is left (4,752).
  await s.post('/api/admin/b2b/credit/' + S.dist3 + '/override', { amount: 0 }, admin);
  await s.put('/api/admin/b2b/credit/' + S.dist3, { credit_limit: 120000, credit_days: 30 }, admin);
  await cartSet(S.d3, S.p3, 10);      // 3292.80 → 3293
  const both = await Promise.all([place(S.d3, 'credit'), place(S.d3, 'credit')]);
  assert.equal(both.filter(x => x.status === 201).length, 1);

  // A distributor gives credit to its own retailer — and only its own.
  r = await s.put('/api/b2b/retailers/' + S.ret1 + '/credit', { credit_limit: 20000, credit_days: 15 }, S.d1);
  assert.equal(r.status, 200);
  assert.equal((await s.put('/api/b2b/retailers/' + S.ret2 + '/credit', { credit_limit: 999999 }, S.d1)).status, 404);
  const mine = await s.get('/api/b2b/my-distributor', S.r1);
  assert.equal(mine.data.credit.credit_limit, '20000.00');
});

test('payments: seller-scoped recording, over-payment and duplicates refused, credit freed', async () => {
  const pay = (h, orderId, body) => s.post('/api/b2b/retailer-orders/' + orderId + '/payments', body, h);
  let r = await pay(S.d1, S.o1, { method: 'upi', amount: 5000 });
  assert.equal(r.status, 400, 'reference required');
  r = await pay(S.d1, S.o1, { method: 'upi', amount: 5000, reference: 'UTR123456' });
  assert.equal(r.status, 201); assert.equal(r.data.paymentStatus, 'partial');
  r = await pay(S.d1, S.o1, { method: 'upi', amount: 5000, reference: 'UTR123456' });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'DUPLICATE_PAYMENT');
  r = await pay(S.d1, S.o1, { method: 'cash', amount: 99999 });
  assert.equal(r.status, 400, 'cannot pay more than is outstanding');
  r = await pay(S.d1, S.o1, { method: 'cash', amount: 8122 });
  assert.equal(r.data.paymentStatus, 'paid');
  assert.equal((await pay(S.r1, S.o1, { method: 'cash', amount: 1 })).status, 403, 'a buyer cannot mark its own order paid');
  const o = await s.get('/api/b2b/orders/' + S.o1, S.r1);
  assert.equal(o.data.order.payment_status, 'paid'); assert.equal(o.data.outstanding, '0.00');

  // Company order on credit: a payment frees the credit line by the same amount.
  const before = (await s.get('/api/b2b/credit', S.d3)).data.credit.credit_used;
  r = await s.post('/api/admin/b2b/orders/' + S.o5 + '/payments', { method: 'bank_transfer', amount: 12928, reference: 'NEFT-0001' }, admin);
  assert.equal(r.status, 201);
  const after = (await s.get('/api/b2b/credit', S.d3)).data.credit.credit_used;
  assert.equal(Number(before) - Number(after), 12928);
  const out = await s.get('/api/admin/b2b/outstanding', admin);
  assert.ok(out.data.items.some(x => x.account_id === S.dist3));
});

test('online payment: amount fixed by the server; callback + webhook + replays apply once', async () => {
  const init = await s.post('/api/b2b/orders/' + S.o3 + '/pay/initiate', {}, S.d3);
  assert.equal(init.status, 200, JSON.stringify(init.data));
  assert.equal(init.data.amount, 38855, 'outstanding amount, decided by the server');   // 32928 + 5927.04 = 38855.04 → 38855
  const confirm = () => s.post('/api/b2b/orders/' + S.o3 + '/pay/confirm', { gateway: 'mock', gatewayOrderId: init.data.gatewayOrderId, paymentId: 'pay_TEST_1', signature: 'x', amount: 1 }, S.d3);
  const results = await Promise.all([confirm(), confirm(), confirm()]);
  assert.equal(results.filter(r => r.data.duplicate === false).length, 1, 'only one of the simultaneous callbacks applies');
  assert.equal((await confirm()).data.duplicate, true);

  // The gateway webhook for the same payment arrives later — verified by HMAC, still no double credit.
  const crypto = require('crypto');
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_TEST_1', order_id: init.data.gatewayOrderId, amount: 3885500 } } } });
  const sig = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');
  const hook = await fetch(s.base + '/api/b2b/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body });
  assert.equal(hook.status, 200); assert.equal((await hook.json()).duplicate, true);
  const forged = await fetch(s.base + '/api/b2b/webhooks/razorpay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef' }, body });
  assert.equal(forged.status, 400);

  const o = await s.get('/api/b2b/orders/' + S.o3, S.d3);
  assert.equal(o.data.order.payment_status, 'paid'); assert.equal(o.data.order.amount_paid, '38855.00');
  assert.equal(o.data.payments.length, 1);
  // Another buyer cannot confirm against someone else's gateway order.
  const other = await s.post('/api/b2b/orders/' + S.o3 + '/pay/confirm', { gateway: 'mock', gatewayOrderId: init.data.gatewayOrderId, paymentId: 'pay_TEST_2' }, S.d1);
  assert.equal(other.status, 404);
  assert.equal((await s.post('/api/b2b/orders/' + S.o1 + '/pay/initiate', {}, S.r1)).status, 400, 'no company gateway for distributor-supplied orders');
});

/* ═════════════════ Partial delivery, returns, credit notes, invoice cancellation ═════════════════ */

test('partial delivery raises a credit note and returns undelivered stock', async () => {
  // Not a first order, so it skipped approval and is already "assigned".
  assert.equal((await s.get('/api/admin/b2b/orders/' + S.o5, admin)).data.order.status, 'assigned');
  for (const x of ['accepted', 'processing', 'packed', 'dispatched']) {
    const r = await adminStatus(S.o5, x);
    assert.equal(r.status, 200, x + ' ' + JSON.stringify(r.data));
  }
  const d = await s.get('/api/admin/b2b/orders/' + S.o5, admin);
  const item = d.data.items[0];
  const before = (await s.get('/api/admin/b2b/stock?q=GUM003', admin)).data.items[0].qty_available;
  let r = await adminStatus(S.o5, 'delivered', { delivered: { [item.id]: 101 } });
  assert.equal(r.status, 400);
  r = await adminStatus(S.o5, 'delivered', { delivered: { [item.id]: 90 } });
  assert.equal(r.status, 200); assert.equal(r.data.status, 'partially_delivered');
  assert.match(r.data.creditNote.creditNoteNo, /^SOHC2\d{3}-00001$/);
  const after = (await s.get('/api/admin/b2b/stock?q=GUM003', admin)).data.items[0].qty_available;
  assert.equal(after - before, 10, 'the 10 undelivered units are back in stock');
  const notes = await s.get('/api/admin/b2b/credit-notes', admin);
  assert.equal(notes.data.items[0].grand_total, '3292.80');   // 10 × 313.60 + 5%
  S.o5Item = item.id;
});

test('returns: request → approve → inspect → credit note; quantities and ownership checked', async () => {
  let r = await s.post('/api/b2b/orders/' + S.o5 + '/returns', { reason: 'Damaged in transit', items: [{ order_item_id: S.o5Item, qty: 95 }] }, S.d3);
  assert.equal(r.status, 400, 'cannot return more than was delivered');
  r = await s.post('/api/b2b/orders/' + S.o5 + '/returns', { reason: 'Damaged in transit', items: [{ order_item_id: S.o5Item, qty: 6 }] }, S.d1);
  assert.equal(r.status, 404, "cannot return someone else's order");
  r = await s.post('/api/b2b/orders/' + S.o5 + '/returns', { reason: 'Damaged in transit', items: [{ order_item_id: S.o5Item, qty: 6 }] }, S.d3);
  assert.equal(r.status, 201, JSON.stringify(r.data)); S.ret = r.data.id;
  r = await s.post('/api/b2b/orders/' + S.o5 + '/returns', { reason: 'Second request', items: [{ order_item_id: S.o5Item, qty: 85 }] }, S.d3);
  assert.equal(r.status, 400, 'units already in an open return are not counted twice');

  assert.equal((await s.post('/api/admin/b2b/returns/' + S.ret + '/complete', { resolution: 'credit_note' }, admin)).status, 400, 'inspection comes first');
  assert.equal((await s.post('/api/admin/b2b/returns/' + S.ret + '/approve', {}, admin)).status, 200);
  const detail = await s.get('/api/admin/b2b/returns/' + S.ret, admin);
  const stockBefore = (await s.get('/api/admin/b2b/stock?q=GUM003', admin)).data.items[0];
  r = await s.post('/api/admin/b2b/returns/' + S.ret + '/inspect', { items: [{ return_item_id: detail.data.items[0].id, qty_accepted: 5, condition: 'damaged' }], note: '1 unit not received' }, admin);
  assert.equal(r.data.status, 'received');
  const stockAfter = (await s.get('/api/admin/b2b/stock?q=GUM003', admin)).data.items[0];
  assert.equal(stockAfter.qty_damaged - stockBefore.qty_damaged, 5, 'damaged returns do not go back on sale');
  assert.equal(stockAfter.qty_available, stockBefore.qty_available);
  r = await s.post('/api/admin/b2b/returns/' + S.ret + '/complete', { resolution: 'credit_note' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.creditNoteNo, /^SOHC2\d{3}-00002$/, 'credit notes are sequential');
  assert.equal((await s.get('/api/b2b/returns/' + S.ret, S.d3)).data.ret.status, 'completed');
  assert.equal((await s.get('/api/b2b/returns/' + S.ret, S.d1)).status, 404);
});

test('invoices are never edited: cancellation issues a full credit note; numbers stay sequential', async () => {
  const list = await s.get('/api/admin/b2b/invoices?seller_type=company', admin);
  const nos = list.data.items.map(i => i.invoice_no).sort();
  assert.deepEqual(nos.map(n => n.slice(-5)), ['00001', '00002'], 'gap-free company series');
  const target = list.data.items.find(i => i.order_id === S.o5);
  let r = await s.post('/api/admin/b2b/invoices/' + target.id + '/cancel', {}, admin);
  assert.equal(r.status, 400);
  r = await s.post('/api/admin/b2b/invoices/' + target.id + '/cancel', { reason: 'Wrong billing address' }, admin);
  assert.equal(r.status, 200); assert.match(r.data.creditNoteNo, /-00003$/);
  assert.equal((await s.post('/api/admin/b2b/invoices/' + target.id + '/cancel', { reason: 'again' }, admin)).status, 400);
  const cancelled = await s.get('/api/admin/b2b/invoices/' + target.id, admin);
  assert.equal(cancelled.data.invoice.status, 'cancelled');
  assert.equal(cancelled.data.invoice.grand_total, '32928.00', 'the original document is preserved as issued');
  // Re-issue: a NEW number, the old one is never reused.
  r = await s.post('/api/admin/b2b/orders/' + S.o5 + '/invoice', {}, admin);
  assert.equal(r.status, 201); assert.match(r.data.invoice_no, /-00003$/);
  // No route can update or delete an invoice.
  for (const m of ['patch', 'put', 'del']) assert.equal((await s[m]('/api/admin/b2b/invoices/' + target.id, m === 'del' ? admin : {}, admin)).status, 404);
});

/* ═════════════════ Reorder, favourites, dashboards ═════════════════ */

test('reorder rebuilds the cart with current price, MOQ and availability', async () => {
  await s.patch('/api/admin/b2b/products/' + S.p1, { moq: 40, case_qty: 40 }, admin);      // MOQ went up since the first order
  await s.patch('/api/admin/b2b/products/' + S.p2, { is_active: 0 }, admin);                // and one product was retired
  const r = await s.post('/api/b2b/orders/' + S.o1 + '/reorder', {}, S.r1);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, 1);
  assert.deepEqual(r.data.notes.map(n => n.sku + ':' + n.status).sort(), ['GUM001:adjusted', 'GUM002:unavailable']);
  assert.equal(r.data.cart.items[0].qty, 40);
  await s.patch('/api/admin/b2b/products/' + S.p1, { moq: 10, case_qty: 20 }, admin);
  await s.patch('/api/admin/b2b/products/' + S.p2, { is_active: 1 }, admin);
  await s.del('/api/b2b/cart', S.r1);
});

test('favourites and frequently ordered', async () => {
  assert.equal((await s.put('/api/b2b/favorites/' + S.p3, {}, S.r1)).data.favorite, true);
  const fav = await s.get('/api/b2b/products?favorites=1', S.r1);
  assert.deepEqual(fav.data.items.map(p => p.sku), ['GUM003']);
  assert.equal((await s.get('/api/b2b/products?favorites=1', S.r2)).data.total, 0, 'favourites are per account');
  const freq = await s.get('/api/b2b/products?frequent=1', S.r1);
  assert.deepEqual(freq.data.items.map(p => p.sku).sort(), ['GUM001', 'GUM002']);
  await s.del('/api/b2b/favorites/' + S.p3, S.r1);
});

test('dashboards: retailer, distributor and admin', async () => {
  const r = await s.get('/api/b2b/dashboard', S.r1);
  assert.equal(r.data.orders.delivered, 1); assert.equal(r.data.distributor.name, 'Bengaluru Trade Links');
  assert.ok(r.data.credit);
  const d = await s.get('/api/b2b/dashboard', S.d1);
  assert.equal(d.data.retailers, 1); assert.equal(d.data.retailerOrders.delivered, 1);
  assert.equal(d.data.sales30.value, '13122.00');
  const a = await s.get('/api/admin/b2b/dashboard?fresh=1', admin);
  assert.deepEqual(a.data.retailers, { total: 3, active: 3, pending: 0, suspended: 0 });
  assert.equal(a.data.distributors.active, 3);
  assert.ok(a.data.today.orders >= 5);
  assert.ok(a.data.topProducts.length > 0 && a.data.stateSales.length >= 2 && a.data.topDistricts.length > 0);
  assert.ok(a.data.fulfilment.deliveredOrders >= 3);
  assert.equal(a.data.expiring.within60, 0);
});

/* ═════════════════ Reports & exports ═════════════════ */

test('reports answer the business questions; exports stream as CSV and Excel', async () => {
  for (const t of ['sales', 'products', 'retailers', 'distributors', 'mapping', 'inventory', 'gst', 'margins', 'geographic']) {
    const r = await s.get('/api/admin/b2b/reports/' + t, admin);
    assert.equal(r.status, 200, t + ' ' + JSON.stringify(r.data).slice(0, 200));
    assert.ok(Array.isArray(r.data.rows) && r.data.columns.length > 0, t);
  }
  const gst = (await s.get('/api/admin/b2b/reports/gst?seller=all', admin)).data.rows;
  assert.ok(gst.some(x => x.supply === 'Inter-state' && Number(x.igst) > 0));
  assert.ok(gst.some(x => x.supply === 'Intra-state' && Number(x.cgst) > 0 && Number(x.cgst) === Number(x.sgst)));
  const margins = (await s.get('/api/admin/b2b/reports/margins', admin)).data.rows;
  const g1 = margins.find(x => x.sku === 'GUM001');
  assert.equal(g1.revenue, '32928.00'); assert.equal(g1.cost, '30000.00'); assert.equal(g1.margin, '2928.00');
  const geo = (await s.get('/api/admin/b2b/reports/geographic?level=state', admin)).data.rows;
  assert.deepEqual(geo.map(x => x.state).sort(), ['Karnataka', 'Tamil Nadu']);
  const map = (await s.get('/api/admin/b2b/reports/mapping', admin)).data.rows;
  assert.ok(map.some(x => x.distributor === 'Bengaluru Trade Links' && x.shop === 'Lakshmi Medicals'));

  for (const name of ['retailers', 'distributors', 'products', 'orders', 'invoices', 'payments', 'outstanding', 'movements', 'gst', 'margins']) {
    const r = await s.get('/api/admin/b2b/export/' + name, admin);
    assert.equal(r.status, 200, name);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.ok(String(r.data).split('\r\n').length >= 2, name + ' has a header row');
  }
  const x = await fetch(s.base + '/api/admin/b2b/export/orders?format=xlsx', { headers: admin });
  assert.equal(x.status, 200);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  assert.equal(wb.worksheets[0].getRow(1).getCell(1).value, 'Order No');
  assert.ok(wb.worksheets[0].rowCount >= 6);
});

test('lists are paginated and searchable server-side; limits are capped', async () => {
  const r = await s.get('/api/admin/b2b/orders?limit=100000&page=1', admin);
  assert.equal(r.data.limit, 100);
  const p = await s.get('/api/admin/b2b/accounts?limit=2&page=2&sort=name&dir=asc', admin);
  assert.equal(p.data.items.length, 2); assert.equal(p.data.total, 6); assert.equal(p.data.pages, 3);
  for (const [q, expect] of [['Lakshmi', S.ret1], ['9845000012', S.ret2], ['570004', S.ret2], [distributorForm().gstin.slice(0, 8), S.dist1], ['dist2@example.com', S.dist2], ['Hubballi', S.ret3]]) {
    const f = await s.get('/api/admin/b2b/accounts?q=' + encodeURIComponent(q), admin);
    assert.ok(f.data.items.some(a => a.id === expect), 'search "' + q + '"');
  }
  const g = await s.get('/api/admin/b2b/search?q=GUM', admin);
  assert.ok(g.data.products.length >= 3);
  const byNo = await s.get('/api/admin/b2b/search?q=' + S.inv1No, admin);
  assert.equal(byNo.data.invoices.length, 1);
});

/* ═════════════════ Security ═════════════════ */

test('SQL injection attempts are inert', async () => {
  const payloads = ["' OR '1'='1", "'; DROP TABLE b2b_orders; --", '" OR ""="', "1 UNION SELECT password_hash FROM b2b_users--", '%', '_', '\\'];
  for (const p of payloads) {
    const q = encodeURIComponent(p);
    for (const url of ['/api/admin/b2b/accounts?q=' + q, '/api/admin/b2b/orders?q=' + q + '&status=' + q + '&sort=' + q, '/api/admin/b2b/products?q=' + q + '&category_id=' + q,
      '/api/admin/b2b/invoices?q=' + q, '/api/admin/b2b/audit?action=' + q + '&entity=' + q, '/api/admin/b2b/stock?q=' + q + '&warehouse_id=' + q]) {
      const r = await s.get(url, admin);
      assert.equal(r.status, 200, url);
      assert.doesNotMatch(JSON.stringify(r.data), /password_hash|SQL syntax|ER_/);
    }
    const portal = await s.get('/api/b2b/products?q=' + q + '&category_id=' + q, S.r1);
    assert.equal(portal.status, 200);
    const l = await s.post('/api/b2b/auth/login', { identifier: p, password: p, role: 'retailer' });
    assert.equal(l.status, 401);
  }
  assert.equal((await s.get('/api/admin/b2b/accounts?q=' + encodeURIComponent("' OR '1'='1"), admin)).data.total, 0);
  assert.equal((await s.get('/api/admin/b2b/orders', admin)).status, 200, 'tables are still there');
  assert.equal((await s.get('/api/b2b/orders/1%20OR%201=1', S.r1)).status, 404);
});

test('XSS payloads are stored as plain text and never break responses; errors leak nothing', async () => {
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  await s.patch('/api/b2b/me/profile', { contact_person: xss, landmark: 'Near "Big" <b>Bazaar</b>' }, S.r3);
  const me = await s.get('/api/b2b/me', S.r3);
  assert.equal(me.data.account.contact_person, xss, 'returned as data (JSON), escaped by every page that renders it');
  assert.match(me.headers.get('content-type'), /application\/json/);
  assert.equal(me.headers.get('x-content-type-options'), 'nosniff');
  await s.patch('/api/b2b/me/profile', { contact_person: 'Hubli Owner' }, S.r3);
  // Identity fields cannot be changed by the business itself.
  await s.patch('/api/b2b/me/profile', { business_name: 'Hacked', gstin: 'X', status: 'approved', account_type: 'distributor', pincode: '110001' }, S.r3);
  const again = (await s.get('/api/b2b/me', S.r3)).data.account;
  assert.equal(again.business_name, 'Hubli Health Mart'); assert.equal(again.account_type, 'retailer'); assert.equal(again.pincode, '580020');

  const bad = await fetch(s.base + '/api/b2b/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.ok(bad.status === 400 || bad.status === 500);
  assert.doesNotMatch(await bad.text(), /at .*\.js|node_modules|\/home\//, 'no stack traces or paths');
  const nf = await s.get('/api/b2b/nope', S.r1);
  assert.ok([403, 404].includes(nf.status));
  assert.doesNotMatch(JSON.stringify(nf.data), /stack|sql/i);
});

test('role manipulation and RBAC: staff get only what their role allows', async () => {
  const mk = async (role) => {
    const email = role + '@test.local';
    const c = await s.post('/api/admin/staff', { name: role, email, password: 'password123', role }, admin);
    assert.equal(c.status, 201); assert.equal(c.data.role, role);
    return bearer((await s.post('/api/admin/login', { email, password: 'password123' })).data.token);
  };
  const support = await mk('support'), finance = await mk('finance'), inventoryRole = await mk('inventory'), sales = await mk('sales');

  // support: read-only
  assert.equal((await s.get('/api/admin/b2b/accounts', support)).status, 200);
  assert.equal((await s.get('/api/admin/b2b/orders/' + S.o1, support)).status, 200);
  assert.equal((await s.get('/api/admin/b2b/orders/' + S.o1, support)).data.order.cost_total, undefined, 'no cost data without pricing permission');
  assert.equal((await s.post('/api/admin/b2b/accounts/' + S.ret1 + '/status', { status: 'suspended', reason: 'x y z' }, support)).status, 403);
  assert.equal((await s.post('/api/admin/b2b/orders/' + S.o2 + '/status', { status: 'approved' }, support)).status, 403);
  assert.equal((await s.get('/api/admin/b2b/pricing/rules', support)).status, 403);
  assert.equal((await s.get('/api/admin/b2b/audit', support)).status, 403);
  assert.equal((await s.put('/api/admin/b2b/settings', { 'pricing.default_retailer_margin': '1' }, support)).status, 403);
  assert.equal((await s.get('/api/admin/b2b/export/products', support)).status, 403);
  assert.equal((await s.post('/api/admin/b2b/system/migrate', {}, support)).status, 403);
  // B2B-only roles cannot touch the B2C admin.
  for (const url of ['/api/admin/orders', '/api/admin/customers', '/api/admin/products', '/api/admin/staff', '/api/admin/settings']) {
    assert.equal((await s.get(url, support)).status, 403, url);
  }
  assert.equal((await s.get('/api/admin/me', support)).status, 200);

  // finance: payments yes, prices and approvals no
  assert.equal((await s.get('/api/admin/b2b/outstanding', finance)).status, 200);
  assert.equal((await s.put('/api/admin/b2b/credit/' + S.ret3, { credit_limit: 5000 }, finance)).status, 200);
  assert.equal((await s.post('/api/admin/b2b/credit/' + S.ret3 + '/override', { amount: 1, reason: 'abc' }, finance)).status, 403);
  assert.equal((await s.patch('/api/admin/b2b/products/' + S.p1, { base_price: 1 }, finance)).status, 403);
  assert.equal((await s.post('/api/admin/b2b/orders/' + S.o2 + '/status', { status: 'approved' }, finance)).status, 409, 'route allowed for refunds, but this transition is not theirs');

  // inventory: stock yes, catalogue text yes, prices no, payments no
  assert.equal((await s.get('/api/admin/b2b/stock', inventoryRole)).status, 200);
  assert.equal((await s.patch('/api/admin/b2b/products/' + S.p1, { pack_size: '30 gummies jar' }, inventoryRole)).status, 200);
  assert.equal((await s.patch('/api/admin/b2b/products/' + S.p1, { base_price: 1 }, inventoryRole)).status, 403);
  assert.equal((await s.get('/api/admin/b2b/products?q=GUM001', inventoryRole)).data.items[0].base_price, undefined);
  assert.equal((await s.post('/api/admin/b2b/orders/' + S.o1 + '/payments', { method: 'cash', amount: 1 }, inventoryRole)).status, 403);

  // sales: approvals yes, imports no
  assert.equal((await s.post('/api/admin/b2b/orders/' + S.o2 + '/status', { status: 'approved' }, sales)).status, 200);
  assert.equal((await s.get('/api/admin/b2b/imports', sales)).status, 403);

  // Existing delivery role: no B2B access at all, B2C access unchanged.
  // (Phase 0.5.8: demo staff are no longer auto-seeded, so the test creates its own delivery agent.)
  await s.post('/api/admin/staff', { name: 'Test Rider', email: 'rider@b2b-platform.test', phone: '9000000003', role: 'delivery', password: 'rider-pass-123' }, admin);
  const delivery = bearer((await s.post('/api/admin/login', { email: 'rider@b2b-platform.test', password: 'rider-pass-123' })).data.token);
  assert.equal((await s.get('/api/admin/b2b/accounts', delivery)).status, 403);
  assert.equal((await s.get('/api/admin/deliveries', delivery)).status, 200);

  // A forged / edited token is rejected.
  const parts = admin.Authorization.slice(7).split('.');
  const forged = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(parts[0], 'base64url').toString()), { role: 'admin', email: 'evil@x.y' }))).toString('base64url') + '.' + parts[1];
  assert.equal((await s.get('/api/admin/b2b/accounts', bearer(forged))).status, 401);
  const bt = S.r1.Authorization.slice(7).split('.');
  const forgedB = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(bt[0], 'base64url').toString()), { aid: S.dist1, role: 'distributor', uid: 1 }))).toString('base64url') + '.' + bt[1];
  assert.equal((await s.get('/api/b2b/me', bearer(forgedB))).status, 401);
});

test('suspending an account cuts access immediately; password change revokes old sessions', async () => {
  let r = await s.post('/api/admin/b2b/accounts/' + S.ret3 + '/status', { status: 'suspended', reason: 'Payment overdue' }, admin);
  assert.equal(r.status, 200);
  const blocked = await s.get('/api/b2b/products', S.r3);
  assert.equal(blocked.status, 403); assert.equal(blocked.data.accountStatus, 'suspended');
  assert.equal((await s.get('/api/b2b/me', S.r3)).data.statusReason, 'Payment overdue');
  await s.post('/api/admin/b2b/accounts/' + S.ret3 + '/status', { status: 'approved' }, admin);
  assert.equal((await s.get('/api/b2b/products', S.r3)).status, 200);

  r = await s.post('/api/b2b/me/password', { current_password: 'wrong', new_password: 'NewPassw0rd!' }, S.r3);
  assert.equal(r.status, 400);
  r = await s.post('/api/b2b/me/password', { current_password: 'Retail3r!x', new_password: 'NewPassw0rd!' }, S.r3);
  assert.equal(r.status, 200);
  assert.equal((await s.get('/api/b2b/me', S.r3)).status, 401, 'the old token no longer works');
  assert.equal((await s.get('/api/b2b/me', bearer(r.data.token))).status, 200);
  S.r3 = bearer(r.data.token);

  r = await s.post('/api/admin/b2b/accounts/' + S.ret3 + '/status', { status: 'blocked', reason: 'Fraud check' }, admin);
  assert.equal((await s.get('/api/b2b/me', S.r3)).status, 401, 'blocked accounts are signed out');
  assert.equal((await s.post('/api/b2b/auth/login', { identifier: 'ret3@example.com', password: 'NewPassw0rd!', role: 'retailer' })).status, 403);
  await s.post('/api/admin/b2b/accounts/' + S.ret3 + '/status', { status: 'approved' }, admin);
});

test('audit log records who did what, with old and new values, and cannot be altered', async () => {
  const all = await s.get('/api/admin/b2b/audit?limit=200', admin);
  const actions = new Set(all.data.items.map(a => a.action));
  ['distributor.approved', 'retailer.approved', 'mapping.changed', 'product.price_changed', 'pricing.bulk_margin_update', 'pricing.default_margin_changed', 'stock.damage',
    'invoice.created', 'invoice.cancelled', 'order.cancelled', 'order.distributor_changed', 'import.completed', 'import.rolled_back', 'credit.limit_changed',
    'credit.override_granted', 'payment.recorded', 'credit_note.created', 'retailer.suspended'].forEach(a => assert.ok(actions.has(a), 'audit has ' + a));
  const margin = (await s.get('/api/admin/b2b/audit?action=pricing.default_margin_changed', admin)).data.items.pop();
  assert.deepEqual(JSON.parse(margin.old_value), { 'pricing.default_retailer_margin': '18.000' });
  assert.deepEqual(JSON.parse(margin.new_value), { 'pricing.default_retailer_margin': '20' });
  assert.equal(margin.actor_label, 'admin@test.local'); assert.equal(margin.actor_role, 'admin'); assert.ok(margin.ip);
  const remap = (await s.get('/api/admin/b2b/audit?entity=retailer&entity_id=' + S.ret3 + '&action=mapping', admin)).data.items;
  assert.ok(remap.length >= 3);
  for (const m of ['del', 'put', 'patch']) assert.equal((await s[m]('/api/admin/b2b/audit' + (m === 'del' ? '' : '/1'), m === 'del' ? admin : {}, admin)).status, 404, 'no ' + m + ' route');
  assert.equal((await s.del('/api/admin/b2b/audit/1', admin)).status, 404);
});

test('notifications are queued with the transaction and delivered afterwards, with retries', async () => {
  const q = await s.get('/api/admin/b2b/notifications/queue?status=pending', admin);
  assert.ok(q.data.total > 20, 'order/approval events queued email + WhatsApp messages');
  const r = await s.post('/api/admin/b2b/notifications/retry', {}, admin);
  assert.ok(r.data.processed > 0, 'worker processes a batch');
  // No email or WhatsApp provider is configured in this test server: nothing may be reported as sent
  // (corrected in N1 — this test used to expect mocked messages to count as sent).
  const sent = await s.get('/api/admin/b2b/notifications/queue?status=sent', admin);
  assert.equal(sent.data.total, 0, 'nothing is "sent" when no provider received it');
  const notSent = await s.get('/api/admin/b2b/notifications/queue?status=not_sent', admin);
  assert.ok(notSent.data.total > 0);
  assert.ok(notSent.data.items.every(n => n.status === 'skipped_no_provider' && /not configured|not sent/i.test(n.last_error)));
  const one = await s.get('/api/admin/b2b/notifications/queue/' + notSent.data.items[0].id, admin);
  assert.deepEqual(one.data.history.map(h => h.status).slice(-2), ['sending', 'skipped_no_provider'], 'status history kept');
  const inbox = await s.get('/api/b2b/notifications', S.r1);
  assert.ok(inbox.data.items.some(n => /delivered/.test(n.title)));
  assert.ok((await s.get('/api/b2b/me', S.r1)).data.unreadNotifications > 0);
  await s.post('/api/b2b/notifications/read', {}, S.r1);
  assert.equal((await s.get('/api/b2b/me', S.r1)).data.unreadNotifications, 0);
});

test('print data for delivery labels and bills is scoped like everything else', async () => {
  const a = await s.get('/api/admin/b2b/print?ids=' + S.o1 + ',' + S.o3, admin);
  assert.equal(a.data.documents.length, 2);
  const doc = a.data.documents.find(d => d.order.id === S.o1);
  assert.equal(doc.order.ship_name, 'Lakshmi Medicals'); assert.equal(doc.order.ship_phone, '9845000011'); assert.equal(doc.order.ship_pincode, '560001');
  assert.equal(doc.seller.name, 'Bengaluru Trade Links'); assert.equal(doc.invoice.invoice_no, S.inv1No);
  assert.equal(doc.items.length, 2);
  assert.equal(JSON.stringify(doc).includes('base_price'), false);
  assert.equal((await s.get('/api/b2b/retailer-orders-print?ids=' + S.o1, S.d1)).data.documents.length, 1);
  assert.equal((await s.get('/api/b2b/retailer-orders-print?ids=' + S.o1, S.d2)).status, 404);
  assert.equal((await s.get('/api/b2b/retailer-orders-print?ids=' + S.o1 + ',' + S.o2, S.d2)).data.documents.length, 1, 'only the orders they supply');
  assert.equal((await s.get('/api/b2b/print?ids=' + S.o1, S.r1)).data.documents.length, 1);
});

test('portal and admin pages are served; unknown B2B pages 404', async () => {
  for (const p of ['/b2b', '/b2b/login', '/b2b/register', '/b2b/dashboard', '/b2b/products', '/b2b/cart', '/b2b/orders', '/b2b/orders/12', '/b2b/invoices', '/b2b/profile',
    '/b2b/distributor', '/b2b/quick-order', '/b2b/retailer-orders', '/b2b/app.css', '/b2b/app.js',
    '/admin/b2b/dashboard.html', '/admin/b2b/accounts.html', '/admin/b2b/orders.html', '/admin/b2b/catalogue.html', '/admin/b2b/pricing.html', '/admin/b2b/import.html',
    '/admin/b2b/network.html', '/admin/b2b/inventory.html', '/admin/b2b/finance.html', '/admin/b2b/reports.html', '/admin/b2b/settings.html',
    '/admin/print.html', '/admin/print.js', '/assets/vendor/qrcode.js']) {
    assert.equal((await s.get(p)).status, 200, p);
  }
  assert.equal((await s.get('/b2b/does-not-exist')).status, 404);
  assert.match((await s.get('/b2b/dashboard')).headers.get('x-robots-tag'), /noindex/);
});
