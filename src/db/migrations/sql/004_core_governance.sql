-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 2 (Foundation). Not applied anywhere. For design review.
--  Staff identity, configurable RBAC, approvals (maker-checker), jobs,
--  integration logs and monitoring events.
--  Additive only: CREATE TABLE IF NOT EXISTS. Column additions to existing
--  tables are listed in alters.md and run from an idempotent .js migration.
-- ═══════════════════════════════════════════════════════════════════════

-- Business-platform staff. A SEPARATE identity from the B2C admin's staff.json:
-- the ERP never reads or writes B2C staff records (B2C protection rule).
CREATE TABLE IF NOT EXISTS b2b_staff (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120) NOT NULL,
  email           VARCHAR(190) NOT NULL,
  mobile          CHAR(10)     NULL,
  password_hash   VARCHAR(255) NULL,
  mfa_secret_enc  VARCHAR(255) NULL,
  mfa_enabled     TINYINT(1)   NOT NULL DEFAULT 0,
  status          ENUM('active','disabled') NOT NULL DEFAULT 'active',
  token_version   INT UNSIGNED NOT NULL DEFAULT 1,
  failed_logins   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until    DATETIME NULL,
  last_login_at   DATETIME NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_staff_email (email),
  KEY ix_b2b_staff_status (status, name),
  KEY ix_b2b_staff_created_by (created_by),
  CONSTRAINT fk_b2b_staff_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_permissions (
  code         VARCHAR(80)  NOT NULL,           -- e.g. procurement.po.approve
  module       VARCHAR(40)  NOT NULL,
  description  VARCHAR(255) NOT NULL,
  is_sensitive TINYINT(1)   NOT NULL DEFAULT 0, -- financial / approval / export: needs MFA
  PRIMARY KEY (code),
  KEY ix_b2b_permissions_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_roles (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code         VARCHAR(40)  NOT NULL,           -- super_admin, salesman, … or custom_xxx
  name         VARCHAR(80)  NOT NULL,
  description  VARCHAR(255) NULL,
  is_system    TINYINT(1)   NOT NULL DEFAULT 0, -- seeded roles cannot be deleted
  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_roles_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_role_permissions (
  role_id          INT UNSIGNED NOT NULL,
  permission_code  VARCHAR(80)  NOT NULL,
  PRIMARY KEY (role_id, permission_code),
  KEY ix_b2b_rp_perm (permission_code),
  CONSTRAINT fk_b2b_rp_role FOREIGN KEY (role_id) REFERENCES b2b_roles (id),
  CONSTRAINT fk_b2b_rp_perm FOREIGN KEY (permission_code) REFERENCES b2b_permissions (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A role held by a staff member, optionally limited to one territory or warehouse.
-- Several rows = several scopes. scope_type 'all' = unrestricted.
CREATE TABLE IF NOT EXISTS b2b_staff_roles (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  staff_id    BIGINT UNSIGNED NOT NULL,
  role_id     INT UNSIGNED NOT NULL,
  scope_type  ENUM('all','territory','warehouse','state') NOT NULL DEFAULT 'all',
  scope_id    BIGINT UNSIGNED NULL,
  granted_by  BIGINT UNSIGNED NULL,
  granted_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at  DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_sr_staff (staff_id, revoked_at),
  KEY ix_b2b_sr_role (role_id),
  KEY ix_b2b_sr_granted_by (granted_by),
  CONSTRAINT fk_b2b_sr_staff FOREIGN KEY (staff_id) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_sr_role FOREIGN KEY (role_id) REFERENCES b2b_roles (id),
  CONSTRAINT fk_b2b_sr_granted_by FOREIGN KEY (granted_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Approval engine (maker-checker) ───────────────
-- One request per thing to approve (price list, PO, GRN variance, disposition,
-- credit note, write-off, OTP override, recall closure, role change …).
CREATE TABLE IF NOT EXISTS b2b_approval_requests (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  approval_type  VARCHAR(40)  NOT NULL,
  entity         VARCHAR(50)  NOT NULL,
  entity_id      BIGINT UNSIGNED NOT NULL,
  status         ENUM('pending','approved','rejected','withdrawn','expired') NOT NULL DEFAULT 'pending',
  amount         DECIMAL(14,2) NULL,               -- used to pick the value band
  steps_required TINYINT UNSIGNED NOT NULL DEFAULT 1,
  steps_done     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  reason         VARCHAR(500) NOT NULL,
  payload_json   MEDIUMTEXT   NULL,                -- snapshot of what is being approved
  requested_by   BIGINT UNSIGNED NOT NULL,
  requested_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at     DATETIME NULL,
  -- = entity key while pending, NULL afterwards: at most one open request per entity + type
  open_key       VARCHAR(120) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_ar_open (open_key),
  KEY ix_b2b_ar_queue (status, approval_type, requested_at),
  KEY ix_b2b_ar_entity (entity, entity_id),
  KEY ix_b2b_ar_requested_by (requested_by),
  CONSTRAINT fk_b2b_ar_requested_by FOREIGN KEY (requested_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The service refuses a step whose approver_id = requested_by (maker ≠ checker).
CREATE TABLE IF NOT EXISTS b2b_approval_steps (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id   BIGINT UNSIGNED NOT NULL,
  step_no      TINYINT UNSIGNED NOT NULL,
  decision     ENUM('approved','rejected','returned') NOT NULL,
  approver_id  BIGINT UNSIGNED NOT NULL,
  comment      VARCHAR(500) NULL,
  decided_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_as_step (request_id, step_no),
  KEY ix_b2b_as_approver (approver_id, decided_at),
  CONSTRAINT fk_b2b_as_request FOREIGN KEY (request_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_as_approver FOREIGN KEY (approver_id) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Value bands: which roles approve what, from which amount, in how many steps.
CREATE TABLE IF NOT EXISTS b2b_approval_rules (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  approval_type  VARCHAR(40)  NOT NULL,
  min_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  steps_required TINYINT UNSIGNED NOT NULL DEFAULT 1,
  approver_permission VARCHAR(80) NOT NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_apr_type (approval_type, is_active, min_amount),
  KEY ix_b2b_apr_perm (approver_permission),
  CONSTRAINT fk_b2b_apr_perm FOREIGN KEY (approver_permission) REFERENCES b2b_permissions (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Background jobs (same claim pattern as the notification outbox) ───────────────
CREATE TABLE IF NOT EXISTS b2b_jobs (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_type         VARCHAR(40)  NOT NULL,      -- import.apply, pdf.invoice, recall.notify, backup.run, b2c.sync …
  status           ENUM('pending','running','done','failed','cancelled') NOT NULL DEFAULT 'pending',
  priority         TINYINT NOT NULL DEFAULT 5,
  payload_json     MEDIUMTEXT NULL,
  result_json      MEDIUMTEXT NULL,
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts     TINYINT UNSIGNED NOT NULL DEFAULT 3,
  run_after        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_by       VARCHAR(40) NULL,
  claimed_at       DATETIME NULL,
  finished_at      DATETIME NULL,
  last_error       VARCHAR(500) NULL,
  dedupe_key       VARCHAR(120) NULL,          -- same key while queued = one job
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_jobs_dedupe (dedupe_key),
  KEY ix_b2b_jobs_claim (status, run_after, priority),
  KEY ix_b2b_jobs_type (job_type, created_at),
  KEY ix_b2b_jobs_created_by (created_by),
  CONSTRAINT fk_b2b_jobs_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every call to an outside service (WhatsApp, SMS, GST API, gateway, storage).
-- Secrets and OTP values are never written here.
CREATE TABLE IF NOT EXISTS b2b_integration_logs (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider       VARCHAR(30)  NOT NULL,
  operation      VARCHAR(60)  NOT NULL,
  direction      ENUM('out','in') NOT NULL DEFAULT 'out',
  ref_type       VARCHAR(30)  NULL,
  ref_id         BIGINT UNSIGNED NULL,
  http_status    SMALLINT NULL,
  ok             TINYINT(1) NOT NULL,
  duration_ms    INT UNSIGNED NULL,
  external_id    VARCHAR(120) NULL,
  error          VARCHAR(500) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_il_provider (provider, ok, created_at),
  KEY ix_b2b_il_ref (ref_type, ref_id),
  KEY ix_b2b_il_external (external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Security and operations events shown on the monitoring dashboard.
CREATE TABLE IF NOT EXISTS b2b_monitor_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category    ENUM('auth','otp','api','notification','database','job','backup','storage','inventory','staff','migration','b2c') NOT NULL,
  severity    ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
  code        VARCHAR(60)  NOT NULL,          -- login_failed, otp_locked, ledger_mismatch, b2c_amount_mismatch …
  message     VARCHAR(500) NOT NULL,
  actor_type  VARCHAR(12)  NULL,
  actor_id    VARCHAR(64)  NULL,
  ip          VARCHAR(45)  NULL,
  ref_type    VARCHAR(30)  NULL,
  ref_id      VARCHAR(64)  NULL,
  acknowledged_by BIGINT UNSIGNED NULL,
  acknowledged_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_me_feed (category, severity, created_at),
  KEY ix_b2b_me_open (acknowledged_at, severity),
  KEY ix_b2b_me_ack_by (acknowledged_by),
  CONSTRAINT fk_b2b_me_ack_by FOREIGN KEY (acknowledged_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every inbound webhook event, kept to refuse replays: an event id seen before is
-- acknowledged and ignored. Signature checked before the row is written.
CREATE TABLE IF NOT EXISTS b2b_webhook_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider       VARCHAR(30)  NOT NULL,           -- whatsapp_meta, sms_<provider>, razorpay
  event_id       VARCHAR(160) NOT NULL,           -- provider message/status id + status, or payload hash
  payload_sha256 CHAR(64)     NOT NULL,
  event_time     DATETIME NULL,                   -- time stated by the provider
  outcome        ENUM('processed','duplicate','stale','bad_signature','ignored') NOT NULL,
  received_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_we_event (provider, event_id),
  KEY ix_b2b_we_received (provider, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
