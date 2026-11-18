/**
 * /api/erp/catalog — products, tax rates, price lists, simulation, schemes.
 * requireStaff + a permission on every route; sensitive ones (publish) also need MFA.
 */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const uploads = require('../../b2b/lib/uploads.js');
const svc = require('../catalog/service.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };

r.use(identity.requireStaff);

r.get('/products', can('catalog.products.view'), h(async function (req, res) { res.json(await svc.listProducts(req.query)); }));
r.patch('/products/:id', can('catalog.products.edit'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.updateProduct(t, a, id(req.params.id), req.body || {}); }));
}));
r.post('/tax-rates', can('catalog.tax.edit'), h(async function (req, res) {
  res.status(202).json(await tx(req, function (t, a) { return svc.proposeTaxRate(t, a, req.body || {}); }));
}));

r.get('/price-lists', can('catalog.pricing.view'), h(async function (req, res) { res.json(await svc.listPriceLists(req.query)); }));
r.post('/price-lists/imports', can('catalog.pricing.import'), uploads.importUpload, h(async function (req, res) {
  res.status(201).json(await tx(req, function (t, a) { return svc.importPriceList(t, a, req.file, req.body || {}); }));
}));
r.get('/price-lists/:id/report', can('catalog.pricing.view'), h(async function (req, res) { res.json(await svc.report(id(req.params.id))); }));
r.get('/price-lists/:id/diff', can('catalog.pricing.view'), h(async function (req, res) { res.json(await svc.diff(id(req.params.id), req.query)); }));
r.delete('/price-lists/:id/items/:productId', can('catalog.pricing.edit'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.removeItem(t, a, id(req.params.id), id(req.params.productId), req.body && req.body.reason); }));
}));
r.post('/price-lists/:id/submit', can('catalog.pricing.edit'), h(async function (req, res) {
  res.status(202).json(await tx(req, function (t, a) { return svc.submit(t, a, id(req.params.id), req.body || {}); }));
}));
r.post('/price-lists/:id/publish', can('catalog.pricing.publish'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.publish(t, a, id(req.params.id)); }));
}));
r.post('/pricing/simulate', can('catalog.pricing.view'), h(async function (req, res) { res.json(await svc.simulate(req.body || {})); }));
r.post('/schemes', can('catalog.schemes.edit'), h(async function (req, res) {
  res.status(202).json(await tx(req, function (t, a) { return svc.proposeScheme(t, a, req.body || {}); }));
}));

module.exports = r;
