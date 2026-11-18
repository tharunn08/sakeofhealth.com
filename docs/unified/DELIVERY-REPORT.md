# Delivery report — unified platform (operations channels), 2026-11-17

Commits on top of `199e6fb` (N5):

* `0b7c3f8` — the operations channels.
* `9c46935` — fix: a MySQL outage after "enforce" fails closed.
* The evidence commit that adds this folder.

Nothing was deployed. No production database or file was connected to, migrated or changed.

## 0. Headline status

| Area | Status |
|---|---|
| Code for every module in the prompt | **Implemented and integrated** (one process, one sidebar, one ledger, one sign-in, one notification outbox). |
| Database-free tests, B2C guard, build, syntax, browser checks | **Run and passing** on a clean clone of the final commit. |
| MySQL 8 integration suites (14 suites, including the 14 new operations scenarios) | **BLOCKED — NOT RUN.** There is no MySQL server here, the Docker daemon is down, and the package network and DNS are blocked (`evidence/mysql-unavailable.log`, `evidence/mysql-runner-attempt.log`). Run them on Windows with `SETUP-AND-TEST-ON-WINDOWS.txt` Part C. |
| Real SMTP / WhatsApp delivery | **BLOCKED — NOT VERIFIED.** There is no outbound network here, and credentials must not be shared. The code paths are tested against provider fakes. |

Until Part C passes on your machine, the database behaviour is **written, not proven**. Do not treat any MySQL-backed feature as accepted before then.

## 1. Test results (final commit, clean clone)

| Check | Result | Evidence |
|---|---|---|
| B2C guard (108 protected files, import rule) | OK | `evidence/clean/b2c-guard.log` |
| Build check | passed: 185 JS files, 17 migrations (001–012, 015–019) | `evidence/clean/build.log` |
| `node --check` on every tracked JS file | 0 failures of 241 | `evidence/clean/syntax-check.log` |
| DB-free tests (all files not in the MySQL list) | **275 tests, 272 pass, 0 fail, 3 skipped**; the skips are listed after this table | `evidence/clean/db-free-tests.log` |
| B2C regression (scenario 12) | 20 / 20 pass | `evidence/clean/b2c-regression.log` |
| New: `operations-channels.test.js` | 18 / 18 pass | `evidence/clean/operations-channels.log` |
| Red runs of the new tests on the code before the change | 18 / 18 fail on 199e6fb; the outage test fails on 0b7c3f8 | `evidence/red-operations-channels.log`, `evidence/red-mode-outage.log` |
| Browser: new admin screens, desktop and mobile; field app offline → online | PASS | `evidence/clean/browser-ops_ui.log`, `evidence/screens/` |
| Browser: earlier checks (ERP shell, first login, notifications, shell flow, admin cancel, blog CSV, 66-page smoke) | all PASS | `evidence/clean/browser-*.log` |
| Browser: shop checkout, business platform off | PASS | `evidence/clean/browser-checkout_flow.log` |
| Browser: shop checkout, business platform **on** and MySQL down | PASS (the shop works as today) | `evidence/clean/browser-checkout_flow-erp-on-mysql-down.log`, `evidence/pay-erp-on-db-down.log` |
| MySQL 8 suites (14) | **NOT RUN — blocked** | `evidence/clean/mysql-suites-not-run.txt` |

The three DB-free skips:

* first-deploy, which needs a database;
* two cases that apply only when 013/014 are present. They are absent from the delivery, as required.

The working copy also has one expected failure: the migration-pinning test names the undecided `013_erp_governance.js` / `014_erp_governance.js`. Those files are on your machine only (D5) and are not in the commits or the ZIP.

**Browser checks** answer the business API with labelled TEST FIXTURES. They prove what the screens send and show:

* one press sends one request;
* the idempotency keys are right;
* offline work is queued and then sent once.

They do not prove the business results; those are what the MySQL suites test.

## 2. The 12 required scenarios

