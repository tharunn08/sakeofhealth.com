/**
 * Online-shop stock (3b.3 shadow, 3b.4 enforcement) on the one central ledger.
 *
 * Mode (business setting inventory.b2c_stock_mode, changed through an approval):
 *   off      — the shop behaves exactly as today; nothing here runs (default).
 *   shadow   — the shop is never refused and the ledger is never moved. Every checkout and order
 *              is replayed and recorded as what enforcement WOULD have done (mode 'shadow' rows),
 *              and every difference becomes a discrepancy for staff.
 *   enforce  — stock is held at Pay (refused with the shop's own words when short; MySQL down
 *              before payment → "temporarily unavailable", nothing charged), committed before the
 *              order is created, deducted when it leaves, released or returned when cancelled.
 *
 * Lifecycle of a shop order line (b2b_b2c_order_stock):
 *   allocated (available → allocated, batches picked earliest-expiry-first)
 *   → sold      when the shop marks it out_for_delivery or delivered (allocated → out)
 *   → released  cancelled before it left (allocated → available, batches restored)
 *   → returned  cancelled after it left, or a return staff record (→ quarantine for inspection,
 *               or damaged / expired)
 *   short       paid but no stock: an exception with a refund (decision 3), never a negative.
 *
 * Every ledger row carries a key built from the gateway order (or shop order) and product, so a
 * browser, a webhook and the catch-up job can all see the same order and it moves stock once.
 * The shop's own files are only read (readonly-adapter.js); nothing here writes them.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const settings = require('../core/settings.js');
const audit = require('../core/audit.js');
const ledger = require('../inventory/ledger.js');
const fefo = require('../inventory/fefo.js');
const adapter = require('../b2cfeed/readonly-adapter.js');
const { fail, posId } = require('../lib/http.js');

const SYSTEM = { type: 'system', id: null, role: 'system', label: 'shop stock' };
const LEFT = ['out_for_delivery', 'delivered'];
const MODES = ['off', 'shadow', 'enforce'];

/**
 * Current configuration. A setting that is missing or invalid = off (the shop as today).
 * A database error is NOT treated as "off": it is thrown, so the front layer can fail closed when
 * it last saw enforcement on (see front.js cfg()).
 */
async function config() {
  const [mode, wh, minutes, auto] = await Promise.all(['inventory.b2c_stock_mode', 'inventory.b2c_warehouse_id', 'inventory.b2c_hold_minutes', 'inventory.b2c_auto_refund']
    .map(function (k) { return settings.get(k); }));
  const warehouseId = posId(wh);
  const m = MODES.indexOf(mode) !== -1 && warehouseId ? mode : 'off';
  return { mode: m, warehouseId: m === 'off' ? null : warehouseId, holdMinutes: Number.isInteger(minutes) && minutes >= 5 && minutes <= 120 ? minutes : 30, autoRefund: auto === true };
}
function liveMode(cfg) { return cfg.mode === 'enforce' ? 'live' : 'shadow'; }

/** Shop cart lines → business products (by b2b_products.b2c_ref). */
async function mapLines(q, items) {
  const lines = [], unmapped = [];
  const want = {};
  (Array.isArray(items) ? items : []).forEach(function (it) {
    const ref = String(it && (it.id != null ? it.id : it.productId) || '').slice(0, 64);
    const qty = Math.floor(Number(it && (it.qty != null ? it.qty : it.quantity)) || 0);
    if (ref && qty > 0) want[ref] = (want[ref] || 0) + qty;
  });
  const refs = Object.keys(want);
  if (!refs.length) return { lines: lines, unmapped: unmapped };
  const rows = await (q || db).query('SELECT id, b2c_ref, name FROM b2b_products WHERE b2c_ref IN (' + db.placeholders(refs) + ')', refs);
  const by = {}; rows.forEach(function (r) { by[String(r.b2c_ref)] = r; });
  refs.forEach(function (ref) {
    if (by[ref]) lines.push({ ref: ref, productId: Number(by[ref].id), name: by[ref].name, qty: want[ref] });
    else unmapped.push({ ref: ref, qty: want[ref] });
  });
  return { lines: lines, unmapped: unmapped };
}

/**
 * Units of a product the shop may still promise: the ledger's available units, minus live holds
 * that have not expired (and, in shadow, minus what shadow already allocated or held — those
 * units were never really taken, so shadow keeps its own running count).
 */
