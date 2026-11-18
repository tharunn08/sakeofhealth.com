require('dotenv').config();
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const trackRouter = require('./routes/track.js');
const checkoutRouter = require('./routes/checkout.js');
const blogRouter = require('./routes/blog.js');
const adminRouter = require('./routes/admin.js');
const shopRouter = require('./routes/shop.js');
const authRouter = require('./routes/auth.js');
const { db } = require('./services/db.js');
// B2B platform (retailers / distributors). Fully inert unless B2B_ENABLED=true.
const b2b = require('./modules/b2b/index.js');

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const FRONTEND = path.join(__dirname, '../frontend');

const app = express();

/* ── Security & compression ── */
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "checkout.razorpay.com",
                    "api.fontshare.com", "unpkg.com", "maps.googleapis.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", "api.fontshare.com", "fonts.googleapis.com", "unpkg.com"],
      fontSrc:     ["'self'", "api.fontshare.com", "fonts.gstatic.com", "data:"],
      imgSrc:      ["'self'", "data:", "blob:", "upload.wikimedia.org",
                    "*.tile.openstreetmap.org", "*.basemaps.cartocdn.com",
                    "unpkg.com", "maps.googleapis.com", "maps.gstatic.com", "*.googleapis.com"],
      connectSrc:  ["'self'", "nominatim.openstreetmap.org", "maps.googleapis.com"],
      frameSrc:    ["'self'", "checkout.razorpay.com", "api.razorpay.com",
                    "www.google.com", "maps.google.com", "www.openstreetmap.org", "openstreetmap.org"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));
app.set('trust proxy', 1);

/* ── B2B: routes that need the raw request body (payment webhook) ── */
b2b.mountEarly(app);
/* ── Storefront Razorpay webhook (raw body; Phase 0.5.5) ── */
require('./routes/shopWebhook.js').mount(app);

