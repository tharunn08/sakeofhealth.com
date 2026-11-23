# Phase 1 development log

Branch `phase-1`, starting from `phase-0.5` (`d687112`).

**Without MySQL 8 (D6)**, only the DB-free steps can be done and verified here: 1.1, 1.3, and the DB-free parts of 1.6. All database gates stay open and are reported as NOT RUN. No migration is run, and 013/014 are untouched.

## 1.1 (part 1): production secret minimums, 48 characters, own secret per audience (correction 1)

**Red.** 2 of 6 pass on the code before (`red-1.1.txt`). The 2 passes are guards that development behaviour stays unchanged.

**Green.** 6/6 (`green-1.1.txt`).

**Behaviour:**
- **B2B, production.** `B2B_JWT_SECRET` (or the legacy `JWT_SECRET`) must be at least 48 characters and different from `ADMIN_JWT_SECRET` and `CUSTOMER_JWT_SECRET`. It is no longer derived from `ADMIN_JWT_SECRET`. Otherwise the business portal answers 503 (existing mechanism) and the start-up warning says why. Development and test are unchanged.
- **ERP, production.** `ERP_JWT_SECRET` must be at least 48 characters (was 32) and different from the admin, customer and B2B secrets. Otherwise it answers 503. Development and test keep the 32-character rule, so existing test secrets work.
- Deployment docs updated: `docs/DEPLOYMENT-HOSTINGER.md` and `docs/erp/BUILD-REPORT.md`.
- **Deploy impact:** a production server with B2B enabled but no separate 48-character B2B secret will now refuse business logins until one is set. Per the audit, B2B is not enabled in production today (migrations 004–012 are not applied there), so no current user is affected.

**Suites:** platform-secrets 6/6, erp-isolation 3/3, b2b-isolation 3 + 1 skipped, erp-unit 13/13, b2b-unit 16/16, b2c-regression 20/20, b2c-security 21/21. The guard passes and the build passes.

**Files.**
- Changed: `src/modules/b2b/config.js`, `src/modules/b2b/index.js` (warning text), `src/modules/erp/config.js`, `src/modules/erp/index.js` (warning text), `docs/DEPLOYMENT-HOSTINGER.md`, `docs/erp/BUILD-REPORT.md`.
- Added: `tests/platform-secrets.test.js`, this log.

**Next (1.1 part 2):** migration-runner hardening, DB-free parts first:
- refuse `up` when an applied migration's checksum changed;
- `verify` reports checksum drift and checks every expected table;
- the forbidden-statement guard scans JS migrations as well.

The MySQL runner tests stay NOT RUN until D6.

## Central Admin Panel, increment 1: one shell, one sidebar, one sign-in

**Built (working, tested):**
- **One page registry** (`src/platform/registry.js`): all 22 existing shop and trade admin pages, in the approved sidebar groups (Overview, Sales & Orders, Business Accounts, Customers, Products & Catalogue, Inventory, Finance & Reports, Administration).
- **Clean addresses** `/admin/<group>/<page>`. Every page is built by one route from the registry, using the shared shell (`admin.js`) and its existing page script. Nothing is a placeholder. Old addresses (`/admin/orders.html`, `/admin/b2b/orders.html`) still work and show the same shell.
- **One sidebar** (`GET /api/platform/nav`), built on the server per user from the *same* permission tables the APIs enforce (B2C role matrix + B2B RBAC). The separate hard-coded B2C and B2B menus in `admin.js` are gone. Trade pages appear only when the business platform is on.
- **`/admin`** opens each user's first permitted page: admin and manager → Dashboard, delivery → Deliveries, trade roles → Trade Dashboard.
- **One sign-in, `/login`** (`POST /api/platform/auth/login`):
  - checks staff and shop-customer accounts on the server and returns the workspaces that e-mail and password open;
  - staff → admin panel; customers → their shop account; both → a choice;
  - one generic error for any failure;
  - same rate limit as the admin login;
  - `/admin/index.html` redirects to `/login`, and sign-out and session expiry go to `/login`.

**Tests:**
- `platform-shell` 15/15; red run 0/15 (`evidence/red-shell-1.txt`, `evidence/green-platform-shell.tap.txt`).
- One test checks, for 6 roles × 22 pages, that a page is in the sidebar **exactly** when its API lets that role in (real API calls).

**Browser check** (`evidence/shell_flow.py`, `evidence/browser-shell-results.json`): PASS.
- Desktop and mobile; admin, manager, staff, delivery and the trade `sales` role sign in at `/login` and land on their home page.
- Every sidebar link opens its page, with the right item marked active and no script errors.
- Trade pages run with the business platform on and no database. Their API calls answer 503 by design, and the pages show the platform's own "not ready" message.
- The staff + customer chooser works and stores only the chosen session. The wrong-password message is correct.

**Other suites:** b2c-regression 20, b2c-security 21, b2c-permissions 6, b2c-payments 17, b2c-orders 9, b2c-hardening 14, b2b-isolation 3 + 1 skipped, erp-isolation 3, b2b-unit 16, erp-unit 13, platform-secrets 6. All pass. The guard passes and the build passes.

**Protected files re-pinned** (with reasons in `scripts/b2c-manifest.json` → `repins`): `frontend/admin/admin.js`, `src/server.js`.

**Files.**
- Added: `src/platform/registry.js`, `src/platform/routes.js`, `platform-web/login.html`, `platform-web/login.js`, `platform-web/home.html`, `tests/platform-shell.test.js`, `docs/phase-1/repin-manifest.js`, `docs/phase-1/evidence/*`.
- Changed: `frontend/admin/admin.js`, `src/server.js`, `src/middleware/b2cPermissions.js` (`allows()`), `scripts/b2c-manifest.json`, this log.

