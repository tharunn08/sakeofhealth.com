/** /api/erp/network — map, territories, bulk mapping, GSTIN checks. */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../network/service.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
const B = function (req) { return req.body || {}; };
r.use(identity.requireStaff);

r.get('/map', can('network.map.view'), h(async function (req, res) { res.json(await svc.map(req.erp, req.query)); }));
r.get('/distributors/:id/retailers', can('network.map.view'), h(async function (req, res) { res.json(await svc.distributorRetailers(req.erp, id(req.params.id))); }));
r.get('/territories', can('network.map.view'), h(async function (req, res) { res.json(await svc.listTerritories()); }));
r.post('/territories', can('network.territories.edit'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createTerritory(t, a, B(req)); })); }));
r.post('/territories/:id/assign-accounts', can('network.territories.edit'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.assignAccounts(t, a, id(req.params.id), B(req)); })); }));
r.post('/mappings/preview', can('network.mapping.edit'), h(async function (req, res) { res.json(await svc.mappingPreview(B(req))); }));
r.post('/mappings/apply', can('network.mapping.edit'), h(async function (req, res) { res.json(await svc.mappingApply(audit.actorFrom(req), B(req))); }));
r.post('/gst-verifications', can('network.gst.verify'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.verifyGstin(t, a, B(req)); })); }));
module.exports = r;
