-- Migration 016 — notification center (DRAFT: disposable test databases only until approved).
-- Additive only: new tables; the existing outbox b2b_notification_queue gains columns through OPS
-- in 016_notification_center.js. No existing row is changed.

-- Append-only status history of every queued message (one row per status change).
CREATE TABLE IF NOT EXISTS b2b_notification_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  queue_id      BIGINT UNSIGNED NOT NULL,
  status        VARCHAR(24) NOT NULL,
  detail        VARCHAR(300) NULL,
  provider      VARCHAR(20) NULL,
  provider_ref  VARCHAR(120) NULL,
  source        ENUM('worker','webhook','admin','system') NOT NULL,
  actor_label   VARCHAR(190) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_b2b_ne_queue (queue_id, id),
  KEY ix_b2b_ne_created (created_at),
  CONSTRAINT fk_b2b_ne_queue FOREIGN KEY (queue_id) REFERENCES b2b_notification_queue (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A message: what was written and how recipients were chosen. The original is never edited.
CREATE TABLE IF NOT EXISTS b2b_messages (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_no           VARCHAR(24) NOT NULL,
  origin               ENUM('manual','workflow') NOT NULL DEFAULT 'manual',
  category             ENUM('transactional','service','promotional') NOT NULL DEFAULT 'transactional',
  subject              VARCHAR(200) NULL,
  body_text            TEXT NULL,
  email_html           MEDIUMTEXT NULL,
  whatsapp_template_id BIGINT UNSIGNED NULL,
  sms_template_id      BIGINT UNSIGNED NULL,
  template_params_json TEXT NULL,
  channels             VARCHAR(40) NOT NULL,
  audience_json        TEXT NULL,
  ref_type             VARCHAR(30) NULL,
  ref_id               BIGINT UNSIGNED NULL,
  status               ENUM('draft','awaiting_approval','sent','rejected') NOT NULL DEFAULT 'draft',
  approval_id          BIGINT UNSIGNED NULL,
  created_by_type      ENUM('staff','system') NOT NULL,
  created_by_id        BIGINT UNSIGNED NULL,
  created_by_label     VARCHAR(190) NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resend_count         INT UNSIGNED NOT NULL DEFAULT 0,
  last_sent_at         DATETIME NULL,
  body_purged_at       DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_msg_no (message_no),
  KEY ix_b2b_msg_created (created_at),
  KEY ix_b2b_msg_ref (ref_type, ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who a message is for. A resend may only go to these recipients (or some of them).
CREATE TABLE IF NOT EXISTS b2b_message_recipients (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id      BIGINT UNSIGNED NOT NULL,
  recipient_type  ENUM('retailer','distributor','salesman','supplier','manufacturer','staff') NOT NULL,
  recipient_ref   BIGINT UNSIGNED NOT NULL,
  display_name    VARCHAR(190) NOT NULL,
  email           VARCHAR(190) NULL,
  mobile          VARCHAR(20) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_mr (message_id, recipient_type, recipient_ref),
  CONSTRAINT fk_b2b_mr_message FOREIGN KEY (message_id) REFERENCES b2b_messages (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per intentional Send / Resend press. Insert-only.
CREATE TABLE IF NOT EXISTS b2b_message_sends (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id          BIGINT UNSIGNED NOT NULL,
  send_no             INT UNSIGNED NOT NULL,
  request_key         CHAR(36) NOT NULL,
  initiated_by_type   ENUM('staff','system') NOT NULL,
  initiated_by_id     BIGINT UNSIGNED NULL,
  initiated_by_label  VARCHAR(190) NULL,
  edited              TINYINT(1) NOT NULL DEFAULT 0,
  subject             VARCHAR(200) NULL,
  body_text           TEXT NULL,
  channels            VARCHAR(40) NOT NULL,
  recipient_count     INT UNSIGNED NOT NULL DEFAULT 0,
  queued_count        INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count       INT UNSIGNED NOT NULL DEFAULT 0,
  reason              VARCHAR(300) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_ms_key (request_key),
  UNIQUE KEY uq_b2b_ms_no (message_id, send_no),
  CONSTRAINT fk_b2b_ms_message FOREIGN KEY (message_id) REFERENCES b2b_messages (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Provider-approved templates (Meta WhatsApp names, MSG91 DLT ids) and email layouts.
CREATE TABLE IF NOT EXISTS b2b_message_templates (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel               ENUM('email','whatsapp','sms') NOT NULL,
  name                  VARCHAR(80) NOT NULL,
  category              ENUM('transactional','service','promotional','authentication') NOT NULL DEFAULT 'transactional',
  provider_template     VARCHAR(120) NULL,
  language              VARCHAR(12) NULL,
  param_names           VARCHAR(400) NULL,
  sample_text           TEXT NULL,
  approved_at_provider  TINYINT(1) NOT NULL DEFAULT 0,
  active                TINYINT(1) NOT NULL DEFAULT 1,
  created_by_label      VARCHAR(190) NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_mt (channel, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Consent and opt-outs, by hashed address (no contact copied here).
CREATE TABLE IF NOT EXISTS b2b_contact_preferences (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel            ENUM('email','whatsapp','sms') NOT NULL,
  address_hash       CHAR(64) NOT NULL,
  scope              ENUM('promotional','all') NOT NULL,
  state              ENUM('opted_in','opted_out') NOT NULL,
  recipient_type     VARCHAR(20) NULL,
  recipient_ref      BIGINT UNSIGNED NULL,
  source             VARCHAR(40) NOT NULL,
  recorded_by_label  VARCHAR(190) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_cp (channel, address_hash, scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Saved recipient groups: a fixed list, or a rule evaluated at send time.
CREATE TABLE IF NOT EXISTS b2b_recipient_groups (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(120) NOT NULL,
  kind              ENUM('list','rule') NOT NULL,
  rule_json         TEXT NULL,
  active            TINYINT(1) NOT NULL DEFAULT 1,
  created_by_label  VARCHAR(190) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_rg_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_recipient_group_members (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id        BIGINT UNSIGNED NOT NULL,
  recipient_type  ENUM('retailer','distributor','salesman','supplier','manufacturer','staff') NOT NULL,
  recipient_ref   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_rgm (group_id, recipient_type, recipient_ref),
  CONSTRAINT fk_b2b_rgm_group FOREIGN KEY (group_id) REFERENCES b2b_recipient_groups (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
