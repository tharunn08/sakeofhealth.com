/**
 * B2C admin permissions — enforced on the server (Phase 0.5.2, BUG-005).
 *
 * The approved role matrix (ARCHITECTURE-CONFIRMATION §11.3):
 *   admin    — everything
 *   manager  — everything except deleting staff
 *   staff    — support desk: orders (no payment/address edits, no cancel),
 *              deliveries, customers (view), reviews (moderate), read-only
 *              catalogue, dashboard and analytics, print settings
 *   delivery — only orders assigned to them: their delivery board, the
 *              order itself, and out_for_delivery → delivered
 * Any other role (e.g. business-platform roles) gets no shop-admin access
 * beyond /me. Every route in routes/admin.js must appear in RULES (a test
 * enforces this); paths that are not shop-admin routes fall through to 404.
 *
 * Mounted on the /api/admin router right after adminAuth, so every route
 * below it is covered. Phase 1 replaces the role table with the unified
 * permission engine; the route → permission mapping stays the same.
 */
const { db } = require('../services/db.js');

const A = ['admin'];
const AM = ['admin', 'manager'];
const AMS = ['admin', 'manager', 'staff'];
const AMSD = ['admin', 'manager', 'staff', 'delivery'];
const ALL = '*';

// [method, path pattern (relative to /api/admin), allowed roles, special rule]
const RULES = [
  ['GET', /^\/me$/, ALL],
  ['GET', /^\/dashboard$/, AMS],
  ['GET', /^\/analytics$/, AMS],
  ['GET', /^\/orders$/, AMS],
  ['GET', /^\/orders\/[^/]+$/, AMS, 'deliveryOwnOrder'],
  ['PATCH', /^\/orders\/[^/]+\/status$/, AMS, 'statusChange'],
  ['PATCH', /^\/orders\/[^/]+$/, AMS, 'staffOrderFields'],
  ['POST', /^\/orders\/[^/]+\/resend-notification$/, AMS],
  ['DELETE', /^\/orders\/[^/]+$/, AM],
  ['POST', /^\/orders\/[^/]+\/cancel$/, AM],
  ['GET', /^\/products$/, AMS],
  ['POST', /^\/products$/, AM],
  ['PATCH', /^\/products\/[^/]+$/, AM],
  ['DELETE', /^\/products\/[^/]+$/, AM],
  ['GET', /^\/coupons$/, AMS],
  ['POST', /^\/coupons$/, AM],
  ['PATCH', /^\/coupons\/[^/]+$/, AM],
  ['DELETE', /^\/coupons\/[^/]+$/, AM],
  ['GET', /^\/customers$/, AMS],
  ['GET', /^\/customers\/[^/]+$/, AMS],
  ['PATCH', /^\/customers\/[^/]+$/, AM],
  ['GET', /^\/reviews$/, AMS],
  ['PATCH', /^\/reviews\/[^/]+$/, AMS],
  ['DELETE', /^\/reviews\/[^/]+$/, AM],
  ['GET', /^\/staff$/, AM],
  ['POST', /^\/staff$/, AM],
  ['PATCH', /^\/staff\/[^/]+$/, AM],
  ['DELETE', /^\/staff\/[^/]+$/, A],
  ['GET', /^\/deliveries$/, AMSD],          // delivery: filtered to own in the route
  ['POST', /^\/deliveries\/[^/]+\/assign$/, AMS],
  ['GET', /^\/reports\/[^/]+\.csv$/, AM],
  ['POST', /^\/reports\/[^/]+\.csv$/, AM],
  ['GET', /^\/settings$/, AM],
  ['PUT', /^\/settings$/, AM],
  ['GET', /^\/notify-emails$/, AM],
  ['PUT', /^\/notify-emails$/, AM],
  ['GET', /^\/print-settings$/, AMSD],
  ['PUT', /^\/print-settings$/, AM],
  ['GET', /^\/email-status$/, AM],
  ['POST', /^\/test-notification$/, AM],
];

const FORBIDDEN = { error: 'Forbidden — your role does not allow this' };

function findOrder(id) {
  return db.orders.findById(id) || db.orders.findOne({ orderId: id });
}
function assignedToMe(order, admin) {
  return !!(order && order.assignedTo && admin && String(order.assignedTo.id) === String(admin.sub));
}

const SPECIAL = {
  // delivery may open only an order assigned to them
  deliveryOwnOrder(req) {
    if (req.admin.role !== 'delivery') return null;
    const order = findOrder(req.path.split('/')[2]);
    return assignedToMe(order, req.admin) ? true : false;
  },
  // delivery may only mark their own out-for-delivery order as delivered;
  // support staff may move an order along but never cancel it (D10)
  statusChange(req) {
    if (req.admin.role === 'staff') return !(req.body && req.body.status === 'cancelled');
    if (req.admin.role !== 'delivery') return null;
    const order = findOrder(req.path.split('/')[2]);
    return !!(assignedToMe(order, req.admin) && order.status === 'out_for_delivery' &&
      req.body && req.body.status === 'delivered');
  },
  // support staff may add notes / reassign, never change payment or address
  staffOrderFields(req) {
    if (req.admin.role !== 'staff') return null;
    const b = req.body || {};
    return b.payment === undefined && b.address === undefined;
  },
};

function b2cPermissions(req, res, next) {
  const role = req.admin && req.admin.role;
  if (!role) return res.status(401).json({ error: 'Unauthorized' });
  const rule = RULES.find(r => r[0] === req.method && r[1].test(req.path));
  // A path that is not a shop-admin route at all (e.g. /api/admin/b2b/* when
  // the business platform is off) falls through to the normal 404. Every
  // real route in routes/admin.js must have a rule: tests/b2c-permissions
  // fails the build if one is missing, so nothing new is ever left open.
  if (!rule) return next();
  const roles = rule[2];
  if (role === 'admin') return next();
  if (roles !== ALL && roles.indexOf(role) === -1) {
    // a special rule may still grant delivery its narrow access
    if (!(role === 'delivery' && rule[3] && SPECIAL[rule[3]](req) === true)) return res.status(403).json(FORBIDDEN);
    return next();
  }
  if (rule[3]) {
    const verdict = SPECIAL[rule[3]](req);
    if (verdict === false) return res.status(403).json(FORBIDDEN);
  }
  next();
}

/**
 * Page-level check used by the central sidebar (src/platform): may this role
 * call this route at all? Same table as the middleware; the per-order special
 * rules (delivery agents' own orders, staff field limits) narrow it further
 * inside a page but never decide whether the page itself is shown.
 */
function allows(role, method, path) {
  const rule = RULES.find(r => r[0] === method && r[1].test(path));
  if (!rule || !role) return false;
  if (role === 'admin' || rule[2] === ALL) return true;
  return rule[2].indexOf(role) !== -1;
}

module.exports = { b2cPermissions, RULES, allows };
