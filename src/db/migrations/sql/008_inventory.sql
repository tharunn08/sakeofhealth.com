-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 6 (Inventory & warehouses). Not applied anywhere.
--  Existing b2b_stock / b2b_batches / b2b_stock_movements stay the ledger;
--  they gain lot_id and a quarantine bucket (alters.md). New: locations,
--  transfers, counts, dispositions, reorder rules, the B2C read-only cursor.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS b2b_warehouse_locations (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  warehouse_id  INT UNSIGNED NOT NULL,
  code          VARCHAR(30)  NOT NULL,          -- e.g. A-03-2 (aisle-rack-level)
  zone          ENUM('saleable','quarantine','damaged','expired','returns','dispatch','receiving') NOT NULL DEFAULT 'saleable',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_wl (warehouse_id, code),
  CONSTRAINT fk_b2b_wl_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_stock_transfers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transfer_no      VARCHAR(24)  NOT NULL,
  from_warehouse_id INT UNSIGNED NOT NULL,
  to_warehouse_id  INT UNSIGNED NOT NULL,
  status           ENUM('draft','approved','dispatched','received','cancelled') NOT NULL DEFAULT 'draft',
  -- company → distributor-owned warehouse is a SALE, not a transfer; the service refuses it
  reason           VARCHAR(300) NULL,
  dispatched_at    DATETIME NULL,
  received_at      DATETIME NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  received_by      BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_st_no (transfer_no),
  KEY ix_b2b_st_from (from_warehouse_id, status),
  KEY ix_b2b_st_to (to_warehouse_id, status),
  KEY ix_b2b_st_created_by (created_by),
  KEY ix_b2b_st_received_by (received_by),
  CONSTRAINT fk_b2b_st_from FOREIGN KEY (from_warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_st_to FOREIGN KEY (to_warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_st_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_st_received_by FOREIGN KEY (received_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_stock_transfer_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transfer_id   BIGINT UNSIGNED NOT NULL,
  lot_id        BIGINT UNSIGNED NOT NULL,
  qty_sent      INT UNSIGNED NOT NULL,
  qty_received  INT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_sti_transfer (transfer_id),
  KEY ix_b2b_sti_lot (lot_id),
  CONSTRAINT fk_b2b_sti_transfer FOREIGN KEY (transfer_id) REFERENCES b2b_stock_transfers (id),
  CONSTRAINT fk_b2b_sti_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cycle counts / full counts. Differences post as adjustments only after approval.
CREATE TABLE IF NOT EXISTS b2b_stock_counts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  count_no      VARCHAR(24)  NOT NULL,
  warehouse_id  INT UNSIGNED NOT NULL,
  count_type    ENUM('cycle','full','spot') NOT NULL DEFAULT 'cycle',
  status        ENUM('open','counted','pending_approval','posted','cancelled') NOT NULL DEFAULT 'open',
  approval_id   BIGINT UNSIGNED NULL,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at     DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_sc_no (count_no),
  KEY ix_b2b_sc_wh (warehouse_id, status),
  KEY ix_b2b_sc_approval (approval_id),
  KEY ix_b2b_sc_created_by (created_by),
  CONSTRAINT fk_b2b_sc_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_sc_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_sc_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_stock_count_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  count_id      BIGINT UNSIGNED NOT NULL,
  lot_id        BIGINT UNSIGNED NOT NULL,
  bucket        ENUM('available','quarantine','damaged','expired') NOT NULL DEFAULT 'available',
  system_qty    INT UNSIGNED NOT NULL,
  counted_qty   INT UNSIGNED NULL,
  counted_by    BIGINT UNSIGNED NULL,
  counted_at    DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_sci (count_id, lot_id, bucket),
  KEY ix_b2b_sci_lot (lot_id),
  KEY ix_b2b_sci_by (counted_by),
  CONSTRAINT fk_b2b_sci_count FOREIGN KEY (count_id) REFERENCES b2b_stock_counts (id),
  CONSTRAINT fk_b2b_sci_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id),
  CONSTRAINT fk_b2b_sci_by FOREIGN KEY (counted_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What happens to quarantined stock. Never automatic; proposer ≠ approver.
CREATE TABLE IF NOT EXISTS b2b_dispositions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  warehouse_id   INT UNSIGNED NOT NULL,
  lot_id         BIGINT UNSIGNED NOT NULL,
  qty            INT UNSIGNED NOT NULL,
  decision       ENUM('return_to_saleable','return_to_vendor','destroy','donate','rework') NOT NULL,
  source_type    ENUM('return','grn','recall','count','expiry') NOT NULL,
  source_id      BIGINT UNSIGNED NULL,
  status         ENUM('proposed','approved','rejected','executed') NOT NULL DEFAULT 'proposed',
  evidence_json  TEXT NULL,
  approval_id    BIGINT UNSIGNED NULL,
  proposed_by    BIGINT UNSIGNED NOT NULL,
  executed_at    DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_disp_wh (warehouse_id, status),
  KEY ix_b2b_disp_lot (lot_id),
  KEY ix_b2b_disp_source (source_type, source_id),
  KEY ix_b2b_disp_approval (approval_id),
  KEY ix_b2b_disp_proposed_by (proposed_by),
  CONSTRAINT fk_b2b_disp_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_disp_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id),
  CONSTRAINT fk_b2b_disp_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_disp_proposed_by FOREIGN KEY (proposed_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reorder levels per warehouse; feeds requisition suggestions.
CREATE TABLE IF NOT EXISTS b2b_reorder_rules (
  warehouse_id   INT UNSIGNED NOT NULL,
  product_id     BIGINT UNSIGNED NOT NULL,
  min_qty        INT UNSIGNED NOT NULL DEFAULT 0,
  reorder_qty    INT UNSIGNED NOT NULL DEFAULT 0,
  max_qty        INT UNSIGNED NULL,
  preferred_vendor_id BIGINT UNSIGNED NULL,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (warehouse_id, product_id),
  KEY ix_b2b_rr_product (product_id),
  KEY ix_b2b_rr_vendor (preferred_vendor_id),
  CONSTRAINT fk_b2b_rr_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_rr_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_rr_vendor FOREIGN KEY (preferred_vendor_id) REFERENCES b2b_vendors (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── B2C read-only adapter ───────────────
-- The adapter reads orders.json (never writes it) and remembers what it posted.
CREATE TABLE IF NOT EXISTS b2b_b2c_sync_cursor (
  id               TINYINT UNSIGNED NOT NULL,   -- always 1
  last_created_at  VARCHAR(40) NULL,            -- ISO string from orders.json
  last_run_at      DATETIME NULL,
  last_result      VARCHAR(300) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per B2C order line posted to the ledger: makes the sync idempotent and
-- lets the reconciliation report show online sales the ledger could not cover.
-- NOT real-time and NOT a stock reservation: the shop can still oversell (see B2C-PROTECTION.md).
CREATE TABLE IF NOT EXISTS b2b_b2c_order_postings (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  b2c_order_id     VARCHAR(64) NOT NULL,        -- orders.json "id"
  b2c_order_no     VARCHAR(32) NOT NULL,        -- "orderId" shown to customers
  b2c_item_ref     VARCHAR(64) NOT NULL,
  product_id       BIGINT UNSIGNED NULL,        -- NULL = not mapped yet
  qty              INT UNSIGNED NOT NULL,
  b2c_status       VARCHAR(20) NOT NULL,
  posting          ENUM('posted','reversed','unmapped','short_stock') NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_b2cp (b2c_order_id, b2c_item_ref, posting),
  KEY ix_b2b_b2cp_product (product_id),
  KEY ix_b2b_b2cp_posting (posting, created_at),
  CONSTRAINT fk_b2b_b2cp_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
