/**
 * Business platform (ERP) entry point.
 *
 * Mounted ONLY from the existing B2B module hooks (src/modules/b2b/index.js), so
 * src/server.js and every other customer-site file stay unchanged. Inert unless
 * B2B_ENABLED=true AND ERP_ENABLED=true: no routes, no timers, no database calls.
 */
'use strict';
const path = require('path');
const express = require('express');
const config = require('./config.js');
const db = require('../../db/connection.js');
const { errorHandler } = require('./lib/http.js');

const WEB = path.join(__dirname, '..', '..', '..', 'erp-web');
let timers = [];

/** Routes that need the raw request body (webhooks) — before the JSON parser. */
function mountEarly(app) {
  if (!config.enabled()) return false;
  require('./core/webhooks.js').mount(app);
  return true;
}

function mount(app) {
  if (!config.enabled()) return false;
  // Online-shop stock (3b.3/3b.4): handlers that run before the shop's own checkout routes and
  // then hand over to them unchanged. They do nothing while inventory.b2c_stock_mode is off.
  require('./shopstock/front.js').mount(app);
  // Delivery (020): shipments follow every order status change and appear in the order view.
  require('./delivery/service.js').attach();
  const api = express.Router();
  api.use(function (req, res, next) {
    if (process.env.NODE_ENV === 'production' && !config.hasStrongSecret()) {
      return res.status(503).json({ error: 'The business platform is not configured yet.', code: 'NOT_CONFIGURED' });
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use('/core', require('./routes/core.js'));
  api.use('/catalog', require('./routes/catalog.js'));
  api.use('/procurement', require('./routes/procurement.js'));
  api.use('/inventory', require('./routes/inventory.js'));
  api.use('/notifications', require('./routes/notifications.js'));
  api.use('/public', require('./routes/public-notifications.js'));   // unsubscribe link (no sign-in; signed token)
  api.use('/public', require('./routes/public-invoice.js'));         // counter invoice for the customer (signed link)
  api.use('/shop-stock', require('./routes/shop-stock.js'));
  api.use('/events', require('./routes/events.js'));
  api.use('/locations', require('./routes/locations.js'));
  api.use('/offline', require('./routes/offline.js'));
  api.use('/customers', require('./routes/customers.js'));
  api.use('/manufacturing', require('./routes/manufacturing.js'));
  api.use('/deliveries', require('./routes/deliveries.js'));
  api.use('/network', require('./routes/network.js'));
  api.use('/insights', require('./routes/insights.js'));   // Smart Insights (read only)
  api.use('/sales', require('./routes/sales.js').office);
  api.use('/sales', require('./routes/sales.js').desk);
  api.use('/', require('./routes/returns-finance.js'));   // /returns, /recalls, /finance
  api.use('/', require('./routes/vendors.js'));   // /vendors, /vendor-products, /vendor-prices — keep last
  api.use(function (req, res) { res.status(404).json({ error: 'Endpoint not found' }); });
  api.use(errorHandler);
  app.use('/api/erp', api);

  // Vendor portal API: its own token audience, its own router, same error rules.
  const vendorApi = express.Router();
  vendorApi.use(function (req, res, next) {
    if (process.env.NODE_ENV === 'production' && !config.hasStrongSecret()) return res.status(503).json({ error: 'The vendor portal is not configured yet.', code: 'NOT_CONFIGURED' });
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  vendorApi.use(require('./routes/vendor-portal.js'));
  vendorApi.use(function (req, res) { res.status(404).json({ error: 'Endpoint not found' }); });
  vendorApi.use(errorHandler);
  app.use('/api/vendor', vendorApi);

  // Salesman app API (ERP staff tokens).
  const salesApi = express.Router();
  salesApi.use(function (req, res, next) {
    if (process.env.NODE_ENV === 'production' && !config.hasStrongSecret()) return res.status(503).json({ error: 'Not configured yet.', code: 'NOT_CONFIGURED' });
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  salesApi.use(require('./routes/sales.js').app);
  salesApi.use(function (req, res) { res.status(404).json({ error: 'Endpoint not found' }); });
  salesApi.use(errorHandler);
  app.use('/api/sales', salesApi);

  const noindex = function (res) { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); res.setHeader('X-Content-Type-Options', 'nosniff'); };
  app.get(['/admin/erp', '/admin/erp/'], function (req, res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); noindex(res);
    res.sendFile(path.join(WEB, 'admin', 'index.html'));
  });
  app.use('/admin/erp', express.static(path.join(WEB, 'admin'), { index: false, etag: true, setHeaders: noindex }));
  // Vendor portal and field-sales app (static pages; every API call is checked on the server).
  [['/vendor-portal', 'vendor'], ['/sales-app', 'sales']].forEach(function (m) {
    app.get([m[0], m[0] + '/'], function (req, res) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); noindex(res);
      res.sendFile(path.join(WEB, m[1], 'index.html'));
    });
    app.use(m[0], express.static(path.join(WEB, m[1]), { index: false, etag: true, setHeaders: noindex }));
  });
  return true;
}

/**
 * Every background job handler, registered once (the web process and scripts/cron/run-jobs.js use the
 * same handlers). Their schedule is in core/schedule.js; handlers are idempotent.
 */
let registered = false;
function registerHandlers() {
  if (registered) return;
  registered = true;
  const jobs = require('./core/jobs.js');
  const audit = require('./core/audit.js');
  const monitor = require('./core/monitor.js');
  jobs.register('audit.verify', async function () {
    const r = await audit.verifyChain();
    if (!r.ok) await monitor.event('staff', 'critical', 'audit_chain_broken', 'Audit chain broken at row ' + r.brokenAt + ': ' + r.reason);
    return r;
  });
  jobs.register('sales.expire_holds', function () { return require('./sales/service.js').expireHolds(); });
  jobs.register('inventory.reconcile', async function () {
    const r = await require('./inventory/service.js').reconciliation({ scopes: { warehouse: 'all' } }, {});
    if (!r.ok) await monitor.event('inventory', 'warning', 'inventory_mismatch', r.issues.length + ' stock balance(s) differ from the ledger or batches');
    return { checked: r.checked, issues: r.issues.length };
  });
  // N5: one stock alert a day to the administrators' alert emails (read-only; never changes stock)
  jobs.register('notifications.stock_alerts', async function () {
    const r = await require('./procurement/service.js').reorderSuggestions({});
    if (!r.items.length) return { below: 0 };
    const day = new Date().toISOString().slice(0, 10);
    await require('../b2b/notifications/service.js').notifyAdmins(null, { event: 'inventory.stock_alert', title: r.items.length + ' product(s) below reorder level',
      lines: r.items.slice(0, 15).map(function (x) { return x.sku + ' ' + x.name + ' (warehouse ' + x.warehouse_id + '): ' + x.position + ' available against a minimum of ' + x.min_qty + '; suggest ' + x.suggestedQty; })
        .concat(r.items.length > 15 ? ['…and ' + (r.items.length - 15) + ' more under Purchasing → Reorder suggestions.'] : []),
      link: '/admin/procurement/purchasing', refType: 'stock_alert', refId: day });
    return { below: r.items.length };
  });
  // 3b.3/3b.4: the shop stock catch-up (commits webhook and admin orders, status changes, expired holds, shadow replay)
  jobs.register('shopstock.sync', function () { return require('./shopstock/service.js').sync(); });
  // expired batches leave 'available' once a day (ledger rows, keyed; nothing created or destroyed)
  jobs.register('inventory.expire_batches', function () { return require('./inventory/fefo.js').expireBatches(db, require('./inventory/ledger.js')); });
  jobs.register('shopstock.auto_refunds', function () { return require('./shopstock/service.js').autoRefunds(); });
  // N4: link the shop's customers and the business accounts once a day when switched on
  jobs.register('customers.import', async function () {
    if ((await require('./core/settings.js').get('customers.import.enabled')) !== true) return { skipped: 'import off' };
    return require('./customers/service.js').importAll();
  });
  jobs.register('b2c.feed', async function () {
    if ((await require('./core/settings.js').get('b2c.feed.enabled')) !== true) return { skipped: 'feed off' };
    return require('./b2cfeed/readonly-adapter.js').run();
  });
  jobs.register('catalog.publish_due', function () { return require('./catalog/service.js').publishDue(); });
  // 020: shipments catch up with orders moved elsewhere; late shipments and late manufacturer deliveries are alerted once
  jobs.register('deliveries.sync', function () { return require('./delivery/service.js').syncFromOrders(); });
  jobs.register('deliveries.alert_late', async function () {
    const a = await require('./delivery/service.js').alertLate();
    const b2 = await require('./manufacturing/service.js').alertLateAsns();
    return { shipments: a, manufacturerDeliveries: b2 };
  });
  jobs.register('jobs.cleanup', function () { return jobs.cleanup(); });
}

/** true when migration 004 (b2b_jobs and the governance tables) is applied. */
async function schemaReady() {
  const t = await db.queryOne("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('b2b_staff','b2b_roles','b2b_approval_requests','b2b_jobs','b2b_webhook_events')");
  return Number(t.n) >= 5;
}

/**
 * Timers inside the web process. JOBS_MODE=inprocess: the scheduler (every minute) and the job worker.
 * Both modes: the shop stock mode is re-read every minute — a per-process cache (fail-closed rule in
 * shopstock/front.js), not background work. Returns the names of what was started.
 */
function startTimers(mode) {
  const started = [];
  const every = function (name, ms, fn) { const t = setInterval(fn, ms); if (t.unref) t.unref(); timers.push(t); started.push(name); };
  if (mode === 'inprocess') {
    const schedule = require('./core/schedule.js');
    const tick = function () { schedule.enqueueDue().catch(function (e) { console.warn('[ERP JOBS] schedule:', e.code || e.message); }); };
    tick();
    every('schedule', 60 * 1000, tick);
    require('./core/jobs.js').start();
    started.push('jobs.worker');
  }
  every('shopstock.warm', 60 * 1000, function () { require('./shopstock/front.js').warm(); });
  return started;
}

/** Start-up work. Never throws, never blocks the server from listening. */
async function boot() {
  if (!config.enabled()) return { enabled: false };
  if (process.env.NODE_ENV === 'production' && !config.hasStrongSecret()) {
    console.warn('[ERP] ERP_JWT_SECRET is missing, shorter than 48 characters, or the same as another secret — the business platform answers 503 until it is set to its own long random value.');
  }
  try {
    if (!(await schemaReady())) { console.warn('[ERP] Migration 004 is not applied — run "npm run migrate". The business platform will answer 503 until then.'); return { enabled: true, schema: 'missing' }; }
    registerHandlers();
    const mode = require('../../platform/jobs-config.js').mode();
    startTimers(mode);
    console.log('[ERP] Business platform ready' + (mode === 'cron' ? ' — background jobs run from Hostinger Cron Jobs (scripts/cron/run-jobs.js).' : '.'));
    return { enabled: true, schema: 'ok', jobsMode: mode };
  } catch (e) {
    console.warn('[ERP] start-up check failed: ' + (e.code || e.message));
    return { enabled: true, schema: 'unknown' };
  }
}

function stop() { timers.forEach(clearInterval); timers = []; require('./core/jobs.js').stop(); }

module.exports = { mountEarly, mount, boot, stop, registerHandlers, schemaReady, startTimers, enabled: config.enabled };
