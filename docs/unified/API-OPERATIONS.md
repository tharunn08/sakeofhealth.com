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
