/**
 * Central Admin Panel — the ONE page registry.
 *
 * Every admin page is listed here once: its place in the sidebar, its address
 * (/admin/<group>/<page>), the scripts that implement it and the permission
 * that decides who sees it. The server builds every page and every user's
 * sidebar from this list, so there is one shell, one menu and one source of
 * truth for "who may open what".
 *
 *   module 'b2c'  — shop pages; shown when the B2C permission table allows the
 *                   page's main API call (`api`) for the user's role
 *   module 'b2b'  — trade pages (business platform); shown when it is enabled
 *                   and the role holds any of `perms` (empty = any trade permission)
 *   module 'erp'  — ERP screens (erp-web/admin, the existing screen code run inside
 *                   this shell); shown when the ERP is enabled and the signed-in
 *                   person's ERP permissions (live from MySQL) include `perm`
 *
 * Groups follow the approved sidebar (ADMIN-CONSOLIDATION-MAP §1). Only pages
 * that exist and work are listed — nothing is shown as a placeholder.
 */
'use strict';

const GROUPS = [
  { id: 'overview', label: 'Overview' },
  { id: 'business', label: 'ERP' },
  { id: 'sales', label: 'Sales & Orders' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'accounts', label: 'Business Accounts' },
  { id: 'customers', label: 'Customers' },
  { id: 'catalogue', label: 'Products & Catalogue' },
  { id: 'inventory', label: 'Inventory' },
  { id: 'manufacturing', label: 'Manufacturing & Quality' },
  { id: 'procurement', label: 'Procurement & Suppliers' },
  { id: 'finance', label: 'Finance & Reports' },
  { id: 'administration', label: 'Administration' },
];

const B2C = (id, group, slug, label, icon, script, api, extra) => Object.assign({
  id, group, path: '/admin/' + group + '/' + slug, label, icon, module: 'b2c',
  base: '/admin/', css: [], scripts: ['/admin/' + script], api,
}, extra || {});
const B2B = (id, group, slug, label, icon, script, perms, extra) => Object.assign({
  id, group, path: '/admin/' + group + '/' + slug, label, icon, module: 'b2b',
  base: '/admin/b2b/', css: ['/admin/b2b/b2b.css?v=1'], scripts: ['/admin/b2b/b2b.js?v=1', '/admin/b2b/' + script + '?v=1'], perms,
}, extra || {});

/** An ERP screen: `view` is its id in erp-web/admin (app.js / modules.js), `perm` the permission that screen requires. */
const ERP = (view, group, slug, label, icon, perm, extra) => Object.assign({
  id: 'erp-' + view, view, group, path: '/admin/' + group + '/' + slug, label, icon, module: 'erp', perm,
  base: '/admin/erp/', css: ['/platform/erp-embed.css'],
  scripts: ['/admin/erp/app.js', '/admin/erp/modules.js', '/admin/erp/operations.js', '/admin/erp/production.js', '/admin/erp/people.js', '/admin/erp/insights.js', '/admin/erp/home.js', '/platform/erp-host.js'],
}, extra || {});

