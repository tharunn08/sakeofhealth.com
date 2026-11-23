/**
 * B2B module entry point.
 *
 * Everything B2B hangs off this file, and it is only wired into the server
 * when B2B_ENABLED=true. With the flag off: no routes, no MySQL connection,
 * no background timers — the B2C site runs exactly as it did before.
 */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config.js');
const db = require('../../db/connection.js');
const { errorHandler } = require('./lib/http.js');
const rbac = require('./rbac.js');

const WEB = path.join(__dirname, '..', '..', '..', 'b2b-web');
const PORTAL_PAGES = ['dashboard', 'products', 'quick-order', 'cart', 'checkout', 'orders', 'invoices', 'payments', 'profile', 'distributor',
  'retailers', 'retailer-orders', 'stock', 'returns', 'favorites', 'notifications', 'receivables'];

/** Routes that must see the raw request body — registered BEFORE the JSON body parser. */
function mountEarly(app) {
  if (!config.enabled()) return;
  // Business platform (ERP) webhooks — inert unless ERP_ENABLED=true as well.
  require('../erp/index.js').mountEarly(app);
  app.post('/api/b2b/webhooks/razorpay', express.raw({ type: '*/*', limit: '256kb' }), function (req, res) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const given = Buffer.from(String(req.headers['x-razorpay-signature'] || ''));
    const expected = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
    if (!secret || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return res.status(400).json({ error: 'invalid signature' });
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'invalid payload' }); }
    const payment = event && event.payload && event.payload.payment && event.payload.payment.entity;
    if (!payment || ['payment.captured', 'order.paid'].indexOf(event.event) === -1) return res.json({ ok: true, ignored: true });
    require('./payments/service.js').gatewayConfirm({ trusted: true, gateway: 'razorpay', gatewayOrderId: payment.order_id, gatewayPaymentId: payment.id })
      .then(function (r) { res.json({ ok: true, duplicate: !!r.duplicate }); })
      .catch(function (e) {
        // Not one of ours (e.g. a storefront payment) → acknowledge so the gateway stops retrying.
        if (e && e.status === 404) return res.json({ ok: true, ignored: true });
        console.error('[B2B WEBHOOK]', e.code || e.message);
        res.status(500).json({ error: 'temporary failure' });   // gateway will retry
      });
  });
}

/**
 * Staff with a B2B-only role (finance, sales, inventory, …) may use the B2B
 * back office but not the B2C admin API. Existing roles are not affected.
 */
function b2bOnlyRoleGuard(req, res, next) {
  if (req.path === '/login' || req.path === '/me' || req.path.indexOf('/b2b') === 0) return next();
  const { verifyToken } = require('../../middleware/adminAuth.js');
  const auth = req.headers['authorization'] || '';
  const payload = verifyToken(auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || ''));
  if (payload && rbac.B2B_ONLY_ROLES.indexOf(payload.role) !== -1) {
    return res.status(403).json({ error: 'Forbidden — your role only has access to the B2B section' });
  }
  next();
}