| # | Scenario | Where it is tested | Status |
|---|---|---|---|
| 1 | B2C order reserves and deducts correctly | mysql "1 + 5"; DB-free hold / front-layer / keys tests | DB-free pass · **MySQL not run** |
| 2 | B2B order updates the same ledger | mysql "2 + 4"; existing `inventory-ledger.mysql`; DB-free "one ledger" | DB-free pass · **MySQL not run** |
| 3 | Event sale updates the same ledger | mysql "3 + 10"; DB-free counter-sale tests | DB-free pass · **MySQL not run** |
| 4 | Salesman field order, same ledger | mysql "2 + 4"; existing `erp-operations` salesman tests | **MySQL not run** |
| 5 | Cancellation releases stock | mysql "1 + 5", event void; existing B2B cancel tests | **MySQL not run** |
| 6 | Returns / damaged goods | mysql "6"; shop line return (condition) | **MySQL not run** |
| 7 | Concurrent orders cannot oversell | mysql "7" (8 buyers, last units); existing B2B concurrency tests | **MySQL not run** |
| 8 | Offline sync without duplicates | mysql "8"; DB-free offline + device-queue tests; browser field app | DB-free and browser pass · **MySQL not run** |
| 9 | Customer mapping without duplicates | mysql "9"; DB-free matching test | DB-free pass · **MySQL not run** |
| 10 | Notification triggers | mysql "3 + 10" (invoice by WhatsApp + email through the outbox); N1–N5 suites | DB-free pass · **MySQL not run** · real delivery blocked |
| 11 | Permission restrictions | mysql "11"; DB-free refund-permission and staff-fence tests | DB-free pass · **MySQL not run** |
| 12 | Existing B2C regression | `b2c-regression.test.js`, guard, checkout browser checks | **PASS** |

## 3. Requirement-by-requirement audit

**1. Inspect first.**

* Done. Commits, migrations 016–018 (re-read, unchanged) and the APIs were inspected first.
* Draft files of unknown origin were found in the working copy:
    * the 019 SQL and migration;
    * `field/locations.js`;
    * `customers/service.js`;
    * reference-data permissions.
* They were reviewed, corrected and kept.
* The draft table `b2b_b2c_stock_publish` was removed, because it implied writing stock figures into the shop.

**2. Protect B2C.**

* Done. No protected file was changed, and the guard passes after every integration.
* The shop is reached only through:
    * the read-only adapter;
    * two front handlers registered before the shop routers. They call `next()`, and the shop's answers pass through untouched.

**3b.2 Locations.**

* **Implemented:**
    * GPS and manual capture;
    * history;
    * event and salesman filters;
    * admin map (an SVG plot with an "Open map" link per point);
    * attendance (first and last fix per day);
    * visit and transaction references;
    * role-based visibility.
* **Not built:** an embedded street map, which would need a map library or a paid tile service. That is not approved.

**3b.3 Shop shadow mode.**

* **Implemented:**
    * shadow replays checkouts and orders with no ledger movement;
    * it records "would refuse" and shop-versus-ledger discrepancies;
    * an admin screen lists the blockers to clear before enforcing;
    * the switch is a business decision with a second approver;
    * no duplicate deduction, by a unique key per (mode, order, product) and keyed movements.
* **Not built:** writing ledger figures back into the shop's product stock. That would change shop files and live B2C behaviour, which is forbidden. Differences are shown as discrepancies instead.

**3b.4 B2C enforcement.**

* **Implemented:**
    * stock check and hold at Pay, with the shop's own wording;
    * concurrency safety through ordered row locks;
    * FEFO allocation before the order exists;
    * deduction when the order leaves (`out_for_delivery` / `delivered`);
    * release on cancel, payment failure and hold expiry;
    * cancellation after dispatch goes back to quarantine;
    * staff-recorded returns by condition;
    * paid-but-short refunds (Razorpay, two-factor, once);
    * batch and expiry traceability per line;
    * every movement in the ledger;
    * checkout stays compatible.
* MySQL down after "enforce" fails closed before any charge.
* **Limitation:** an order that arrives only through the Razorpay webhook after its hold expired is committed by the one-minute catch-up after the shop created it. If the stock is gone by then, it appears as an exception on an existing order for staff to settle.
* **Adjustments** use the existing approved adjustment flow (3b.1).

