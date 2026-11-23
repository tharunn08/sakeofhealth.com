# The four protected shop products

These four products can never be deleted, deactivated, archived, duplicated or given another identity. That holds whoever asks: the admin panel, an import, a bulk script, a sync, the seed, a migration or a redeploy.

| Registry id (never changes) | Name | Page | Category | Price / MRP (₹) when restored |
|---|---|---|---|---|
| `soh-core-multivitamin` | Multivitamin Gummies | `/products/multivitamin.html` | multivitamins | 621 / 690 |
| `soh-core-iron` | Iron Gummies (formerly "Iron + Folic Acid Gummies") | `/products/iron.html` | iron | 581 / 645 |
| `soh-core-curcumin` | Curcumin Gummies | `/products/curcumin.html` | athletic | 576 / 640 |
| `soh-core-probiotic` | Probiotic & Prebiotic Gummies (formerly "Probiotic Gummies") | `/products/probiotic.html` | multivitamins | 626 / 695 |

**Still to confirm by the owner:** the SKU, HSN code and GST rate of each product. `src/seed.js` suggests the SKUs SOH-MV-60, SOH-FE-60, SOH-CU-60 and SOH-PB-60. These are recorded as candidates only, not as facts.

No stock figure is recorded. When a product has to be restored it comes back with no stock number, and a person enters it.

The original IDs from the live site are unknown, because the live `products.json` was lost. If an old file or backup is found, run `node scripts/protected-products.js adopt <file>`. It compares the file with the registry and prints matches and conflicts, without changing anything. The original IDs then go into the registry as `legacyIds`. Records stored under a legacy id are protected too.

## Where the rules are enforced

The rules live in the shop's product store itself, not in a hidden button. `src/services/db.js` wraps the store's `products` collection with `src/services/productProtection.js`, so every write is checked, whatever made it.

| Attempt | Result |
|---|---|
| Delete | refused: `409 protected_delete` (the attempt is logged) |
| Change id, slug, name or category, or a confirmed SKU | refused: `409 protected_identity` |
| Switch off: `active:false`, `upcoming:true`, archived, deleted | refused: `409 protected_active` |
| Change price, MRP, stock, text or images | allowed **with a reason** of 5 or more characters, otherwise `400 reason_required`. The admin screen asks for the reason. |
| Insert a second copy, for example from a CSV import or the seed | refused: `409 protected_duplicate`. A first insert is always stored under the registry id and identity. |

Every change is appended to `CATALOGUE_DIR/protected-products-changes.jsonl`, outside the site folder. Each line records when, who, why, what was used (screen, script or system) and the changed fields before and after. Read it with `node scripts/protected-products.js history [slug]`, or through the admin API `GET /api/admin/products/:id/history` (admin and managers; there is no history screen yet).

## Integrity at start and at every cron run

1. **On start, if a product is missing:** the catalogue guard (`src/services/catalogueGuard.js`) puts it back. It uses the latest good snapshot, or the registry if there is no snapshot.
2. **On start, identity drift:** drift is repaired and logged with `op: repair`.
3. **On start, the integrity check:** if the check still fails in production, the app **does not start**. It exits with code 78 and a message naming the product and the problem.
   - Setting `PROTECTED_PRODUCTS_STRICT=false` lets it start anyway. `/api/health` then reports `"protectedProducts": false`.
   - Use that setting only to reach the admin panel and fix the products.
4. **At every cron run:** the cron job (`scripts/cron/run-jobs.js`) runs the same check. A failure is reported and recorded. A damaged catalogue is never snapshotted, so the last good snapshot stays the restore point.
5. **Before and after a deploy:** run `npm run verify:products`. It exits 0 when all four are present and intact. `node scripts/release-gate.js` also runs this check on a fresh shop.

## Restores and resets

- **Restore from backup:** `npm run restore:shop -- <backup>` refuses a backup that would lose a protected product. See `docs/BACKUP-RESTORE.md`.
- **Development reset:** `npm run reset` refuses production and any folder that is not a development folder. It reseeds through the same store, so the four products come back under their registry ids.

## Tests (all pass, no database needed)

`tests/protected-products.test.js` has 14 tests:

- the registry pin;
- the product pages;
- every store rule;
- reasons and the change log;
- these situations:
  1. restart;
  2. production redeploy from a snapshot;
  3. migrations;
  4. backup and restore through the scripts;
  5. CSV import;
  6. bulk updates;
  7. deletion through the admin API;
  8. the shop-to-trade sync;
- integrity repair;
- the fail-safe start (exit 78, and the `false` override).

Also covering the protected products:

- `tests/catalogue-guard.test.js`: restore from a snapshot or from the registry.
- `tests/jobs-cron.test.js`: a damaged catalogue is reported by the cron run and not snapshotted.
- The browser sweep: the admin catalogue shows four "Protected" badges and no delete button for them.
