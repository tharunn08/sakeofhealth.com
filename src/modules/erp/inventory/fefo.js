/**
 * Batch picking for sales from a stock point (shop orders, event counters): First-Expiry-
 * First-Out over the existing per-warehouse batch rows (b2b_batches), the same rule as B2B
 * packing. Expired batches are never sold. Units that were received without batch details are
 * returned as one pick with batchId null, so every unit still has a ledger row.
 *
 * pick() only changes b2b_batches.qty_on_hand; the caller posts the ledger rows (one per pick,
 * with the batch and lot) through ledger.move, in the same transaction.
 */
'use strict';
const { fail } = require('../lib/http.js');

/** Take qty units of a product at a warehouse. Returns [{ batchId, lotId, batchNo, expiryDate, qty }]. */
async function pick(tx, warehouseId, productId, qty) {
  let remaining = Number(qty);
  const batches = await tx.query(
    "SELECT id, lot_id, batch_no, expiry_date, qty_on_hand FROM b2b_batches WHERE warehouse_id = ? AND product_id = ? AND status = 'active' AND qty_on_hand > 0 " +
    'AND (expiry_date IS NULL OR expiry_date > UTC_DATE()) ORDER BY (expiry_date IS NULL), expiry_date, id FOR UPDATE', [warehouseId, productId]);
  const picks = [];
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(b.qty_on_hand));
    await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand - ?, status = IF(qty_on_hand = 0, 'depleted', status) WHERE id = ?", [take, b.id]);
    picks.push({ batchId: Number(b.id), lotId: b.lot_id == null ? null : Number(b.lot_id), batchNo: b.batch_no, expiryDate: b.expiry_date || null, qty: take });
    remaining -= take;
  }
  if (remaining > 0) {
    // Units without batch details may be sold only if they really exist outside every batch:
    // units sitting in expired (or not yet swept) batches are never sold as "no batch".
    // batch figures (qty_on_hand) cover units not yet packed: available + reserved. The batches
    // picked above are already reduced here, while 'available' still includes them.
    const st = await tx.queryOne('SELECT qty_available, qty_reserved FROM b2b_stock WHERE warehouse_id = ? AND product_id = ? FOR UPDATE', [warehouseId, productId]);
    const inBatches = await tx.queryOne("SELECT COALESCE(SUM(qty_on_hand), 0) AS n FROM b2b_batches WHERE warehouse_id = ? AND product_id = ? AND status IN ('active','expired')", [warehouseId, productId]);
    const taken = picks.reduce(function (n, p) { return n + p.qty; }, 0);
    const unbatched = (st ? Number(st.qty_available) + Number(st.qty_reserved) : 0) - Number(inBatches.n) - taken;
    if (unbatched < remaining) throw fail(409, 'Not enough sellable stock (some units are expired or past their date)', 'insufficient_stock', { productId: Number(productId), short: remaining - Math.max(0, unbatched) });
    picks.push({ batchId: null, lotId: null, batchNo: null, expiryDate: null, qty: remaining });
  }
  return picks;
}

/**
 * Units coming back to the same batches (a cancelled order, a resaleable return): 'available'
 * adds to qty_on_hand (and re-activates a depleted batch); 'quarantine' to qty_quarantine (held
 * for inspection); 'damaged' / 'expired' change no batch figure (the ledger bucket records them).
 */
async function putBack(tx, picks, bucket) {
  for (const p of picks) {
    if (!p.batchId || !p.qty) continue;
    if (bucket === 'available') await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand + ?, status = IF(status = 'depleted', 'active', status) WHERE id = ?", [p.qty, p.batchId]);
    else if (bucket === 'quarantine') await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine + ? WHERE id = ?', [p.qty, p.batchId]);
  }
}

/** Split picks for a partial quantity (a return of 2 out of 5 units): latest-expiry batches come back first. */
function takeFrom(picks, qty) {
  const out = [];
  let remaining = Number(qty);
  for (let i = picks.length - 1; i >= 0 && remaining > 0; i--) {
    const t = Math.min(remaining, Number(picks[i].qty));
    if (t > 0) out.push(Object.assign({}, picks[i], { qty: t }));
    remaining -= t;
  }
  return out;
}

/**
 * Daily: units of batches past their expiry date leave 'available' for 'expired' (one ledger row
 * per batch, keyed by batch and date, so a repeat run moves nothing twice). Units already
 * reserved or allocated stay where they are and are reported. Nothing is created or destroyed.
 */
async function expireBatches(db, ledger) {
  const due = await db.query("SELECT id, warehouse_id, product_id, lot_id, batch_no, expiry_date, qty_on_hand FROM b2b_batches WHERE status = 'active' AND qty_on_hand > 0 " +
    'AND expiry_date IS NOT NULL AND expiry_date <= UTC_DATE() ORDER BY id LIMIT 500');
  let moved = 0, units = 0, held = 0;
  for (const b of due) {
    await db.transaction(async function (tx) {
      const row = await tx.queryOne("SELECT qty_on_hand, status FROM b2b_batches WHERE id = ? FOR UPDATE", [b.id]);
      if (!row || row.status !== 'active' || Number(row.qty_on_hand) <= 0) return;
      const st = await tx.queryOne('SELECT qty_available FROM b2b_stock WHERE warehouse_id = ? AND product_id = ? FOR UPDATE', [b.warehouse_id, b.product_id]);
      const qty = Math.min(Number(row.qty_on_hand), st ? Number(st.qty_available) : 0);
      if (qty > 0) {
        const r = await ledger.move(tx, { warehouseId: b.warehouse_id, productId: b.product_id, batchId: b.id, lotId: b.lot_id, type: 'expiry', qty: qty, from: 'available', to: 'expired',
          refType: 'batch', refId: String(b.id), reason: 'batch ' + b.batch_no + ' expired', actor: { type: 'system', label: 'expiry sweep' },
          idemKey: 'expiry:' + b.id + ':' + String(b.expiry_date instanceof Date ? b.expiry_date.toISOString().slice(0, 10) : b.expiry_date).slice(0, 10) });
        if (r === true) { moved++; units += qty; }
      }
      held += Number(row.qty_on_hand) - qty;
      await tx.query("UPDATE b2b_batches SET status = 'expired', qty_on_hand = qty_on_hand - ? WHERE id = ?", [qty, b.id]);
    });
  }
  return { batches: moved, units: units, stillReservedOrAllocated: held };
}

module.exports = { pick, putBack, takeFrom, expireBatches };
