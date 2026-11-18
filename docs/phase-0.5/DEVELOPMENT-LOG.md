# Phase 0.5 development log

Workspace: `/home/claude/dev/soh`, branch `phase-0.5`, starting from commit `8b93839` (the delivered ZIP, sha256 `d82bbe35…e1ee7b9`).
The shipped `.env` is quarantined outside the workspace and is never loaded. Tests run on a throw-away `DATA_DIR`; no customer JSON data, no database, no migration and no production setting is touched.
Raw test output is kept in `/home/claude/dev/baseline/` (file named on each line below).

## Baseline before any change (`baseline-tests.txt`)

| Suite | Result |
|---|---|
| b2c-regression | 20/20 |
| b2b-unit | 16/16 |
| b2b-isolation | 3 pass, 1 skipped |
| erp-isolation | 3/3 |
| erp-unit | 12/13: test 12 (B2C protection guard) already failing, because the delivered package.json/package-lock.json carry an un-pinned dotenv bump. Reverted in 0.5.11 |
| erp-migrations-guarded | 11/12: test 12 fails on the untracked migrations 013/014 (left untouched, pending D5) |
| 98 MySQL-backed tests | NOT RUN: no MySQL 8 here, and running them would execute 013/014 |

## 0.5.1: separate admin and customer token secrets (BUG-001, BUG-015). Commit `4f9f0db`

- Red on the original code: 6 pass, 15 fail (`red-0.5.1.txt`). Green: 21/21.
- Changed: `src/middleware/adminAuth.js`, `src/middleware/customerAuth.js`, `src/routes/admin.js`, `src/routes/auth.js`, `tests/helpers/server.js`.
- Added: `tests/b2c-security.test.js`, `tests/helpers/tokens.js`.

## 0.5.2: server-side B2C admin role matrix (BUG-005). Commits `af664c2` and `40f6893`

- Red: 30 role/route violations found by the matrix test (`red-0.5.2.txt`). Green: 6/6.
- `af664c2` caused two regressions, which I found by re-running all suites:
  - `/api/admin/b2b/*` returned 403 instead of 404 with B2B off;
  - regression test #17 asserted the old delivery access.
- Both fixed in `40f6893`: unmatched paths fall through, and a test checks every admin route has a rule. The test change is recorded in `CHANGED-TESTS.md`.
- Changed: `frontend/admin/admin.js`, `frontend/admin/page-deliveries.js`, `src/routes/admin.js`, `tests/b2c-regression.test.js`.
- Added: `src/middleware/b2cPermissions.js`, `tests/b2c-permissions.test.js`, `docs/phase-0.5/CHANGED-TESTS.md`.
- Browser check: the delivery user sees only Deliveries; staff see no Reports, Settings or Staff; no page errors.

## 0.5.3–0.5.5: server pricing, payment binding, webhook, fail-closed payments (BUG-002, -003, -004, -006, -021, -028, new BUG-032)

**Red.** On the original code, with the final test file run in a separate checkout of `40f6893`: 2 pass, 14 fail (`red-0.5.3.txt`).
- The 2 "passes" are tests 6 and 8 (reused or mismatched payment refused).
- They pass on the old code only because it cannot start a cart-based checkout at all, so every payment is refused before any check. They prove nothing about the old code and are not counted as evidence.

**Green.** 16/16 (`green-0.5.3.txt`), including every orderable SKU × {no coupon, WELCOME10, FLAT100, FREESHIP}: quote = Razorpay order amount = stored order total.
- Razorpay is a local stub (`tests/helpers/razorpay-stub.js`).
- Test keys only. No network and no money.
- No live credentials were used.

**What changed in behaviour:**
- `POST /api/shop/quote` (new) prices a cart from the Admin catalogue.
- `POST /api/checkout/order` now takes the cart and contact details, not an amount.
  - It prices on the server.
  - It creates the Razorpay order for that exact amount.
  - It records the checkout in `DATA_DIR/checkouts.json` (a new, separate file; `db.js` collections are unchanged).
  - A client `amount` is ignored; a request without items is refused (400).
