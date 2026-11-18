/**
 * /api/erp/offline — the offline queue (3b.6). Devices send what they queued (/sync); staff see
 * every operation and settle conflicts and failures (retry, resolve by hand, discard with a note).
 */
'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../offline/service.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const syncLimit = rateLimit({ windowMs: 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 1000 : 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many syncs; the app will try again shortly.' } });
r.use(identity.requireStaff);

// any signed-in staff member syncs their own operations; each kind checks its own permission
r.post('/sync', syncLimit, h(async function (req, res) { res.json(await svc.sync(req.erp, audit.actorFrom(req), (req.body || {}).ops)); }));
r.get('/ops', h(async function (req, res) { res.json(await svc.list(req.erp, req.query)); }));
r.get('/ops/:id', h(async function (req, res) { res.json(await svc.detail(req.erp, id(req.params.id))); }));
r.post('/ops/:id/retry', can('offline.resolve'), h(async function (req, res) { res.json(await svc.retry(req.erp, audit.actorFrom(req), id(req.params.id))); }));
r.post('/ops/:id/resolve', can('offline.resolve'), h(async function (req, res) { res.json(await db.transaction(function (t) { return svc.close(t, req.erp, audit.actorFrom(req), id(req.params.id), 'resolve', (req.body || {}).note); })); }));
r.post('/ops/:id/discard', can('offline.resolve'), h(async function (req, res) { res.json(await db.transaction(function (t) { return svc.close(t, req.erp, audit.actorFrom(req), id(req.params.id), 'discard', (req.body || {}).note); })); }));

module.exports = r;
