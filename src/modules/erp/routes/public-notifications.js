/**
 * /api/erp/public/unsubscribe — the link at the foot of every promotional email (D4).
 * Opening the link only shows a confirmation page (mail scanners open links); the opt-out is
 * recorded when the person presses the button. The link carries a signed hash, never an address.
 */
'use strict';
const express = require('express');
const consent = require('../notifications/consent.js');

const r = express.Router();
const brand = function () { return process.env.BRAND_NAME || 'Sake of Health'; };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function page(res, status, title, body) {
  res.status(status).set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'").type('html').send(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>' + esc(title) + '</title></head><body style="font-family:Arial,sans-serif;background:#f6f7f4;color:#16261a;margin:0;padding:40px 16px">' +
    '<main style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e4e8e0;border-radius:12px;padding:28px">' +
    '<p style="margin:0 0 6px;font-weight:700;color:#2f5d1f">' + esc(brand()) + '</p><h1 style="font-size:20px;margin:0 0 12px">' + esc(title) + '</h1>' + body + '</main></body></html>');
}

r.get('/unsubscribe', function (req, res) {
  const t = String(req.query.t || '');
  if (!consent.readToken(t)) return page(res, 400, 'This link is not valid', '<p style="line-height:1.5">The unsubscribe link is incomplete or was changed. Please use the link from the email, or reply to the email and ask us to stop.</p>');
  page(res, 200, 'Stop receiving offers by email?', '<p style="line-height:1.5">You will no longer receive promotional emails from us at this address. Messages about your orders, payments and account are not affected.</p>' +
    '<form method="post" action="unsubscribe"><input type="hidden" name="t" value="' + esc(t) + '"><button type="submit" style="background:#2f5d1f;color:#fff;border:0;border-radius:8px;padding:11px 18px;font-size:15px;cursor:pointer">Stop offers by email</button></form>');
});

r.post('/unsubscribe', express.urlencoded({ extended: false, limit: '4kb' }), function (req, res) {
  consent.unsubscribe((req.body && req.body.t) || req.query.t).then(function () {
    page(res, 200, 'You will not receive offers by email', '<p style="line-height:1.5">Done. If you change your mind, ask us or turn offers back on in the business portal under Profile.</p>');
  }).catch(function (e) {
    if (e.code === 'bad_token') return page(res, 400, 'This link is not valid', '<p>The unsubscribe link is incomplete or was changed.</p>');
    console.error('[UNSUBSCRIBE]', e.code || e.message);
    page(res, 503, 'Please try again', '<p>We could not record this just now. Please try again in a few minutes.</p>');
  });
});

module.exports = r;
