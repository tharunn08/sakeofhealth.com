# Final test report — 19 November 2026

**Overall status: NOT FULLY VALIDATED.**

- **Passed here:** every check that does not need a database. The release gate then **blocks**, because the MySQL 8 suites could not run.
- **Why they could not run:** this workspace has no MySQL 8 server. Docker is not running, packages cannot be installed and the network is restricted.
- **What runs them:** the CI quality gate (`.github/workflows/quality-gate.yml`, with a throw-away MySQL 8 service) or `node scripts/release-gate.js` on a computer with the test database.
- **What is claimed:** only tests that actually ran and passed are reported as passing.

## 1. Build

| Check | Result | Evidence |
|---|---|---|
| Node | v22.23.4. `package.json` requires 20.6 or newer; Hostinger: use 22. | |
| Build check (`npm run build`) | PASS: 214 JavaScript files, 10 dependencies, 18 migrations. Nothing to compile. | `docs/unified/evidence/2026-11-19/SUMMARY.txt` (clean clone) |
| Syntax of every JavaScript file | PASS: 0 errors in 284 files. | same |
| B2C protection (`scripts/b2c-guard.js`) | PASS: 108 protected files match the manifest. The 5 files changed at the owner's request were re-pinned with reasons (`scripts/b2c-manifest.json` → `repins`, 2026-11-19). No business code reaches into the shop. | same |
| Environment templates | PASS: `.env.example`, `.env.development.example`, `.env.production.example` and `ENVIRONMENT.md` match the schema. | release gate |
| Dependencies | No dependency added. The S3 signer uses Node's `crypto`. `npm audit` could not run here (no network); it runs in CI (`--audit-level=high`). | |

## 2. Automated tests

| Group | Tests | Result |
|---|---|---|
| Database-free suites: 33 files, run by `scripts/run-all-tests.js` on a **clean clone of commit a320e1b** | 371 | **368 pass, 0 fail, 3 skipped by design.** The skipped tests need a checkout that contains 013/014, or an empty database. |
| Online shop regression (`tests/b2c-regression.test.js`), also inside the suites above | 20 | 20 pass |
| MySQL 8 suites: 17 files (`scripts/run-mysql-tests.js`) | 172 | **NOT RUN — no MySQL 8 server here** |

### New in this phase (all database-free, all pass)

| Suite | Tests | Covers |
|---|---|---|
| `protected-products` | 14 | Registry pin; store rules. Situations: restart, redeploy, migration, backup/restore, CSV import, bulk updates, admin deletion, sync. Integrity repair; fail-safe start (exit 78). |
| `env-config` | 11 | Every variable documented and used; validation; templates; secret generation; setup script; check script; production refusal. |
| `storage` | 11 | AWS Signature V4 example values (signing keys, canonical request, signature); a fake S3 server; error handling; a local round trip; path traversal; file sending; cleanup when storing fails. |
| `jobs-cron` | 10 | `JOBS_MODE`; budgets; schedule slots and repeat-safety; the finite runner; which timers each mode starts; the cron script end to end; a damaged catalogue; production refusal; the HTTP trigger (404 / 403 / 200). |
| `reconcile-catalogue` | 5 | The supplied price list and invoice: every finding. The Excel file is unchanged afterwards. Database comparison rules; the read-only database access; the invoice extraction against the invoice's own totals. |
| `encryption-and-reset` | 2 | Encryption v2 with ENCRYPTION_KEY, and reading v1; `npm run reset` safety. |

Two existing tests were changed. Each now checks the same thing at its new location, so neither was weakened:

- `notifications-workflow`: "one stock alert a day" now checks the single schedule, where the daily slot moved.
- `env-config`: STORAGE_DIR was removed from the expected list, because local storage uses B2B_PRIVATE_DIR.

### Mutation checks

The storage tests were run against two deliberately broken signers: a changed header after signing, and swapped key-derivation steps. They failed both times, as they should, and passed again on the real code.

## 3. MySQL 8 suites — NOT RUN

These 17 files hold 172 tests, including the new `jobs-cron.mysql` (6):

