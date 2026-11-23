# Development log — 19 November 2026

**Brief.** Quality, Hostinger Business, environment configuration, Excel reconciliation, and permanent protection of the four shop products.

**Your decisions in this session.**

- Harden the current stack now; React + TypeScript becomes a planned phase.
- The registry uses the product pages; SKU, HSN and GST stay "to confirm".
- Documents go to a folder outside the site, with an S3 option.
- Lock the four products' identity and log every edit.

**Safety rules followed.**

- No production database, no deploy and no migration applied.
- Migrations 013/014 were never committed or run; they were moved aside for the test runs and put back.
- No dependency added. The supplied Excel and PDF files were not modified.

## Protected shop files changed (minimal, at your request; re-pinned in `scripts/b2c-manifest.json` with reasons)

| File | Change |
|---|---|
| `src/services/db.js` | One added line: the products collection is wrapped by `productProtection.js`. |
| `src/server.js` | The environment check runs first. The protected-product integrity check runs at start, and production stops with exit 78 if it fails. `/api/health` reports `protectedProducts`. |
| `src/routes/admin.js` | Product create and edit run with the admin's identity and reason. New `GET /products/:id/history`. |
| `frontend/admin/page-products.js` | "Protected" badge; no delete button for the four; identity fields locked; a reason is asked for each edit. |
| `package.json` | New scripts (`setup`, `check:env`, `secrets`, `env:templates`, `verify:products`, `restore:shop`, `reset`, `dev`), and `engines` node >=20.6. No dependency change. |

## New files

| File | Purpose |
|---|---|
| `src/catalogue/protected-products.json` | Registry of the four products. It replaces `src/catalogue/core-products.json`, which was removed. |
| `src/services/productProtection.js` | Store-level rules, change log, verify and repair. |
| `src/config/env-schema.js`, `src/config/env.js` | One schema for all variables; validation; the start-up check. |
| `.env.example`, `.env.development.example`, `.env.production.example`, `docs/unified/ENVIRONMENT.md` | Generated from the schema by `scripts/env-templates.js`. |
| `scripts/setup-env.js`, `scripts/check-env.js`, `scripts/generate-secrets.js`, `scripts/env-templates.js` | Setup, checking, secrets and templates. |
| `scripts/protected-products.js`, `scripts/restore-shop.js`, `scripts/reset-dev.js`, `scripts/dev.js` | Verify, show, history and adopt; a safe restore; a safe reset; a cross-platform dev start. |
| `src/platform/storage.js`, `scripts/storage-copy.js` | Document storage: local or S3, with Signature V4. Copies local files to a bucket. |
| `src/platform/jobs-config.js`, `src/platform/cron.js`, `src/platform/cron-route.js`, `src/modules/erp/core/schedule.js`, `scripts/cron/run-jobs.js` | Background work through Hostinger Cron Jobs. |
| `platform-web/shell.css` | Mobile layout fix for the admin shell (QR-09). |
| `scripts/reconcile-catalogue.js`, `docs/reconciliation/*` | Read-only reconciliation: tool, report, and the extracted invoice lines. |
| `scripts/perf-b2c.js` | Shop volume measurement. |
| `scripts/release-gate.js`, `.github/workflows/quality-gate.yml` | Release gate and CI. |
| `docs/unified/PROTECTED-PRODUCTS.md`, `docs/unified/BACKGROUND-JOBS.md`, `docs/unified/reports/*` | Documentation and reports. |
| `tests/protected-products`, `env-config`, `storage`, `jobs-cron`, `jobs-cron.mysql`, `reconcile-catalogue`, `encryption-and-reset` (`.test.js`) | Tests. |

## Other files changed

| File | Change |
|---|---|
| `src/db/connection.js` | `afterCommit()` on the transaction handle. Callbacks run only after a commit. |
| `src/modules/b2b/lib/uploads.js` | Documents are stored through `storage.js`. Adds `withDocument`, which stores before the transaction and removes on failure, and `sendDocument`. |
| `src/modules/b2b/accounts/service.js`, `routes/admin.js`, `routes/portal.js` | Asynchronous storage; documents are sent through storage. |
| `src/modules/erp/vendors/service.js`, `manufacturing/service.js`, `delivery/service.js`, `routes/vendors.js`, `routes/manufacturing.js`, `routes/vendor-portal.js`, `routes/deliveries.js` | Uploads are stored before the transaction; files are sent through storage, `private, no-store`. A failed delivery record removes its photo. |
| `src/modules/b2b/notifications/service.js` | In cron mode a message is sent right after commit. The sender can be switched off inside the cron run. |
| `src/modules/b2b/index.js` | The message timer runs only with `JOBS_MODE=inprocess`. |
| `src/modules/erp/index.js` | Job handlers are registered once, shared with the cron script. Timers come from `startTimers(mode)`: in cron mode, only the shop-stock cache refresh. |
| `src/modules/erp/core/jobs.js` | Adds `runFor` (a finite run) and `cleanup` (scheduled maintenance). |
| `src/modules/erp/core/monitor.js`, `erp-web/admin/app.js` | The overview shows the background-jobs mode and the last cron run, with a warning when it is overdue. |
| `src/modules/erp/core/security.js` | `ENCRYPTION_KEY` (format v2); v1 is still read. |
| `src/services/catalogueGuard.js` | Restores from the registry. No snapshot of a damaged catalogue. |
| `src/middleware/b2cPermissions.js` | The history route is for admin and managers. |
| `src/platform/routes.js` | Mounts the cron route and loads `shell.css`. |
| `scripts/backup.js` | Records the storage provider in the manifest. Warns that bucket files are not in the backup. |
| `scripts/run-mysql-tests.js` | Adds the `jobs-cron.mysql` suite. |
| `docs/DEPLOYMENT-HOSTINGER.md`, `docs/BACKUP-RESTORE.md` | Hostinger facts; cron; storage; persistent folders; restore with `restore:shop`; rollback; the VPS path. |
| `tests/helpers/server.js` and the production-mode tests | A valid production configuration for test servers (`prodEnv`). |
| `tests/notifications-workflow.test.js`, `tests/b2c-permissions.test.js`, `tests/b2c-security.test.js`, `tests/catalogue-guard.test.js` | Checks follow the moved schedule, the new route and the registry. None was weakened. |
