/**
 * Indexes found by load-testing with 10,000 products, 13,000 business
 * accounts and 100,000 orders (see docs/TESTING.md → Performance).
 * Each index is only added if it is not already there, so this is safe to
 * re-run.
 */
const INDEXES = [
  // Admin order search by delivery phone number (prefix match).
  ['b2b_orders', 'ix_b2b_orders_phone', '(ship_phone)'],
  // "Orders for this buyer in this status" — the retailer / distributor order tabs.
  ['b2b_orders', 'ix_b2b_orders_buyer_status', '(buyer_account_id, status, id)'],
  // Outstanding per seller (distributor receivables).
  ['b2b_orders', 'ix_b2b_orders_seller_pay', '(seller_account_id, payment_status, status)'],
];

async function up(conn) {
  for (const [table, name, cols] of INDEXES) {
    const [rows] = await conn.raw.query(
      'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [table, name]);
    if (rows.length) continue;
    await conn.raw.query('ALTER TABLE `' + table + '` ADD INDEX `' + name + '` ' + cols);
  }
}

module.exports = { up };
