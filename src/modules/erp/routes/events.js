/**
 * /api/erp/events — events (stalls) and counter sales (3b.5). Staff with events.manage run
 * events; event staff (events.sell) sell only at events they are assigned to.
 */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../events/service.js');
const invoice = require('../events/invoice.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
const B = function (req) { return req.body || {}; };
r.use(identity.requireStaff);

r.get('/', can('events.view'), h(async function (req, res) { res.json(await svc.listEvents(req.erp, req.query)); }));
r.post('/', can('events.manage'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createEvent(t, a, req.erp, B(req)); })); }));
r.get('/report', can('events.view'), h(async function (req, res) { res.json(await svc.report(req.erp, req.query)); }));
r.get('/sales', can('events.view'), h(async function (req, res) { res.json(await svc.listSales(req.erp, req.query)); }));
r.post('/sales', can('events.sell'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.sell(t, a, req.erp, B(req)); })); }));
r.get('/sales/:id', can('events.view'), h(async function (req, res) { res.json(await svc.getSale(req.erp, id(req.params.id))); }));
r.get('/sales/:id/invoice', can('events.view'), h(async function (req, res) {
  const sale = await svc.getSale(req.erp, id(req.params.id));
  const seller = await require('../../b2b/invoices/service.js').sellerCard('company', null);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  if (req.query.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="invoice-' + sale.invoiceNo.replace(/[^A-Za-z0-9-]/g, '-') + '.html"');
  res.type('html').send(invoice.render(sale, seller));
}));
r.post('/sales/:id/payments', can('events.sell'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.addPayment(t, a, req.erp, id(req.params.id), B(req)); })); }));
r.post('/sales/:id/returns', can('events.sell'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.returnItems(t, a, req.erp, id(req.params.id), B(req)); })); }));
r.post('/sales/:id/void', can('events.sales.void'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.voidSale(t, a, req.erp, id(req.params.id), B(req)); })); }));
r.get('/:id', can('events.view'), h(async function (req, res) { res.json(await svc.getEvent(req.erp, id(req.params.id))); }));
r.get('/:id/stock', can('events.view'), h(async function (req, res) { res.json(await svc.eventStock(req.erp, id(req.params.id))); }));
r.post('/:id/status', can('events.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.setStatus(t, a, req.erp, id(req.params.id), B(req).status); })); }));
r.put('/:id/staff', can('events.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.setStaff(t, a, req.erp, id(req.params.id), B(req).staffIds); })); }));

module.exports = r;
