/**
 * Storefront payments — Razorpay only (Phase 0.5.4–0.5.5; BUG-002, BUG-003, BUG-021).
 *
 * Mode is decided on every call, fail-closed:
 *   mock         only when PAYMENT_MOCK === 'true' AND NODE_ENV !== 'production'
 *   razorpay     when RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set
 *   unavailable  otherwise — callers answer 503; no order is created unpaid
 *
 * Razorpay is called over its REST API. RAZORPAY_API_BASE exists only so the
 * automated tests can point at a local stub; leave it unset everywhere else.
 * Use rzp_test_ keys for all development and staging payment testing.
 */
const { createHmac, timingSafeEqual } = require('crypto');

const DEFAULT_API = 'https://api.razorpay.com/v1';

function mode() {
  if (process.env.PAYMENT_MOCK === 'true' && process.env.NODE_ENV !== 'production') return 'mock';
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) return 'razorpay';
  return 'unavailable';
}

class GatewayError extends Error {
  constructor(message, status) { super(message); this.status = status || 502; }
}

async function api(method, path, body) {
  const base = (process.env.RAZORPAY_API_BASE || DEFAULT_API).replace(/\/$/, '');
  const auth = Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64');
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: Object.assign({ Authorization: 'Basic ' + auth }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new GatewayError('Payment gateway unreachable');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok) {
    const msg = data && data.error && data.error.description ? data.error.description : ('HTTP ' + res.status);
    throw new GatewayError('Payment gateway error: ' + msg, res.status >= 500 ? 502 : 400);
  }
  return data;
}

/** Create a Razorpay order for an amount the SERVER computed. */
async function createGatewayOrder({ amountPaise, currency, receipt, notes }) {
  if (!Number.isInteger(amountPaise) || amountPaise < 100) throw new GatewayError('Order amount is too small for online payment', 400);
  const o = await api('POST', '/orders', { amount: amountPaise, currency: currency || 'INR', receipt: String(receipt || '').slice(0, 40), notes: notes || {} });
  return o;
}

const fetchPayment = id => api('GET', '/payments/' + encodeURIComponent(id));
const fetchOrder = id => api('GET', '/orders/' + encodeURIComponent(id));

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Checkout callback signature: HMAC-SHA256(order_id|payment_id, key secret). */
function verifyCheckoutSignature(gatewayOrderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !gatewayOrderId || !paymentId) return false;
  return safeEqualHex(createHmac('sha256', secret).update(gatewayOrderId + '|' + paymentId).digest('hex'), signature);
}

/** Webhook signature: HMAC-SHA256(raw body, webhook secret). */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  return safeEqualHex(createHmac('sha256', secret).update(rawBody).digest('hex'), signature);
}

/**
 * Does this Razorpay payment pay exactly this checkout?
 * @returns {string|null} a reason it does not, or null when it does
 */
function paymentMismatch(payment, expected) {
  if (!payment || typeof payment !== 'object') return 'payment not found';
  if (payment.order_id !== expected.gatewayOrderId) return 'payment belongs to a different order';
  if (['captured', 'authorized'].indexOf(payment.status) === -1) return 'payment status is ' + payment.status;
  if (Number(payment.amount) !== expected.amountPaise) return 'amount paid does not match the order total';
  if (String(payment.currency || '').toUpperCase() !== String(expected.currency || 'INR').toUpperCase()) return 'currency does not match';
  return null;
}

/**
 * Kept for callers of the old API (/api/checkout/verify). Mock mode only
 * accepts outside production; unavailable → false.
 */
async function verifySignature(gateway, params) {
  const m = mode();
  if (m === 'mock') return true;
  if (m !== 'razorpay' || (gateway && gateway !== 'razorpay')) return false;
  return verifyCheckoutSignature(params.orderId, params.paymentId, params.signature);
}

/**
 * Gateway order in rupees — the contract the business (B2B) module uses
 * (src/modules/b2b/payments/service.js, a frozen coupling). Same fail-closed
 * modes: mock only outside production when asked for; no keys → refused.
 */
async function createOrder({ amount, currency, receipt, idempotencyKey }) {
  const m = mode();
  currency = currency || 'INR';
  if (m === 'mock') return { id: 'mock_' + idempotencyKey, amount: amount, currency: currency, gateway: 'mock', key: 'mock_key' };
  if (m !== 'razorpay') throw new GatewayError('Online payment is not configured', 503);
  const o = await createGatewayOrder({ amountPaise: Math.round(Number(amount) * 100), currency, receipt: receipt || idempotencyKey, notes: { idempotencyKey: String(idempotencyKey || '') } });
  return Object.assign({}, o, { gateway: 'razorpay', key: process.env.RAZORPAY_KEY_ID });
}

module.exports = {
  mode, GatewayError, createGatewayOrder, fetchPayment, fetchOrder,
  verifyCheckoutSignature, verifyWebhookSignature, paymentMismatch, verifySignature,
  createOrder,
};
