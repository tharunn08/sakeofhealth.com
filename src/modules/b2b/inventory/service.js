/**
 * Warehouse-aware inventory with an append-only ledger.
 *
 * b2b_stock holds the current balance per warehouse + product, split into
 * status buckets. Stock only ever changes through move(): one guarded UPDATE
 * (`… WHERE qty_available >= ?`) plus one ledger row, inside the caller's
 * transaction. Two buyers racing for the last units cannot both win — the
 * second UPDATE simply matches zero rows.
 *
 *   available → reserved      order placed
 *   reserved  → allocated     packed (batches picked First-Expiry-First-Out)
 *   allocated → in_transit    dispatched
 *   in_transit → (out)        delivered
 */
const db = require('../../../db/connection.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const { bad, notFound, conflict, like } = require('../lib/http.js');
const ledger = require('../../erp/inventory/ledger.js');

const BUCKETS = ['available', 'reserved', 'allocated', 'in_transit', 'damaged', 'expired'];
const INBOUND = ['opening', 'purchase', 'production', 'return', 'transfer_in'];

class StockError extends Error {
  constructor(message, shortages) {
    super(message);
    this.status = 409; this.expose = true; this.extra = { code: 'INSUFFICIENT_STOCK', shortages: shortages || [] };
  }
}

/**
 * Stock movement for the B2B module. Since Milestone 3b.1 this delegates to the ONE ledger
 * write path (src/modules/erp/inventory/ledger.js): same guarded UPDATE + append-only row,
 * plus lots and the duplicate-proof key. Kept with its original snake_case signature so
 * every existing B2B caller works unchanged.
 * m = { warehouse_id, product_id, batch_id?, lot_id?, type, qty, from?, to?, ref_type?, ref_id?, reason?, actor?, idem_key? }
 * Returns false (and writes nothing) when the `from` bucket does not hold enough.
 */
async function move(tx, m) {
  if (m.from && BUCKETS.indexOf(m.from) === -1) throw new Error('Unknown stock bucket ' + m.from);
  if (m.to && BUCKETS.indexOf(m.to) === -1) throw new Error('Unknown stock bucket ' + m.to);
  const qty = Number(m.qty);
  if (!Number.isInteger(qty) || qty <= 0) throw bad('Quantity must be a positive whole number');
  return ledger.move(tx, { warehouseId: m.warehouse_id, productId: m.product_id, batchId: m.batch_id, lotId: m.lot_id, type: m.type, qty: qty,
    from: m.from, to: m.to, refType: m.ref_type, refId: m.ref_id, reason: m.reason, actor: m.actor || audit.SYSTEM, idemKey: m.idem_key });
}

/** A move that must happen: a refused move means the books would drift, so the whole action stops. */
async function mustMove(tx, m) {
  if (!(await move(tx, m))) throw new StockError('Not enough ' + String(m.from).replace('_', ' ') + ' stock for this step (product ' + m.product_id + ', warehouse ' + m.warehouse_id + ')');
}

async function upsertBatch(tx, warehouseId, productId, b, qty) {
  const batchNo = v.text(b.batch_no, 60);
  if (!batchNo) return null;
  const mfg = v.date(b.mfg_date), exp = v.date(b.expiry_date);
  if (b.mfg_date && !mfg) throw bad('Invalid manufacturing date');
  if (b.expiry_date && !exp) throw bad('Invalid expiry date');
  if (mfg && exp && exp <= mfg) throw bad('Expiry date must be after the manufacturing date');
  await tx.query(
    'INSERT INTO b2b_batches (warehouse_id, product_id, batch_no, mfg_date, expiry_date, qty_on_hand) VALUES (?, ?, ?, ?, ?, ?) ' +
    "ON DUPLICATE KEY UPDATE qty_on_hand = qty_on_hand + VALUES(qty_on_hand), status = 'active', " +
    'mfg_date = COALESCE(VALUES(mfg_date), mfg_date), expiry_date = COALESCE(VALUES(expiry_date), expiry_date)',
    [warehouseId, productId, batchNo, mfg, exp, qty]);
  const row = await tx.queryOne('SELECT id FROM b2b_batches WHERE warehouse_id = ? AND product_id = ? AND batch_no = ?', [warehouseId, productId, batchNo]);
  return row.id;
}

/** Stock coming in: opening balance, purchase, production. */
async function receive(tx, r) {
  if (INBOUND.indexOf(r.type) === -1 && r.type !== 'adjustment') throw bad('Unknown receipt type');
  const batchId = await upsertBatch(tx, r.warehouse_id, r.product_id, r, Number(r.qty));
  await move(tx, { warehouse_id: r.warehouse_id, product_id: r.product_id, batch_id: batchId, type: r.type, qty: r.qty,
    to: 'available', ref_type: r.ref_type, ref_id: r.ref_id, reason: r.reason, actor: r.actor });
  return { batchId: batchId };
}

/* ─────────── Warehouses ─────────── */

async function companyWarehouses(q) {
  const run = q ? q.query.bind(q) : db.query;
  // Only company warehouses fill B2B orders: never an event, salesman, online-shop or transit location (3b.1).
  return run("SELECT id, code, name, state_id, district_id, city, pincode, priority FROM b2b_warehouses WHERE owner_account_id IS NULL AND warehouse_type = 'company' AND is_active = 1 ORDER BY priority DESC, id");
}

async function distributorWarehouses(accountId, q) {
  const run = q ? q.query.bind(q) : db.query;
  return run('SELECT id, code, name, state_id, district_id, city, pincode, priority FROM b2b_warehouses WHERE owner_account_id = ? AND is_active = 1 ORDER BY priority DESC, id', [accountId]);
}

async function listWarehouses() {
  return db.query(
    'SELECT w.*, s.name AS state_name, a.business_name AS owner_name, ' +
    '  (SELECT COUNT(*) FROM b2b_stock st WHERE st.warehouse_id = w.id AND st.qty_available > 0) AS skus_in_stock, ' +
    '  (SELECT COALESCE(SUM(st.qty_available), 0) FROM b2b_stock st WHERE st.warehouse_id = w.id) AS units_available ' +
    'FROM b2b_warehouses w LEFT JOIN b2b_states s ON s.id = w.state_id LEFT JOIN b2b_accounts a ON a.id = w.owner_account_id ' +
    'ORDER BY (w.owner_account_id IS NOT NULL), w.priority DESC, w.name LIMIT 500');
}

async function saveWarehouse(id, b, actor) {
  const data = {
    code: v.upper(b.code, 30).replace(/[^A-Z0-9\-]/g, ''), name: v.text(b.name, 120), address: v.text(b.address, 300) || null,
    state_id: v.posInt(b.state_id), city: v.text(b.city, 80) || null, pincode: b.pincode ? String(b.pincode) : null,
    priority: Math.max(-100, Math.min(1000, Number(b.priority) || 0)), is_active: v.bool(b.is_active, true) ? 1 : 0,
  };
  if (!data.code || !data.name) throw bad('Warehouse code and name are required');
  if (data.pincode && !v.isPincode(data.pincode)) throw bad('Enter a valid pincode');
  if (data.state_id && !(await db.queryOne('SELECT id FROM b2b_states WHERE id = ?', [data.state_id]))) throw bad('Unknown state');
  try {
    if (id) {
      const before = await db.queryOne('SELECT * FROM b2b_warehouses WHERE id = ?', [id]);
      if (!before) throw notFound('Warehouse not found');
      await db.query('UPDATE b2b_warehouses SET code = ?, name = ?, address = ?, state_id = ?, city = ?, pincode = ?, priority = ?, is_active = ? WHERE id = ?',
        [data.code, data.name, data.address, data.state_id, data.city, data.pincode, data.priority, data.is_active, id]);
      await audit.log(null, actor, 'warehouse.updated', 'warehouse', id, before, data);
      return { id: Number(id) };
    }
    const res = await db.query('INSERT INTO b2b_warehouses (code, name, address, state_id, city, pincode, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [data.code, data.name, data.address, data.state_id, data.city, data.pincode, data.priority, data.is_active]);
    await audit.log(null, actor, 'warehouse.created', 'warehouse', res.insertId, null, data);
    return { id: res.insertId };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('A warehouse with that code already exists');
    throw e;
  }
}

/* ─────────── Order lifecycle ─────────── */

/**
 * Reserve every line of an order from ONE warehouse. Warehouses are tried in
 * the order given; the first that can cover the whole order wins.
 * lines = [{ product_id, qty, sku }]
 */
async function reserveForOrder(tx, orderId, lines, warehouses, actor) {
  if (!warehouses.length) throw new StockError('No warehouse is set up to fulfil this order.', []);
  // Always lock rows in product order, so two concurrent orders cannot deadlock each other.
  const sorted = lines.slice().sort(function (a, b) { return a.product_id - b.product_id; });
  const ids = sorted.map(function (l) { return l.product_id; });
  let lastShortages = [];
  for (const wh of warehouses) {
    const rows = await tx.query(
      'SELECT product_id, qty_available FROM b2b_stock WHERE warehouse_id = ? AND product_id IN (' + db.placeholders(ids) + ') ORDER BY product_id FOR UPDATE',
      [wh.id].concat(ids));
    const have = {};
    rows.forEach(function (r) { have[r.product_id] = Number(r.qty_available); });
    const shortages = sorted.filter(function (l) { return (have[l.product_id] || 0) < l.qty; })
      .map(function (l) { return { product_id: l.product_id, sku: l.sku, requested: l.qty, available: have[l.product_id] || 0 }; });
    if (shortages.length) {
      // Report against the warehouse that came closest to covering the order.
      if (!lastShortages.length || shortages.length < lastShortages.length) lastShortages = shortages;
      continue;
    }
    for (const line of sorted) {
      // The guarded UPDATE is still the final authority, even with the rows locked.
      const ok = await move(tx, { warehouse_id: wh.id, product_id: line.product_id, type: 'reservation', qty: line.qty,
        from: 'available', to: 'reserved', ref_type: 'order', ref_id: orderId, actor: actor });
      if (!ok) throw new StockError('Not enough stock for ' + line.sku + '. Please reduce the quantity.',
        [{ product_id: line.product_id, sku: line.sku, requested: line.qty, available: 0 }]);
    }
    return wh.id;
  }
  throw new StockError(
    'Not enough stock for ' + (lastShortages.length === 1 ? lastShortages[0].sku : lastShortages.length + ' items') + '. Please reduce the quantity.',
    lastShortages);
}

async function releaseForOrder(tx, order, items, actor, reason) {
  if (!order.stock_reserved || !order.warehouse_id) return;
  const allocations = await tx.query('SELECT a.*, i.product_id FROM b2b_order_item_allocations a JOIN b2b_order_items i ON i.id = a.order_item_id WHERE a.order_id = ?', [order.id]);
  if (allocations.length) {
    for (const a of allocations) {
      if (a.batch_id) await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand + ?, status = 'active' WHERE id = ?", [a.qty, a.batch_id]);
      const ok = await move(tx, { warehouse_id: order.warehouse_id, product_id: a.product_id, batch_id: a.batch_id, type: 'deallocation', qty: a.qty,
        from: 'allocated', to: 'available', ref_type: 'order', ref_id: order.id, reason: reason, actor: actor });
      if (!ok) throw new Error('Stock ledger out of sync releasing order ' + order.id);
    }
    await tx.query('DELETE FROM b2b_order_item_allocations WHERE order_id = ?', [order.id]);
  } else {
    for (const it of items) {
      const ok = await move(tx, { warehouse_id: order.warehouse_id, product_id: it.product_id, type: 'release', qty: it.qty,
        from: 'reserved', to: 'available', ref_type: 'order', ref_id: order.id, reason: reason, actor: actor });
      if (!ok) throw new Error('Stock ledger out of sync releasing order ' + order.id);
    }
  }
}

/** Packing: pick batches First-Expiry-First-Out and move reserved → allocated. */
async function allocateForOrder(tx, order, items, actor) {
  if (!order.stock_reserved || !order.warehouse_id) return;
  for (const it of items) {
    let remaining = Number(it.qty);
    const batches = await tx.query(
      "SELECT id, qty_on_hand FROM b2b_batches WHERE warehouse_id = ? AND product_id = ? AND status = 'active' AND qty_on_hand > 0 " +
      'AND (expiry_date IS NULL OR expiry_date > UTC_DATE()) ORDER BY (expiry_date IS NULL), expiry_date, id FOR UPDATE',
      [order.warehouse_id, it.product_id]);
    const picks = [];
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(b.qty_on_hand));
      await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand - ?, status = IF(qty_on_hand = 0, 'depleted', status) WHERE id = ?", [take, b.id]);
      picks.push({ batchId: b.id, qty: take });
      remaining -= take;
    }
    if (remaining > 0) picks.push({ batchId: null, qty: remaining });   // stock that was received without batch details
    for (const p of picks) {
      const ok = await move(tx, { warehouse_id: order.warehouse_id, product_id: it.product_id, batch_id: p.batchId, type: 'allocation', qty: p.qty,
        from: 'reserved', to: 'allocated', ref_type: 'order', ref_id: order.id, actor: actor });
      if (!ok) throw new Error('Stock ledger out of sync allocating order ' + order.id);
      await tx.query('INSERT INTO b2b_order_item_allocations (order_id, order_item_id, batch_id, qty) VALUES (?, ?, ?, ?)', [order.id, it.id, p.batchId, p.qty]);
    }
  }
}

async function dispatchOrder(tx, order, actor) {
  if (!order.stock_reserved || !order.warehouse_id) return;
  const allocations = await tx.query('SELECT a.*, i.product_id FROM b2b_order_item_allocations a JOIN b2b_order_items i ON i.id = a.order_item_id WHERE a.order_id = ?', [order.id]);
  for (const a of allocations) {
    const ok = await move(tx, { warehouse_id: order.warehouse_id, product_id: a.product_id, batch_id: a.batch_id, type: 'dispatch', qty: a.qty,
      from: 'allocated', to: 'in_transit', ref_type: 'order', ref_id: order.id, actor: actor });
    if (!ok) throw new Error('Stock ledger out of sync dispatching order ' + order.id);
  }
}

/**
 * Delivery: in_transit leaves the seller's books. Undelivered units come back
 * to available. If the buyer is a distributor, the delivered units (with their
 * batch numbers and expiry dates) arrive in the distributor's own stock point.
 * delivered = { order_item_id: qtyDelivered }
 */
async function deliverOrder(tx, order, items, delivered, actor) {
  if (!order.stock_reserved || !order.warehouse_id) {
    if (order.buyer_type === 'distributor') await creditDistributor(tx, order, items.map(function (it) {
      return { product_id: it.product_id, qty: delivered[it.id] == null ? Number(it.qty) : Number(delivered[it.id]), batch: null };
    }), actor);
    return;
  }
  const allocations = await tx.query(
    'SELECT a.*, i.product_id, b.batch_no, b.mfg_date, b.expiry_date FROM b2b_order_item_allocations a ' +
    'JOIN b2b_order_items i ON i.id = a.order_item_id LEFT JOIN b2b_batches b ON b.id = a.batch_id WHERE a.order_id = ? ORDER BY a.id', [order.id]);
  const left = {};
  items.forEach(function (it) { left[it.id] = delivered[it.id] == null ? Number(it.qty) : Number(delivered[it.id]); });
  const received = [];
  for (const a of allocations) {
    const deliverQty = Math.min(Number(a.qty), left[a.order_item_id] || 0);
    const backQty = Number(a.qty) - deliverQty;
    left[a.order_item_id] = (left[a.order_item_id] || 0) - deliverQty;
    if (deliverQty > 0) {
      const ok = await move(tx, { warehouse_id: order.warehouse_id, product_id: a.product_id, batch_id: a.batch_id, type: 'delivery', qty: deliverQty,
        from: 'in_transit', ref_type: 'order', ref_id: order.id, actor: actor });
      if (!ok) throw new Error('Stock ledger out of sync delivering order ' + order.id);
      received.push({ product_id: a.product_id, qty: deliverQty, batch: a.batch_no ? { batch_no: a.batch_no, mfg_date: a.mfg_date, expiry_date: a.expiry_date } : null });
    }
    if (backQty > 0) {
      if (a.batch_id) await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand + ?, status = 'active' WHERE id = ?", [backQty, a.batch_id]);
      const ok = await move(tx, { warehouse_id: order.warehouse_id, product_id: a.product_id, batch_id: a.batch_id, type: 'return', qty: backQty,
        from: 'in_transit', to: 'available', ref_type: 'order', ref_id: order.id, reason: 'not delivered', actor: actor });
      if (!ok) throw new Error('Stock ledger out of sync delivering order ' + order.id);
    }
  }
  if (order.buyer_type === 'distributor') await creditDistributor(tx, order, received, actor);
}