async function sellable(tx, cfg, productId, exceptRef, lock) {
  const st = await tx.queryOne('SELECT qty_available FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?' + (lock ? ' FOR UPDATE' : ''), [cfg.warehouseId, productId]);
  const avail = st ? Number(st.qty_available) : 0;
  const mode = liveMode(cfg);
  const held = await tx.queryOne("SELECT COALESCE(SUM(qty), 0) AS n FROM b2b_stock_reservations WHERE channel = 'b2c' AND mode = ? AND product_id = ? AND status = 'held' " +
    'AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP()) AND source_ref <> ?', [mode, productId, exceptRef || '']);
  let shadowTaken = 0;
  if (mode === 'shadow') {
    const t = await tx.queryOne("SELECT COALESCE(SUM(qty), 0) AS n FROM b2b_b2c_order_stock WHERE mode = 'shadow' AND product_id = ? AND stage IN ('allocated','sold')", [productId]);
    shadowTaken = Number(t.n);
  }
  return avail - Number(held.n) - shadowTaken;
}

function shopWords(line, left) {
  return left > 0 ? 'Only ' + left + ' of "' + line.name + '" left in stock.' : '"' + line.name + '" is out of stock.';
}

async function discrepancy(q, kind, ref, d) {
  const key = kind + ':' + ref;
  await (q || db).query('INSERT INTO b2b_b2c_discrepancies (kind, ref, product_id, shop_qty, ledger_qty, details, open_key) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP, shop_qty = VALUES(shop_qty), ledger_qty = VALUES(ledger_qty), details = VALUES(details)',
    [kind, String(ref).slice(0, 80), d.productId || null, d.shopQty == null ? null : d.shopQty, d.ledgerQty == null ? null : d.ledgerQty, d.details ? String(d.details).slice(0, 500) : null, key.slice(0, 120)]);
}

/**
 * At Pay: hold every line for holdMinutes. ref identifies this checkout ('idem:<key>' or
 * 'pay:<uuid>'; later re-keyed to 'gw:<gateway order id>'). A repeated ref refreshes its holds.
 * enforce → { ok:false, message } when any line is short (nothing is held).
 * shadow  → always ok; a shortage is recorded as 'would_refuse'.
 */
async function hold(ref, items, cfg) {
  const mode = liveMode(cfg);
  return db.transaction(async function (tx) {
    const m = await mapLines(tx, items);
    for (const u of m.unmapped) await discrepancy(tx, 'unmapped_product', u.ref, { details: 'A shop product with no business product mapped (b2b_products.b2c_ref); its stock cannot be checked' });
    const lines = m.lines.slice().sort(function (a, b) { return a.productId - b.productId; });   // lock in one order: no deadlocks
    const short = [];
    for (const l of lines) {
      const left = await sellable(tx, cfg, l.productId, ref, true);
      if (left < l.qty) {
        short.push({ line: l, left: Math.max(0, left) });
        if (mode === 'shadow') await discrepancy(tx, 'would_refuse', ref + ':' + l.productId, { productId: l.productId, ledgerQty: Math.max(0, left), shopQty: l.qty,
          details: 'Enforcement would have refused this checkout: ' + l.qty + ' wanted, ' + Math.max(0, left) + ' sellable' });
      }
    }
    if (short.length && mode === 'live') {
      const e = new Error('short'); e.short = short; throw e;
    }
    for (const l of lines) {
      await tx.query("INSERT INTO b2b_stock_reservations (warehouse_id, product_id, qty, channel, mode, source_ref, status, expires_at) VALUES (?, ?, ?, 'b2c', ?, ?, 'held', UTC_TIMESTAMP() + INTERVAL ? MINUTE) " +
        "ON DUPLICATE KEY UPDATE qty = IF(status = 'held', VALUES(qty), qty), expires_at = IF(status = 'held', VALUES(expires_at), expires_at)",
        [cfg.warehouseId, l.productId, l.qty, mode, String(ref).slice(0, 80), cfg.holdMinutes]);
    }
    return { ok: true, held: lines.length, unmapped: m.unmapped.length, short: short.length };
  }).catch(function (e) {
    if (e.short) return { ok: false, message: e.short.map(function (s) { return shopWords(s.line, s.left); }).join(' '), short: e.short.map(function (s) { return { productId: s.line.productId, wanted: s.line.qty, left: s.left }; }) };
    throw e;
  });
}

/** The gateway answered Pay: the holds now belong to that gateway order. */
async function bind(ref, gatewayOrderId, cfg) {
  await db.query("UPDATE b2b_stock_reservations SET source_ref = ? WHERE channel = 'b2c' AND mode = ? AND source_ref = ? AND status = 'held'",
    ['gw:' + String(gatewayOrderId).slice(0, 60), liveMode(cfg), String(ref).slice(0, 80)]);
}
/** Pay failed (gateway error, bad cart): give the units back now. */
async function release(ref, cfg) {
  await db.query("UPDATE b2b_stock_reservations SET status = 'released' WHERE channel = 'b2c' AND mode = ? AND source_ref = ? AND status = 'held'", [liveMode(cfg), String(ref).slice(0, 80)]);
}

