# API — operations channels (migration 019)

All paths are under `/api/erp` and need a staff token (`Authorization: Bearer …`, the same
sign-in as the admin). Errors are `{ "error": "<message>", "code": "<code>" }` with the HTTP
status shown. Amounts are rupees with two decimals; the server works in paise internally.
Permissions are in brackets.

## Online shop stock — `/api/erp/shop-stock`

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/overview` | shop_stock.view | mode, warehouse, hold minutes, counts, last catch-up, `blockers[]`, `readyToEnforce` |
| GET `/lines?mode=&stage=&q=` | shop_stock.view | order lines with stage allocated / sold / released / returned / short |
| GET `/holds?status=` | shop_stock.view | checkout holds |
| GET `/discrepancies?status=` | shop_stock.view | shop figure vs ledger; shadow "would refuse" |
| GET `/exceptions?status=` | shop_stock.view | paid-but-short payments |
| POST `/sync` | shop_stock.resolve | run the catch-up now |
| POST `/discrepancies/:id/explain` `{note}` | shop_stock.resolve | close with an explanation |
| POST `/exceptions/:id/refund` | shop_stock.refund.pay (two-factor) | refund through Razorpay once; repeat returns the stored refund |
| POST `/exceptions/:id/close` `{note}` | shop_stock.resolve | close without refund (e.g. refunded elsewhere) |
| POST `/lines/:id/return` `{condition: quarantine\|damaged\|expired, reason}` | shop_stock.resolve | goods back from a shop order line that has left (whole line; quarantine = inspect first) |

Shop endpoints are **not** changed. With the mode `enforce`, `POST /api/checkout/order` may answer
409 (shop wording, unchanged body shape) or 503 ("Online payment is temporarily unavailable" — only when MySQL cannot be read after this process saw `enforce`), and `POST /api/shop/orders` may
answer 409 `PAID_SHORT`. With the mode unset or `off` they are exactly as before.

## Events and counter sales — `/api/erp/events`

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/` | events.view | events (event staff: only their own) |
| POST `/` `{code, name, venue, city, stateId?, startsOn, endsOn, invoicePrefix}` | events.manage | creates the event and its stock point `EV-<code>` |
| GET `/:id`, GET `/:id/stock` | events.view | event with staff; stock by product (available, damaged, expired, next expiry) |
| POST `/:id/status` `{status: open\|closed}` | events.manage | planned → open → closed |
| PUT `/:id/staff` `{staffIds:[…]}` | events.manage | who may sell here |
| POST `/sales` | events.sell | counter sale (below) |
| GET `/sales?eventId=&from=&to=` · GET `/sales/:id` | events.view | invoices |
| GET `/sales/:id/invoice` | events.view | printable HTML invoice |
| POST `/sales/:id/payments` `{idempotencyKey, method, amount, reference?}` | events.sell | later payment |
| POST `/sales/:id/returns` `{idempotencyKey, items:[{saleItemId, qty, condition: resaleable\|damaged\|expired}], refundMethod: cash\|upi\|card\|bank_transfer\|none, reason}` | events.sell | credit note (`CR` number); stock back by condition; refund never more than was paid |
| POST `/sales/:id/void` `{reason}` | events.sales.void | everything back, refund recorded |
| GET `/report?eventId=&from=&to=` | events.view | by event, day, product, payment method, returns |

Counter sale body:
```json
{ "idempotencyKey": "uuid-v4", "eventId": 3,
  "items": [{ "productId": 5, "qty": 2 }],
  "customer": { "name": "", "mobile": "", "email": "", "gstin": "" },
  "payments": [{ "method": "upi", "amount": 240 }],
  "capturedAt": "optional ISO time (offline)" }
```
201 → the sale (invoice number, lines per batch with expiry, tax split, totals, payment status).
Same key again → the same sale with `"duplicate": true`. 409 `insufficient_stock` when any line is
short (nothing is recorded). 403 when the person is not staff of an open event.

Public: `GET /api/erp/public/invoice?t=<signed token>` — the invoice HTML for the customer link
sent by WhatsApp / email (no sign-in; token is HMAC-signed and names one sale).

