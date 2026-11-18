-- Migration 017 — central inventory ledger (DRAFT: disposable test databases only until approved).
-- Additive only. The ledger stays b2b_stock (balances) + b2b_stock_movements (append-only);
-- this adds holds that are not B2B orders, and approved stock adjustments / opening balances.

-- Holds that are not B2B orders (shop checkout, event cart). mode 'shadow' rows never touch b2b_stock.
CREATE TABLE IF NOT EXISTS b2b_stock_reservations (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  warehouse_id     INT UNSIGNED NOT NULL,
  product_id       BIGINT UNSIGNED NOT NULL,
  qty              INT UNSIGNED NOT NULL,
  channel          ENUM('b2c','event') NOT NULL,
  mode             ENUM('live','shadow') NOT NULL DEFAULT 'live',
  source_ref       VARCHAR(80) NOT NULL,
  status           ENUM('held','committed','released','expired','short') NOT NULL DEFAULT 'held',
  expires_at       DATETIME NULL,
  payment_seen_at  DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_sr_source (channel, mode, source_ref, product_id),
  KEY ix_b2b_sr_due (status, expires_at),
  CONSTRAINT fk_b2b_sr_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_sr_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Owner decision 5: stock is added only through a GRN or an approved adjustment; opening
-- balances are a proposed-then-approved record of their own. Posted by a second person.
CREATE TABLE IF NOT EXISTS b2b_stock_adjustments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  adj_no         VARCHAR(24) NOT NULL,
  kind           ENUM('adjustment','opening') NOT NULL,
  direction      ENUM('increase','decrease') NOT NULL,
  warehouse_id   INT UNSIGNED NOT NULL,
  product_id     BIGINT UNSIGNED NOT NULL,
  lot_id         BIGINT UNSIGNED NULL,
  bucket         ENUM('available','damaged','expired','quarantine') NOT NULL,
  qty            INT UNSIGNED NOT NULL,
  reason_code    ENUM('opening_balance','found','damage','expiry','loss','theft','correction') NOT NULL,
  reason         VARCHAR(300) NOT NULL,
  status         ENUM('proposed','posted','rejected','withdrawn') NOT NULL DEFAULT 'proposed',
  approval_id    BIGINT UNSIGNED NULL,
  proposed_by    BIGINT UNSIGNED NOT NULL,
  posted_at      DATETIME NULL,
  open_key       VARCHAR(80) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_sa_no (adj_no),
  UNIQUE KEY uq_b2b_sa_open (open_key),
  KEY ix_b2b_sa_wh (warehouse_id, status),
  CONSTRAINT fk_b2b_sa_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_sa_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_sa_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