- `b2b-platform`, `erp-foundation`, `erp-catalog`, `erp-procurement`, `erp-operations`, `erp-integrations`
- `erp-federation.mysql`, `identity-seed.mysql`, `notifications-reliability.mysql`, `inventory-ledger.mysql`, `notifications-center.mysql`, `notifications-consent.mysql`, `notifications-workflow.mysql`
- `operations-channels.mysql`, `manufacturing-delivery.mysql`, `suppliers-salesmen-delivery.mysql`, `jobs-cron.mysql`

They also cover these changes of this phase:

- uploads stored before the transaction (registration, documents, supplier, manufacturing and proof of delivery);
- sending right after commit;
- slot repeat-safety across two processes;
- the run lock;
- cleanup.

**Run them** with a dedicated `*_test` database and a test-only account (the runner refuses anything else):

```powershell
$env:TEST_DB_HOST="127.0.0.1"; $env:TEST_DB_USER="soh_test"; $env:TEST_DB_NAME="sakeofhealth_test"
node scripts/release-gate.js
```

## 4. Release gate — verified to block

| Situation | Result |
|---|---|
| No test database settings | **RELEASE BLOCKED.** The MySQL 8 suites cannot run, so not every check ran. Exit 1. |
| Settings given but the server is unreachable | **RELEASE BLOCKED.** The checks failed (MySQL 8 suites: connection refused). Exit 1. |
| CI (`.github/workflows/quality-gate.yml`) | Written and YAML-checked. It **has not run here**, because no GitHub Actions runner is available. The first push runs it. Make it a *required* check in branch protection. |

## 5. Browser checks (headless Chrome, test data, no database)

| Check | Screens | Result |
|---|---|---|
| Every-screen sweep (`checks/sweep/sweep.py`), desktop 1366 × 900 and mobile 390 × 844 | 94 screens: 19 storefront, 6 portal and 22 admin-sidebar pages for the owner, each at both sizes. Plus a protected-products check. | **0 page errors, 0 console errors, 0 unexpected failed requests, 0 blank screens, 0 sideways scrolling.** The sweep first found one defect, the Settings page overflowing on mobile (QR-09); it was fixed and the sweep re-run. 74 business API answers were 503 "database not reachable", as designed. |
| Protected products in Admin → Catalogue | 1 | 4 "Protected" badges, no delete button for them |
| Business screens in the shell (`erp_shell.py`), with an empty test fixture | 18 + 18 | PASS: no script errors, links stay in the shell. With the database down, the sidebar shows "Business modules unavailable". |
| Suppliers, salesmen and delivery screens (`people_ui.py`), with labelled fixtures | 13 groups | ALL PASS |
| Manufacturing and delivery screens (`mfg_ui.py`), with labelled fixtures | 5 groups | ALL PASS |

These checks prove what the screens send and show. They do not prove business results; those are in the MySQL suites.
Raw results: `docs/unified/reports/screen-sweep-2026-11-19.json`.

## 6. Performance

See `PERFORMANCE-REPORT.md`. The shop was measured at 1,000, 10,000 and 30,000 orders. The trade and ERP platform at volume (`scripts/perf-seed.js`, 100,000 orders) needs MySQL and is **not run**.

## 7. Unresolved-issue register

| ID | Severity | Issue | What closes it |
|---|---|---|---|
| U-01 | High | The MySQL 8 suites (172 tests) have not run on this build. | A green CI run, or `node scripts/release-gate.js` against the test database |
| U-02 | Medium | Shop JSON store slows down as orders grow (QR-11). | Owner decision on the options in `PERFORMANCE-REPORT.md` |
| U-03 | Low | The admin customer list is not paged (QR-12). | Fixed together with U-02 |
| U-04 | Medium | Migrations 013/014 are held back (decision D5). | Owner's D5 decision; see the D5 inspection reports |
| U-05 | Info | The second Excel file was not received, and the read-only reconciliation against your database has not been run. | Send the file; run `scripts/reconcile-catalogue.js --database` |
| U-06 | Info | SKU, HSN and GST of the four protected products are still to confirm. | Owner confirmation |
| U-07 | Info | The CI workflow has never run. | The first push to GitHub |
| U-08 | Info | `npm audit` was not run (no network here). | CI step |
