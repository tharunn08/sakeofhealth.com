# Testing

## Automated tests

```bash
npm test          # everything (needs a MySQL/MariaDB test database)
npm run test:b2c  # customer-site regression only (no database needed)
```

The B2B suites create and wipe their tables, so they refuse to run unless the
database name ends in `_test`, `_dev` or `_local`. Connection settings come
from `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD`,
`TEST_DB_NAME` (default database name `sakeofhealth_test`).

```bash
TEST_DB_USER=youruser TEST_DB_PASSWORD=yourpassword TEST_DB_NAME=sakeofhealth_test npm test
```

| Suite | Tests | What it proves |
|---|---|---|
| `tests/b2c-regression.test.js` | 19 | The customer shop and its admin behave as before, with `B2B_ENABLED=false`: pages, catalogue, signup/login, coupons, checkout, order tracking, admin orders, staff, reports |
| `tests/b2b-unit.test.js` | 16 | Money arithmetic, GST split, GSTIN/PAN checks, pricing precedence, MOQ and case rules, invoice numbering, order state machine, roles, file-type sniffing, export formula-injection guard, migration safety guard |
| `tests/b2b-platform.test.js` | 50 | The platform end to end against a real database (list below) |
| `tests/b2b-isolation.test.js` | 4 | B2B off → nothing exists and MySQL is never contacted; database down → shop works, portal answers a clean 503; production without a signing secret → logins refused; first deploy on an empty database |

Result at hand-over: **89 passed, 0 failed** on MariaDB 10.11 and on
MySQL 8.0 (the first-deploy test needs `TEST_FRESH_DB_NAME` pointing at an
empty scratch database; without it that one test is skipped).

### What the platform suite covers

* Registration validation, duplicate detection, document upload rules, private
  document access
* Pending accounts cannot see prices or order; approval, rejection, history
* Automatic distributor mapping, service areas, manual and bulk re-mapping
* Catalogue, categories, product availability per audience
* Pricing precedence at every level, slabs, bulk margin preview → confirm
* Excel import: mapping, validation errors, preview, commit, no blind overwrite
* Cart rules: MOQ, case multiples, minimum order value — enforced on the server
* Order placement: idempotency (same key → same order), first-order approval,
  **30 buyers racing for limited stock never oversell**
* State machine: illegal jumps rejected; who may do what
* Inventory ledger, batches and first-expiry-first-out, stock entries
* GST: CGST+SGST inside the state, IGST across states
* Invoices: gap-free numbers per seller and year, immutability, credit notes
* Payments, credit limits, admin overrides, signed webhook, replay protection
* Returns and their stock / credit effects
* Data isolation: one retailer cannot read another's orders, invoices or
  documents; a distributor only sees its own retailers
* Role permissions for every B2B staff role
* Tampering: prices, totals, roles and account ids sent from the browser are
  ignored; SQL-injection and script-injection inputs are stored and returned
  inert
* Reports, exports, audit log, notification queue with retries

## Performance check

`scripts/perf-seed.js` fills a scratch database with **10,000 products,
1,000 distributors, 12,000 retailers and 100,000 orders (about 400,000 order
lines)**. Timings below are single requests on a small development machine
with MariaDB 10.11, after the indexes in migration 003.

| Request | Time |
|---|---|
| Retailer: product list, search, category page | 7–17 ms |
| Retailer: dashboard, order list, cart | 4–8 ms |
| Retailer: place an order (5 lines, stock reserved, distributor assigned) | ~30 ms |
| Distributor: dashboard, retailer orders, retailers | 6–7 ms |
| Admin: orders — first page, by status, page 2000, name search | 20–40 ms |
| Admin: business users — list, search, deep page | 14–43 ms |
| Admin: catalogue — list, search, deep page | 8–23 ms |
| Admin: best distributor for a retailer (1,000 distributors) | ~35 ms |
| Admin: print data for 20 labels | ~13 ms |
| Admin: outstanding by buyer (43,000 unpaid orders in the test data) | ~250 ms |
| Admin: dashboard, uncached (normally cached for a short time) | ~320 ms |
| Reports: sales, GST, margins, geographic | 4–70 ms |
| Reports: product / retailer ranking over a year | 160–290 ms |

What the test changed:

* Order lists were counting and sorting through a three-table join
  (~500 ms). They now count and page on the orders table alone and join names
  only for the rows shown.
* Searching orders by business name scanned every order. It now finds the
  matching businesses first and uses the buyer index.
* An index on the delivery phone number, and two composite indexes for
  per-buyer and per-seller views (migration 003).
* Reports sent thousands of rows to the browser (up to 2.7 MB). The screen now
  gets the first 400 rows with totals calculated on the server; CSV / Excel
  exports still contain everything.

To repeat it:

```bash
DB_NAME=soh_perf_test node scripts/perf-seed.js      # full volume
DB_NAME=soh_perf_test node scripts/perf-seed.js 0.1  # a tenth
```

Shared hosting will be slower than these numbers, but the shape holds: no
request scans the whole orders table to show one page.

## Manual checks before going live

Do these on the real domain after deploying, with real devices.

**Customer site (must be unchanged)**
- [ ] Home page, a product page and the cart load on a phone
- [ ] A test order completes and appears in Admin → Orders
- [ ] Order confirmation email / WhatsApp arrives
- [ ] Admin → Orders → Print label and Print bill, on the real printer

**Business portal**
- [ ] Register a retailer on a phone, including a document photo
- [ ] The pending account cannot see prices
- [ ] Approve it; the retailer is mapped to the expected distributor
- [ ] Place an order; the first order waits for approval
- [ ] The distributor accepts, packs and dispatches; an invoice appears
- [ ] The invoice shows the right GSTIN, state and CGST/SGST or IGST split —
      **have your accountant check one invoice and one credit note**
- [ ] Print a 4 × 6 label on the label printer; scan the barcode and the QR code
- [ ] Record a payment; the outstanding amount drops
- [ ] Upload the Excel template with two changed prices; the preview shows
      exactly those changes

**Operations**
- [ ] `npm run backup` runs, and the folder downloads
- [ ] Restore that backup into an empty test database once
- [ ] `/api/health` is added to an uptime monitor

## Known limits

* Email, WhatsApp and online-payment delivery could not be exercised against
  the real providers here; the queue, retries and webhook verification are
  tested, the provider accounts are not.
* Browser testing was done in Chromium at phone and desktop widths. Check
  Safari on an iPhone and the actual label printer before relying on them.
* `npm audit` reports two remaining items that need a breaking upgrade and
  were left alone on purpose: `nodemailer` (used by the existing customer
  site; upgrade to the current major and re-test order emails) and `uuid`
  inside `exceljs` (the affected function is not used with outside input).
