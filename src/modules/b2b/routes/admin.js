/**
 * B2B back-office API — mounted at /api/admin/b2b.
 *
 * Authentication is the existing admin login (adminAuth). Authorisation is
 * per-route with granular b2b.* permissions (see rbac.js) — a logged-in
 * staff member can only do what their role allows, whatever the browser sends.
 */
const express = require('express');
const db = require('../../../db/connection.js');
const migrate = require('../../../db/migrate.js');
const { adminAuth } = require('../../../middleware/adminAuth.js');
const rbac = require('../rbac.js');
const config = require('../config.js');
const { h, paging, paged, bad, notFound, like } = require('../lib/http.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const settings = require('../lib/settings.js');
const uploads = require('../lib/uploads.js');
const accounts = require('../accounts/service.js');
const mappings = require('../mappings/service.js');
const catalogue = require('../catalogue/service.js');
const pricing = require('../pricing/service.js');
const inventory = require('../inventory/service.js');
const orders = require('../orders/service.js');
const invoices = require('../invoices/service.js');
const payments = require('../payments/service.js');
const returns = require('../returns/service.js');
const imports = require('../imports/service.js');
const reports = require('../reports/service.js');
const notifications = require('../notifications/service.js');

const router = express.Router();
const can = rbac.can;
const id = function (req, name) { const n = Number(req.params[name || 'id']); if (!Number.isInteger(n) || n <= 0) throw notFound(); return n; };
const actor = audit.adminActor;
const adminScope = function (req) { return { admin: true, permissions: rbac.permissionsFor(req.admin.role) }; };

router.use(adminAuth);

router.get('/me', function (req, res) {
  res.json({ user: { email: req.admin.email, name: req.admin.name, role: req.admin.role }, permissions: rbac.permissionsFor(req.admin.role) });
});

/* ═════════════ System (works even before the schema exists) ═════════════ */

router.get('/system/status', can('b2b.settings.view', 'b2b.system.migrate'), h(async function (req, res) {
  const ping = await db.ping(0);
  const out = { database: { configured: db.isConfigured(), connected: ping.ok, error: ping.ok ? null : ping.error },
    privateStorage: config.privateDir().replace(/^.*[\\/]/, '…/'), strongSecret: config.hasStrongSecret(), version: config.appVersion(), autoMigrate: config.autoMigrate() };
  if (ping.ok) {
    try { out.migrations = await migrate.status(); out.schema = await migrate.verify(); }
    catch (e) { out.migrations = null; out.schema = { ok: false, error: e.code || 'error' }; }
  }
  res.json(out);
}));

router.post('/system/migrate', can('b2b.system.migrate'), h(async function (req, res) {
  const log = [];
  const result = await migrate.up(function (line) { log.push(line); });
  settings.invalidate();
  const schema = await migrate.verify();
  // First-time setup from the admin panel: start the background sender now, no restart needed.
  if (schema.ok) { try { require('../notifications/service.js').startWorker(); } catch (e) { /* starts on next boot */ } }
  try { await audit.log(null, actor(req), 'system.migrated', 'system', null, null, { applied: result.applied }); } catch (e) { /* audit table may be brand new */ }
  res.json({ applied: result.applied, log: log, schema: schema });
}));

/* ═════════════ Dashboard & search ═════════════ */

router.get('/dashboard', can('b2b.reports.view', 'b2b.orders.view', 'b2b.users.view'), h(async function (req, res) { res.json(await reports.dashboard(req.query.fresh === '1')); }));

/** One search box across accounts, orders, invoices and products — every lookup is an indexed, server-side query. */
router.get('/search', h(async function (req, res) {
  const term = v.text(req.query.q, 80);
  if (term.length < 2) return res.json({ accounts: [], orders: [], invoices: [], products: [] });
  const role = req.admin.role, out = { accounts: [], orders: [], invoices: [], products: [] };
  const pg = { limit: 6, offset: 0, page: 1 };
  if (rbac.has(role, 'b2b.users.view')) out.accounts = (await accounts.listAccounts({ q: term }, pg)).rows;
  if (rbac.has(role, 'b2b.orders.view')) out.orders = (await orders.list({ admin: true }, { q: term }, pg)).rows;
  if (rbac.has(role, 'b2b.invoices.view')) out.invoices = (await invoices.list({}, { q: term }, pg)).rows;
  if (rbac.has(role, 'b2b.catalogue.view')) {
    out.products = await db.query('SELECT id, sku, name, is_active FROM b2b_products WHERE sku LIKE ? OR name LIKE ? OR barcode = ? ORDER BY sku LIMIT 6', [like(term, 'prefix'), like(term), term]);
  }
  res.json(out);
}));

/* ═════════════ Business users ═════════════ */

router.get('/geo/states', h(async function (req, res) { res.json({ states: await accounts.listStates() }); }));
router.get('/geo/districts', h(async function (req, res) { res.json({ districts: await accounts.listDistricts(req.query.state_id) }); }));
router.post('/geo/states/:id/serviceable', can('b2b.settings.edit'), h(async function (req, res) {
  await db.query('UPDATE b2b_states SET is_serviceable = ? WHERE id = ?', [(req.body || {}).serviceable ? 1 : 0, id(req)]);
  audit.logSoft(actor(req), 'state.serviceable_changed', 'state', id(req), null, { is_serviceable: !!(req.body || {}).serviceable });
  res.json({ ok: true });
}));

router.get('/accounts', can('b2b.users.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100), q = req.query;
  const r = await accounts.listAccounts({ type: q.type, status: q.status, state_id: q.state_id, district_id: q.district_id, pincode: q.pincode,
    distributor_id: q.distributor_id, unmapped: q.unmapped === '1', q: q.q, sort: q.sort, dir: q.dir }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/accounts/:id', can('b2b.users.view'), h(async function (req, res) { res.json(await accounts.adminDetail(id(req))); }));
router.post('/accounts/:id/status', can('b2b.users.approve'), h(async function (req, res) {
  res.json(await accounts.changeStatus(id(req), String((req.body || {}).status || ''), (req.body || {}).reason, actor(req)));
}));
router.patch('/accounts/:id', can('b2b.users.edit'), h(async function (req, res) { res.json(await accounts.adminUpdate(id(req), req.body || {}, actor(req))); }));
router.post('/accounts/:id/reset-password', can('b2b.users.edit'), h(async function (req, res) {
  res.json(await accounts.adminResetPassword(id(req), (req.body || {}).password, actor(req)));
}));
function documentHeaders(doc) {
  return { 'Content-Type': doc.mime_type, 'Content-Disposition': 'inline; filename="document-' + doc.id + '.' + doc.stored_name.split('.').pop() + '"',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
}
/** KYC documents are sent through this authorised route only — they have no public URL. */
router.get('/documents/:id/file', can('b2b.users.view'), h(async function (req, res) {
  const f = await accounts.documentFile(id(req), null);
  await f.send(res, documentHeaders(f.doc), function () {
    audit.logSoft(actor(req), 'document.viewed', 'document', f.doc.id, null, { account_id: Number(f.doc.account_id), doc_type: f.doc.doc_type });
  });
}));

/* ═════════════ Network: mapping & service areas ═════════════ */

router.get('/retailers/:id/candidates', can('b2b.network.view'), h(async function (req, res) {
  const a = await accounts.getAccount(id(req));
  if (!a || a.account_type !== 'retailer') throw notFound('Retailer not found');
  res.json({ candidates: await mappings.rankDistributors(a), current: await mappings.currentMapping(a.id) });
}));
router.post('/retailers/:id/mapping', can('b2b.network.edit'), h(async function (req, res) {
  const b = req.body || {}, rid = id(req);
  const reason = v.text(b.reason, 500);
  if (reason.length < 3) throw bad('Please give a reason for the change');
  const distributorId = b.distributor_id == null || b.distributor_id === '' ? null : Number(b.distributor_id);
  res.json(await db.transaction(function (tx) { return mappings.assign(tx, rid, distributorId, { method: 'manual', reason: reason, actor: actor(req) }); }));
}));
router.post('/retailers/:id/mapping/auto', can('b2b.network.edit'), h(async function (req, res) {
  const rid = id(req);
  const r = await db.transaction(function (tx) { return mappings.autoAssign(tx, rid, actor(req)); });
  res.json({ assigned: r.assigned, candidates: r.candidates.length });
}));
router.post('/retailers/:id/mapping/status', can('b2b.network.edit'), h(async function (req, res) {
  const b = req.body || {}, rid = id(req);
  res.json(await db.transaction(function (tx) { return mappings.setMappingStatus(tx, rid, String(b.status || ''), actor(req), v.text(b.reason, 500)); }));
}));
router.post('/mapping/bulk', can('b2b.network.edit'), h(async function (req, res) {
  const b = req.body || {};
  const reason = v.text(b.reason, 500);
  if (reason.length < 3) throw bad('Please give a reason for the bulk remap');
  let ids = b.retailer_ids;
  if (!Array.isArray(ids) && b.from_distributor_id) {
    ids = (await db.query('SELECT retailer_id FROM b2b_retailer_distributor_map WHERE distributor_id = ? AND current_retailer_id IS NOT NULL LIMIT 2000', [Number(b.from_distributor_id)]))
      .map(function (r) { return r.retailer_id; });
  }
  res.json(await mappings.bulkRemap(ids, b.distributor_id == null || b.distributor_id === '' ? null : Number(b.distributor_id), actor(req), reason));
}));
router.get('/distributors/:id/service-areas', can('b2b.network.view'), h(async function (req, res) { res.json({ areas: await mappings.listServiceAreas(id(req)) }); }));
router.post('/distributors/:id/service-areas', can('b2b.network.edit'), h(async function (req, res) {
  const b = req.body || {};
  if (b.pincodes) return res.status(201).json(await mappings.addPincodes(id(req), b.pincodes, actor(req)));
  res.status(201).json(await mappings.addServiceArea(id(req), b, actor(req)));
}));
router.post('/service-areas/:id/active', can('b2b.network.edit'), h(async function (req, res) {
  res.json(await mappings.setServiceAreaActive(id(req), !!(req.body || {}).active, actor(req)));
}));

/* ═════════════ Catalogue ═════════════ */

router.get('/categories', can('b2b.catalogue.view', 'b2b.pricing.view'), h(async function (req, res) { res.json({ categories: await catalogue.listCategories(false) }); }));
router.post('/categories', can('b2b.catalogue.edit'), h(async function (req, res) { res.status(201).json(await catalogue.saveCategory(null, req.body || {}, actor(req))); }));
router.patch('/categories/:id', can('b2b.catalogue.edit'), h(async function (req, res) { res.json(await catalogue.saveCategory(id(req), req.body || {}, actor(req))); }));

router.get('/products', can('b2b.catalogue.view', 'b2b.pricing.view', 'b2b.inventory.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100), q = req.query;
  const r = await catalogue.adminList({ q: q.q, category_id: q.category_id, active: q.active, channel: q.channel, sort: q.sort, dir: q.dir }, pg);
  // Cost and margin columns are only for roles allowed to see pricing.
  if (!rbac.has(req.admin.role, 'b2b.pricing.view')) {
    r.rows.forEach(function (p) { ['base_price', 'distributor_price', 'retailer_price', 'distributor_margin', 'retailer_margin', 'computed'].forEach(function (k) { delete p[k]; }); });
  }
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/products/:id', can('b2b.catalogue.view'), h(async function (req, res) { res.json(await catalogue.getProduct(id(req))); }));
router.post('/products', can('b2b.catalogue.edit'), h(async function (req, res) { res.status(201).json(await catalogue.createProduct(req.body || {}, actor(req))); }));
router.patch('/products/:id', can('b2b.catalogue.edit'), h(async function (req, res) {
  const b = req.body || {};
  const touchesPrice = ['mrp', 'base_price', 'distributor_price', 'retailer_price', 'distributor_margin', 'retailer_margin', 'gst_rate'].some(function (k) { return b[k] !== undefined; });
  if (touchesPrice && !rbac.has(req.admin.role, 'b2b.pricing.edit')) return res.status(403).json({ error: 'Forbidden — changing prices or margins needs the b2b.pricing.edit permission' });
  res.json(await catalogue.updateProduct(id(req), b, actor(req)));
}));
router.post('/products/sync-b2c', can('b2b.catalogue.edit'), h(async function (req, res) { res.json(await catalogue.syncFromB2C(actor(req))); }));

/* ═════════════ Pricing & margins ═════════════ */

router.get('/pricing/rules', can('b2b.pricing.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await pricing.listRules(req.query, pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.post('/pricing/rules', can('b2b.pricing.edit'), h(async function (req, res) { res.status(201).json(await pricing.createRule(req.body || {}, actor(req))); }));
router.patch('/pricing/rules/:id', can('b2b.pricing.edit'), h(async function (req, res) { res.json(await pricing.updateRule(id(req), req.body || {}, actor(req))); }));
router.delete('/pricing/rules/:id', can('b2b.pricing.edit'), h(async function (req, res) { res.json(await pricing.deactivateRule(id(req), actor(req))); }));
router.post('/pricing/bulk/preview', can('b2b.pricing.edit'), h(async function (req, res) { res.json(await pricing.bulkPreview((req.body || {}).selection, req.body || {})); }));
router.post('/pricing/bulk/apply', can('b2b.pricing.edit'), h(async function (req, res) {
  const b = req.body || {};
  if (b.confirm !== true) throw bad('Confirm the bulk update to apply it');
  res.json(await pricing.bulkApply(b.selection, b, actor(req)));
}));
router.get('/pricing/simulate', can('b2b.pricing.view'), h(async function (req, res) {
  res.json(await pricing.simulate(Number(req.query.product_id) || 0, Number(req.query.account_id) || null, String(req.query.audience || ''), Math.max(1, Number(req.query.qty) || 1)));
}));

/* ═════════════ Excel import ═════════════ */

router.get('/imports/template', can('b2b.imports.execute', 'b2b.catalogue.edit'), h(async function (req, res) {
  const wb = await imports.templateWorkbook();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sake-of-health-product-import-template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));
router.get('/imports', can('b2b.imports.execute'), h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await imports.list(pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.post('/imports', can('b2b.imports.execute'), uploads.importUpload, h(async function (req, res) { res.status(201).json(await imports.upload(req.file, actor(req))); }));
router.get('/imports/:id', can('b2b.imports.execute'), h(async function (req, res) { res.json(await imports.get(id(req))); }));
router.post('/imports/:id/validate', can('b2b.imports.execute'), h(async function (req, res) { res.json(await imports.validate(id(req), req.body || {}, actor(req))); }));
router.get('/imports/:id/rows', can('b2b.imports.execute'), h(async function (req, res) {
  const pg = paging(req.query, 50, 200);
  const r = await imports.preview(id(req), { filter: req.query.filter, action: req.query.action }, pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { import: r.import }));
}));
router.get('/imports/:id/errors.csv', can('b2b.imports.execute'), h(async function (req, res) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="import-' + id(req) + '-errors.csv"');
  res.send('﻿' + await imports.errorReport(id(req)));
}));
router.post('/imports/:id/apply', can('b2b.imports.execute'), h(async function (req, res) {
  if ((req.body || {}).confirm !== true) throw bad('Confirm the import to apply it');
  res.status(202).json(await imports.apply(id(req), actor(req), { wait: (req.body || {}).wait === true }));
}));
router.post('/imports/:id/rollback', can('b2b.imports.execute'), h(async function (req, res) { res.json(await imports.rollback(id(req), actor(req))); }));

/* ═════════════ Inventory ═════════════ */

router.get('/warehouses', can('b2b.inventory.view', 'b2b.catalogue.view'), h(async function (req, res) { res.json({ warehouses: await inventory.listWarehouses() }); }));
router.post('/warehouses', can('b2b.inventory.edit'), h(async function (req, res) { res.status(201).json(await inventory.saveWarehouse(null, req.body || {}, actor(req))); }));
router.patch('/warehouses/:id', can('b2b.inventory.edit'), h(async function (req, res) { res.json(await inventory.saveWarehouse(id(req), req.body || {}, actor(req))); }));
const stockFilter = function (q) {
  const f = { warehouse_id: q.warehouse_id, q: q.q, category_id: q.category_id, low: q.low === '1', out: q.out === '1', sort: q.sort, dir: q.dir,
    product_id: q.product_id, type: q.type, from: v.date(q.from), to: v.date(q.to), within: q.within, expired: q.expired === '1' };
  if (q.owner === 'company' || !q.owner) f.company_only = true;
  return f;
};
router.get('/stock', can('b2b.inventory.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await inventory.listStock(stockFilter(req.query), pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/stock/movements', can('b2b.inventory.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await inventory.listMovements(stockFilter(req.query), pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/stock/batches', can('b2b.inventory.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await inventory.listBatches(stockFilter(req.query), pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { summary: await inventory.expirySummary({ company_only: true }) }));
}));
router.post('/stock/entry', can('b2b.inventory.edit'), h(async function (req, res) { res.json(await inventory.manualEntry(req.body || {}, actor(req))); }));

/* ═════════════ Orders ═════════════ */

router.get('/orders', can('b2b.orders.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100), q = req.query;
  const r = await orders.list({ admin: true }, { status: q.status, buyer_type: q.buyer_type, seller_type: q.seller_type, buyer_id: q.buyer_id, seller_id: q.seller_id,
    payment_status: q.payment_status, on_hold: q.on_hold === '1', unassigned: q.unassigned === '1', from: v.date(q.from), to: v.date(q.to), state_id: q.state_id, q: q.q, sort: q.sort, dir: q.dir }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/orders/:id', can('b2b.orders.view'), h(async function (req, res) {
  const out = await orders.get(id(req), adminScope(req));
  if (!rbac.has(req.admin.role, 'b2b.pricing.view')) { delete out.order.cost_total; out.items.forEach(function (i) { delete i.base_price; }); }
  if (out.order.buyer_type === 'retailer' && ['pending_admin_approval', 'approved', 'assigned'].indexOf(out.order.status) !== -1 && rbac.has(req.admin.role, 'b2b.network.view')) {
    const buyer = await accounts.getAccount(out.order.buyer_account_id);
    out.candidates = (await mappings.rankDistributors(buyer)).slice(0, 8);
    out.buyerRiskFlags = buyer.risk_flags;
  }
  res.json(out);
}));
router.post('/orders/:id/status', can('b2b.orders.approve', 'b2b.orders.fulfil', 'b2b.orders.cancel', 'b2b.payments.record'), h(async function (req, res) {
  const b = req.body || {};
  res.json(await orders.transition(id(req), String(b.status || ''), adminScope(req), actor(req), { note: b.note, delivered: b.delivered }));
}));
router.post('/orders/:id/hold', can('b2b.orders.approve'), h(async function (req, res) { res.json(await orders.setHold(id(req), !!(req.body || {}).hold, (req.body || {}).reason, actor(req))); }));
router.post('/orders/:id/quantities', can('b2b.orders.approve'), h(async function (req, res) { res.json(await orders.adjustQuantities(id(req), (req.body || {}).items, actor(req))); }));
router.post('/orders/:id/seller', can('b2b.orders.approve'), h(async function (req, res) {
  const b = req.body || {};
  const distributorId = b.distributor_id == null || b.distributor_id === '' ? null : Number(b.distributor_id);
  res.json(await orders.reassignSeller(id(req), distributorId, b.reason, actor(req), rbac.has(req.admin.role, 'b2b.credit.override')));
}));
router.put('/orders/:id/note', can('b2b.orders.approve', 'b2b.orders.fulfil'), h(async function (req, res) { res.json(await orders.setInternalNote(id(req), (req.body || {}).note, actor(req))); }));
router.post('/orders/:id/invoice', can('b2b.invoices.create'), h(async function (req, res) { res.status(201).json(await orders.generateInvoice(id(req), actor(req))); }));
router.post('/orders/:id/payments', can('b2b.payments.record'), h(async function (req, res) { res.status(201).json(await payments.recordManual(id(req), req.body || {}, actor(req), { admin: true })); }));
router.get('/print', can('b2b.orders.view'), h(async function (req, res) {
  res.json(await orders.printData(String(req.query.ids || '').split(',').map(Number), { admin: true }));
}));

/* ═════════════ Returns ═════════════ */

router.get('/returns', can('b2b.orders.view', 'b2b.returns.manage'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await returns.list({ admin: true }, { status: req.query.status, open: req.query.open === '1', q: req.query.q }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/returns/:id', can('b2b.orders.view', 'b2b.returns.manage'), h(async function (req, res) { res.json(await returns.get(id(req), { admin: true })); }));
router.post('/returns/:id/:action', can('b2b.returns.manage'), h(async function (req, res) {
  const a = req.params.action;
  if (a === 'inspect') return res.json(await returns.inspect(id(req), req.body || {}, { admin: true }, actor(req)));
  if (a === 'complete') return res.json(await returns.complete(id(req), req.body || {}, { admin: true }, actor(req)));
  res.json(await returns.act(id(req), a, req.body, { admin: true }, actor(req)));
}));

/* ═════════════ Finance ═════════════ */

router.get('/invoices', can('b2b.invoices.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100), q = req.query;
  const r = await invoices.list({}, { q: q.q, status: q.status, payment: q.payment, from: v.date(q.from), to: v.date(q.to), seller_type: q.seller_type }, pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { amount: r.amount }));
}));
router.get('/invoices/:id', can('b2b.invoices.view'), h(async function (req, res) { res.json(await invoices.get(id(req), {})); }));
router.post('/invoices/:id/cancel', can('b2b.invoices.create'), h(async function (req, res) { res.json(await invoices.cancelInvoice(id(req), (req.body || {}).reason, actor(req))); }));
router.get('/credit-notes', can('b2b.invoices.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await invoices.listCreditNotes({}, { q: req.query.q, from: v.date(req.query.from), to: v.date(req.query.to) }, pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { amount: r.amount }));
}));
router.get('/payments', can('b2b.payments.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100), q = req.query;
  const r = await payments.listPayments({}, { q: q.q, method: q.method, from: v.date(q.from), to: v.date(q.to) }, pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { amount: r.amount }));
}));
router.get('/outstanding', can('b2b.payments.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await payments.listOutstanding({}, { q: req.query.q, type: req.query.type }, pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { amount: r.amount }));
}));
router.get('/credit', can('b2b.payments.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await payments.listCreditAccounts({ q: req.query.q, used: req.query.used === '1', creditor_id: req.query.creditor === 'all' ? undefined : 0 }, pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { totalLimit: r.totalLimit, totalUsed: r.totalUsed }));
}));
router.get('/credit/:id/history', can('b2b.payments.view'), h(async function (req, res) {
  res.json({ credit: await payments.getCredit(id(req), Number(req.query.creditor) || 0), history: await payments.creditHistory(id(req), Number(req.query.creditor) || 0, paging(req.query, 30, 100)) });
}));
router.put('/credit/:id', can('b2b.credit.edit'), h(async function (req, res) { res.json(await payments.setCreditTerms(id(req), Number((req.body || {}).creditor_id) || 0, req.body || {}, actor(req))); }));
router.post('/credit/:id/override', can('b2b.credit.override'), h(async function (req, res) { res.json(await payments.setOverride(id(req), Number((req.body || {}).creditor_id) || 0, req.body || {}, actor(req))); }));

/* ═════════════ Reports & exports ═════════════ */

const EXPORT_PERMISSION = { retailers: 'b2b.users.view', distributors: 'b2b.users.view', products: 'b2b.pricing.view', orders: 'b2b.orders.view', invoices: 'b2b.invoices.view',
  payments: 'b2b.payments.view', outstanding: 'b2b.payments.view', movements: 'b2b.inventory.view', margins: 'b2b.pricing.view' };
router.get('/reports/:type', can('b2b.reports.view'), h(async function (req, res) {
  if (req.params.type === 'margins' && !rbac.has(req.admin.role, 'b2b.pricing.view')) return res.status(403).json({ error: 'Forbidden — margin reports need the b2b.pricing.view permission' });
  res.json(await reports.report(req.params.type, req.query, { screen: true }));
}));
router.get('/export/:name', h(async function (req, res) {
  const need = EXPORT_PERMISSION[req.params.name] || 'b2b.reports.view';
  if (!rbac.has(req.admin.role, need)) return res.status(403).json({ error: 'Forbidden — this export needs the ' + need + ' permission' });
  audit.logSoft(actor(req), 'export.downloaded', 'export', req.params.name, null, { format: req.query.format === 'xlsx' ? 'xlsx' : 'csv' });
  await reports.exportTo(res, req.params.name, req.query);
}));

/* ═════════════ Settings, audit, notifications ═════════════ */

router.get('/settings', can('b2b.settings.view', 'b2b.pricing.view'), h(async function (req, res) { res.json({ settings: await settings.all() }); }));
router.put('/settings', h(async function (req, res) {
  const body = req.body || {}, role = req.admin.role;
  const keys = Object.keys(body);
  if (!keys.length) throw bad('Nothing to save');
  const pricingOnly = keys.every(function (k) { return k.indexOf('pricing.') === 0; });
  // Default margins belong to pricing staff; everything else needs settings.edit.
  if (!(rbac.has(role, 'b2b.settings.edit') || (pricingOnly && rbac.has(role, 'b2b.pricing.edit')))) {
    return res.status(403).json({ error: 'Forbidden — your role does not have permission for this action' });
  }
  const change = await settings.setMany(body, req.admin.email);
  if (Object.keys(change.new).length) {
    await audit.log(null, actor(req), pricingOnly ? 'pricing.default_margin_changed' : 'settings.changed', 'settings', null, change.old, change.new);
  }
  res.json({ ok: true, changed: Object.keys(change.new) });
}));

router.get('/audit', can('b2b.audit.view'), h(async function (req, res) {
  const pg = paging(req.query, 50, 200), q = req.query, where = [], params = [];
  if (q.entity) { where.push('entity = ?'); params.push(v.text(q.entity, 50)); }
  if (q.entity_id) { where.push('entity_id = ?'); params.push(v.text(q.entity_id, 64)); }
  if (q.action) { where.push('action LIKE ?'); params.push(like(v.text(q.action, 80), 'prefix')); }
  if (q.actor) { where.push('actor_label LIKE ?'); params.push(like(v.text(q.actor, 80), 'prefix')); }
  if (v.date(q.from)) { where.push('created_at >= ?'); params.push(v.date(q.from) + ' 00:00:00'); }
  if (v.date(q.to)) { where.push('created_at <= ?'); params.push(v.date(q.to) + ' 23:59:59'); }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_audit_logs' + sql, params);
  const rows = await db.query('SELECT id, actor_type, actor_label, actor_role, action, entity, entity_id, old_value, new_value, ip, created_at FROM b2b_audit_logs' + sql +
    ' ORDER BY id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  res.json(paged(rows, total.n, pg));
}));

const QUEUE_VIEWS = { failed: ['failed'], pending: ['pending', 'sending'], sent: ['sent'], not_sent: ['skipped_no_provider', 'skipped_no_contact', 'skipped_opt_out'] };
router.get('/notifications/queue', can('b2b.settings.view'), h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const view = QUEUE_VIEWS[req.query.status] ? req.query.status : 'failed';
  const list = QUEUE_VIEWS[view];
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_notification_queue WHERE status IN (' + db.placeholders(list) + ')', list);
  const rows = await db.query('SELECT id, channel, recipient, subject, status, delivery_status, attempts, last_error, ref_type, ref_id, template_name, created_at, sent_at FROM b2b_notification_queue WHERE status IN (' + db.placeholders(list) + ') ORDER BY id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, list);
  rows.forEach(function (r) { r.can_retry = notifications.RETRYABLE.indexOf(r.status) !== -1 && !/_otp$/.test(r.template_name || ''); });
  res.json(paged(rows, total.n, pg));
}));
router.get('/notifications/queue/:id', can('b2b.settings.view'), h(async function (req, res) {
  const row = await db.queryOne('SELECT id, channel, recipient, subject, status, delivery_status, attempts, max_attempts, last_error, ref_type, ref_id, template_name, provider_message_id, created_at, sent_at, next_attempt_at FROM b2b_notification_queue WHERE id = ?', [v.posInt(req.params.id) || 0]);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  row.history = await notifications.historyOf(row.id);
  res.json(row);
}));
// One message: put a failed / not-sent message back in the queue. Sent messages are never reset.
router.post('/notifications/queue/:id/retry', can('b2b.settings.edit'), h(async function (req, res) {
  const id = v.posInt(req.params.id) || 0;
  const r = await notifications.requeue([id], actor(req).label);
  if (!r.requeued.length) return res.status(409).json({ error: r.refused.length ? 'Not retried: ' + r.refused[0].reason : 'Message not found', code: 'not_retryable' });
  await audit.log(null, actor(req), 'notification.retried', 'notification', String(id), null, { ids: r.requeued });
  const done = await notifications.processDue(10);
  res.json({ requeued: r.requeued.length, processed: done.processed || 0 });
}));
// All failed messages (kept for the transition, owner decision D10). One-time codes are skipped.
router.post('/notifications/retry', can('b2b.settings.edit'), h(async function (req, res) {
  const r = await notifications.requeue('all-failed', actor(req).label);
  if (r.requeued.length) await audit.log(null, actor(req), 'notification.retried_all', 'notification', null, null, { count: r.requeued.length, skipped: r.refused.length });
  const done = await notifications.processDue(50);
  res.json({ requeued: r.requeued.length, skipped: r.refused.length, processed: done.processed || 0 });
}));

module.exports = router;
