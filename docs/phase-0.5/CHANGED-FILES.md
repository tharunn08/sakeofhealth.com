# Phase 0.5: every file changed (generated from git, `8b93839..HEAD`)

★ marks a protected B2C file. Every ★ file was re-pinned with a recorded reason; see `repins` in `scripts/b2c-manifest.json`.

Untouched by design: migrations `013_erp_governance.js` and `014_erp_governance.js`, `erp-role-schema.txt`, and all customer data. `package.json` and `package-lock.json` were reverted to the committed version.

## Commits

- `4f9f0db` Phase 0.5.1: separate admin/customer token secrets (BUG-001, BUG-015)
- `af664c2` Phase 0.5.2: enforce the B2C admin role matrix on the server (BUG-005)
- `40f6893` Phase 0.5.2 fix-up: non-admin paths fall through to 404; route-coverage test
- `bf843b9` Phase 0.5.3–0.5.5: server-priced checkout, Razorpay payment binding, webhook, fail-closed payments
- `04387fa` Phase 0.5.6–0.5.7: delivery keeps payment status; collision-free order numbers; cancel instead of delete
- `ef2805b` Phase 0.5.8–0.5.10: no production seeding, status-only /health, header-only admin tokens, safe durable blog
- `7c0f9d1` Phase 0.5.11: restore B2B payment contract, revert dotenv bump, re-pin B2C manifest, close out

## Files

| File | Status | Lines + / − | Protected |
|---|---|---|---|
| `docs/phase-0.5/CHANGED-TESTS.md` | added | +11 / −0 |  |
| `docs/phase-0.5/DEVELOPMENT-LOG.md` | added | +296 / −0 |  |
| `docs/phase-0.5/repin-manifest.js` | added | +40 / −0 |  |
| `frontend/admin/admin.js` | modified | +15 / −10 | ★ |
| `frontend/admin/blog.html` | modified | +11 / −14 | ★ |
| `frontend/admin/page-customers.js` | modified | +21 / −1 | ★ |
| `frontend/admin/page-deliveries.js` | modified | +30 / −9 | ★ |
| `frontend/admin/page-orders.js` | modified | +41 / −19 | ★ |
| `frontend/admin/page-reports.js` | modified | +19 / −2 | ★ |
| `frontend/checkout/index.html` | modified | +70 / −11 | ★ |
| `scripts/b2c-manifest.json` | modified | +175 / −23 |  |
| `src/middleware/adminAuth.js` | modified | +44 / −24 | ★ |
| `src/middleware/b2cPermissions.js` | added | +128 / −0 |  |
| `src/middleware/customerAuth.js` | modified | +34 / −10 | ★ |
| `src/routes/admin.js` | modified | +30 / −29 | ★ |
| `src/routes/auth.js` | modified | +2 / −2 | ★ |
| `src/routes/blog.js` | modified | +40 / −17 | ★ |
| `src/routes/checkout.js` | modified | +22 / −10 | ★ |
| `src/routes/shop.js` | modified | +55 / −56 | ★ |
| `src/routes/shopWebhook.js` | added | +54 / −0 |  |
| `src/seed.js` | modified | +24 / −9 | ★ |
| `src/server.js` | modified | +28 / −9 | ★ |
| `src/services/blogStore.js` | modified | +57 / −10 | ★ |
| `src/services/blogTemplate.js` | modified | +5 / −3 | ★ |
| `src/services/checkoutFlow.js` | added | +114 / −0 |  |
| `src/services/checkoutPricing.js` | added | +108 / −0 |  |
| `src/services/orders.js` | modified | +74 / −9 | ★ |
| `src/services/payments.js` | modified | +109 / −41 | ★ |
| `src/services/pendingCheckouts.js` | added | +83 / −0 |  |
| `tests/b2b-platform.test.js` | modified | +3 / −1 |  |
| `tests/b2c-hardening.test.js` | added | +213 / −0 |  |
| `tests/b2c-orders.test.js` | added | +148 / −0 |  |
| `tests/b2c-payments.test.js` | added | +272 / −0 |  |
| `tests/b2c-permissions.test.js` | added | +153 / −0 |  |
| `tests/b2c-regression.test.js` | modified | +20 / −5 | ★ |
| `tests/b2c-security.test.js` | added | +162 / −0 |  |
| `tests/helpers/razorpay-stub.js` | added | +55 / −0 |  |
| `tests/helpers/server.js` | modified | +2 / −1 |  |
| `tests/helpers/tokens.js` | added | +34 / −0 |  |