const PAGES = [
  B2C('dashboard', 'overview', 'dashboard', 'Dashboard', 'dashboard', 'page-dashboard.js', ['GET', '/dashboard']),
  B2C('analytics', 'overview', 'analytics', 'Sales Analytics', 'analytics', 'page-analytics.js', ['GET', '/analytics']),
  B2B('b2b-dashboard', 'overview', 'trade', 'Trade Dashboard', 'dashboard', 'page-dashboard.js', []),

  B2C('orders', 'sales', 'online', 'Online Orders', 'orders', 'page-orders.js', ['GET', '/orders'], { badge: 'pending' }),
  B2B('b2b-orders', 'sales', 'trade', 'Trade Orders', 'orders', 'page-orders.js', ['b2b.orders.view'], { badge: 'b2b-orders' }),

  B2B('b2b-accounts', 'accounts', 'business', 'Retailers & Distributors', 'store', 'page-accounts.js', ['b2b.users.view'], { badge: 'b2b-accounts' }),
  B2B('b2b-network', 'accounts', 'network', 'Network & Mapping', 'network', 'page-network.js', ['b2b.network.view']),

  B2C('customers', 'customers', 'shop', 'Shop Customers', 'customers', 'page-customers.js', ['GET', '/customers']),
  B2C('reviews', 'customers', 'reviews', 'Reviews', 'reviews', 'page-reviews.js', ['GET', '/reviews'], { badge: 'reviews' }),
  ERP('customers', 'customers', 'all', 'All Customers', 'customers', 'customers.view'),

  B2C('products', 'catalogue', 'products', 'Online Products', 'products', 'page-products.js', ['GET', '/products']),
  B2B('b2b-catalogue', 'catalogue', 'trade', 'Trade Catalogue', 'products', 'page-catalogue.js', ['b2b.catalogue.view']),
  B2B('b2b-pricing', 'catalogue', 'pricing', 'Pricing & Margins', 'tag', 'page-pricing.js', ['b2b.pricing.view']),
  B2C('coupons', 'catalogue', 'coupons', 'Coupons', 'coupons', 'page-coupons.js', ['GET', '/coupons']),
  B2B('b2b-import', 'catalogue', 'import', 'Excel Import', 'upload', 'page-import.js', ['b2b.imports.execute']),

  B2B('b2b-inventory', 'inventory', 'stock', 'Stock & Warehouses', 'box', 'page-inventory.js', ['b2b.inventory.view']),

  B2B('b2b-finance', 'finance', 'invoices', 'Invoices & Payments', 'rupee', 'page-finance.js', ['b2b.invoices.view', 'b2b.payments.view']),
  B2C('reports', 'finance', 'shop-reports', 'Shop Reports', 'reports', 'page-reports.js', ['GET', '/reports/orders.csv']),
  B2B('b2b-reports', 'finance', 'trade-reports', 'Trade Reports', 'reports', 'page-reports.js', ['b2b.reports.view']),

  B2C('staff', 'administration', 'staff', 'Staff', 'staff', 'page-staff.js', ['GET', '/staff']),
  B2C('settings', 'administration', 'settings', 'Shop Settings', 'settings', 'page-settings.js', ['GET', '/settings']),
  B2B('b2b-settings', 'administration', 'trade-settings', 'Trade Settings', 'settings', 'page-settings.js', ['b2b.settings.view']),

  /* ERP screens (32) — same screen code as /admin/erp, now inside this shell */
  ERP('overview', 'overview', 'system', 'System Health', 'analytics', 'core.monitoring.view'),
  ERP('insights', 'overview', 'insights', 'Smart Insights', 'analytics', 'reports.export'),
  ERP('erphome', 'business', 'erp', 'ERP Home', 'dashboard', 'core.self.view'),
  ERP('salesdesk', 'sales', 'desk', 'Sales Desk', 'orders', 'sales.reports.view'),
  ERP('salesmen', 'sales', 'salesmen', 'Salesmen', 'staff', 'sales.reports.view'),
  // Delivery: dashboard, shop deliveries, trade deliveries, staff. The two delivery lists keep their
  // existing addresses (bookmarks, the shop delivery role's home page).
  ERP('deliveryhub', 'delivery', 'dashboard', 'Delivery Dashboard', 'truck', 'deliveries.view'),
  B2C('deliveries', 'sales', 'deliveries', 'Shop Deliveries', 'deliveries', 'page-deliveries.js', ['GET', '/deliveries'], { group: 'delivery' }),
  ERP('deliveries', 'sales', 'trade-deliveries', 'Trade Deliveries', 'truck', 'deliveries.view', { group: 'delivery' }),
  ERP('deliverystaff', 'delivery', 'staff', 'Delivery Staff', 'staff', 'deliveries.manage'),
  ERP('events', 'sales', 'events', 'Events & Counter Sales', 'tag', 'events.view'),
  ERP('locations', 'sales', 'locations', 'Field & Event Locations', 'map', 'locations.view'),
  ERP('network', 'accounts', 'distribution', 'Distribution Network', 'network', 'network.map.view'),
  ERP('products', 'catalogue', 'master', 'Product Master', 'products', 'catalog.products.view'),
  ERP('pricing', 'catalogue', 'price-lists', 'Price Lists', 'tag', 'catalog.pricing.view'),
  ERP('stock', 'inventory', 'batches', 'Stock & Batches', 'box', 'inventory.view'),
  ERP('shopstock', 'inventory', 'shop-stock', 'Online Shop Stock', 'store', 'shop_stock.view'),
  ERP('recalls', 'inventory', 'recalls', 'Recalls', 'alert', 'recalls.view'),
  ERP('manufacturers', 'manufacturing', 'manufacturers', 'Manufacturers', 'store', 'manufacturing.view'),
  ERP('manufacturing', 'manufacturing', 'orders', 'Manufacturing Orders', 'box', 'manufacturing.view'),
  ERP('quality', 'manufacturing', 'quality', 'Batch Quality & Release', 'check', 'manufacturing.view'),
  ERP('boms', 'manufacturing', 'boms', 'Bills of Materials', 'reports', 'manufacturing.view'),
  ERP('vendors', 'procurement', 'vendors', 'Manufacturers & Suppliers', 'store', 'vendors.view'),
  ERP('purchasing', 'procurement', 'purchasing', 'Purchasing', 'orders', 'procurement.pr.view'),
  ERP('receiving', 'procurement', 'receiving', 'Goods Receipt', 'deliveries', 'warehouse.grn.create'),
  ERP('finance', 'finance', 'business', 'Business Finance', 'rupee', 'finance.reports.view'),
  ERP('bills', 'finance', 'bills', 'Supplier Bills', 'reports', 'finance.payables.view'),
  ERP('collections', 'finance', 'collections', 'Collections', 'rupee', 'sales.collections.confirm'),
  ERP('offline', 'administration', 'offline-sync', 'Offline Sync', 'refresh', 'offline.view'),
  ERP('notifications', 'administration', 'notifications', 'Notifications', 'inbox', 'notifications.view'),
  ERP('approvals', 'administration', 'approvals', 'Approvals', 'check', 'core.approvals.view'),
  ERP('decisions', 'administration', 'decisions', 'Business Decisions', 'settings', 'core.settings.view'),
  ERP('staff', 'administration', 'business-staff', 'Business Staff & Roles', 'staff', 'core.staff.view'),
  ERP('audit', 'administration', 'audit', 'Audit Log', 'reports', 'core.audit.view'),
  ERP('account', 'administration', 'my-security', 'My Password & 2FA', 'settings', 'core.self.view'),
];

