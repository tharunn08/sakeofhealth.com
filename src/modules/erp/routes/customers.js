/** /api/erp/customers — one customer record across shop, events, field sales and business accounts (N4). */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../customers/service.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
r.use(identity.requireStaff);

r.get('/', can('customers.view'), h(async function (req, res) { res.json(await svc.list(req.erp, req.query)); }));
r.get('/:id', can('customers.view'), h(async function (req, res) { res.json(await svc.detail(req.erp, id(req.params.id))); }));
// bring in the shop's customers and orders (read-only) and the business accounts; safe to repeat
r.post('/import', can('customers.link.manage'), h(async function (req, res) {
  const out = await svc.importAll();
  await audit.write(null, audit.actorFrom(req), { module: 'customers', action: 'customers.imported', entity: 'customers', entityId: 0, new: out });
  res.json(out);
}));
r.post('/links/:id/resolve', can('customers.link.manage'), h(async function (req, res) { res.json(await db.transaction(function (t) { return svc.resolveLink(t, audit.actorFrom(req), id(req.params.id), req.body || {}); })); }));

module.exports = r;
