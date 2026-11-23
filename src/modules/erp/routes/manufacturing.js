/**
 * /api/erp/manufacturing — manufacturers, facilities, bills of materials, manufacturing orders,
 * batches and QC release (migration 020). Every write is audited; stock moves only through the ledger.
 */
'use strict';
const express = require('express');
const multer = require('multer');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const uploads = require('../../b2b/lib/uploads.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../manufacturing/service.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
const B = function (req) { return req.body || {}; };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 10 } }).single('file');
r.use(identity.requireStaff);

r.get('/lookups', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.lookups()); }));
r.get('/manufacturers', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.listManufacturers(req.query)); }));
r.get('/manufacturers/:id', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.manufacturerDetail(id(req.params.id))); }));
r.get('/deliveries', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.asnList({ vendorId: posId(req.query.vendorId) || null, late: req.query.late === '1', status: req.query.status })); }));

r.get('/facilities', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.listFacilities(req.query)); }));
r.post('/facilities', can('manufacturing.manage'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.saveFacility(t, a, B(req)); })); }));
r.put('/facilities/:id', can('manufacturing.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.saveFacility(t, a, B(req), id(req.params.id)); })); }));

r.get('/boms', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.listBoms(req.query)); }));
r.get('/boms/:id', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.bomDetail(db, id(req.params.id))); }));
r.post('/boms', can('manufacturing.manage'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createBom(t, a, B(req)); })); }));
r.post('/boms/:id/activate', can('manufacturing.bom.approve'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.activateBom(t, a, id(req.params.id)); })); }));
r.post('/boms/:id/archive', can('manufacturing.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.archiveBom(t, a, id(req.params.id)); })); }));

r.get('/orders', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.listMos(req.query)); }));
r.post('/orders', can('manufacturing.manage'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createMo(t, a, B(req)); })); }));
r.get('/orders/:id', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.moDetail(id(req.params.id))); }));
r.post('/orders/:id/release', can('manufacturing.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.releaseMo(t, a, id(req.params.id)); })); }));
r.post('/orders/:id/cancel', can('manufacturing.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.cancelMo(t, a, id(req.params.id), B(req).reason); })); }));
r.post('/orders/:id/complete', can('manufacturing.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.completeMo(t, a, id(req.params.id)); })); }));
r.post('/orders/:id/close', can('manufacturing.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.closeMo(t, a, id(req.params.id)); })); }));
r.post('/orders/:id/progress', can('manufacturing.manage'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.staffProgress(t, a, id(req.params.id), B(req)); })); }));
r.post('/orders/:id/materials/issue', can('manufacturing.issue'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.issueMaterials(t, a, id(req.params.id), B(req)); })); }));
r.post('/orders/:id/materials/return', can('manufacturing.issue'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.returnMaterials(t, a, id(req.params.id), B(req)); })); }));
r.post('/orders/:id/batches', can('manufacturing.issue'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.staffBatch(t, a, id(req.params.id), B(req)); })); }));
r.post('/orders/:id/documents', can('manufacturing.manage'), upload, h(async function (req, res) {
  svc.checkDocumentRequest(req.file, B(req));
  res.status(201).json(await uploads.withDocument(req.file, function (saved) {   // stored before the transaction, removed if it fails
    return tx(req, function (t, a) { return svc.staffDocument(t, a, id(req.params.id), saved, B(req)); });
  }));
}));
r.get('/documents/:id/file', can('manufacturing.view'), h(async function (req, res) {
  const f = await svc.documentFile(db, id(req.params.id));
  await f.send(res, { 'Content-Type': f.mime, 'Content-Disposition': 'inline; filename="document"', 'X-Content-Type-Options': 'nosniff' }, function () {
    return audit.write(null, audit.actorFrom(req), { module: 'manufacturing', action: 'mfg_document.viewed', entity: 'mfg_document', entityId: req.params.id });
  });
}));

r.get('/batches', can('manufacturing.view'), h(async function (req, res) { res.json(await svc.listBatches(req.query)); }));
r.post('/batches/:id/qc', can('manufacturing.qc.release'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.qcDecide(t, a, id(req.params.id), B(req)); })); }));

module.exports = r;