/* ── Body parsing ── */
// Review submissions may carry a photo (base64), so they get a larger limit.
app.use('/api/shop/reviews', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

/* ── Rate limits ── */
const apiLimit      = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const checkoutLimit = rateLimit({ windowMs: 60_000, max: 20,  standardHeaders: true, legacyHeaders: false });
const trackLimit    = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const blogLimit     = rateLimit({ windowMs: 60_000, max: 10,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many submissions — try again in a minute' } });
const adminLimit    = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
const loginLimit    = rateLimit({
  windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
});
const orderLimit    = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many orders placed. Please wait a moment.' } });
const authLimit     = rateLimit({
  windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

/* ── Health check ── */
// Public liveness check: status only — no counts or configuration (Phase 0.5.8, BUG-018).
app.get('/health', function (req, res) {
  res.json({ ok: true });
});

/* ── Health check for deployments / uptime monitors (no secrets, no counts) ── */
app.get('/api/health', function (req, res) {
  b2b.health().then(function (h) {
    res.json({
      ok: true,
      service: 'sake-of-health',
      version: require('../package.json').version,
      env: isProd ? 'production' : (process.env.NODE_ENV || 'development'),
      b2b: h,
      ts: Date.now(),
    });
  }).catch(function () {
    res.json({ ok: true, service: 'sake-of-health', b2b: { enabled: b2b.enabled(), database: 'down' }, ts: Date.now() });
  });
});

/* ── Staff with a temporary password must change it first (shop + trade admin APIs) ── */
app.use('/api/admin', require('./platform/guards.js').staffMustChangePassword);

/* ── B2B portal + B2B admin API (only when B2B_ENABLED=true) ── */
b2b.mount(app);

/* ── API routes ── */
app.use('/api/admin/login', loginLimit);
/* ── Central Admin Panel: one sign-in (/login), one shell and sidebar for /admin ── */
app.use('/api/platform/auth/login', loginLimit);
app.use('/api/platform/auth/change-password', loginLimit);
require('./platform/routes.js').mount(app, { b2bEnabled: b2b.enabled });
// Staff whose role is B2B-only (finance, sales, inventory …) cannot call the B2C admin API.
app.use('/api/admin', b2b.b2bOnlyRoleGuard);
app.use('/api/admin',    adminLimit,    adminRouter);
app.use('/api/auth/signup', authLimit);
app.use('/api/auth/login',  authLimit);
app.use('/api/auth',     authRouter);
app.use('/api/shop/orders', orderLimit);
app.use('/api/shop',     apiLimit,      shopRouter);
app.use('/api/track',    trackLimit,    trackRouter);
app.use('/api/checkout', checkoutLimit, checkoutRouter);
app.use('/api/blog',     blogLimit,     blogRouter);

/* ── Runtime config for the frontend ── */
app.get('/config.js', function (req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  var settings = {};
  try {
    var storeRow = db.settings.findOne({ key: 'store' });
    settings = (storeRow && storeRow.value) || {};
  } catch (e) { settings = {}; }
  res.send('window.SOH_CONFIG=' + JSON.stringify({
    brand: process.env.BRAND_NAME || 'Sake of Health',
    currency: 'INR',
    mapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
    razorpayKey: process.env.PAYMENT_MOCK === 'true' ? '' : (process.env.RAZORPAY_KEY_ID || ''),
    paymentMock: process.env.PAYMENT_MOCK === 'true',
    freeShippingAbove: Number(process.env.FREE_SHIPPING_ABOVE || 499),
    shippingFee: Number(process.env.SHIPPING_FEE || 49),
    codEnabled: false, // Cash on delivery is disabled — payment is required before delivery.
    couponDisplay: settings.couponDisplay || 'off', // 'off' | 'homepage' | 'products'
    supportPhone: process.env.SUPPORT_PHONE || '',
    supportEmail: process.env.SUPPORT_EMAIL || '',
    b2bEnabled: b2b.enabled(),
  }) + ';');
});

/* ── Published blog articles live in DATA_DIR (Phase 0.5.10) ── */
app.get('/blog/:file', blogRouter.serveArticle);

/* ── Static frontend ── */
app.use(express.static(FRONTEND, {
  maxAge: isProd ? '7d' : 0,
  etag: true,
  index: 'index.html',
  setHeaders: function (res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (/\.(png|jpg|jpeg|webp|svg)$/.test(filePath)) {
      res.setHeader('Cache-Control', isProd ? 'public, max-age=2592000' : 'no-cache');
    }
  },
}));

/* ── Unknown API routes should 404 as JSON, not HTML ── */
app.use('/api', function (req, res) {
  res.status(404).json({ error: 'Endpoint not found' });
});

/* ── SPA fallback ── */
/* Unknown paths still show the storefront home page (existing behaviour), but:
   - a missing file such as /x/style.css or /img.png answers 404 instead of the
     home page's HTML (browsers refused that HTML as a script/stylesheet);
   - the home page is sent with <base href="/"> so its relative links, styles
     and images still load when the address is something like /old/page. */
let fallbackHtml = null;
app.get('*', function (req, res) {
  const ext = path.extname(req.path).toLowerCase();
  if (ext && ext !== '.html' && ext !== '.htm') return res.status(404).type('text/plain').send('Not found');
  try {
    if (fallbackHtml === null || process.env.NODE_ENV !== 'production') {
      fallbackHtml = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8').replace(/<head>/i, '<head>\n<base href="/"/>');
    }
    res.type('html').send(fallbackHtml);
  } catch (e) {
    res.sendFile(path.join(FRONTEND, 'index.html'));
  }
});

/* ── Error handler ── */
app.use(function (err, req, res, _next) {
  if (isProd) console.error('[ERROR] ' + req.method + ' ' + req.path, err.message);
  else console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

/* ── Boot ── */
if (isProd) {
  // Accounts the old seed created have passwords published in the source code.
  // They are reported (never changed or locked, so nobody is shut out) — Phase 0.5.8, BUG-008.
  try {
    const seeded = db.staff.all().filter(st => st.createdBy === 'seed' && st.active !== false && !st.passwordChangedAt);
    if (seeded.length) {
      console.error('\n✗ [SECURITY] ' + seeded.length + ' active staff account(s) were created by the demo seed and still exist: ' +
        seeded.map(st => st.email).join(', ') + '.');
      console.error('✗ [SECURITY] Their original passwords are published in the source code. In Admin → Staff, give each');
      console.error('✗ [SECURITY] a new password or deactivate it. This message stops once each one is done.\n');
    }
  } catch (e) { /* never block start-up on this check */ }
}

if (db.products.count() === 0 && isProd) {
  // Never refill a live shop with demo data or demo staff (Phase 0.5.8, BUG-008).
  console.error('\n✗ [SEED] Products collection is empty — not seeding in production.');
  console.error('✗ [SEED] If the shop had products, orders or staff, the data directory is');
  console.error('✗ [SEED] wrong or was wiped: check the "[DB] Using data directory" line and');
  console.error('✗ [SEED] restore from your latest backup. Add products in Admin → Products.\n');
} else if (db.products.count() === 0 && String(process.env.AUTO_SEED || 'true') === 'true') {
  console.warn('\n⚠️  [SEED] Products collection is empty — auto-seeding demo data now.');
  console.warn('⚠️  [SEED] If you previously created real staff, products, or orders and');
  console.warn('⚠️  [SEED] they are missing, your data directory was wiped — most likely');
  console.warn('⚠️  [SEED] because a redeploy replaced the folder it was stored in. Check');
  console.warn('⚠️  [SEED] the "[DB] Using data directory" line above/below this message.\n');
  try {
    const { seed } = require('./seed.js');
    seed();
    console.log('✓ Database auto-seeded with demo catalogue and orders');
  } catch (e) {
    console.warn('[SEED] skipped:', e.message);
  }
}

const server = app.listen(PORT, '0.0.0.0', function () {
  console.log('\n  ' + (process.env.BRAND_NAME || 'Sake of Health'));
  console.log('  Server:     http://localhost:' + PORT);
  console.log('  Admin:      http://localhost:' + PORT + '/admin/');
  console.log('  Track:      http://localhost:' + PORT + '/track.html');
  console.log('  Payments:   ' + (process.env.PAYMENT_MOCK === 'true' ? 'TEST MODE (mock)' : 'LIVE'));
  console.log('  Orders in DB: ' + db.orders.count() + '\n');
  if (b2b.enabled()) {
    console.log('  B2B portal: http://localhost:' + PORT + '/b2b\n');
    b2b.boot().catch(function (e) { console.warn('[B2B] boot:', e.message); });
  }
});
server.on('error', function (err) {
  console.log('[LISTEN ERROR] ' + err.message + ' ' + err.code);
  process.exit(1);
});

module.exports = app;