**3b.5 Event sales.**

* **Implemented:**
    * events with their own stock point and staff;
    * counter sale with products and quantities, all-or-nothing;
    * GST from MRP (CGST+SGST or IGST);
    * stock from the event's location, FEFO;
    * gap-free invoice numbers;
    * printable invoice with download, and a signed customer link;
    * WhatsApp invoice through the outbox (needs an approved template name in `WHATSAPP_TEMPLATE_EVENT_INVOICE`) and email;
    * payment methods and status, with later payments;
    * returns by condition with a CR credit;
    * void with refund record;
    * event reports;
    * ledger updates.
* **PDF:** produced by the browser's "Save as PDF". The project has no PDF library, and none could be installed here.

**3b.6 Offline queue.**

* **Implemented:**
    * device queue (IndexedDB buffer, a UUID per operation);
    * automatic sync when the connection returns, plus every 30 s;
    * server idempotency: duplicates, reused ids and other people's ids are refused;
    * conflict-safe stock, because the online services are reused under lock;
    * statuses: pending on the device; applied, duplicate, conflict, failed or retry on the server;
    * admin screen with the exact payload, retry as the original person, and close with a note;
    * nothing is ever deleted.
* **Limitation:** an offline field order for a retailer is confirmed by the retailer's code only after sync. That is the existing field-sales rule.

**N4 B2C customer integration.**

* **Implemented:**
    * central records;
    * existing logins preserved, with no new registration;
    * passwords are never read;
    * linked by normalised email or mobile, with unique keys and no duplicates;
    * conflicts are flagged and never merged;
    * order history across shop, event, B2B and field;
    * contacts masked by permission;
    * idempotent import.

**5. Central inventory.**

* One ledger covers:
    * B2B (company and distributor);
    * the online shop;
    * events;
    * field (as B2B orders);
    * returns, damage and expiry (daily job);
    * approved adjustments;
    * GRN.
* It records location, batch and expiry, reservations, movement history, reconciliation, low-stock alerts (N5 daily alert) and audit.
* It is transaction-safe: no negative stock, and keyed movements prevent duplicates.
* Every movement carries its source reference.
* **Not built:** a *retailer-held* stock point. Stock sold to a retailer leaves the supplying distributor's or company's stock point. Tracking the retailer's own shelf stock (who records it, and sell-through) is a business decision that has not been taken.

**6. N1, N2, N3, N5.**

* Implemented in earlier commits. Their DB-free tests and browser check pass in this run.
* MySQL suites: not run (blocked).
* SMTP (nodemailer) and WhatsApp (Meta Cloud API) are wired through the existing outbox, configured only by environment variables.
* Actual delivery could not be verified here (blocked). Nothing is ever marked "delivered" because a provider merely accepted it.

**7. MySQL everywhere.**

* Migration 019: create table and add index only, with FKs, unique keys and indexes.
* Pinned by SHA-256; history untouched; 016–018 unchanged.
* Pool, transactions, `FOR UPDATE`, parameterised SQL, credentials from env.
* Rollback: restore the pre-migration backup. 019 only adds tables and one index.

**8. Admin.**

* New screens:
    * Online Shop Stock (lines, holds, discrepancies, paid-but-short, catch-up);
    * Events & Counter Sales (with reports);
    * Field & Event Locations;
    * Offline Sync (failed-transaction recovery);
    * All Customers.
* Existing screens cover the ledger and movements, approvals, notifications, reconciliation (System Health), reports and audit.
* All screens call real APIs; there are no demo screens.

**9. Security.**

* RBAC permissions plus the `event_staff` role.
* Refunds need two-factor sign-in.
* Event staff are fenced to their own events.
* Retailer and distributor isolation is unchanged.
* Validation on every write, and the hash-chained audit log.
* Rate limits: Pay 20/min, offline sync 60/min.
* Secrets only in env.
* Invoices and ledger rows are insert-only.

**10. Testing.** See sections 1 and 2. MySQL is **blocked**, and the exact procedure is in `SETUP-AND-TEST-ON-WINDOWS.txt`.

