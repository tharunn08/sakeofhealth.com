# B2B platform — architecture and decisions

This document explains how the retailer & distributor platform is built, why
it was built that way, and the rules it enforces. Read it before changing the
B2B code.

## 1. What was already there (audit)

| Area | Finding |
|---|---|
| Runtime | Node.js + Express 4, CommonJS, one process, started by `index.js` |
| Storefront + admin | Static HTML/CSS/JS in `frontend/`, served by Express |
| Data | **JSON files** in `DATA_DIR` (`src/services/db.js`) — products, orders, customers, coupons, reviews, staff, settings |
| Auth | HMAC-signed tokens, scrypt password hashes; admin roles `admin / manager / staff / delivery` |
| Payments | Razorpay / Cashfree, with `PAYMENT_MOCK` |
| Hosting | Hostinger Node.js app, deployed from GitHub; data folder kept outside the repo |

The JSON store is fine for the customer shop but cannot give a B2B platform
what it needs: transactions, row locks for stock, foreign keys, concurrent
order placement, and reporting over tens of thousands of orders.

## 2. The decision: add B2B beside B2C, do not rewrite B2C

**Option A (chosen).** The customer website keeps its JSON store, untouched.
The B2B platform is a separate module with its own MySQL database layer.

Why:

* The live shop keeps working exactly as before — nothing about its data,
  checkout or admin was migrated.
* `B2B_ENABLED=false` (the default) switches the whole platform off. With the
  flag off no B2B route exists and MySQL is never contacted.
* If MySQL is down, only the business portal answers 503; the shop is unaffected.
  This is covered by `tests/b2b-isolation.test.js`.

Moving B2C orders and customers into MySQL is possible later, as its own
project with its own verified migration. It was deliberately not done here.

### What was changed in existing files

Small and additive only:

| File | Change |
|---|---|
| `src/server.js` | mounts the B2B module, adds `/api/health`, adds `b2bEnabled` to `/config.js` |
| `src/routes/admin.js` | accepts the new staff roles; `GET/PUT /print-settings` for the label sender address |
| `frontend/admin/admin.js` | "B2B / Business" menu group (only when enabled), print icon |
| `frontend/admin/page-orders.js`, `page-deliveries.js` | **Print label / Print bill** buttons |
| `frontend/admin/page-staff.js` | offers the B2B roles |
| `frontend/account.html` | "Business login" link (only when enabled) |

## 3. Layout

```
src/db/connection.js            mysql2 pool, query helpers, transactions
src/db/migrate.js               versioned migration runner
src/db/migrations/              001 schema · 002 reference data · 003 indexes
src/modules/b2b/
  index.js                      mounting, feature flag, start-up checks
  rbac.js                       permissions and roles
  lib/                          money, validation, uploads, audit, settings, export
  auth/ accounts/ mappings/     registration, approval, distributor matching
  catalogue/ pricing/           product master, pricing engine
  inventory/ orders/            stock ledger, cart, order state machine
  invoices/ payments/ returns/  GST invoices, credit, payments, returns
  imports/ notifications/ reports/
  routes/portal.js              /api/b2b        (retailers and distributors)
  routes/admin.js               /api/admin/b2b  (staff)
b2b-web/portal/                 /b2b      business portal (mobile-first)
b2b-web/admin/                  /admin/b2b back-office pages
frontend/admin/print.*          label and bill printing (B2C and B2B)
```

All tables are prefixed `b2b_`, use InnoDB, `utf8mb4`, foreign keys, and
`DECIMAL` for money. Money is handled as integer paise in JavaScript
(`lib/money.js`) — never as floating point.

## 4. Who sells to whom

```
Company ──► Distributor ──► Retailer
   └───────────────────────► Retailer   (only when no distributor serves the area)
```

* A **distributor's** order is supplied and invoiced by the company.
* A **retailer's** order is supplied and invoiced by the distributor mapped to
  that retailer. If the retailer has no distributor, the company supplies it
  directly and the order is flagged for the admin.
* Each seller has its own invoice series and its own credit ledger with its
  buyers.

## 5. Registration and approval

1. The business registers at `/b2b/register` (details, address, optional map
   pin, documents). GSTIN is checked with the official checksum; PAN and
   pincode are format-checked.
2. The account is `pending`. It can log in and see its status, but cannot see
   prices or order.
3. An admin with `b2b.users.approve` reviews the documents and approves,
   rejects (with reason), or asks for more information.
4. On approval a retailer is automatically mapped to a distributor.
5. Every status change is stored in `b2b_account_status_history`.

Documents are stored in `B2B_PRIVATE_DIR`, outside the web root, under random
names. They are only ever sent through an authenticated endpoint that checks
ownership or the `b2b.users.view` permission. Uploads are limited by size and
verified by their actual file signature, not their extension.

## 6. Distributor matching

When a retailer is approved (or when an admin asks for candidates) every
active distributor is ranked:

1. **Territory** — pincode match beats city, city beats district, district
   beats state. A distributor with no service area covering the retailer is
   not a candidate.
2. **Stock** — distributors holding the products score higher (only when
   distributor stock tracking is on).
3. **Capacity** — distributors at their retailer limit or daily order
   capacity are pushed down.
4. **Workload** — fewer open orders ranks higher.
5. **Distance** — straight-line distance between map pins breaks ties.

