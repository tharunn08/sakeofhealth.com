/**
 * ERP stock write path. Same tables and the same guarded-UPDATE rule as the existing
 * B2B inventory (b2b_stock buckets + append-only b2b_stock_movements), plus:
 *   - the quarantine bucket (migration 008: b2b_stock.qty_quarantine, b2b_batches.qty_quarantine)
 *   - the lot on every ledger row.
 * A bucket can never go negative: the UPDATE only matches when enough is there.
 */
'use strict';
const { fail } = require('../lib/http.js');

const BUCKETS = ['available', 'reserved', 'allocated', 'in_transit', 'damaged', 'expired', 'quarantine'];

const ACTOR_TYPES = ['admin', 'business', 'system'];

/** A movement that was already posted under the same key (ledger rows are never repeated). */
function duplicate(key) { return fail(409, 'This stock movement was already posted (' + key + ')', 'duplicate_movement'); }

/**
 * THE single stock write path (Milestone 3b.1): every module — B2B orders, field sales,
 * procurement, transfers, counts, recalls, returns, adjustments — posts through here.
 *
 * m = { warehouseId, productId, batchId?, lotId?, type, qty, from?, to?, refType?, refId?,
 *       reason?, actor?, idemKey? }
 * Returns true when posted, false (and writes nothing) when `from` does not hold enough.
 *
 * idemKey (needs migration 017): a key for this exact business event, e.g. 'grn:12:item:3:available'.
 * A key that was already posted returns 'duplicate' (truthy) and moves nothing; two concurrent
 * posts with one key cannot both land: the unique index refuses the second and its transaction
 * rolls back, bucket change included.
 */
async function move(tx, m) {
  const qty = Number(m.qty);
  if (!Number.isInteger(qty) || qty <= 0) throw fail(400, 'Quantity must be a positive whole number');
  [m.from, m.to].forEach(function (b) { if (b && BUCKETS.indexOf(b) === -1) throw new Error('Unknown stock bucket ' + b); });
  if (!m.from && !m.to) throw new Error('A stock movement needs a from or to bucket');
  const key = m.idemKey ? String(m.idemKey).slice(0, 120) : null;
  if (key && await tx.queryOne('SELECT id FROM b2b_stock_movements WHERE idem_key = ?', [key])) return 'duplicate';
  if (!m.from) {
    await tx.query('INSERT INTO b2b_stock (warehouse_id, product_id, qty_' + m.to + ') VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE qty_' + m.to + ' = qty_' + m.to + ' + VALUES(qty_' + m.to + ')',
      [m.warehouseId, m.productId, qty]);
  } else {
    const sets = ['qty_' + m.from + ' = qty_' + m.from + ' - ?'], params = [qty];
    if (m.to) { sets.push('qty_' + m.to + ' = qty_' + m.to + ' + ?'); params.push(qty); }
    params.push(m.warehouseId, m.productId, qty);
    const r = await tx.query('UPDATE b2b_stock SET ' + sets.join(', ') + ' WHERE warehouse_id = ? AND product_id = ? AND qty_' + m.from + ' >= ?', params);
    if (r.affectedRows !== 1) return false;
  }
  const a = m.actor || {};
  const cols = ['warehouse_id', 'product_id', 'batch_id', 'lot_id', 'movement_type', 'qty', 'from_status', 'to_status', 'ref_type', 'ref_id', 'reason', 'actor_type', 'actor_label'];
  const vals = [m.warehouseId, m.productId, m.batchId || null, m.lotId || null, m.type, qty, m.from || null, m.to || null, m.refType || null, m.refId || null,
    m.reason ? String(m.reason).slice(0, 255) : null, ACTOR_TYPES.indexOf(a.type) !== -1 ? a.type : (a.type === 'staff' ? 'admin' : 'system'),
    a.label || (a.id ? 'erp-staff:' + a.id : 'system')];
  if (key) { cols.push('idem_key'); vals.push(key); }
  try {
    await tx.query('INSERT INTO b2b_stock_movements (' + cols.join(', ') + ') VALUES (' + cols.map(function () { return '?'; }).join(', ') + ')', vals);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' && key) throw duplicate(key);
    throw e;
  }
  return true;
}

/** Must succeed (stock already checked under lock); a false means the ledger is out of step. */
async function mustMove(tx, m) {
  const r = await move(tx, m);
  // A keyed event already posted: stop the whole action (and its batch updates) instead of repeating it.
  if (r === 'duplicate') throw duplicate(m.idemKey);
  if (!r) throw fail(409, 'Not enough stock in ' + m.from + ' for product ' + m.productId + ' at warehouse ' + m.warehouseId, 'insufficient_stock');
}

/** The per-warehouse batch row for a lot (existing b2b_batches), created when first needed. */
async function batchFor(tx, warehouseId, lot) {
  const b = await tx.queryOne('SELECT id, lot_id FROM b2b_batches WHERE warehouse_id = ? AND product_id = ? AND batch_no = ? FOR UPDATE', [warehouseId, lot.product_id, lot.batch_no]);
  if (b) {
    if (b.lot_id && Number(b.lot_id) !== Number(lot.id)) {
      throw fail(409, 'Batch ' + lot.batch_no + ' of this product already exists at this warehouse from another manufacturer; resolve it before receiving', 'batch_conflict');
    }
    if (!b.lot_id) await tx.query('UPDATE b2b_batches SET lot_id = ? WHERE id = ?', [lot.id, b.id]);
    return Number(b.id);
  }
  const r = await tx.query("INSERT INTO b2b_batches (warehouse_id, product_id, batch_no, mfg_date, expiry_date, qty_on_hand, status, lot_id, qty_quarantine) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, 0)",
    [warehouseId, lot.product_id, lot.batch_no, lot.mfg_date, lot.expiry_date, lot.id]);
  return Number(r.insertId);
}

module.exports = { move, mustMove, batchFor, BUCKETS, ACTOR_TYPES };
