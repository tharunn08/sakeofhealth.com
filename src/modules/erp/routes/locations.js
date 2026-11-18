/** /api/erp/locations — salesman and event locations (3b.2): record, history, map, attendance. */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h } = require('../lib/http.js');
const identity = require('../core/identity.js');
const svc = require('../field/locations.js');

const r = express.Router();
const can = identity.can;
r.use(identity.requireStaff);
// a person records their own location (or their event's stall position)
r.post('/', can('locations.capture'), h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return svc.capture(t, req.erp, req.body || {}); })); }));
// everyone sees their own; locations.view sees everyone (enforced inside)
r.get('/', h(async function (req, res) { res.json(await svc.history(req.erp, req.query)); }));
r.get('/map', h(async function (req, res) { res.json(await svc.map(req.erp, req.query)); }));
r.get('/attendance', h(async function (req, res) { res.json(await svc.attendance(req.erp, req.query)); }));

module.exports = r;
