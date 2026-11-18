-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 3 (Products & pricing). Not applied anywhere.
--  Effective-dated GST per product, versioned price lists that reproduce
--  the "SS Price List" formula chain, schemes, and import name aliases.
--  b2b_products gains columns (sap_code, uom, shipper_size, …) — see alters.md.
-- ═══════════════════════════════════════════════════════════════════════

-- GST is decided per product and date, approved by a person. HSN is stored
-- for printing only and never used to look a rate up.
CREATE TABLE IF NOT EXISTS b2b_tax_rates (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id    BIGINT UNSIGNED NOT NULL,
  hsn_code      VARCHAR(10)  NOT NULL,
  gst_rate      DECIMAL(5,2) NOT NULL,          -- percent: 0, 5, 12, 18, 28
  cess_rate     DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  valid_from    DATE NOT NULL,
  valid_to      DATE NULL,                      -- NULL = open
  source_note   VARCHAR(255) NULL,              -- e.g. "CA review 2026-11, invoice 4050191465"
  status        ENUM('draft','approved','superseded') NOT NULL DEFAULT 'draft',
  approval_id   BIGINT UNSIGNED NULL,
  created_by    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_tr_lookup (product_id, status, valid_from),
  KEY ix_b2b_tr_hsn (hsn_code),
  KEY ix_b2b_tr_approval (approval_id),
  KEY ix_b2b_tr_created_by (created_by),
  CONSTRAINT fk_b2b_tr_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_tr_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_tr_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per published (or draft) version of a brand's trade price list.
-- Publishing version N sets valid_to on version N-1 in the same transaction.
CREATE TABLE IF NOT EXISTS b2b_price_lists (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code             VARCHAR(40)  NOT NULL,       -- e.g. SST-FMCG
  version_no       INT UNSIGNED NOT NULL,
  name             VARCHAR(160) NOT NULL,       -- "SS Price List revised 9 Oct 2026"
  brand            VARCHAR(100) NULL,
  vendor_id        BIGINT UNSIGNED NULL,        -- the brand owner / manufacturer
  formula_profile  ENUM('divide_chain_incl_gst','markup_on_base','off_mrp') NOT NULL DEFAULT 'divide_chain_incl_gst',
  rounding_json    VARCHAR(500) NOT NULL,       -- which steps round, to how many places, half-up
  status           ENUM('draft','submitted','approved','published','superseded','rejected') NOT NULL DEFAULT 'draft',
  valid_from       DATETIME NULL,               -- scheduled publish time (UTC)
  valid_to         DATETIME NULL,
  source_import_id BIGINT UNSIGNED NULL,
  approval_id      BIGINT UNSIGNED NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at     DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_pl_version (code, version_no),
  KEY ix_b2b_pl_status (code, status, valid_from),
  KEY ix_b2b_pl_vendor (vendor_id),
  KEY ix_b2b_pl_import (source_import_id),
  KEY ix_b2b_pl_approval (approval_id),
  KEY ix_b2b_pl_created_by (created_by),
  CONSTRAINT fk_b2b_pl_import FOREIGN KEY (source_import_id) REFERENCES b2b_imports (id),
  CONSTRAINT fk_b2b_pl_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_pl_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
  -- fk to b2b_vendors is added in 006 (alters.md) because vendors do not exist yet
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inputs (MRP, GST, margins, scheme) and every computed tier, frozen per version.
-- Percentages are stored as percent (15.0000 = 15 %), money in rupees.
CREATE TABLE IF NOT EXISTS b2b_price_list_items (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  price_list_id      BIGINT UNSIGNED NOT NULL,
  product_id         BIGINT UNSIGNED NOT NULL,
  mrp                DECIMAL(12,2) NOT NULL,
  offer_mrp          DECIMAL(12,2) NULL,        -- only from a written brand confirmation; never inferred from text
  gst_rate           DECIMAL(5,2)  NOT NULL,
  retailer_margin_pct    DECIMAL(7,4) NOT NULL,
  distributor_margin_pct DECIMAL(7,4) NOT NULL,
  ss_margin_pct          DECIMAL(7,4) NOT NULL,
  scheme_pct         DECIMAL(7,4) NOT NULL DEFAULT 0.0000,  -- brand's trade scheme to us (purchase side); selling discounts stay in b2b_pricing_rules
  ptr_incl_raw       DECIMAL(14,6) NOT NULL,    -- unrounded, as in the sheet
  ptr_ex             DECIMAL(12,2) NOT NULL,
  ptd_incl           DECIMAL(12,2) NOT NULL,
  ptd_ex             DECIMAL(12,2) NOT NULL,
  ptss_incl          DECIMAL(12,2) NOT NULL,
  ptss_ex            DECIMAL(12,2) NOT NULL,
  purchase_cost_ex   DECIMAL(12,4) NULL,        -- what Ixitek pays: PTD ex-GST less scheme
  source_row_no      INT UNSIGNED NULL,
  -- 'held' rows are excluded from publishing: the product keeps no new price until a person resolves it
  check_status       ENUM('ok','warning','held') NOT NULL DEFAULT 'ok',
  check_notes        VARCHAR(500) NULL,         -- e.g. "margin amount uses 199, PTR uses 225"
  manual_override    TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_pli (price_list_id, product_id),
  KEY ix_b2b_pli_product (product_id),
  CONSTRAINT fk_b2b_pli_list FOREIGN KEY (price_list_id) REFERENCES b2b_price_lists (id),
  CONSTRAINT fk_b2b_pli_product FOREIGN KEY (product_id) REFERENCES b2b_products (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Reviewed names a supplier uses for our product ("Cow#s Premium Ghee 1ltr MRP950").
CREATE TABLE IF NOT EXISTS b2b_product_aliases (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id   BIGINT UNSIGNED NOT NULL,
  source       VARCHAR(40)  NOT NULL,          -- vendor code, 'price_list', 'b2c'
  alias        VARCHAR(255) NOT NULL,
  alias_norm   VARCHAR(255) NOT NULL,          -- lower-case, punctuation stripped
  created_by   BIGINT UNSIGNED NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_alias (source, alias_norm),
  KEY ix_b2b_alias_product (product_id),
  KEY ix_b2b_alias_created_by (created_by),
  CONSTRAINT fk_b2b_alias_product FOREIGN KEY (product_id) REFERENCES b2b_products (id),
  CONSTRAINT fk_b2b_alias_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