/**
 * Commit an order's lines: allocate the held units (or, without a hold, whatever is sellable
 * now). o = { orderKey ('gw:<id>' or the shop order id), shopOrderNo?, gatewayOrderId?, items }.
 * Idempotent per (mode, order, product). Returns { committed, short: [lines], already }.
 */
async function commit(tx, cfg, o) {
  const mode = liveMode(cfg);
  const m = await mapLines(tx, o.items);
  const lines = m.lines.slice().sort(function (a, b) { return a.productId - b.productId; });
  const out = { committed: 0, short: [], already: 0, unmapped: m.unmapped.length };
  for (const l of lines) {
    const have = await tx.queryOne('SELECT id, stage FROM b2b_b2c_order_stock WHERE mode = ? AND product_id = ? AND (shop_order_id = ? OR (gateway_order_id IS NOT NULL AND gateway_order_id = ?)) FOR UPDATE',
      [mode, l.productId, o.orderKey, o.gatewayOrderId || '']);
    if (have) { out.already++; continue; }
    const holdRow = o.gatewayOrderId ? await tx.queryOne("SELECT id, qty FROM b2b_stock_reservations WHERE channel = 'b2c' AND mode = ? AND source_ref = ? AND product_id = ? AND status = 'held' FOR UPDATE",
      [mode, 'gw:' + o.gatewayOrderId, l.productId]) : null;
    const left = await sellable(tx, cfg, l.productId, holdRow ? 'gw:' + o.gatewayOrderId : null, true);
    // this order's own holds are left out of `left`, so held units count as this order's
    const covered = left >= l.qty;
    let stage = 'allocated', picks = null;
    if (!covered) {
      stage = 'short';
      out.short.push({ productId: l.productId, name: l.name, wanted: l.qty, left: Math.max(0, left) });
      if (mode === 'shadow') await discrepancy(tx, 'would_refuse', o.orderKey + ':' + l.productId, { productId: l.productId, ledgerQty: Math.max(0, left), shopQty: l.qty,
        details: 'Paid order with no stock in the ledger: enforcement would have refunded it' });
    } else if (mode === 'live') {
      picks = await fefo.pick(tx, cfg.warehouseId, l.productId, l.qty);
    }
    if (holdRow) await tx.query("UPDATE b2b_stock_reservations SET status = ?, payment_seen_at = UTC_TIMESTAMP() WHERE id = ?", [stage === 'short' ? 'short' : 'committed', holdRow.id]);
    // The order line first: its number is the stock ledger's reference (that column holds numbers; the shop's
    // order key is text and goes in the reason).
    const line = await tx.query('INSERT INTO b2b_b2c_order_stock (mode, shop_order_id, shop_order_no, gateway_order_id, product_id, warehouse_id, qty, stage, picks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [mode, String(o.orderKey).slice(0, 64), o.shopOrderNo ? String(o.shopOrderNo).slice(0, 40) : null, o.gatewayOrderId ? String(o.gatewayOrderId).slice(0, 64) : null,
        l.productId, cfg.warehouseId, l.qty, stage, picks ? JSON.stringify(picks) : null]);
    for (const p of (picks || [])) {
      await ledger.mustMove(tx, { warehouseId: cfg.warehouseId, productId: l.productId, batchId: p.batchId, lotId: p.lotId, type: 'allocation', qty: p.qty,
        from: 'available', to: 'allocated', refType: 'b2c_order', refId: Number(line.insertId), reason: ('shop order ' + o.orderKey).slice(0, 255), actor: SYSTEM,
        idemKey: 'b2c:' + o.orderKey + ':' + l.productId + ':alloc:' + (p.batchId || 'nb') });
    }
    if (stage !== 'short') out.committed++;
  }
  return out;
}

/** A paid checkout that could not get stock: one exception per checkout (refund follows). */
async function paidShort(q, ref, info) {
  await (q || db).query("INSERT INTO b2b_b2c_exceptions (checkout_ref, gateway_order_id, payment_id, kind, amount, details_json) VALUES (?, ?, ?, 'paid_short', ?, ?) " +
    'ON DUPLICATE KEY UPDATE payment_id = COALESCE(payment_id, VALUES(payment_id))',
    [String(ref).slice(0, 80), info.gatewayOrderId || null, info.paymentId || null, info.amount || 0, JSON.stringify({ short: info.short || [], source: info.source || null })]);
}

