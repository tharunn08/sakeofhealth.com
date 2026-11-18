/**
 * Migration 016 — notification center. DRAFT: applied only to disposable test
 * databases until the owner approves it. Additive only:
 *  - new tables (status history, messages, recipients, sends, templates,
 *    consent, recipient groups) from sql/016_notification_center.sql;
 *  - the existing outbox b2b_notification_queue gains three nullable links and
 *    two "not sent" statuses. No existing row is changed.
 * Needs 001 and 004 (queue columns). Safe to re-run (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '016_notification_center.sql');
const SQL_SHA256 = 'fdcdaef5c0a8e093276bc3fa1697bf0ddb75c75b1100709dcae93cd256e89017';
const OPS = [
  { "op": "addColumn", "table": "b2b_notification_queue", "column": "message_id", "def": "BIGINT UNSIGNED NULL" },
  { "op": "addColumn", "table": "b2b_notification_queue", "column": "send_id", "def": "BIGINT UNSIGNED NULL" },
  { "op": "addColumn", "table": "b2b_notification_queue", "column": "message_recipient_id", "def": "BIGINT UNSIGNED NULL" },
  { "op": "addIndex", "table": "b2b_notification_queue", "name": "ix_b2b_nq_message", "columns": ["message_id", "send_id"], "unique": false },
  { "op": "extendEnum", "table": "b2b_notification_queue", "column": "status", "def": "ENUM('pending','sending','sent','failed','skipped_no_provider','skipped_no_contact','skipped_opt_out') NOT NULL DEFAULT 'pending'" }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS };
