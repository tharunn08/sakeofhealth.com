/**
 * Migration 019 — operations channels. DRAFT: applied only to disposable test databases
 * until the owner approves it. Additive only:
 *  - new tables from sql/019_operations_channels.sql: location history and events (3b.2),
 *    online-shop exceptions, per-order shop stock lifecycle and shadow discrepancies (3b.3/3b.4), counter
 *    sales with items, payments and returns (3b.5), the offline operation log (3b.6), and the
 *    unified customer record with links and order history (N4);
 *  - an index for listing shop holds by mode and status.
 * No existing row is changed. Needs 004–012 and 016–018. Safe to re-run (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '019_operations_channels.sql');
const SQL_SHA256 = '6819a92f989192a0471eb7c5d7927e3d64e75409d931c5ed0acc82bb4d52c1cc';
const OPS = [
  { "op": "addIndex", "table": "b2b_stock_reservations", "name": "ix_b2b_sr_mode_status", "columns": ["mode", "status", "channel"], "unique": false }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS };
