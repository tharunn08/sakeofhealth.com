/**
 * Migration 004 — core governance. DRAFT for approval; generated from the reviewed DDL.
 * Creates 12 new table(s), then 15 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '004_core_governance.sql');
const SQL_SHA256 = '7ff73696cf578a1c131bb9e432a5dbb308536aaf4f8d00255e2066ee0c602e84';
const OPS = [
  {
    "op": "addColumn",
    "table": "b2b_audit_logs",
    "column": "module",
    "def": "VARCHAR(40) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_audit_logs",
    "column": "reason",
    "def": "VARCHAR(500) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_audit_logs",
    "column": "approval_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_audit_logs",
    "column": "session_id",
    "def": "VARCHAR(64) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_audit_logs",
    "column": "user_agent",
    "def": "VARCHAR(255) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_audit_logs",
    "column": "prev_hash",
    "def": "CHAR(64) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_audit_logs",
    "column": "row_hash",
    "def": "CHAR(64) NULL"
  },
  {
    "op": "addIndex",
    "table": "b2b_audit_logs",
    "name": "ix_b2b_audit_approval",
    "columns": [
      "approval_id"
    ],
    "unique": false
  },
  {
    "op": "addColumn",
    "table": "b2b_notification_queue",
    "column": "template_name",
    "def": "VARCHAR(80) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_notification_queue",
    "column": "template_params_json",
    "def": "TEXT NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_notification_queue",
    "column": "provider_message_id",
    "def": "VARCHAR(120) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_notification_queue",
    "column": "delivery_status",
    "def": "ENUM('unknown','sent','delivered','read','failed') NOT NULL DEFAULT 'unknown'"
  },
  {
    "op": "addColumn",
    "table": "b2b_notification_queue",
    "column": "consent_checked",
    "def": "TINYINT(1) NOT NULL DEFAULT 0"
  },
  {
    "op": "extendEnum",
    "table": "b2b_notification_queue",
    "column": "status",
    "def": "ENUM('pending','sending','sent','failed','skipped_no_provider') NOT NULL DEFAULT 'pending'"
  },
  {
    "op": "addIndex",
    "table": "b2b_notification_queue",
    "name": "ix_b2b_nq_provider_id",
    "columns": [
      "provider_message_id"
    ],
    "unique": false
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_staff", "b2b_permissions", "b2b_roles", "b2b_role_permissions", "b2b_staff_roles", "b2b_approval_requests", "b2b_approval_steps", "b2b_approval_rules", "b2b_jobs", "b2b_integration_logs", "b2b_monitor_events", "b2b_webhook_events"] };
