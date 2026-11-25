/** /api/erp/public/invoice?t= — a counter invoice for the customer, by signed link (read-only; no sign-in). */
'use strict';
const express = require('express');
const events = require('../events/service.js');
const invoice = require('../events/invoice.js');

const r = express.Router();
r.get('/invoice', function (req, res) {
  const saleId = events.readInvoiceToken(req.query.t);
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  if (!saleId) return res.status(400).type('html').send('<!doctype html><meta charset="utf-8"><title>Invoice</title><p style="font-family:Arial">This invoice link is not valid.</p>');
  Promise.all([events.saleView(null, saleId), require('../../b2b/invoices/service.js').sellerCard('company', null), require('../../../platform/branding.js').billLogo()]).then(function (x) {
    res.type('html').send(invoice.render(x[0], x[1], x[2]));
  }).catch(function (e) {
    if (e && e.status === 404) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Invoice</title><p style="font-family:Arial">Invoice not found.</p>');
    console.error('[INVOICE]', e.code || e.message);
    res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Invoice</title><p style="font-family:Arial">Please try again in a few minutes.</p>');
  });
});
module.exports = r;