- `POST /api/shop/orders` (live) builds the order only from that recorded checkout. It requires:
  - a valid signature;
  - the payment, fetched from Razorpay, to be `captured`/`authorized`, for the same gateway order, with the exact amount and currency.

  Further rules:
  - A payment id can belong to one order only (409).
  - Repeating the call returns the same order.
  - One order per checkout is held by an exclusive lock file, which works across processes.
- `POST /api/shop/webhooks/razorpay` (new, raw body, `RAZORPAY_WEBHOOK_SECRET`):
  - refuses bad signatures;
  - skips replayed event ids;
  - creates the order if the browser callback was lost;
  - creates nothing on mismatch;
  - answers 500 on internal errors so Razorpay retries.
- Payment mode is fail-closed:
  - mock only when `PAYMENT_MOCK=true` and `NODE_ENV≠production`;
  - otherwise Razorpay keys are required;
  - otherwise 503 and no order.

  Developers now need `PAYMENT_MOCK=true` set explicitly for local test mode.
- Order lines are refused when:
  - the product is unknown, inactive, coming soon or unpriced;
  - the quantity is not a whole number ≥ 1;
  - the quantity is above recorded stock;
  - the quantity is above the per-line limit (`B2C_MAX_LINE_QTY`, default 20).

  Mock mode applies the same checks.
- Cashfree code removed (hard-coded sandbox URL; D8 approved).
- Checkout page (`frontend/checkout/index.html`):
  - shows the server quote;
  - corrects stale or tampered cart prices to the catalogue price;
  - sends the cart, not an amount;
  - opens Razorpay with the server amount;
  - if the server total differs from what was on screen, shows it and asks the customer to press Pay again.
- **BUG-032 (found during this work).** The checkout page offered "Express Delivery ₹99", which the server never knew about. In the old flow the customer could be charged ₹99 delivery while the order recorded ₹49 or free.
  - The option is now hidden (markup kept, `display:none`).
  - Whether to offer express delivery, and its fee, is open decision **D14** for the owner.
- Regression test #7 changed (amount-only checkout now 400); recorded in `CHANGED-TESTS.md`.

**Browser check** (`/home/claude/dev/checks/checkout_flow.py`, test mode, desktop 1366×900 and mobile 390×844): PASS.
- A cart tampered to ₹1 was corrected to ₹599.
- Sidebar total = Pay button = stored order total = ₹1,198.
- No page errors.

**Suites after this unit** (`suites-after-0.5.3.txt` plus the re-run of b2c-regression):

| Suite | Result |
|---|---|
| b2c-payments | 16/16 |
| b2c-regression | 20/20 |
| b2c-security | 21/21 |
| b2c-permissions | 6/6 |
| b2b-isolation | 3 pass, 1 skipped |
| erp-isolation | 3/3 |
| b2b-unit | 16/16 |
| erp-unit | 12/13 (test 12, same as baseline; re-pin in 0.5.11) |
| erp-migrations-guarded | 11/12 (013/014, untouched) |
| MySQL tests | NOT RUN |

**Files.**
- Changed: `src/routes/checkout.js`, `src/routes/shop.js`, `src/server.js` (one mount line), `src/services/payments.js`, `frontend/checkout/index.html`, `tests/b2c-regression.test.js`.
- Added: `src/services/checkoutPricing.js`, `src/services/checkoutFlow.js`, `src/services/pendingCheckouts.js`, `src/routes/shopWebhook.js`, `tests/b2c-payments.test.js`, `tests/helpers/razorpay-stub.js`, this log.

**Still required before any deploy (unchanged gates):**
- staging run with Razorpay **test** keys and a test-mode webhook;
- Razorpay auto-capture enabled on the account (an `authorized` payment is accepted as paid);
- `RAZORPAY_WEBHOOK_SECRET` set and the webhook URL registered;
- D12 prices confirmed.

## 0.5.6–0.5.7: delivery no longer marks payment paid; safe order numbers; cancel instead of delete (BUG-012, BUG-013, D10)

**Red.** On the code before this unit (`bf843b9`, separate checkout): 1 pass, 8 fail (`red-0.5.6.txt`).
- The pass is the "numbers keep increasing" guard. It holds on the old code too, because numbering only breaks after a gap.

