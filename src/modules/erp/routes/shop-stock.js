/** /api/erp/shop-stock — online-shop stock on the central ledger (3b.3 shadow, 3b.4 enforcement). */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../shopstock/service.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
const B = function (req) { return req.body || {}; };
r.use(identity.requireStaff);

r.get('/overview', can('shop_stock.view'), h(async function (req, res) { res.json(await svc.overview()); }));
r.get('/lines', can('shop_stock.view'), h(async function (req, res) { res.json(await svc.listLines(req.query)); }));
r.get('/holds', can('shop_stock.view'), h(async function (req, res) { res.json(await svc.listHolds(req.query)); }));
r.get('/discrepancies', can('shop_stock.view'), h(async function (req, res) { res.json(await svc.listDiscrepancies(req.query)); }));
r.get('/exceptions', can('shop_stock.view'), h(async function (req, res) { res.json(await svc.listExceptions(req.query)); }));
// run the catch-up now (it also runs every minute while the mode is not off)
r.post('/sync', can('shop_stock.resolve'), h(async function (req, res) {
  const out = await svc.sync();
  await audit.write(null, audit.actorFrom(req), { module: 'shop_stock', action: 'sync.run', entity: 'shop_stock', entityId: 0, new: out });
  res.json(out);
}));
r.post('/discrepancies/:id/explain', can('shop_stock.resolve'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.explain(t, a, req.erp, id(req.params.id), B(req)); })); }));
r.post('/exceptions/:id/refund', can('shop_stock.refund.pay'), h(async function (req, res) { res.json(await svc.refund(audit.actorFrom(req), id(req.params.id))); }));
r.post('/exceptions/:id/close', can('shop_stock.resolve'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.closeException(t, a, id(req.params.id), B(req)); })); }));
r.post('/lines/:id/return', can('shop_stock.resolve'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.recordReturn(t, a, id(req.params.id), B(req)); })); }));

module.exports = r;
