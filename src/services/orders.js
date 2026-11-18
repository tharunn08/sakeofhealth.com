/**
 * Order lifecycle: creation, status transitions, customer aggregation.
 */
const { db } = require('./db.js');
const { notifyOrderPlaced, notifyStatusChange } = require('./notify.js');

const STATUS_FLOW = ['pending', 'accepted', 'prepared', 'out_for_delivery', 'delivered'];
const ALL_STATUSES = STATUS_FLOW.concat(['cancelled']);

const STATUS_LABEL = {
  pending: 'Pending',
  accepted: 'Order Accepted',
  prepared: 'Order Prepared',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/**
 * Human-friendly order ID: SOH-20260724-0007 (Phase 0.5.6, BUG-013).
 * Highest number already used today + 1 (not a count, so gaps left by
 * removed orders can never produce a duplicate), then checked for collision.
 */
function generateOrderId() {
  const d = new Date();
  const datePart = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const prefix = (process.env.ORDER_PREFIX || 'SOH') + '-' + datePart + '-';
  const all = db.orders.all();
  const used = new Set(all.map(o => o.orderId));
  let max = 0;
  for (const o of all) {
    const id = String(o.orderId || '');
    if (id.indexOf(prefix) !== 0) continue;
    const n = parseInt(id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  let n = max + 1;
  while (used.has(prefix + String(n).padStart(4, '0'))) n++;
  return prefix + String(n).padStart(4, '0');
}

function sanitisePhone(p) {
  return String(p || '').replace(/[^\d]/g, '').slice(-10);
}

/** Create and persist an order, then fire notifications. */
async function createOrder(input) {
  const items = (input.items || []).map(i => ({
    id: i.id,
    name: i.name,
    price: Number(i.price) || 0,
    qty: Math.max(1, Number(i.qty) || 1),
    image: i.image || '',
  }));
  if (!items.length) throw new Error('Cart is empty');

  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const discount = Number(input.discount) || 0;
  const shipping = Number(input.shipping) || 0;
  const total = Math.max(0, subtotal - discount + shipping);

  const order = db.orders.insert({
    orderId: generateOrderId(),
    items: items,
    subtotal: subtotal,
    discount: discount,
    couponCode: input.couponCode || null,
    shipping: shipping,
    total: total,
    currency: input.currency || 'INR',
    customer: {
      name: String(input.customer.name || '').trim(),
      email: String(input.customer.email || '').trim().toLowerCase(),
      phone: sanitisePhone(input.customer.phone),
    },
    address: {
      doorNo: input.address.doorNo || '',
      line1: input.address.line1 || '',
      line2: input.address.line2 || '',
      city: input.address.city || '',
      state: input.address.state || '',
      pincode: input.address.pincode || '',
      landmark: input.address.landmark || '',
    },
    location: input.location && input.location.lat ? {
      lat: Number(input.location.lat),
      lng: Number(input.location.lng),
      accuracy: input.location.accuracy || null,
      source: input.location.source || 'unknown',
      formatted: input.location.formatted || '',
      capturedAt: new Date().toISOString(),
    } : null,
    payment: {
      method: input.payment && input.payment.method || 'online',
      status: input.payment && input.payment.status || 'pending',
      gateway: input.payment && input.payment.gateway || null,
      paymentId: input.payment && input.payment.paymentId || null,
      gatewayOrderId: input.payment && input.payment.gatewayOrderId || null,
    },
    status: 'pending',
    timeline: [{ status: 'pending', at: new Date().toISOString(), by: 'system', note: 'Order placed' }],
    notes: input.notes || '',
    assignedTo: null,
  });

  upsertCustomer(order);
  incrementCouponUse(order.couponCode);

  // Fire and forget — never block the checkout response
  setImmediate(() => {
    notifyOrderPlaced(order).catch(e => console.error('[NOTIFY] order placed:', e.message));
  });

  return order;
}

/** Move an order to a new status, append timeline, notify customer. */
async function updateStatus(orderId, status, actor, note) {
  if (ALL_STATUSES.indexOf(status) === -1) throw new Error('Invalid status: ' + status);
  const order = db.orders.findOne({ id: orderId }) || db.orders.findOne({ orderId: orderId });
  if (!order) throw new Error('Order not found');
  if (order.status === status) return order;

  const timeline = (order.timeline || []).concat([{
    status: status,
    at: new Date().toISOString(),
    by: actor || 'admin',
    note: note || '',
  }]);

  const patch = { status: status, timeline: timeline };
  // Delivery does not change the payment status (Phase 0.5.6, BUG-012): only a
  // verified gateway payment or an authorised manual confirmation does.
  if (status === 'delivered') patch.deliveredAt = new Date().toISOString();
  if (status === 'cancelled') {
    // Cancelling goes through cancelOrder() so a reason is always recorded.
    throw new Error('Use cancelOrder() to cancel an order');
  }

  const updated = db.orders.update(order.id, patch);

  setImmediate(() => {
    notifyStatusChange(updated, status).catch(e => console.error('[NOTIFY] status:', e.message));
  });

  return updated;
}

class OrderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * Cancel an order (Phase 0.5.7, D10). The order is kept: status "cancelled",
 * with reason, actor, time and a timeline entry. A paid order is flagged
 * refundRequired (the refund itself is done in the Razorpay dashboard).
 */
async function cancelOrder(orderId, opts) {
  const reason = String((opts && opts.reason) || '').trim();
  const actor = (opts && opts.actor) || 'admin';
  if (reason.length < 3) throw new OrderError('Please give a reason for cancelling (at least 3 characters).', 400);
  if (reason.length > 500) throw new OrderError('Reason is too long (500 characters at most).', 400);
  const order = db.orders.findOne({ id: orderId }) || db.orders.findOne({ orderId: orderId });
  if (!order) throw new OrderError('Order not found', 404);
  if (order.status === 'cancelled') throw new OrderError('This order is already cancelled.', 409);
  if (order.status === 'delivered') throw new OrderError('A delivered order cannot be cancelled. Use a return or refund instead.', 409);

  const at = new Date().toISOString();
  const paid = !!(order.payment && order.payment.status === 'paid');
  const updated = db.orders.update(order.id, {
    status: 'cancelled',
    cancelledAt: at,
    cancelledBy: actor,
    cancelReason: reason,
    refundRequired: paid,
    timeline: (order.timeline || []).concat([{ status: 'cancelled', at: at, by: actor, note: reason + (paid ? ' — refund required' : '') }]),
  });
  recomputeCustomer(order.customer && order.customer.email);

  setImmediate(() => {
    notifyStatusChange(updated, 'cancelled').catch(e => console.error('[NOTIFY] status:', e.message));
  });
  return updated;
}

/** Recalculate a customer's order count and spend from their non-cancelled orders. */
function recomputeCustomer(email) {
  if (!email) return;
  const cust = db.customers.findOne({ email: email });
  if (!cust) return;
  const mine = db.orders.all().filter(o => o.customer && o.customer.email === email && o.status !== 'cancelled');
  db.customers.update(cust.id, {
    orderCount: mine.length,
    totalSpent: mine.reduce((s, o) => s + (o.total || 0), 0),
  });
}

/** Maintain a rolled-up customer record for the CRM view. */
function upsertCustomer(order) {
  const email = order.customer.email;
  const phone = order.customer.phone;
  let customer = email ? db.customers.findOne({ email: email }) : null;
  if (!customer && phone) customer = db.customers.findOne({ phone: phone });

  if (customer) {
    db.customers.update(customer.id, {
      name: order.customer.name || customer.name,
      phone: phone || customer.phone,
      email: email || customer.email,
      orderCount: (customer.orderCount || 0) + 1,
      totalSpent: (customer.totalSpent || 0) + order.total,
      lastOrderAt: order.createdAt,
      lastAddress: order.address,
      lastLocation: order.location || customer.lastLocation,
    });
  } else {
    db.customers.insert({
      name: order.customer.name,
      email: email,
      phone: phone,
      orderCount: 1,
      totalSpent: order.total,
      firstOrderAt: order.createdAt,
      lastOrderAt: order.createdAt,
      lastAddress: order.address,
      lastLocation: order.location,
      tags: [],
    });
  }
}

function incrementCouponUse(code) {
  if (!code) return;
  const coupon = db.coupons.findOne({ code: String(code).toUpperCase() });
  if (coupon) db.coupons.update(coupon.id, { usedCount: (coupon.usedCount || 0) + 1 });
}

/** Public tracking — requires order ID AND matching phone number. */
function trackOrder(orderId, phone) {
  const id = String(orderId || '').trim().toUpperCase();
  const ph = sanitisePhone(phone);
  if (!id || ph.length < 10) return null;

  const order = db.orders.all().find(o =>
    (String(o.orderId).toUpperCase() === id || String(o.id).toUpperCase() === id) &&
    o.customer.phone === ph
  );
  if (!order) return null;

  return {
    orderId: order.orderId,
    status: order.status,
    statusLabel: STATUS_LABEL[order.status],
    placedAt: order.createdAt,
    deliveredAt: order.deliveredAt || null,
    items: order.items.map(i => ({ name: i.name, qty: i.qty, image: i.image })),
    total: order.total,
    currency: order.currency,
    paymentStatus: order.payment.status,
    address: order.address,
    timeline: (order.timeline || []).map(t => ({
      status: t.status,
      label: STATUS_LABEL[t.status] || t.status,
      at: t.at,
      note: t.note,
    })),
    flow: STATUS_FLOW,
    estimatedDelivery: estimateDelivery(order),
  };
}

function estimateDelivery(order) {
  if (order.status === 'delivered' || order.status === 'cancelled') return null;
  const placed = new Date(order.createdAt).getTime();
  const days = Number(process.env.DELIVERY_DAYS || 4);
  return new Date(placed + days * 86400000).toISOString();
}

module.exports = {
  createOrder, updateStatus, cancelOrder, recomputeCustomer, OrderError, trackOrder, upsertCustomer,
  STATUS_FLOW, ALL_STATUSES, STATUS_LABEL, generateOrderId,
};