**Green.** 9/9 (`green-0.5.6.txt`).

**What changed in behaviour:**
- Marking an order **delivered** no longer sets payment to "paid". Payment status changes only through a verified Razorpay payment, or a manager editing the payment as before.
- **Order numbers:**
  - highest number used that day + 1, then checked for collision, instead of "count of today's orders + 1";
  - a gap left by an old deletion can no longer create a duplicate.
- **Cancel order** (`POST /api/admin/orders/:id/cancel`, admin/manager):
  - a reason is required (3–500 characters);
  - the order is kept, with `cancelReason`, `cancelledBy`, `cancelledAt` and a timeline entry;
  - a paid order gets `refundRequired: true`, and the screen says to refund it in Razorpay;
  - the customer's order count and spend are recalculated from the non-cancelled orders on file;
  - the customer is notified as before;
  - delivered or already-cancelled orders answer 409.
- Cancelling from the status menu (`PATCH …/status` with `cancelled`) uses the same rules: the note is the required reason.
- Support staff can no longer cancel by either route. This was a gap in 0.5.2: the matrix said "no cancel", but the status menu still allowed it.
- `DELETE /api/admin/orders/:id` deletes nothing. It answers 410 with "use Cancel order", so an old cached admin page fails visibly instead of removing records.
- **Admin screens:**
  - The order drawer's "Delete this order permanently" danger zone is gone.
  - "Cancel this order…" (managers and admins only) asks for the reason.
  - Cancelled orders show reason, actor, time and the refund note.
  - The Deliveries board's trash icon is now a ✕ "Cancel order" with the same reason prompt.

**Browser check** (`/home/claude/dev/checks/admin_cancel.py`, test data): PASS.
- Staff: no cancel or delete control.
- Manager on mobile:
  - cancels from the drawer;
  - a too-short reason is asked again;
  - the drawer shows reason, who, when and the refund note.
- Admin on desktop: cancels from the Deliveries board.
- Both orders remain on file as cancelled, with reasons. No page errors.

**Suites after this unit:**

| Suite | Result |
|---|---|
| b2c-orders | 9/9 |
| b2c-payments | 16/16 |
| b2c-regression | 20/20 |
| b2c-security | 21/21 (route count 38 → 39, see CHANGED-TESTS) |
| b2c-permissions | 6/6 (cancel route added to the matrix) |
| b2b-isolation | 3 pass, 1 skipped |
| erp-isolation | 3/3 |
| b2b-unit | 16/16 |
| erp-unit | 12/13 (test 12, baseline; re-pin in 0.5.11) |
| erp-migrations-guarded | 11/12 (013/014, untouched) |
| MySQL tests | NOT RUN |

**Files.**
- Changed: `src/services/orders.js`, `src/routes/admin.js`, `src/middleware/b2cPermissions.js`, `frontend/admin/page-orders.js`, `frontend/admin/page-deliveries.js`, `tests/b2c-security.test.js`, `tests/b2c-permissions.test.js`, `docs/phase-0.5/CHANGED-TESTS.md`, this log.
- Added: `tests/b2c-orders.test.js`.

## 0.5.8–0.5.10: no production seeding, status-only /health, CSV downloads without URL tokens, safe and durable blog (BUG-007, BUG-008, BUG-016, BUG-018)

**Red.** On the code before this unit (`04387fa`, temporary checkout): 0 of 12 pass (`red-0.5.8.txt`).
- The old code also wrote the test article into its own `frontend/blog/` and blog data into `data/`. That is the defect itself, and it was caught by the test's "repository folders unchanged" check.
- An earlier exploratory red run in the workspace did the same: it wrote `data/blog-pending.json`, `data/blog-published.json` and `frontend/blog/gummies-b-habits-b-656c73.html`.
  - I confirmed against the delivered ZIP that those folders originally held only `.gitkeep`, `index.html` and `submit.html`.
  - I then removed exactly those three test files. No other file was touched.

**Green.** 14/14 (`green-0.5.8.txt`). Two tests were added after the red run, for the leftover-demo-staff warning and for password-change recording. The warning test was run red before its fix.

