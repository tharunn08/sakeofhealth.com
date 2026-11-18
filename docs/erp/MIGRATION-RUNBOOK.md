# Migration execution plan — 004 to 012 (DRAFT, not approved)

Status: **validated offline only.** Not run on any MySQL server. Nothing in this
plan is to be executed on production until (1) the restored-copy validation below
has PASSED and (2) you have approved the production run in writing.

## What the migrations do

| Order | File | New tables | Guarded changes to existing tables |
| --- | --- | --- | --- |
| 1 | `004_core_governance.js` | 12 (staff, roles, permissions, approvals, jobs, integration logs, monitor events, webhook events) | 15 — audit-log columns, notification template/delivery columns, `skipped_no_provider` status |
| 2 | `005_products_pricing.js` | 4 (tax rates, price lists, price-list items, product aliases) | 16 — product master columns, super-stockist price columns, pricing-rule audience + `free_qty` |
| 3 | `006_vendors.js` | 11 (vendor identity, users, documents, verifications, bank, products, price lists, contracts, messages, addresses, capabilities) | 2 — foreign keys products → vendors, price lists → vendors |
| 4 | `007_procurement_lots.js` | 23 (lots, requisitions, RFQs, POs, ASNs, GRNs, inspections, supplier bills, matching, payments, purchase returns) | 12 — `lot_id` on batches / movements / allocations, quarantine column, new movement types |
| 5 | `008_inventory.js` | 9 (locations, transfers, counts, dispositions, reorder rules, B2C read-only cursor and postings) | 4 — quarantine bucket, warehouse type and coordinates |
| 6 | `009_network.js` | 3 (territories, GST verifications, geo corrections) | 17 — `super_stockist` type, `more_info_required` status, email optional, territory links |
| 7 | `010_field_sales.js` | 7 (salesmen, beats, beat stops, visits, OTP challenges, OTP attempts, targets) | 32 — order channel / OTP / delivery columns, field-collection columns on payments |
| 8 | `011_returns_recalls.js` | 4 (recalls, recall lots, recall parties, recall receipts) | 15 — return type, recall link, inspection fields and lot on return lines |
| 9 | `012_finance.js` | 5 (payment allocations, debit notes, bank accounts, statement lines, distributor settlements) | 1 — unallocated amount on payments |

Totals: 78 new tables, 114 guarded changes, 0 destructive statements, 0 data rows written
(no seed, no backfill). Reference data (permissions, system roles) is **not** inserted
by these migrations; it is a separate, reviewed step in Phase 2.

Every change is one of: add nullable/defaulted column · append values to the end of an
ENUM · make a NOT NULL column nullable (2: `b2b_accounts.email`, `b2b_users.email`) · add
index · add foreign key. `lib/guarded.js` checks information_schema first and refuses
when the live definition differs from what was reviewed.

## Stage A — validation on a restored copy (now, before approval)

Needs: a machine with **MySQL 8** (same major version as production) and Node 18+.

1. **Back up production (read-only).** Either
   - Hostinger hPanel → Databases → phpMyAdmin → Export (SQL, all `b2b_` tables, structure + data), or
   - over SSH: `mysqldump --single-transaction --quick --routines --triggers --hex-blob --no-tablespaces -h <host> -u <user> -p <db> > soh_b2b_YYYYMMDD.sql`
   - and run `npm run backup` on the server, which also copies the B2C JSON folder and private documents.
   Record `sha256sum` (or `Get-FileHash`) of every file. Keep one copy off the server.
2. **Restore into a new local database** named e.g. `sakeofhealth_b2b_restore`:
   `mysql -u root -p -e "CREATE DATABASE sakeofhealth_b2b_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"` then
   `mysql -u root -p sakeofhealth_b2b_restore < soh_b2b_YYYYMMDD.sql`. Compare row counts with the backup manifest.
3. **Make a scratch checkout** of the repository at the exact commit running in production
   (not your working folder). `npm ci`. Copy the pack's `migrations/src/db/migrations/*`
   (the nine `.js` files, `lib/`, `sql/`) into the checkout's `src/db/migrations/`.
4. In the checkout's `.env`: `DB_HOST=127.0.0.1`, `DB_NAME=sakeofhealth_b2b_restore`,
   `NODE_ENV=development`, `B2B_ENABLED=true`, `DATA_DIR` and `B2B_PRIVATE_DIR` pointing to
   empty scratch folders.
5. Run the harness: `VALIDATION_TARGET=restored-copy node <pack>/migrations/tools/validate-restored-copy.js --repo <checkout>`
   (PowerShell: `$env:VALIDATION_TARGET="restored-copy"; node …`). It refuses any database
   not named `*_restore`, `*_restored`, `*_validation` or `*_staging`.
6. It writes `validation-report-<time>.md/.json`. PASSED means: MySQL 8; 001–003 applied
   with the repo's checksums; live schema identical to the reviewed baseline (no drift);
   no name collisions; all 78 tables / columns / indexes / keys present afterwards;
   **existing data fingerprints identical before and after**; a second run changes nothing.
7. Run the existing suites against the extended schema:
   `TEST_DB_NAME=sakeofhealth_test npm test` (in the checkout; the test DB is disposable).
8. Send me both reports. Any FAILED line is fixed in the pack, then Stage A is repeated.

## Stage B — production run (only after written approval; not part of this phase)

1. Announce a maintenance window. B2C keeps running throughout (it never touches MySQL);
   set `B2B_ENABLED=false` for the window so the business portal is not mid-request.
2. Fresh backup exactly as A1, verify it restores (A2) — no backup, no migration.
3. Run the harness in `--precheck-only` mode against production **with a read-only DB user**
   (it changes nothing) to prove production still matches the validated copy.
4. `npm run migrate` with the app's normal DB user. Watch `migrate:status`.
5. `npm run migrate:verify`, then the post-checks from the harness (schema vs expected).
6. Re-enable `B2B_ENABLED=true`, smoke-test the portal and the shop.

## Recovery and rollback

- **A migration stops half-way** (network, lock timeout): MySQL DDL cannot roll back,
  but every step is guarded — fix the cause and run `npm run migrate` again; finished
  steps are skipped. The `b2b_schema_migrations` row is only written when a whole file
  succeeds.
- **The guards refuse** (live schema differs from the reviewed one): nothing in that step
  was changed. Stop, send the message; the pack is corrected and re-validated.
- **Something is wrong after a successful run:** the previous application release keeps
  working on the extended schema (all additions are unused by old code). Roll back the
  code only. Do not drop anything.
- **Data damage (should not be possible — no statement writes rows):** restore the Stage B
  backup into a NEW database (`…_recovered`), verify it, and point `DB_NAME` at it. The
  damaged database is kept untouched for investigation. No DROP is ever run.
- B2C JSON data and private documents are not touched by any migration; their backups
  are taken anyway (A1) so the whole application can be restored together.

## Locking and timing

`ADD COLUMN` (nullable, appended) and appending ENUM values are metadata-only in MySQL 8
for most tables. Adding foreign keys and making `email` nullable rebuild the table
(`b2b_accounts`, `b2b_users`, `b2b_orders`, `b2b_payments`, `b2b_order_items`,
`b2b_batches`, `b2b_stock_movements`, `b2b_return_items`). The harness records the time
taken on the restored copy; that time, with margin, is the maintenance window.
