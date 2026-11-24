/**
 * /api/erp/insights — Smart Insights (read only; no outside service). The page needs
 * reports.export; each section also needs the permission for the data it shows, and a role whose
 * scope is the whole business (insights add up every territory and warehouse).
 */
'use strict';
const express = require('express');
const { h } = require('../lib/http.js');
const identity = require('../core/identity.js');
const svc = require('../insights/service.js');

const r = express.Router();
const can = identity.can;
r.use(identity.requireStaff);
r.use(can('reports.export'));
r.use(function (req, res, next) { try { svc.assertWholeBusiness(req.erp); next(); } catch (e) { next(e); } });

r.get('/summary', h(async function (req, res) { res.json(await svc.summary(req.erp.permissions)); }));
r.get('/forecast', can('sales.reports.view'), h(async function (req, res) { res.json(await svc.forecast()); }));
r.get('/stock', can('inventory.view'), h(async function (req, res) { res.json(await svc.stock()); }));
r.get('/customers', can('customers.view'), h(async function (req, res) { res.json(await svc.customers()); }));
r.get('/alerts', can('sales.reports.view'), h(async function (req, res) { res.json(await svc.alerts()); }));
r.get('/recommendations', can('sales.reports.view'), h(async function (req, res) { res.json(await svc.recommendations()); }));

module.exports = r;
