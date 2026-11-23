/**
 * /api/vendor — the vendor portal. Vendor tokens (audience 'vendor') only; staff,
 * B2B and B2C tokens are refused. Every handler uses req.vendor.vendorId from the
 * session for isolation.
 */
'use strict';
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const svc = require('../vendors/service.js');
const proc = require('../procurement/service.js');
const pret = require('../procurement/returns.js');
const mfg = require('../manufacturing/service.js');
const uploads = require('../../b2b/lib/uploads.js');

const r = express.Router();
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tight = rateLimit({ windowMs: 15 * 60000, max: process.env.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please wait and try again.' } });
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 10 } }).single('file');

r.post('/register', tight, h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return svc.register(t, req.body || {}, String(req.ip || '').slice(0, 45)); })); }));
r.post('/invite/accept', tight, h(async function (req, res) { res.json(await db.transaction(function (t) { return svc.acceptInvite(t, String((req.body || {}).token || ''), (req.body || {}).password, req.ip); })); }));
r.get('/states', h(async function (req, res) { res.json({ states: await db.query('SELECT id, name, gst_code FROM b2b_states ORDER BY name') }); }));
r.post('/auth/login', tight, h(async function (req, res) { res.json(await svc.login((req.body || {}).email, (req.body || {}).password, String(req.ip || '').slice(0, 45))); }));

r.use(svc.requireVendor);
r.get('/me', h(async function (req, res) { res.json(await svc.me(req.vendor)); }));
r.post('/documents', svc.vendorRole(['owner', 'accounts']), docUpload, h(async function (req, res) {
  svc.checkDocumentRequest(req.file, req.body);
  res.status(201).json(await uploads.withDocument(req.file, function (saved) {   // stored before the transaction, removed if it fails
    return db.transaction(function (t) { return svc.uploadDocument(t, req.vendor, saved, req.body || {}, req.ip); });
  }));
}));
r.post('/products', svc.vendorRole(['owner', 'sales']), h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return svc.submitProduct(t, req.vendor, req.body || {}); })); }));
r.get('/products', h(async function (req, res) { res.json(await svc.myProducts(req.vendor)); }));
r.put('/profile', svc.vendorRole(['owner']), h(async function (req, res) { res.json(await db.transaction(function (t) { return svc.updateProfile(t, req.vendor, req.body || {}); })); }));
r.put('/me/contact', h(async function (req, res) {
  const b = req.body || {};
  res.json(await db.transaction(function (t) { return svc.updateProfile(t, req.vendor, { contactName: b.contactName, contactMobile: b.contactMobile }); }));
}));
// the vendor's own addresses, bank accounts (new accounts wait for our finance team), team sign-ins and capabilities
const vact = function (req) { return svc.vendorActor({ id: req.vendor.userId, role: req.vendor.role }, req); };
const vtx = function (fn) { return db.transaction(fn); };
r.get('/addresses', h(async function (req, res) { res.json({ items: await svc.listAddresses(req.vendor.vendorId) }); }));
r.post('/addresses', svc.vendorRole(['owner']), h(async function (req, res) { res.status(201).json(await vtx(function (t) { return svc.addAddress(t, vact(req), req.vendor.vendorId, req.body || {}); })); }));
r.delete('/addresses/:id', svc.vendorRole(['owner']), h(async function (req, res) { res.json(await vtx(function (t) { return svc.removeAddress(t, vact(req), req.vendor.vendorId, id(req.params.id)); })); }));
r.get('/bank-accounts', svc.vendorRole(['owner', 'accounts']), h(async function (req, res) { res.json({ items: await svc.listBankAccounts(req.vendor.vendorId) }); }));
r.post('/bank-accounts', svc.vendorRole(['owner', 'accounts']), h(async function (req, res) { res.status(201).json(await vtx(function (t) { return svc.addBankAccount(t, vact(req), req.vendor.vendorId, req.body || {}); })); }));
r.get('/users', svc.vendorRole(['owner']), h(async function (req, res) { res.json({ items: await svc.listUsers(req.vendor.vendorId) }); }));
r.post('/users', svc.vendorRole(['owner']), h(async function (req, res) { res.status(201).json(await vtx(function (t) { return svc.addUser(t, vact(req), req.vendor.vendorId, req.body || {}); })); }));
r.post('/users/:id/reset-password', svc.vendorRole(['owner']), h(async function (req, res) {
  if (id(req.params.id) === req.vendor.userId) return res.status(409).json({ error: 'Change your own password at /login' });
  res.json(await vtx(function (t) { return svc.resetUserPassword(t, vact(req), req.vendor.vendorId, id(req.params.id)); }));
}));
r.post('/users/:id/status', svc.vendorRole(['owner']), h(async function (req, res) { res.json(await vtx(function (t) { return svc.setUserStatus(t, vact(req), req.vendor.vendorId, id(req.params.id), String((req.body || {}).status || ''), req.vendor.userId); })); }));
r.post('/capabilities', svc.vendorRole(['owner']), h(async function (req, res) { res.status(201).json(await vtx(function (t) { return svc.requestCapability(t, req.vendor, String((req.body || {}).capability || '')); })); }));
r.post('/price-lists', svc.vendorRole(['owner', 'sales']), h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return svc.submitPrice(t, req.vendor, req.body || {}); })); }));

