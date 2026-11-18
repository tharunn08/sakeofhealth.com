/**
 * Order state machine. Statuses can only move along these edges, and each
 * edge lists who may take it. Anything else is rejected by the server.
 *
 *  submitted ─┬─► pending_admin_approval ─┬─► approved ─► assigned ─► accepted ─► processing ─► packed
 *             └──────────────────────────►┘      ▲            │                                   │
 *                                                └─(declined)─┘                                   ▼
 *        delivered / partially_delivered ◄── out_for_delivery ◄──────────────────────────── dispatched
 *
 *  cancelled / rejected / returned ─► refunded
 */
const STATUSES = ['draft', 'submitted', 'pending_admin_approval', 'approved', 'assigned', 'accepted', 'processing', 'packed',
  'dispatched', 'out_for_delivery', 'delivered', 'partially_delivered', 'cancelled', 'rejected', 'returned', 'refunded'];

const LABEL = {
  draft: 'Draft', submitted: 'Submitted', pending_admin_approval: 'Awaiting approval', approved: 'Approved', assigned: 'Assigned',
  accepted: 'Accepted', processing: 'Processing', packed: 'Packed', dispatched: 'Dispatched', out_for_delivery: 'Out for delivery',
  delivered: 'Delivered', partially_delivered: 'Partially delivered', cancelled: 'Cancelled', rejected: 'Rejected',
  returned: 'Returned', refunded: 'Refunded',
};

// who: 'approve' | 'fulfil' | 'cancel' | 'refund' are admin permissions (b2b.orders.approve …);
//      'seller' = the distributor supplying the order; 'buyer' = the account that placed it; 'system' = internal only.
const EDGES = {
  submitted: { pending_admin_approval: ['system'], approved: ['system'], cancelled: ['cancel', 'buyer'] },
  pending_admin_approval: { approved: ['approve'], rejected: ['approve'], cancelled: ['cancel', 'buyer'] },
  approved: { assigned: ['approve', 'system'], cancelled: ['cancel', 'buyer'] },
  assigned: { accepted: ['fulfil', 'seller'], approved: ['approve', 'seller'], cancelled: ['cancel', 'buyer'] },
  accepted: { processing: ['fulfil', 'seller'], cancelled: ['cancel', 'seller', 'buyer'] },
  processing: { packed: ['fulfil', 'seller'], cancelled: ['cancel', 'seller'] },
  packed: { dispatched: ['fulfil', 'seller'], cancelled: ['cancel', 'seller'] },
  dispatched: { out_for_delivery: ['fulfil', 'seller'], delivered: ['fulfil', 'seller'], partially_delivered: ['fulfil', 'seller'] },
  out_for_delivery: { delivered: ['fulfil', 'seller'], partially_delivered: ['fulfil', 'seller'] },
  delivered: { returned: ['system'] },
  partially_delivered: { returned: ['system'] },
  cancelled: { refunded: ['refund'] },
  rejected: { refunded: ['refund'] },
  returned: { refunded: ['refund'] },
  refunded: {},
  draft: {},
};

const TIMESTAMP_COLUMN = {
  submitted: 'submitted_at', approved: 'approved_at', assigned: 'assigned_at', accepted: 'accepted_at', processing: 'processing_at',
  packed: 'packed_at', dispatched: 'dispatched_at', out_for_delivery: 'out_for_delivery_at', delivered: 'delivered_at',
  partially_delivered: 'delivered_at', cancelled: 'cancelled_at', rejected: 'cancelled_at',
};

const BUYER_CANCEL_ORDER = ['submitted', 'pending_admin_approval', 'approved', 'assigned', 'accepted'];
const ADMIN_PERM = { approve: 'b2b.orders.approve', fulfil: 'b2b.orders.fulfil', cancel: 'b2b.orders.cancel', refund: 'b2b.payments.record' };

/**
 * May this viewer move the order from → to?
 * viewer = { kind: 'admin', permissions: [...] } | { kind: 'seller' } | { kind: 'buyer', cancelUntil } | { kind: 'system' }
 */
function allowed(from, to, viewer) {
  const who = (EDGES[from] || {})[to];
  if (!who) return false;
  if (viewer.kind === 'system') return true;
  if (viewer.kind === 'admin') {
    return who.some(function (w) { return ADMIN_PERM[w] && viewer.permissions.indexOf(ADMIN_PERM[w]) !== -1; });
  }
  if (viewer.kind === 'seller') return who.indexOf('seller') !== -1;
  if (viewer.kind === 'buyer') {
    if (who.indexOf('buyer') === -1) return false;
    const limit = BUYER_CANCEL_ORDER.indexOf(viewer.cancelUntil || 'assigned');
    return BUYER_CANCEL_ORDER.indexOf(from) !== -1 && BUYER_CANCEL_ORDER.indexOf(from) <= limit;
  }
  return false;
}

/** Every status this viewer could move the order to right now (drives the buttons in the UI). */
function nextFor(from, viewer) {
  return Object.keys(EDGES[from] || {}).filter(function (to) { return allowed(from, to, viewer); });
}

const OPEN = ['submitted', 'pending_admin_approval', 'approved', 'assigned', 'accepted', 'processing', 'packed', 'dispatched', 'out_for_delivery'];
const DEAD = ['cancelled', 'rejected', 'refunded', 'draft'];

module.exports = { STATUSES, LABEL, EDGES, TIMESTAMP_COLUMN, allowed, nextFor, OPEN, DEAD, BUYER_CANCEL_ORDER };
