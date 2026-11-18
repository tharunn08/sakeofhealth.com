# Inventory: one ledger, adjustments and opening balances (Milestone 3b.1)

## One write path
Every stock change in the platform goes through `src/modules/erp/inventory/ledger.js`
(`move` / `mustMove`): one guarded `UPDATE b2b_stock … WHERE qty_<bucket> >= ?` plus one
append-only `b2b_stock_movements` row, in the caller's transaction. The B2B module's `move`
delegates to it with its original arguments. A test fails if any other file writes
`b2b_stock` or `b2b_stock_movements`.

**Duplicate-proof keys** (`idem_key`, migration 017, unique). Keyed today:
- goods receipts: `grn:<grn>:<line>:accepted|quarantined`;
- transfers: `trf:<transfer>:<lot>:dispatched|left|received`;
- dispositions: `disp:<id>`;
- adjustments and opening balances: `adj:<id>`.

A key already posted is refused (409 `duplicate_movement`): the whole action stops, batch
updates included. The B2B order steps (reserve, pack, dispatch, deliver, release) remain
protected by their order state machine and are not keyed. Deploying this code requires
migration 017.

**Warehouse restriction:** B2B orders are filled only from warehouses with no owner and type
`company`. Event, salesman, online-shop, transit and distributor locations are never used.

## Adjustments and opening balances (owner decision 5)
With the ERP enabled, `POST /api/admin/b2b/stock/entry` refuses company stock (409
`use_adjustment`). Purchases come in through goods receipts; everything else is proposed
here and posted only after a second person approves (existing approvals engine: the
proposer cannot approve; approvers need two-factor sign-in). Distributors' own stock
entries in the portal are unchanged until decision M7.

| Method and path | Permission | Body / answer |
| --- | --- | --- |
| `GET /api/erp/inventory/adjustments?status=&kind=` | `inventory.view` (warehouse scope applies) | `{ items: [...] }` with approval status |
| `POST /api/erp/inventory/adjustments` | `inventory.adjust.propose` | See the rules below. Answers 202 `{ approvalId, adjustmentId, adjNo }` |

**Request body:** `{ kind: 'opening'|'adjustment', warehouseId, productId, qty, reason, direction?, bucket?, reasonCode?, lotId? | batchNo + expiry + manufacturerId }`.

**Opening balance:**
- Increase only, into available (or quarantine).
- Allowed only while the product has no stock history at that warehouse, and only once.
- A rejected or withdrawn opening balance may be proposed again.

**Adjustments:**
- Increase reasons: found, correction. Units go into available or quarantine.
- Decrease reasons: damage, expiry, loss, theft, correction.
- Damage moves available → damaged; expiry moves available → expired; the other reasons take units out of stock.

**Lots:** stock coming in always needs its lot (an existing `lotId`, or `batchNo` + `expiry` + `manufacturerId`), so every unit stays traceable.

Permission `inventory.adjust.propose` is granted to super_admin, warehouse_manager and inventory_executive.
