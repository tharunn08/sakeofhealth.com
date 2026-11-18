# Sake of Health business platform: build report (phases 2–12, plus round 2)

Status: **built and tested on a MySQL-compatible engine (Dolt), not yet on MySQL 8.**
Nothing has been deployed. No production database was touched. No B2C file was changed:
the guard confirms all 108 protected files are byte-for-byte unchanged.

Before going live you need to do three things. Each is described further down.

1. Run the MySQL 8 test command (§6) and send the output.
2. Run the migration validator on a **restored copy** of the live database (§7).
3. Take the business decisions that are still pending (§5), or knowingly accept the fail-safe behaviour.

## 1. What was built

| Module | Screens | What works |
|---|---|---|
| **Foundation** (phase 2) | Admin: overview, approvals, business decisions, staff & roles, audit log, my account | Staff login separate from the shop admin, with lockout and two-factor (TOTP). Roles and permissions with scopes (warehouse or territory). Maker-checker approvals, with MFA needed to approve. Settings have no defaults until a decision is approved. Hash-chained audit log. Job queue, monitoring, and a signed, replay-proof WhatsApp status webhook. |
| **Products & pricing** (3) | Price lists, products | Excel import of the brand price list with the divide chain: 235/235 rows match the sheet exactly. **Rows 188, 189 and 204–206 are held**: never priced, never published. Versions with a diff. Tax rates go through approval. Publishing needs approval plus MFA and writes PTR and PTD into the products the existing B2B engine uses. Schemes start inactive and need approval. Price calculator. |
| **Vendors** (4) | Vendors (admin), vendor portal `/vendor-portal` | Self-registration (GSTIN check digit, no account discovery) or staff invite with a one-time link. Documents are checked by content and stored privately. Five verification stages, then approval by a second person. Bank accounts are encrypted, and the person who adds one cannot verify it. The vendor offers products and prices. Suspending a vendor ends their sessions at once. **Each vendor sees only its own records** (404 for anyone else's). |
| **Procurement (P2P)** (5) | Purchasing, goods receipt, supplier bills | Requisition, then approval, then RFQ to approved vendors, then quotes (versioned), then landed-cost comparison, then award (written reason required if not the lowest; MFA). That produces a PO, which needs approval by value band, is sent, and is accepted or rejected by the vendor. The vendor sends a dispatch notice with batch and expiry. The GRN records per line accepted, rejected and quarantined quantities and a QC result; over-receipt is refused, and differences from the dispatch notice need approval. Posting creates lots and batches and moves stock. Supplier bill entry checks the GSTIN and the total. Three-way match with zero tolerance until decided; disputes are resolved by a finance manager. Payments go only to a verified bank account, need approval, and are marked paid by someone other than the person who created them. |
| **Inventory** (6) | Stock & batches | Balances by warehouse and bucket (including quarantine) with warehouse scope. Lots with days to expiry. **Lot trace backward (GRN, PO, supplier) and forward (orders, customers).** Transfers (dispatch, then receipt; shortages recorded). Dispositions need approval. Cycle counts: variances need another person's approval, and stale counts are refused. Nightly reconciliation of ledger against balances against batches. |
| **Network** (7) | Network map | Map data (GeoJSON) drawn on a canvas: no map service and no tiles. Territories with GeoJSON boundaries; assign accounts by point-in-polygon, preview first, and refuse when an account is already in another territory unless confirmed. Bulk retailer-to-distributor remap through the existing B2B mapping service. GSTIN check digit, plus a manual verification with evidence. |
| **Field sales** (8) | Salesman app `/sales-app`, collections (admin) | Only retailers in the salesman's territory. Register a retailer (pending, approved in the existing B2B admin; location stored only with consent). Catalogue priced by the existing engine. The order is held until the retailer reads out a one-time code; wrong-code lockout, resend limits, expiry releases the stock, and an approver override exists (never the salesman). The confirmed order continues exactly like a portal order. Visit check-in with distance from the shop. Collections with receipts and idempotency, a cash limit, and handover confirmed by finance (not the collector). |
| **Returns & recalls** (9) | Recalls | Lot-level return inspection: the batch must have been shipped on that order line; units go to **quarantine**, then a disposition decides. The existing B2B "complete" step (credit note) still works. A recall, once activated, blocks the lot everywhere: stock goes to quarantine, batches can no longer be picked, packed orders are put on hold, and every customer who received the lot is listed and notified. Collection and receipts follow; closing needs reconciliation plus a second person. A recalled batch cannot be received again. |
| **Finance** (10) | Finance | Allocating receipts to invoices (no over-allocation, no other customer's invoice). Receivables and payables ageing. Company bank accounts (last 4 digits only). Bank statement CSV import, idempotent by line hash, with suggested matches confirmed by a person. |
| **Approval thresholds** | Business decisions | When the "PO / payment value bands" or "price-list steps" decision is approved, it becomes the engine's rules (old rules are deactivated, not deleted). Two-step approvals refuse the same person twice. |
| **Returns to vendors** (round 2) | Purchasing, vendor portal | Goods refused at receipt, or quarantined goods, go back to the vendor. Approval issues a **debit note number**. Dispatch takes the goods out of stock. The vendor confirms receipt in the portal. The return is settled against one of the vendor's bills, or by recording the vendor's refund. Debit notes not yet settled reduce payables ageing. The "return to vendor" disposition now redirects here, so stock is never written off without a document. |
| **Customer debit notes** (round 2) | Finance | Raised against company invoices for under-charges, with GST at each line's rate. Numbered on approval. Included in invoice balances, allocation and ageing. |
| **Distributor settlements** (round 2) | Finance | For a period: company-funded promotional discounts the distributor gave, the refund part of credit notes, and a signed manual adjustment with a reason. Overlapping periods are refused; the draft is re-checked at submit. Needs approval, and is marked paid by someone other than the person who drafted it. |
| **Free-goods schemes** (round 2) | Price lists | "Buy N get M free" per product or category, applied to **portal, salesman and office orders**. It is a separate zero-price line, with stock reserved for the free units. It never changes the price, and goes through approval before it applies. Under GST the paid price is the value of the whole supply (CBIC circular 92/11/2019), so the free line carries no separate tax. |
| **Sales desk** (round 2) | Sales desk | Beats (ordered stops, all within the territory), monthly targets, and achievement against them (orders, value, new retailers, collections confirmed by finance, visits). **Office orders** for any approved customer need approval first and then continue like a portal order. |
| **Super stockists** (round 2) | Sales desk | Accounts are created from the office **only when the tiers decision includes super_stockist**, and activated by a second person. Orders go through the office desk and are never priced from a default margin: every product needs its published super-stockist price. Publishing a price list with that tier enabled writes the price and makes the product available to that tier. |
| **SMS (MSG91)** (round 2) | — | Salesman order codes go by SMS through MSG91 using a DLT template (`MSG91_TEMPLATE_ORDER_OTP`), with WhatsApp as the fallback. The code is erased from the queue as soon as the gateway accepts it. Delivery reports reach `/api/webhooks/msg91?token=…`, which requires the secret token, refuses replays and never moves a status backwards. The existing queue **no longer reports SMS as "sent"** when nothing was sent. |
| **Online-shop feed** (round 2) | Stock & batches | **Off until the `b2c.feed.enabled` decision is approved.** It reads the shop's orders file read-only, never loads or writes the shop's code or data, and records each line once. Cancellations are recorded as reversals, and items not linked to a product are listed. It shows shop demand next to business stock. **Observe only:** nothing is deducted, so it cannot prevent shop overselling. |
| **Razorpay fix** (round 2) | — | The existing B2B checkout no longer accepts the "mock" gateway by accident. Online payment is refused unless real Razorpay keys are set, or `PAYMENT_MOCK=true` is set in a non-production environment. |

The API has 130 server routes, each with an explicit permission check. The permission is
re-read from the database on every request, so revocation is immediate.

## 2. Files and migrations

**New code:**
- `src/modules/erp/**`: core, catalog, vendors, procurement, inventory, network, sales, returns, finance, routes, lib
- `erp-web/admin|vendor|sales`
- `scripts/erp-*.js`
- `tools/erp-migration-validation/`
- `tools/verify-on-dolt/`
- tests `tests/erp-*.test.js`, plus the fixture price list

**Changed:**
- `src/modules/b2b/index.js`: three one-line hooks that call the ERP module.
- `src/modules/b2b/pricing/engine.js`: free-goods rules are never read as a margin; `freeGoods()` was added.
- `src/modules/b2b/orders/service.js`: free-goods lines and their stock reservation.
- `src/modules/b2b/payments/service.js`: the Razorpay mock is no longer accepted by accident.
- `src/modules/b2b/notifications/service.js`: SMS goes through MSG91 or is marked skipped, never falsely "sent"; codes are erased after sending.
- `src/modules/b2b/lib/sms-msg91.js` (new).
- `scripts/build.js`: runs the B2C guard.
- `.gitignore`

**Migrations 004–012** (`src/db/migrations`):
- They add 78 tables and make 114 guarded changes to existing tables.
- They are additive only: no DROP, TRUNCATE, DELETE, UPDATE or data seeding, and a test enforces this.
- Each SQL file is SHA-pinned.
- Each guarded change checks `information_schema` first. If the live database differs from what was expected, the change refuses rather than guessing.
- Running them a second time applies 0 changes.

Bugs found and fixed in this round, by running on a real engine:
- Lockout fired one attempt early.
- Error codes were not reaching the screens.
- Ids from the URL were clamped instead of refused: `/staff/abc` would have meant staff #1.
- The migration validator would have reported false drift on ENUM columns of a real MySQL database.
- The price-list publish time was parsed wrongly.

## 3. Tests executed

| Suite | Engine | Result |
|---|---|---|
| B2C regression | none needed | **20/20** |
| Existing B2B unit / isolation | none needed | **16/16**, **3/3** (+1 skip) |
| ERP unit (security, TOTP vectors, audit hash, settings, permissions in every route, B2C guard, migration safety) | none needed | **13/13** |
| ERP isolation (ERP off: no ERP route, page, vendor or sales API exists; database down: shop works) | none needed | **3/3** |
| Migration guard & pins (004–012) | none needed | **12/12** |
| ERP foundation | Dolt 2.7.2 | **10/10** |
| ERP catalog & pricing (real 9 Oct 2026 sheet) | Dolt | **8/8** |
| ERP vendors & procure-to-pay (incl. returns to vendors and debit notes) | Dolt | **10/10** |
| ERP operations (inventory, network, salesman OTP, B2B fulfilment, trace, collections, finance, debit notes, settlements, sales desk, office orders, super stockists, returns, recall, count) | Dolt | **14/14** |
| ERP integrations (MSG91 SMS via a local fake gateway, delivery-report webhook, honest SMS status, shop feed, Razorpay hardening) | Dolt | **5/5** |
| Existing B2B platform | Dolt | 37/47 (3 concurrency tests skipped). **The same 10 fail with and without the ERP changes, re-checked after the round-2 changes to B2B code**; they are Dolt engine gaps (see `tools/verify-on-dolt/README.md`). |
| Migration validator on a restored-style database with data (001–003 plus rows), then 004–012 | Dolt | **PASSED**: existing data fingerprint unchanged, schema matches the reviewed design, re-run applies 0 changes |
| Browser smoke test (17 admin screens, vendor portal, salesman app, shop home) | Chromium | All render; no script errors |
| Build pre-flight plus B2C guard | none needed | Pass: 139 files, 12 migrations, 108 protected files unchanged |

**Not yet executed:** anything on MySQL 8, and the concurrency tests (they need real row locks).

## 4. Known limitations (nothing here is presented as done)

1. **Online-shop stock is not synchronised.** The shop feed is observe-only and delayed. Unified real-time stock would need changes inside the shop, which you asked me not to make.
2. **External services are configuration only.** Nothing is sent or charged until you add the account keys:
   - **MSG91:** `MSG91_AUTH_KEY`, a DLT-approved template per message (`MSG91_TEMPLATE_ORDER_OTP`) and `MSG91_WEBHOOK_TOKEN`. Other SMS messages need their own DLT templates.
   - **WhatsApp:** the existing variables.
   - **Razorpay:** real keys.
3. **GST verification stays manual, by your choice:** checksum plus a person's record. There is no bank API (statements come in as CSV and payments are recorded, not executed) and no map tiles.
4. **Distributor resale is not lot-tracked** unless distributors record batches. A recall lists the customers *we* shipped to.
5. **Super stockists cannot log in to the B2B portal.** They order through the office desk; the portal only has retailer and distributor logins.
6. **Audit chain:** only ERP rows are hash-chained. Making the table append-only for the app user is a database grant (see the runbook).
7. **Salesman and office orders in existing B2B lists:** orders waiting for a code or an approval show there as `pending_otp`; the existing state machine cannot move them.
8. **Not yet run on MySQL 8.** Running on a real engine has already caught real bugs, including two in this round that MySQL would have hit and Dolt does not:
   - unsigned-integer subtraction that MySQL rejects
   - a reserved word (`lines`) used as a column alias

   That is why your MySQL run matters.

## 5. Pending business decisions (fail-safe until approved in "Business decisions")

| Decision | While unset |
|---|---|
| Shelf life at GRN (e.g. 60 %) | The receiver must confirm that each accepted line's shelf life was reviewed |
| Dispatch shelf life, near-expiry % | Existing FEFO picking; reported only |
| HSN source on invoices | Product master as today; never overwritten |
| GST: approved rate required for new price lists | **Required** (publish blocked) |
| Pricing tiers | Retailer + distributor only; no super-stockist price written |
| Pass scheme to buyers | Purchase-side information only |
| PO / payment value bands, price-list steps | One Super Admin step (not the requester) |
| Three-way match tolerance | Zero |
| GRN quantity variance | Any difference from the dispatch notice needs approval |
| Salesman OTP rules | **Salesman ordering is switched off** |
| B2C feed | Off |
| Retention years | Nothing is purged |

## 6. What I need you to run (MySQL 8, throw-away test database)

```powershell
cd C:\Users\Admin\Downloads\sakeofhealth-erp-build
npm install
# in MySQL: CREATE DATABASE sakeofhealth_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
$env:TEST_DB_USER="root"; $env:TEST_DB_PASSWORD="<password>"; $env:TEST_DB_NAME="sakeofhealth_test"
node --test --test-concurrency=1 tests/b2c-regression.test.js tests/b2b-unit.test.js tests/b2b-isolation.test.js tests/b2b-platform.test.js tests/erp-unit.test.js tests/erp-isolation.test.js tests/erp-migrations-guarded.test.js tests/erp-foundation.test.js tests/erp-catalog.test.js tests/erp-procurement.test.js tests/erp-operations.test.js tests/erp-integrations.test.js 2>&1 | Tee-Object erp-mysql-results.txt
```

This wipes `b2b_*` tables **only** in a database whose name ends in `_test`, `_dev` or `_local`.

## 7. Before production: validate on a restored copy

1. Restore last night's production dump into a **new** database named for example `sakeofhealth_restored`.
2. Run the validator from the build folder:

   ```powershell
   $env:VALIDATION_TARGET="restored-copy"; $env:DB_NAME="sakeofhealth_restored"
   node tools/erp-migration-validation/tools/validate-restored-copy.js --repo .
   ```

3. Send me the `validation-report-*.md` it writes. The full procedure, backup and recovery steps are in `docs/erp/MIGRATION-RUNBOOK.md`.

## 8. Deploy (only with your approval) and rollback

**Deploy:**
1. Take a backup.
2. Run `node scripts/migrate.js up`, then `node scripts/migrate.js verify`.
3. Set `ERP_ENABLED=true` and `ERP_JWT_SECRET` (48+ characters in production, different from the admin, customer and B2B secrets).
4. Optionally set `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ORDER_OTP` and `MSG91_WEBHOOK_TOKEN` (24+ characters), and the real `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
5. Load the reference data with `node scripts/erp-reference-data.js --apply --confirm-reference-data`.
6. Create **two** Super Admins with `scripts/erp-create-admin.js`. Both enrol MFA.
7. Make the business decisions.

**Rollback:**
- **Instant:** set `ERP_ENABLED=false` and restart. Every ERP route and page disappears, and the shop and B2B are unaffected.
- **Code:** the previous release runs unchanged on the extended schema.
- **Schema:** restore the pre-migration backup into a new database and switch `DB_NAME`. Never run DROP statements on live data.