## Locations — `/api/erp/locations`

| Method & path | Permission | Purpose |
|---|---|---|
| POST `/` `{clientUuid, subject: salesman\|event, eventId?, lat, lng, accuracy?, source: gps\|manual, purpose, visitId?, refType?, refId?, note?, capturedAt?}` | locations.capture | record one fix (same `clientUuid` ⇒ recorded once) |
| GET `/?subject=&salesmanId=&eventId=&from=&to=` | own; all with locations.view | history |
| GET `/map?…` | own; all with locations.view | latest point per salesman / event |
| GET `/attendance?from=&to=&salesmanId=` | own; all with locations.view | first / last fix per day |

## Offline sync — `/api/erp/offline`

| Method & path | Permission | Purpose |
|---|---|---|
| POST `/sync` `{ops:[{clientOpId, kind, payload, createdAt, deviceId}]}` (≤ 50; 60/min) | the permission of each kind | apply; per-op result `applied` / `duplicate` / `conflict` / `failed` / `retry` (codes `op_reused`, `op_not_yours`, `client_op_id`, `bad_kind`) |
| GET `/ops?status=&kind=` · GET `/ops/:id` | own; all with offline.view | queue and the exact payload the device sent |
| POST `/ops/:id/retry` | offline.resolve | apply again as the original person |
| POST `/ops/:id/resolve` · `/ops/:id/discard` `{note}` | offline.resolve | close with a note (never deleted) |

Kinds: `event_sale`, `event_payment`, `field_order`, `visit`, `location`.

## Customers — `/api/erp/customers`

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/?q=&channel=b2c\|event\|b2b\|field&review=1&page=` | customers.view | one row per person; contacts masked without customers.contacts.view; an email or mobile is searched exactly, never partially |
| GET `/:id` | customers.view | links (shop account, shop customer, event sales, business account) and order history across channels |
| POST `/import` | customers.link.manage | read shop customers, accounts and orders (read-only) and link them; idempotent |
| POST `/links/:id/resolve` `{note, moveTo?}` | customers.link.manage | confirm a flagged link, or move it (and its shop orders) to customer `moveTo`; audited |

## Manufacturing — `/api/erp/manufacturing` (migration 020)

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/lookups` | manufacturing.view | products, company warehouses, approved makers, facilities, active BOMs, open POs (for forms) |
| GET `/manufacturers?q=&capability=` · GET `/manufacturers/:id` | manufacturing.view | makers with counts; one maker with facilities, products, prices, documents, orders, batches, POs, deliveries and `performance` |
| GET `/deliveries?vendorId=&late=1` | manufacturing.view | dispatch notices from makers, with `late` / `lateHours` |
| GET `/facilities?vendorId=<id>\|own` · POST `/facilities` · PUT `/facilities/:id` `{vendorId?, name, address, city, pincode, fssai (14 digits), fssaiValidTo, capacityPerMonth, capacityUom, categories, status}` | view / manufacturing.manage | plants |
| GET `/boms?productId=&status=` · GET `/boms/:id` | manufacturing.view | bills of materials |
| POST `/boms` `{productId, outputQty, note, lines:[{productId, qty, scrapPct}]}` | manufacturing.manage | new draft version |
| POST `/boms/:id/activate` | manufacturing.bom.approve (two-factor; not the author) | activate; archives the previous active version |
| POST `/boms/:id/archive` | manufacturing.manage | refused while open orders use it |
| GET `/orders?status=open\|<status>&mode=&vendorId=&q=` · GET `/orders/:id` | manufacturing.view | orders; detail has events, batches, documents, materials (required / issued) and receipts by batch |
| POST `/orders` `{mode: contract\|in_house, productId, plannedQty, warehouseId, vendorId?, poId?, facilityId?, plannedStart?, plannedEnd?, note?}` | manufacturing.manage | draft |
| POST `/orders/:id/release` · `/cancel {reason}` · `/complete` · `/close` · `/progress {stage, qty?, note?}` | manufacturing.manage | lifecycle |
| POST `/orders/:id/materials/issue` `{idempotencyKey (UUID), lines:[{productId, qty}], reason?}` | manufacturing.issue | in-house, FEFO; `over_issue` asks for a reason; repeat key → `{duplicate: true}` |
| POST `/orders/:id/materials/return` `{idempotencyKey, lines:[{productId, batchId?, qty}]}` | manufacturing.issue | unused material back to its batch |
| POST `/orders/:id/batches` `{batchNo, mfgDate, expiryDate, qty, coaDocumentId?}` | manufacturing.issue | record output (in-house → quarantine) or a batch for a maker |
| POST `/orders/:id/documents` multipart `file`, `docType: coa\|test_report\|production_record\|other`, `batchId?` | manufacturing.manage | PDF / JPG / PNG / WEBP, checked by content |
| GET `/documents/:id/file` | manufacturing.view | the file (viewing is audited) |
| GET `/batches?status=&vendorId=` | manufacturing.view | QC queue |
| POST `/batches/:id/qc` `{result: pass\|fail\|partial, releasedQty?, rejectedQty?, note, checklist?}` | manufacturing.qc.release | needs a CoA / test report to release; not by the person who recorded the batch |

