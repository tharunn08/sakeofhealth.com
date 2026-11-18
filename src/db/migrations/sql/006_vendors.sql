-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 4 (Manufacturers & suppliers / SRM). Not applied anywhere.
--  One legal identity per vendor, several capabilities, separate approval of
--  registration, products and prices. Vendor users only ever see rows whose
--  vendor_id is their own.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS b2b_vendors (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_code       VARCHAR(20)  NULL,           -- assigned on approval, e.g. V-00042
  legal_name        VARCHAR(200) NOT NULL,
  trade_name        VARCHAR(200) NULL,
  gstin             CHAR(15)     NULL,
  pan               CHAR(10)     NULL,
  cin               VARCHAR(21)  NULL,
  fssai_licence     VARCHAR(20)  NULL,
  fssai_valid_to    DATE NULL,
  msme_udyam        VARCHAR(25)  NULL,
  registration_no   VARCHAR(60)  NULL,
  website           VARCHAR(200) NULL,
  status            ENUM('draft','submitted','under_verification','more_info_required','approved','rejected','suspended','renewal_required') NOT NULL DEFAULT 'draft',
  onboarding        ENUM('self','invited') NOT NULL DEFAULT 'self',
  payment_terms_days SMALLINT UNSIGNED NULL,
  credit_terms_note VARCHAR(255) NULL,
  default_lead_days SMALLINT UNSIGNED NULL,
  categories_note   VARCHAR(500) NULL,
  brands_note       VARCHAR(500) NULL,
  capabilities_note VARCHAR(1000) NULL,
  state_id          SMALLINT UNSIGNED NULL,      -- registered-office state: decides IGST vs CGST+SGST
  -- the same business already trading with us as a distributor/retailer: one legal identity, two roles
  linked_account_id BIGINT UNSIGNED NULL,
  risk_score        TINYINT UNSIGNED NULL,
  approved_at       DATETIME NULL,
  approved_by       BIGINT UNSIGNED NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_vendors_code (vendor_code),
  UNIQUE KEY uq_b2b_vendors_gstin (gstin),
  KEY ix_b2b_vendors_status (status, created_at),
  KEY ix_b2b_vendors_pan (pan),
  KEY ix_b2b_vendors_name (legal_name),
  KEY ix_b2b_vendors_state (state_id),
  KEY ix_b2b_vendors_approved_by (approved_by),
  UNIQUE KEY uq_b2b_vendors_account (linked_account_id),
  CONSTRAINT fk_b2b_vendors_state FOREIGN KEY (state_id) REFERENCES b2b_states (id),
  CONSTRAINT fk_b2b_vendors_approved_by FOREIGN KEY (approved_by) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_vendors_account FOREIGN KEY (linked_account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_vendor_capabilities (
  vendor_id    BIGINT UNSIGNED NOT NULL,
  capability   ENUM('manufacturer','authorised_distributor','supplier_wholesaler') NOT NULL,
  status       ENUM('requested','approved','rejected','suspended') NOT NULL DEFAULT 'requested',
  decided_by   BIGINT UNSIGNED NULL,
  decided_at   DATETIME NULL,
  PRIMARY KEY (vendor_id, capability),
  KEY ix_b2b_vc_decided_by (decided_by),
  CONSTRAINT fk_b2b_vc_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_vc_decided_by FOREIGN KEY (decided_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_vendor_addresses (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id     BIGINT UNSIGNED NOT NULL,
  address_type  ENUM('registered','factory','warehouse','billing') NOT NULL,
  line1         VARCHAR(200) NOT NULL,
  line2         VARCHAR(200) NULL,
  city          VARCHAR(80)  NOT NULL,
  state_id      SMALLINT UNSIGNED NOT NULL,
  pincode       CHAR(6)      NOT NULL,
  latitude      DECIMAL(10,7) NULL,
  longitude     DECIMAL(10,7) NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_va_vendor (vendor_id, address_type),
  KEY ix_b2b_va_state (state_id),
  CONSTRAINT fk_b2b_va_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_va_state FOREIGN KEY (state_id) REFERENCES b2b_states (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_vendor_users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id      BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(120) NOT NULL,
  email          VARCHAR(190) NOT NULL,
  mobile         CHAR(10)     NOT NULL,
  password_hash  VARCHAR(255) NULL,            -- NULL until the invite is accepted
  role           ENUM('owner','sales','dispatch','accounts') NOT NULL DEFAULT 'owner',
  status         ENUM('invited','active','disabled') NOT NULL DEFAULT 'invited',
  invite_token_hash CHAR(64) NULL,
  invite_expires_at DATETIME NULL,
  token_version  INT UNSIGNED NOT NULL DEFAULT 1,
  failed_logins  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until   DATETIME NULL,
  last_login_at  DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_vu_email (email),
  KEY ix_b2b_vu_vendor (vendor_id, status),
  CONSTRAINT fk_b2b_vu_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Files live in B2B_PRIVATE_DIR/vendors/<vendor_id>/; the row holds only metadata.
CREATE TABLE IF NOT EXISTS b2b_vendor_documents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id      BIGINT UNSIGNED NOT NULL,
  doc_type       ENUM('gst_certificate','pan','business_registration','bank_proof','cancelled_cheque','fssai_licence',
                      'other_licence','quality_certificate','product_catalogue','manufacturer_authorisation','contract','other') NOT NULL,
  original_name  VARCHAR(200) NOT NULL,
  stored_name    VARCHAR(80)  NOT NULL,
  mime_type      VARCHAR(80)  NOT NULL,
  size_bytes     INT UNSIGNED NOT NULL,
  sha256         CHAR(64)     NOT NULL,
  valid_to       DATE NULL,                    -- drives renewal_required
  review_status  ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  review_note    VARCHAR(300) NULL,
  reviewed_by    BIGINT UNSIGNED NULL,
  uploaded_by_vendor_user BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_vd_stored (stored_name),
  KEY ix_b2b_vd_vendor (vendor_id, doc_type),
  KEY ix_b2b_vd_expiry (valid_to),
  KEY ix_b2b_vd_reviewed_by (reviewed_by),
  KEY ix_b2b_vd_uploader (uploaded_by_vendor_user),
  CONSTRAINT fk_b2b_vd_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_vd_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES b2b_staff (id),
  CONSTRAINT fk_b2b_vd_uploader FOREIGN KEY (uploaded_by_vendor_user) REFERENCES b2b_vendor_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each stage of Registration → Verification → Document review → Procurement →
-- Finance/Compliance → Admin approval, with who and when.
CREATE TABLE IF NOT EXISTS b2b_vendor_verifications (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id    BIGINT UNSIGNED NOT NULL,
  stage        ENUM('verification','document_review','procurement','finance_compliance','admin') NOT NULL,
  outcome      ENUM('passed','failed','more_info_required') NOT NULL,
  note         VARCHAR(500) NULL,
  staff_id     BIGINT UNSIGNED NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_vv_vendor (vendor_id, created_at),
  KEY ix_b2b_vv_staff (staff_id),
  CONSTRAINT fk_b2b_vv_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_vv_staff FOREIGN KEY (staff_id) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_vendor_bank_accounts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  account_name     VARCHAR(160) NOT NULL,
  account_no_enc   VARCHAR(255) NOT NULL,        -- encrypted at rest; last 4 kept for display
  account_last4    CHAR(4)      NOT NULL,
  ifsc             CHAR(11)     NOT NULL,
  status           ENUM('pending','verified','rejected','inactive') NOT NULL DEFAULT 'pending',
  verified_by      BIGINT UNSIGNED NULL,          -- a change needs finance approval before any payment
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_vba_vendor (vendor_id, status),
  KEY ix_b2b_vba_verified_by (verified_by),
  CONSTRAINT fk_b2b_vba_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_vba_verified_by FOREIGN KEY (verified_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A product a vendor can supply. Submission is approved separately; on approval
-- it is linked to (or creates) a b2b_products row.
CREATE TABLE IF NOT EXISTS b2b_vendor_products (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  product_id       BIGINT UNSIGNED NULL,
  vendor_sku       VARCHAR(64)  NULL,
  sap_code         VARCHAR(30)  NULL,
  name             VARCHAR(200) NOT NULL,
  brand            VARCHAR(100) NULL,
  hsn_code         VARCHAR(10)  NULL,
  gst_rate_claimed DECIMAL(5,2) NULL,
  mrp              DECIMAL(12,2) NULL,
  pack_size        VARCHAR(60)  NULL,
  shelf_life_days  SMALLINT UNSIGNED NULL,
  mfg_location     VARCHAR(200) NULL,
  moq              INT UNSIGNED NULL,
  lead_days        SMALLINT UNSIGNED NULL,
  specs_json       TEXT NULL,
  status           ENUM('submitted','under_review','approved','rejected','delisted') NOT NULL DEFAULT 'submitted',
  review_note      VARCHAR(500) NULL,
  reviewed_by      BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_vp_vendor_sku (vendor_id, vendor_sku),
  KEY ix_b2b_vp_product (product_id),
  KEY ix_b2b_vp_status (status, created_at),
  KEY ix_b2b_vp_reviewed_by (reviewed_by),
  CONSTRAINT fk_b2b_vp_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_vp_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_vp_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Vendor supply prices. Feeds purchase cost and RFQ comparison only — never sales prices.
CREATE TABLE IF NOT EXISTS b2b_vendor_price_lists (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id        BIGINT UNSIGNED NOT NULL,
  vendor_product_id BIGINT UNSIGNED NOT NULL,
  unit_price       DECIMAL(12,4) NOT NULL,      -- ex-GST
  gst_rate         DECIMAL(5,2)  NOT NULL,
  discount_pct     DECIMAL(7,4)  NOT NULL DEFAULT 0.0000,
  freight_per_unit DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  moq              INT UNSIGNED NULL,
  lead_days        SMALLINT UNSIGNED NULL,
  payment_terms_days SMALLINT UNSIGNED NULL,
  valid_from       DATE NOT NULL,
  valid_to         DATE NULL,
  status           ENUM('submitted','accepted','rejected','expired') NOT NULL DEFAULT 'submitted',
  reviewed_by      BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_vpl_vendor (vendor_id, status, valid_from),
  KEY ix_b2b_vpl_vp (vendor_product_id, valid_from),
  KEY ix_b2b_vpl_reviewed_by (reviewed_by),
  CONSTRAINT fk_b2b_vpl_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_vpl_vp FOREIGN KEY (vendor_product_id) REFERENCES b2b_vendor_products (id),
  CONSTRAINT fk_b2b_vpl_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_vendor_contracts (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id      BIGINT UNSIGNED NOT NULL,
  title          VARCHAR(200) NOT NULL,
  document_id    BIGINT UNSIGNED NULL,
  starts_on      DATE NOT NULL,
  ends_on        DATE NULL,
  payment_terms_days SMALLINT UNSIGNED NULL,
  notes          VARCHAR(1000) NULL,
  status         ENUM('draft','active','expired','terminated') NOT NULL DEFAULT 'draft',
  created_by     BIGINT UNSIGNED NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_vct_vendor (vendor_id, status),
  KEY ix_b2b_vct_doc (document_id),
  KEY ix_b2b_vct_created_by (created_by),
  CONSTRAINT fk_b2b_vct_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id),
  CONSTRAINT fk_b2b_vct_doc FOREIGN KEY (document_id) REFERENCES b2b_vendor_documents (id),
  CONSTRAINT fk_b2b_vct_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Communication centre: one thread per topic (RFQ, PO, invoice, general).
CREATE TABLE IF NOT EXISTS b2b_vendor_messages (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vendor_id      BIGINT UNSIGNED NOT NULL,
  thread_ref_type VARCHAR(30) NOT NULL,
  thread_ref_id  BIGINT UNSIGNED NULL,
  sender_type    ENUM('vendor','staff','system') NOT NULL,
  sender_id      BIGINT UNSIGNED NULL,
  body           TEXT NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at        DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_vm_thread (vendor_id, thread_ref_type, thread_ref_id, created_at),
  CONSTRAINT fk_b2b_vm_vendor FOREIGN KEY (vendor_id) REFERENCES b2b_vendors (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
