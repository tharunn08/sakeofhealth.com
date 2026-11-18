/**
 * MySQL connection layer (mysql2/promise).
 *
 * - The pool is created lazily: the B2C storefront never touches MySQL, so a
 *   missing/broken database can never stop the customer website from booting.
 * - Every query goes through prepared statements (pool.execute) or mysql2's
 *   own escaping (bulk inserts) — never string concatenation of user input.
 * - All timestamps are stored and read in UTC.
 */
const mysql = require('mysql2/promise');

let pool = null;
let lastPing = { at: 0, ok: false, error: '' };

function config() {
  return {
    host: process.env.DB_HOST || '',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || '',
  };
}

function isConfigured() {
  const c = config();
  return !!(c.host && c.user && c.database);
}

function getPool() {
  if (pool) return pool;
  if (!isConfigured()) {
    const err = new Error('Database is not configured (DB_HOST, DB_USER, DB_NAME)');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
  const c = config();
  pool = mysql.createPool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    waitForConnections: true,
    // Shared hosting caps connections per MySQL user — keep the pool small.
    connectionLimit: Math.max(1, Number(process.env.DB_POOL_SIZE || 6)),
    maxIdle: Math.max(1, Number(process.env.DB_POOL_SIZE || 6)),
    idleTimeout: 60000,
    queueLimit: 200,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: false,
    decimalNumbers: false,      // DECIMAL comes back as a string — never a float
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    namedPlaceholders: false,
  });
  pool.on('connection', function (conn) {
    // Session in UTC + strict mode, regardless of the server default.
    conn.query("SET time_zone = '+00:00', sql_mode = CONCAT_WS(',', @@sql_mode, 'STRICT_TRANS_TABLES')");
  });
  return pool;
}

/** Run a prepared statement. Returns rows (SELECT) or a result header (writes). */
async function query(sql, params) {
  const [rows] = await getPool().execute(sql, normalise(params));
  return rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

function normalise(params) {
  return (params || []).map(function (p) {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

/** `?, ?, ?` for IN (...) lists. Throws on an empty list so it can't become invalid SQL. */
function placeholders(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('placeholders(): empty list');
  return list.map(function () { return '?'; }).join(', ');
}

/** Safe integer for LIMIT / OFFSET (these cannot be bound reliably as placeholders). */
function int(n, fallback, min, max) {
  let v = parseInt(n, 10);
  if (!Number.isFinite(v)) v = fallback;
  if (min != null && v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

function wrap(conn) {
  return {
    raw: conn,
    async query(sql, params) { const [rows] = await conn.execute(sql, normalise(params)); return rows; },
    async queryOne(sql, params) { const [rows] = await conn.execute(sql, normalise(params)); return rows[0] || null; },
    /** Multi-row insert: bulk('INSERT INTO t (a,b) VALUES ?', [[1,2],[3,4]]) — escaped by mysql2. */
    async bulk(sql, rows) { if (!rows.length) return { affectedRows: 0 }; const [res] = await conn.query(sql, [rows]); return res; },
  };
}

const RETRYABLE = { ER_LOCK_DEADLOCK: 1, ER_LOCK_WAIT_TIMEOUT: 1 };

/**
 * Run `fn(tx)` inside a transaction. Commits on success, rolls back on any
 * throw. Deadlocks / lock-wait timeouts are retried a few times, so `fn` must
 * only perform database work (no emails, no external calls).
 */
async function transaction(fn, opts) {
  const attempts = (opts && opts.attempts) || 4;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(wrap(conn));
      await conn.commit();
      conn.release();
      return result;
    } catch (e) {
      try { await conn.rollback(); } catch (_) { /* connection already gone */ }
      conn.release();
      lastErr = e;
      if (!RETRYABLE[e.code]) throw e;
      await new Promise(function (r) { setTimeout(r, 30 + Math.floor(Math.random() * 120) * (i + 1)); });
    }
  }
  throw lastErr;
}

/** Dedicated connection (used by the migration runner for GET_LOCK). */
async function withConnection(fn) {
  const conn = await getPool().getConnection();
  try { return await fn(wrap(conn)); } finally { conn.release(); }
}

/** Bulk insert outside a transaction. */
async function bulk(sql, rows) {
  if (!rows.length) return { affectedRows: 0 };
  const [res] = await getPool().query(sql, [rows]);
  return res;
}

/** Cheap cached connectivity probe for /api/health — never throws. */
async function ping(maxAgeMs) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  if (Date.now() - lastPing.at < (maxAgeMs == null ? 10000 : maxAgeMs)) return lastPing;
  try {
    await getPool().query('SELECT 1');
    lastPing = { at: Date.now(), ok: true, error: '' };
  } catch (e) {
    lastPing = { at: Date.now(), ok: false, error: e.code || 'error' };
  }
  return lastPing;
}

async function close() {
  if (pool) { const p = pool; pool = null; await p.end(); }
}

/**
 * Guard for seed / reset / load-test scripts: refuse to run against anything
 * that could be the production database.
 */
function assertDisposableDatabase(what) {
  const name = config().database;
  const ok = /(_dev|_test|_local)$/i.test(name) && process.env.NODE_ENV !== 'production';
  if (!ok) {
    throw new Error(
      'Refusing to run "' + what + '" against database "' + name + '". ' +
      'Development scripts only run when NODE_ENV is not "production" and DB_NAME ends with _dev, _test or _local.'
    );
  }
}

module.exports = {
  config, isConfigured, getPool, query, queryOne, placeholders, int,
  transaction, withConnection, bulk, ping, close, assertDisposableDatabase,
};