/** Browser path, before the shop creates the order: commit now, or stop the order (paid but short). */
async function commitAtPlace(cfg, gatewayOrderId, paymentId) {
  const checkout = adapter.readShop('checkouts').items.find(function (c) { return c.gatewayOrderId === gatewayOrderId; });
  if (!checkout || !checkout.quote) return { unknown: true };   // the shop will refuse it itself
  if (checkout.orderId) return { already: true };                 // order exists: the job reconciles it
  const items = (checkout.quote.lines || []).map(function (l) { return { id: l.id || l.productId, qty: l.qty }; });
  const r = await db.transaction(function (tx) { return commit(tx, cfg, { orderKey: 'gw:' + gatewayOrderId, gatewayOrderId: gatewayOrderId, items: items }); });
  if (r.short.length && liveMode(cfg) === 'live') {
    await paidShort(null, 'gw:' + gatewayOrderId, { gatewayOrderId: gatewayOrderId, paymentId: paymentId, amount: checkout.amountPaise ? Number(checkout.amountPaise) / 100 : 0, short: r.short, source: 'browser' });
  }
  return r;
}

/** Move an order line along when the shop's status changes (idempotent by stage). */
async function advance(tx, cfg, row, shopStatus) {
  if (row.mode !== 'live') {
    const next = shopStatus === 'cancelled' ? (row.stage === 'sold' ? 'returned' : 'released') : (LEFT.indexOf(shopStatus) !== -1 ? 'sold' : null);
    if (next && next !== row.stage && (row.stage === 'allocated' || (row.stage === 'sold' && next === 'returned'))) {
      await tx.query('UPDATE b2b_b2c_order_stock SET stage = ?, shop_status = ? WHERE id = ?', [next, shopStatus, row.id]);
      return next;
    }
    return null;
  }
  const picks = row.picks_json ? JSON.parse(row.picks_json) : [];
  const key = 'b2c:line:' + row.id;   // stable for this order line, whichever path sees it
  if (LEFT.indexOf(shopStatus) !== -1 && row.stage === 'allocated') {
    for (const p of picks) await ledger.mustMove(tx, { warehouseId: row.warehouse_id, productId: row.product_id, batchId: p.batchId, lotId: p.lotId, type: 'b2c_sale', qty: p.qty,
      from: 'allocated', refType: 'b2c_order', refId: Number(row.id), reason: ('shop order ' + shopRef(row)).slice(0, 255), actor: SYSTEM, idemKey: key + ':sale:' + (p.batchId || 'nb') });
    await tx.query("UPDATE b2b_b2c_order_stock SET stage = 'sold', shop_status = ? WHERE id = ?", [shopStatus, row.id]);
    return 'sold';
  }
  if (shopStatus === 'cancelled' && row.stage === 'allocated') {
    for (const p of picks) await ledger.mustMove(tx, { warehouseId: row.warehouse_id, productId: row.product_id, batchId: p.batchId, lotId: p.lotId, type: 'release', qty: p.qty,
      from: 'allocated', to: 'available', refType: 'b2c_order', refId: Number(row.id), reason: ('shop order ' + shopRef(row) + ' cancelled before it left').slice(0, 255), actor: SYSTEM, idemKey: key + ':release:' + (p.batchId || 'nb') });
    await fefo.putBack(tx, picks, 'available');
    await tx.query("UPDATE b2b_b2c_order_stock SET stage = 'released', shop_status = ? WHERE id = ?", [shopStatus, row.id]);
    return 'released';
  }
  if (shopStatus === 'cancelled' && row.stage === 'sold') {
    await returnLine(tx, SYSTEM, row, picks, 'quarantine', 'shop order cancelled after it left: goods come back for inspection', key + ':return');
    return 'returned';
  }
  return null;
}

/** How a person finds the order: the shop's order number when known, else its id or checkout key. */
function shopRef(row) { return String(row.ref_id || row.shop_order_no || row.shop_order_id); }

async function returnLine(tx, actor, row, picks, bucket, reason, keyBase) {
  for (const p of picks) await ledger.mustMove(tx, { warehouseId: row.warehouse_id, productId: row.product_id, batchId: p.batchId, lotId: p.lotId, type: 'b2c_reversal', qty: p.qty,
    to: bucket, refType: 'b2c_order', refId: Number(row.id), reason: ('shop order ' + shopRef(row) + ': ' + reason).slice(0, 255), actor: actor, idemKey: keyBase + ':' + (p.batchId || 'nb') });
  await fefo.putBack(tx, picks, bucket);
  await tx.query("UPDATE b2b_b2c_order_stock SET stage = 'returned' WHERE id = ?", [row.id]);
}

/**
 * The catch-up job (every minute while the mode is not off): every shop order is committed
 * once (the webhook path, admin-created orders, anything the browser path missed), status
 * changes move it along, expired holds are released, and the shop's displayed stock is
 * compared with the ledger. Shadow also replays open checkouts as holds.
 */