**11. Production safety.**

* There was no production connection, migration, deployment or file change.
* Shop stock stays **off** until two people decide it.
* 013/014 are not included.

**12. Deliverables.**

* This ZIP: source, backend, frontend, migrations, `.env.example` (names only).
* `SETUP-AND-TEST-ON-WINDOWS.txt` (setup, database, migrations, tests).
* `ARCHITECTURE.md` and `API-OPERATIONS.md`.
* Evidence logs.
* This report.
* `docs/phase-1/DEVELOPMENT-LOG.md`.

**13. Strict rules.**

* No TODO or placeholder code in the changed files (scanned).
* No demo data in the application: fixtures exist only in the browser-check harness and are labelled.
* Untested database behaviour is marked NOT RUN throughout.

## 4. Blocked or not built, with the exact reason

| Item | Blocker | Evidence / what unblocks it |
|---|---|---|
| All MySQL 8 suites (14) | No MySQL 8 here; the Docker daemon is down; no network or DNS for packages or images | `evidence/mysql-unavailable.log`, `evidence/clean/mysql-runner-attempt.log` → run Part C on Windows |
| Real SMTP / WhatsApp delivery | No outbound network; credentials must not be shared | Send one test from the Notification Center on a machine with the provider settings |
| WhatsApp event invoice | Needs a Meta-approved utility template | Set `WHATSAPP_TEMPLATE_EVENT_INVOICE` once approved |
| Ledger figures shown on shop product pages | Would change shop files / live B2C behaviour | Your decision; discrepancies are shown instead |
| Retailer-held stock point | No business rule for who records retailer stock | Business decision |
| Embedded street map, native PDF | Needs a library or paid service; package install unavailable | Approve a library; map links and browser PDF work now |

## 5. Changed files (199e6fb → 9c46935, 37 files)

```
M .env.example
A docs/unified/API-OPERATIONS.md
A docs/unified/ARCHITECTURE.md
A docs/unified/SETUP-AND-TEST-ON-WINDOWS.txt
M docs/phase-1/DEVELOPMENT-LOG.md
M erp-web/admin/index.html
A erp-web/admin/operations.js
M erp-web/sales/app.css
M erp-web/sales/app.js
M erp-web/sales/index.html
A erp-web/sales/queue.js
M scripts/run-mysql-tests.js
A src/db/migrations/019_operations_channels.js
A src/db/migrations/sql/019_operations_channels.sql
M src/modules/erp/b2cfeed/readonly-adapter.js
M src/modules/erp/catalog/reference-data.json
M src/modules/erp/core/settings-catalog.json
A src/modules/erp/customers/service.js
A src/modules/erp/events/invoice.js
A src/modules/erp/events/service.js
A src/modules/erp/field/locations.js
M src/modules/erp/index.js
A src/modules/erp/inventory/fefo.js
A src/modules/erp/offline/service.js
A src/modules/erp/routes/customers.js
A src/modules/erp/routes/events.js
A src/modules/erp/routes/locations.js
A src/modules/erp/routes/offline.js
A src/modules/erp/routes/public-invoice.js
A src/modules/erp/routes/shop-stock.js
A src/modules/erp/shopstock/front.js
A src/modules/erp/shopstock/service.js
M src/platform/registry.js
M tests/erp-migrations-guarded.test.js
A tests/operations-channels.mysql.test.js
A tests/operations-channels.test.js
M tests/platform-erp.test.js
```

**Evidence commit:** adds `docs/unified/DELIVERY-REPORT.md` and `docs/unified/evidence/`. It contains logs, screenshots and the browser-check scripts. The scripts expect a Linux path layout and are included as the record of what ran.

## 6. B2C protection evidence

* `node scripts/b2c-guard.js` → "B2C protection OK — 108 protected files unchanged, no business code reaches into B2C". It was run on the working copy after each integration and on the clean clone of the final commit.
* No protected path appears in the changed-files list above.
* With the business platform on and MySQL unreachable, the shop's Pay request was logged by the front layer ("last known: never read") and answered by the shop itself, unchanged.
* The full browser checkout passes in that state and with the platform off.