async function creditDistributor(tx, order, received, actor) {
  const whs = await distributorWarehouses(order.buyer_account_id, tx);
  if (!whs.length) return;
  for (const r of received) {
    if (r.qty <= 0) continue;
    await receive(tx, Object.assign({ warehouse_id: whs[0].id, product_id: r.product_id, qty: r.qty, type: 'transfer_in',
      ref_type: 'order', ref_id: order.id, reason: 'received against order', actor: actor }, r.batch || {}));
  }
}

/** Goods coming back on an approved return. */
async function receiveReturn(tx, warehouseId, productId, qty, condition, returnId, actor) {
  const to = condition === 'good' ? 'available' : (condition === 'expired' ? 'expired' : 'damaged');
  await move(tx, { warehouse_id: warehouseId, product_id: productId, type: 'return', qty: qty, to: to,
    ref_type: 'return', ref_id: returnId, reason: 'customer return (' + condition + ')', actor: actor });
}

/* ─────────── Manual stock operations ─────────── */

async function assertWarehouseScope(tx, warehouseId, ownerAccountId) {
  const wh = await tx.queryOne('SELECT id, owner_account_id, is_active FROM b2b_warehouses WHERE id = ?', [warehouseId]);
  if (!wh) throw notFound('Warehouse not found');
  // ownerAccountId === undefined → admin (any warehouse). Otherwise the caller may only touch their own stock point.
  if (ownerAccountId !== undefined && Number(wh.owner_account_id) !== Number(ownerAccountId)) throw notFound('Warehouse not found');
  return wh;
}