The scores of the chosen distributor and the alternatives are saved with the
mapping, so "why was this retailer given to that distributor?" always has an
answer. Admins can re-map one retailer or many at once; each change needs a
reason and ends the old mapping rather than deleting it.

## 7. Pricing — which price wins

The price a buyer pays is always worked out on the server. The first level
that has a price is used:

1. **Customer-specific price** — a rule for one account and one product
2. **Account override** — a rule for one account across all products
3. **Product pricing** — a product rule, else the product's own fixed
   retailer/distributor price or margin
4. **Category pricing** — sub-category before category
5. **Default margin** — the two percentages in B2B Settings

Then: quantity slabs choose the best slab the order quantity reaches, a volume
discount may apply, and a running promotion replaces the price only if it is
lower.

**What "margin" means.** Two modes are supported, set in Pricing → Margins:

* `markup_on_base` (default): price = base price × (1 + margin %)
* `off_mrp`: price = MRP × (1 − margin %)

Prices exclude GST. The browser never sends a price; cart and order totals are
recalculated from the database every time.

Bulk margin updates run as **preview → confirm**: the preview lists every
product with its old and new price, and the confirmed change is written in one
transaction and recorded in the audit log.

## 8. Orders

```
submitted ─► (first order?) awaiting approval ─► approved ─► assigned
   ─► accepted ─► processing ─► packed ─► dispatched ─► out for delivery ─► delivered
```

* Transitions are fixed in `orders/stateMachine.js`; the server rejects any
  other move. Each edge lists who may take it (buyer, supplying distributor,
  or a staff permission).
* A buyer's **first order** waits for admin approval (setting).
* **Idempotency** — the checkout sends an `Idempotency-Key`; a repeated
  submit (double tap, flaky network) returns the first order instead of
  creating a second one. Enforced by a unique index.
* **Stock** — reserving stock is a guarded update
  (`… SET qty_available = qty_available - ? WHERE qty_available >= ?`) inside
  the order transaction, with rows locked in a fixed order. Two buyers cannot
  both get the last case. Every movement is written to the stock ledger.
  Batches are picked first-expiry-first-out.
* MOQ, case multiples, minimum order value, credit limit and product
  availability are all checked on the server at the moment of ordering.

## 9. GST and invoices

* Seller state = buyer state → CGST + SGST. Different states → IGST. The
  seller's state comes from settings (company) or the distributor's account —
  nothing is hard-coded to Karnataka.
* An invoice is created when the order is dispatched (setting).
* Numbers are gap-free per seller and financial year: `SOH2627-00001`
  (16 characters or fewer, as GST requires). Distributors have their own prefix.
* An invoice is a snapshot: seller, buyer, addresses, HSN, rates and amounts
  are copied at the time of issue. It is never edited. Corrections are made
  with a **credit note** that references the invoice.

## 10. Payments and credit

* Methods: bank transfer, UPI, credit, online gateway.
* Each seller keeps a credit limit and credit days per buyer. An order on
  credit is refused if it would exceed the limit, unless an admin with
  `b2b.credit.override` grants a temporary override (amount, expiry, reason —
  all audited).
* Gateway payments are created as `pending` and only marked `received` by a
  signed webhook; the gateway payment id is unique so a replayed webhook
  cannot credit twice.

## 11. Roles and permissions

| Role | Access |
|---|---|
| `admin`, `b2b_admin` | everything |
| `manager` | everything except running migrations |
| `b2b_manager` | operations; not settings, pricing edits or credit overrides |
| `sales` | business users, approvals, mapping, read pricing |
| `inventory` | catalogue, stock, imports, fulfilment, returns |
| `finance` | invoices, payments, credit, returns |
| `support` | read-only: users, orders, invoices, payments |
| `staff` | read-only: users, orders, catalogue |

`b2b_admin`, `b2b_manager`, `sales`, `inventory`, `finance` and `support`
exist only for the B2B back office; they cannot use the customer-site admin.
Permissions are checked on the server on every request; hiding a button is
never the control. Retailers and distributors can only ever read their own
data — an id belonging to someone else answers "not found".

## 12. Other rules worth knowing

* **Audit log** — approvals, price changes, stock entries, credit changes,
  re-mapping, exports and settings changes are recorded with who, when,
  before and after. There is no endpoint that deletes audit entries.
* **Notifications** — written to an outbox table in the same transaction as
  the event, then sent by a background worker with retries. A failing email
  or WhatsApp provider never blocks or rolls back an order.
* **Excel import** — upload → detect columns → map → validate → preview →
  confirm → one transaction → result. SKU is the key. Blank cells never
  overwrite existing values. Every import and every row result is kept.
* **Errors** — in production, responses never include SQL, stack traces or
  file paths. `/api/health` reports status only.
* **Migrations** — forward-only, recorded with checksums, refuse destructive
  statements, and do not run on deploy unless `DB_AUTO_MIGRATE=true`.

## 13. Defaults you may want to change

| Setting | Default | Where |
|---|---|---|
| Default margins | distributor 12 %, retailer 18 % | Pricing → Margins |
| Margin mode | mark-up on base price | Pricing → Margins |
| First order needs approval | on | B2B Settings → Order rules |
| Invoice issued at | dispatch | B2B Settings → Order rules |
| Track distributor stock | off | B2B Settings → Order rules |
| Return window | 7 days | B2B Settings → Order rules |
| Serviceable states | Karnataka | B2B Settings → Service states |
