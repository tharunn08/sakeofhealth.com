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

const r = express.Router();
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tight = rateLimit({ windowMs: 15 * 60000, max: process.env.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please wait and try again.' } });
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 10 } }).single('file');

r.post('/register', tight, h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return svc.register(t, req.body || {}, String(req.ip || '').slice(0, 45)); })); }));
r.post('/invite/accept', tight, h(async function (req, res) { res.json(await db.transaction(function (t) { return svc.acceptInvite(t, String((req.body || {}).token || ''), (req.body || {}).password, req.ip); })); }));
r.post('/auth/login', tight, h(async function (req, res) { res.json(await svc.login((req.body || {}).email, (req.body || {}).password, String(req.ip || '').slice(0, 45))); }));

r.use(svc.requireVendor);
r.get('/me', h(async function (req, res) { res.json(await svc.me(req.vendor)); }));
r.post('/documents', svc.vendorRole(['owner', 'accounts']), docUpload, h(async function (req, res) {
  res.status(201).json(await db.transaction(function (t) { return svc.uploadDocument(t, req.vendor, req.file, req.body || {}, req.ip); }));
}));
r.post('/products', svc.vendorRole(['owner', 'sales']), h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return svc.submitProduct(t, req.vendor, req.body || {}); })); }));
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
module.exports = r;