const byPath = new Map(PAGES.map(p => [p.path, p]));

/** Pages that exist on this server (trade pages when the business platform is on, ERP screens when the ERP is on). */
function available(b2bEnabled, erpEnabled) {
  return PAGES.filter(p => p.module === 'b2c' || (p.module === 'b2b' && b2bEnabled) || (p.module === 'erp' && erpEnabled));
}

/**
 * May this person open this page? Uses the same tables the APIs enforce:
 * `role` is their shop/trade staff role (null for ERP-only staff),
 * `erpPerms` their live ERP permissions (null without an ERP session).
 */
function permitted(page, role, erpPerms) {
  if (page.module === 'erp') return !!(erpPerms && erpPerms.has(page.perm));
  if (!role) return false;
  if (page.module === 'b2c') return require('../middleware/b2cPermissions.js').allows(role, page.api[0], page.api[1]);
  const rbac = require('../modules/b2b/rbac.js');
  return page.perms.length ? page.perms.some(p => rbac.has(role, p)) : rbac.permissionsFor(role).length > 0;
}

/**
 * The sidebar for one person: permitted pages, grouped in the approved order.
 * @param {string|null} role      shop/trade staff role, or null
 * @param {boolean}     b2bEnabled
 * @param {{enabled:boolean, permissions:Set<string>|null}} [erp]
 */
function navFor(role, b2bEnabled, erp) {
  erp = erp || { enabled: false, permissions: null };
  const pages = available(b2bEnabled, erp.enabled).filter(p => permitted(p, role, erp.permissions));
  const groups = GROUPS.map(g => ({
    id: g.id, label: g.label,
    items: pages.filter(p => p.group === g.id).map(p => ({ id: p.id, label: p.label, path: p.path, icon: p.icon, badge: p.badge || null, module: p.module, view: p.view || null })),
  })).filter(g => g.items.length);
  const first = groups.length ? groups[0].items[0].path : null;
  return { home: first, groups };
}

module.exports = { GROUPS, PAGES, byPath, available, permitted, navFor };
