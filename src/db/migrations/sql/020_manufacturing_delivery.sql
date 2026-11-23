-- ════════════════════════════════════════════════════════════════════════════
--  020 — manufacturing and delivery. Additive only: new tables, no existing row changed.
--
--  Manufacturing: manufacturing facilities (a manufacturer's plant, or our own when
--  vendor_id is NULL), bills of materials, manufacturing orders (contract = made by a
--  manufacturer against a purchase order; in_house = made in our facility from issued
--  materials), production updates, material issues, manufactured batches with their
--  QC decision, and production documents (Certificates of Analysis, test reports).
--  Stock moves only through the one ledger (b2b_stock / b2b_stock_movements).
--
--  Delivery: one shipment per trade order (vehicle, driver, courier, tracking, e-way
--  bill, proof of delivery), its tracking timeline, and the delivery challan issued at
--  dispatch (an immutable snapshot of what left, by batch). Order statuses, stock,
--  invoices and notifications stay in the existing order flow; a shipment drives it.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS b2b_mfg_facilities (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id          BIGINT UNSIGNED NULL,          -- NULL = our own plant
  name               VARCHAR(160) NOT NULL,
  address            VARCHAR(400) NULL,
  city               VARCHAR(80)  NULL,
  state_id           SMALLINT UNSIGNED NULL,
  pincode            CHAR(6)      NULL,
  fssai_licence      VARCHAR(20)  NULL,
  fssai_valid_to     DATE NULL,
  capacity_per_month INT UNSIGNED NULL,
  capacity_uom       VARCHAR(20)  NULL,             -- units, kg, litres …
  categories_note    VARCHAR(500) NULL,
  status             ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by         BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_mfgf_name (vendor_id, name),
  KEY ix_b2b_mfgf_status (status),
  KEY ix_b2b_mfgf_state (state_id),
  CONSTRAINT fk_b2b_mfgf_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_mfgf_state FOREIGN KEY (state_id) REFERENCES b2b_states (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_boms (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id    BIGINT UNSIGNED NOT NULL,           -- the finished product
  version       SMALLINT UNSIGNED NOT NULL,
  output_qty    INT UNSIGNED NOT NULL,              -- the lines below make this many units
  status        ENUM('draft','active','archived') NOT NULL DEFAULT 'draft',
  note          VARCHAR(500) NULL,
  created_by    BIGINT UNSIGNED NULL,
  approved_by   BIGINT UNSIGNED NULL,
  approved_at   DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_bom_version (product_id, version),
  KEY ix_b2b_bom_status (product_id, status),
  CONSTRAINT fk_b2b_bom_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_bom_lines (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bom_id               BIGINT UNSIGNED NOT NULL,
  component_product_id BIGINT UNSIGNED NOT NULL,    -- raw material or packaging (a product row)
  qty                  DECIMAL(14,4) NOT NULL,      -- per output_qty
  scrap_pct            DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  note                 VARCHAR(200) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_boml_component (bom_id, component_product_id),
  KEY ix_b2b_boml_component (component_product_id),
  CONSTRAINT fk_b2b_boml_bom FOREIGN KEY (bom_id) REFERENCES b2b_boms (id),
  CONSTRAINT fk_b2b_boml_product FOREIGN KEY (component_product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_mfg_orders (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mo_no          VARCHAR(30)  NOT NULL,
  mode           ENUM('contract','in_house') NOT NULL,
  vendor_id      BIGINT UNSIGNED NULL,              -- the manufacturer (contract)
  facility_id    BIGINT UNSIGNED NULL,
  product_id     BIGINT UNSIGNED NOT NULL,
  bom_id         BIGINT UNSIGNED NULL,
  po_id          BIGINT UNSIGNED NULL,              -- contract: the purchase order the goods arrive against
  warehouse_id   INT UNSIGNED NOT NULL,             -- in_house: materials and output; contract: receiving warehouse
  planned_qty    INT UNSIGNED NOT NULL,
  produced_qty   INT UNSIGNED NOT NULL DEFAULT 0,   -- batches recorded
  released_qty   INT UNSIGNED NOT NULL DEFAULT 0,   -- passed QC
  rejected_qty   INT UNSIGNED NOT NULL DEFAULT 0,   -- failed QC
  planned_start  DATE NULL,
  planned_end    DATE NULL,
  status         ENUM('draft','released','accepted','in_production','completed','closed','cancelled') NOT NULL DEFAULT 'draft',
  note           VARCHAR(500) NULL,
  cancel_reason  VARCHAR(300) NULL,
  created_by     BIGINT UNSIGNED NULL,
  released_at    DATETIME NULL,
  accepted_at    DATETIME NULL,
  started_at     DATETIME NULL,
  completed_at   DATETIME NULL,
  closed_at      DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_mo_no (mo_no),
  KEY ix_b2b_mo_vendor (vendor_id, status),
  KEY ix_b2b_mo_status (status, planned_end),
  KEY ix_b2b_mo_product (product_id),
  KEY ix_b2b_mo_po (po_id),
  KEY ix_b2b_mo_facility (facility_id),
  KEY ix_b2b_mo_bom (bom_id),
  KEY ix_b2b_mo_wh (warehouse_id),
  CONSTRAINT fk_b2b_mo_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_mo_facility FOREIGN KEY (facility_id) REFERENCES b2b_mfg_facilities (id),
  CONSTRAINT fk_b2b_mo_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_mo_bom FOREIGN KEY (bom_id) REFERENCES b2b_boms (id),
  CONSTRAINT fk_b2b_mo_po FOREIGN KEY (po_id) REFERENCES b2b_purchase_orders (id),
  CONSTRAINT fk_b2b_mo_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_mfg_order_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mo_id        BIGINT UNSIGNED NOT NULL,
  kind         ENUM('status','progress','note','material_issue','batch','qc','document') NOT NULL,
  stage        VARCHAR(60)  NULL,                    -- e.g. mixing, filling, packing; or the new status
  qty          INT UNSIGNED NULL,
  note         VARCHAR(500) NULL,
  actor_type   ENUM('staff','vendor','system') NOT NULL,
  actor_id     BIGINT UNSIGNED NULL,
  actor_label  VARCHAR(160) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_moe_mo (mo_id, id),
  CONSTRAINT fk_b2b_moe_mo FOREIGN KEY (mo_id) REFERENCES b2b_mfg_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_mfg_material_issues (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mo_id         BIGINT UNSIGNED NOT NULL,
  product_id    BIGINT UNSIGNED NOT NULL,            -- the component
  warehouse_id  INT UNSIGNED NOT NULL,
  batch_id      BIGINT UNSIGNED NULL,
  qty           INT UNSIGNED NOT NULL,
  kind          ENUM('issue','return') NOT NULL DEFAULT 'issue',
  idem_key      VARCHAR(80) NOT NULL,
  issued_by     BIGINT UNSIGNED NULL,
  issued_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_mmi_key (idem_key),
  KEY ix_b2b_mmi_mo (mo_id, product_id),
  KEY ix_b2b_mmi_product (product_id),
  KEY ix_b2b_mmi_wh (warehouse_id),
  KEY ix_b2b_mmi_batch (batch_id),
  CONSTRAINT fk_b2b_mmi_mo FOREIGN KEY (mo_id) REFERENCES b2b_mfg_orders (id),
  CONSTRAINT fk_b2b_mmi_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_mmi_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_mmi_batch FOREIGN KEY (batch_id) REFERENCES b2b_batches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_mfg_documents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mo_id          BIGINT UNSIGNED NOT NULL,
  batch_id       BIGINT UNSIGNED NULL,               -- b2b_mfg_batches.id (set after the batch row exists)
  doc_type       ENUM('coa','test_report','production_record','other') NOT NULL,
  original_name  VARCHAR(200) NOT NULL,
  stored_name    VARCHAR(80)  NOT NULL,
  mime_type      VARCHAR(80)  NOT NULL,
  size_bytes     INT UNSIGNED NOT NULL,
  sha256         CHAR(64)     NOT NULL,
  uploaded_by_type ENUM('staff','vendor') NOT NULL,
  uploaded_by_id BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_mfgd_mo (mo_id),
  KEY ix_b2b_mfgd_batch (batch_id),
  CONSTRAINT fk_b2b_mfgd_mo FOREIGN KEY (mo_id) REFERENCES b2b_mfg_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_mfg_batches (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mo_id          BIGINT UNSIGNED NOT NULL,
  product_id     BIGINT UNSIGNED NOT NULL,
  batch_no       VARCHAR(60)  NOT NULL,
  batch_no_norm  VARCHAR(60)  NOT NULL,
  mfg_date       DATE NOT NULL,
  expiry_date    DATE NOT NULL,
  qty            INT UNSIGNED NOT NULL,
  -- submitted: recorded, waiting for QC · released: passed (in_house: stock now available;
  -- contract: approved for dispatch) · rejected: failed (in_house: stock to damaged)
  status         ENUM('submitted','released','rejected') NOT NULL DEFAULT 'submitted',
  coa_document_id BIGINT UNSIGNED NULL,
  released_qty   INT UNSIGNED NOT NULL DEFAULT 0,
  rejected_qty   INT UNSIGNED NOT NULL DEFAULT 0,
  qc_note        VARCHAR(500) NULL,
  qc_checklist_json TEXT NULL,
  qc_by          BIGINT UNSIGNED NULL,
  qc_at          DATETIME NULL,
  lot_id         BIGINT UNSIGNED NULL,               -- b2b_lots, once stock exists (in_house)
  stock_batch_id BIGINT UNSIGNED NULL,               -- b2b_batches at the warehouse (in_house)
  created_by_type ENUM('staff','vendor') NOT NULL,
  created_by_id  BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_mfgb_batch (mo_id, batch_no_norm),
  KEY ix_b2b_mfgb_product (product_id, batch_no_norm),
  KEY ix_b2b_mfgb_status (status, created_at),
  KEY ix_b2b_mfgb_coa (coa_document_id),
  KEY ix_b2b_mfgb_lot (lot_id),
  KEY ix_b2b_mfgb_stock (stock_batch_id),
  CONSTRAINT fk_b2b_mfgb_mo FOREIGN KEY (mo_id) REFERENCES b2b_mfg_orders (id),
  CONSTRAINT fk_b2b_mfgb_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_mfgb_coa FOREIGN KEY (coa_document_id) REFERENCES b2b_mfg_documents (id),
  CONSTRAINT fk_b2b_mfgb_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id),
  CONSTRAINT fk_b2b_mfgb_stock FOREIGN KEY (stock_batch_id) REFERENCES b2b_batches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_shipments (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shipment_no     VARCHAR(30)  NOT NULL,
  order_id        BIGINT UNSIGNED NOT NULL,
  seller_type     ENUM('company','distributor') NOT NULL,
  seller_account_id BIGINT UNSIGNED NULL,
  warehouse_id    INT UNSIGNED NULL,
  mode            ENUM('own_vehicle','courier','transporter','pickup') NOT NULL,
  carrier         VARCHAR(120) NULL,
  vehicle_no      VARCHAR(20)  NULL,
  driver_name     VARCHAR(120) NULL,
  driver_phone    CHAR(10)     NULL,
  delivery_staff_id BIGINT UNSIGNED NULL,           -- b2b_staff doing the delivery (field app)
  tracking_no     VARCHAR(60)  NULL,
  lr_no           VARCHAR(60)  NULL,
  eway_bill_no    VARCHAR(20)  NULL,
  packages        SMALLINT UNSIGNED NULL,
  weight_kg       DECIMAL(9,2) NULL,
  status          ENUM('ready','dispatched','out_for_delivery','attempt_failed','delivered','partially_delivered','returned','cancelled') NOT NULL DEFAULT 'ready',
  expected_at     DATETIME NULL,
  dispatched_at   DATETIME NULL,
  out_at          DATETIME NULL,
  delivered_at    DATETIME NULL,
  returned_at     DATETIME NULL,
  attempts        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  pod_received_by VARCHAR(120) NULL,
  pod_phone       CHAR(10)     NULL,
  pod_note        VARCHAR(300) NULL,
  pod_stored_name VARCHAR(80)  NULL,
  pod_mime        VARCHAR(80)  NULL,
  pod_sha256      CHAR(64)     NULL,
  pod_lat         DECIMAL(10,7) NULL,
  pod_lng         DECIMAL(10,7) NULL,
  delay_alerted_at DATETIME NULL,
  created_by_type ENUM('staff','business','system') NOT NULL,
  created_by_id   BIGINT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_ship_no (shipment_no),
  UNIQUE KEY uq_b2b_ship_order (order_id),
  KEY ix_b2b_ship_status (status, expected_at),
  KEY ix_b2b_ship_staff (delivery_staff_id, status),
  KEY ix_b2b_ship_seller (seller_account_id),
  KEY ix_b2b_ship_wh (warehouse_id),
  CONSTRAINT fk_b2b_ship_order FOREIGN KEY (order_id) REFERENCES b2b_orders (id),
  CONSTRAINT fk_b2b_ship_seller FOREIGN KEY (seller_account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_ship_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_ship_staff FOREIGN KEY (delivery_staff_id) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_shipment_events (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  shipment_id  BIGINT UNSIGNED NOT NULL,
  kind         ENUM('created','details_changed','dispatched','out_for_delivery','location','attempt_failed','delivered','partially_delivered','returned','cancelled','note') NOT NULL,
  note         VARCHAR(500) NULL,
  place        VARCHAR(160) NULL,
  lat          DECIMAL(10,7) NULL,
  lng          DECIMAL(10,7) NULL,
  actor_type   ENUM('staff','business','system') NOT NULL,
  actor_id     BIGINT UNSIGNED NULL,
  actor_label  VARCHAR(160) NULL,
  client_uuid  CHAR(36) NULL,                        -- offline: the same update is recorded once
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_shipe_client (client_uuid),
  KEY ix_b2b_shipe_ship (shipment_id, id),
  CONSTRAINT fk_b2b_shipe_ship FOREIGN KEY (shipment_id) REFERENCES b2b_shipments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_delivery_challans (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  challan_no    VARCHAR(30)  NOT NULL,
  shipment_id   BIGINT UNSIGNED NOT NULL,
  order_id      BIGINT UNSIGNED NOT NULL,
  lines_json    MEDIUMTEXT NOT NULL,                 -- what left, by product and batch (snapshot)
  value_total   DECIMAL(14,2) NOT NULL,
  issued_by_type ENUM('staff','business','system') NOT NULL,
  issued_by_id  BIGINT UNSIGNED NULL,
  issued_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_dc_no (challan_no),
  UNIQUE KEY uq_b2b_dc_ship (shipment_id),
  KEY ix_b2b_dc_order (order_id),
  CONSTRAINT fk_b2b_dc_ship FOREIGN KEY (shipment_id) REFERENCES b2b_shipments (id),
  CONSTRAINT fk_b2b_dc_order FOREIGN KEY (order_id) REFERENCES b2b_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