/**
 * Admin / distributor stock entry.
 * body = { warehouse_id, product_id, operation, qty, batch_no?, mfg_date?, expiry_date?, batch_id?, reason }
 * operation: opening | purchase | production | adjust_increase | adjust_decrease | damage | expiry
 */
async function manualEntry(body, actor, ownerAccountId) {
  const qty = v.posInt(body.qty);
  if (!qty) throw bad('Quantity must be a positive whole number');
  if (qty > 10000000) throw bad('Quantity is too large');
  const op = String(body.operation || '');
  const reason = v.text(body.reason, 255);
  if (['adjust_increase', 'adjust_decrease', 'damage', 'expiry'].indexOf(op) !== -1 && reason.length < 3) throw bad('Please give a reason for this stock change');
  // Owner decision 5 (3b.1): company stock is added only through a goods receipt, or changed through an
  // adjustment / opening balance that a second person approves. Distributors' own stock points keep
  // their entry screen until decision M7.
  if (ownerAccountId === undefined && require('../../erp/config.js').enabled()) {
    throw conflict('Company stock is no longer changed directly. Receive purchases with a goods receipt (Procurement), and propose ' +
      'an adjustment or opening balance under Inventory → Adjustments; a second person approves it.', { code: 'use_adjustment' });
  }
  return db.transaction(async function (tx) {
    const wh = await assertWarehouseScope(tx, v.posInt(body.warehouse_id) || 0, ownerAccountId);
    const product = await tx.queryOne('SELECT id, sku FROM b2b_products WHERE id = ?', [v.posInt(body.product_id) || 0]);
    if (!product) throw bad('Product not found');
    const base = { warehouse_id: wh.id, product_id: product.id, qty: qty, ref_type: 'manual', reason: reason || op, actor: actor };
    const before = await tx.queryOne('SELECT * FROM b2b_stock WHERE warehouse_id = ? AND product_id = ? FOR UPDATE', [wh.id, product.id]);

    if (op === 'opening' || op === 'purchase' || op === 'production') {
      await receive(tx, Object.assign({}, base, { type: op, batch_no: body.batch_no, mfg_date: body.mfg_date, expiry_date: body.expiry_date }));
    } else if (op === 'adjust_increase') {
      await receive(tx, Object.assign({}, base, { type: 'adjustment', batch_no: body.batch_no, mfg_date: body.mfg_date, expiry_date: body.expiry_date }));
    } else if (op === 'adjust_decrease' || op === 'damage' || op === 'expiry') {
      let batchId = null;
      if (body.batch_id) {
        const b = await tx.queryOne('SELECT id, qty_on_hand FROM b2b_batches WHERE id = ? AND warehouse_id = ? AND product_id = ? FOR UPDATE', [v.posInt(body.batch_id) || 0, wh.id, product.id]);
        if (!b) throw bad('Batch not found in this warehouse');
        if (Number(b.qty_on_hand) < qty) throw new StockError('That batch only has ' + b.qty_on_hand + ' units on hand.');
        await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand - ?, status = IF(qty_on_hand = 0, ?, status) WHERE id = ?",
          [qty, op === 'expiry' ? 'expired' : 'depleted', b.id]);
        batchId = b.id;
      }
      const to = op === 'damage' ? 'damaged' : (op === 'expiry' ? 'expired' : null);
      const ok = await move(tx, Object.assign({}, base, { batch_id: batchId, type: op === 'adjust_decrease' ? 'adjustment' : op, from: 'available', to: to }));
      if (!ok) throw new StockError('Only ' + (before ? before.qty_available : 0) + ' units of ' + product.sku + ' are available in this warehouse.');
    } else {
      throw bad('Unknown stock operation');
    }
    const after = await tx.queryOne('SELECT qty_available, qty_reserved, qty_allocated, qty_in_transit, qty_damaged, qty_expired FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [wh.id, product.id]);
    await audit.log(tx, actor, 'stock.' + op, 'stock', wh.id + ':' + product.id,
      before ? { qty_available: before.qty_available, qty_damaged: before.qty_damaged, qty_expired: before.qty_expired } : null,
      Object.assign({ sku: product.sku, qty: qty, reason: reason }, after));
    return after;
  });
}