async function sync() {
  const cfg = await config();
  if (cfg.mode === 'off') return { mode: 'off' };
  const mode = liveMode(cfg);
  const out = { mode: cfg.mode, committed: 0, short: 0, moved: 0, expired: 0, mismatches: 0 };
  const exp = await db.query("UPDATE b2b_stock_reservations SET status = 'expired' WHERE channel = 'b2c' AND status = 'held' AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP()");
  out.expired = exp.affectedRows || 0;
  const startedAt = await modeStartedAt(cfg.mode);
  const orders = adapter.readShopOrders();
  if (!orders.ok) return Object.assign(out, { error: orders.reason });
  if (mode === 'shadow') {
    // replay open checkouts in time order as shadow holds (what enforcement would have held)
    const cs = adapter.readShop('checkouts');
    const window = new Date(Date.now() - cfg.holdMinutes * 60000).toISOString();   // a checkout older than a hold would have released it
    const open = cs.items.filter(function (c) { return c && c.status === 'pending' && !c.orderId && String(c.createdAt || '') >= startedAt && String(c.createdAt || '') >= window && c.quote; })
      .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
    for (const c of open) await hold('gw:' + c.gatewayOrderId, (c.quote.lines || []).map(function (l) { return { id: l.id, qty: l.qty }; }), cfg);
  }
  for (const o of orders.orders) {
    const created = String(o.createdAt || '');
    if (!created || created < startedAt) continue;   // orders before the switch were never part of this mode
    const shopId = String(o.id || o._id || '').slice(0, 64);
    if (!shopId) continue;
    const gw = o.payment && o.payment.gatewayOrderId ? String(o.payment.gatewayOrderId).slice(0, 60) : null;
    const status = String(o.status || '').toLowerCase();
    await db.transaction(async function (tx) {
      // rows made at the browser step carry the gateway id: give them the shop's order id now
      if (gw) await tx.query("UPDATE b2b_b2c_order_stock SET shop_order_id = ?, shop_order_no = ? WHERE mode = ? AND gateway_order_id = ? AND shop_order_id = ?",
        [shopId, String(o.orderId || '').slice(0, 40) || null, mode, gw, 'gw:' + gw]);
      const known = await tx.queryOne('SELECT COUNT(*) AS n FROM b2b_b2c_order_stock WHERE mode = ? AND shop_order_id = ?', [mode, shopId]);
      if (!Number(known.n) && status !== 'cancelled') {
        const r = await commit(tx, cfg, { orderKey: shopId, shopOrderNo: o.orderId, gatewayOrderId: gw, items: (o.items || []).map(function (i) { return { id: i.id, qty: i.qty }; }) });
        out.committed += r.committed;
        if (r.short.length) {
          out.short += r.short.length;
          if (mode === 'live') await paidShort(tx, gw ? 'gw:' + gw : 'order:' + shopId, { gatewayOrderId: gw, paymentId: o.payment && o.payment.paymentId, amount: Number(o.total) || 0, short: r.short, source: 'catch-up' });
          else await discrepancy(tx, 'order_without_hold', shopId, { details: 'Shop order ' + (o.orderId || shopId) + ': ' + r.short.length + ' line(s) the ledger could not cover' });
        }
      }
      const rows = await tx.query('SELECT * FROM b2b_b2c_order_stock WHERE mode = ? AND shop_order_id = ? FOR UPDATE', [mode, shopId]);
      for (const row of rows) {
        row.ref_id = String(o.orderId || shopId).slice(0, 40);
        if (await advance(tx, cfg, row, status)) out.moved++;
      }
    });
  }
  out.mismatches = await compareShopStock(cfg);
  await db.query("INSERT INTO b2b_b2c_sync_cursor (id, last_run_at, last_result) VALUES (2, UTC_TIMESTAMP(), ?) ON DUPLICATE KEY UPDATE last_run_at = VALUES(last_run_at), last_result = VALUES(last_result)",
    [JSON.stringify(out).slice(0, 255)]);
  return out;
}

/** When the current mode was switched on (the approved setting's time), so earlier orders are left alone. */
async function modeStartedAt(mode) {
  const r = await db.queryOne("SELECT updated_at FROM b2b_settings WHERE setting_key = 'erp.inventory.b2c_stock_mode'");
  if (!r || !r.updated_at) return '';
  const t = new Date(r.updated_at);
  return Number.isFinite(t.getTime()) ? t.toISOString() : '';
}

