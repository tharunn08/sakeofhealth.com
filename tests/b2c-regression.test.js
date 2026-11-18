/**
 * B2C + existing-admin regression suite.
 *
 * These tests describe how the production customer website behaved BEFORE the
 * B2B platform was added. They are run with B2B_ENABLED=false (the default)
 * and must keep passing unchanged — if one fails, the B2B work has altered
 * the protected B2C system.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, bearer } = require('./helpers/server.js');

let s, adminToken, customerToken, product, order;

test.before(async () => { s = await startServer({ B2B_ENABLED: 'false' }); });
test.after(async () => { await s.stop(); });

test('health endpoint (legacy /health) still answers', async () => {
  const r = await s.get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  // Phase 0.5.8 (BUG-018): /health no longer discloses counts; the seeded
  // catalogue is checked through the shop API instead.
  assert.equal((await s.get('/api/shop/products')).data.products.length, 5);
});

test('storefront pages are served', async () => {
  for (const p of ['/', '/index.html', '/track.html', '/account.html', '/checkout/', '/checkout/success.html',
    '/products/multivitamin.html', '/categories/iron.html', '/brand-story.html', '/terms.html',
    '/privacy-policy.html', '/refund-policy.html', '/blog/', '/admin/', '/admin/dashboard.html',
    '/admin/orders.html', '/assets/css/main.css', '/assets/js/app.js', '/config.js']) {
    const r = await s.get(p);
    assert.equal(r.status, 200, p + ' should be 200');
  }
});

test('config.js exposes the same storefront settings', async () => {
  const r = await s.get('/config.js');
  assert.match(r.data, /^window\.SOH_CONFIG=/);
  const cfg = JSON.parse(r.data.replace(/^window\.SOH_CONFIG=/, '').replace(/;$/, ''));
  assert.equal(cfg.currency, 'INR');
  assert.equal(cfg.paymentMock, true);
  assert.equal(cfg.shippingFee, 49);
  assert.equal(cfg.freeShippingAbove, 499);
  assert.equal(cfg.codEnabled, false);
});

test('products list and detail', async () => {
  const r = await s.get('/api/shop/products');
  assert.equal(r.status, 200);
  assert.equal(r.data.products.length, 5);
  product = r.data.products.find(p => p.slug === 'multivitamin');
  assert.equal(product.price, 599);
  assert.equal(product.mrp, 799);
  const d = await s.get('/api/shop/products/multivitamin');
  assert.equal(d.status, 200);
  assert.equal(d.data.product.name, 'Multivitamin Gummies');
  const missing = await s.get('/api/shop/products/nope');
  assert.equal(missing.status, 404);
});

test('customer signup, login, me', async () => {
  const su = await s.post('/api/auth/signup', { email: 'Buyer@Example.com', password: 'password123', name: 'Test Buyer' });
  assert.equal(su.status, 201);
  assert.ok(su.data.token);
  const dup = await s.post('/api/auth/signup', { email: 'buyer@example.com', password: 'password123' });
  assert.equal(dup.status, 400);
  const bad = await s.post('/api/auth/login', { email: 'buyer@example.com', password: 'wrong' });
  assert.equal(bad.status, 401);
  const li = await s.post('/api/auth/login', { email: 'buyer@example.com', password: 'password123' });
  assert.equal(li.status, 200);
  customerToken = li.data.token;
  const me = await s.get('/api/auth/me', bearer(customerToken));
  assert.equal(me.data.user.email, 'buyer@example.com');
  const anon = await s.get('/api/auth/me');
  assert.equal(anon.status, 401);
});

test('coupons: public list and validation', async () => {
  const list = await s.get('/api/shop/coupons');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.coupons));
  const ok = await s.post('/api/shop/coupons/validate', { code: 'welcome10', subtotal: 1198 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.discount, 120);
  const bad = await s.post('/api/shop/coupons/validate', { code: 'NOPE', subtotal: 1198 });
  assert.equal(bad.status, 400);
});

test('checkout: gateway order (mock) + verify', async () => {
  // Phase 0.5.4 (BUG-002): payment starts from the cart, priced by the server;
  // an amount-only request is refused. Mock mode remains for tests only.
  const cart = {
    items: [{ id: product.id, qty: 2 }],
    customer: { name: 'Test Buyer', email: 'buyer@example.com', phone: '+91 98765 43210' },
    address: { line1: 'MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
  };
  assert.equal((await s.post('/api/checkout/order', { amount: 1127 }, { 'Idempotency-Key': 'k-0' })).status, 400);
  const r = await s.post('/api/checkout/order', cart, { 'Idempotency-Key': 'k-1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.gateway, 'mock');
  assert.equal(r.data.amountPaise, Math.round(r.data.quote.total * 100));
  const again = await s.post('/api/checkout/order', cart, { 'Idempotency-Key': 'k-1' });
  assert.deepEqual(again.data, r.data);
  const v = await s.post('/api/checkout/verify', { orderId: 'x', paymentId: 'y', signature: 'z' });
  assert.equal(v.data.verified, true);
});

test('order placement re-prices server-side and ignores tampered prices', async () => {
  const body = {
    items: [{ id: product.id, name: 'hacked', price: 1, qty: 2 }],
    customer: { name: 'Test Buyer', email: 'buyer@example.com', phone: '+91 98765 43210' },
    address: { doorNo: '12A', line1: 'MG Road', line2: 'Indiranagar', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', landmark: 'Near Metro' },
    location: { lat: 12.9716, lng: 77.5946, source: 'gps' },
    couponCode: 'WELCOME10',
  };
  const r = await s.post('/api/shop/orders', body);
  assert.equal(r.status, 201);
  assert.equal(r.data.ok, true);
  assert.match(r.data.orderId, /^SOH-\d{8}-0001$/);
  // 2 × 599 = 1198; WELCOME10 → 10% = 119.8 capped rules → 120 (rounded); free shipping above 499
  assert.equal(r.data.total, 1198 - 120);
  order = r.data;

  const invalid = await s.post('/api/shop/orders', { items: [] });
  assert.equal(invalid.status, 400);
  const badPin = await s.post('/api/shop/orders', Object.assign({}, body, { address: Object.assign({}, body.address, { pincode: '12' }) }));
  assert.equal(badPin.status, 400);
});

test('order tracking needs order id AND phone', async () => {
  const ok = await s.post('/api/shop/track', { orderId: order.orderId, phone: '9876543210' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'pending');
  assert.equal(ok.data.items[0].qty, 2);
  const wrong = await s.post('/api/shop/track', { orderId: order.orderId, phone: '9999999999' });
  assert.equal(wrong.status, 404);
});

test('customer sees own order history', async () => {
  const r = await s.get('/api/auth/orders', bearer(customerToken));
  assert.equal(r.status, 200);
  assert.equal(r.data.orders.length, 1);
  assert.equal(r.data.orders[0].orderId, order.orderId);
});

test('reviews: submit (pending) and public list only shows approved', async () => {
  const r = await s.post('/api/shop/reviews', { rating: 5, name: 'Test Buyer', body: 'Really tasty and effective gummies.' });
  assert.equal(r.status, 201);
  const pub = await s.get('/api/shop/reviews');
  assert.equal(pub.data.reviews.length, 0);
});

test('admin: login and auth guard', async () => {
  const bad = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await s.post('/api/admin/login', { email: 'admin@test.local', password: 'Test@12345' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'admin');
  adminToken = ok.data.token;
  const unauth = await s.get('/api/admin/orders');
  assert.equal(unauth.status, 401);
  const me = await s.get('/api/admin/me', bearer(adminToken));
  assert.equal(me.data.user.email, 'admin@test.local');
});

test('admin: dashboard, orders list/detail, status pipeline', async () => {
  const h = bearer(adminToken);
  const dash = await s.get('/api/admin/dashboard', h);
  assert.equal(dash.status, 200);
  const list = await s.get('/api/admin/orders?search=' + encodeURIComponent(order.orderId), h);
  assert.equal(list.data.total, 1);
  const detail = await s.get('/api/admin/orders/' + order.id, h);
  assert.equal(detail.data.customer.phone, '9876543210');
  assert.equal(detail.data.address.doorNo, '12A');
  assert.equal(detail.data.payment.status, 'paid');
  for (const st of ['accepted', 'prepared', 'out_for_delivery']) {
    const u = await s.patch('/api/admin/orders/' + order.id + '/status', { status: st }, h);
    assert.equal(u.status, 200);
    assert.equal(u.data.status, st);
  }
  const bad = await s.patch('/api/admin/orders/' + order.id + '/status', { status: 'bogus' }, h);
  assert.equal(bad.status, 400);
  const note = await s.patch('/api/admin/orders/' + order.id, { notes: 'call before delivery' }, h);
  assert.equal(note.data.notes, 'call before delivery');
});

test('admin: deliveries board and customers', async () => {
  const h = bearer(adminToken);
  const d = await s.get('/api/admin/deliveries', h);
  assert.equal(d.status, 200);
  assert.equal(d.data.counts.out_for_delivery, 1);
  const c = await s.get('/api/admin/customers', h);
  assert.equal(c.data.total, 1);
  assert.equal(c.data.customers[0].orderCount, 1);
});

test('admin: products CRUD', async () => {
  const h = bearer(adminToken);
  const created = await s.post('/api/admin/products', { name: 'Test Gummy', price: 100, sku: 'T-1' }, h);
  assert.equal(created.status, 201);
  const upd = await s.patch('/api/admin/products/' + created.data.id, { price: 120 }, h);
  assert.equal(upd.data.price, 120);
  const shop = await s.get('/api/shop/products');
  assert.equal(shop.data.products.length, 6);
  const del = await s.del('/api/admin/products/' + created.data.id, h);
  assert.equal(del.data.ok, true);
});

test('admin: coupons, reviews, staff, analytics, settings, reports', async () => {
  const h = bearer(adminToken);
  assert.equal((await s.get('/api/admin/coupons', h)).data.coupons.length, 4);
  const rv = await s.get('/api/admin/reviews', h);
  assert.equal(rv.data.stats.pending, 1);
  const staff = await s.get('/api/admin/staff', h);
  assert.equal(staff.status, 200);
  const st = await s.post('/api/admin/staff', { name: 'Agent', email: 'agent@test.local', password: 'password123', role: 'delivery', phone: '9000000001' }, h);
  assert.equal(st.status, 201);
  assert.equal(st.data.role, 'delivery');
  assert.equal((await s.get('/api/admin/analytics?days=30', h)).status, 200);
  assert.equal((await s.get('/api/admin/settings', h)).status, 200);
  for (const t of ['orders', 'sales', 'deliveries', 'customers', 'products']) {
    const r = await s.get('/api/admin/reports/' + t + '.csv', h);
    assert.equal(r.status, 200, t);
    assert.match(r.headers.get('content-type'), /text\/csv/);
  }
});

test('staff role restrictions (delivery agent cannot manage staff; works from own delivery board)', async () => {
  const li = await s.post('/api/admin/login', { email: 'agent@test.local', password: 'password123' });
  assert.equal(li.status, 200);
  const r = await s.get('/api/admin/staff', bearer(li.data.token));
  assert.equal(r.status, 403);
  // Phase 0.5.2 (approved role matrix, BUG-005): a delivery agent no longer
  // lists every order; they use their own delivery board.
  const orders = await s.get('/api/admin/orders', bearer(li.data.token));
  assert.equal(orders.status, 403);
  const board = await s.get('/api/admin/deliveries', bearer(li.data.token));
  assert.equal(board.status, 200);
});

test('unknown API routes return JSON 404; unknown pages fall back to the storefront', async () => {
  const r = await s.get('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'Endpoint not found');
  const page = await s.get('/some/unknown/page');
  assert.equal(page.status, 200);
  assert.match(page.data, /Sake of Health/);
});

test('unknown pages keep their styling; missing files are not answered with HTML', async () => {
  const page = await s.get('/old/section/page');
  assert.equal(page.status, 200);
  assert.match(page.data, /<base href="\/"\/>/, 'relative styles and links resolve from the site root');
  const css = await s.get('/old/assets/css/main.css');
  assert.equal(css.status, 404);
  assert.doesNotMatch(String(css.data), /<html/i);
  const home = await s.get('/');
  assert.doesNotMatch(home.data, /<base href=/, 'the real home page is served unchanged');
});

test('mark delivered completes the order', async () => {
  const u = await s.patch('/api/admin/orders/' + order.id + '/status', { status: 'delivered' }, bearer(adminToken));
  assert.equal(u.data.status, 'delivered');
  assert.ok(u.data.deliveredAt);
});
