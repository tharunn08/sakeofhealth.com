/** /api/erp/vendors and /api/erp/vendor-products — staff side of vendor management. */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../vendors/service.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
r.use(identity.requireStaff);

r.get('/vendors', can('vendors.view'), h(async function (req, res) { res.json(await svc.list(req.query)); }));
r.post('/vendors', can('vendors.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createWithLogin(t, a, req.body || {}); })); }));
// pickers for the vendor screens (only what the screens need: no prices, no stock)
r.get('/vendors-lookup/states', can('vendors.view'), h(async function (req, res) { res.json({ items: await db.query('SELECT id, name, gst_code FROM b2b_states ORDER BY name') }); }));
r.get('/vendors-lookup/products', can('vendors.view'), h(async function (req, res) {
  const t = '%' + String(req.query.q || '').replace(/[\\%_]/g, '\\$&').slice(0, 80) + '%';
  res.json({ items: await db.query('SELECT id, sku, name FROM b2b_products WHERE sku LIKE ? OR name LIKE ? ORDER BY name LIMIT 30', [t, t]) });
}));
r.post('/vendors/invite', can('vendors.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.invite(t, a, req.body || {}); })); }));
r.get('/vendors/:id', can('vendors.view'), h(async function (req, res) { res.json(await svc.detail(id(req.params.id))); }));
r.put('/vendors/:id', can('vendors.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.staffUpdate(t, a, id(req.params.id), req.body || {}); })); }));
r.post('/vendors/:id/addresses', can('vendors.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.addAddress(t, a, id(req.params.id), req.body || {}); })); }));
r.delete('/vendors/:id/addresses/:addressId', can('vendors.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.removeAddress(t, a, id(req.params.id), id(req.params.addressId)); })); }));
r.post('/vendors/:id/users', can('vendors.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.addUser(t, a, id(req.params.id), req.body || {}); })); }));
r.post('/vendors/:id/users/:userId/reset-password', can('vendors.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.resetUserPassword(t, a, id(req.params.id), id(req.params.userId)); })); }));
r.post('/vendors/:id/users/:userId/status', can('vendors.verify'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.setUserStatus(t, a, id(req.params.id), id(req.params.userId), String((req.body || {}).status || '')); })); }));
r.post('/vendors/:id/capabilities', can('vendors.verify'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.decideCapability(t, a, id(req.params.id), req.body || {}); })); }));
r.get('/vendors/:id/documents/:docId/file', can('vendors.view'), h(async function (req, res) {
  const d = await db.queryOne('SELECT stored_name, mime_type, original_name FROM b2b_vendor_documents WHERE id = ? AND vendor_id = ?', [id(req.params.docId), id(req.params.id)]);
  const sent = d && await svc.sendDocument(res, d, { 'Content-Type': d.mime_type, 'Content-Disposition': 'inline; filename="document"', 'X-Content-Type-Options': 'nosniff' }, function () {
    return audit.write(null, audit.actorFrom(req), { module: 'vendors', action: 'vendor.document_viewed', entity: 'vendor', entityId: req.params.id, new: { documentId: Number(req.params.docId) } });
  });
  if (!sent) return res.status(404).json({ error: 'Not found' });
}));
r.post('/vendors/:id/documents/:docId/review', can('vendors.verify'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.reviewDocument(t, a, id(req.params.id), id(req.params.docId), req.body || {}); }));
}));
r.post('/vendors/:id/verifications', can('vendors.verify'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.recordVerification(t, a, id(req.params.id), req.body || {}); }));
}));
r.post('/vendors/:id/suspend', can('vendors.verify'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.setStatus(t, a, id(req.params.id), 'suspended', req.body && req.body.reason); }));
}));
r.post('/vendors/:id/bank-accounts', can('vendors.create'), h(async function (req, res) {
  res.status(201).json(await tx(req, function (t, a) { return svc.addBankAccount(t, a, id(req.params.id), req.body || {}); }));
}));
r.post('/vendors/:id/bank-accounts/:bankId/verify', can('vendors.verify'), h(async function (req, res) {
  // the person who added the account cannot verify it (checked in the service, per account)
  res.json(await tx(req, function (t, a) { return svc.verifyBankAccount(t, a, id(req.params.id), id(req.params.bankId), req.body || {}); }));
}));
r.post('/vendor-products/:id/decide', can('vendors.products.approve'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.decideProduct(t, a, id(req.params.id), req.body || {}); }));
}));
r.post('/vendor-prices/:id/decide', can('vendors.products.approve'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.decidePrice(t, a, id(req.params.id), req.body || {}); }));
}));
module.exports = r;
