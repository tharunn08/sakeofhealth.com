-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 8 (Offline salesman orders with OTP). Not applied anywhere.
--  Salesman orders are ordinary b2b_orders rows with channel='salesman' and
--  status 'pending_otp' (alters.md) — one order model for every channel.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS b2b_salesmen (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  staff_id        BIGINT UNSIGNED NOT NULL,
  employee_code   VARCHAR(20) NULL,
  home_territory_id INT UNSIGNED NULL,
  default_warehouse_id INT UNSIGNED NULL,
  cash_limit      DECIMAL(14,2) NOT NULL DEFAULT 0.00,   -- max cash they may hold before deposit
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_sm_staff (staff_id),
  UNIQUE KEY uq_b2b_sm_code (employee_code),
  KEY ix_b2b_sm_terr (home_territory_id),
  KEY ix_b2b_sm_wh (default_warehouse_id),
  CONSTRAINT fk_b2b_slm_staff FOREIGN KEY (staff_id) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_slm_terr FOREIGN KEY (home_territory_id) REFERENCES b2b_territories (id),
  CONSTRAINT fk_b2b_slm_wh FOREIGN KEY (default_warehouse_id) REFERENCES b2b_warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Beat plan: which retailers a salesman visits on which weekday.
CREATE TABLE IF NOT EXISTS b2b_beats (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  salesman_id   BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(120) NOT NULL,
  weekday       TINYINT UNSIGNED NOT NULL,      -- 1 = Monday … 7 = Sunday
  territory_id  INT UNSIGNED NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_b2b_beat_sm (salesman_id, weekday),
  KEY ix_b2b_beat_terr (territory_id),
  CONSTRAINT fk_b2b_beat_sm FOREIGN KEY (salesman_id) REFERENCES b2b_salesmen (id),
  CONSTRAINT fk_b2b_beat_terr FOREIGN KEY (territory_id) REFERENCES b2b_territories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_beat_stops (
  beat_id       BIGINT UNSIGNED NOT NULL,
  account_id    BIGINT UNSIGNED NOT NULL,
  seq           SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (beat_id, account_id),
  KEY ix_b2b_bs_account (account_id),
  CONSTRAINT fk_b2b_bs_beat FOREIGN KEY (beat_id) REFERENCES b2b_beats (id),
  CONSTRAINT fk_b2b_bs_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_visits (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  salesman_id   BIGINT UNSIGNED NOT NULL,
  account_id    BIGINT UNSIGNED NOT NULL,
  beat_id       BIGINT UNSIGNED NULL,
  checked_in_at DATETIME NOT NULL,
  checked_out_at DATETIME NULL,
  lat           DECIMAL(10,7) NULL,             -- only with consent
  lng           DECIMAL(10,7) NULL,
  distance_m    INT UNSIGNED NULL,              -- from the shop's saved pin
  outcome       ENUM('order','no_order','shop_closed','collection_only','new_registration') NULL,
  note          VARCHAR(500) NULL,
  client_uuid   CHAR(36) NOT NULL,              -- offline-safe idempotency from the PWA
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_visit_client (client_uuid),
  KEY ix_b2b_visit_sm (salesman_id, checked_in_at),
  KEY ix_b2b_visit_account (account_id, checked_in_at),
  KEY ix_b2b_visit_beat (beat_id),
  CONSTRAINT fk_b2b_visit_sm FOREIGN KEY (salesman_id) REFERENCES b2b_salesmen (id),
  CONSTRAINT fk_b2b_visit_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_visit_beat FOREIGN KEY (beat_id) REFERENCES b2b_beats (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OTP challenge. The code itself is never stored: only HMAC-SHA256(pepper, challenge_id || code).
CREATE TABLE IF NOT EXISTS b2b_otp_challenges (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purpose        ENUM('order_confirm','retailer_login','mobile_change') NOT NULL,
  order_id       BIGINT UNSIGNED NULL,
  account_id     BIGINT UNSIGNED NOT NULL,
  mobile         CHAR(10) NOT NULL,             -- the registered mobile at the time of sending
  code_hash      CHAR(64) NOT NULL,
  expires_at     DATETIME NOT NULL,             -- created + sales.otp.expiry_min (setting, pending D7)
  attempts       TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- limit = sales.otp.max_attempts
  resends        TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- limit = sales.otp.max_resends
  last_sent_at   DATETIME NOT NULL,             -- resend allowed after sales.otp.resend_cooldown_s
  channel        ENUM('sms','whatsapp') NOT NULL,
  delivery_status ENUM('queued','sent','delivered','failed') NOT NULL DEFAULT 'queued',
  status         ENUM('pending','verified','expired','locked','cancelled') NOT NULL DEFAULT 'pending',
  verified_at    DATETIME NULL,
  requested_by_staff BIGINT UNSIGNED NULL,      -- the salesman
  -- = order_id while pending: one live challenge per order
  open_order_id  BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_otp_open (open_order_id),
  KEY ix_b2b_otp_order (order_id),
  KEY ix_b2b_otp_mobile (mobile, created_at),
  KEY ix_b2b_otp_account (account_id),
  KEY ix_b2b_otp_staff (requested_by_staff, created_at),
  KEY ix_b2b_otp_purge (created_at),
  CONSTRAINT fk_b2b_otp_order FOREIGN KEY (order_id) REFERENCES b2b_orders (id),
  CONSTRAINT fk_b2b_otp_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_otp_staff FOREIGN KEY (requested_by_staff) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every verify attempt (outcome only — never the digits typed).
CREATE TABLE IF NOT EXISTS b2b_otp_attempts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  challenge_id  BIGINT UNSIGNED NOT NULL,
  outcome       ENUM('ok','wrong','expired','locked','rate_limited') NOT NULL,
  ip            VARCHAR(45) NULL,
  device_id     VARCHAR(64) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_otpa_ch (challenge_id, created_at),
  CONSTRAINT fk_b2b_otpa_ch FOREIGN KEY (challenge_id) REFERENCES b2b_otp_challenges (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;



CREATE TABLE IF NOT EXISTS b2b_sales_targets (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  salesman_id   BIGINT UNSIGNED NOT NULL,
  period_month  CHAR(7) NOT NULL,               -- 2026-11
  metric        ENUM('sales_value','orders','new_retailers','collections','visits') NOT NULL,
  target_value  DECIMAL(14,2) NOT NULL,
  set_by        BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_tgt (salesman_id, period_month, metric),
  KEY ix_b2b_tgt_set_by (set_by),
  CONSTRAINT fk_b2b_tgt_sm FOREIGN KEY (salesman_id) REFERENCES b2b_salesmen (id),
  CONSTRAINT fk_b2b_tgt_set_by FOREIGN KEY (set_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
