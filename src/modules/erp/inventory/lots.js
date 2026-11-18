/**
 * Lot identity = product + manufacturer + normalised batch number (unique in b2b_lots).
 * "B-12/24", "b 12 24" and "B1224" are the same batch of the same maker's product.
 */
'use strict';
const { fail } = require('../lib/http.js');

function normBatch(b) { return String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 60); }

async function upsert(tx, o) {
  const batchNo = String(o.batchNo || '').trim().slice(0, 60);
  const norm = normBatch(batchNo);
  if (!norm) throw fail(400, 'Batch number is required');
  const existing = await tx.queryOne('SELECT * FROM b2b_lots WHERE product_id = ? AND manufacturer_vendor_id = ? AND batch_no_norm = ? FOR UPDATE', [o.productId, o.manufacturerId, norm]);
  if (existing) {
    // The same batch must carry the same dates; a different expiry means a data error or a fake.
    if (o.expiry && existing.expiry_date && fmt(existing.expiry_date) !== o.expiry) {
      throw fail(409, 'Batch ' + batchNo + ' was received before with expiry ' + fmt(existing.expiry_date) + ', not ' + o.expiry, 'lot_mismatch');
    }
    if (existing.status === 'recalled') throw fail(409, 'Batch ' + batchNo + ' is under recall and cannot be received', 'lot_recalled');
    return existing;
  }
  const r = await tx.query("INSERT INTO b2b_lots (product_id, manufacturer_vendor_id, batch_no, batch_no_norm, mfg_date, expiry_date, mrp, first_grn_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'released')",
    [o.productId, o.manufacturerId, batchNo, norm, o.mfg || null, o.expiry || null, o.mrp == null ? null : String(o.mrp), o.grnId || null]);
  return tx.queryOne('SELECT * FROM b2b_lots WHERE id = ?', [r.insertId]);
}
function fmt(d) { if (!d) return null; if (d instanceof Date) return d.toISOString().slice(0, 10); return String(d).slice(0, 10); }

module.exports = { normBatch, upsert, fmt };
