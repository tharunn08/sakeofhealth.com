/**
 * Migration 018 — notification workflow records (N5). DRAFT: applied only to disposable test
 * databases until the owner approves it. Additive only: message recipients may be a plain
 * address ('address'), e.g. the administrators' alert emails, so every automatic message can be
 * kept in the notification history and resent. No existing row is changed.
 * Needs 016. Safe to re-run (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '018_notification_workflow.sql');
const SQL_SHA256 = '23a695f95eaea385971f7b2c3a8c59aba19abc564ff55c6b2c37f8bf425cbdcf';
const OPS = [
  { "op": "extendEnum", "table": "b2b_message_recipients", "column": "recipient_type", "def": "ENUM('retailer','distributor','salesman','supplier','manufacturer','staff','address') NOT NULL" }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS };
