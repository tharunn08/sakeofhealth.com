-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 5 (Procurement, purchase-to-pay) + the lot master.
--  Not applied anywhere.
--  Rule: only a posted GRN creates lots and increases company stock.
--  A lot is identified by product + manufacturer + batch number (the same
--  batch number "BHP482/S85" appears on two products in invoice 4050191465).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS b2b_lots (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id          BIGINT UNSIGNED NOT NULL,
  -- NOT NULL so the unique key really is unique (MySQL allows repeated NULLs);
  -- lots migrated from old b2b_batches point at a seeded "Unknown — migrated" vendor
  manufacturer_vendor_id BIGINT UNSIGNED NOT NULL,
  batch_no            VARCHAR(60)  NOT NULL,
  batch_no_norm       VARCHAR(60)  NOT NULL,     -- upper-case, spaces removed: matching key
  mfg_date            DATE NULL,
  expiry_date         DATE NULL,
  mrp                 DECIMAL(12,2) NULL,
  first_grn_id        BIGINT UNSIGNED NULL,
  status              ENUM('released','on_hold','recalled','expired','closed') NOT NULL DEFAULT 'released',
  hold_reason         VARCHAR(300) NULL,
  -- expiry/mfg can only change through a correction with approval; the old value goes to the audit log
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_lots_identity (product_id, manufacturer_vendor_id, batch_no_norm),
  KEY ix_b2b_lots_batch (batch_no_norm),
  KEY ix_b2b_lots_expiry (status, expiry_date),
  KEY ix_b2b_lots_maker (manufacturer_vendor_id),
  KEY ix_b2b_lots_grn (first_grn_id),
  CONSTRAINT fk_b2b_lots_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_lots_maker FOREIGN KEY (manufacturer_vendor_id) REFERENCES b2b_vendors (id)
  -- fk first_grn_id → b2b_grns added in alters (created below, circular dependency)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Requisitions ───────────────
CREATE TABLE IF NOT EXISTS b2b_purchase_requisitions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pr_no         VARCHAR(24)  NOT NULL,
  source        ENUM('manual','reorder_level','sales_forecast','open_orders','expiry_replacement') NOT NULL DEFAULT 'manual',
  warehouse_id  INT UNSIGNED NOT NULL,
  needed_by     DATE NULL,
  status        ENUM('draft','submitted','approved','rejected','converted','cancelled') NOT NULL DEFAULT 'draft',
  note          VARCHAR(500) NULL,
  approval_id   BIGINT UNSIGNED NULL,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_pr_no (pr_no),
  KEY ix_b2b_pr_status (status, created_at),
  KEY ix_b2b_pr_wh (warehouse_id),
  KEY ix_b2b_pr_approval (approval_id),
  KEY ix_b2b_pr_created_by (created_by),
  CONSTRAINT fk_b2b_pr_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_pr_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_pr_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_purchase_requisition_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pr_id         BIGINT UNSIGNED NOT NULL,
  product_id    BIGINT UNSIGNED NOT NULL,
  qty           INT UNSIGNED NOT NULL,
  suggested_qty INT UNSIGNED NULL,           -- what the reorder rule proposed
  reason_json   VARCHAR(1000) NULL,          -- stock, reorder level, 30-day sales, open orders
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_pri (pr_id, product_id),
  KEY ix_b2b_pri_product (product_id),
  CONSTRAINT fk_b2b_pri_pr FOREIGN KEY (pr_id) REFERENCES b2b_purchase_requisitions (id),
  CONSTRAINT fk_b2b_pri_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── RFQ and quotations ───────────────
CREATE TABLE IF NOT EXISTS b2b_rfqs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rfq_no        VARCHAR(24)  NOT NULL,
  pr_id         BIGINT UNSIGNED NULL,
  title         VARCHAR(200) NOT NULL,
  delivery_warehouse_id INT UNSIGNED NOT NULL,
  respond_by    DATETIME NOT NULL,
  status        ENUM('draft','sent','closed','awarded','cancelled') NOT NULL DEFAULT 'draft',
  terms_note    VARCHAR(1000) NULL,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_rfq_no (rfq_no),
  KEY ix_b2b_rfq_status (status, respond_by),
  KEY ix_b2b_rfq_pr (pr_id),
  KEY ix_b2b_rfq_wh (delivery_warehouse_id),
  KEY ix_b2b_rfq_created_by (created_by),
  CONSTRAINT fk_b2b_rfq_pr FOREIGN KEY (pr_id) REFERENCES b2b_purchase_requisitions (id),
  CONSTRAINT fk_b2b_rfq_wh FOREIGN KEY (delivery_warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_rfq_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_rfq_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rfq_id        BIGINT UNSIGNED NOT NULL,
  product_id    BIGINT UNSIGNED NOT NULL,
  qty           INT UNSIGNED NOT NULL,
  min_shelf_life_pct TINYINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_rfqi (rfq_id, product_id),
  KEY ix_b2b_rfqi_product (product_id),
  CONSTRAINT fk_b2b_rfqi_rfq FOREIGN KEY (rfq_id) REFERENCES b2b_rfqs (id),
  CONSTRAINT fk_b2b_rfqi_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which approved vendors were invited. Only invited vendors can see the RFQ.
CREATE TABLE IF NOT EXISTS b2b_rfq_vendors (
  rfq_id        BIGINT UNSIGNED NOT NULL,
  vendor_id     BIGINT UNSIGNED NOT NULL,
  invited_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  viewed_at     DATETIME NULL,
  declined_at   DATETIME NULL,
  PRIMARY KEY (rfq_id, vendor_id),
  KEY ix_b2b_rfqv_vendor (vendor_id),
  CONSTRAINT fk_b2b_rfqv_rfq FOREIGN KEY (rfq_id) REFERENCES b2b_rfqs (id),
  CONSTRAINT fk_b2b_rfqv_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_rfq_responses (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rfq_id           BIGINT UNSIGNED NOT NULL,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  revision         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  valid_until      DATE NOT NULL,
  payment_terms_days SMALLINT UNSIGNED NULL,
  freight_total    DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  note             VARCHAR(1000) NULL,
  status           ENUM('submitted','withdrawn','shortlisted','awarded','not_awarded') NOT NULL DEFAULT 'submitted',
  submitted_by     BIGINT UNSIGNED NULL,       -- vendor user
  submitted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_rfqr (rfq_id, vendor_id, revision),
  KEY ix_b2b_rfqr_vendor (vendor_id, submitted_at),
  KEY ix_b2b_rfqr_user (submitted_by),
  CONSTRAINT fk_b2b_rfqr_rfq FOREIGN KEY (rfq_id) REFERENCES b2b_rfqs (id),
  CONSTRAINT fk_b2b_rfqr_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_rfqr_user FOREIGN KEY (submitted_by) REFERENCES b2b_vendor_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_rfq_response_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  response_id     BIGINT UNSIGNED NOT NULL,
  rfq_item_id     BIGINT UNSIGNED NOT NULL,
  available_qty   INT UNSIGNED NOT NULL,
  unit_price      DECIMAL(12,4) NOT NULL,     -- ex-GST
  gst_rate        DECIMAL(5,2)  NOT NULL,
  discount_pct    DECIMAL(7,4)  NOT NULL DEFAULT 0.0000,
  moq             INT UNSIGNED NULL,
  lead_days       SMALLINT UNSIGNED NULL,
  batch_expiry_from DATE NULL,                -- earliest expiry they will ship
  landed_unit_cost DECIMAL(12,4) NULL,        -- computed by us: price − discount + freight share
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_rfqri (response_id, rfq_item_id),
  KEY ix_b2b_rfqri_item (rfq_item_id),
  CONSTRAINT fk_b2b_rfqri_resp FOREIGN KEY (response_id) REFERENCES b2b_rfq_responses (id),
  CONSTRAINT fk_b2b_rfqri_item FOREIGN KEY (rfq_item_id) REFERENCES b2b_rfq_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Purchase orders ───────────────
CREATE TABLE IF NOT EXISTS b2b_purchase_orders (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  po_no             VARCHAR(24)  NOT NULL,      -- e.g. FM-BNG-LHCAW-08-66 style, from a sequence
  revision          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  vendor_id         BIGINT UNSIGNED NOT NULL,
  rfq_id            BIGINT UNSIGNED NULL,
  award_reason      VARCHAR(500) NULL,         -- required when the lowest landed cost was not chosen
  ship_to_warehouse_id INT UNSIGNED NOT NULL,
  bill_to_state_id  SMALLINT UNSIGNED NOT NULL,
  is_interstate     TINYINT(1) NOT NULL DEFAULT 0,
  status            ENUM('draft','pending_approval','approved','sent','accepted','partially_accepted','change_requested',
                         'rejected_by_vendor','partially_received','received','closed','cancelled') NOT NULL DEFAULT 'draft',
  delivery_by       DATE NULL,
  payment_terms_days SMALLINT UNSIGNED NULL,
  min_shelf_life_pct TINYINT UNSIGNED NULL,
  quality_terms     VARCHAR(1000) NULL,
  taxable_total     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  discount_total    DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  freight_total     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  cgst_total        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_total        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_total        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  grand_total       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  approval_id       BIGINT UNSIGNED NULL,
  sent_at           DATETIME NULL,
  created_by        BIGINT UNSIGNED NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_po_no (po_no, revision),
  KEY ix_b2b_po_vendor (vendor_id, status, created_at),
  KEY ix_b2b_po_status (status, delivery_by),
  KEY ix_b2b_po_rfq (rfq_id),
  KEY ix_b2b_po_wh (ship_to_warehouse_id),
  KEY ix_b2b_po_state (bill_to_state_id),
  KEY ix_b2b_po_approval (approval_id),
  KEY ix_b2b_po_created_by (created_by),
  CONSTRAINT fk_b2b_po_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_po_rfq FOREIGN KEY (rfq_id) REFERENCES b2b_rfqs (id),
  CONSTRAINT fk_b2b_po_wh FOREIGN KEY (ship_to_warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_po_state FOREIGN KEY (bill_to_state_id) REFERENCES b2b_states (id),
  CONSTRAINT fk_b2b_po_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_po_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_purchase_order_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  po_id           BIGINT UNSIGNED NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  hsn_code        VARCHAR(10)  NULL,
  qty_ordered     INT UNSIGNED NOT NULL,
  qty_accepted_by_vendor INT UNSIGNED NULL,
  qty_received    INT UNSIGNED NOT NULL DEFAULT 0,   -- accepted at GRN, kept in step by the GRN post
  qty_rejected    INT UNSIGNED NOT NULL DEFAULT 0,
  unit_price      DECIMAL(12,4) NOT NULL,
  discount_pct    DECIMAL(7,4)  NOT NULL DEFAULT 0.0000,
  gst_rate        DECIMAL(5,2)  NOT NULL,
  taxable_amount  DECIMAL(14,2) NOT NULL,
  tax_amount      DECIMAL(14,2) NOT NULL,
  line_total      DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_poi (po_id, product_id),
  KEY ix_b2b_poi_product (product_id),
  CONSTRAINT fk_b2b_poi_po FOREIGN KEY (po_id) REFERENCES b2b_purchase_orders (id),
  CONSTRAINT fk_b2b_poi_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vendor's answer to a PO: accept, partial, reject, or a change request
-- (a change creates a new PO revision that needs internal approval).
CREATE TABLE IF NOT EXISTS b2b_po_acknowledgements (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  po_id         BIGINT UNSIGNED NOT NULL,
  response      ENUM('accepted','partially_accepted','change_requested','rejected') NOT NULL,
  changes_json  TEXT NULL,
  note          VARCHAR(1000) NULL,
  vendor_user_id BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_poa_po (po_id, created_at),
  KEY ix_b2b_poa_user (vendor_user_id),
  CONSTRAINT fk_b2b_poa_po FOREIGN KEY (po_id) REFERENCES b2b_purchase_orders (id),
  CONSTRAINT fk_b2b_poa_user FOREIGN KEY (vendor_user_id) REFERENCES b2b_vendor_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Dispatch notice (ASN) from the vendor ───────────────
CREATE TABLE IF NOT EXISTS b2b_asns (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  po_id            BIGINT UNSIGNED NOT NULL,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  delivery_note_no VARCHAR(40)  NULL,          -- invoice shows "Delivery Note 1125196312"
  vendor_invoice_no VARCHAR(40) NULL,
  eway_bill_no     VARCHAR(20)  NULL,
  transporter      VARCHAR(120) NULL,
  lr_no            VARCHAR(40)  NULL,
  dispatched_at    DATETIME NULL,
  expected_at      DATETIME NULL,
  status           ENUM('draft','dispatched','arrived','received','cancelled') NOT NULL DEFAULT 'draft',
  created_by_vendor_user BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_asn_po (po_id),
  KEY ix_b2b_asn_vendor (vendor_id, status),
  KEY ix_b2b_asn_user (created_by_vendor_user),
  CONSTRAINT fk_b2b_asn_po FOREIGN KEY (po_id) REFERENCES b2b_purchase_orders (id),
  CONSTRAINT fk_b2b_asn_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_asn_user FOREIGN KEY (created_by_vendor_user) REFERENCES b2b_vendor_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_asn_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  asn_id        BIGINT UNSIGNED NOT NULL,
  po_item_id    BIGINT UNSIGNED NOT NULL,
  batch_no      VARCHAR(60)  NOT NULL,
  mfg_date      DATE NULL,
  expiry_date   DATE NULL,
  mrp           DECIMAL(12,2) NULL,
  qty           INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_asni_asn (asn_id),
  KEY ix_b2b_asni_poi (po_item_id),
  CONSTRAINT fk_b2b_asni_asn FOREIGN KEY (asn_id) REFERENCES b2b_asns (id),
  CONSTRAINT fk_b2b_asni_poi FOREIGN KEY (po_item_id) REFERENCES b2b_purchase_order_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Goods received + quality inspection ───────────────
CREATE TABLE IF NOT EXISTS b2b_grns (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  grn_no         VARCHAR(24)  NOT NULL,
  po_id          BIGINT UNSIGNED NOT NULL,
  asn_id         BIGINT UNSIGNED NULL,
  warehouse_id   INT UNSIGNED NOT NULL,
  vendor_invoice_no VARCHAR(40) NULL,
  status         ENUM('draft','inspecting','pending_approval','posted','cancelled') NOT NULL DEFAULT 'draft',
  received_at    DATETIME NOT NULL,
  received_by    BIGINT UNSIGNED NOT NULL,
  posted_at      DATETIME NULL,
  posted_by      BIGINT UNSIGNED NULL,
  approval_id    BIGINT UNSIGNED NULL,        -- required when variance exceeds tolerance
  note           VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_grn_no (grn_no),
  KEY ix_b2b_grn_po (po_id),
  KEY ix_b2b_grn_asn (asn_id),
  KEY ix_b2b_grn_wh (warehouse_id, status, received_at),
  KEY ix_b2b_grn_received_by (received_by),
  KEY ix_b2b_grn_posted_by (posted_by),
  KEY ix_b2b_grn_approval (approval_id),
  CONSTRAINT fk_b2b_grn_po FOREIGN KEY (po_id) REFERENCES b2b_purchase_orders (id),
  CONSTRAINT fk_b2b_grn_asn FOREIGN KEY (asn_id) REFERENCES b2b_asns (id),
  CONSTRAINT fk_b2b_grn_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_grn_received_by FOREIGN KEY (received_by) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_grn_posted_by FOREIGN KEY (posted_by) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_grn_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_grn_items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  grn_id           BIGINT UNSIGNED NOT NULL,
  po_item_id       BIGINT UNSIGNED NOT NULL,
  product_id       BIGINT UNSIGNED NOT NULL,
  batch_no         VARCHAR(60)  NOT NULL,
  mfg_date         DATE NULL,
  expiry_date      DATE NULL,
  mrp              DECIMAL(12,2) NULL,
  qty_received     INT UNSIGNED NOT NULL,
  qty_accepted     INT UNSIGNED NOT NULL DEFAULT 0,
  qty_rejected     INT UNSIGNED NOT NULL DEFAULT 0,
  qty_quarantined  INT UNSIGNED NOT NULL DEFAULT 0,
  reject_reason    ENUM('damaged','short_expiry','wrong_item','quality_fail','excess','other') NULL,
  lot_id           BIGINT UNSIGNED NULL,        -- set when posted
  shelf_life_left_pct DECIMAL(5,2) NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_grni_grn (grn_id),
  KEY ix_b2b_grni_poi (po_item_id),
  KEY ix_b2b_grni_product (product_id),
  KEY ix_b2b_grni_lot (lot_id),
  CONSTRAINT fk_b2b_grni_grn FOREIGN KEY (grn_id) REFERENCES b2b_grns (id),
  CONSTRAINT fk_b2b_grni_poi FOREIGN KEY (po_item_id) REFERENCES b2b_purchase_order_items (id),
  CONSTRAINT fk_b2b_grni_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_grni_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_quality_inspections (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ref_type       ENUM('grn_item','return_item','stock_count') NOT NULL,
  ref_id         BIGINT UNSIGNED NOT NULL,
  result         ENUM('pass','fail','partial') NOT NULL,
  checklist_json TEXT NULL,                    -- seal, label, MRP print, expiry, damage, FSSAI mark
  photos_json    TEXT NULL,                    -- stored file names in the private dir
  note           VARCHAR(500) NULL,
  inspected_by   BIGINT UNSIGNED NOT NULL,
  inspected_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_qi_ref (ref_type, ref_id),
  KEY ix_b2b_qi_by (inspected_by),
  CONSTRAINT fk_b2b_qi_by FOREIGN KEY (inspected_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Supplier bills, matching, payments, purchase returns ───────────────
CREATE TABLE IF NOT EXISTS b2b_supplier_invoices (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  invoice_no       VARCHAR(40)  NOT NULL,
  invoice_date     DATE NOT NULL,
  invoice_kind     ENUM('tax_invoice','proforma') NOT NULL DEFAULT 'tax_invoice', -- a proforma is never payable
  po_id            BIGINT UNSIGNED NULL,
  supplier_gstin   CHAR(15) NULL,
  buyer_gstin      CHAR(15) NULL,
  is_interstate    TINYINT(1) NOT NULL DEFAULT 0,
  taxable_total    DECIMAL(14,2) NOT NULL,
  cgst_total       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_total       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_total       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  round_off        DECIMAL(6,2)  NOT NULL DEFAULT 0.00,
  grand_total      DECIMAL(14,2) NOT NULL,
  due_date         DATE NULL,
  status           ENUM('entered','matching','matched','disputed','approved_for_payment','partly_paid','paid','cancelled') NOT NULL DEFAULT 'entered',
  document_id      BIGINT UNSIGNED NULL,
  entered_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_si_vendor_no (vendor_id, invoice_no),
  KEY ix_b2b_si_status (status, due_date),
  KEY ix_b2b_si_po (po_id),
  KEY ix_b2b_si_doc (document_id),
  KEY ix_b2b_si_entered_by (entered_by),
  CONSTRAINT fk_b2b_si_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_si_po FOREIGN KEY (po_id) REFERENCES b2b_purchase_orders (id),
  CONSTRAINT fk_b2b_si_doc FOREIGN KEY (document_id) REFERENCES b2b_vendor_documents (id),
  CONSTRAINT fk_b2b_si_entered_by FOREIGN KEY (entered_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mirrors the invoice lines (Sl, description, HSN, batch, mfg, expiry, MRP, qty,
-- rate, discount %, taxable, CGST, SGST, total).
CREATE TABLE IF NOT EXISTS b2b_supplier_invoice_items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_invoice_id BIGINT UNSIGNED NOT NULL,
  line_no          SMALLINT UNSIGNED NOT NULL,
  po_item_id       BIGINT UNSIGNED NULL,
  product_id       BIGINT UNSIGNED NULL,       -- NULL until matched via SAP code / alias
  description      VARCHAR(255) NOT NULL,
  hsn_code         VARCHAR(10)  NULL,
  batch_no         VARCHAR(60)  NULL,
  mfg_date         DATE NULL,
  expiry_date      DATE NULL,
  mrp              DECIMAL(12,2) NULL,
  qty              DECIMAL(12,3) NOT NULL,
  uom              VARCHAR(10)  NULL,
  rate             DECIMAL(12,4) NOT NULL,
  discount_pct     DECIMAL(7,4)  NOT NULL DEFAULT 0.0000,
  discount_amount  DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  taxable_amount   DECIMAL(14,2) NOT NULL,
  gst_rate         DECIMAL(5,2)  NOT NULL,
  cgst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  line_total       DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_sii_line (supplier_invoice_id, line_no),
  KEY ix_b2b_sii_poi (po_item_id),
  KEY ix_b2b_sii_product (product_id),
  CONSTRAINT fk_b2b_sii_si FOREIGN KEY (supplier_invoice_id) REFERENCES b2b_supplier_invoices (id),
  CONSTRAINT fk_b2b_sii_poi FOREIGN KEY (po_item_id) REFERENCES b2b_purchase_order_items (id),
  CONSTRAINT fk_b2b_sii_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per invoice line checked against PO price and GRN accepted qty.
CREATE TABLE IF NOT EXISTS b2b_match_results (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_invoice_id BIGINT UNSIGNED NOT NULL,
  supplier_invoice_item_id BIGINT UNSIGNED NOT NULL,
  po_item_id          BIGINT UNSIGNED NULL,
  qty_invoiced        DECIMAL(12,3) NOT NULL,
  qty_accepted_grn    INT UNSIGNED NOT NULL DEFAULT 0,
  price_po            DECIMAL(12,4) NULL,
  price_invoiced      DECIMAL(12,4) NOT NULL,
  result              ENUM('matched','qty_mismatch','price_mismatch','tax_mismatch','no_po','no_grn') NOT NULL,
  variance_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  resolution          ENUM('open','accepted_variance','debit_note','vendor_credit','corrected') NOT NULL DEFAULT 'open',
  resolved_by         BIGINT UNSIGNED NULL,
  resolved_at         DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_mr_line (supplier_invoice_item_id),
  KEY ix_b2b_mr_si (supplier_invoice_id, result, resolution),
  KEY ix_b2b_mr_poi (po_item_id),
  KEY ix_b2b_mr_resolved_by (resolved_by),
  CONSTRAINT fk_b2b_mr_si FOREIGN KEY (supplier_invoice_id) REFERENCES b2b_supplier_invoices (id),
  CONSTRAINT fk_b2b_mr_sii FOREIGN KEY (supplier_invoice_item_id) REFERENCES b2b_supplier_invoice_items (id),
  CONSTRAINT fk_b2b_mr_poi FOREIGN KEY (po_item_id) REFERENCES b2b_purchase_order_items (id),
  CONSTRAINT fk_b2b_mr_resolved_by FOREIGN KEY (resolved_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_supplier_payments (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_no       VARCHAR(24)  NOT NULL,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  bank_account_id  BIGINT UNSIGNED NOT NULL,
  method           ENUM('neft','rtgs','imps','upi','cheque','adjustment') NOT NULL,
  amount           DECIMAL(14,2) NOT NULL,
  tds_amount       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  reference        VARCHAR(60)  NULL,
  status           ENUM('pending_approval','approved','paid','failed','reversed') NOT NULL DEFAULT 'pending_approval',
  approval_id      BIGINT UNSIGNED NULL,
  paid_at          DATETIME NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_sp_no (payment_no),
  KEY ix_b2b_sp_vendor (vendor_id, status),
  KEY ix_b2b_sp_bank (bank_account_id),
  KEY ix_b2b_sp_approval (approval_id),
  KEY ix_b2b_sp_created_by (created_by),
  CONSTRAINT fk_b2b_sp_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_sp_bank FOREIGN KEY (bank_account_id) REFERENCES b2b_vendor_bank_accounts (id),
  CONSTRAINT fk_b2b_sp_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_sp_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_supplier_payment_allocations (
  supplier_payment_id BIGINT UNSIGNED NOT NULL,
  supplier_invoice_id BIGINT UNSIGNED NOT NULL,
  amount              DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (supplier_payment_id, supplier_invoice_id),
  KEY ix_b2b_spa_si (supplier_invoice_id),
  CONSTRAINT fk_b2b_spa_sp FOREIGN KEY (supplier_payment_id) REFERENCES b2b_supplier_payments (id),
  CONSTRAINT fk_b2b_spa_si FOREIGN KEY (supplier_invoice_id) REFERENCES b2b_supplier_invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Goods sent back to a vendor: GRN rejections, expired/damaged stock, recalls.
CREATE TABLE IF NOT EXISTS b2b_purchase_returns (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_no        VARCHAR(24)  NOT NULL,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  source           ENUM('grn_reject','expiry','damage','recall','other') NOT NULL,
  warehouse_id     INT UNSIGNED NOT NULL,
  status           ENUM('draft','approved','dispatched','acknowledged','settled','cancelled') NOT NULL DEFAULT 'draft',
  debit_note_no    VARCHAR(24)  NULL,
  taxable_total    DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  tax_total        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  grand_total      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  approval_id      BIGINT UNSIGNED NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_pret_no (return_no),
  UNIQUE KEY uq_b2b_pret_dn (debit_note_no),
  KEY ix_b2b_pret_vendor (vendor_id, status),
  KEY ix_b2b_pret_wh (warehouse_id),
  KEY ix_b2b_pret_approval (approval_id),
  KEY ix_b2b_pret_created_by (created_by),
  CONSTRAINT fk_b2b_pret_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_pret_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_pret_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_pret_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_purchase_return_items (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purchase_return_id BIGINT UNSIGNED NOT NULL,
  lot_id             BIGINT UNSIGNED NOT NULL,
  qty                INT UNSIGNED NOT NULL,
  unit_price         DECIMAL(12,4) NOT NULL,
  gst_rate           DECIMAL(5,2)  NOT NULL,
  reason             VARCHAR(200) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_preti_ret (purchase_return_id),
  KEY ix_b2b_preti_lot (lot_id),
  CONSTRAINT fk_b2b_preti_ret FOREIGN KEY (purchase_return_id) REFERENCES b2b_purchase_returns (id),
  CONSTRAINT fk_b2b_preti_lot FOREIGN KEY (lot_id) REFERENCES b2b_lots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
