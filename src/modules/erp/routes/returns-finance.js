/** /api/erp/returns, /api/erp/recalls, /api/erp/finance */
'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const ret = require('../returns/service.js');
const fin = require('../finance/service.js');
const notes = require('../finance/notes.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
const B = function (req) { return req.body || {}; };
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } }).single('file');
r.use(identity.requireStaff);

r.post('/returns/:id/inspect', can('returns.inspect'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return ret.inspect(t, a, req.erp, id(req.params.id), B(req)); })); }));

r.get('/recalls', can('recalls.view'), h(async function (req, res) { res.json(await ret.list()); }));
r.post('/recalls', can('recalls.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return ret.createRecall(t, a, B(req)); })); }));
r.post('/recalls/:id/activate', can('recalls.activate'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return ret.activate(t, a, id(req.params.id)); })); }));
r.get('/recalls/:id/reconciliation', can('recalls.view'), h(async function (req, res) { res.json(await ret.reconciliation(id(req.params.id))); }));
r.post('/recalls/:id/parties/:partyId', can('recalls.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return ret.updateParty(t, a, id(req.params.id), id(req.params.partyId), B(req)); })); }));
r.post('/recalls/:id/receipts', can('returns.inspect'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return ret.receive(t, a, req.erp, id(req.params.id), B(req)); })); }));
r.post('/recalls/:id/close', can('recalls.close'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return ret.requestClose(t, a, id(req.params.id), B(req).reason); })); }));

r.post('/finance/payments/:id/allocations', can('finance.receivables.allocate'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return fin.allocate(t, a, id(req.params.id), B(req)); })); }));
r.get('/finance/ageing', can('finance.reports.view'), h(async function (req, res) { res.json(await fin.ageing(req.query)); }));
r.post('/finance/bank-accounts', can('finance.bank.import'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return fin.addBankAccount(t, a, B(req)); })); }));
r.post('/finance/bank-statements', can('finance.bank.import'), csvUpload, h(async function (req, res) {
  res.status(201).json(await tx(req, function (t, a) { return fin.importStatement(t, a, posId((req.body || {}).bankAccountId), req.file); }));
}));
r.get('/finance/bank-lines', can('finance.bank.reconcile'), h(async function (req, res) { res.json(await fin.lines(req.query)); }));
r.post('/finance/bank-lines/:id/match', can('finance.bank.reconcile'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return fin.matchLine(t, a, id(req.params.id), B(req)); })); }));

r.post('/finance/debit-notes', can('finance.receivables.allocate'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return notes.createDebitNote(t, a, B(req)); })); }));
r.get('/finance/settlements', can('finance.reports.view'), h(async function (req, res) { res.json(await notes.listSettlements(req.query)); }));
r.post('/finance/settlements', can('finance.payables.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return notes.createSettlement(t, a, B(req)); })); }));
r.post('/finance/settlements/:id/submit', can('finance.payables.create'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return notes.submitSettlement(t, a, id(req.params.id), B(req).reason); })); }));
r.post('/finance/settlements/:id/mark-settled', can('finance.payables.pay'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return notes.markSettled(t, a, id(req.params.id), B(req)); })); }));
r.post('/finance/settlements/:id/cancel', can('finance.payables.create'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return notes.cancelSettlement(t, a, id(req.params.id), B(req).reason); })); }));
module.exports = r;
