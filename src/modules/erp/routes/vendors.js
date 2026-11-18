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
r.post('/vendors/invite', can('vendors.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.invite(t, a, req.body || {}); })); }));
r.get('/vendors/:id', can('vendors.view'), h(async function (req, res) { res.json(await svc.detail(id(req.params.id))); }));
r.get('/vendors/:id/documents/:docId/file', can('vendors.view'), h(async function (req, res) {
  const d = await db.queryOne('SELECT stored_name, mime_type, original_name FROM b2b_vendor_documents WHERE id = ? AND vendor_id = ?', [id(req.params.docId), id(req.params.id)]);
  const p = d && svc.documentFile(d);
  if (!p) return res.status(404).json({ error: 'Not found' });
  await audit.write(null, audit.actorFrom(req), { module: 'vendors', action: 'vendor.document_viewed', entity: 'vendor', entityId: req.params.id, new: { documentId: Number(req.params.docId) } });
  res.setHeader('Content-Type', d.mime_type); res.setHeader('Content-Disposition', 'inline; filename="document"'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(p);
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
  // the person who added the account cannot verify it
  res.json(await tx(req, async function (t, a) {
    const added = await t.queryOne("SELECT actor_id FROM b2b_audit_logs WHERE action = 'vendor.bank_added' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(req.params.id)]);
    if (added && Number(added.actor_id) === Number(a.id)) throw Object.assign(new Error('The person who added the bank account cannot verify it'), { status: 403, expose: true, code: 'maker_cannot_check' });
    return svc.verifyBankAccount(t, a, id(req.params.id), id(req.params.bankId), req.body || {});
  }));
}));
r.post('/vendor-products/:id/decide', can('vendors.products.approve'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.decideProduct(t, a, id(req.params.id), req.body || {}); }));
}));
r.post('/vendor-prices/:id/decide', can('vendors.products.approve'), h(async function (req, res) {
  res.json(await tx(req, function (t, a) { return svc.decidePrice(t, a, id(req.params.id), req.body || {}); }));
}));
module.exports = r;
