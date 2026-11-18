/**
 * Razorpay webhook for storefront payments (Phase 0.5.5).
 *   POST /api/shop/webhooks/razorpay   (raw body — mounted before the JSON parser)
 *
 * - Signature: HMAC-SHA256(raw body, RAZORPAY_WEBHOOK_SECRET); refused if absent or wrong.
 * - Replays: an X-Razorpay-Event-Id seen before is acknowledged and skipped.
 * - payment.captured / payment.authorized / order.paid for a checkout this
 *   server started: the order is created if the browser callback never
 *   arrived. A payment that does not pay exactly that checkout creates nothing.
 * - Anything else (not ours, other events) is acknowledged so Razorpay stops retrying.
 *   An internal error answers 500 so Razorpay retries later.
 */
const express = require('express');
const payments = require('../services/payments.js');
const pending = require('../services/pendingCheckouts.js');
const checkoutFlow = require('../services/checkoutFlow.js');

const HANDLED = ['payment.captured', 'payment.authorized', 'order.paid'];

async function handler(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!payments.verifyWebhookSignature(raw, req.headers['x-razorpay-signature'])) {
    return res.status(400).json({ error: 'invalid signature' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'invalid payload' }); }

  const eventId = String(req.headers['x-razorpay-event-id'] || '');
  if (eventId && pending.seenEvent(eventId)) return res.json({ ok: true, duplicate: true });

  const payment = event && event.payload && event.payload.payment && event.payload.payment.entity;
  if (!payment || HANDLED.indexOf(event.event) === -1 || !payment.order_id || !pending.get(payment.order_id)) {
    pending.markEvent(eventId);
    return res.json({ ok: true, ignored: true });
  }

  try {
    const r = await checkoutFlow.complete({ gatewayOrderId: payment.order_id, payment, source: 'webhook' });
    pending.markEvent(eventId);
    if (r.status >= 400) console.warn('[SHOP WEBHOOK] ' + payment.order_id + ': ' + (r.body && r.body.error));
    return res.json({ ok: true, created: !!r.created, orderId: r.body && r.body.orderId || null });
  } catch (e) {
    console.error('[SHOP WEBHOOK] error for ' + payment.order_id + ':', e.message);
    return res.status(500).json({ error: 'temporary error' });
  }
}

function mount(app) {
  app.post('/api/shop/webhooks/razorpay', express.raw({ type: '*/*', limit: '256kb' }), function (req, res, next) {
    handler(req, res).catch(next);
  });
}

module.exports = { mount, handler };