/** The figure the shop shows next to the ledger, per mapped product; a difference stays open until it matches. */
async function compareShopStock(cfg) {
  const prods = adapter.readShop('products');
  if (!prods.ok) return 0;
  const shop = {}; prods.items.forEach(function (p) { if (p && p.id != null && p.stock != null && Number.isFinite(Number(p.stock))) shop[String(p.id)] = Number(p.stock); });
  const mapped = await db.query('SELECT p.id, p.b2c_ref, p.name, COALESCE(s.qty_available, 0) AS avail FROM b2b_products p LEFT JOIN b2b_stock s ON s.product_id = p.id AND s.warehouse_id = ? WHERE p.b2c_ref IS NOT NULL', [cfg.warehouseId]);
  let open = 0;
  for (const m of mapped) {
    const ref = String(m.b2c_ref);
    if (!(ref in shop)) continue;
    if (shop[ref] !== Number(m.avail)) {
      open++;
      await discrepancy(null, 'stock_mismatch', ref, { productId: Number(m.id), shopQty: shop[ref], ledgerQty: Number(m.avail), details: m.name + ': the shop shows ' + shop[ref] + ', the ledger has ' + m.avail + ' available' });
    } else {
      await db.query("UPDATE b2b_b2c_discrepancies SET status = 'resolved', resolution_note = 'figures match again', open_key = NULL WHERE open_key = ?", ['stock_mismatch:' + ref]);
    }
  }
  return open;
}

// ── Staff ──
async function overview() {
  const cfg = await config();
  const mapped = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_products WHERE b2c_ref IS NOT NULL');
  const prods = adapter.readShop('products');
  const shopIds = prods.ok ? prods.items.map(function (p) { return String(p && p.id); }).filter(Boolean) : [];
  const mappedRefs = (await db.query('SELECT b2c_ref FROM b2b_products WHERE b2c_ref IS NOT NULL')).map(function (r) { return String(r.b2c_ref); });
  const unmappedShop = shopIds.filter(function (id) { return mappedRefs.indexOf(id) === -1; });
  const wh = cfg.warehouseId ? await db.queryOne('SELECT id, code, name, warehouse_type FROM b2b_warehouses WHERE id = ?', [cfg.warehouseId]) : null;
  const counts = await db.query("SELECT 'holds' AS k, COUNT(*) AS n FROM b2b_stock_reservations WHERE channel = 'b2c' AND status = 'held' UNION ALL " +
    "SELECT 'discrepancies', COUNT(*) FROM b2b_b2c_discrepancies WHERE status = 'open' UNION ALL SELECT 'exceptions', COUNT(*) FROM b2b_b2c_exceptions WHERE status IN ('open','refund_requested','refund_failed')");
  const last = await db.queryOne('SELECT last_run_at, last_result FROM b2b_b2c_sync_cursor WHERE id = 2');
  const c = {}; counts.forEach(function (r) { c[r.k] = Number(r.n); });
  const blockers = [];
  if (!wh) blockers.push('Choose the online-shop warehouse (setting inventory.b2c_warehouse_id).');
  else if (wh.warehouse_type !== 'online_shop') blockers.push('Warehouse ' + wh.code + ' is not of type online_shop.');
  if (unmappedShop.length) blockers.push(unmappedShop.length + ' shop product(s) have no business product mapped; their stock cannot be enforced.');
  if (!prods.ok) blockers.push('The shop products file could not be read: ' + prods.reason);
  return { mode: cfg.mode, warehouse: wh, holdMinutes: cfg.holdMinutes, autoRefund: cfg.autoRefund, mapped: Number(mapped.n), shopProducts: shopIds.length, unmappedShop: unmappedShop.slice(0, 50),
    openHolds: c.holds || 0, openDiscrepancies: c.discrepancies || 0, openExceptions: c.exceptions || 0, lastSync: last || null, readyToEnforce: blockers.length === 0, blockers: blockers };
}

