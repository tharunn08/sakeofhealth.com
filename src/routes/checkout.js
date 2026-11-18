const { Router } = require('express');
const { randomUUID } = require('crypto');
const { idempotency } = require('../middleware/idempotency.js');
const payments = require('../services/payments.js');
const checkoutFlow = require('../services/checkoutFlow.js');
const pending = require('../services/pendingCheckouts.js');

const router = Router();

/**
 * Start a payment. The body is the cart and contact details — NOT an amount.
 * The server prices the cart and creates the Razorpay order for that total
 * (Phase 0.5.4; BUG-002). Any "amount" in the body is ignored.
 */
router.post('/order', idempotency, async function (req, res, next) {
  try {
    const idempotencyKey = String(req.headers['idempotency-key'] || randomUUID()).slice(0, 80);
    const r = await checkoutFlow.start(req.body || {}, idempotencyKey);
    res.status(r.status).json(r.body);
  } catch (e) {
    if (e instanceof payments.GatewayError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/** Signature check for a checkout this server started (kept for compatibility). */
router.post('/verify', async function (req, res, next) {
  try {
    const m = payments.mode();
    if (m === 'unavailable') return res.status(503).json({ error: 'Online payment is temporarily unavailable.' });
    if (m === 'mock') return res.json({ verified: true, mock: true });
    const { orderId, paymentId, signature } = req.body || {};
    if (!pending.get(orderId)) return res.status(400).json({ error: 'unknown checkout' });
    if (!payments.verifyCheckoutSignature(orderId, paymentId, signature)) return res.status(400).json({ error: 'signature mismatch' });
    res.json({ verified: true });
  } catch (e) { next(e); }
});

module.exports = router;
