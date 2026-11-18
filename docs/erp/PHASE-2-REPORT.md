# Phase 2: Foundation (governance core). Build report

> Superseded by `BUILD-REPORT.md` (phases 2–12). Running on a real engine later fixed three Phase 2 bugs: lockout fired one attempt early; error codes did not reach screens; ids from URLs were clamped instead of refused.

Status: **built, not yet verified against MySQL.** Every test that runs without a database passes. The MySQL integration suite is written but has **not** been run, because no MySQL server is available in the build environment. Do not treat Phase 2 as accepted until you have run the command in §7 and the results come back clean.

Nothing has been deployed, no production database has been touched, and no B2C file has been changed. The guard confirms this: 108 protected files are byte-for-byte unchanged.

## 1. What this phase adds

| Area | What works now |
|---|---|
| Staff identity | A separate staff login at `/admin/erp`, with scrypt passwords of 12 or more characters. Unknown e-mail and wrong password return the same message. The account locks for 15 minutes after 5 failures. Sessions last 8 hours (configurable 1–24). Tokens are header-only, so cookies give no CSRF route in. |
| Session revocation | Disabling a person, changing their roles, changing their password or enrolling MFA ends their existing sessions straight away, because a `token_version` check runs on every request. |
| Two-factor (TOTP) | Any authenticator app works (RFC 6238, tested against the reference vectors). The secret is AES-256-GCM encrypted at rest. MFA is **required** to approve, publish, pay, edit roles or change settings. |
| Roles and permissions | 69 permissions and 13 system roles, loaded only by an explicit, confirmed command. Scopes can be set per grant (all, territory, warehouse or state). Every route checks permissions on the server. |
| Maker-checker approvals | One engine is used by every later module. The requester can never approve their own request. Each approver decides once, and approving needs MFA. Duplicate open requests are refused with 409. **No approval thresholds are configured,** so every approval falls back to Super Admin only (the fail-safe in D7). |
| Business decisions | 18 settings with **no code defaults**: shelf life, HSN on invoices, GST treatment, pricing tiers, thresholds, OTP rules and others. Each one stays `pending_business_decision` until someone proposes a value and a second person approves it. Until then, each feature that depends on it uses its documented fail-safe. |
| Audit log | Every ERP action writes old value, new value, reason, approval id, IP and user agent. ERP rows are hash-chained, so `/audit/verify` finds an edited or deleted row. A daily job re-checks the chain. There is no route that updates or deletes audit rows. |
| Monitoring | Failed logins, failed jobs, WhatsApp failures and a broken audit chain all raise events. A summary page shows database, queue, jobs, last backup and migrations. |
| Background jobs | A database-backed queue with a dedupe key, a safe claim across several processes, back-off retries (4ⁿ minutes) and a monitoring event when a job finally fails. |
| WhatsApp webhook | `GET` handshake with the verify token. `POST` checks the **HMAC-SHA256 over the raw body** (`X-Hub-Signature-256`). Replays are stored once and ignored. A delivery status never moves backwards. |
| Admin screen | Sign-in with TOTP, plus Overview, Approvals, Business decisions, Staff and roles, Audit log and My account. Text is rendered with `textContent` only. |

ERP is **off** unless both `B2B_ENABLED=true` and `ERP_ENABLED=true`. With ERP off, no ERP route, page or webhook exists.

## 2. Files

New:
- `src/modules/erp/**`: config, core (security, identity, audit, approvals, settings, staff, jobs, monitor, webhooks), routes, the catalog (reference data and loader), and index
- `erp-web/admin/` (index.html, app.css, app.js)
- `src/db/migrations/004_core_governance.js`, `sql/004_core_governance.sql` (SHA-pinned), `lib/guarded.js`
- `scripts/b2c-guard.js`, `scripts/b2c-manifest.json`, `scripts/erp-reference-data.js`, `scripts/erp-create-admin.js`
- `tests/erp-unit.test.js`, `tests/erp-isolation.test.js`, `tests/erp-foundation.test.js`

