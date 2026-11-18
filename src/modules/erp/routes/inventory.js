/** /api/erp/inventory — stock, lots, trace, transfers, dispositions, counts, reconciliation. */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../inventory/service.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
const B = function (req) { return req.body || {}; };
r.use(identity.requireStaff);

r.get('/stock', can('inventory.view'), h(async function (req, res) { res.json(await svc.stock(req.erp, req.query)); }));
r.get('/lots', can('inventory.view'), h(async function (req, res) { res.json(await svc.listLots(req.erp, req.query)); }));
r.get('/lots/:id/trace', can('inventory.trace'), h(async function (req, res) { res.json(await svc.trace(id(req.params.id))); }));
r.post('/transfers', can('inventory.transfer'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createTransfer(t, a, req.erp, B(req)); })); }));
r.post('/transfers/:id/dispatch', can('inventory.transfer'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.dispatchTransfer(t, a, req.erp, id(req.params.id)); })); }));
r.post('/transfers/:id/receive', can('inventory.transfer'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.receiveTransfer(t, a, req.erp, id(req.params.id), B(req)); })); }));
r.post('/dispositions', can('inventory.disposition.propose'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return svc.proposeDisposition(t, a, req.erp, B(req)); })); }));
// stock adjustments and opening balances: proposed here, posted only after a second person approves (decision 5)
r.get('/adjustments', can('inventory.view'), h(async function (req, res) { res.json({ items: await svc.listAdjustments(req.erp, req.query) }); }));
r.post('/adjustments', can('inventory.adjust.propose'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return svc.proposeAdjustment(t, a, req.erp, B(req)); })); }));
r.post('/counts', can('inventory.count'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.openCount(t, a, req.erp, B(req)); })); }));
r.put('/counts/:id', can('inventory.count'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.recordCount(t, a, req.erp, id(req.params.id), B(req)); })); }));
r.post('/counts/:id/submit', can('inventory.count'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.submitCount(t, a, req.erp, id(req.params.id), B(req).reason); })); }));
r.get('/reconciliation', can('inventory.view'), h(async function (req, res) { res.json(await svc.reconciliation(req.erp, req.query)); }));
// read-only shop feed (observe only; runs only when the b2c.feed.enabled decision is true)
r.get('/b2c-feed', can('inventory.view'), h(async function (req, res) { res.json(await require('../b2cfeed/readonly-adapter.js').report(req.query.days)); }));
r.post('/b2c-feed/run', can('inventory.transfer'), h(async function (req, res) {
  if ((await require('../core/settings.js').get('b2c.feed.enabled')) !== true) return res.status(409).json({ error: 'The shop feed is off (business decision b2c.feed.enabled)', code: 'feed_off' });
  res.json(await require('../b2cfeed/readonly-adapter.js').run());
}));
module.exports = r;