async function listLines(q) {
  const where = [], args = [];
  if (q.mode === 'live' || q.mode === 'shadow') { where.push('s.mode = ?'); args.push(q.mode); }
  if (['allocated', 'sold', 'released', 'returned', 'short'].indexOf(q.stage) !== -1) { where.push('s.stage = ?'); args.push(q.stage); }
  if (q.q) { where.push('(s.shop_order_no = ? OR s.shop_order_id = ? OR s.gateway_order_id = ?)'); args.push(String(q.q), String(q.q), String(q.q)); }
  const rows = await db.query('SELECT s.*, p.sku, p.name FROM b2b_b2c_order_stock s JOIN b2b_products p ON p.id = s.product_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY s.updated_at DESC, s.id DESC LIMIT 300', args);
  return { items: rows.map(function (r) { return { id: Number(r.id), mode: r.mode, shopOrderId: r.shop_order_id, shopOrderNo: r.shop_order_no, gatewayOrderId: r.gateway_order_id, productId: Number(r.product_id),
    sku: r.sku, name: r.name, qty: Number(r.qty), stage: r.stage, shopStatus: r.shop_status, batches: r.picks_json ? JSON.parse(r.picks_json) : [], updatedAt: r.updated_at }; }) };
}
async function listHolds(q) {
  const rows = await db.query("SELECT r.*, p.sku, p.name FROM b2b_stock_reservations r JOIN b2b_products p ON p.id = r.product_id WHERE r.channel = 'b2c'" +
    (['held', 'committed', 'released', 'expired', 'short'].indexOf(q.status) !== -1 ? ' AND r.status = ?' : '') + ' ORDER BY r.id DESC LIMIT 300',
    ['held', 'committed', 'released', 'expired', 'short'].indexOf(q.status) !== -1 ? [q.status] : []);
  return { items: rows.map(function (r) { return { id: Number(r.id), mode: r.mode, ref: r.source_ref, sku: r.sku, name: r.name, qty: Number(r.qty), status: r.status, expiresAt: r.expires_at, createdAt: r.created_at }; }) };
}
async function listDiscrepancies(q) {
  const st = ['open', 'explained', 'resolved'].indexOf(q.status) !== -1 ? q.status : 'open';
  const rows = await db.query('SELECT d.*, p.sku, p.name FROM b2b_b2c_discrepancies d LEFT JOIN b2b_products p ON p.id = d.product_id WHERE d.status = ? ORDER BY d.last_seen_at DESC LIMIT 300', [st]);
  return { items: rows.map(function (r) { return { id: Number(r.id), kind: r.kind, ref: r.ref, sku: r.sku, name: r.name, shopQty: r.shop_qty, ledgerQty: r.ledger_qty, details: r.details, status: r.status,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, note: r.resolution_note }; }) };
}
async function explain(tx, actor, principal, id, b) {
  const d = await tx.queryOne('SELECT * FROM b2b_b2c_discrepancies WHERE id = ? FOR UPDATE', [posId(id)]);
  if (!d) throw fail(404, 'Not found');
  const note = String(b.note || '').trim();
  if (note.length < 5) throw fail(400, 'Say what was found (at least 5 characters)', 'reason_required');
  const status = b.resolved ? 'resolved' : 'explained';
  await tx.query('UPDATE b2b_b2c_discrepancies SET status = ?, resolution_note = ?, resolved_by = ?, open_key = NULL WHERE id = ?', [status, note.slice(0, 500), principal.id, d.id]);
  await audit.write(tx, actor, { module: 'shop_stock', action: 'discrepancy.' + status, entity: 'b2c_discrepancy', entityId: d.id, old: { status: d.status }, new: { status: status }, reason: note });
  return { id: Number(d.id), status: status };
}
async function listExceptions(q) {
  const rows = await db.query('SELECT * FROM b2b_b2c_exceptions' + (q.all === '1' ? '' : " WHERE status NOT IN ('refunded','backorder_agreed','closed')") + ' ORDER BY id DESC LIMIT 300');
  return { items: rows.map(function (r) { return { id: Number(r.id), ref: r.checkout_ref, gatewayOrderId: r.gateway_order_id, paymentId: r.payment_id, kind: r.kind, amount: Number(r.amount),
    details: r.details_json ? JSON.parse(r.details_json) : null, status: r.status, refundRef: r.refund_ref, refundError: r.refund_error, note: r.resolution_note, createdAt: r.created_at }; }) };
}

/**
 * Refund a paid-but-short checkout through the gateway (Razorpay test or live keys from the
 * environment; never stored here). gateway is injectable for tests. Idempotent: a refunded
 * exception is not refunded again; the gateway receives a receipt built from the exception.
 */
