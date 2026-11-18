-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 10 (Returns, expiry, damage, recalls). Not applied anywhere.
--  Existing b2b_returns / b2b_return_items are extended (lot_id, return_type,
--  quarantine) — see alters.md. New: recall tables.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS b2b_recalls (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recall_no       VARCHAR(24) NOT NULL,
  initiated_by_party ENUM('manufacturer','company','regulator') NOT NULL,
  manufacturer_vendor_id BIGINT UNSIGNED NULL,
  severity        ENUM('class_1','class_2','class_3','precautionary') NOT NULL,
  reason          VARCHAR(1000) NOT NULL,
  scope           ENUM('full','partial') NOT NULL DEFAULT 'full',
  status          ENUM('draft','active','collecting','reconciling','pending_closure','closed','cancelled') NOT NULL DEFAULT 'draft',
  evidence_json   TEXT NULL,
  started_at      DATETIME NULL,
  closure_approval_id BIGINT UNSIGNED NULL,     -- closure needs a second approver
  closed_at       DATETIME NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_recall_no (recall_no),
  KEY ix_b2b_recall_status (status, created_at),
  KEY ix_b2b_recall_vendor (manufacturer_vendor_id),
  KEY ix_b2b_recall_approval (closure_approval_id),
  KEY ix_b2b_recall_created_by (created_by),
  CONSTRAINT fk_b2b_recall_vendor FOREIGN KEY (manufacturer_vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_recall_approval FOREIGN KEY (closure_approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_recall_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lots in the recall, with the quantities frozen when the recall starts and
-- updated as returns arrive.
CREATE TABLE IF NOT EXISTS b2b_recall_lots (
  recall_id        BIGINT UNSIGNED NOT NULL,
  lot_id           BIGINT UNSIGNED NOT NULL,
  qty_received_total INT UNSIGNED NOT NULL DEFAULT 0,   -- ever received into our warehouses
  qty_in_company_stock INT UNSIGNED NOT NULL DEFAULT 0,
  qty_shipped_out  INT UNSIGNED NOT NULL DEFAULT 0,
  qty_returned     INT UNSIGNED NOT NULL DEFAULT 0,
  qty_written_off  INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (recall_id, lot_id),
  KEY ix_b2b_rl_lot (lot_id),
  CONSTRAINT fk_b2b_rl_recall FOREIGN KEY (recall_id) REFERENCES b2b_recalls (id),
  CONSTRAINT fk_b2b_rl_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each distributor / retailer that received an affected lot (from order allocations).
CREATE TABLE IF NOT EXISTS b2b_recall_parties (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recall_id        BIGINT UNSIGNED NOT NULL,
  lot_id           BIGINT UNSIGNED NOT NULL,
  account_id       BIGINT UNSIGNED NOT NULL,
  qty_supplied     INT UNSIGNED NOT NULL,
  qty_returned     INT UNSIGNED NOT NULL DEFAULT 0,
  qty_declared_sold INT UNSIGNED NOT NULL DEFAULT 0,  -- already sold to consumers, declared by the party
  status           ENUM('to_notify','notified','acknowledged','collecting','complete','unreachable') NOT NULL DEFAULT 'to_notify',
  notified_at      DATETIME NULL,
  acknowledged_at  DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_rp (recall_id, lot_id, account_id),
  KEY ix_b2b_rp_account (account_id),
  KEY ix_b2b_rp_lot (lot_id),
  KEY ix_b2b_rp_status (recall_id, status),
  CONSTRAINT fk_b2b_rparty_recall FOREIGN KEY (recall_id) REFERENCES b2b_recalls (id),
  CONSTRAINT fk_b2b_rparty_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id),
  CONSTRAINT fk_b2b_rparty_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Physical receipts of recalled stock (goes straight to the quarantine bucket).
CREATE TABLE IF NOT EXISTS b2b_recall_receipts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recall_party_id  BIGINT UNSIGNED NOT NULL,
  warehouse_id     INT UNSIGNED NOT NULL,
  qty              INT UNSIGNED NOT NULL,
  return_id        BIGINT UNSIGNED NULL,
  received_by      BIGINT UNSIGNED NOT NULL,
  received_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_rr2_party (recall_party_id),
  KEY ix_b2b_rr2_wh (warehouse_id),
  KEY ix_b2b_rr2_return (return_id),
  KEY ix_b2b_rr2_by (received_by),
  CONSTRAINT fk_b2b_rrec_party FOREIGN KEY (recall_party_id) REFERENCES b2b_recall_parties (id),
  CONSTRAINT fk_b2b_rrec_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_rrec_return FOREIGN KEY (return_id) REFERENCES b2b_returns (id),
  CONSTRAINT fk_b2b_rrec_by FOREIGN KEY (received_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

