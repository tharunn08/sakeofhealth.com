/**
 * Gap-free document numbers per key and financial year (b2b_sequences, row lock).
 * Called inside the business transaction, so a rolled-back document gives its number back.
 */
'use strict';
function fy(d) {
  d = d || new Date();
  const ist = new Date(d.getTime() + 330 * 60000);
  const y = ist.getUTCFullYear(), start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return String(start).slice(2) + String(start + 1).slice(2);
}
async function next(tx, prefix, width) {
  const key = 'erp:' + prefix + ':' + fy();
  await tx.query('INSERT IGNORE INTO b2b_sequences (seq_key, next_val) VALUES (?, 1)', [key]);
  const row = await tx.queryOne('SELECT next_val FROM b2b_sequences WHERE seq_key = ? FOR UPDATE', [key]);
  await tx.query('UPDATE b2b_sequences SET next_val = next_val + 1 WHERE seq_key = ?', [key]);
  return prefix + '/' + fy() + '/' + String(row.next_val).padStart(width || 5, '0');
}
module.exports = { next, fy };
