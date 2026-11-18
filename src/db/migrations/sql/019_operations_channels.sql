-- Migration 019 — event and salesman locations (3b.2), online-shop stock (3b.3 / 3b.4),
-- event sales (3b.5), offline queue (3b.6) and unified customers (N4).
-- Additive only: new tables. The ledger stays b2b_stock + b2b_stock_movements; nothing here
-- is a second balance or a second ledger. Needs 004–012 and 016–018.

-- 3b.2: every location fix (GPS or typed in) for a salesman or an event, kept as history.
CREATE TABLE IF NOT EXISTS b2b_location_pings (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject_type    ENUM('salesman','event') NOT NULL,
  subject_id      BIGINT UNSIGNED NOT NULL,
  staff_id        BIGINT UNSIGNED NULL,
  lat             DECIMAL(10,7) NOT NULL,
  lng             DECIMAL(10,7) NOT NULL,
  accuracy_m      INT UNSIGNED NULL,
  source          ENUM('gps','manual') NOT NULL,
  purpose         ENUM('check_in','visit','sale','stall','route','manual') NOT NULL DEFAULT 'manual',
  visit_id        BIGINT UNSIGNED NULL,
  ref_type        VARCHAR(30) NULL,
  ref_id          VARCHAR(40) NULL,
  note            VARCHAR(255) NULL,
  captured_at     DATETIME(3) NOT NULL,
  received_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  client_uuid     CHAR(36) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_lp_client (client_uuid),
  KEY ix_b2b_lp_subject (subject_type, subject_id, captured_at),
  KEY ix_b2b_lp_staff (staff_id, captured_at),
  KEY ix_b2b_lp_ref (ref_type, ref_id),
  CONSTRAINT fk_b2b_lp_staff FOREIGN KEY (staff_id) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_lp_visit FOREIGN KEY (visit_id) REFERENCES b2b_visits (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3b.2 / 3b.5: an event or stall, with its own stock location (warehouse_type 'event').
CREATE TABLE IF NOT EXISTS b2b_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code            VARCHAR(30) NOT NULL,
  name            VARCHAR(160) NOT NULL,
  venue           VARCHAR(200) NULL,
  city            VARCHAR(80) NULL,
  state_id        SMALLINT UNSIGNED NULL,
  lat             DECIMAL(10,7) NULL,
  lng             DECIMAL(10,7) NULL,
  warehouse_id    INT UNSIGNED NOT NULL,
  starts_on       DATE NOT NULL,
  ends_on         DATE NOT NULL,
  status          ENUM('planned','open','closed') NOT NULL DEFAULT 'planned',
  invoice_prefix  VARCHAR(12) NOT NULL DEFAULT 'EV',
  created_by      BIGINT UNSIGNED NULL,
  closed_by       BIGINT UNSIGNED NULL,
  closed_at       DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_ev_code (code),
  UNIQUE KEY uq_b2b_ev_wh (warehouse_id),
  KEY ix_b2b_ev_status (status, starts_on),
  CONSTRAINT fk_b2b_ev_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_ev_created FOREIGN KEY (created_by) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_ev_closed FOREIGN KEY (closed_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who may sell at which event (event staff see and sell only at their events).
CREATE TABLE IF NOT EXISTS b2b_event_staff (
  event_id        BIGINT UNSIGNED NOT NULL,
  staff_id        BIGINT UNSIGNED NOT NULL,
  added_by        BIGINT UNSIGNED NULL,
  added_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, staff_id),
  KEY ix_b2b_es_staff (staff_id),
  CONSTRAINT fk_b2b_es_event FOREIGN KEY (event_id) REFERENCES b2b_events (id),
  CONSTRAINT fk_b2b_es_staff FOREIGN KEY (staff_id) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3b.5: counter sales at an event, with a GST invoice number per event series.
CREATE TABLE IF NOT EXISTS b2b_counter_sales (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_no      VARCHAR(40) NOT NULL,
  event_id        BIGINT UNSIGNED NOT NULL,
  warehouse_id    INT UNSIGNED NOT NULL,
  customer_id     BIGINT UNSIGNED NULL,
  customer_name   VARCHAR(160) NULL,
  customer_mobile VARCHAR(15) NULL,
  customer_email  VARCHAR(190) NULL,
  customer_gstin  VARCHAR(15) NULL,
  place_of_supply_state_id SMALLINT UNSIGNED NULL,
  is_interstate   TINYINT(1) NOT NULL DEFAULT 0,
  item_count      INT UNSIGNED NOT NULL,
  total_qty       INT UNSIGNED NOT NULL,
  subtotal        DECIMAL(14,2) NOT NULL,
  discount_total  DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  taxable_total   DECIMAL(14,2) NOT NULL,
  cgst_total      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_total      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_total      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  round_off       DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  grand_total     DECIMAL(14,2) NOT NULL,
  amount_paid     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  payment_status  ENUM('unpaid','partial','paid','refunded') NOT NULL DEFAULT 'unpaid',
  status          ENUM('completed','voided') NOT NULL DEFAULT 'completed',
  idempotency_key CHAR(36) NOT NULL,
  sold_by         BIGINT UNSIGNED NOT NULL,
  sold_at         DATETIME(3) NOT NULL,
  received_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  offline         TINYINT(1) NOT NULL DEFAULT 0,
  lat             DECIMAL(10,7) NULL,
  lng             DECIMAL(10,7) NULL,
  notes           VARCHAR(500) NULL,
  voided_by       BIGINT UNSIGNED NULL,
  voided_at       DATETIME NULL,
  void_reason     VARCHAR(300) NULL,
  whatsapp_queue_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_cs_invoice (invoice_no),
  UNIQUE KEY uq_b2b_cs_key (idempotency_key),
  KEY ix_b2b_cs_event (event_id, sold_at),
  KEY ix_b2b_cs_customer (customer_id),
  KEY ix_b2b_cs_seller (sold_by, sold_at),
  CONSTRAINT fk_b2b_cs_event FOREIGN KEY (event_id) REFERENCES b2b_events (id),
  CONSTRAINT fk_b2b_cs_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_cs_seller FOREIGN KEY (sold_by) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_cs_voider FOREIGN KEY (voided_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_counter_sale_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_id         BIGINT UNSIGNED NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  sku             VARCHAR(60) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  hsn_code        VARCHAR(12) NULL,
  batch_id        BIGINT UNSIGNED NULL,
  lot_id          BIGINT UNSIGNED NULL,
  batch_no        VARCHAR(60) NULL,
  expiry_date     DATE NULL,
  qty             INT UNSIGNED NOT NULL,
  unit_price      DECIMAL(12,2) NOT NULL,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  gst_rate        DECIMAL(5,2) NOT NULL,
  taxable_amount  DECIMAL(14,2) NOT NULL,
  cgst_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  line_total      DECIMAL(14,2) NOT NULL,
  returned_qty    INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_b2b_csi_sale (sale_id),
  KEY ix_b2b_csi_product (product_id),
  CONSTRAINT fk_b2b_csi_sale FOREIGN KEY (sale_id) REFERENCES b2b_counter_sales (id),
  CONSTRAINT fk_b2b_csi_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_csi_batch FOREIGN KEY (batch_id) REFERENCES b2b_batches (id),
  CONSTRAINT fk_b2b_csi_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Payments against a counter sale (cash, UPI, card; split payments allowed). Insert-only.
CREATE TABLE IF NOT EXISTS b2b_counter_payments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_id         BIGINT UNSIGNED NOT NULL,
  method          ENUM('cash','upi','card','bank_transfer') NOT NULL,
  amount          DECIMAL(14,2) NOT NULL,
  direction       ENUM('in','refund') NOT NULL DEFAULT 'in',
  reference       VARCHAR(80) NULL,
  recorded_by     BIGINT UNSIGNED NOT NULL,
  recorded_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  idempotency_key VARCHAR(80) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_cp_key (idempotency_key),
  KEY ix_b2b_cp_sale (sale_id),
  CONSTRAINT fk_b2b_cp_sale FOREIGN KEY (sale_id) REFERENCES b2b_counter_sales (id),
  CONSTRAINT fk_b2b_cp_staff FOREIGN KEY (recorded_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_counter_returns (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_no       VARCHAR(40) NOT NULL,
  sale_id         BIGINT UNSIGNED NOT NULL,
  reason          VARCHAR(300) NOT NULL,
  refund_amount   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  refund_method   ENUM('cash','upi','card','bank_transfer','none') NOT NULL DEFAULT 'none',
  idempotency_key CHAR(36) NOT NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_cr_no (return_no),
  UNIQUE KEY uq_b2b_cr_key (idempotency_key),
  KEY ix_b2b_cr_sale (sale_id),
  CONSTRAINT fk_b2b_cr_sale FOREIGN KEY (sale_id) REFERENCES b2b_counter_sales (id),
  CONSTRAINT fk_b2b_cr_staff FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_counter_return_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_id       BIGINT UNSIGNED NOT NULL,
  sale_item_id    BIGINT UNSIGNED NOT NULL,
  qty             INT UNSIGNED NOT NULL,
  item_condition  ENUM('resaleable','damaged','expired') NOT NULL,
  refund_amount   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (id),
  KEY ix_b2b_cri_return (return_id),
  KEY ix_b2b_cri_item (sale_item_id),
  CONSTRAINT fk_b2b_cri_return FOREIGN KEY (return_id) REFERENCES b2b_counter_returns (id),
  CONSTRAINT fk_b2b_cri_item FOREIGN KEY (sale_item_id) REFERENCES b2b_counter_sale_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3b.6: every operation a device sent while it may have been offline. Never deleted.
CREATE TABLE IF NOT EXISTS b2b_offline_ops (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_op_id    CHAR(36) NOT NULL,
  device_id       VARCHAR(64) NULL,
  staff_id        BIGINT UNSIGNED NOT NULL,
  kind            ENUM('event_sale','event_payment','field_order','visit','location') NOT NULL,
  payload_json    MEDIUMTEXT NOT NULL,
  payload_sha256  CHAR(64) NOT NULL,
  status          ENUM('applied','duplicate','failed','conflict','resolved','discarded') NOT NULL,
  attempts        INT UNSIGNED NOT NULL DEFAULT 1,
  result_json     TEXT NULL,
  error_code      VARCHAR(60) NULL,
  error           VARCHAR(500) NULL,
  created_offline_at DATETIME(3) NULL,
  first_received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_by     BIGINT UNSIGNED NULL,
  resolved_at     DATETIME NULL,
  resolution_note VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_oo_client (client_op_id),
  KEY ix_b2b_oo_status (status, last_attempt_at),
  KEY ix_b2b_oo_staff (staff_id, first_received_at),
  CONSTRAINT fk_b2b_oo_staff FOREIGN KEY (staff_id) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_oo_resolver FOREIGN KEY (resolved_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3b.4 decision 3: every paid shop checkout that could not get stock has an owner and a refund record.
CREATE TABLE IF NOT EXISTS b2b_b2c_exceptions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  checkout_ref    VARCHAR(80) NOT NULL,
  gateway_order_id VARCHAR(64) NULL,
  payment_id      VARCHAR(64) NULL,
  kind            ENUM('paid_short','db_down_timeout','unmapped') NOT NULL,
  amount          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  details_json    TEXT NULL,
  status          ENUM('open','refund_requested','refunded','refund_failed','backorder_agreed','closed') NOT NULL DEFAULT 'open',
  refund_ref      VARCHAR(64) NULL,
  refund_error    VARCHAR(300) NULL,
  resolver_id     BIGINT UNSIGNED NULL,
  resolution_note VARCHAR(500) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_bx_checkout (checkout_ref),
  KEY ix_b2b_bx_status (status, created_at),
  CONSTRAINT fk_b2b_bx_resolver FOREIGN KEY (resolver_id) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3b.3 / 3b.4: what the ledger did (live) or would have done (shadow) for each shop order line.
-- Allocated when the order exists, sold when it leaves (out_for_delivery / delivered), released
-- when cancelled before that, returned (to quarantine, for inspection) when cancelled after.
-- The shop's own figures are never written: the shop's data is read-only to the business code.
CREATE TABLE IF NOT EXISTS b2b_b2c_order_stock (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mode            ENUM('live','shadow') NOT NULL,
  shop_order_id   VARCHAR(64) NOT NULL,
  shop_order_no   VARCHAR(40) NULL,
  gateway_order_id VARCHAR(64) NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  warehouse_id    INT UNSIGNED NOT NULL,
  qty             INT UNSIGNED NOT NULL,
  stage           ENUM('allocated','sold','released','returned','short') NOT NULL,
  picks_json      TEXT NULL,
  shop_status     VARCHAR(30) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_bos_line (mode, shop_order_id, product_id),
  KEY ix_b2b_bos_gateway (gateway_order_id),
  KEY ix_b2b_bos_stage (mode, stage),
  CONSTRAINT fk_b2b_bos_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_bos_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3b.3: what shadow mode found: unmapped shop products, shop vs ledger differences, sales the
-- ledger could not have covered. One open row per (kind, ref); explained or resolved by staff.
CREATE TABLE IF NOT EXISTS b2b_b2c_discrepancies (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind            ENUM('unmapped_product','stock_mismatch','would_refuse','order_without_hold') NOT NULL,
  ref             VARCHAR(80) NOT NULL,
  product_id      BIGINT UNSIGNED NULL,
  shop_qty        INT NULL,
  ledger_qty      INT NULL,
  details         VARCHAR(500) NULL,
  status          ENUM('open','explained','resolved') NOT NULL DEFAULT 'open',
  open_key        VARCHAR(120) NULL,
  first_seen_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_by     BIGINT UNSIGNED NULL,
  resolution_note VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_bd_open (open_key),
  KEY ix_b2b_bd_status (status, kind),
  CONSTRAINT fk_b2b_bd_resolver FOREIGN KEY (resolved_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- N4: one customer record across the shop, events, field sales and business accounts.
-- Logins stay where they are (the shop keeps its own accounts); this links them.
CREATE TABLE IF NOT EXISTS b2b_customers (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  display_name    VARCHAR(160) NULL,
  email           VARCHAR(190) NULL,
  email_norm      VARCHAR(190) NULL,
  mobile          VARCHAR(15) NULL,
  mobile_norm     CHAR(12) NULL,
  first_seen_at   DATETIME NULL,
  last_seen_at    DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_cust_email (email_norm),
  UNIQUE KEY uq_b2b_cust_mobile (mobile_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_customer_links (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id     BIGINT UNSIGNED NOT NULL,
  source          ENUM('b2c_customer','b2c_login','b2b_account','event_sale','field_retailer') NOT NULL,
  source_ref      VARCHAR(64) NOT NULL,
  match_rule      ENUM('email','mobile','new','manual') NOT NULL,
  review          TINYINT(1) NOT NULL DEFAULT 0,
  review_note     VARCHAR(255) NULL,
  linked_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_cl_source (source, source_ref),
  KEY ix_b2b_cl_customer (customer_id),
  KEY ix_b2b_cl_review (review),
  CONSTRAINT fk_b2b_cl_customer FOREIGN KEY (customer_id) REFERENCES b2b_customers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- N4: order history across channels (shop orders mirrored read-only; others by reference).
CREATE TABLE IF NOT EXISTS b2b_customer_orders (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id     BIGINT UNSIGNED NOT NULL,
  channel         ENUM('b2c','event','b2b','field') NOT NULL,
  source_order_id VARCHAR(64) NOT NULL,
  order_no        VARCHAR(40) NULL,
  status          VARCHAR(30) NULL,
  total           DECIMAL(14,2) NULL,
  item_count      INT UNSIGNED NULL,
  ordered_at      DATETIME NULL,
  synced_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_co_source (channel, source_order_id),
  KEY ix_b2b_co_customer (customer_id, ordered_at),
  CONSTRAINT fk_b2b_co_customer FOREIGN KEY (customer_id) REFERENCES b2b_customers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