async function refund(actor, id, gateway) {
  const ex = await db.queryOne('SELECT * FROM b2b_b2c_exceptions WHERE id = ?', [posId(id)]);
  if (!ex) throw fail(404, 'Not found');
  if (ex.status === 'refunded') return { id: Number(ex.id), status: 'refunded', refundRef: ex.refund_ref, duplicate: true };
  if (!ex.payment_id) throw fail(409, 'No payment id is known for this checkout; refund it in the Razorpay dashboard and close this with a note', 'no_payment_id');
  const g = gateway || razorpay();
  if (!g) throw fail(503, 'Razorpay keys are not configured on this server', 'gateway_unavailable');
  await db.query("UPDATE b2b_b2c_exceptions SET status = 'refund_requested' WHERE id = ? AND status IN ('open','refund_failed')", [ex.id]);
  let r;
  try {
    r = await g.refund(ex.payment_id, { amount: Math.round(Number(ex.amount) * 100) || undefined, receipt: 'soh-short-' + ex.id, notes: { reason: 'paid but out of stock', checkout: ex.checkout_ref } });
  } catch (e) {
    const msg = String((e && (e.error && e.error.description)) || (e && e.message) || 'refund failed').slice(0, 300);
    await db.query("UPDATE b2b_b2c_exceptions SET status = 'refund_failed', refund_error = ? WHERE id = ?", [msg, ex.id]);
    await audit.write(null, actor, { module: 'shop_stock', action: 'exception.refund_failed', entity: 'b2c_exception', entityId: ex.id, new: { error: msg } });
    throw fail(502, 'The gateway refused the refund: ' + msg, 'refund_failed');
  }
  await db.query("UPDATE b2b_b2c_exceptions SET status = 'refunded', refund_ref = ?, refund_error = NULL WHERE id = ?", [String(r && r.id || '').slice(0, 64), ex.id]);
  await audit.write(null, actor, { module: 'shop_stock', action: 'exception.refunded', entity: 'b2c_exception', entityId: ex.id, new: { refundRef: r && r.id, amount: Number(ex.amount) } });
  return { id: Number(ex.id), status: 'refunded', refundRef: r && r.id };
}
function razorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  const Razorpay = require('razorpay');
  const client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  return { refund: function (paymentId, o) { return client.payments.refund(paymentId, o); } };
}
async function autoRefunds(gateway) {
  const cfg = await config();
  if (!cfg.autoRefund) return { skipped: 'auto refund off' };
  const due = await db.query("SELECT id FROM b2b_b2c_exceptions WHERE kind = 'paid_short' AND status = 'open' AND payment_id IS NOT NULL ORDER BY id LIMIT 20");
  let done = 0, failed = 0;
  for (const d of due) { try { await refund(SYSTEM, d.id, gateway); done++; } catch (e) { failed++; } }
  return { refunded: done, failed: failed };
}
async function closeException(tx, actor, id, b) {
  const ex = await tx.queryOne('SELECT * FROM b2b_b2c_exceptions WHERE id = ? FOR UPDATE', [posId(id)]);
  if (!ex) throw fail(404, 'Not found');
  const note = String(b.note || '').trim();
  if (note.length < 5) throw fail(400, 'Say how it was settled (at least 5 characters)', 'reason_required');
  const status = b.backorder ? 'backorder_agreed' : 'closed';
  await tx.query('UPDATE b2b_b2c_exceptions SET status = ?, resolver_id = ?, resolution_note = ? WHERE id = ?', [status, actor.id || null, note.slice(0, 500), ex.id]);
  await audit.write(tx, actor, { module: 'shop_stock', action: 'exception.' + status, entity: 'b2c_exception', entityId: ex.id, old: { status: ex.status }, new: { status: status }, reason: note });
  return { id: Number(ex.id), status: status };
}

/** A return of a delivered shop order, recorded by staff (the shop has no return step of its own). */
async function recordReturn(tx, actor, id, b) {
  const row = await tx.queryOne("SELECT * FROM b2b_b2c_order_stock WHERE id = ? AND mode = 'live' FOR UPDATE", [posId(id)]);
  if (!row) throw fail(404, 'Not found');
  if (row.stage !== 'sold') throw fail(409, 'Only a line that has left the warehouse can be returned', 'not_sold');
  const bucket = ['quarantine', 'damaged', 'expired'].indexOf(b.condition) !== -1 ? b.condition : null;
  if (!bucket) throw fail(400, 'condition must be quarantine (to inspect), damaged or expired');
  const note = String(b.reason || '').trim();
  if (note.length < 5) throw fail(400, 'Give a reason (at least 5 characters)', 'reason_required');
  row.ref_id = String(row.shop_order_no || row.shop_order_id).slice(0, 40);
  await returnLine(tx, actor, row, row.picks_json ? JSON.parse(row.picks_json) : [], bucket, note, 'b2c:return:' + row.id);
  await audit.write(tx, actor, { module: 'shop_stock', action: 'line.returned', entity: 'b2c_order_stock', entityId: row.id, new: { condition: bucket, qty: Number(row.qty) }, reason: note });
  return { id: Number(row.id), stage: 'returned', condition: bucket };
}

function newRef() { return 'pay:' + crypto.randomUUID(); }

module.exports = { config, mapLines, sellable, hold, bind, release, commit, commitAtPlace, advance, sync, compareShopStock, overview, listLines, listHolds, listDiscrepancies,
  explain, listExceptions, refund, autoRefunds, closeException, recordReturn, paidShort, shopWords, newRef, liveMode, MODES };