**Not yet consolidated:** the ERP admin (`/admin/erp`, 18 views) still has its own sign-in and is not linked from the panel. Its data and staff accounts are in MySQL. Moving those views into this shell needs the unified identity (staff accounts linked across the JSON store and MySQL) and its migration, and that needs a disposable MySQL 8 database to build and test on.

## Central Admin Panel, increment 2: ERP screens and ERP staff in the one panel (2026-11-13)

**Built:**
- **All 18 ERP screens are registered pages of the one shell**, at `/admin/<group>/<page>` and in the one sidebar. They are in the approved groups, plus a new **Procurement & Suppliers** group:
  - Overview: System Health.
  - Sales: Sales Desk.
  - Accounts: Distribution Network.
  - Catalogue: Product Master, Price Lists.
  - Inventory: Stock & Batches, Recalls.
  - Procurement: Manufacturers & Suppliers, Purchasing, Goods Receipt.
  - Finance: Business Finance, Supplier Bills, Collections.
  - Administration: Approvals, Business Decisions, Business Staff & Roles, Audit Log, My Password & 2FA.
- **The screens reuse the existing ERP code** (`erp-web/admin/app.js`, `modules.js`) in a new embedded mode. Inside the shell they draw only their content: no separate menu, no separate sign-in, and links between screens go to shell addresses. `platform-web/erp-host.js` hosts them; `platform-web/erp-embed.css` draws their markup in the shell's design system.
- **One sign-in covers ERP staff** (`src/platform/auth.js`):
  - `/login` checks shop/trade staff, ERP staff (MySQL) and customer accounts on the server.
  - Staff and ERP sessions for the same person form one admin workspace; ERP-only staff use the same panel.
  - Two-factor: the code step is on `/login`. When the staff password opens the panel but the ERP account needs a code, the person can add the code or continue without the business modules.
  - Lockout: a password accepted by another of the person's accounts is not counted against their ERP account. A password wrong everywhere is counted, and a wrong 6-digit code after a correct password is **always** counted.
  - If the database is down, ERP is skipped and shop sign-in still works.
- **The sidebar combines both permission systems** (`/api/platform/nav`): staff role + live ERP permissions (sent as `X-ERP-Token` and read from MySQL like every ERP request). If the database is down, the sidebar says "Business modules unavailable" and shows no ERP links.
- **Safety: the MySQL test helper refuses to run while 013/014 are present** (`tests/helpers/db.js`). It applies every migration file, so the MySQL suites in this working copy would otherwise have executed 013/014. They must run from a clean checkout until D5 is approved.

**Tests** (raw output in `evidence/m2/`):
- `platform-erp` 13/13; red run 0/13 before implementation. It covers:
  - every ERP screen is in the registry with **exactly** the permission its own code declares;
  - the sidebar follows ERP permissions;
  - 7 sign-in cases (both sessions, ERP-only, 2FA, code-after-password, lockout counting, database down, locked);
  - a server run with ERP on and the database down.
- `db-test-safety` 1/1 (red first).
- Every other database-free suite passes.
- `erp-migrations-guarded` 11/12 **in this working copy only**: 013/014 are present here. In a clean clone it passes; see the milestone report.

**Browser** (`evidence/m2/erp_shell.py`, `results.json`, screenshots): PASS.
- **A — real server, database unreachable.** The admin signs in with an ERP session; the sidebar shows the "unavailable" notice and no ERP links; opening an ERP address returns to the dashboard; no script errors.
- **B — layout check only, not real data.** The sidebar is the one the real registry builds for a person holding every ERP permission, and every ERP API call answers an **empty** list (no records invented). All 18 screens draw inside the shell on desktop and mobile, with the right menu item active, no ERP menu or sign-in of their own, and no script errors.

**MySQL tests prepared, NOT RUN:** `tests/erp-federation.mysql.test.js` (3 tests: ERP-only sign-in → ERP sidebar; different shop/ERP passwords do not lock the ERP account; a password wrong everywhere is counted).

**Test changes:** `platform-shell` (from increment 1), three places now limited to the pages a server with ERP off offers. These are my own Phase 1 tests and their checks are unchanged.

**Protected file re-pinned:** `frontend/admin/admin.js` (reason recorded).

**Remaining issues:**
- **Not verified against real ERP data:** the screens with real MySQL data and real ERP staff, 2FA and approvals. This needs MySQL 8.
- **Two staff stores remain:** shop/trade staff in `staff.json` and ERP staff in MySQL, joined at sign-in. Merging them is the unified-identity migration, which needs MySQL 8 and the D5 decision.
- The standalone ERP app at `/admin/erp/` still exists alongside; it is to be retired after the screens are verified with real data. Adding a redirect is a one-line change once you sign off.
- Some screens show their own heading under the shell's title (for example "Manufacturers & Suppliers" above "Vendors"). This is cosmetic.

## Milestone 2a: migration test evidence, D5 tooling, MySQL test runner (2026-11-13)