**What changed in behaviour:**
- **Seeding:**
  - `src/seed.js` refuses to run with `NODE_ENV=production` (exit code 1, nothing written).
  - It creates demo staff only with `--with-staff`, and prints demo passwords only then.
  - A production server with an empty catalogue does not seed. It logs a clear "not seeding in production — check DATA_DIR / restore from backup" message.
  - Development auto-seed still creates the catalogue and coupons, but no staff.
- **Leftover demo staff:** in production, active staff accounts created by the old seed whose password was never changed are listed by e-mail at start-up, never with a password.
  - They are not changed, locked or removed, so nobody is shut out.
  - Changing a staff password now records `passwordChangedAt`, which clears the warning for that account.
- **`/health`:** answers `{ "ok": true }` only. No order or product counts, environment or payment mode. `/api/health` is unchanged.
- **CSV exports:**
  - The customers page and the five report buttons download through an authorised `fetch`, with the token in the `Authorization` header.
  - `adminAuth` no longer accepts `?token=`.
  - The browser check found no request URL carrying a token.
- **Blog:**
  - The article body is HTML-escaped, with paragraphs and line breaks kept. Date and read time are escaped as well.
  - Data lives in `DATA_DIR/blog/` and generated pages in `DATA_DIR/blog/articles/`.
  - Old `data/blog-*.json` files are **copied** there on first start, never moved or changed.
  - `/blog/<slug>.html` is served from `DATA_DIR` first. It is regenerated, escaped, if the page file is missing, which also restores articles lost in past redeploys. Otherwise it falls back to the old folder.
  - Moderation needs an admin, manager or support-staff login (role matrix §11.3). Delivery gets 403; customers or no token get 401.
  - `frontend/admin/blog.html` uses the admin panel's session instead of turning a typed password into a "token". Without a session it offers "Sign in to the admin panel".

**Test changes** (recorded in `CHANGED-TESTS.md`):
- regression `/health` test;
- `b2c-payments` production test now copies a catalogue in;
- `b2b-platform` (MySQL-backed, NOT RUN) now creates its own delivery agent instead of using the seeded `ravi@…/delivery@1234`.

**Browser check** (`/home/claude/dev/checks/admin_blog_csv.py`): PASS.
- The blog page without a session shows the sign-in prompt, with no password box.
- With the admin session it lists the pending post; approve publishes it.
- On the article, `window.__xss` stays undefined, the submitted tags show as text, and both paragraphs are kept.
- Customers and orders CSVs download with the right file names.
- No URL contains a token. No page errors.
- Repo `data/` and `frontend/blog/` are unchanged.

**Suites after this unit:**

| Suite | Result |
|---|---|
| b2c-hardening | 14/14 |
| b2c-orders | 9/9 |
| b2c-payments | 16/16 |
| b2c-regression | 20/20 |
| b2c-security | 21/21 |
| b2c-permissions | 6/6 |
| b2b-isolation | 3 pass, 1 skipped |
| erp-isolation | 3/3 |
| b2b-unit | 16/16 |
| erp-unit | 12/13 (baseline test 12; re-pin in 0.5.11) |
| erp-migrations-guarded | 11/12 (013/014, untouched) |
| MySQL tests | NOT RUN |

**Files.**
- Changed: `src/seed.js`, `src/server.js`, `src/middleware/adminAuth.js`, `src/routes/admin.js` (password-change timestamp), `src/routes/blog.js`, `src/services/blogStore.js`, `src/services/blogTemplate.js`, `frontend/admin/blog.html`, `frontend/admin/page-customers.js`, `frontend/admin/page-reports.js`, `tests/b2c-regression.test.js`, `tests/b2c-payments.test.js`, `tests/b2b-platform.test.js`, `docs/phase-0.5/CHANGED-TESTS.md`, this log.
- Added: `tests/b2c-hardening.test.js`.

**Deploy note:** after deploying, read the start-up log once. Any `[SECURITY]` line names demo accounts to re-password or deactivate in Admin → Staff.

## 0.5.11: close-out (B2B payment contract restored, dotenv revert, manifest re-pin, build, full smoke test)

