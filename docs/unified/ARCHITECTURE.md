# Sake of Health — unified platform architecture (operations channels, November 2026)

This document describes how the online shop (B2C), the business platform (B2B / ERP), events,
field sales, offline sync and the central customer record fit together after migration 019.
Earlier architecture: `docs/B2B-ARCHITECTURE.md` (portals, pricing, orders) and
`docs/erp/BUILD-REPORT.md` (ERP core, approvals, audit, inventory ledger, notifications).

## 1. One process, two stores, one ledger

```
                         ┌────────────────────── one Node process (index.js) ──────────────────────┐
 shop customer ─────────▶│ shop routes (108 protected files, unchanged)  ── JSON files in DATA_DIR  │
                         │   ▲ /api/checkout/order, /api/shop/orders                                 │
                         │   │ next()                                                               │
                         │ shop stock front layer (erp/shopstock/front.js) ─┐                        │
 admin / staff ─────────▶│ /admin (one sidebar) → /api/erp/*                 │                        │
 salesman / event staff ▶│ /sales-app (field app + offline queue)           ├──▶ MySQL 8             │
 retailer / distributor ▶│ /b2b portal → /api/b2b/*                          │     b2b_stock_levels   │
 supplier ──────────────▶│ /vendor portal                                    │     b2b_stock_movements│
                         │ read-only shop adapter (erp/b2cfeed) ─────────────┘     (THE ledger)        │
                         └──────────────────────────────────────────────────────────────────────────┘
```

* **The shop's own data stays in its JSON files and its code is untouched.** `scripts/b2c-guard.js`
  pins the 108 shop files by SHA-256 and refuses any business code that imports shop services.
  The only reader of shop files is `src/modules/erp/b2cfeed/readonly-adapter.js` (read-only:
  `orders`, `products`, `customers`, `accounts`, `checkouts`). Nothing in the business platform
  writes a shop file.
* **All business data is in MySQL 8** (mysql2 pool, parameterised queries, transactions with
  `SELECT … FOR UPDATE`, credentials only from environment variables). No SQLite, no JSON store.
* **There is exactly one stock ledger**: `b2b_stock_levels` (buckets per warehouse × product ×
  batch: available, reserved, allocated, in_transit, damaged, expired, quarantine) and the
  insert-only `b2b_stock_movements`. Every channel posts through `ledger.move()` with an
  idempotency key, so a replay changes nothing. Channels differ only by **warehouse** (stock point):

| Channel | Stock point (warehouse_type) | Movement types |
|---|---|---|
| B2B orders (retailer / distributor) | company / distributor | reservation, allocation, dispatch … |
| Salesman field orders | the account's supplying warehouse | same as B2B (it *is* a B2B order) |
| Online shop (B2C) | the one `online_shop` warehouse chosen in `inventory.b2c_warehouse_id` | allocation, b2c_sale, release, b2c_reversal |
| Event counter | one `event` warehouse per event (`EV-<code>`) | counter_sale, counter_return |
| GRN / transfers / returns / damage / counts / recall | as in phase 2 | receipt, transfer_*, return_*, adjustment … |
| Expiry | every warehouse | expiry (available → expired, daily, keyed by batch + date) |

Batch / expiry: `inventory/fefo.js` picks first-expiry-first-out under row locks, never picks an
expired batch, and refuses batch-less units unless real unbatched capacity exists. The daily
`inventory.expire_batches` job moves past-date units out of *available*.

## 2. Online shop stock (3b.3 shadow → 3b.4 enforcement)

Controlled by business decisions (Administration → Business Decisions; a second person approves):
`inventory.b2c_stock_mode` (`off` | `shadow` | `enforce`), `inventory.b2c_warehouse_id`,
`inventory.b2c_hold_minutes` (default 30), `inventory.b2c_auto_refund`.

**While the mode is unset or `off`, the shop behaves exactly as before** — the front layer calls
`next()` and does nothing else.

`src/modules/erp/index.js → mount()` registers two handlers *before* `server.js` mounts the shop
routers (verified by a test on mount order):

1. **Pay — `POST /api/checkout/order`.** Maps the cart to business products, then in one
   transaction locks the stock rows in a fixed order and creates a *hold*
   (`b2b_stock_reservations`, ref `pay:<uuid>`) for `hold_minutes`.
   *Sellable* = ledger available − other live holds. Enforce: short → 409 with the shop's own
   wording (`Only N of "Name" left in stock.` / `"Name" is out of stock.`) before any gateway order
   exists, so nobody is charged. MySQL unreachable: if this process last read the mode as
   `enforce` → 503 "Online payment is temporarily unavailable" (fail closed, before any charge);
   if it last read `off`/`shadow`, or never read it (unset, or the app started while MySQL was
   down) → the shop works exactly as today, with its own stock check. The mode is read at start-up,
   every minute and on each Pay. Shadow: never refuses; records `would_refuse`.
   After the shop answers, the hold is bound to the gateway order id (or released on failure).
2. **Place — `POST /api/shop/orders`** (enforce only). Commits the held units *before* the shop
   creates the order: FEFO allocation available → allocated, one row per (mode, order, product) in
   `b2b_b2c_order_stock` (unique key ⇒ no duplicate deduction). If the units are no longer there
   (hold expired and someone else bought them) → **paid but short**: no order is created, 409
   "this item sold out while you were paying; refunded in full", and an exception row waits for a
   refund (`shop_stock.refund.pay`, two-factor) or the approved automatic refund.