r.use(svc.requireApprovedVendor);
r.get('/rfqs', h(async function (req, res) { res.json(await proc.vendorRfqs(req.vendor)); }));
r.get('/rfqs/:id', h(async function (req, res) { res.json(await proc.vendorRfq(req.vendor, id(req.params.id))); }));
r.post('/rfqs/:id/responses', svc.vendorRole(['owner', 'sales']), h(async function (req, res) {
  res.status(201).json(await db.transaction(function (t) { return proc.submitResponse(t, req.vendor, id(req.params.id), req.body || {}); }));
}));
r.get('/purchase-orders', h(async function (req, res) { res.json(await proc.vendorPos(req.vendor)); }));
r.get('/purchase-orders/:id', h(async function (req, res) { res.json(await proc.vendorPo(req.vendor, id(req.params.id))); }));
r.post('/purchase-orders/:id/acknowledge', svc.vendorRole(['owner', 'sales']), h(async function (req, res) {
  res.json(await db.transaction(function (t) { return proc.acknowledge(t, req.vendor, id(req.params.id), req.body || {}); }));
}));
r.post('/asns', svc.vendorRole(['owner', 'dispatch']), h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return proc.createAsn(t, req.vendor, req.body || {}); })); }));
r.get('/purchase-returns', h(async function (req, res) { res.json(await pret.vendorList(req.vendor)); }));
r.get('/purchase-returns/:id', h(async function (req, res) { res.json(await pret.vendorDetail(req.vendor, id(req.params.id))); }));
r.post('/purchase-returns/:id/acknowledge', svc.vendorRole(['owner', 'dispatch', 'accounts']), h(async function (req, res) {
  res.json(await db.transaction(function (t) { return pret.vendorAcknowledge(t, req.vendor, id(req.params.id), (req.body || {}).note); }));
}));
// ── manufacturer workspace: manufacturing orders, production updates, batches, documents, deliveries, accounts ──
const tx = function (fn) { return db.transaction(fn); };
r.get('/manufacturing-orders', h(async function (req, res) { res.json(await mfg.listMos(req.query, req.vendor.vendorId)); }));
r.get('/manufacturing-orders/:id', h(async function (req, res) { res.json(await mfg.moDetail(id(req.params.id), req.vendor.vendorId)); }));
r.post('/manufacturing-orders/:id/respond', svc.vendorRole(['owner', 'sales']), h(async function (req, res) {
  res.json(await tx(function (t) { return mfg.vendorRespond(t, req.vendor, id(req.params.id), req.body || {}); }));
}));
r.post('/manufacturing-orders/:id/progress', svc.vendorRole(['owner', 'dispatch']), h(async function (req, res) {
  res.json(await tx(function (t) { return mfg.vendorProgress(t, req.vendor, id(req.params.id), req.body || {}); }));
}));
r.post('/manufacturing-orders/:id/batches', svc.vendorRole(['owner', 'dispatch']), h(async function (req, res) {
  res.status(201).json(await tx(function (t) { return mfg.vendorBatch(t, req.vendor, id(req.params.id), req.body || {}); }));
}));
r.post('/manufacturing-orders/:id/documents', svc.vendorRole(['owner', 'dispatch']), docUpload, h(async function (req, res) {
  mfg.checkDocumentRequest(req.file, req.body);
  res.status(201).json(await uploads.withDocument(req.file, function (saved) {
    return tx(function (t) { return mfg.vendorDocument(t, req.vendor, id(req.params.id), saved, req.body || {}); });
  }));
}));
r.get('/manufacturing-documents/:id/file', h(async function (req, res) {
  const f = await mfg.documentFile(db, id(req.params.id), req.vendor.vendorId);
  await f.send(res, { 'Content-Type': f.mime, 'Content-Disposition': 'inline; filename="document"', 'X-Content-Type-Options': 'nosniff' });
}));
r.get('/deliveries', h(async function (req, res) { res.json(await mfg.asnList({ vendorId: req.vendor.vendorId })); }));
r.get('/accounts', svc.vendorRole(['owner', 'accounts']), h(async function (req, res) { res.json(await mfg.vendorAccounts(req.vendor)); }));
module.exports = r;