function mount(app) {
  if (!config.enabled()) return false;
  // The B2B APIs have their own request budgets (a busy shop counter makes far more calls than a
  // shopper does). Login, registration and order placement have much tighter limits in routes/portal.js.
  const { rateLimit } = require('express-rate-limit');
  const perMinute = function (max) {
    return rateLimit({ windowMs: 60000, max: process.env.NODE_ENV === 'test' ? 1000000 : max, standardHeaders: true, legacyHeaders: false,
      message: { error: 'Too many requests. Please wait a moment and try again.' } });
  };
  const limits = { admin: perMinute(Number(process.env.B2B_ADMIN_RATE_PER_MIN || 600)), api: perMinute(Number(process.env.B2B_RATE_PER_MIN || 400)) };

  const adminApi = express.Router();
  adminApi.use(require('./routes/admin.js'));
  adminApi.use(function (req, res) { res.status(404).json({ error: 'Endpoint not found' }); });
  adminApi.use(errorHandler);
  app.use('/api/admin/b2b', limits.admin, adminApi);

  const portalApi = express.Router();
  // In production the portal refuses to issue or accept sessions until a real signing secret is set —
  // it must never fall back to a guessable default.
  portalApi.use(function (req, res, next) {
    if (process.env.NODE_ENV === 'production' && !config.hasStrongSecret()) {
      return res.status(503).json({ error: 'The business portal is not available yet. Please try again later.', code: 'NOT_CONFIGURED' });
    }
    next();
  });
  portalApi.use(require('./routes/portal.js'));
  portalApi.use(function (req, res) { res.status(404).json({ error: 'Endpoint not found' }); });
  portalApi.use(errorHandler);
  app.use('/api/b2b', limits.api, portalApi);

  // Business platform (ERP): /api/erp and /admin/erp — inert unless ERP_ENABLED=true as well.
  require('../erp/index.js').mount(app);

  // Static assets for the portal and the admin B2B pages. Nothing in this folder is private.
  const staticOpts = {
    etag: true, index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    setHeaders: function (res, filePath) {
      if (filePath.endsWith('.html')) { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.setHeader('X-Robots-Tag', 'noindex, nofollow'); }
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  };
  const page = function (file) {
    return function (req, res) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(WEB, file));
    };
  };
  app.use('/admin/b2b', express.static(path.join(WEB, 'admin'), staticOpts));
  app.get(['/b2b', '/b2b/', '/b2b/login'], page('portal/login.html'));
  app.get('/b2b/register', page('portal/register.html'));
  app.get(PORTAL_PAGES.map(function (p) { return '/b2b/' + p; }).concat(PORTAL_PAGES.map(function (p) { return '/b2b/' + p + '/:id'; })), page('portal/app.html'));
  app.use('/b2b', express.static(path.join(WEB, 'portal'), staticOpts));
  app.use('/b2b', function (req, res) { res.status(404).sendFile(path.join(WEB, 'portal', '404.html')); });
  return true;
}

/** Start-up work. Never throws and never blocks the server from listening. */
async function boot() {
  if (!config.enabled()) return { enabled: false };
  const out = { enabled: true, database: 'down', schema: 'unknown' };
  if (!db.isConfigured()) {
    console.warn('[B2B] B2B_ENABLED=true but the database is not configured (DB_HOST / DB_USER / DB_NAME). The business portal will answer 503 until it is.');
    return out;
  }
  if (process.env.NODE_ENV === 'production' && !config.hasStrongSecret()) {
    console.warn('[B2B] ⚠️  B2B_JWT_SECRET is missing, shorter than 48 characters, or the same as another secret. Business logins are DISABLED (503) until it is set to its own long random value.');
  }
  try {
    const migrate = require('../../db/migrate.js');
    const ping = await db.ping(0);
    if (!ping.ok) { console.warn('[B2B] Database not reachable (' + ping.error + '). The business portal will answer 503 until it is.'); return out; }
    out.database = 'up';
    if (config.autoMigrate()) {
      const r = await migrate.up(function (l) { console.log('[B2B MIGRATE] ' + l); });
      if (r.applied.length) console.log('[B2B] Applied ' + r.applied.length + ' database migration(s).');
    }
    const check = await migrate.verify();
    out.schema = check.ok ? 'ok' : 'incomplete';
    if (!check.ok) {
      console.warn('[B2B] ⚠️  Database schema is not complete (' + (check.missing.length ? 'missing: ' + check.missing.slice(0, 5).join(', ') : check.pending + ' migration(s) pending') +
        '). Run "npm run migrate" or use Admin → B2B → Settings → System.');
      return out;
    }
    await require('./imports/service.js').recoverInterrupted();
    // JOBS_MODE=cron (production): no sender timer — scripts/cron/run-jobs.js sends, and new messages are sent on commit.
    if (require('../../platform/jobs-config.js').mode() === 'inprocess') require('./notifications/service.js').startWorker();
    console.log('[B2B] Business portal ready — database connected, schema verified.');
    await require('../erp/index.js').boot();
  } catch (e) {
    console.warn('[B2B] start-up check failed: ' + (e.code || e.message));
  }
  return out;
}

async function health() {
  if (!config.enabled()) return { enabled: false, database: 'disabled' };
  const ping = await db.ping();
  return { enabled: true, database: ping.ok ? 'up' : 'down' };
}

module.exports = { mountEarly, mount, boot, health, b2bOnlyRoleGuard, enabled: config.enabled };
