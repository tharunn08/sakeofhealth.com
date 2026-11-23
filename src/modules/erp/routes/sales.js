/**
 * /api/sales — the salesman app API (ERP staff tokens; salesman role + salesman record),
 * and /api/erp/sales — the office side (salesmen, collection handover).
 */
'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../sales/service.js');
const officeSvc = require('../sales/office.js');
const team = require('../sales/team.js');

const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const tx = function (req, fn) { return db.transaction(function (t) { return fn(t, audit.actorFrom(req)); }); };
const B = function (req) { return req.body || {}; };
const otpLimit = rateLimit({ windowMs: 10 * 60000, max: process.env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many code attempts. Please wait.' } });

const app = express.Router();
app.use(identity.requireStaff, svc.requireSalesman);
app.get('/me', can('sales.self.view'), h(async function (req, res) { res.json(await svc.me(req.erp, req.salesman)); }));
app.get('/dashboard', can('sales.self.view'), h(async function (req, res) { res.json(await team.dashboard(req.salesman)); }));
app.get('/retailers', can('sales.retailers.view'), h(async function (req, res) { res.json(await svc.retailers(req.erp, req.salesman, req.query)); }));
app.post('/retailers', can('sales.retailers.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.registerRetailer(t, a, req.erp, req.salesman, B(req)); })); }));
app.get('/catalogue', can('sales.catalogue.view'), h(async function (req, res) { res.json(await svc.catalogue(req.erp, req.salesman, req.query)); }));
app.post('/orders', can('sales.orders.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.createOrder(t, a, req.erp, req.salesman, B(req)); })); }));
app.post('/orders/:id/otp/resend', can('sales.orders.create'), otpLimit, h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.resend(t, a, req.erp, req.salesman, id(req.params.id)); })); }));
app.post('/orders/:id/otp/verify', can('sales.orders.create'), otpLimit, h(async function (req, res) {
  const r = await tx(req, function (t, a) { return svc.verify(t, a, req.erp, req.salesman, id(req.params.id), B(req).code); });
  if (r.ok === false) return res.status(r.status).json({ error: r.error, code: r.code, attemptsLeft: r.attemptsLeft });
  res.json(r);
}));
app.post('/orders/:id/otp-override', can('sales.otp.override.request'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return svc.requestOverride(t, a, req.erp, req.salesman, id(req.params.id), B(req).reason); })); }));
app.get('/orders/:id/recommendations', can('sales.orders.create'), h(async function (req, res) {
  const o = await db.queryOne('SELECT id, buyer_account_id FROM b2b_orders WHERE id = ? AND salesman_id = ?', [id(req.params.id), req.salesman.id]);
  if (!o) return res.status(404).json({ error: 'Not found' });
  // Products this retailer bought in the last 180 days that are not on this order — plain history, no model.
  res.json({ basis: 'purchase history (180 days)', items: await db.query(
    "SELECT oi.product_id, MAX(oi.name) AS name, COUNT(DISTINCT oi.order_id) AS times, SUM(oi.qty) AS qty FROM b2b_order_items oi JOIN b2b_orders x ON x.id = oi.order_id " +
    "WHERE x.buyer_account_id = ? AND x.id <> ? AND x.status NOT IN ('cancelled','rejected','otp_expired','pending_otp') AND x.created_at >= UTC_TIMESTAMP() - INTERVAL 180 DAY " +
    'AND oi.product_id NOT IN (SELECT product_id FROM b2b_order_items WHERE order_id = ?) GROUP BY oi.product_id ORDER BY times DESC, qty DESC LIMIT 10', [o.buyer_account_id, o.id, o.id]) });
}));
app.post('/visits', can('sales.visits.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.checkIn(t, a, req.erp, req.salesman, B(req)); })); }));
app.post('/collections', can('sales.collections.create'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.collect(t, a, req.erp, req.salesman, B(req)); })); }));

const office = express.Router();
office.use(identity.requireStaff);
office.get('/salesmen', can('sales.reports.view'), h(async function (req, res) { res.json(await team.list(req.query)); }));
office.get('/salesmen/lookups', can('core.staff.edit'), h(async function (req, res) { res.json(await team.lookups()); }));
office.get('/salesmen/:id', can('sales.reports.view'), h(async function (req, res) { res.json(await team.detail(id(req.params.id), req.query)); }));
office.put('/salesmen/:id', can('core.staff.edit'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return team.update(t, a, id(req.params.id), B(req)); })); }));
office.post('/salesmen', can('core.staff.edit'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return svc.addSalesman(t, a, B(req)); })); }));
office.post('/collections/:id/confirm', can('sales.collections.confirm'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return svc.confirmHandover(t, a, id(req.params.id)); })); }));
office.get('/collections/pending', can('sales.collections.confirm'), h(async function (req, res) {
  res.json({ items: await db.query("SELECT p.id, p.receipt_no, p.order_id, p.method, p.amount, p.reference, p.received_at, s.staff_id, st.name AS salesman FROM b2b_payments p JOIN b2b_salesmen s ON s.id = p.collected_by_salesman_id JOIN b2b_staff st ON st.id = s.staff_id WHERE p.status = 'pending' ORDER BY p.id LIMIT 500") });
}));

const off = officeSvc;
const desk = express.Router();
desk.use(identity.requireStaff);
desk.post('/office-orders', can('sales.office_orders.create'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return off.requestOfficeOrder(t, a, B(req)); })); }));
desk.post('/accounts', can('network.accounts.create'), h(async function (req, res) { res.status(202).json(await tx(req, function (t, a) { return off.createAccount(t, a, B(req)); })); }));
desk.get('/beats', can('sales.reports.view'), h(async function (req, res) { res.json(await off.listBeats(req.query)); }));
desk.post('/beats', can('sales.beats.edit'), h(async function (req, res) { res.status(201).json(await tx(req, function (t, a) { return off.saveBeat(t, a, B(req)); })); }));
desk.put('/beats/:id', can('sales.beats.edit'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return off.saveBeat(t, a, B(req), id(req.params.id)); })); }));
desk.put('/targets', can('sales.targets.edit'), h(async function (req, res) { res.json(await tx(req, function (t, a) { return off.setTarget(t, a, B(req)); })); }));
desk.get('/performance', can('sales.reports.view'), h(async function (req, res) { res.json(await off.performance(req.query)); }));

module.exports = { app: app, office: office, desk: desk };
