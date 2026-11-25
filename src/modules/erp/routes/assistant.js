/**
 * /api/erp/assistant — the AI assistant (assistant/service.js). Switched off until the provider
 * and key are set in the server environment AND a Super Admin switches it on.
 */
'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { h } = require('../lib/http.js');
const db = require('../../../db/connection.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../assistant/service.js');

const r = express.Router();
const can = identity.can;
const askLimit = rateLimit({ windowMs: 60000, max: process.env.NODE_ENV === 'test' ? 1000 : 6, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Please wait a minute before asking again.' } });
r.use(identity.requireStaff);

r.get('/status', h(async function (req, res) {
  res.json(Object.assign(await svc.status(req.erp), { canSwitch: req.erp.permissions.has('core.settings.edit') }));
}));
r.post('/ask', can('reports.export'), askLimit, h(async function (req, res) {
  res.json(await svc.ask(req.erp, audit.actorFrom(req), req.body && req.body.question));
}));
r.put('/switch', can('core.settings.edit'), h(async function (req, res) {
  res.json(await db.transaction(function (t) { return svc.setSwitch(t, audit.actorFrom(req), req.body.on, req.body.reason); }));
}));

module.exports = r;
