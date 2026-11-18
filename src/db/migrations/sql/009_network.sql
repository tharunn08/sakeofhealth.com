-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 7 (Retailer & distributor network). Not applied anywhere.
--  Existing b2b_accounts, b2b_service_areas and b2b_retailer_distributor_map
--  are reused (map rows already are the mapping history). New: territories
--  with polygons, GST verification history, geocode corrections.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS b2b_territories (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(30)  NOT NULL,
  name           VARCHAR(120) NOT NULL,
  parent_id      INT UNSIGNED NULL,             -- region → area → beat
  level          ENUM('region','area','beat') NOT NULL DEFAULT 'area',
  state_id       SMALLINT UNSIGNED NULL,
  boundary_geojson MEDIUMTEXT NULL,             -- polygon drawn on the admin map
  bbox_min_lat   DECIMAL(10,7) NULL,            -- for a fast first filter before the polygon test
  bbox_min_lng   DECIMAL(10,7) NULL,
  bbox_max_lat   DECIMAL(10,7) NULL,
  bbox_max_lng   DECIMAL(10,7) NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_by     BIGINT UNSIGNED NOT NULL,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_terr_code (code),
  KEY ix_b2b_terr_parent (parent_id),
  KEY ix_b2b_terr_state (state_id),
  KEY ix_b2b_terr_bbox (bbox_min_lat, bbox_max_lat, bbox_min_lng, bbox_max_lng),
  KEY ix_b2b_terr_created_by (created_by),
  CONSTRAINT fk_b2b_terr_parent FOREIGN KEY (parent_id) REFERENCES b2b_territories (id),
  CONSTRAINT fk_b2b_terr_state FOREIGN KEY (state_id) REFERENCES b2b_states (id),
  CONSTRAINT fk_b2b_terr_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every GSTIN check, from any source. Format/checksum alone is recorded as
-- source 'checksum' and never sets an account to "verified".
CREATE TABLE IF NOT EXISTS b2b_gst_verifications (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gstin             CHAR(15) NOT NULL,
  party_type        ENUM('account','vendor') NOT NULL,
  party_id          BIGINT UNSIGNED NOT NULL,
  source            ENUM('checksum','api','manual') NOT NULL,
  provider          VARCHAR(40) NULL,
  result            ENUM('active','cancelled','suspended','not_found','format_ok','format_invalid','error') NOT NULL,
  legal_name        VARCHAR(200) NULL,
  trade_name        VARCHAR(200) NULL,
  registration_type VARCHAR(40) NULL,           -- regular, composition, …
  state_code        CHAR(2) NULL,
  address           VARCHAR(500) NULL,
  registered_on     DATE NULL,
  name_match        ENUM('exact','close','mismatch','not_checked') NOT NULL DEFAULT 'not_checked',
  evidence_doc      VARCHAR(80) NULL,           -- stored file for a manual check (screenshot of the GST portal)
  checked_by        BIGINT UNSIGNED NULL,
  checked_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_gv_gstin (gstin, checked_at),
  KEY ix_b2b_gv_party (party_type, party_id, checked_at),
  KEY ix_b2b_gv_by (checked_by),
  CONSTRAINT fk_b2b_gv_by FOREIGN KEY (checked_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Location corrections: who moved a pin, from where to where, and why.
CREATE TABLE IF NOT EXISTS b2b_geo_corrections (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id    BIGINT UNSIGNED NOT NULL,
  old_lat       DECIMAL(10,7) NULL,
  old_lng       DECIMAL(10,7) NULL,
  new_lat       DECIMAL(10,7) NOT NULL,
  new_lng       DECIMAL(10,7) NOT NULL,
  source        ENUM('salesman_gps','admin_map','geocoder','retailer') NOT NULL,
  accuracy_m    INT UNSIGNED NULL,
  consent_given TINYINT(1) NOT NULL DEFAULT 0,
  reason        VARCHAR(300) NULL,
  actor_type    VARCHAR(12) NOT NULL,
  actor_id      BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_b2b_geoc_account (account_id, created_at),
  CONSTRAINT fk_b2b_geoc_account FOREIGN KEY (account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