Changed (additive only):
- `src/modules/b2b/index.js`: three one-line hooks that call the ERP module (mountEarly, mount, boot)
- `scripts/build.js`: step 7 runs the B2C guard
- `.gitignore`: makes sure the migration SQL files are committed

`package.json` was **not** changed, because it is on the B2C-protected list (the guard refused the change). That is why the commands below call `node` directly rather than `npm run`.

## 3. Migration 004

The migration adds 12 new tables: staff, roles, permissions, role_permissions, staff_roles, approval_requests, approval_steps, approval_rules, jobs, integration_logs, monitor_events and webhook_events.

It also makes 15 guarded changes to existing tables:
- **`b2b_audit_logs`** gets new nullable columns: module, reason, approval_id, session_id, user_agent, prev_hash and row_hash.
- **`b2b_notification_queue`** gets template_name, template_params_json, provider_message_id and delivery_status. Its status enum gains the value `skipped_no_provider`, and a new index is added.

The safety rules are as follows:
- The SQL contains no `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `INSERT` or `RENAME`, and a unit test enforces this.
- Every guarded change checks `information_schema` first. It skips the change if it is already applied, and **refuses** if the live column differs from what was expected.
- Running it a second time applies 0 changes.

Note: until `npm run migrate` has been run, the existing B2B start-up check reports "schema incomplete". This is the existing behaviour for any pending migration.

## 4. API (`/api/erp/core`)

| Route | Who may call it |
|---|---|
| `POST login` | Anyone (rate-limited: 10 per 15 minutes) |
| `GET me`, `POST me/password`, `me/mfa/setup`, `me/mfa/enable`, `approvals/:id/withdraw` (own request only), `GET jobs/:id` (own job, or `core.jobs.view`) | Any signed-in staff member |
| `GET staff` / `POST staff` / `PATCH staff/:id` | core.staff.view / create / edit. Disabling takes effect immediately; re-enabling goes to approval. |
| `GET roles`, `POST roles`, `PUT roles/:id/permissions`, `POST staff/:id/roles`, `POST staff/:id/roles/:grantId/revoke` | core.roles.view / edit. Permission changes and grants go to approval; revoking is immediate. |
| `GET approvals`, `POST approvals/:id/decide` | core.approvals.view, plus the approver permission for that specific request, maker ≠ checker, and MFA |
| `GET audit`, `GET audit/verify` | core.audit.view |
| `GET monitoring`, `monitoring/events`, `POST …/acknowledge` | core.monitoring.view |
| `GET settings/pending-decisions`, `PUT settings/:key` | core.settings.view / edit. Changes go to approval. |
| `GET/POST /api/webhooks/whatsapp` | Meta handshake token and HMAC signature |

There is one deviation from the Phase 1 matrix. The self-service routes do not require `core.self.view`, so that a newly created person can sign in and set up MFA before any role is granted. Each of these routes only ever reads or changes the caller's own record.

## 5. Tests executed (in the build environment, 6 Nov 2026)

| Suite | Result |
|---|---|
| B2C regression (`tests/b2c-regression.test.js`) | **20/20 pass** |
| Existing B2B unit | **16/16 pass** |
| Existing B2B isolation | **3 pass, 1 skipped** (skipped because it needs MySQL) |
| ERP unit (passwords, tokens, TOTP RFC vectors, MFA encryption, audit hash, maker-checker, settings validation, webhook signature, permission catalogue, role rules, B2C guard, migration safety) | **13/13 pass** |
| ERP isolation (ERP off, ERP on with the database down, production with a weak secret) | **3/3 pass** |
| Build pre-flight, including the B2C guard | **Pass:** 108 JavaScript files, 4 migrations, 108 protected files unchanged |
| **ERP foundation, MySQL** (`tests/erp-foundation.test.js`, 10 tests) | **NOT RUN.** There is no MySQL here, so the run ends in ECONNREFUSED, which is expected. |
| **Existing B2B platform, MySQL** | **NOT RUN** (same reason) |

The MySQL suite covers:
- migration 004: tables, columns, the enum, a re-run applying 0 changes, and verify
- login: generic errors and lockout
- MFA: enrolment ending sessions, and the code being required
- grants: maker-checker, MFA required to approve, a duplicate returning 409, the session ending on grant, and a decided request being final
- disabling a person: immediate revocation, with re-enabling going to approval
- settings: nothing is applied before approval
- the audit chain: tampering is detected
- jobs: retry, failure and the monitoring event
- the webhook: signature, replay and a stale status
- B2B still working with 004 applied

## 6. Known limitations and risks (not hidden)

1. **Not verified on MySQL 8 yet.** Bugs may show up when you run §7. I will fix them before Phase 3.
2. **The audit chain covers ERP rows only.** Rows the existing B2B code writes have no hash, and verify skips them. Making the table truly append-only needs database grants (no UPDATE or DELETE for the app user), which is a manual DBA step in the runbook.
3. **Changing a role's permissions deletes link rows** in `b2b_role_permissions`. This happens only after approval, and it is audited. No business data is deleted.
4. There is **no generic Idempotency-Key cache** yet; it is planned with the order flows. Approvals are protected against duplicates by `open_key`.
5. **The existing B2B Razorpay path mock-verifies payments when `RAZORPAY_KEY_ID` is unset.** This is pre-existing and not changed here. Fixing it is a B2B change that needs your decision.
6. Inventory reconciliation shows "not available until Phase 6". **B2C stock is not synchronised** in real time, or at all, in this phase.
7. No SMS or WhatsApp provider is called. Only the inbound status webhook exists.

## 7. What I need you to run (MySQL 8, disposable test database)

The database name **must** end in `_test`, `_dev` or `_local`, because the helper wipes `b2b_*` tables in it. Never point it at production or at the restored copy you care about.

```powershell
cd C:\Users\Admin\Downloads\sakeofhealth-erp-build
npm install            # only if node_modules is missing
# in MySQL:  CREATE DATABASE sakeofhealth_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
$env:TEST_DB_USER="root"; $env:TEST_DB_PASSWORD="<your password>"; $env:TEST_DB_NAME="sakeofhealth_test"
node --test --test-concurrency=1 tests/erp-foundation.test.js tests/b2b-platform.test.js 2>&1 | Tee-Object phase2-mysql-results.txt
```

Send me `phase2-mysql-results.txt`.

## 8. Deploy (later, only with your approval)

1. Restore a copy of production into a new database. Run `node scripts/migrate.js status`, then `node scripts/migrate.js up` on **the copy**, then `node scripts/migrate.js verify`. Check the copy with `migrations/tools/validate-restored-copy.js` from the design pack.
2. Take a backup of production (`npm run backup` and a mysqldump), then migrate production.
3. Set these environment variables:
   - `ERP_ENABLED=true`
   - `ERP_JWT_SECRET`: 32 or more random characters, different from `B2B_JWT_SECRET`
   - `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` (only if the webhook is used)
4. Load the reference data. Run `node scripts/erp-reference-data.js` (the report) first, then `--apply --confirm-reference-data`. This is decision D14.
5. Create **two** Super Admins with `ERP_ADMIN_PASSWORD=… node scripts/erp-create-admin.js --email … --name …`, then have both enrol MFA. The second one is needed because a maker cannot approve their own request.

## 9. Rollback

- **Instant:** set `ERP_ENABLED=false` and restart. Every ERP route, page and webhook disappears, and the shop and B2B are unaffected.
- **Code:** the previous release runs unchanged on the extended schema, because every new column is nullable or defaulted and the new tables are simply unused.
- **Schema:** the migration is forward-only by design. To go back fully, restore the pre-migration backup **into a new database** and switch `DB_NAME`. Never run DROP statements on live data.

## 10. Next: Phase 3, products and pricing

This phase covers the product master and price lists from the Excel divide chain (235 rows exact). Rows 188–189 and 204–206 stay **unpublished**. Tiers stay off until D5 is decided, and publishing goes through maker-checker.