1. **Regression I introduced in 0.5.4, found and fixed here (BUG-033).**
   - Reviewing the business-module couplings before re-pinning showed that `src/modules/b2b/payments/service.js` calls `payments.createOrder()` (rupees) and `verifySignature()`. 0.5.4 had removed `createOrder()`.
   - B2B online payment would have failed. Its tests need MySQL, so no runnable suite caught it, and my 0.5.4 caller search had wrongly excluded that file.
   - `createOrder()` is restored as a thin wrapper with the same fail-closed modes: mock only outside production when asked for; no keys means refused.
   - A contract test was added to `b2c-payments`. It ran red, then green (17/17).
   - The other couplings were checked and are unaffected: catalogue → `db.js` (read), notifications → `notify.js` (unchanged), B2B → `adminAuth.verifyToken` (typed tokens accepted).
   - The B2B role guard's `?token=` read can only deny access, so it is left unchanged.
2. **dotenv (BUG-011).**
   - `package.json` and `package-lock.json` were backed up to `/home/claude/dev/baseline/pre-0.5.11-backup/`, then reverted to the committed `^16.4.5` range.
   - The lock already resolves 16.6.1, which satisfies that range, so nothing is installed or changed at runtime.
3. **Manifest re-pin** (`scripts/b2c-manifest.json`, backup kept). Only approved files were re-pinned, by `docs/phase-0.5/repin-manifest.js`; each change is recorded under `repins` with its reason and old and new hash.
   - 20 files from the approved specification (rows 1–21; package.json needed no re-pin after the revert).
   - `frontend/admin/admin.js`: **not** in the approved list. It was changed in 0.5.2 for the role menu. The owner approved it on 2026-11-12 when asked, and it was pinned only after that.
   - `frontend/checkout/index.html` again, for the empty-cart total fix (BUG-031 part 1).
   - `node scripts/b2c-guard.js` → "B2C protection OK — 108 protected files unchanged".
   - `node scripts/build.js` → "Build check passed — 151 JavaScript files, 10 dependencies, 14 migrations". Migrations 013 and 014 are still present and untouched.
4. **Smoke test** (`/home/claude/dev/checks/smoke_all.py`): PASS.
   - 19 storefront pages plus the admin login and 13 signed-in admin pages, desktop 1366×900 and mobile 390×844: 66 page loads.
   - 0 script errors, 0 failed same-site requests. Screenshots are in `/home/claude/dev/checks/smoke/`.
   - Seen but not fixed: the empty icon buttons in the admin header (BUG-025, UI phase) and the floating social buttons overlapping content on mobile (BUG-031 part 2).

### Phase 0.5 final suite results (`suites-final-0.5.txt`)

| Suite | Result |
|---|---|
| b2c-regression | 20/20 |
| b2c-security | 21/21 |
| b2c-permissions | 6/6 |
| b2c-payments | 17/17 |
| b2c-orders | 9/9 |
| b2c-hardening | 14/14 |
| b2b-isolation | 3 pass, 1 skipped |
| erp-isolation | 3/3 |
| b2b-unit | 16/16 |
| erp-unit | **13/13** (was 12/13 at baseline) |
| erp-migrations-guarded | 11/12: test 12 fails only on the untracked migrations 013/014, untouched pending D5 |
| `npm run build` preflight | passes |
| b2b-platform, erp-catalog, erp-foundation, erp-integrations, erp-operations, erp-procurement | **NOT RUN**: they need MySQL 8, which is not available here, and running them would execute migrations 013/014 |

### Before any deployment (unchanged gates G3/G4)
- `ADMIN_JWT_SECRET` and `CUSTOMER_JWT_SECRET` set (48+ random characters, different).
- `RAZORPAY_WEBHOOK_SECRET` set and the webhook URL `/api/shop/webhooks/razorpay` registered (test mode on staging first).
- Razorpay auto-capture on.
- D12 prices confirmed.
- Backup taken and test-restored.
- After start-up, check the log for `[SECURITY]` demo-account lines.
- Decisions still open: D14 (express delivery), D5 (013/014), D6 (MySQL 8 test database).