3. **Catch-up job — every minute (`shopstock.sync`).** Reads shop orders read-only; links
   gateway rows to shop order ids; commits orders that arrived by the Razorpay webhook path;
   advances each line by shop status:
   `out_for_delivery`/`delivered` → **sold** (allocated leaves the ledger, `b2c_sale`);
   `cancelled` before it left → **released** (back to available);
   `cancelled` after it left → **returned** to *quarantine* for inspection.
   Staff can record a return with condition (resaleable → available, damaged, expired).
   It also compares shop stock figures with the ledger and records discrepancies (shop figures are
   never written back — that would mean writing shop files).

Shadow mode runs the same code paths with `mode = 'shadow'` rows and no ledger movement, so the
admin screen shows what enforcement *would* have refused or deducted before anyone switches it on.
The screen lists blockers (unmapped products, no warehouse, open exceptions) that must be cleared
first.

Known limitation (documented, tested): an order that arrives *only* by the webhook path after its
hold expired is committed by the catch-up job after the shop has already created it; if stock is
gone by then, it becomes a paid-short exception attached to an existing order (staff decide).

## 3. Events and counter sales (3b.5)

`events/service.js`. An event owns an `event` warehouse; stock moves there by the existing
transfer flow. Event staff (`b2b_event_staff`) see and sell only at their events, and only while
the event is `open`.

A counter sale (`POST /api/erp/events/sales`, UUID `idempotencyKey`, unique per sale): all lines
checked under lock → FEFO picks (one invoice line per batch, with batch number and expiry) →
GST from MRP (tax-inclusive; CGST+SGST in-state, IGST when the event's state differs from the
seller's) → invoice number from the gap-free sequence (`<prefix>/<FY>/<n>`) → ledger
`counter_sale` (available → out) → payments (cash / UPI / card / bank transfer, never more than the
total) → customer link → audit → invoice by WhatsApp (approved template
`WHATSAPP_TEMPLATE_EVENT_INVOICE`) and email through the existing notification outbox.
Invoices are printable HTML (print / save as PDF) from the admin, or by a signed link
(`/api/erp/public/invoice?t=…`, HMAC with `ERP_JWT_SECRET`). Invoices are never edited: returns
issue a credit (`CR` sequence) and put stock back by condition (resaleable → available,
damaged → damaged, expired → expired); a void (`events.sales.void`) returns everything and
records the refund. Reports by event, day, product, payment method and returns.

## 4. Locations (3b.2)

`field/locations.js`, table `b2b_location_pings`. A fix is recorded only when a person sends one
(check-in, visit, sale, stall, route, manual entry with an optional note) — nothing tracks anyone
in the background. GPS or typed coordinates are validated (valid range, 0,0 refused); the
device's capture time is kept when it is within the 30-day offline window and not in the future,
otherwise the server time is used; a repeated `clientUuid` records once. Each fix may reference an
event, a retailer visit or a transaction (`refType`/`refId`); an event's stall position follows
its latest stall or manual fix.
Everyone sees their own; `locations.view` sees all salesmen and events, filtered by salesman,
event and period; attendance is first and last fix per salesman per day. The admin map is an SVG
plot of the recorded coordinates with an "Open map" link per point (no map library or paid service).

## 5. Offline queue (3b.6)

Device: `erp-web/sales/queue.js` keeps pending operations in IndexedDB (`soh-field` / `ops`),
each with a client UUID that is also the operation's idempotency key. It sends in batches of 25
when the connection returns (and every 30 s), keeps failed and conflicting operations, shows
"N waiting to send", and never silently drops anything. The device store is only a buffer: the
record is MySQL.

Server: `offline/service.js`, table `b2b_offline_ops` (unique `client_op_id`, payload SHA-256).
`POST /api/erp/offline/sync` applies each operation through the *same* service as the online
path (event sale, event payment, location, visit, field order) with the original timestamp.
A repeated id with the same payload returns the stored result (`duplicate`); the same id with a
different payload is refused (`op_reused`); another person's id is refused. Stock that is no longer
there → `conflict` (kept, visible to admins in Administration → Offline Sync). Admins with
`offline.resolve` retry as the original person, or close with a note (resolve / discard); rows are
never deleted.

## 6. Central customer record (N4)

`customers/service.js`, tables `b2b_customers`, `b2b_customer_links`, `b2b_customer_orders`.
Logins stay where they are (shop accounts keep their passwords in the shop; nobody registers
again). Records from the shop (customers, accounts, orders — passwords are never read),
event sales and business accounts are linked to one customer by a normalised email or Indian
mobile (unique). Conflicts (email matches one customer, mobile another) link by email and are
flagged for review, never merged automatically. Import is idempotent (`customers.import`, daily
once `customers.import.enabled` is approved, or the admin button). Contacts are masked unless the
viewer has `customers.contacts.view`.

## 7. Security

* RBAC: new permissions `locations.*`, `events.*`, `shop_stock.*`, `offline.*`, `customers.*`,
  role `event_staff`; refunds (`shop_stock.refund.pay`) are sensitive and need two-factor.
  Retailer/distributor isolation is unchanged (portal tokens never reach `/api/erp`).
* Rate limits: Pay 20/min per client in the front layer (it runs before the shop limiter),
  offline sync 60/min.
* Every write is audited in the hash-chained audit log; invoices and ledger rows are insert-only.
* Secrets only from environment variables (`.env.example` lists names, never values).

## 8. Migrations

`019_operations_channels` (new tables listed above, plus one index on reservations). Pinned by
SHA-256 like 004–018; only allowed operations (create table / add index, no drops). 016–018 were
re-reviewed and are unchanged. 013/014 remain undecided (D5) and are not part of the delivery.
Rollback: restore the pre-migration backup (`docs/BACKUP-RESTORE.md`); 019 only adds empty
tables, so dropping them restores the previous schema — the runbook (`docs/erp/MIGRATION-RUNBOOK.md`)
applies unchanged.