**Migration-pinning test (`erp-migrations-guarded` #12, "11 !== 9").**
- This is not a test defect. The test requires exactly the nine ERP migrations 004–012. My working copy holds 11 files because the owner's untracked `013_erp_governance.js` and `014_erp_governance.js` sit there (D5).
- Making it pass in the working copy would mean removing those files (needs the D5 decision) or ignoring them (would hide the problem). Neither was done.
- The test now compares the exact file list and **names** any unexpected file in its failure message.
- Result: **passes 12/12 in a clean checkout of the delivered code** and **fails 11/12 in the working copy** while 013/014 are present. Both raw outputs are in `evidence/m2a/`.

**What 013/014 are (read-only check of the files).**
- Each is a 470-byte wrapper that re-runs migration 004's SQL file and operations under a new version number.
- 013 and 014 are byte-identical (BOM, one CRLF line; sha256 `62c731fa…`). They are not copies of 004's file, but applying them repeats 004's work.
- Whether any database recorded them can only be read from that database's `b2b_schema_migrations`.

**Added:**
- **`scripts/d5-inspect.js`**: read-only D5 inspection of one MySQL server.
  - It sets the session READ ONLY, then runs only single SELECTs (enforced; anything else is refused).
  - It lists every database with the migration table and its recorded migrations.
  - It compares each checksum with these files (exact / Unix / Windows line endings) and states "013 applied here: YES/no".
  - The password is typed at a hidden prompt and never printed.
- **`scripts/run-mysql-tests.js`**: runs the 7 MySQL suites against a disposable MySQL 8 database and saves raw TAP plus a summary.
  - **Refuses before connecting** if 013/014 are in the checkout, if the database name is not `*_test`, `*_dev` or `*_local` (the suites wipe it), or under `NODE_ENV=production`.
  - It requires a MySQL 8 server.
- **`tests/ops-tools.test.js`** 7/7: the read-only check, the checksum comparison, the 013/014 detection, the runner's refusals, and the runner stopping in this working copy before connecting.
  - These tests were written together with the tools, not before them.
  - Running either tool against a real server: **NOT RUN** (no MySQL here).

**Files.**
- Added: `scripts/d5-inspect.js`, `scripts/run-mysql-tests.js`, `tests/ops-tools.test.js`, `docs/phase-1/evidence/m2a/*`.
- Changed: `tests/erp-migrations-guarded.test.js` (failure message names unexpected files; same pass/fail rule), this log.

## Milestone 2b: tool safety for running D5 and the MySQL tests on the owner's local MySQL 8 (2026-11-13)

**`scripts/run-mysql-tests.js` refuses to start unless:**
- the database name ends in **`_test`** (`_dev`, `_local`, plain names and look-alikes such as `x_test_backup` are refused);
- `TEST_DB_USER` is set and is not root;
- there are no 013/014 files in the checkout;
- `NODE_ENV` is not production.

After connecting, using only `SELECT VERSION()`, `SHOW GRANTS` and `information_schema`, it also requires:
- MySQL 8;
- an account with **no privilege outside the test database** (any global, other-database or role grant is refused);
- a test database holding **only `b2b_*` tables**, i.e. a dedicated one.

Other behaviour:
- Inherited `DB_*` and `TEST_FRESH_DB_NAME` settings are removed before the suites start.
- The password is asked at a hidden prompt, passed only to the suites, and masked in the saved output.

**`tests/helpers/db.js`:** the test suites themselves now only reset a database named `*_test`.

**`scripts/d5-inspect.js`:**
- **New: reports databases that contain this project's tables (`b2b_*`, with the ERP core tables counted) but no `b2b_schema_migrations`**, i.e. tables created outside the migration runner.
- Restructured so the read-only rules can be tested end to end on a recording stand-in for the database.
- The `b2b_` pattern now uses `ESCAPE '!'`, so it works under `NO_BACKSLASH_ESCAPES` too.
- It still sets the session READ ONLY first and runs only single SELECTs. It reads only server facts, `information_schema.TABLES` names/counts and the migration table: no business data.

**Tests:** `tests/ops-tools.test.js` 14/14. Against the previous scripts (`31aa214`): 5 pass, 9 fail (`baseline/red-ops-tools-v2.txt`). The tests check:
- read-only (READ ONLY first; every statement is a SELECT; the tables read are only information_schema/migration);
- the password reaches only the driver and never the report or console;
- the no-migration-table finding;
- `_test`-only naming;
- refusal of root, production and 013/014;
- refusal of every kind of extra privilege;
- MySQL 8 only;
- refusal of a non-dedicated database;
- inherited `DB_*` removed;
- the helper refusing a `_dev` database before connecting.

**Not run:** both tools against a real server. That is the owner's local run; commands are in `RUN-ON-WINDOWS.txt`.

## Milestone 2c: D5 inspection with least privilege (2026-11-13)

**Problem found by the owner:** the Milestone 2b instructions granted the D5 account `SELECT ON *.*`, i.e. read access to every table on the server, including business data. That was wrong and is withdrawn.

**New approach. No account gets a global privilege:**
1. **Inventory, as root:** `scripts/d5/inventory.sql` reads only `information_schema.TABLES` (table names and counts). It lists every database containing this project's tables, whether it has `b2b_schema_migrations`, and how many ERP core tables it has. This also answers "project tables without a migration table". Root already has every right, so this creates no new access.
2. **Grants:** `node scripts/d5-inspect.js grants --inventory …` writes one statement per database that has the migration table: `GRANT SELECT ON <db>.b2b_schema_migrations TO 'soh_d5'@'127.0.0.1'`. There is no global privilege, no `SHOW DATABASES`, no database-wide grant and no other table. The owner reviews the file before applying it.
3. **Inspect, as `soh_d5`:** the script first sets the session READ ONLY and reads its own grants. It **stops before reading anything** if the account holds anything beyond `USAGE` plus SELECT on migration-history tables (global SELECT, `SHOW DATABASES`, database-wide or other-table grants, extra privileges on the migration table, roles). It then reads only server version/settings and those migration tables.
4. `DROP USER 'soh_d5'@'127.0.0.1'` at the end removes all of its grants.

**What `soh_d5` can read:** only the rows of `b2b_schema_migrations` in the databases listed in the reviewed grant file (version, file name, checksum, applied date, duration). MySQL itself prevents anything else.

**Test account:** unchanged. `soh_test` holds ALL on `sakeofhealth_test.*` only, and the runner refuses any wider right.

**Instructions** now live in the repository (`docs/phase-1/RUN-ON-WINDOWS.txt`) so tests can check them. They handle Windows details: PowerShell's UTF-16 output, and a grant file written by the script itself without a BOM.

**Tests:** `tests/ops-tools.test.js` 19/19 (12 for D5, 7 for the runner). They cover:
- generated grants are only table-level SELECT on `b2b_schema_migrations` (backtick-escaped; control characters refused);
- every wider grant is refused, including `SELECT ON *.*`;
- with global SELECT the script stops after `SHOW GRANTS`, having sent exactly two statements;
- with narrow grants every query reads only migration tables, and databases without one are not queried;
- the inventory SQL reads only `information_schema.TABLES`;
- the instruction file contains no `ON *.*` grant, the test account only on `sakeofhealth_test`, and the D5 account only via the generated form;
- the password never reaches the report, the console or a file;
- UTF-16 and UTF-8 inventory files are read correctly.

**Red runs:**
- Against the previous scripts the test file fails to load (missing functions).
- With the new code and the **old** instructions, the instruction test fails on exactly `GRANT SELECT ON *.* TO 'soh_d5'@'127.0.0.1';` (`baseline/red-d5-least-privilege.txt`).

**Not run:** against a real MySQL server. That is the owner's local run.

## Milestone 3a — shared identity: initial role accounts, forced first password change (2026-11-13)

Owner instruction: "Complete the Entire Unified Platform", step 2 (identity) and the 15 initial role accounts.

**Step A (6cc2e5e):** migration 015 adds `must_change_password` to `b2b_staff`, `b2b_users` and `b2b_vendor_users` (addColumn OPS only; its SQL file is comments only). It also adds the ERP role `quality_control`, built from existing permissions only.

**Steps B+C (this commit):**
- **One sign-in, five stores:** `/login` now also opens business (retailer/distributor) and supplier accounts, and the field-sales app for salesmen. Each session is stored where its app already looks for it. The lockout rule extends to all three MySQL stores: if any store accepts the password, none of them counts a failure; if no store accepts it, each counts exactly one.
- **Forced change:** any account flagged with a temporary password is refused (`403 password_change_required`) until the password is changed. This covers ERP, business portal, supplier portal, field sales, and shop/trade admin (`src/platform/guards.js` on `/api/admin`). Only "who am I" stays open.
- **Change password:** `POST /api/platform/auth/change-password` changes the password in every store that accepts the current one. It rejects new passwords under 12 characters, without letters and a number, or equal to the current one. It ends old sessions (token_version) and clears the flag. The same rate limit as sign-in applies. `/login` shows the box after a temporary-password sign-in and also offers "change my password" at any time.
- **Seed tool:** `scripts/seed-accounts.js` creates the 15 role accounts:
  - temporary passwords are random, 20 characters, all distinct, and not stored in the code;
  - it never overwrites an existing account, so re-running is safe;
  - the shop-staff JSON records are written only after the database transaction commits;
  - it refuses: production, a DB name not ending `_local`, root, the default or non-empty shop data folder, and 013/014 being present;
  - the report is saved outside the project folder and readable only by the owner; `local-credentials-*.txt` is git-ignored;
  - supplier and business records are marked "LOCAL TEST — not a real business".
- **Bug found by the new tests:** with a broken random source, `passwordsFor` looped forever. It now stops with an error after 50 repeats.
- **Protected file:** `src/server.js` gained two lines (the guard mount and the rate limit). It was re-pinned with its reason through `docs/phase-1/repin-manifest.js`.

**Tests run:**
- `tests/identity-seed.test.js`: 11 tests, all pass, including a real server walking the whole forced-change flow. Against 6cc2e5e, with only the tests and the seed tool copied in, the 6 behaviour tests fail.
- Browser check `checks/first_login.py` (desktop + mobile + voluntary change): PASS.
- Earlier browser checks `shell_flow.py` and `erp_shell.py`: PASS.

**Not run (needs MySQL 8):** `tests/identity-seed.mysql.test.js`. It covers:
- seeding the 15 accounts;
- each signing in at `/login`;
- the block on every app until the change;
- the change in every store;
- re-seeding leaving everything unchanged;
- role isolation.

The owner's local trial steps are in `docs/phase-1/LOCAL-TRIAL-ON-WINDOWS.txt`. The credentials are generated on the owner's computer when the seed runs; none exist anywhere else.

## N1 — notification reliability (2026-11-16)

Owner instruction: "APPROVED IMPLEMENTATION INSTRUCTIONS — NOTIFICATION CENTER" (decisions D1–D10). N1 first; N2 after inventory 3b.1.

- **Defect fixed:** with no SMTP/WhatsApp provider configured the shop sender logs the message and answers "ok" (`mock: true`). The outbox recorded those rows as `sent`. Now they are `skipped_no_provider`, with the reason; nothing counts as sent unless a provider took it.
- **Provider ids:** the SMTP message id is stored (the outbox previously read a field the shop sender never returns). MSG91 request ids as before. WhatsApp ids are not available without changing the protected `notify.js` (D2: not changed), so WhatsApp stays "Accepted by provider".
- **WhatsApp templates:** queued template name and parameters are now passed to the shop sender, which sends an approved Meta template (`WHATSAPP_TEMPLATE_<NAME>` maps a logical name to the Meta name). Field-sales WhatsApp codes now carry their parameter.
- **Failures:**
    - Meta's permanent errors (template missing or unapproved, invalid token, number not allowed) fail at once, without retries.
    - A missing or invalid address becomes `skipped_no_contact`.
    - Back-off (1, 5, 30, 120 min, 4 attempts) is unchanged.
- **Never backwards:** every status change requires the row to still be `sending`, and history is written only when the row really changed. A test caught a late answer writing a history entry; fixed before commit.
- **Append-only history:** new `b2b_notification_events` (migration 016), written by the worker, the admin retry and both delivery-report webhooks. The outbox works unchanged before 016 is applied.
- **Retry controls (D10):**
    - Per-message Retry and History in B2B Settings → Notifications.
    - Retry-all kept.
    - Both audited; one-time codes never re-sent; sent rows never reset.
- **Migration 016_notification_center:** additive, with eight new tables (history, plus the N2/N3 tables: messages, recipients, sends, templates, consent, groups and members) and three nullable queue columns plus two statuses. Numbering: notifications take 016, because N1 lands first; the planned inventory migration becomes 017 and event sales 018.
- **Test corrected:** `b2b-platform` "notifications are queued…" expected mocked messages to count as sent. It now expects `skipped_no_provider` with history. This is a correction, not a relaxation.
- **Tests:**
    - `tests/notifications-reliability.test.js`: 11, run here, pass. The real outbox runs against an in-memory queue and local fake SMTP / Meta / MSG91 servers. All 11 fail on 58bd369.
    - `tests/notifications-reliability.mysql.test.js`: 6, MySQL 8, NOT RUN here (no MySQL in this workspace).
- **Docs:** `.env.example` (template mappings, webhook secrets, MSG91), `docs/phase-1/API-NOTIFICATIONS.md`.

## Milestone 3b.1 — one ledger, duplicate-proof movements, warehouse restriction, approved adjustments (2026-11-16)

Owner: decisions 1–5 recorded 14 Nov; sequence N1 → 3b.1 → N2 (16 Nov instructions).

- **One write path:** the B2B module's `move` now delegates to `erp/inventory/ledger.js`. A test proves that no other file writes `b2b_stock` or `b2b_stock_movements`.
- **Duplicate-proof keys:**
    - `idem_key` with a unique index (migration 017).
    - Keyed: goods receipts, transfers, dispositions, adjustments.
    - A replay is refused and stops the whole action, batch updates included.
    - B2B order steps stay protected by their order state machine.
- **Warehouse restriction:** B2B orders are filled only from owner-less `company` warehouses. Note: distributor warehouses created after migration 008 also default to type `company`, so the owner check is kept.
- **Decision 5:**
    - With the ERP enabled, direct company stock entry is refused (409 `use_adjustment`).
    - Adjustments and opening balances are proposed under Inventory and posted after a second person approves.
    - Distributors' portal entry is unchanged until M7.
    - New permission `inventory.adjust.propose`; the Stock screen gains an Adjustments section.
- **Silent drift removed:** a distributor return whose stock move is refused is now recorded in the audit log (`return.distributor_stock_short`) instead of being ignored.
- **Migration 017_inventory_ledger:**
    - additive: `idem_key`, warehouse types `event`/`salesman`, movement types `counter_sale`/`counter_return`, `b2b_salesmen.stock_warehouse_id`, a unique `b2c_ref`, and tables `b2b_stock_reservations` and `b2b_stock_adjustments`;
    - a pre-check refuses, before any change, if two products claim one shop product;
    - renumbered from the plan's 016, because N1 took 016.
- **Tests:**
    - `tests/inventory-ledger.test.js`: 11, run here, pass; 10 of them fail on 74a6345.
    - `tests/inventory-ledger.mysql.test.js`: 7, MySQL 8, NOT RUN here.

## N2 — Notification center in /admin (2026-11-16)

Owner instructions of 16 Nov (D1–D10). This step follows 3b.1, as the approved sequence requires.

- **Screen:**
    - Administration → Notifications, inside the one `/admin` shell, with five tabs: Overview, Compose, History, Templates, Consent.
    - Consent shows what arrives in N3; it does not pretend to work yet.
    - The detail view shows the original message, the recipients, every send and every attempt with its status history, provider reference and error.
    - Resend is always enabled. It takes a subset of recipients, an optional edit and confirmation of changed contacts. One press sends once.
- **Code:**
    - `src/modules/erp/notifications/{directory,service,templates}.js` and `src/modules/erp/routes/notifications.js`.
    - The N1 outbox and worker do all sending. MSG91 accepts `dlt:<id>` template references.
- **Permissions:**
    - 10 `notifications.*` permissions. Only approving a promotional send needs two-factor sign-in, under the existing `.approve` rule.
    - My first draft marked three permissions "sensitive" without matching the two-factor rule. The existing check `erp-unit` caught it, and I fixed the permissions, not the test.
- **Setting:** `notifications.limits`, with the D5 values as the default.
- **Test changes:**
    - `platform-erp`: the registry test now expects 19 ERP screens instead of 18, because Notifications is the 19th. Every per-screen permission and address check is unchanged.
- **Bug found while writing the API documentation, then fixed:**
    - A repeated key reported the message's latest send instead of the send that key made.
    - Two presses racing past the check got a 500 from the unique index instead of the first result.
    - Fix: one `replay()` helper. It is also used when the unique index refuses a racing press. A key used for another message is refused (409 `request_key_reused`).
    - A stubbed-connection test fails without the fix and passes with it. The MySQL double-click test now also requires both presses to answer 201 with the same send.
- **Second bug, found the same way (D3):**
    - The changed-contact confirmation always masked both sides. A mobile changed only in its middle digits showed as `98•••••011` before and after.
    - The MySQL test had accepted identical masked values; it now requires the `(changed)` mark.
    - People with `contacts.view` now see full old and new details, and the MySQL test checks that too.
- **Tests:**
    - `tests/notifications-center.test.js`: 11, run here, pass. They fail on 0c6efc5, where the module is missing.
    - `tests/notifications-center.mysql.test.js`: 8, MySQL 8, NOT RUN here.
- **Browser check (Playwright, desktop and mobile):** passes. API answers came from labelled TEST FIXTURES, so this checks screen behaviour only, not data. It covers:
    - double-pressing Send or Resend sends one request;
    - a new press uses a new key, while confirming a changed contact keeps the same key;
    - changed contacts are shown;
    - the preview warns when a recipient has no email.

## N3 — consent, opt-out, promotional approval, groups, provider throughput (2026-11-16)

Owner decisions D4, D5 and D8 (16 Nov). No new migration: the tables were created in 016.

- **One gate:** the outbox worker checks consent for every row just before sending, so the rule holds for every path. Blocked rows become `skipped_opt_out` and are never retried. A lookup error retries the row later instead of sending it (fail closed).
- **Consent:**
    - `erp/notifications/consent.js`: per channel and per hashed address; promotional opt-in or opt-out; "stop all" (codes still go).
    - Recorded from four places: the business portal (account's own choice), staff with evidence, the signed unsubscribe link (the page needs a button press), and WhatsApp STOP/START replies (each processed once).
    - Every change is audited with the address masked.
- **Promotions:**
    - Business accounts only, email or WhatsApp (not SMS), and WhatsApp only with a template recorded as promotional.
    - Each promotional email carries a personal unsubscribe link.
    - More than the threshold waits for approval through the existing approvals engine (`notifications.promotional.approve`, two-factor, not the writer). The send is queued only on approval; rejection or withdrawal closes the message.
- **Approvals engine:** two small opt-in additions, with existing types unchanged.
    - A type may name its approver permission while no rule is configured. Otherwise the Super Admin fail-safe still applies.
    - A type may register a hook for rejection or withdrawal.
- **ERP audit:** an actor of type `business` was recorded as `admin`. It is now recorded as `business`. No existing ERP code wrote business actors.
- **Groups:** fixed lists, or rules evaluated at send time; `groups` in send and preview; audience permissions per type.
- **Throughput:** the per-channel per-minute limit is the setting `notifications.provider_rates`, pending a business decision with defaults 30/60/60. Waiting rows keep their attempts.
- **Screens:**
    - Compose gains the promotional category (SMS switched off, promotional templates only), saved groups, a server preview with consent counts and an approval warning, and the approval result.
    - The Consent & groups tab records consent and opt-outs, lists preferences, manages groups, and lists promotions waiting for approval.
    - Message detail shows approval state per send.
    - The business portal Profile gains "Offers and promotions".
- **My own rule kept:** a send row is changed only in its counts. The approval outcome lives in the approval record and the audit log, not in the send's note. The N2 test caught my first attempt.
- **Test harness:**
    - The in-memory database in `notifications-reliability.test.js` now models the per-channel claim and the per-minute count. Its 11 N1 tests are unchanged and pass.
    - Because the harness models the new claim, the updated file cannot run against the old code.
- **Tests (run here):**
    - `notifications-consent.test.js`: 11 pass. The file fails on 482ae29.
    - `notifications-reliability.test.js`: 4 new tests pass. They fail on 482ae29.
    - `notifications-center.test.js`: the isolation test now also scans the consent, groups and public-page files.
- **Tests (not run here):** `notifications-consent.mysql.test.js`, 8, MySQL 8, NOT RUN here. One case waits 61 s, so that the throughput limit is measured on a clean minute.
- **Browser check (fixtures, desktop and mobile):** passes. It covers SMS off for promotions, promotional templates only, preview consent and approval warning, the held result, the send body (category, group, reason), the consent list, groups and "not yours to change", and the consent record body.

## N5 — automatic notifications in the history, missing triggers (2026-11-16)

- **Single integration point:**
    - `notifyAccount` and `notifyAdmins` write one `b2b_messages` record per event (origin workflow), its recipients and send #1, in the same transaction as the business change. The queued rows point at them.
    - Field-sales codes now go through the outbox (`queueCode`) instead of a direct INSERT. They gain the "queued" history row, and the record never holds the code.
    - Only the outbox writes the queue, and a test enforces it.
- **New triggers:**
    - Payment received, in the single place a payment is applied.
    - Password changed and password reset by an administrator: email only, and non-blocking.
    - Daily stock alert to the admin alert emails: a read-only job, deduplicated per day.
    - Invoices are announced in the existing dispatched and delivered messages, so there is no duplicate trigger.
- **Resend of automatic messages:**
    - The original email HTML and WhatsApp text are reused, and the event is never repeated.
    - Alert addresses need `notifications.send.staff`.
    - One-time codes are refused (`otp_never_resent`), and the screen explains it.
- **Migration 018** (draft): one enum extension, `'address'` recipients. Planned event sales move to 019.
- **Compatibility:** without 016, and for alert emails without 018, nothing changes. A cached `information_schema` probe decides this, and no partial records are written.
- **Hot row:** the MSG number is taken inside the business transaction (gap-free numbering, row lock on `b2b_sequences`). Notifying transactions therefore queue briefly on that row. Deadlocks are retried by `db.transaction`.
- **Test changes:**
    - `notifications-reliability`: the outbox isolation test now lists the three message tables the outbox inserts into, and also checks that it never updates or deletes them.
- **Tests:**
    - `notifications-reliability.test.js`: 4 new N5 tests, run, pass.
    - `notifications-workflow.test.js`: 5, run, pass.
    - `notifications-workflow.mysql.test.js`: 4, MySQL 8, NOT RUN here.

## Unified platform — operations channels, N4, central ledger for all channels (2026-11-16)

- **Inspected first:**
    - Commits up to 199e6fb; migrations 016–018 re-read and left unchanged.
    - Draft files found in the working copy, of unknown origin and created after 199e6fb: 019 SQL and migration, `field/locations.js`, `customers/service.js`, reference-data permissions. They were reviewed, corrected and kept.
    - `b2b_b2c_stock_publish` was removed, because publishing figures into the shop would mean writing shop files. `b2b_b2c_order_stock` was added in its place.
- **Migration 019** (draft, SHA re-pinned): location pings, events and staff, counter sales, items, payments and returns, offline ops, shop exceptions, discrepancies and order-stock lines, central customers, links and orders, and one index on reservations. Create and add-index only.
- **3b.3 / 3b.4 online shop stock:**
    - `shopstock/front.js` registers two handlers before the protected shop routers, and `shopstock/service.js` does the work. Modes are off, shadow and enforce; each is a business decision, and while unset the shop behaves exactly as before.
    - **Pay:** holds the units, and in enforce mode refuses with the shop's own wording, or fails closed with a 503 before any charge.
    - **Order:** commits FEFO before the shop creates the order. If paid but short, no order is created, and an exception waits for a refund (two-factor) or the approved automatic refund.
    - **Every minute, a catch-up job:** webhook-path orders, sold / released / returned by shop status, and discrepancies.
    - **Pay has its own rate limit** (20/min).
- **FEFO:** `inventory/fefo.js` never picks expired batches, and batch-less units are taken only when they really exist. A daily `inventory.expire_batches` job runs, keyed per batch and day.
- **3b.5 events:**
    - Each event has its own stock point.
    - Counter sale: UUID key, all-or-nothing, an invoice line per batch, MRP-inclusive GST (CGST+SGST / IGST), and a gap-free invoice number.
    - Payments, returns by condition with a CR credit, void with refund, and reports.
    - Invoices: printable HTML, plus a signed public link sent by WhatsApp template and email through the existing outbox.
- **3b.2 locations:** only sent fixes are stored (no background tracking); event and salesman filters, a map (SVG with an "Open map" link), attendance, and visit / transaction references.
- **3b.6 offline:**
    - **Device:** an IndexedDB queue (`erp-web/sales/queue.js`) as a buffer only.
    - **Server:** `b2b_offline_ops`; the same services as online. Outcomes: duplicate, op_reused, op_not_yours, conflict kept for staff; admin retry as the original person, or close with a note. Never deleted.
- **N4 customers:** central records linked by normalised email or mobile. Conflicts are flagged and never merged. The import is idempotent and read-only, and never reads passwords. Shop logins are unchanged.
- **Admin:** 5 screens in the one sidebar (`erp-web/admin/operations.js`), so the registry now has 24 ERP screens. The field app gains My events, the counter, and the queue panel.
- **Test changes:**
    - `platform-erp.test.js` expects 24 screens and reads `operations.js`; per-screen checks are unchanged.
    - `erp-migrations-guarded.test.js` lists 019.
- **Tests:**
    - `operations-channels.test.js`: 18, run, pass. All 18 fail on 199e6fb.
    - `operations-channels.mysql.test.js`: 14, MySQL 8, NOT RUN here. MySQL is unavailable: no server, the Docker daemon is down, and the network and DNS are blocked.
    - Browser check (fixtures, desktop and mobile, plus the field app offline → online): passes.
- **Bugs found and fixed while building:**
    - The commit coverage check.
    - Unstable advance keys.
    - Abandoned shadow checkouts held forever.
    - Expired units saleable as "no batch".
    - The shop rate limiter bypassed.
    - A wrong token accessor.
    - The KPI tiles class.
- **Found in clean-clone verification and fixed:** `shopstock.config()` turned a MySQL read error into "off", so enforcement silently stopped during an outage. The fail-closed branch was reachable only with a stub.
    - Now the error propagates.
    - The front layer fails closed only if it last read `enforce`; otherwise the shop works as today. The mode is read at start, every minute and on each Pay.
    - Test: behavioural, and it fails on 0b7c3f8.
    - Browser checkout with ERP on and MySQL down: passes.

## Complete-build package (2026-11-18)

- `scripts/run-all-tests.js` and `RUN-ALL-TESTS.cmd` run every check in one go: the guard, the build, the syntax check, the database-free tests, the shop regression tests and, with `--mysql`, the MySQL 8 suites. Results are written to `test-results/<time>/SUMMARY.txt`.
    - The exit code is non-zero when any step fails.
    - When the MySQL suites are not run, the summary says so.
- `START-HERE.txt` is the entry point.
- The ZIP includes `node_modules`: 10 dependencies, all plain JavaScript with no compiled parts, so it works on Windows without a download.
- The MySQL 8 suites are still NOT RUN here, because no server is available.

## Manufacturers, manufacturing and delivery (2026-11-18)

- **Requirement:** the owner reported that the manufacturer and delivery sections had not been built. The requirement documents were checked:
    - the platform audit §5 and the screen list (Manufacturing & Quality, Delivery Challans);
    - Phase 1 §4;
    - the complete-platform brief C and G.
- **What already existed and was reused:** vendors with capabilities, document review, product and price submission and approval, POs, ASN, GRN, QC at receipt, lots, recalls, and the order flow with statuses.
- **Migration 020** (guarded, SHA-pinned):
    - 11 new tables;
    - `b2b_products.item_kind`;
    - `b2b_asns.delay_alerted_at`;
    - enum extensions, each keeping the existing values first: capability `contract_manufacturer`, movement `production_issue`, offline kind `delivery`.
- **Manufacturing** (`manufacturing/service.js`, routes `/api/erp/manufacturing`):
    - facilities, versioned bills of materials (a second person activates, with two-factor), and contract and in-house manufacturing orders;
    - FEFO material issue with an idempotency key; output to quarantine; QC that needs a CoA, is done by a different person, and releases to available or rejects to damaged;
    - a contract ASN may carry only released batches, up to the released quantity, with the canonical batch number and dates;
    - manufacturer performance computed from POs, GRNs, QC and ASNs;
    - late manufacturer deliveries are alerted once.
- **Manufacturer workspace** (supplier portal):
    - manufacturing orders: accept or decline, production updates, batches with a CoA upload;
    - deliveries to us, invoices and payments;
    - own products with their latest price, and price submission;
    - profile and contact editing (legal identity locked).
- **Delivery** (`delivery/service.js`, routes `/api/erp/deliveries`):
    - one shipment per order (vehicle, driver or delivery staff, courier, tracking, LR, e-way bill);
    - dispatch, out for delivery, failed attempt (buyer notified), delivered with proof (multipart; short deliveries give a credit note through the existing flow), and back to warehouse;
    - every step calls `orders.transition`;
    - a challan snapshot at dispatch;
    - an after-commit hook (`orders.onTransition`) and a 10-minute catch-up; the order view is extended through `orders.extendDetail`;
    - late shipments are alerted once.
- **Order flow:**
    - new edge: dispatched / out_for_delivery → returned (fulfilment or seller, with a reason);
    - `inventory.returnUndelivered` is keyed per allocation, and batch figures follow only a real posting.
- **Screens:**
    - 5 admin screens; a new sidebar group, Manufacturing & Quality (29 ERP screens in total);
    - field app: My deliveries, offline-capable;
    - trade portal: shipment card, distributor delivery details, challan, and a "could not deliver" action;
    - the trade-orders admin page asks for a reason when goods come back.
- **Permissions:** `manufacturing.*` and `deliveries.*`; new role `delivery_staff`; QC release belongs to quality control only.
- **Settings:** `manufacturing.own_manufacturer_vendor_id`, `delivery.eway_bill_required_above`, `delivery.max_attempts` and `delivery.delay_alert_hours`, all pending decision.
- **Bugs found and fixed:**
    - The settings validator did not recognise the types of 3 earlier decisions (shop stock mode, warehouse, hold minutes), so they could never be set. Fixed, and a test now checks that every catalogue proposal validates.
    - The new tabbed screens did not open their first tab.
    - The field app would have stopped completely if the deliveries list failed (e.g. before migration 020); that list is now optional.
- **Tests:**
    - `manufacturing-delivery.test.js`: 21, DB-free, pass. Mutation checks: 12 deliberate defects, all caught.
    - `manufacturing-delivery.mysql.test.js`: 8, MySQL 8, NOT RUN here.
    - Browser check `mfg_ui.py`: pass on desktop and mobile.

## 2026-11-18 (2) — permanent products, suppliers & manufacturers, salesmen, delivery group, admin menu

- **Permanent products:**
    - New `src/services/catalogueGuard.js` and `src/catalogue/core-products.json` (the four products with the product pages' names and prices).
    - `server.js` calls the guard at start.
    - Admin refuses to delete a core product.
    - Snapshots and daily backups are kept outside the site folder; restore order: whole-folder backup → product snapshot → core file; missing core products are put back.
    - Tests: `catalogue-guard.test.js` (8).
    - BUG-008 test updated: production with an empty folder now shows the four real products, still no demo data or staff.
- **Manufacturers & Suppliers:**
    - Full admin record in `erp-web/admin/people.js`; it replaces the old screen in `modules.js`.
    - Staff add a business with its owner's sign-in (temporary password, must change), or by invitation.
    - Addresses, team sign-ins, capability decisions and audited staff edits.
    - Vendor portal: richer registration, addresses, bank accounts, team, capability requests; `/login` links.
    - Fixes: the invite link path, invited vendors had no capabilities, bank maker-checker matched the wrong audit rows, re-verifying a verified account.
- **Salesmen:**
    - `sales/team.js`: list, detail, update (cash-in-hand rule), lookups, and the salesman dashboard.
    - New admin screen; field-app "My day"; the Sales Desk uses pickers.
- **Delivery:** new sidebar group (dashboard, shop deliveries, trade deliveries, staff) and `GET /api/erp/deliveries/summary`.
- **Admin menu:** keeps its scroll position between pages (`frontend/admin/admin.js`).
- **Protected files changed (requested):**
    - `src/server.js`, `src/routes/admin.js`, `frontend/admin/admin.js`.
    - Manifest re-pinned with reasons.
- **Tests:**
    - `suppliers-salesmen-delivery.test.js`: 14, DB-free, pass.
    - `suppliers-salesmen-delivery.mysql.test.js`: 5, NOT RUN here (no MySQL 8).
    - Browser check `people_ui.py`: pass on desktop and mobile; earlier checks re-run, all pass.