Codes: `vendor_not_approved`, `not_a_manufacturer`, `no_active_bom`, `not_accepted`, `over_production`, `batch_exists`, `own_maker_undecided`, `coa_required`, `same_person`, `qc_pending`, `materials_issued`, `bom_in_use`.

## Deliveries — `/api/erp/deliveries` (migration 020)

| Method & path | Permission | Purpose |
|---|---|---|
| GET `/?status=open\|<status>&late=1&staffId=&q=` | deliveries.view / manage (all); deliveries.update (own) | shipments; with manage also `toShip` (packed orders without a shipment) |
| GET `/staff` | deliveries.manage | people who can be assigned |
| POST `/` `{orderId, mode: own_vehicle\|courier\|transporter\|pickup, carrier?, vehicleNo?, driverName?, driverPhone?, deliveryStaffId?, trackingNo?, lrNo?, ewayBillNo?, packages?, weightKg?, expectedAt?}` | deliveries.manage | one per order (`shipment_exists`); order must be packed (`order_not_packed`) |
| GET `/:id` · PUT `/:id` (same fields) | see / manage | detail with items, tracking, `missing` |
| POST `/:id/dispatch` | deliveries.manage | order → dispatched; challan issued; `shipment_incomplete`, `eway_bill_required`; `warnings[]` |
| POST `/:id/out-for-delivery` · `/location {place?, lat?, lng?, note?}` · `/attempt-failed {reason}` | own or all | tracking; a failed attempt notifies the buyer |
| POST `/:id/delivered` JSON or multipart `{receivedBy, receiverPhone?, note?, delivered?: {orderItemId: qty}, lat?, lng?}` + optional `file` | own or all | order → delivered / partially_delivered (credit note for short lines) |
| POST `/:id/return` `{reason, condition: good\|damaged}` | deliveries.manage | order → returned; stock back |
| GET `/:id/proof` · GET `/:id/challan` | own or all | proof file; printable challan |

Offline (field app): `POST /api/erp/offline/sync` kind `delivery`, payload `{shipmentId, action: out_for_delivery\|location\|attempt_failed\|delivered, …}`.

## Supplier portal additions — `/api/vendor` (vendor token)

| Method & path | Vendor role | Purpose |
|---|---|---|
| GET `/products` | any | own product submissions with the latest price and review status |
| PUT `/profile` `{tradeName, website, categories, brands, capabilitiesNote, defaultLeadDays}` | owner | legal identity is not editable here |
| PUT `/me/contact` `{contactName, contactMobile}` | any | own contact details |
| GET `/manufacturing-orders` · GET `/manufacturing-orders/:id` | any | own orders (never drafts) |
| POST `/manufacturing-orders/:id/respond` `{response: accepted\|declined, note}` | owner, sales | accept / decline |
| POST `/manufacturing-orders/:id/progress` `{stage, qty?, note?}` · `/batches {batchNo, mfgDate, expiryDate, qty}` · `/documents` (multipart) | owner, dispatch | production updates, batches, certificates |
| GET `/manufacturing-documents/:id/file` | any | own documents only |
| GET `/deliveries` | any | own dispatch notices with status, received time and lateness |
| GET `/accounts` | owner, accounts | own invoices (paid / outstanding) and payments |

