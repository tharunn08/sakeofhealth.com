/**
 * ERP HTTP helpers. Errors written for users carry `expose: true`, a status and
 * optionally a short lowercase `code` (e.g. 'mfa_required') that screens can act on.
 * Anything else is handed to the B2B error handler, which never leaks internals.
 */
'use strict';
const b2b = require('../../b2b/lib/http.js');

function fail(status, message, code, extra) {
  return Object.assign(new Error(message), { status: status, expose: true, code: code, extra: extra });
}
const h = b2b.h;

function errorHandler(err, req, res, next) {
  if (res.headersSent) return;
  if (err && err.expose && err.status) {
    const body = Object.assign({ error: err.message }, err.extra || {});
    if (typeof err.code === 'string' && /^[a-z][a-z_]{1,40}$/.test(err.code)) body.code = err.code;   // never MySQL codes (ER_…)
    return res.status(err.status).json(body);
  }
  return b2b.errorHandler(err, req, res, next);
}

module.exports = { fail, h, errorHandler };

/** A positive integer id from user input, or 0. (db.int clamps to its minimum, so it is not used for ids.) */
function posId(v) {
  const s = typeof v === 'number' ? String(v) : String(v == null ? '' : v).trim();
  if (!/^[1-9]\d{0,15}$/.test(s)) return 0;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : 0;
}
module.exports.posId = posId;