/* ─────────── Read models ─────────── */

function scopeSql(f, params) {
  const where = [];
  if (f.owner_account_id !== undefined) { where.push('w.owner_account_id = ?'); params.push(f.owner_account_id); }
  else if (f.company_only) where.push('w.owner_account_id IS NULL');
  if (f.warehouse_id) { where.push('w.id = ?'); params.push(Number(f.warehouse_id)); }
  return where;
}

async function listStock(f, pg) {
  const params = [];
  const where = scopeSql(f, params);
  if (f.q) { const t = v.text(f.q, 80); where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.barcode = ?)'); params.push(like(t, 'prefix'), like(t), t); }
  if (f.category_id) { where.push('(p.category_id = ? OR p.subcategory_id = ?)'); params.push(Number(f.category_id), Number(f.category_id)); }
  if (f.low) where.push('p.is_active = 1 AND p.low_stock_threshold > 0 AND st.qty_available <= p.low_stock_threshold');
  if (f.out) where.push('st.qty_available = 0');
  const sql = ' FROM b2b_stock st JOIN b2b_warehouses w ON w.id = st.warehouse_id JOIN b2b_products p ON p.id = st.product_id' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const total = await db.queryOne('SELECT COUNT(*) AS n' + sql, params);
  const sort = { sku: 'p.sku', name: 'p.name', available: 'st.qty_available', updated: 'st.updated_at' };
  const order = sort[f.sort] ? sort[f.sort] + (f.dir === 'desc' ? ' DESC' : ' ASC') : 'p.sku ASC';
  const rows = await db.query(
    'SELECT st.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, st.product_id, p.sku, p.name, p.pack_size, p.low_stock_threshold, ' +
    'st.qty_available, st.qty_reserved, st.qty_allocated, st.qty_in_transit, st.qty_damaged, st.qty_expired, st.updated_at' + sql +
    ' ORDER BY ' + order + ', st.warehouse_id LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows, total: Number(total.n) };
}

async function listMovements(f, pg) {
  const params = [];
  const where = scopeSql(f, params);
  if (f.product_id) { where.push('m.product_id = ?'); params.push(Number(f.product_id)); }
  if (f.type) { where.push('m.movement_type = ?'); params.push(String(f.type)); }
  if (f.q) { const t = v.text(f.q, 80); where.push('(p.sku LIKE ? OR p.name LIKE ?)'); params.push(like(t, 'prefix'), like(t)); }
  if (f.from) { where.push('m.created_at >= ?'); params.push(f.from + ' 00:00:00'); }
  if (f.to) { where.push('m.created_at <= ?'); params.push(f.to + ' 23:59:59'); }
  const sql = ' FROM b2b_stock_movements m JOIN b2b_warehouses w ON w.id = m.warehouse_id JOIN b2b_products p ON p.id = m.product_id' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const total = await db.queryOne('SELECT COUNT(*) AS n' + sql, params);
  const rows = await db.query(
    'SELECT m.id, m.created_at, w.code AS warehouse_code, p.sku, p.name, m.movement_type, m.qty, m.from_status, m.to_status, m.ref_type, m.ref_id, ' +
    'm.reason, m.actor_type, m.actor_label, b.batch_no FROM b2b_stock_movements m JOIN b2b_warehouses w ON w.id = m.warehouse_id ' +
    'JOIN b2b_products p ON p.id = m.product_id LEFT JOIN b2b_batches b ON b.id = m.batch_id' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY m.id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows, total: Number(total.n) };
}

/** Batches with expiry information. f.within = days (30 / 60 / 90), f.expired = already past. */
async function listBatches(f, pg) {
  const params = [];
  const where = scopeSql(f, params);
  where.push('b.qty_on_hand > 0');
  if (f.expired) where.push('b.expiry_date IS NOT NULL AND b.expiry_date <= UTC_DATE()');
  else if (f.within) { where.push('b.expiry_date IS NOT NULL AND b.expiry_date > UTC_DATE() AND b.expiry_date <= (UTC_DATE() + INTERVAL ' + db.int(f.within, 90, 1, 3650) + ' DAY)'); }
  if (f.product_id) { where.push('b.product_id = ?'); params.push(Number(f.product_id)); }
  if (f.q) { const t = v.text(f.q, 80); where.push('(p.sku LIKE ? OR p.name LIKE ? OR b.batch_no LIKE ?)'); params.push(like(t, 'prefix'), like(t), like(t, 'prefix')); }
  const sql = ' FROM b2b_batches b JOIN b2b_warehouses w ON w.id = b.warehouse_id JOIN b2b_products p ON p.id = b.product_id WHERE ' + where.join(' AND ');
  const total = await db.queryOne('SELECT COUNT(*) AS n' + sql, params);
  const rows = await db.query(
    'SELECT b.id, b.warehouse_id, w.code AS warehouse_code, b.product_id, p.sku, p.name, b.batch_no, b.mfg_date, b.expiry_date, b.qty_on_hand, b.status, ' +
    'DATEDIFF(b.expiry_date, UTC_DATE()) AS days_left' + sql + ' ORDER BY (b.expiry_date IS NULL), b.expiry_date, b.id LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows, total: Number(total.n) };
}

async function expirySummary(f) {
  const params = [];
  const where = scopeSql(f || {}, params);
  where.push('b.qty_on_hand > 0 AND b.expiry_date IS NOT NULL');
  const row = await db.queryOne(
    'SELECT COALESCE(SUM(b.expiry_date <= UTC_DATE()), 0) AS expired, ' +
    'COALESCE(SUM(b.expiry_date > UTC_DATE() AND b.expiry_date <= UTC_DATE() + INTERVAL 30 DAY), 0) AS d30, ' +
    'COALESCE(SUM(b.expiry_date > UTC_DATE() + INTERVAL 30 DAY AND b.expiry_date <= UTC_DATE() + INTERVAL 60 DAY), 0) AS d60, ' +
    'COALESCE(SUM(b.expiry_date > UTC_DATE() + INTERVAL 60 DAY AND b.expiry_date <= UTC_DATE() + INTERVAL 90 DAY), 0) AS d90 ' +
    'FROM b2b_batches b JOIN b2b_warehouses w ON w.id = b.warehouse_id WHERE ' + where.join(' AND '), params);
  return { expired: Number(row.expired), within30: Number(row.d30), within60: Number(row.d60), within90: Number(row.d90) };
}

/** product_id → units available to a buyer (summed over the given warehouses). */
async function availability(productIds, warehouseIds, q) {
  if (!productIds.length || !warehouseIds.length) return {};
  const run = q ? q.query.bind(q) : db.query;
  const rows = await run(
    'SELECT product_id, SUM(qty_available) AS n FROM b2b_stock WHERE warehouse_id IN (' + db.placeholders(warehouseIds) + ') ' +
    'AND product_id IN (' + db.placeholders(productIds) + ') GROUP BY product_id', warehouseIds.concat(productIds));
  const out = {};
  rows.forEach(function (r) { out[r.product_id] = Number(r.n); });
  return out;
}

module.exports = {
  BUCKETS, StockError, move, receive, companyWarehouses, distributorWarehouses, listWarehouses, saveWarehouse,
  reserveForOrder, releaseForOrder, allocateForOrder, dispatchOrder, deliverOrder, receiveReturn,
  manualEntry, listStock, listMovements, listBatches, expirySummary, availability,
};