`POST /api/vendor/asns` now refuses, for a product made on a contract manufacturing order of that PO, a batch our QC has not released (`batch_not_released`) or more than its released quantity (`over_dispatch`).

## Trade portal additions — `/api/b2b` (business token)

| Method & path | Who | Purpose |
|---|---|---|
| GET `/orders/:id` · `/retailer-orders/:id` | buyer / selling distributor | now include `shipment` (details, challan number, tracking events) |
| GET `/orders/:id/challan` · `/retailer-orders/:id/challan` | buyer / selling distributor | printable delivery challan |
| POST `/retailer-orders/:id/shipment` (shipment fields) | selling distributor | add or change delivery details |
| POST `/retailer-orders/:id/status` `{status: returned, note, condition?}` | selling distributor | goods could not be delivered: back to stock |

## Suppliers & manufacturers, salesmen, delivery summary (2026-11-18)

**Staff — `/api/erp` (ERP session; permission in brackets)**

Suppliers and manufacturers:
* `POST /vendors` (vendors.create): add a business with its owner's sign-in.
  * Body: legalName, gstin, pan, fssaiLicence, capabilities[], address, user{name, email, mobile}.
  * Returns `login.temporaryPassword`, shown once.
* `PUT /vendors/:id` (vendors.create): edit identity and terms; `reason` is audited.
* `POST /vendors/:id/addresses` and `DELETE /vendors/:id/addresses/:addressId` (vendors.create).
* `POST /vendors/:id/users` (vendors.create): add a sign-in; returns a temporary password.
* `POST /vendors/:id/users/:userId/reset-password` (vendors.create).
* `POST /vendors/:id/users/:userId/status` (vendors.verify): `{ status: active | disabled }`. The last active owner cannot be turned off.
* `POST /vendors/:id/capabilities` (vendors.verify): `{ capability, status: approved | rejected | suspended, note }`.
* `GET /vendors-lookup/states` and `GET /vendors-lookup/products?q=` (vendors.view): pickers.
* `GET /vendors` now also takes `capability`, searches owner e-mail and mobile, and returns `byStatus`, `owner`, place, and pending banks and products.
* `GET /vendors/:id` now also returns users, addresses, bankAccounts (masked), prices, state and trade totals.

Salesmen:
* `GET /sales/salesmen` (sales.reports.view): every salesman with today's and the month's numbers and cash in hand.
* `GET /sales/salesmen/:id` (sales.reports.view): orders, visits, collections pending, beats, targets and locations.
* `GET /sales/salesmen/lookups` (core.staff.edit): staff, territories and warehouses.
* `PUT /sales/salesmen/:id` (core.staff.edit): employeeCode, homeTerritoryId, defaultWarehouseId, cashLimit, active. Switching off is a 409 `cash_in_hand` while cash is not handed over.

Deliveries:
* `GET /deliveries/summary` (deliveries.view or deliveries.manage): shipments by status, late, delivered and failed today, waiting for a shipment, and each driver's workload.

**Salesman — `/api/sales`**
* `GET /dashboard` (sales.self.view): today, the month against target, cash in hand vs limit, today's beat with shops visited, recent orders.

**Supplier portal — `/api/vendor` (vendor token)**
* `GET /states`: public, used by registration.
* `GET|POST /addresses` and `DELETE /addresses/:id` (owner).
* `GET|POST /bank-accounts` (owner or accounts).
* `GET|POST /users`, `POST /users/:id/reset-password` and `POST /users/:id/status` (owner).
* `POST /capabilities` (owner).
* `POST /register` now accepts several capabilities and `address`.

**Shop admin**
* `DELETE /api/admin/products/:id` answers 409 for the four core products.
