/**
 * Read-only online-shop (B2C) feed — OBSERVE ONLY.
 *
 * Reads the shop's orders file (DATA_DIR/orders.json) without loading the shop's code and
 * without ever writing to the shop's data. Each shop order line is recorded once in
 * b2b_b2c_order_postings ('posted', or 'unmapped' when no product has that shop id in
 * b2b_products.b2c_ref); a later cancellation/refund adds a 'reversed' row.
 *
 * It does NOT move or reserve stock, and it is NOT real-time (it runs on a schedule). It cannot
 * stop the shop from overselling. It only shows shop demand next to business stock.
 * Runs only when the business decision "b2c.feed.enabled" is approved as true.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../../db/connection.js');

const REVERSED = ['cancelled', 'canceled', 'refunded', 'returned', 'failed'];

/** Same location rule as the shop (services/db.js), computed here so the shop module is never loaded. */
function shopDataDir() { return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data'); }

function readShopOrders() {
  const file = path.join(shopDataDir(), 'orders.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: 'shop orders file not readable', orders: [] }; }
  try { const a = JSON.parse(raw); return { ok: true, orders: Array.isArray(a) ? a : [] }; } catch (e) { return { ok: false, reason: 'shop orders file is not valid JSON (being written?)', orders: [] }; }
}

/**
 * Any other shop collection, read-only and fresh from disk (the shop rewrites its files whole,
 * by rename, so a read sees either the old or the new file). name: products, customers,
 * accounts, checkouts. Never writes; a missing or half-written file reads as unavailable.
 */
const READABLE = ['orders', 'products', 'customers', 'accounts', 'checkouts'];
function readShop(name) {
  if (READABLE.indexOf(name) === -1) throw new Error('Not a readable shop collection: ' + name);
  let raw;
  try { raw = fs.readFileSync(path.join(shopDataDir(), name + '.json'), 'utf8'); } catch (e) { return { ok: false, reason: 'shop ' + name + ' file not readable', items: [] }; }
  let d;
  try { d = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'shop ' + name + ' file is not valid JSON (being written?)', items: [] }; }
  if (name === 'checkouts') {   // { checkouts: { <gatewayOrderId>: {...} }, events: [] }
    const c = d && d.checkouts && typeof d.checkouts === 'object' ? d.checkouts : {};
    return { ok: true, items: Object.keys(c).map(function (k) { return Object.assign({ gatewayOrderId: k }, c[k]); }) };
  }
  return { ok: true, items: Array.isArray(d) ? d : [] };
}

async function run() {
  const r = readShopOrders();
  if (!r.ok) {
    await db.query("INSERT INTO b2b_b2c_sync_cursor (id, last_run_at, last_result) VALUES (1, UTC_TIMESTAMP(), ?) ON DUPLICATE KEY UPDATE last_run_at = VALUES(last_run_at), last_result = VALUES(last_result)", [r.reason]);
    return { ok: false, reason: r.reason };
  }
  const cur = await db.queryOne('SELECT last_created_at FROM b2b_b2c_sync_cursor WHERE id = 1');
  const since = cur && cur.last_created_at ? cur.last_created_at : '';
  const map = {};
  (await db.query('SELECT id, b2c_ref FROM b2b_products WHERE b2c_ref IS NOT NULL')).forEach(function (p) { map[String(p.b2c_ref)] = Number(p.id); });
  let posted = 0, unmapped = 0, reversed = 0, newest = since;
  const recentCut = new Date(Date.now() - 45 * 86400000).toISOString();
  for (const o of r.orders) {
    const created = String(o.createdAt || '');
    const orderId = String(o._id || o.id || o.orderId || '').slice(0, 64);
    if (!orderId) continue;
    const status = String(o.status || '').toLowerCase().slice(0, 30);
    const items = Array.isArray(o.items) ? o.items : [];
    if (created > since) {
      if (created > newest) newest = created;
      for (const it of items) {
        const ref = String(it.id == null ? '' : it.id).slice(0, 64), qty = Math.max(0, Math.floor(Number(it.qty) || 0));
        if (!ref || !qty) continue;
        const pid = map[ref] || null;
        const ins = await db.query('INSERT IGNORE INTO b2b_b2c_order_postings (b2c_order_id, b2c_order_no, b2c_item_ref, product_id, qty, b2c_status, posting) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [orderId, String(o.orderId || '').slice(0, 40), ref, pid, qty, status, pid ? 'posted' : 'unmapped']);
        if (ins.affectedRows) { if (pid) posted++; else unmapped++; }
      }
    }
    // cancellations arrive later: look back 45 days
    if (created >= recentCut && REVERSED.indexOf(status) !== -1) {
      for (const it of items) {
        const ref = String(it.id == null ? '' : it.id).slice(0, 64);
        const was = await db.queryOne("SELECT product_id, qty FROM b2b_b2c_order_postings WHERE b2c_order_id = ? AND b2c_item_ref = ? AND posting = 'posted'", [orderId, ref]);
        if (!was) continue;
        const ins = await db.query("INSERT IGNORE INTO b2b_b2c_order_postings (b2c_order_id, b2c_order_no, b2c_item_ref, product_id, qty, b2c_status, posting) VALUES (?, ?, ?, ?, ?, ?, 'reversed')",
          [orderId, String(o.orderId || '').slice(0, 40), ref, was.product_id, was.qty, status]);
        if (ins.affectedRows) reversed++;
      }
    }
  }
  const result = 'posted ' + posted + ', unmapped ' + unmapped + ', reversed ' + reversed;
  await db.query('INSERT INTO b2b_b2c_sync_cursor (id, last_created_at, last_run_at, last_result) VALUES (1, ?, UTC_TIMESTAMP(), ?) ON DUPLICATE KEY UPDATE last_created_at = VALUES(last_created_at), last_run_at = VALUES(last_run_at), last_result = VALUES(last_result)',
    [newest || null, result]);
  return { ok: true, posted: posted, unmapped: unmapped, reversed: reversed, cursor: newest };
}

/** Shop demand next to business stock (read-only report). */
async function report(days) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const rows = await db.query("SELECT p.id, p.sku, p.name, SUM(CASE WHEN x.posting = 'posted' THEN CAST(x.qty AS SIGNED) WHEN x.posting = 'reversed' THEN -CAST(x.qty AS SIGNED) ELSE 0 END) AS shop_units, " +
    "(SELECT COALESCE(SUM(st.qty_available), 0) FROM b2b_stock st JOIN b2b_warehouses w ON w.id = st.warehouse_id WHERE st.product_id = p.id AND w.owner_account_id IS NULL) AS business_available " +
    'FROM b2b_b2c_order_postings x JOIN b2b_products p ON p.id = x.product_id WHERE x.created_at >= UTC_TIMESTAMP() - INTERVAL ' + d + ' DAY GROUP BY p.id, p.sku, p.name ORDER BY shop_units DESC LIMIT 500');   // d is a validated integer
  const unmapped = await db.query("SELECT b2c_item_ref, COUNT(*) AS line_count, SUM(qty) AS units FROM b2b_b2c_order_postings WHERE posting = 'unmapped' GROUP BY b2c_item_ref ORDER BY units DESC LIMIT 100");
  const cur = await db.queryOne('SELECT last_created_at, last_run_at, last_result FROM b2b_b2c_sync_cursor WHERE id = 1');
  return { days: d, items: rows, unmapped: unmapped, lastRun: cur || null,
    warning: 'Observe only and delayed: shop sales are NOT deducted from business stock, and this cannot prevent shop overselling.' };
}

module.exports = { run, report, readShopOrders, readShop, shopDataDir, READABLE };
