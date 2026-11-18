-- ═══════════════════════════════════════════════════════════════════════
--  Sake of Health — B2B platform schema (MySQL 8 / MariaDB 10.6+, InnoDB)
--
--  Every table is prefixed b2b_ so this schema can share a Hostinger
--  database with anything else without collisions. All statements are
--  idempotent. Money is DECIMAL, never FLOAT. Timestamps are UTC.
-- ═══════════════════════════════════════════════════════════════════════

-- ─────────────── Geography: Country → State → District → City → Pincode ───────────────

CREATE TABLE IF NOT EXISTS b2b_states (
  id            SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  country_code  CHAR(2)      NOT NULL DEFAULT 'IN',
  name          VARCHAR(80)  NOT NULL,
  gst_code      CHAR(2)      NOT NULL,
  is_serviceable TINYINT(1)  NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_states_gst (country_code, gst_code),
  UNIQUE KEY uq_b2b_states_name (country_code, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_districts (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  state_id  SMALLINT UNSIGNED NOT NULL,
  name      VARCHAR(80) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_districts (state_id, name),
  CONSTRAINT fk_b2b_districts_state FOREIGN KEY (state_id) REFERENCES b2b_states (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_settings (
  setting_key   VARCHAR(80) NOT NULL,
  setting_value TEXT        NOT NULL,
  updated_by    VARCHAR(190) NULL,
  updated_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Business accounts (retailers, distributors, future tiers) ───────────────

CREATE TABLE IF NOT EXISTS b2b_accounts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_type     ENUM('retailer','distributor') NOT NULL,
  -- tier + parent_account_id leave room for Super Distributor → Distributor → Sub Distributor → Retailer
  tier             VARCHAR(30)  NOT NULL DEFAULT 'standard',
  parent_account_id BIGINT UNSIGNED NULL,
  status           ENUM('pending','under_review','approved','rejected','suspended','blocked') NOT NULL DEFAULT 'pending',
  business_name    VARCHAR(160) NOT NULL,
  shop_name        VARCHAR(160) NULL,
  contact_person   VARCHAR(120) NOT NULL,
  mobile           CHAR(10)     NOT NULL,
  email            VARCHAR(190) NOT NULL,
  gstin            CHAR(15)     NULL,
  pan              CHAR(10)     NULL,
  business_type    VARCHAR(60)  NULL,
  address_line1    VARCHAR(200) NOT NULL,
  address_line2    VARCHAR(200) NULL,
  landmark         VARCHAR(160) NULL,
  state_id         SMALLINT UNSIGNED NOT NULL,
  district_id      INT UNSIGNED NULL,
  district_name    VARCHAR(80)  NOT NULL,
  city             VARCHAR(80)  NOT NULL,
  pincode          CHAR(6)      NOT NULL,
  latitude         DECIMAL(10,7) NULL,
  longitude        DECIMAL(10,7) NULL,
  first_order_done TINYINT(1)   NOT NULL DEFAULT 0,
  risk_flags       VARCHAR(600) NULL,
  max_retailers        INT UNSIGNED NULL,
  daily_order_capacity INT UNSIGNED NULL,
  invoice_prefix   VARCHAR(12)  NULL,
  admin_notes      TEXT NULL,
  approved_at      DATETIME NULL,
  approved_by      VARCHAR(190) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_accounts_mobile (mobile),
  UNIQUE KEY uq_b2b_accounts_email (email),
  UNIQUE KEY uq_b2b_accounts_gstin (gstin),
  KEY ix_b2b_accounts_type_status (account_type, status, created_at),
  KEY ix_b2b_accounts_pincode (pincode),
  KEY ix_b2b_accounts_geo (state_id, district_id, city),
  KEY ix_b2b_accounts_name (business_name),
  KEY ix_b2b_accounts_shop (shop_name),
  KEY ix_b2b_accounts_parent (parent_account_id),
  CONSTRAINT fk_b2b_accounts_state FOREIGN KEY (state_id) REFERENCES b2b_states (id),
  CONSTRAINT fk_b2b_accounts_district FOREIGN KEY (district_id) REFERENCES b2b_districts (id),
  CONSTRAINT fk_b2b_accounts_parent FOREIGN KEY (parent_account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id     BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(120) NOT NULL,
  email          VARCHAR(190) NOT NULL,
  mobile         CHAR(10)     NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('retailer','distributor') NOT NULL,
  is_primary     TINYINT(1) NOT NULL DEFAULT 1,
  status         ENUM('active','disabled') NOT NULL DEFAULT 'active',
  token_version  INT UNSIGNED NOT NULL DEFAULT 1,
  failed_logins  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until   DATETIME NULL,
  last_login_at  DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_users_email (email),
  UNIQUE KEY uq_b2b_users_mobile (mobile),
  KEY ix_b2b_users_account (account_id),
  CONSTRAINT fk_b2b_users_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_documents (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id     BIGINT UNSIGNED NOT NULL,
  doc_type       ENUM('gst_certificate','business_proof','address_proof','shop_proof','pan_card','other') NOT NULL,
  original_name  VARCHAR(200) NOT NULL,
  stored_name    VARCHAR(80)  NOT NULL,
  mime_type      VARCHAR(80)  NOT NULL,
  size_bytes     INT UNSIGNED NOT NULL,
  sha256         CHAR(64)     NOT NULL,
  uploaded_by    VARCHAR(190) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_documents_stored (stored_name),
  KEY ix_b2b_documents_account (account_id),
  CONSTRAINT fk_b2b_documents_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_account_status_history (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id   BIGINT UNSIGNED NOT NULL,
  from_status  VARCHAR(20) NULL,
  to_status    VARCHAR(20) NOT NULL,
  reason       VARCHAR(500) NULL,
  actor_type   VARCHAR(12) NOT NULL,
  actor_label  VARCHAR(190) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_ash_account (account_id, created_at),
  CONSTRAINT fk_b2b_ash_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Distribution network ───────────────

CREATE TABLE IF NOT EXISTS b2b_service_areas (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  distributor_id  BIGINT UNSIGNED NOT NULL,
  area_type       ENUM('state','district','city','pincode','pincode_range') NOT NULL,
  state_id        SMALLINT UNSIGNED NOT NULL,
  district_id     INT UNSIGNED NULL,
  city            VARCHAR(80) NULL,
  pincode_from    CHAR(6) NULL,
  pincode_to      CHAR(6) NULL,
  priority        SMALLINT NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_sa_distributor (distributor_id, is_active),
  KEY ix_b2b_sa_pincode (area_type, pincode_from, pincode_to),
  KEY ix_b2b_sa_geo (state_id, district_id, city),
  CONSTRAINT fk_b2b_sa_distributor FOREIGN KEY (distributor_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_sa_state FOREIGN KEY (state_id) REFERENCES b2b_states (id),
  CONSTRAINT fk_b2b_sa_district FOREIGN KEY (district_id) REFERENCES b2b_districts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per mapping period. The retailer's CURRENT mapping has current_retailer_id = retailer_id
-- (unique), ended mappings have NULL — so history is kept and "one current distributor" is enforced by the database.
CREATE TABLE IF NOT EXISTS b2b_retailer_distributor_map (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  retailer_id     BIGINT UNSIGNED NOT NULL,
  distributor_id  BIGINT UNSIGNED NOT NULL,
  status          ENUM('active','suspended','ended') NOT NULL DEFAULT 'active',
  current_retailer_id BIGINT UNSIGNED NULL,
  method          ENUM('auto','manual','bulk') NOT NULL DEFAULT 'auto',
  reason          VARCHAR(500) NULL,
  score_json      TEXT NULL,
  assigned_by     VARCHAR(190) NULL,
  ended_by        VARCHAR(190) NULL,
  started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_rdm_current (current_retailer_id),
  KEY ix_b2b_rdm_distributor (distributor_id, status),
  KEY ix_b2b_rdm_retailer (retailer_id, started_at),
  CONSTRAINT fk_b2b_rdm_retailer FOREIGN KEY (retailer_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_rdm_distributor FOREIGN KEY (distributor_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Catalogue (central product master) ───────────────

CREATE TABLE IF NOT EXISTS b2b_categories (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id   INT UNSIGNED NULL,
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(120) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_categories_slug (slug),
  KEY ix_b2b_categories_parent (parent_id, sort_order),
  CONSTRAINT fk_b2b_categories_parent FOREIGN KEY (parent_id) REFERENCES b2b_categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_products (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku             VARCHAR(64)  NOT NULL,
  name            VARCHAR(200) NOT NULL,
  category_id     INT UNSIGNED NULL,
  subcategory_id  INT UNSIGNED NULL,
  brand           VARCHAR(100) NULL,
  description     TEXT NULL,
  image_url       VARCHAR(500) NULL,
  barcode         VARCHAR(64)  NULL,
  hsn_code        VARCHAR(10)  NULL,
  gst_rate        DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  mrp             DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  base_price      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  -- product-level pricing: an explicit price wins over a product margin
  distributor_price  DECIMAL(12,2) NULL,
  retailer_price     DECIMAL(12,2) NULL,
  distributor_margin DECIMAL(7,3)  NULL,
  retailer_margin    DECIMAL(7,3)  NULL,
  moq             INT UNSIGNED NOT NULL DEFAULT 1,
  case_qty        INT UNSIGNED NOT NULL DEFAULT 1,
  enforce_case_multiple TINYINT(1) NOT NULL DEFAULT 1,
  pack_size       VARCHAR(60) NULL,
  low_stock_threshold INT UNSIGNED NOT NULL DEFAULT 0,
  -- one product row, three sales channels; B2C pricing is never read from here
  avail_b2c         TINYINT(1) NOT NULL DEFAULT 0,
  avail_retailer    TINYINT(1) NOT NULL DEFAULT 1,
  avail_distributor TINYINT(1) NOT NULL DEFAULT 1,
  b2c_ref         VARCHAR(64) NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  effective_from  DATE NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_products_sku (sku),
  KEY ix_b2b_products_active_cat (is_active, category_id, name),
  KEY ix_b2b_products_name (name),
  KEY ix_b2b_products_barcode (barcode),
  KEY ix_b2b_products_subcat (subcategory_id),
  CONSTRAINT fk_b2b_products_cat FOREIGN KEY (category_id) REFERENCES b2b_categories (id),
  CONSTRAINT fk_b2b_products_subcat FOREIGN KEY (subcategory_id) REFERENCES b2b_categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pricing rules. scope decides precedence (see docs/B2B-PRICING.md):
--   account_product > account > [product columns] > product > category > [default margin setting]
CREATE TABLE IF NOT EXISTS b2b_pricing_rules (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope        ENUM('account_product','account','product','category','default') NOT NULL,
  audience     ENUM('distributor','retailer') NOT NULL,
  account_id   BIGINT UNSIGNED NULL,
  product_id   BIGINT UNSIGNED NULL,
  category_id  INT UNSIGNED NULL,
  rule_type    ENUM('margin_pct','fixed_price','discount_pct') NOT NULL,
  value        DECIMAL(12,3) NOT NULL,
  min_qty      INT UNSIGNED NOT NULL DEFAULT 1,
  is_promo     TINYINT(1) NOT NULL DEFAULT 0,
  label        VARCHAR(120) NULL,
  starts_at    DATETIME NULL,
  ends_at      DATETIME NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_by   VARCHAR(190) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_pr_product (product_id, audience, is_active),
  KEY ix_b2b_pr_account (account_id, is_active),
  KEY ix_b2b_pr_category (category_id, audience, is_active),
  KEY ix_b2b_pr_scope (scope, audience, is_active),
  CONSTRAINT fk_b2b_pr_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_pr_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_pr_category FOREIGN KEY (category_id) REFERENCES b2b_categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Inventory (warehouse-aware, ledger-based) ───────────────

CREATE TABLE IF NOT EXISTS b2b_warehouses (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code             VARCHAR(30)  NOT NULL,
  name             VARCHAR(120) NOT NULL,
  -- NULL = company warehouse; otherwise the distributor who owns this stock point
  owner_account_id BIGINT UNSIGNED NULL,
  address          VARCHAR(300) NULL,
  state_id         SMALLINT UNSIGNED NULL,
  district_id      INT UNSIGNED NULL,
  city             VARCHAR(80) NULL,
  pincode          CHAR(6) NULL,
  priority         SMALLINT NOT NULL DEFAULT 0,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_warehouses_code (code),
  KEY ix_b2b_warehouses_owner (owner_account_id, is_active),
  CONSTRAINT fk_b2b_warehouses_owner FOREIGN KEY (owner_account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_warehouses_state FOREIGN KEY (state_id) REFERENCES b2b_states (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Current balances per warehouse + product, split by status. UNSIGNED means the
-- database itself refuses any update that would take a bucket below zero.
CREATE TABLE IF NOT EXISTS b2b_stock (
  warehouse_id    INT UNSIGNED NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  qty_available   INT UNSIGNED NOT NULL DEFAULT 0,
  qty_reserved    INT UNSIGNED NOT NULL DEFAULT 0,
  qty_allocated   INT UNSIGNED NOT NULL DEFAULT 0,
  qty_in_transit  INT UNSIGNED NOT NULL DEFAULT 0,
  qty_damaged     INT UNSIGNED NOT NULL DEFAULT 0,
  qty_expired     INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (warehouse_id, product_id),
  KEY ix_b2b_stock_product (product_id),
  CONSTRAINT fk_b2b_stock_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_stock_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_batches (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  warehouse_id  INT UNSIGNED NOT NULL,
  product_id    BIGINT UNSIGNED NOT NULL,
  batch_no      VARCHAR(60) NOT NULL,
  mfg_date      DATE NULL,
  expiry_date   DATE NULL,
  qty_on_hand   INT UNSIGNED NOT NULL DEFAULT 0,
  status        ENUM('active','expired','depleted') NOT NULL DEFAULT 'active',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_batches (warehouse_id, product_id, batch_no),
  KEY ix_b2b_batches_fefo (product_id, warehouse_id, status, expiry_date),
  KEY ix_b2b_batches_expiry (status, expiry_date),
  CONSTRAINT fk_b2b_batches_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_batches_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only ledger: every change to b2b_stock writes one row here.
CREATE TABLE IF NOT EXISTS b2b_stock_movements (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  warehouse_id   INT UNSIGNED NOT NULL,
  product_id     BIGINT UNSIGNED NOT NULL,
  batch_id       BIGINT UNSIGNED NULL,
  movement_type  ENUM('opening','purchase','production','reservation','release','allocation','deallocation',
                      'dispatch','delivery','damage','expiry','adjustment','return','transfer_in','transfer_out') NOT NULL,
  qty            INT UNSIGNED NOT NULL,
  from_status    VARCHAR(12) NULL,
  to_status      VARCHAR(12) NULL,
  ref_type       VARCHAR(30) NULL,
  ref_id         BIGINT UNSIGNED NULL,
  reason         VARCHAR(255) NULL,
  actor_type     VARCHAR(12) NOT NULL,
  actor_label    VARCHAR(190) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_sm_product (product_id, created_at),
  KEY ix_b2b_sm_wh (warehouse_id, created_at),
  KEY ix_b2b_sm_ref (ref_type, ref_id),
  CONSTRAINT fk_b2b_sm_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_sm_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Cart & favourites ───────────────

CREATE TABLE IF NOT EXISTS b2b_cart_items (
  account_id  BIGINT UNSIGNED NOT NULL,
  product_id  BIGINT UNSIGNED NOT NULL,
  qty         INT UNSIGNED NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, product_id),
  CONSTRAINT fk_b2b_cart_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_cart_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_favorites (
  account_id  BIGINT UNSIGNED NOT NULL,
  product_id  BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, product_id),
  CONSTRAINT fk_b2b_fav_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_fav_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Orders ───────────────

CREATE TABLE IF NOT EXISTS b2b_orders (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no           VARCHAR(24) NULL,
  buyer_account_id   BIGINT UNSIGNED NOT NULL,
  buyer_type         ENUM('retailer','distributor') NOT NULL,
  seller_type        ENUM('company','distributor') NOT NULL DEFAULT 'company',
  seller_account_id  BIGINT UNSIGNED NULL,
  warehouse_id       INT UNSIGNED NULL,
  stock_reserved     TINYINT(1) NOT NULL DEFAULT 0,
  status             ENUM('draft','submitted','pending_admin_approval','approved','assigned','accepted','processing',
                          'packed','dispatched','out_for_delivery','delivered','partially_delivered',
                          'cancelled','rejected','returned','refunded') NOT NULL DEFAULT 'submitted',
  is_on_hold         TINYINT(1) NOT NULL DEFAULT 0,
  hold_reason        VARCHAR(300) NULL,
  is_first_order     TINYINT(1) NOT NULL DEFAULT 0,
  payment_method     ENUM('prepaid','upi','bank_transfer','gateway','credit') NOT NULL DEFAULT 'bank_transfer',
  payment_status     ENUM('pending','partial','paid','refunded') NOT NULL DEFAULT 'pending',
  amount_paid        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  credit_override    TINYINT(1) NOT NULL DEFAULT 0,
  item_count         INT UNSIGNED NOT NULL DEFAULT 0,
  total_qty          INT UNSIGNED NOT NULL DEFAULT 0,
  subtotal           DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  discount_total     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  taxable_total      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  cgst_total         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_total         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_total         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  tax_total          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  round_off          DECIMAL(6,2)  NOT NULL DEFAULT 0.00,
  grand_total        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  cost_total         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  seller_state_id    SMALLINT UNSIGNED NULL,
  buyer_state_id     SMALLINT UNSIGNED NOT NULL,
  buyer_gstin        CHAR(15) NULL,
  ship_name          VARCHAR(160) NOT NULL,
  ship_contact       VARCHAR(120) NULL,
  ship_phone         CHAR(10) NOT NULL,
  ship_line1         VARCHAR(200) NOT NULL,
  ship_line2         VARCHAR(200) NULL,
  ship_landmark      VARCHAR(160) NULL,
  ship_city          VARCHAR(80) NOT NULL,
  ship_district      VARCHAR(80) NULL,
  ship_state         VARCHAR(80) NOT NULL,
  ship_pincode       CHAR(6) NOT NULL,
  ship_lat           DECIMAL(10,7) NULL,
  ship_lng           DECIMAL(10,7) NULL,
  buyer_notes        VARCHAR(500) NULL,
  internal_notes     VARCHAR(1000) NULL,
  cancel_reason      VARCHAR(300) NULL,
  idempotency_key    VARCHAR(64) NULL,
  placed_by_user_id  BIGINT UNSIGNED NULL,
  submitted_at       DATETIME NULL,
  approved_at        DATETIME NULL,
  assigned_at        DATETIME NULL,
  accepted_at        DATETIME NULL,
  processing_at      DATETIME NULL,
  packed_at          DATETIME NULL,
  dispatched_at      DATETIME NULL,
  out_for_delivery_at DATETIME NULL,
  delivered_at       DATETIME NULL,
  cancelled_at       DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_orders_no (order_no),
  -- duplicate-order protection: one order per (buyer, idempotency key)
  UNIQUE KEY uq_b2b_orders_idem (buyer_account_id, idempotency_key),
  KEY ix_b2b_orders_buyer (buyer_account_id, created_at),
  KEY ix_b2b_orders_seller (seller_account_id, status, created_at),
  KEY ix_b2b_orders_status (status, created_at),
  KEY ix_b2b_orders_created (created_at),
  KEY ix_b2b_orders_pincode (ship_pincode),
  KEY ix_b2b_orders_state (buyer_state_id, created_at),
  KEY ix_b2b_orders_payment (payment_status, status),
  CONSTRAINT fk_b2b_orders_buyer FOREIGN KEY (buyer_account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_orders_seller FOREIGN KEY (seller_account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_orders_wh FOREIGN KEY (warehouse_id) REFERENCES b2b_warehouses (id),
  CONSTRAINT fk_b2b_orders_bstate FOREIGN KEY (buyer_state_id) REFERENCES b2b_states (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_order_items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id         BIGINT UNSIGNED NOT NULL,
  product_id       BIGINT UNSIGNED NOT NULL,
  sku              VARCHAR(64)  NOT NULL,
  name             VARCHAR(200) NOT NULL,
  hsn_code         VARCHAR(10)  NULL,
  pack_size        VARCHAR(60)  NULL,
  gst_rate         DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  mrp              DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  base_price       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  list_price       DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  unit_price       DECIMAL(12,2) NOT NULL,
  price_source     VARCHAR(40) NULL,
  price_rule_id    BIGINT UNSIGNED NULL,
  qty              INT UNSIGNED NOT NULL,
  qty_delivered    INT UNSIGNED NULL,
  qty_returned     INT UNSIGNED NOT NULL DEFAULT 0,
  discount_amount  DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  taxable_amount   DECIMAL(14,2) NOT NULL,
  cgst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  line_total       DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_oi_order (order_id),
  KEY ix_b2b_oi_product (product_id, order_id),
  CONSTRAINT fk_b2b_oi_order FOREIGN KEY (order_id) REFERENCES b2b_orders (id),
  CONSTRAINT fk_b2b_oi_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_order_item_allocations (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id       BIGINT UNSIGNED NOT NULL,
  order_item_id  BIGINT UNSIGNED NOT NULL,
  batch_id       BIGINT UNSIGNED NULL,
  qty            INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_oia_order (order_id),
  CONSTRAINT fk_b2b_oia_item FOREIGN KEY (order_item_id) REFERENCES b2b_order_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_order_status_history (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id     BIGINT UNSIGNED NOT NULL,
  from_status  VARCHAR(30) NULL,
  to_status    VARCHAR(30) NOT NULL,
  note         VARCHAR(500) NULL,
  actor_type   VARCHAR(12) NOT NULL,
  actor_label  VARCHAR(190) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_osh_order (order_id, id),
  CONSTRAINT fk_b2b_osh_order FOREIGN KEY (order_id) REFERENCES b2b_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Invoicing ───────────────

-- Gap-free counters (invoice / credit-note numbers). Rows are locked FOR UPDATE while a number is taken.
CREATE TABLE IF NOT EXISTS b2b_sequences (
  seq_key   VARCHAR(80) NOT NULL,
  next_val  BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (seq_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_invoices (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_no         VARCHAR(32) NOT NULL,
  order_id           BIGINT UNSIGNED NOT NULL,
  status             ENUM('final','cancelled') NOT NULL DEFAULT 'final',
  -- = order_id while the invoice is final, NULL once cancelled: at most one live invoice per order
  live_order_id      BIGINT UNSIGNED NULL,
  invoice_date       DATE NOT NULL,
  financial_year     VARCHAR(7) NOT NULL,
  seller_type        ENUM('company','distributor') NOT NULL,
  seller_account_id  BIGINT UNSIGNED NULL,
  seller_name        VARCHAR(200) NOT NULL,
  seller_gstin       VARCHAR(15) NULL,
  seller_pan         VARCHAR(10) NULL,
  seller_address     VARCHAR(500) NOT NULL,
  seller_state       VARCHAR(80) NOT NULL,
  seller_state_code  CHAR(2) NOT NULL,
  seller_phone       VARCHAR(20) NULL,
  seller_email       VARCHAR(190) NULL,
  buyer_account_id   BIGINT UNSIGNED NOT NULL,
  buyer_name         VARCHAR(200) NOT NULL,
  buyer_gstin        VARCHAR(15) NULL,
  buyer_address      VARCHAR(500) NOT NULL,
  buyer_state        VARCHAR(80) NOT NULL,
  buyer_state_code   CHAR(2) NOT NULL,
  buyer_phone        VARCHAR(20) NULL,
  place_of_supply    VARCHAR(90) NOT NULL,
  is_interstate      TINYINT(1) NOT NULL DEFAULT 0,
  taxable_total      DECIMAL(14,2) NOT NULL,
  cgst_total         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_total         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_total         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  tax_total          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  discount_total     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  round_off          DECIMAL(6,2)  NOT NULL DEFAULT 0.00,
  grand_total        DECIMAL(14,2) NOT NULL,
  due_date           DATE NULL,
  cancelled_at       DATETIME NULL,
  cancel_reason      VARCHAR(300) NULL,
  created_by         VARCHAR(190) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_invoices_no (invoice_no),
  UNIQUE KEY uq_b2b_invoices_live (live_order_id),
  KEY ix_b2b_invoices_order (order_id),
  KEY ix_b2b_invoices_buyer (buyer_account_id, invoice_date),
  KEY ix_b2b_invoices_seller (seller_account_id, invoice_date),
  KEY ix_b2b_invoices_date (invoice_date),
  CONSTRAINT fk_b2b_invoices_order FOREIGN KEY (order_id) REFERENCES b2b_orders (id),
  CONSTRAINT fk_b2b_invoices_buyer FOREIGN KEY (buyer_account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_invoice_items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id       BIGINT UNSIGNED NOT NULL,
  order_item_id    BIGINT UNSIGNED NULL,
  sku              VARCHAR(64)  NOT NULL,
  name             VARCHAR(200) NOT NULL,
  hsn_code         VARCHAR(10)  NULL,
  qty              INT UNSIGNED NOT NULL,
  unit_price       DECIMAL(12,2) NOT NULL,
  discount_amount  DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  taxable_amount   DECIMAL(14,2) NOT NULL,
  gst_rate         DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  cgst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  line_total       DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_ii_invoice (invoice_id),
  CONSTRAINT fk_b2b_ii_invoice FOREIGN KEY (invoice_id) REFERENCES b2b_invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_credit_notes (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credit_note_no    VARCHAR(32) NOT NULL,
  invoice_id        BIGINT UNSIGNED NOT NULL,
  order_id          BIGINT UNSIGNED NOT NULL,
  return_id         BIGINT UNSIGNED NULL,
  seller_type       ENUM('company','distributor') NOT NULL,
  seller_account_id BIGINT UNSIGNED NULL,
  buyer_account_id  BIGINT UNSIGNED NOT NULL,
  note_date         DATE NOT NULL,
  reason            VARCHAR(300) NOT NULL,
  is_full_cancellation TINYINT(1) NOT NULL DEFAULT 0,
  taxable_total     DECIMAL(14,2) NOT NULL,
  cgst_total        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_total        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_total        DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  grand_total       DECIMAL(14,2) NOT NULL,
  -- how much of this note reduced what the buyer still owed, and how much has to be paid back
  applied_amount    DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  refund_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  created_by        VARCHAR(190) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_cn_no (credit_note_no),
  KEY ix_b2b_cn_invoice (invoice_id),
  KEY ix_b2b_cn_buyer (buyer_account_id, note_date),
  KEY ix_b2b_cn_seller (seller_account_id, note_date),
  CONSTRAINT fk_b2b_cn_invoice FOREIGN KEY (invoice_id) REFERENCES b2b_invoices (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_credit_note_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credit_note_id  BIGINT UNSIGNED NOT NULL,
  order_item_id   BIGINT UNSIGNED NULL,
  sku             VARCHAR(64)  NOT NULL,
  name            VARCHAR(200) NOT NULL,
  hsn_code        VARCHAR(10)  NULL,
  qty             INT UNSIGNED NOT NULL,
  unit_price      DECIMAL(12,2) NOT NULL,
  taxable_amount  DECIMAL(14,2) NOT NULL,
  gst_rate        DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  cgst_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_amount     DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  line_total      DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_cni_cn (credit_note_id),
  CONSTRAINT fk_b2b_cni_cn FOREIGN KEY (credit_note_id) REFERENCES b2b_credit_notes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Payments & credit ───────────────

CREATE TABLE IF NOT EXISTS b2b_payments (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id           BIGINT UNSIGNED NULL,
  payer_account_id   BIGINT UNSIGNED NOT NULL,
  payee_type         ENUM('company','distributor') NOT NULL DEFAULT 'company',
  payee_account_id   BIGINT UNSIGNED NULL,
  method             ENUM('upi','bank_transfer','gateway','cash','cheque','credit_note','adjustment') NOT NULL,
  amount             DECIMAL(14,2) NOT NULL,
  reference          VARCHAR(120) NULL,
  gateway            VARCHAR(20) NULL,
  gateway_payment_id VARCHAR(120) NULL,
  gateway_order_id   VARCHAR(120) NULL,
  status             ENUM('pending','received','failed','reversed') NOT NULL DEFAULT 'received',
  note               VARCHAR(300) NULL,
  recorded_by        VARCHAR(190) NULL,
  received_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- a gateway callback delivered twice can only ever create one payment
  UNIQUE KEY uq_b2b_payments_gateway (gateway, gateway_payment_id),
  KEY ix_b2b_payments_order (order_id),
  KEY ix_b2b_payments_gw_order (gateway_order_id),
  KEY ix_b2b_payments_payer (payer_account_id, received_at),
  KEY ix_b2b_payments_payee (payee_account_id, received_at),
  KEY ix_b2b_payments_date (received_at),
  CONSTRAINT fk_b2b_payments_order FOREIGN KEY (order_id) REFERENCES b2b_orders (id),
  CONSTRAINT fk_b2b_payments_payer FOREIGN KEY (payer_account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- creditor_account_id = 0 means the company; otherwise the distributor extending credit to a retailer.
CREATE TABLE IF NOT EXISTS b2b_credit_accounts (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  debtor_account_id    BIGINT UNSIGNED NOT NULL,
  creditor_account_id  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  credit_limit         DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  credit_used          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  credit_days          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- temporary, audited admin override: extra headroom above the limit until a deadline
  override_amount      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  override_until       DATETIME NULL,
  override_by          VARCHAR(190) NULL,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_credit_accounts (debtor_account_id, creditor_account_id),
  KEY ix_b2b_credit_creditor (creditor_account_id),
  CONSTRAINT fk_b2b_credit_debtor FOREIGN KEY (debtor_account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_credit_transactions (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  credit_account_id  BIGINT UNSIGNED NOT NULL,
  txn_type           ENUM('debit','credit','limit_change') NOT NULL,
  amount             DECIMAL(14,2) NOT NULL,
  balance_after      DECIMAL(14,2) NOT NULL,
  order_id           BIGINT UNSIGNED NULL,
  payment_id         BIGINT UNSIGNED NULL,
  due_date           DATE NULL,
  note               VARCHAR(300) NULL,
  actor_label        VARCHAR(190) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_ct_account (credit_account_id, id),
  KEY ix_b2b_ct_order (order_id),
  CONSTRAINT fk_b2b_ct_account FOREIGN KEY (credit_account_id) REFERENCES b2b_credit_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Returns ───────────────

CREATE TABLE IF NOT EXISTS b2b_returns (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_no          VARCHAR(24) NULL,
  order_id           BIGINT UNSIGNED NOT NULL,
  buyer_account_id   BIGINT UNSIGNED NOT NULL,
  seller_type        ENUM('company','distributor') NOT NULL,
  seller_account_id  BIGINT UNSIGNED NULL,
  status             ENUM('requested','approved','rejected','pickup_scheduled','received','completed','cancelled') NOT NULL DEFAULT 'requested',
  resolution         ENUM('refund','replacement','credit_note') NULL,
  reason             VARCHAR(500) NOT NULL,
  inspection_note    VARCHAR(500) NULL,
  credit_note_id     BIGINT UNSIGNED NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_returns_no (return_no),
  KEY ix_b2b_returns_order (order_id),
  KEY ix_b2b_returns_buyer (buyer_account_id, created_at),
  KEY ix_b2b_returns_seller (seller_account_id, status),
  KEY ix_b2b_returns_status (status, created_at),
  CONSTRAINT fk_b2b_returns_order FOREIGN KEY (order_id) REFERENCES b2b_orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_return_items (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_id      BIGINT UNSIGNED NOT NULL,
  order_item_id  BIGINT UNSIGNED NOT NULL,
  qty            INT UNSIGNED NOT NULL,
  qty_accepted   INT UNSIGNED NULL,
  item_condition ENUM('good','damaged','expired') NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_ri_return (return_id),
  CONSTRAINT fk_b2b_ri_return FOREIGN KEY (return_id) REFERENCES b2b_returns (id),
  CONSTRAINT fk_b2b_ri_item FOREIGN KEY (order_item_id) REFERENCES b2b_order_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Notifications ───────────────

CREATE TABLE IF NOT EXISTS b2b_notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id  BIGINT UNSIGNED NOT NULL,
  title       VARCHAR(160) NOT NULL,
  body        VARCHAR(500) NULL,
  link        VARCHAR(200) NULL,
  is_read     TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_notif_account (account_id, is_read, id),
  CONSTRAINT fk_b2b_notif_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outbox: rows are written in the same transaction as the business change and
-- delivered afterwards by a background worker with retries. A failed email can
-- never fail or lose an order.
CREATE TABLE IF NOT EXISTS b2b_notification_queue (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel          ENUM('email','sms','whatsapp') NOT NULL,
  recipient        VARCHAR(190) NOT NULL,
  subject          VARCHAR(200) NULL,
  body             TEXT NOT NULL,
  status           ENUM('pending','sending','sent','failed') NOT NULL DEFAULT 'pending',
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts     TINYINT UNSIGNED NOT NULL DEFAULT 4,
  next_attempt_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error       VARCHAR(300) NULL,
  ref_type         VARCHAR(30) NULL,
  ref_id           BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at          DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_nq_due (status, next_attempt_at),
  KEY ix_b2b_nq_ref (ref_type, ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Excel imports ───────────────

CREATE TABLE IF NOT EXISTS b2b_imports (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  file_name          VARCHAR(200) NOT NULL,
  stored_name        VARCHAR(80)  NOT NULL,
  uploaded_by        VARCHAR(190) NOT NULL,
  status             ENUM('uploaded','validating','ready','processing','completed','failed','rolled_back') NOT NULL DEFAULT 'uploaded',
  total_rows         INT UNSIGNED NOT NULL DEFAULT 0,
  valid_rows         INT UNSIGNED NOT NULL DEFAULT 0,
  invalid_rows       INT UNSIGNED NOT NULL DEFAULT 0,
  created_count      INT UNSIGNED NOT NULL DEFAULT 0,
  updated_count      INT UNSIGNED NOT NULL DEFAULT 0,
  deactivated_count  INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count      INT UNSIGNED NOT NULL DEFAULT 0,
  headers_json       TEXT NULL,
  mapping_json       TEXT NULL,
  options_json       TEXT NULL,
  error_message      VARCHAR(500) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at         DATETIME NULL,
  finished_at        DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_b2b_imports_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_import_rows (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  import_id    BIGINT UNSIGNED NOT NULL,
  row_no       INT UNSIGNED NOT NULL,
  raw_json     TEXT NOT NULL,
  action       ENUM('create','update','deactivate','skip') NULL,
  is_valid     TINYINT(1) NULL,
  errors_json  TEXT NULL,
  product_id   BIGINT UNSIGNED NULL,
  before_json  TEXT NULL,
  applied      TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_b2b_ir_import (import_id, row_no),
  KEY ix_b2b_ir_valid (import_id, is_valid, row_no),
  CONSTRAINT fk_b2b_ir_import FOREIGN KEY (import_id) REFERENCES b2b_imports (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────── Audit trail (append-only: the application has no update/delete path) ───────────────

CREATE TABLE IF NOT EXISTS b2b_audit_logs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_type   ENUM('admin','business','system') NOT NULL,
  actor_id     VARCHAR(64) NULL,
  actor_label  VARCHAR(190) NULL,
  actor_role   VARCHAR(30) NULL,
  action       VARCHAR(80) NOT NULL,
  entity       VARCHAR(50) NOT NULL,
  entity_id    VARCHAR(64) NULL,
  old_value    MEDIUMTEXT NULL,
  new_value    MEDIUMTEXT NULL,
  ip           VARCHAR(45) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_audit_entity (entity, entity_id, id),
  KEY ix_b2b_audit_created (created_at),
  KEY ix_b2b_audit_action (action, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
