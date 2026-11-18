/**
 * Role-based access control for the B2B admin API.
 *
 * Staff accounts are the existing admin-panel staff (JSON store) — a staff
 * member's `role` decides which b2b.* permissions they hold. Checks happen
 * on the server for every request; the browser only uses this list to hide
 * buttons the server would refuse anyway.
 */
const PERMISSIONS = [
  'b2b.users.view', 'b2b.users.approve', 'b2b.users.edit',
  'b2b.orders.view', 'b2b.orders.approve', 'b2b.orders.fulfil', 'b2b.orders.cancel',
  'b2b.catalogue.view', 'b2b.catalogue.edit',
  'b2b.pricing.view', 'b2b.pricing.edit',
  'b2b.imports.execute',
  'b2b.network.view', 'b2b.network.edit',
  'b2b.inventory.view', 'b2b.inventory.edit',
  'b2b.invoices.view', 'b2b.invoices.create',
  'b2b.payments.view', 'b2b.payments.record', 'b2b.credit.edit', 'b2b.credit.override',
  'b2b.returns.manage',
  'b2b.reports.view',
  'b2b.settings.view', 'b2b.settings.edit',
  'b2b.audit.view',
  'b2b.system.migrate',
];

const ALL = PERMISSIONS.slice();
const except = function () { const deny = Array.prototype.slice.call(arguments); return ALL.filter(p => deny.indexOf(p) === -1); };

const ROLE_PERMISSIONS = {
  admin: ALL,
  b2b_admin: ALL,
  manager: except('b2b.system.migrate'),
  b2b_manager: except('b2b.system.migrate', 'b2b.settings.edit', 'b2b.credit.override', 'b2b.pricing.edit'),
  sales: ['b2b.users.view', 'b2b.users.approve', 'b2b.users.edit', 'b2b.orders.view', 'b2b.orders.approve',
    'b2b.catalogue.view', 'b2b.pricing.view', 'b2b.network.view', 'b2b.network.edit', 'b2b.reports.view'],
  inventory: ['b2b.orders.view', 'b2b.orders.fulfil', 'b2b.catalogue.view', 'b2b.catalogue.edit',
    'b2b.inventory.view', 'b2b.inventory.edit', 'b2b.imports.execute', 'b2b.returns.manage', 'b2b.reports.view'],
  finance: ['b2b.users.view', 'b2b.orders.view', 'b2b.pricing.view', 'b2b.catalogue.view',
    'b2b.invoices.view', 'b2b.invoices.create', 'b2b.payments.view', 'b2b.payments.record',
    'b2b.credit.edit', 'b2b.returns.manage', 'b2b.reports.view'],
  support: ['b2b.users.view', 'b2b.orders.view', 'b2b.catalogue.view', 'b2b.invoices.view',
    'b2b.network.view', 'b2b.payments.view'],
  // Existing generic roles: read-only visibility of B2B activity, nothing else.
  staff: ['b2b.users.view', 'b2b.orders.view', 'b2b.catalogue.view'],
  delivery: [],
};

/** Roles that exist only for the B2B back office — they get no access to the B2C admin API. */
const B2B_ONLY_ROLES = ['b2b_admin', 'b2b_manager', 'sales', 'inventory', 'finance', 'support'];
const ALL_STAFF_ROLES = ['admin', 'manager', 'staff', 'delivery'].concat(B2B_ONLY_ROLES);

function permissionsFor(role) {
  return (ROLE_PERMISSIONS[role] || []).slice();
}

function has(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).indexOf(permission) !== -1;
}

/** Express middleware: requires ANY of the listed permissions. Runs after adminAuth. */
function can() {
  const needed = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.admin) return res.status(401).json({ error: 'Unauthorized — please log in again' });
    const role = req.admin.role;
    if (needed.some(function (p) { return has(role, p); })) return next();
    return res.status(403).json({ error: 'Forbidden — your role does not have permission for this action', required: needed });
  };
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, B2B_ONLY_ROLES, ALL_STAFF_ROLES, permissionsFor, has, can };
