# Security report — 19 November 2026

This report covers the changes of this phase and the controls they depend on. The earlier security reviews still stand: `docs/phase-0.5/`, `docs/phase-1/` and `docs/unified/DELIVERY-REPORT.md`.

## Checked and passing (tests ran here)

| Area | Control | Evidence |
|---|---|---|
| Secrets in the source | A scan of every tracked or new file found no live keys, private keys or provider tokens. Test files contain fake test-only values. The old weak sample values from `.env.example` are gone. | Scan on 19 Nov; `tests/env-config.test.js` |
| Secret in git history | The real-looking `B2B_JWT_SECRET` from the original upload is still in the first commit (`d514b5f`, "Baseline … as received"). **If that value was ever used, change it.** Editing history is not enough; rotate the value. | `git log -S` |
| Configuration | In production, the app refuses to start without required settings or with unsafe ones: short or shared secrets, data folders inside the deploy folder. Outside production a live payment key is refused; in production a test key is warned about. Messages and `check-env` print **names only**, never values. | `tests/env-config.test.js` (11) |
| Generated secrets | `crypto.randomBytes`: 48 bytes base64url (64 characters), or 32 bytes hex for `ENCRYPTION_KEY`. Each is different, and nothing is written to disk unless the setup script creates a new `.env`. The script never overwrites an existing one. | `tests/env-config.test.js` |
| Stored secrets | AES-256-GCM with its own `ENCRYPTION_KEY`, independent of session secrets. A changed byte fails authentication; another key cannot read the data. | `tests/encryption-and-reset.test.js` |
| The four protected products | Enforced in the product store, so no screen, script, import or sync can bypass it. Every change is logged with who, when, why and before/after. Production refuses to start on failed integrity. | `tests/protected-products.test.js` (14) |
| Uploaded documents | The file type comes from its first bytes, not from its name. Stored names are random. Storage is outside the web root, or in a private bucket. Responses are `private, no-store` with `nosniff`. Path traversal is refused at storage level. Files are stored before the transaction and removed if it fails. | `tests/storage.test.js` (11), `tests/b2b-unit.test.js` |
| Bucket access | Requests carry AWS Signature V4, checked against AWS's published example values. The secret key is never sent. Provider errors show the provider code, never the secret. Recommended: a key limited to one private bucket, with versioning on. | `tests/storage.test.js` |
| Cron HTTP trigger | Answers 404 unless `CRON_SECRET` (32 or more characters) is set. The `X-Cron-Secret` header is compared in constant time (SHA-256 digests, `timingSafeEqual`). POST only; 6 requests a minute; `no-store`; 90-second budget; the response never echoes the secret. | `tests/jobs-cron.test.js` |
| Reconciliation tool | Database access is a `READ ONLY` transaction, always rolled back. Production needs an explicit flag. The script contains no write statements. Excel files are hash-checked before and after reading. | `tests/reconcile-catalogue.test.js` |
| `npm run reset` | Refuses production, and any folder not named like a development folder. | `tests/encryption-and-reset.test.js` |
| Admin route permissions | The approved route-permission matrix now has 40 routes, including the new history route, which is for admin and managers. Any change to the routes fails the test. | `tests/b2c-permissions.test.js`, `tests/b2c-security.test.js` |
| Isolation (database-free parts) | With the trade or business platform off, or its database down, none of its pages, APIs or webhooks are reachable and the shop works unchanged. Production refuses a missing, short (under 48 characters) or shared signing secret. | `tests/b2b-isolation.test.js`, `tests/erp-isolation.test.js`, `tests/platform-secrets.test.js` |

## Not verified here

- **MySQL-backed security suites:** account isolation between retailers and distributors, vendor isolation, permission scopes, audit-chain checks and OTP flows. They are written but **NOT RUN**, because there is no MySQL 8 server here. CI and the release gate run them.
- **`npm audit`:** not run, because there is no network. CI runs it and fails on high or critical issues.

## Notes

- **One company, not several.** The platform serves a single company: Sake of Health / Ixitek. "Tenant isolation" therefore means isolation between business accounts: each distributor, retailer and supplier sees only its own records. That is enforced by account scope in every query. There is no multi-company tenancy.
- **Behind a proxy.** The app trusts one proxy hop (`trust proxy 1`), as it runs behind Hostinger's web server. The visitor's address used for rate limits is then the real one. If the app were ever exposed directly, without a proxy, rate limits could be dodged with a forged header. On Hostinger Business that cannot happen.
