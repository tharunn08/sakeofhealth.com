/**
 * The shop stock front layer (3b.3 / 3b.4): two Express handlers registered by the business
 * platform BEFORE the shop's own (protected) routers, so no storefront file changes.
 *
 *   POST /api/checkout/order  (Pay)       hold the cart's units; in enforce mode refuse with the
 *                                         shop's own words when short, or "temporarily
 *                                         unavailable" when MySQL cannot answer — before any
 *                                         gateway order exists, so nothing is charged.
 *   POST /api/shop/orders     (after pay) commit the held units before the shop creates the
 *                                         order; paid but short → no order, a refund exception.
 *
 * Both call next() so the shop's handler runs exactly as before; response bodies are passed
 * through untouched. In mode 'off' (the default) they do nothing at all. Shadow mode never
 * refuses: it only records what enforcement would have done.
 */
'use strict';
const { rateLimit } = require('express-rate-limit');
const svc = require('./service.js');

// This layer runs before the shop's own rate limiter, so it has its own: holds tie up stock,
// and a flood of Pay requests must not be able to hold everything.
const payLimit = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a minute and try again.' } });

// The mode is read from MySQL (a business decision) and cached for 10 s. When MySQL cannot be
// read, what happens depends on the last mode this process read successfully:
//   enforce        → 'unknown': Pay is refused as "temporarily unavailable" (fail closed, no charge);
//   off / shadow / never read → off: the shop works exactly as today (shadow refuses nothing anyway).
// A process that starts while MySQL is down therefore cannot know enforcement was on; it is read
// at start-up (warm()) and on every Pay, and the shop's own stock check still applies meanwhile.
let cached = null, lastKnown = null;
async function cfg() {
  if (cached && cached.until > Date.now()) return cached.value;
  let value;
  try { value = await svc.config(); lastKnown = value.mode; }
  catch (e) {
    console.error('[SHOP-STOCK] mode could not be read:', e.code || e.message, '| last known:', lastKnown || 'never read');
    value = lastKnown === 'enforce' ? { mode: 'unknown', error: e } : { mode: 'off', degraded: true };
  }
  cached = { value: value, until: Date.now() + 10000 };
  return value;
}
function warm() { cached = null; return cfg().catch(function () {}); }
/** Forget the cached mode (tests: also forget the last known mode). */
function reset(all) { cached = null; if (all) lastKnown = null; }
const UNAVAILABLE = 'Online payment is temporarily unavailable. Please try again later.';

/** After the shop's handler answers: run fn(status, body) without changing the answer. */
function after(res, fn) {
  const json = res.json.bind(res);
  res.json = function (body) {
    try { fn(res.statusCode, body); } catch (e) { console.error('[SHOP-STOCK] after-hook:', e.message); }
    return json(body);
  };
}

async function onPay(req, res, next) {
  const c = await cfg();
  if (c.mode === 'off') return next();
  if (c.mode === 'unknown') {
    // MySQL did not answer when reading the mode: fail closed before payment (decision 2)
    console.error('[SHOP-STOCK] mode unknown at Pay:', c.error && (c.error.code || c.error.message));
    return res.status(503).json({ error: UNAVAILABLE });
  }
  const items = req.body && req.body.items;
  if (!Array.isArray(items) || !items.length) return next();   // the shop answers "Your cart is empty"
  const k = req.headers['idempotency-key'] ? 'idem:' + String(req.headers['idempotency-key']).slice(0, 70) : svc.newRef();
  let r;
  try { r = await svc.hold(k, items, c); }
  catch (e) {
    console.error('[SHOP-STOCK] hold failed:', e.code || e.message);
    if (c.mode === 'enforce') return res.status(503).json({ error: UNAVAILABLE });
    return next();
  }
  if (!r.ok) return res.status(409).json({ error: r.message });   // the shop's own "Only N of … left" / "… is out of stock."
  after(res, function (status, body) {
    const p = status === 200 && body && body.id ? svc.bind(k, body.id, c) : svc.release(k, c);
    p.catch(function (e) { console.error('[SHOP-STOCK] bind/release:', e.code || e.message); });
  });
  next();
}

async function onPlace(req, res, next) {
  const c = await cfg();
  if (c.mode !== 'enforce') return next();   // shadow: the catch-up job replays it; off: nothing
  const pay = req.body && req.body.payment;
  if (!pay || !pay.gatewayOrderId) return next();   // test (mock) payments: the catch-up job handles them
  let r;
  try { r = await svc.commitAtPlace(c, String(pay.gatewayOrderId).slice(0, 60), pay.paymentId ? String(pay.paymentId).slice(0, 60) : null); }
  catch (e) {
    // The customer has paid: never block the order on a database error. The catch-up job
    // commits it (or records the shortage and refunds) once MySQL answers again.
    console.error('[SHOP-STOCK] commit at order failed, the catch-up job will retry:', e.code || e.message);
    return next();
  }
  if (r && r.short && r.short.length) {
    return res.status(409).json({ error: 'Sorry — this item sold out while you were paying. Your payment will be refunded in full; we have recorded it and you do not need to do anything.' });
  }
  next();
}

function mount(app) {
  app.post('/api/checkout/order', function (req, res, next) {
    cfg().then(function (c) { if (c.mode === 'off') return next(); payLimit(req, res, function () { onPay(req, res, next).catch(next); }); }).catch(next);
  });
  app.post('/api/shop/orders', function (req, res, next) { onPlace(req, res, next).catch(next); });
  // learn the mode at start-up, so a later MySQL outage after "enforce" fails closed
  if (process.env.NODE_ENV !== 'test') { const t = setTimeout(warm, 3000); if (t.unref) t.unref(); }
}

module.exports = { mount, onPay, onPlace, reset, warm, UNAVAILABLE };
