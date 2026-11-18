/**
 * Small HTTP helpers shared by every B2B route: typed errors, async handler
 * wrapper, pagination/sort parsing and a safe error responder.
 */
const db = require('../../../db/connection.js');

class AppError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.expose = true;
    if (extra) this.extra = extra;
  }
}
const bad = (msg, extra) => new AppError(400, msg, extra);
const notFound = (msg) => new AppError(404, msg || 'Not found');
const forbidden = (msg) => new AppError(403, msg || 'You do not have permission to do that');
const conflict = (msg, extra) => new AppError(409, msg, extra);

/** Wrap an async route so rejections reach the error handler. */
function h(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** ?page=&limit= → { page, limit, offset } with hard caps (never returns unbounded lists). */
function paging(q, defLimit, maxLimit) {
  const limit = db.int(q.limit, defLimit || 25, 1, maxLimit || 100);
  const page = db.int(q.page, 1, 1, 100000);
  return { page: page, limit: limit, offset: (page - 1) * limit };
}

/** ?sort=field&dir=desc → 'col DESC' using a whitelist, so user input never reaches ORDER BY. */
function sorting(q, allowed, fallback) {
  const col = allowed[q.sort];
  if (!col) return fallback;
  return col + (String(q.dir).toLowerCase() === 'asc' ? ' ASC' : ' DESC');
}

function paged(rows, total, pg) {
  total = Number(total) || 0;
  return { items: rows, total: total, page: pg.page, limit: pg.limit, pages: Math.max(1, Math.ceil(total / pg.limit)) };
}

/** LIKE pattern with wildcards escaped. */
function like(term, mode) {
  const t = String(term).replace(/[\\%_]/g, '\\$&');
  return mode === 'prefix' ? t + '%' : '%' + t + '%';
}

const MYSQL_DOWN = { ECONNREFUSED: 1, PROTOCOL_CONNECTION_LOST: 1, ETIMEDOUT: 1, ENOTFOUND: 1, ER_ACCESS_DENIED_ERROR: 1,
  ER_CON_COUNT_ERROR: 1, DB_NOT_CONFIGURED: 1, ER_BAD_DB_ERROR: 1, EHOSTUNREACH: 1, ECONNRESET: 1 };

/**
 * Error handler for the B2B routers. Never leaks SQL, stack traces or paths:
 * only AppError messages (written for users) are sent to the client.
 */
function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  if (err && err.expose && err.status) {
    return res.status(err.status).json(Object.assign({ error: err.message }, err.extra || {}));
  }
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : 'Upload rejected (' + err.code + ')';
    return res.status(400).json({ error: msg });
  }
  if (err && (MYSQL_DOWN[err.code] || err.code === 'ER_NO_SUCH_TABLE')) {
    console.error('[B2B] database unavailable:', err.code, req.method, req.originalUrl);
    const msg = err.code === 'ER_NO_SUCH_TABLE'
      ? 'The business database has not been set up yet. Ask an administrator to run the database migration.'
      : 'The business portal is temporarily unavailable. Please try again shortly.';
    return res.status(503).json({ error: msg });
  }
  console.error('[B2B ERROR]', req.method, req.originalUrl, '-', err && (err.code || ''), err && err.message);
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test' && err && err.stack) console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
}

function clientIp(req) {
  return String(req.ip || '').slice(0, 45);
}

module.exports = { AppError, bad, notFound, forbidden, conflict, h, paging, sorting, paged, like, errorHandler, clientIp };
