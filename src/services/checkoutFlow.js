/**
 * Storefront checkout flow (Phase 0.5.3–0.5.5).
 *
 *   start()     price the cart on the server, create the Razorpay order for
 *               that exact amount, remember the checkout
 *   complete()  given a Razorpay payment (fetched from Razorpay, or delivered
 *               by a signed webhook), check it pays exactly that checkout and
 *               create the order once. Safe to call repeatedly.
 */
const ordersService = require('./orders.js');
const payments = require('./payments.js');
const pending = require('./pendingCheckouts.js');
const { priceCart, validateContact, orderLines } = require('./checkoutPricing.js');

function pick(o, keys) { const r = {}; keys.forEach(k => { if (o && o[k] != null) r[k] = o[k]; }); return r; }

function publicQuote(q) {
  return {
    lines: q.lines, subtotal: q.subtotal, discount: q.discount, couponCode: q.couponCode, coupon: q.coupon,
    shipping: q.shipping, total: q.total, currency: q.currency,
  };
}

/** @returns {{status:number, body:object}} */
async function start(body, idempotencyKey) {
  const m = payments.mode();
  if (m === 'unavailable') return { status: 503, body: { error: 'Online payment is temporarily unavailable. Please try again later.' } };
  const q = priceCart({ items: body && body.items, couponCode: body && body.couponCode });
  if (!q.ok) return { status: 400, body: { error: q.error } };
  const bad = validateContact(body);
  if (bad) return { status: 400, body: { error: bad } };
  const amountPaise = Math.round(q.total * 100);

  if (m === 'mock') {
    // Test mode (never in production): no gateway; the order route re-prices.
    return { status: 200, body: { id: 'mock_' + idempotencyKey, gateway: 'mock', key: 'mock_key', amountPaise, currency: q.currency, quote: publicQuote(q) } };
  }

  const gw = await payments.createGatewayOrder({ amountPaise, currency: q.currency, receipt: 'soh_' + String(idempotencyKey).slice(0, 30), notes: { source: 'storefront' } });
  if (gw.amount !== amountPaise || String(gw.currency).toUpperCase() !== q.currency) {
    return { status: 502, body: { error: 'Payment gateway returned an unexpected amount. Please try again.' } };
  }
  pending.put({
    gatewayOrderId: gw.id, createdAt: new Date().toISOString(), status: 'pending',
    amountPaise, currency: q.currency,
    quote: { lines: orderLines(q.lines), subtotal: q.subtotal, discount: q.discount, couponCode: q.couponCode, shipping: q.shipping, total: q.total },
    customer: pick(body.customer, ['name', 'email', 'phone']),
    address: pick(body.address, ['doorNo', 'line1', 'line2', 'city', 'state', 'pincode', 'landmark']),
    location: body.location && body.location.lat ? pick(body.location, ['lat', 'lng', 'accuracy', 'mapsLink', 'source']) : null,
    notes: body.notes ? String(body.notes).slice(0, 1000) : '',
  });
  return { status: 200, body: { id: gw.id, gateway: 'razorpay', key: process.env.RAZORPAY_KEY_ID, amount: amountPaise, amountPaise, currency: q.currency, quote: publicQuote(q) } };
}

function orderResponse(order) {
  return { ok: true, orderId: order.orderId, id: order.id, total: order.total, status: order.status };
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * @param {{gatewayOrderId:string, payment:object, source:'browser'|'webhook'}} p
 * @returns {Promise<{status:number, body:object, created?:boolean}>}
 */
async function complete({ gatewayOrderId, payment, source }) {
  const rec = pending.get(gatewayOrderId);
  if (!rec) return { status: 400, body: { error: 'This payment does not match a checkout on our side. If money was taken, please contact us.' } };

  const done = () => {
    const r = pending.get(gatewayOrderId);
    if (!r || !r.orderId) return null;
    if (r.paymentId !== payment.id) return { status: 409, body: { error: 'This order has already been paid with a different payment. Please contact us for a refund of the extra payment.' } };
    return { status: 200, body: { ok: true, orderId: r.orderId, id: r.orderRecordId, total: r.quote.total, status: r.orderStatus || 'placed', duplicate: true } };
  };
  const already = done();
  if (already) return already;

  const other = pending.orderWithPayment(payment.id);
  if (other) return { status: 409, body: { error: 'This payment has already been used for order ' + other.orderId + '.' } };

  const reason = payments.paymentMismatch(payment, { gatewayOrderId, amountPaise: rec.amountPaise, currency: rec.currency });
  if (reason) {
    pending.update(gatewayOrderId, { lastRejection: { at: new Date().toISOString(), source, paymentId: payment.id, reason } });
    console.warn('[CHECKOUT] payment refused for ' + gatewayOrderId + ' (' + source + '): ' + reason);
    return { status: 400, body: { error: 'Payment verification failed: ' + reason + '.' } };
  }

  if (!pending.tryLock(gatewayOrderId)) {
    // Another request (browser or webhook) is creating this order right now.
    for (let i = 0; i < 40; i++) { await wait(100); const r = done(); if (r) return r; }
    return { status: 409, body: { error: 'Your order is being confirmed. Please check your email or track your order in a minute.' } };
  }
  try {
    const again = done();
    if (again) return again;
    const order = await ordersService.createOrder({
      items: rec.quote.lines, subtotal: rec.quote.subtotal, discount: rec.quote.discount, couponCode: rec.quote.couponCode,
      shipping: rec.quote.shipping, customer: rec.customer, address: rec.address, location: rec.location || undefined,
      notes: rec.notes, currency: rec.currency,
      payment: {
        method: 'online', status: 'paid', gateway: 'razorpay',
        gatewayOrderId, paymentId: payment.id, gatewayStatus: payment.status,
        amountPaise: Number(payment.amount), verifiedBy: source, verifiedAt: new Date().toISOString(),
      },
    });
    pending.update(gatewayOrderId, { status: 'completed', orderId: order.orderId, orderRecordId: order.id, orderStatus: order.status, paymentId: payment.id, completedBy: source, completedAt: new Date().toISOString() });
    return { status: 201, body: orderResponse(order), created: true };
  } catch (e) {
    pending.unlock(gatewayOrderId);
    throw e;
  }
}

module.exports = { start, complete, publicQuote };
