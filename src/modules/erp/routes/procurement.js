/** /api/erp/procurement — requisitions, RFQs, POs, GRNs, supplier invoices and payments. */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../procurement/service.js');
const pret = require('../procurement/returns.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
const B = function (req) { return req.body || {}; };
r.use(identity.requireStaff);

r.post('/requisitions', can('procurement.pr.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createRequisition(t, a, req.erp, B(req)); })); }));
r.post('/requisitions/:id/submit', can('procurement.pr.create'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return svc.submitRequisition(t, a, id(req.params.id), B(req).reason); })); }));
r.get('/reorder-suggestions', can('procurement.pr.view'), h(async function (req, res) { res.json(await svc.reorderSuggestions(req.query)); }));
r.put('/reorder-rules', can('procurement.po.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.setReorderRule(t, a, B(req)); })); }));

r.post('/rfqs', can('procurement.rfq.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createRfq(t, a, B(req)); })); }));
r.get('/rfqs/:id/comparison', can('procurement.rfq.view'), h(async function (req, res) { res.json(await svc.comparison(id(req.params.id))); }));
r.post('/rfqs/:id/award', can('procurement.rfq.award'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.award(t, a, id(req.params.id), B(req)); })); }));

r.get('/purchase-orders', can('procurement.pr.view'), h(async function (req, res) { res.json(await svc.listPos(req.query)); }));
r.post('/purchase-orders', can('procurement.po.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createPo(t, a, B(req)); })); }));
r.get('/purchase-orders/:id', can('procurement.pr.view'), h(async function (req, res) { res.json(await svc.poDetail(id(req.params.id))); }));
r.post('/purchase-orders/:id/submit', can('procurement.po.create'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return svc.submitPo(t, a, id(req.params.id), B(req).reason); })); }));
r.post('/purchase-orders/:id/send', can('procurement.po.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.sendPo(t, a, id(req.params.id)); })); }));
r.post('/purchase-orders/:id/cancel', can('procurement.po.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.cancelPo(t, a, id(req.params.id), B(req).reason); })); }));

r.get('/grns', can('inventory.view'), h(async function (req, res) { res.json(await svc.listGrns(req.query)); }));
r.post('/grns', can('warehouse.grn.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createGrn(t, a, req.erp, B(req)); })); }));
r.post('/grns/:id/post', can('warehouse.grn.post'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.postGrn(t, a, req.erp, id(req.params.id), B(req).reason); })); }));

r.get('/supplier-invoices', can('finance.payables.view'), h(async function (req, res) { res.json(await svc.listInvoices(req.query)); }));
r.post('/supplier-invoices', can('finance.payables.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.enterInvoice(t, a, B(req)); })); }));
r.post('/supplier-invoices/:id/match', can('finance.payables.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.match(t, a, id(req.params.id)); })); }));
r.post('/supplier-invoices/:id/match-results/:resultId/resolve', can('finance.payables.pay'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.resolveMatch(t, a, id(req.params.id), id(req.params.resultId), B(req)); }));
}));
r.post('/supplier-payments', can('finance.payables.create'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return svc.createPayment(t, a, B(req)); })); }));
r.post('/supplier-payments/:id/mark-paid', can('finance.payables.pay'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.markPaid(t, a, id(req.params.id), B(req)); })); }));

// purchase returns to vendors (debit notes)
r.get('/purchase-returns', can('procurement.pr.view'), h(async function (req, res) { res.json(await pret.list(req.query)); }));
r.post('/purchase-returns', can('procurement.po.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return pret.create(t, a, req.erp, B(req)); })); }));
r.post('/purchase-returns/:id/submit', can('procurement.po.create'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return pret.submit(t, a, id(req.params.id), B(req).reason); })); }));
r.post('/purchase-returns/:id/dispatch', can('warehouse.grn.post'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return pret.dispatch(t, a, req.erp, id(req.params.id), B(req)); })); }));
r.post('/purchase-returns/:id/settle', can('finance.payables.pay'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return pret.settle(t, a, id(req.params.id), B(req)); })); }));
module.exports = r;
