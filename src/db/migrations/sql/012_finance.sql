-- ═══════════════════════════════════════════════════════════════════════
--  DRAFT — Phase 11 (Finance). Not applied anywhere. Needs CA review.
--  Existing b2b_invoices, b2b_credit_notes, b2b_payments and the credit ledger
--  stay. New: allocation of receipts across invoices, debit notes to buyers,
--  bank statement import and reconciliation, distributor settlements.
-- ═══════════════════════════════════════════════════════════════════════

-- One receipt can settle several invoices; one invoice can be settled by
-- several receipts. Ageing is computed from invoice due_date minus allocations.
CREATE TABLE IF NOT EXISTS b2b_payment_allocations (
  payment_id     BIGINT UNSIGNED NOT NULL,
  invoice_id     BIGINT UNSIGNED NOT NULL,
  amount         DECIMAL(14,2) NOT NULL,
  allocated_by   BIGINT UNSIGNED NULL,
  allocated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reversed_at    DATETIME NULL,                 -- corrections reverse, never delete
  PRIMARY KEY (payment_id, invoice_id),
  KEY ix_b2b_pa_invoice (invoice_id),
  KEY ix_b2b_pa_by (allocated_by),
  CONSTRAINT fk_b2b_pa_payment FOREIGN KEY (payment_id) REFERENCES b2b_payments (id),
  CONSTRAINT fk_b2b_pa_invoice FOREIGN KEY (invoice_id) REFERENCES b2b_invoices (id),
  CONSTRAINT fk_b2b_pa_by FOREIGN KEY (allocated_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Debit note to a buyer (price short-billed, freight, interest on late payment).
CREATE TABLE IF NOT EXISTS b2b_debit_notes (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  debit_note_no    VARCHAR(32) NOT NULL,
  invoice_id       BIGINT UNSIGNED NOT NULL,
  buyer_account_id BIGINT UNSIGNED NOT NULL,
  note_date        DATE NOT NULL,
  reason           VARCHAR(300) NOT NULL,
  taxable_total    DECIMAL(14,2) NOT NULL,
  cgst_total       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  sgst_total       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  igst_total       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  grand_total      DECIMAL(14,2) NOT NULL,
  approval_id      BIGINT UNSIGNED NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_dn_no (debit_note_no),
  KEY ix_b2b_dn_invoice (invoice_id),
  KEY ix_b2b_dn_buyer (buyer_account_id, note_date),
  KEY ix_b2b_dn_approval (approval_id),
  KEY ix_b2b_dn_created_by (created_by),
  CONSTRAINT fk_b2b_dn_invoice FOREIGN KEY (invoice_id) REFERENCES b2b_invoices (id),
  CONSTRAINT fk_b2b_dn_buyer FOREIGN KEY (buyer_account_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_dn_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_dn_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_bank_accounts (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_type    ENUM('company','distributor') NOT NULL DEFAULT 'company',
  owner_account_id BIGINT UNSIGNED NULL,
  bank_name     VARCHAR(120) NOT NULL,
  account_last4 CHAR(4) NOT NULL,
  ifsc          CHAR(11) NOT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_b2b_ba_owner (owner_account_id, owner_type),
  CONSTRAINT fk_b2b_ba_owner FOREIGN KEY (owner_account_id) REFERENCES b2b_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS b2b_bank_statement_lines (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bank_account_id INT UNSIGNED NOT NULL,
  import_id       BIGINT UNSIGNED NULL,
  txn_date        DATE NOT NULL,
  description     VARCHAR(300) NOT NULL,
  reference       VARCHAR(80) NULL,             -- UTR / cheque no
  debit           DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  credit          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  balance         DECIMAL(14,2) NULL,
  line_hash       CHAR(64) NOT NULL,            -- stops the same statement being imported twice
  match_status    ENUM('unmatched','suggested','matched','ignored') NOT NULL DEFAULT 'unmatched',
  matched_type    ENUM('payment','supplier_payment','collection','other') NULL,
  matched_id      BIGINT UNSIGNED NULL,
  matched_by      BIGINT UNSIGNED NULL,
  matched_at      DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_bsl_hash (bank_account_id, line_hash),
  KEY ix_b2b_bsl_status (bank_account_id, match_status, txn_date),
  KEY ix_b2b_bsl_ref (reference),
  KEY ix_b2b_bsl_import (import_id),
  KEY ix_b2b_bsl_by (matched_by),
  CONSTRAINT fk_b2b_bsl_bank FOREIGN KEY (bank_account_id) REFERENCES b2b_bank_accounts (id),
  CONSTRAINT fk_b2b_bsl_import FOREIGN KEY (import_id) REFERENCES b2b_imports (id),
  CONSTRAINT fk_b2b_bsl_by FOREIGN KEY (matched_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Periodic settlement between the company and a distributor (schemes passed on,
-- returns credited, claims), approved by finance.
CREATE TABLE IF NOT EXISTS b2b_distributor_settlements (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  settlement_no    VARCHAR(24) NOT NULL,
  distributor_id   BIGINT UNSIGNED NOT NULL,
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  scheme_claims    DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  return_credits   DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  other_adjustments DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  net_amount       DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  status           ENUM('draft','pending_approval','approved','settled','cancelled') NOT NULL DEFAULT 'draft',
  approval_id      BIGINT UNSIGNED NULL,
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_b2b_ds_no (settlement_no),
  UNIQUE KEY uq_b2b_ds_period (distributor_id, period_from, period_to),
  KEY ix_b2b_ds_approval (approval_id),
  KEY ix_b2b_ds_created_by (created_by),
  CONSTRAINT fk_b2b_ds_dist FOREIGN KEY (distributor_id) REFERENCES b2b_accounts (id),
  CONSTRAINT fk_b2b_ds_approval FOREIGN KEY (approval_id) REFERENCES b2b_approval_requests (id),
  CONSTRAINT fk_b2b_ds_created_by FOREIGN KEY (created_by) REFERENCES b2b_staff (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
