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
 retailer / distributor ▶│ /b2b portal → /api/b2b/*                          │     b2b_stock          │
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
* **There is exactly one stock ledger**: `b2b_stock` (buckets per warehouse × product ×
  batch: available, reserved, allocated, in_transit, damaged, expired, quarantine) and the
  insert-only `b2b_stock_movements`. Every channel posts through `ledger.move()` with an
  idempotency key, so a replay changes nothing. Channels differ only by **warehouse** (stock point):

| Channel | Stock point (warehouse_type) | Movement types |
|---|---|---|
| B2B orders (retailer / distributor) | company / distributor | reservation, allocation, dispatch … |
| Salesman field orders | the account's supplying warehouse | same as B2B (it *is* a B2B order) |
| Online shop (B2C) | the one `online_shop` warehouse chosen in `inventory.b2c_warehouse_id` | allocation, b2c_sale, release, b2c_reversal |
| Event counter | one `event` warehouse per event (`EV-<code>`) | counter_sale, counter_return |
| GRN / transfers / returns / damage / counts / recall | as in phase 2 | grn, transfer_*, return, adjustment … |
| In-house manufacturing (020) | the order's company warehouse | production_issue (materials out), production (output → quarantine), quarantine_out / damage (QC) |
| Trade deliveries (020) | the seller's warehouse | dispatch (allocated → in transit), delivery, return (undelivered → available / damaged) |
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

## 7. Manufacturers and manufacturing (migration 020)

`manufacturing/service.js`; screens under **Manufacturing & Quality** (Manufacturers, Manufacturing
Orders, Batch Quality & Release, Bills of Materials); the manufacturer's own workspace in the supplier
portal (`/vendor-portal/`).

* **Who is who.** A vendor has one or more approved capabilities: `manufacturer` (makes its own
  branded products we buy), `contract_manufacturer` (new: makes our products to our specification),
  `supplier_wholesaler`, `authorised_distributor`. Registration, document review, product and price
  approval stay in Procurement → Manufacturers & Suppliers (existing); the Manufacturers screen shows
  each maker's identity, FSSAI (with expiry), facilities and capacity, products (approved / pending),
  price submissions, documents, manufacturing orders, batch records with QC results and certificates,
  purchase orders, deliveries (late ones flagged) and performance computed from real records
  (on-time %, fill rate, rejection at receipt, lead time, batches released / rejected).
* **Facilities** (`b2b_mfg_facilities`): a maker's plant or our own (vendor NULL) with FSSAI and
  monthly capacity.
* **Bills of materials** (`b2b_boms`, `b2b_bom_lines`): versioned per finished product; a draft is
  activated by a different person with two-factor sign-in (`manufacturing.bom.approve`), which archives
  the previous version. Materials are product rows with `item_kind` raw_material / packaging.
* **Manufacturing orders** (`b2b_mfg_orders`, events in `b2b_mfg_order_events`):
  draft → released → (contract: accepted by the manufacturer) → in_production → completed → closed;
  cancel only before any batch or material movement.
  * *Contract*: linked to a purchase order with the same maker, product and delivery warehouse. The
    maker accepts or declines in the portal, posts production updates, records each batch (number,
    manufacture and expiry dates within the product's shelf life, quantity ≤ planned + 10 %) and
    uploads its Certificate of Analysis. No stock moves at that point.
  * *In-house*: needs the active bill of materials. Materials are issued earliest-expiry-first with a
    device key (a repeat issues nothing; more than the requirement needs a reason), and unused ones
    can be returned to their batch. Output is recorded as a batch that enters **quarantine** as a lot
    whose manufacturer of record is the vendor decided in `manufacturing.own_manufacturer_vendor_id`.
* **Quality release** (`b2b_mfg_batches`, documents in `b2b_mfg_documents`): pass / fail / partial,
  released + rejected = the batch, a CoA or test report must be attached before anything is
  released, and the person who recorded a batch cannot decide it. In-house: quarantine → available
  (released) and quarantine → damaged (rejected). Contract: no stock moves; the manufacturer is
  emailed; a dispatch notice (ASN) for that PO may carry **only released batches, up to the released
  quantity, with the recorded dates and batch number**, and the goods enter stock by the existing
  goods receipt (GRN), which the order then shows as received by batch.
* **Late manufacturer deliveries**: dispatch notices past their expected time are flagged on the
  screens and, once `delivery.delay_alert_hours` is decided, alerted once to the back office.

## 8. Delivery of trade orders (migration 020)

`delivery/service.js`; screen **Sales & Orders → Trade Deliveries**; "My deliveries" in the field app
(`/sales-app/`, role `delivery_staff`); shipment card, delivery details (distributors) and challan in the
trade portal.

* **One shipment per order** (`b2b_shipments`, unique on order): mode (own vehicle / courier /
  transporter / buyer pickup), carrier, vehicle number (validated Indian format), driver and phone or
  an assigned delivery staff member, tracking / LR number, e-way bill (12 digits), packages, weight,
  expected time. Created once the order is packed (or later, for an order already on its way).
* **Every step is the existing order flow.** Dispatch, out for delivery, delivered (with quantities;
  short lines raise the credit note) and back-to-warehouse call `orders.transition`, so stock
  (allocated → in transit → delivered or back), invoices, credit, history, audit and buyer
  notifications are exactly the existing ones. New in the order flow: **dispatched / out for delivery
  → returned** (fulfilment or the selling distributor only, with a reason): the goods come back to
  available (or damaged), keyed per allocation; credit held for the order is released.
* **Dispatch** refuses a shipment that lacks what its mode needs (e.g. a courier without a tracking
  or LR number). E-way bill: once `delivery.eway_bill_required_above` is decided, dispatch above that
  value without the number is refused; until then a warning is shown above ₹50,000.
* **Delivery challan** (`b2b_delivery_challans`, one per shipment) is issued at dispatch: an
  immutable snapshot of what left by product and batch (FEFO allocations), with its value; printable
  HTML for staff, the selling distributor and the buyer. It is not a tax invoice.
* **Tracking** (`b2b_shipment_events`): created, details changed, dispatched, out for delivery,
  location, failed attempt (the buyer is told), delivered / partly delivered (who received it, their
  phone, optional photo or signed copy kept privately, GPS), returned. Offline updates from the field
  app are recorded once (`client_uuid`, offline kind `delivery`).
* **Keeping in step**: an order moved elsewhere (trade-orders page, distributor's portal) is mirrored
  on its shipment by an after-commit hook (`orders.onTransition`) and a ten-minute catch-up; a shipment
  never moves backwards. Late shipments are flagged and alerted once (`delivery.delay_alert_hours`).
* **Who sees what**: `deliveries.view` all; `deliveries.manage` creates, dispatches and takes goods
  back; delivery staff (`deliveries.update`) see and work only shipments assigned to them; a
  distributor only its own orders; a buyer sees the shipment and challan of its own order without
  staff names or proof files.

## 8a. Permanent shop products, suppliers' records, salesmen, the Delivery group (2026-11-18)

* **Permanent products** — `src/services/catalogueGuard.js`, called by `src/server.js` after the demo seed and before listening.
  * Order of checks:
    1. If every shop file is empty and a backup exists, restore the whole folder from the newest backup. Both `auto-YYYYMMDD` and `npm run backup` folders count.
    2. If there are no products, restore the newest product snapshot, else `src/catalogue/core-products.json`.
    3. Put back any of the four core products that is missing, matched by id, slug or SKU.
  * It never overwrites a record. An unreadable file is copied aside before anything is restored.
  * Snapshots (`CATALOGUE_DIR`, 60 kept, written on change, checked every minute) and daily backups (`BACKUP_DIR`, 14 kept) live outside the site folder.
  * In test mode both default to folders inside `DATA_DIR`. The store stays the existing JSON store; no new database.
* **Manufacturers & Suppliers** — one record per business: `b2b_vendors` and its users, addresses, bank accounts, documents, verifications, products and prices (migration 006). No new tables.
  * Staff can add a business with its owner's sign-in. The temporary password is shown once; only its scrypt hash is stored, and `must_change_password` makes the owner choose their own at `/login`.
  * The vendor manages its own addresses, bank accounts and team sign-ins in the portal.
  * Bank accounts stay `pending` until a second person verifies them. The person who added an account cannot verify it; this is matched through that account's audit row.
* **Salesmen** — `src/modules/erp/sales/team.js` reads the tables the field app writes. The day is the India business day.
  * Switching a salesman off is refused while cash collected has not been handed over.
  * `GET /api/sales/dashboard` is the salesman's own view.
* **Sidebar** — a new **Delivery** group: Delivery Dashboard, Shop Deliveries, Trade Deliveries, Delivery Staff.
  * The two lists keep their old addresses; a page's group no longer has to match its address.
  * The dashboard reads shop deliveries with the shop session (`/api/admin/deliveries`) and trade shipments with the ERP session (`/api/erp/deliveries/summary`). Each API checks its own permissions; the server never mixes the two stores.
* **Admin menu** — the scroll position is kept in `sessionStorage` (`soh_admin_nav_scroll`) and restored after every redraw.

## 9. Security

* RBAC: new permissions `locations.*`, `events.*`, `shop_stock.*`, `offline.*`, `customers.*`,
  `manufacturing.*`, `deliveries.*`, roles `event_staff` and `delivery_staff`; refunds
  (`shop_stock.refund.pay`) and activating a bill of materials (`manufacturing.bom.approve`) are
  sensitive and need two-factor. Quality release (`manufacturing.qc.release`) belongs to quality
  control, not to purchasing.
  Retailer/distributor isolation is unchanged (portal tokens never reach `/api/erp`).
* Rate limits: Pay 20/min per client in the front layer (it runs before the shop limiter),
  offline sync 60/min.
* Every write is audited in the hash-chained audit log; invoices and ledger rows are insert-only.
* Secrets only from environment variables (`.env.example` lists names, never values).

## 10. Migrations

`020_manufacturing_delivery`: eleven new tables (facilities, BOMs and lines, manufacturing orders,
events, material issues, documents, batches, shipments, shipment events, challans), `b2b_products.item_kind`,
`b2b_asns.delay_alerted_at`, and enum extensions (capability `contract_manufacturer`, movement type
`production_issue`, offline kind `delivery`) that keep every existing value first. Same guarded runner
and SHA-256 pin as 004–019; nothing is dropped or rewritten.

`019_operations_channels` (new tables listed above, plus one index on reservations). Pinned by
SHA-256 like 004–018; only allowed operations (create table / add index, no drops). 016–018 were
re-reviewed and are unchanged. 013/014 remain undecided (D5) and are not part of the delivery.
Rollback: restore the pre-migration backup (`docs/BACKUP-RESTORE.md`); 019 only adds empty
tables, so dropping them restores the previous schema — the runbook (`docs/erp/MIGRATION-RUNBOOK.md`)
applies unchanged.
