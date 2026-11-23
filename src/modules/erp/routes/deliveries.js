/**
 * /api/erp/deliveries — shipments of trade orders (migration 020). deliveries.view sees all,
 * deliveries.manage creates and dispatches, deliveries.update (delivery staff) works the shipments
 * assigned to them. Every step drives the existing order flow.
 */
'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../delivery/service.js');

const r = express.Router();
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const B = function (req) { return req.body || {}; };
const by = function (req) { return { staff: req.erp }; };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 30 } }).single('file');
function any() {
  const list = Array.prototype.slice.call(arguments);
  return function (req, res, next) {
    if (!req.erp) return res.status(401).json({ error: 'Please log in to continue' });
    if (!list.some(function (p) { return req.erp.permissions.has(p); })) return res.status(403).json({ error: 'You do not have permission to do that', required: list.join(' or ') });
    next();
  };
}
const SEE = any('deliveries.view', 'deliveries.manage', 'deliveries.update');
const MANAGE = identity.can('deliveries.manage');
r.use(identity.requireStaff);

r.get('/', SEE, h(async function (req, res) { res.json(await svc.list(by(req), req.query)); }));
r.get('/summary', any('deliveries.view', 'deliveries.manage'), h(async function (req, res) { res.json(await svc.summary()); }));
r.get('/staff', MANAGE, h(async function (req, res) { res.json(await svc.deliveryStaff()); }));
r.post('/', MANAGE, h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return svc.create(t, audit.actorFrom(req), by(req), B(req)); })); }));
r.get('/:id', SEE, h(async function (req, res) { res.json(await svc.detail(by(req), id(req.params.id))); }));
r.put('/:id', MANAGE, h(async function (req, res) { res.json(await db.transaction(function (t) { return svc.update(t, audit.actorFrom(req), by(req), id(req.params.id), B(req)); })); }));
r.post('/:id/dispatch', MANAGE, h(async function (req, res) { res.json(await svc.dispatch(audit.actorFrom(req), by(req), id(req.params.id), B(req))); }));
r.post('/:id/out-for-delivery', SEE, h(async function (req, res) { res.json(await svc.outForDelivery(audit.actorFrom(req), by(req), id(req.params.id), B(req))); }));
r.post('/:id/location', SEE, h(async function (req, res) { res.json(await svc.location(audit.actorFrom(req), by(req), id(req.params.id), B(req))); }));
r.post('/:id/attempt-failed', SEE, h(async function (req, res) { res.json(await svc.attemptFailed(audit.actorFrom(req), by(req), id(req.params.id), B(req))); }));
r.post('/:id/delivered', SEE, upload, h(async function (req, res) {
  const b = Object.assign({}, B(req));
  if (typeof b.delivered === 'string') { try { b.delivered = JSON.parse(b.delivered); } catch (e) { return res.status(400).json({ error: 'delivered must be JSON' }); } }
  res.json(await svc.deliver(audit.actorFrom(req), by(req), id(req.params.id), b, req.file));
}));
r.post('/:id/return', MANAGE, h(async function (req, res) { res.json(await svc.returnToWarehouse(audit.actorFrom(req), by(req), id(req.params.id), B(req))); }));
r.get('/:id/proof', SEE, h(async function (req, res) {
  const f = await svc.proof(by(req), id(req.params.id));
  await f.send(res, { 'Content-Type': f.mime, 'Content-Disposition': 'inline; filename="proof-of-delivery"', 'X-Content-Type-Options': 'nosniff' });
}));
r.get('/:id/challan', SEE, h(async function (req, res) {
  const html = await svc.challan(by(req), { shipmentId: id(req.params.id) });
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  res.type('html').send(html);
}));

module.exports = r;
