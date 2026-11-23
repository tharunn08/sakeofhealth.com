/**
 * B2B orders: cart → priced quote → order → fulfilment.
 *
 * Trust boundary: the browser sends product ids and quantities, nothing else
 * that matters. Price, tax, totals, seller, stock and credit are all decided
 * here, inside one database transaction.
 */
const db = require('../../../db/connection.js');
const money = require('../lib/money.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const settings = require('../lib/settings.js');
const engine = require('../pricing/engine.js');
const catalogue = require('../catalogue/service.js');
const inventory = require('../inventory/service.js');
const mappings = require('../mappings/service.js');
const invoices = require('../invoices/service.js');
const payments = require('../payments/service.js');
const notifications = require('../notifications/service.js');
const sm = require('./stateMachine.js');
const { AppError, bad, notFound, forbidden, like } = require('../lib/http.js');

const PAYMENT_METHODS = ['upi', 'bank_transfer', 'gateway', 'credit'];
const MAX_LINES = 300;

/* ═════════════════ Seller + quote ═════════════════ */

/** Who supplies this buyer: the company, or (for a mapped retailer) their distributor. */
async function sellerFor(account, q) {
  if (account.account_type !== 'retailer') return { type: 'company', accountId: null };
  const m = await mappings.currentMapping(account.id, q);
  if (m && m.status === 'active' && m.distributor_status === 'approved') {
    return { type: 'distributor', accountId: Number(m.distributor_id), name: m.distributor_name };
  }
  return { type: 'company', accountId: null };
}

async function sellerStateId(seller, q) {
  const card = await invoices.sellerCard(seller.type, seller.accountId, q);
  return card.stateId;
}

function lineAmounts(unitPaise, listPaise, qty, gstRate, interstate) {
  const taxable = unitPaise * qty;
  const g = invoices.gstSplit(taxable, gstRate, interstate);
  return {
    gross: listPaise * qty, discount: Math.max(0, (listPaise - unitPaise) * qty), taxable: taxable,
    cgst: g.cgst, sgst: g.sgst, igst: g.igst, total: taxable + g.cgst + g.sgst + g.igst,
  };
}

function totalsOf(lines) {
  const t = { subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cost: 0, qty: 0 };
  lines.forEach(function (l) {
    t.subtotal += l.amounts.gross; t.discount += l.amounts.discount; t.taxable += l.amounts.taxable;
    t.cgst += l.amounts.cgst; t.sgst += l.amounts.sgst; t.igst += l.amounts.igst;
    t.cost += money.toPaise(l.product.base_price) * l.qty; t.qty += l.qty;
  });
  t.tax = t.cgst + t.sgst + t.igst;
  const r = money.roundToRupee(t.taxable + t.tax);
  t.grand = r.rounded; t.roundOff = r.roundOff;
  return t;
}

/**
 * Price a set of { product, qty } rows for a buyer. Used for the cart view AND
 * for placing the order, so what the buyer sees is exactly what is charged.
 */
async function quote(account, rows, seller, q) {
  const aud = account.account_type;
  const products = rows.map(function (r) { return r.product; });
  const ctx = await engine.contextFor(aud, account.id, products, q);
  const sellerState = await sellerStateId(seller, q);
  const interstate = sellerState == null || Number(sellerState) !== Number(account.state_id);
  const today = new Date().toISOString().slice(0, 10);
  const lines = rows.map(function (r) {
    const p = r.product, qty = Number(r.qty);
    let problem = null;
    const effective = p.effective_from ? (p.effective_from instanceof Date ? p.effective_from.toISOString().slice(0, 10) : String(p.effective_from).slice(0, 10)) : null;
    if (!Number(p.is_active) || !Number(p['avail_' + aud]) || (effective && effective > today)) problem = 'This product is no longer available';
    else problem = catalogue.qtyProblem(p, qty);
    const price = engine.resolve(p, Math.max(1, qty || 1), ctx);
    const free = problem ? null : engine.freeGoods(p, qty, ctx);
    return { product: p, qty: qty, price: price, problem: problem, free: free,
      amounts: lineAmounts(price.unitPrice, price.listPrice, Number.isInteger(qty) && qty > 0 ? qty : 0, p.gst_rate, interstate) };
  });
  return { lines: lines, totals: totalsOf(lines.filter(function (l) { return !l.problem; })), interstate: interstate, sellerStateId: sellerState };
}

/* ═════════════════ Cart ═════════════════ */

async function cartRows(accountId, q) {
  const run = q ? q.query.bind(q) : db.query;
  const rows = await run(
    'SELECT ci.qty AS cart_qty, p.* FROM b2b_cart_items ci JOIN b2b_products p ON p.id = ci.product_id WHERE ci.account_id = ? ORDER BY p.name', [accountId]);
  return rows.map(function (r) { return { product: r, qty: Number(r.cart_qty) }; });
}

async function paymentOptions(account, seller) {
  const credit = await payments.getCredit(account.id, seller.accountId || 0);
  const methods = [{ id: 'bank_transfer', label: 'Bank transfer (NEFT / RTGS / IMPS)' }, { id: 'upi', label: 'UPI' }];
  if (seller.type === 'company') methods.unshift({ id: 'gateway', label: 'Pay online now' });
  if (credit.is_active !== false && (Number(credit.credit_limit) > 0 || Number(credit.override_amount) > 0)) methods.push({ id: 'credit', label: 'On credit (' + credit.credit_days + ' days)' });
  return { methods: methods, credit: credit };
}

async function getCart(account) {
  const seller = await sellerFor(account);
  const rows = await cartRows(account.id);
  const qd = await quote(account, rows, seller);
  const source = await catalogue.stockSourceFor(account, seller.accountId);
  const stock = source.tracked && rows.length
    ? await inventory.availability(rows.map(function (r) { return Number(r.product.id); }), source.warehouseIds) : {};
  const pay = await paymentOptions(account, seller);
  const minOrder = money.toPaise(await settings.get('orders.min_order_value'));
  const items = qd.lines.map(function (l) {
    const p = l.product;
    let problem = l.problem;
    const available = source.tracked ? (stock[p.id] || 0) : null;
    const freeQty = l.free ? l.free.qty : 0;
    if (!problem && available != null && available < l.qty + freeQty) problem = available > 0 ? 'Only ' + available + ' in stock' + (freeQty ? ' (including ' + freeQty + ' free)' : '') : 'Out of stock';
    return {
      product_id: Number(p.id), sku: p.sku, name: p.name, image_url: p.image_url, pack_size: p.pack_size,
      moq: Number(p.moq), case_qty: Number(p.case_qty), enforce_case_multiple: !!Number(p.enforce_case_multiple), min_qty: catalogue.minValidQty(p),
      qty: l.qty, gst_rate: p.gst_rate, mrp: p.mrp,
      unit_price: money.fromPaise(l.price.unitPrice),
      list_price: l.price.listPrice !== l.price.unitPrice ? money.fromPaise(l.price.listPrice) : null,
      promo: l.price.promo, taxable: money.fromPaise(l.amounts.taxable),
      tax: money.fromPaise(l.amounts.cgst + l.amounts.sgst + l.amounts.igst), line_total: money.fromPaise(l.amounts.total),
      available: available, problem: problem,
      free_qty: freeQty, free_label: l.free ? l.free.label : null,
    };
  });
  const t = qd.totals;
  const problems = items.filter(function (i) { return i.problem; }).length;
  return {
    items: items,
    totals: {
      subtotal: money.fromPaise(t.subtotal), discount: money.fromPaise(t.discount), taxable: money.fromPaise(t.taxable),
      cgst: money.fromPaise(t.cgst), sgst: money.fromPaise(t.sgst), igst: money.fromPaise(t.igst), tax: money.fromPaise(t.tax),
      round_off: money.fromPaise(t.roundOff), grand_total: money.fromPaise(t.grand), total_qty: t.qty, interstate: qd.interstate,
    },
    seller: { type: seller.type, name: seller.type === 'company' ? (process.env.BRAND_NAME || 'Sake of Health') : seller.name },
    payment: pay,
    min_order_value: money.fromPaise(minOrder),
    can_checkout: items.length > 0 && problems === 0 && t.grand >= minOrder,
    problems: problems,
  };
}

async function visibleProduct(account, productId) {
  const p = await db.queryOne('SELECT p.* FROM b2b_products p WHERE p.id = ? AND ' + catalogue.VISIBLE(account.account_type), [productId]);
  if (!p) throw notFound('Product not found or not available to your account');
  return p;
}

/** Set an exact quantity (0 removes the line). MOQ / case rules are enforced here, not only in the browser. */
async function setCartItem(account, productId, qty) {
  qty = Number(qty);
  if (qty === 0) {
    await db.query('DELETE FROM b2b_cart_items WHERE account_id = ? AND product_id = ?', [account.id, productId]);
    return { removed: true };
  }
  const p = await visibleProduct(account, productId);
  const problem = catalogue.qtyProblem(p, qty);
  if (problem) throw bad(p.sku + ': ' + problem, { code: 'QTY_RULE', min_qty: catalogue.minValidQty(p), case_qty: Number(p.case_qty) });
  const count = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_cart_items WHERE account_id = ?', [account.id]);
  if (Number(count.n) >= MAX_LINES) throw bad('A cart can hold at most ' + MAX_LINES + ' different products');
  await db.query('INSERT INTO b2b_cart_items (account_id, product_id, qty) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE qty = VALUES(qty)', [account.id, productId, qty]);
  return { product_id: Number(productId), qty: qty };
}

/**
 * Quick order: add many lines in one go. lines = [{ sku | product_id, qty }].
 * Valid lines are added; invalid ones are reported back row by row.
 */
async function addManyToCart(account, lines, replace) {
  if (!Array.isArray(lines) || !lines.length) throw bad('Enter at least one product and quantity');
  if (lines.length > MAX_LINES) throw bad('Add at most ' + MAX_LINES + ' lines at a time');
  const codes = lines.map(function (l) { return l.sku; }).filter(Boolean);
  const bySku = {}, byId = {};
  (await catalogue.portalLookup(account, codes)).forEach(function (p) { bySku[String(p.sku).toLowerCase()] = p; if (p.barcode) bySku[String(p.barcode).toLowerCase()] = p; });
  const ids = lines.map(function (l) { return Number(l.product_id); }).filter(function (n) { return Number.isInteger(n) && n > 0; });
  if (ids.length) {
    (await db.query('SELECT p.* FROM b2b_products p WHERE p.id IN (' + db.placeholders(ids) + ') AND ' + catalogue.VISIBLE(account.account_type), ids))
      .forEach(function (p) { byId[p.id] = p; });
  }
  const ok = [], errors = [];
  lines.forEach(function (l, i) {
    const p = l.product_id ? byId[Number(l.product_id)] : bySku[String(l.sku || '').trim().toLowerCase()];
    const label = l.sku || ('#' + l.product_id);
    if (!p) { errors.push({ row: i + 1, sku: label, error: 'Product not found' }); return; }
    const qty = Number(l.qty);
    const problem = catalogue.qtyProblem(p, qty);
    if (problem) { errors.push({ row: i + 1, sku: p.sku, error: problem }); return; }
    ok.push([account.id, Number(p.id), qty]);
  });
  if (ok.length) {
    await db.transaction(async function (tx) {
      if (replace) await tx.query('DELETE FROM b2b_cart_items WHERE account_id = ?', [account.id]);
      await tx.bulk('INSERT INTO b2b_cart_items (account_id, product_id, qty) VALUES ? ON DUPLICATE KEY UPDATE qty = VALUES(qty)', ok);
    });
  }
  return { added: ok.length, errors: errors };
}

async function clearCart(accountId) {
  await db.query('DELETE FROM b2b_cart_items WHERE account_id = ?', [accountId]);
  return { ok: true };
}

/* ═════════════════ Place order ═════════════════ */

function orderNumber(id) {
  const d = invoices.istDate();
  return 'B2B' + d.slice(2, 4) + d.slice(5, 7) + '-' + String(id).padStart(6, '0');
}

async function history(tx, orderId, from, to, note, actor) {
  await tx.query('INSERT INTO b2b_order_status_history (order_id, from_status, to_status, note, actor_type, actor_label) VALUES (?, ?, ?, ?, ?, ?)',
    [orderId, from, to, note ? String(note).slice(0, 500) : null, (actor && actor.type) || 'system', (actor && actor.label) || 'system']);
}

async function findByIdempotencyKey(accountId, key, q) {
  const run = q ? q.queryOne.bind(q) : db.queryOne;
  return run('SELECT id, order_no, status, grand_total, payment_method FROM b2b_orders WHERE buyer_account_id = ? AND idempotency_key = ?', [accountId, key]);
}

/**
 * Turn the buyer's cart into an order.
 *
 * Idempotent: the same Idempotency-Key always returns the same order, however
 * many times (or how concurrently) the request is sent — the unique index
 * (buyer_account_id, idempotency_key) guarantees at most one row.
 */
async function placeOrder(identity, body, actor) {
  const accountId = identity.account.id;
  const key = v.text(body.idempotencyKey, 64);
  if (!/^[A-Za-z0-9_\-]{8,64}$/.test(key)) throw bad('Missing or invalid Idempotency-Key');
  const method = String(body.payment_method || '');
  if (PAYMENT_METHODS.indexOf(method) === -1) throw bad('Choose a payment method');

  const already = await findByIdempotencyKey(accountId, key);
  if (already) return { order: already, duplicate: true };

  let created;
  try {
    created = await db.transaction(async function (tx) {
      // Serialise this buyer's checkouts: first-order flag, credit and cart are all read under this lock.
      const account = await tx.queryOne(
        'SELECT a.*, s.name AS state_name, s.gst_code AS state_gst_code FROM b2b_accounts a JOIN b2b_states s ON s.id = a.state_id WHERE a.id = ? FOR UPDATE', [accountId]);
      if (!account || account.status !== 'approved') throw forbidden('Your account is not approved for ordering');
      const dup = await findByIdempotencyKey(accountId, key, tx);
      if (dup) return { order: dup, duplicate: true };

      const rows = await cartRows(accountId, tx);
      if (!rows.length) throw bad('Your cart is empty');
      if (rows.length > MAX_LINES) throw bad('Too many lines in one order');
      const seller = await sellerFor(account, tx);
      if (method === 'gateway' && seller.type !== 'company') throw bad('Online payment is not available for orders supplied by your distributor');
      const qd = await quote(account, rows, seller, tx);
      const bad_ = qd.lines.filter(function (l) { return l.problem; });
      if (bad_.length) {
        throw new AppError(400, 'Some items in your cart need attention', { code: 'CART_INVALID',
          items: bad_.map(function (l) { return { product_id: Number(l.product.id), sku: l.product.sku, error: l.problem }; }) });
      }
      const t = qd.totals;
      const cfg = await settings.all();
      const minOrder = money.toPaise(cfg['orders.min_order_value']);
      if (t.grand < minOrder) throw bad('The minimum order value is ' + money.inr(minOrder));
      if (t.grand <= 0) throw bad('Order total must be greater than zero');

      const firstOrder = !Number(account.first_order_done);
      const needsApproval = firstOrder && !!cfg['orders.first_order_approval'];

      const ins = await tx.query(
        'INSERT INTO b2b_orders (buyer_account_id, buyer_type, seller_type, seller_account_id, status, is_first_order, payment_method, ' +
        ' item_count, total_qty, subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total, tax_total, round_off, grand_total, cost_total, ' +
        ' seller_state_id, buyer_state_id, buyer_gstin, ship_name, ship_contact, ship_phone, ship_line1, ship_line2, ship_landmark, ship_city, ship_district, ' +
        ' ship_state, ship_pincode, ship_lat, ship_lng, buyer_notes, idempotency_key, placed_by_user_id, submitted_at) ' +
        "VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())",
        [accountId, account.account_type, seller.type, seller.accountId, firstOrder ? 1 : 0, method,
          qd.lines.length, t.qty, money.fromPaise(t.subtotal), money.fromPaise(t.discount), money.fromPaise(t.taxable), money.fromPaise(t.cgst),
          money.fromPaise(t.sgst), money.fromPaise(t.igst), money.fromPaise(t.tax), money.fromPaise(t.roundOff), money.fromPaise(t.grand), money.fromPaise(t.cost),
          qd.sellerStateId, account.state_id, account.gstin,
          account.shop_name || account.business_name, account.contact_person, account.mobile, account.address_line1, account.address_line2, account.landmark,
          account.city, account.district_name, account.state_name, account.pincode, account.latitude, account.longitude,
          v.text(body.notes, 500) || null, key, identity.user.id]);
      const orderId = ins.insertId;
      const orderNo = orderNumber(orderId);

      await tx.bulk(
        'INSERT INTO b2b_order_items (order_id, product_id, sku, name, hsn_code, pack_size, gst_rate, mrp, base_price, list_price, unit_price, price_source, price_rule_id, ' +
        'qty, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, line_total) VALUES ?',
        qd.lines.map(function (l) {
          const p = l.product, a = l.amounts;
          return [orderId, p.id, p.sku, p.name, p.hsn_code, p.pack_size, p.gst_rate, p.mrp, p.base_price, money.fromPaise(l.price.listPrice), money.fromPaise(l.price.unitPrice),
            l.price.source, l.price.ruleId, l.qty, money.fromPaise(a.discount), money.fromPaise(a.taxable), money.fromPaise(a.cgst), money.fromPaise(a.sgst),
            money.fromPaise(a.igst), money.fromPaise(a.total)];
        }));

      await insertFreeLines(tx, orderId, qd.lines);
      // Stock: reserved atomically (paid + free units) — or the whole order rolls back.
      const reservation = await reserveStock(tx, orderId, seller, reservationLines(qd.lines), cfg, actor);

      // Credit: checked and debited under a row lock.
      if (method === 'credit') {
        await payments.debit(tx, { debtorId: accountId, creditorId: seller.accountId || 0, amount: t.grand, orderId: orderId, note: 'Order ' + orderNo, actor: actor });
      }

      await history(tx, orderId, null, 'submitted', 'Order placed', actor);
      let status = 'submitted';
      const hop = async function (to, note) { await history(tx, orderId, status, to, note, audit.SYSTEM); status = to; };
      if (needsApproval) await hop('pending_admin_approval', 'First order — needs admin approval');
      else {
        await hop('approved', 'Auto-approved');
        await hop('assigned', seller.type === 'distributor' ? 'Assigned to mapped distributor' : 'Assigned to company fulfilment');
      }
      await tx.query(
        'UPDATE b2b_orders SET order_no = ?, status = ?, warehouse_id = ?, stock_reserved = ?' +
        (needsApproval ? '' : ', approved_at = UTC_TIMESTAMP(), assigned_at = UTC_TIMESTAMP()') + ' WHERE id = ?',
        [orderNo, status, reservation.warehouseId, reservation.reserved ? 1 : 0, orderId]);
      if (!needsApproval && firstOrder) await tx.query('UPDATE b2b_accounts SET first_order_done = 1 WHERE id = ?', [accountId]);
      await tx.query('DELETE FROM b2b_cart_items WHERE account_id = ?', [accountId]);

      await audit.log(tx, actor, 'order.placed', 'order', orderId, null,
        { order_no: orderNo, grand_total: money.fromPaise(t.grand), lines: qd.lines.length, seller: seller.type, seller_account_id: seller.accountId, payment_method: method, status: status });

      const brand = process.env.BRAND_NAME || 'Sake of Health';
      await notifications.notifyAccount(tx, accountId, {
        title: 'Order ' + orderNo + ' received',
        lines: ['We have received your order for ' + money.inr(t.grand) + ' (' + t.qty + ' units).',
          needsApproval ? 'As this is your first order it will be reviewed by our team before processing.' : 'It has been sent to ' + (seller.type === 'distributor' ? seller.name : brand) + ' for fulfilment.'],
        link: '/b2b/orders/' + orderId, refType: 'order', refId: orderId });
      if (needsApproval) {
        await notifications.notifyAdmins(tx, { title: 'First order needs approval: ' + orderNo,
          lines: [account.business_name + ' · ' + account.city + ' ' + account.pincode, 'Order value ' + money.inr(t.grand)],
          link: '/admin/b2b/orders.html?open=' + orderId, refType: 'order', refId: orderId });
      } else if (seller.type === 'distributor') {
        await notifications.notifyAccount(tx, seller.accountId, { title: 'New retailer order ' + orderNo,
          lines: [(account.shop_name || account.business_name) + ' · ' + account.city + ' ' + account.pincode, 'Order value ' + money.inr(t.grand) + '. Please accept it to start processing.'],
          link: '/b2b/retailer-orders/' + orderId, refType: 'order', refId: orderId });
      } else {
        await notifications.notifyAdmins(tx, { title: 'New B2B order ' + orderNo,
          lines: [account.business_name + ' · ' + account.city + ' ' + account.pincode, 'Order value ' + money.inr(t.grand)],
          link: '/admin/b2b/orders.html?open=' + orderId, refType: 'order', refId: orderId });
      }
      return { order: { id: orderId, order_no: orderNo, status: status, grand_total: money.fromPaise(t.grand), payment_method: method }, duplicate: false };
    });
  } catch (e) {
    // A concurrent request with the same key won the race: return ITS order.
    if (e.code === 'ER_DUP_ENTRY') {
      const winner = await findByIdempotencyKey(accountId, key);
      if (winner) return { order: winner, duplicate: true };
    }
    throw e;
  }
  return created;
}

/** Zero-price lines for free goods (buy N get M). */
async function insertFreeLines(tx, orderId, lines) {
  const free = lines.filter(function (l) { return l.free && l.free.qty > 0; });
  if (!free.length) return 0;
  await tx.bulk('INSERT INTO b2b_order_items (order_id, product_id, sku, name, hsn_code, pack_size, gst_rate, mrp, base_price, list_price, unit_price, price_source, price_rule_id, ' +
    'qty, discount_amount, taxable_amount, cgst_amount, sgst_amount, igst_amount, line_total) VALUES ?', free.map(function (l) {
    const p = l.product;
    return [orderId, p.id, p.sku, p.name + ' (free: ' + l.free.label + ')', p.hsn_code, p.pack_size, p.gst_rate, p.mrp, p.base_price, '0.00', '0.00', 'scheme_free', l.free.ruleId, l.free.qty, '0.00', '0.00', '0.00', '0.00', '0.00', '0.00'];
  }));
  const n = free.reduce(function (s2, l) { return s2 + l.free.qty; }, 0);
  await tx.query('UPDATE b2b_orders SET total_qty = total_qty + ? WHERE id = ?', [n, orderId]);
  return n;
}
/** Reservation needs paid + free units, one line per product. */
function reservationLines(lines) {
  return lines.map(function (l) { return { product_id: Number(l.product.id), qty: l.qty + (l.free ? l.free.qty : 0), sku: l.product.sku }; });
}

/** Reserve stock for an order from the right place. Returns { warehouseId, reserved }. */
async function reserveStock(tx, orderId, seller, lines, cfg, actor) {
  if (seller.type === 'company') {
    const whs = await inventory.companyWarehouses(tx);
    return { warehouseId: await inventory.reserveForOrder(tx, orderId, lines, whs, actor), reserved: true };
  }
  if (!cfg['inventory.track_distributor_stock']) return { warehouseId: null, reserved: false };
  const whs = await inventory.distributorWarehouses(seller.accountId, tx);
  return { warehouseId: await inventory.reserveForOrder(tx, orderId, lines, whs, actor), reserved: true };
}

/* ═════════════════ Read ═════════════════ */

function scopeWhere(scope, where, params) {
  if (scope.buyerAccountId != null) { where.push('o.buyer_account_id = ?'); params.push(scope.buyerAccountId); }
  if (scope.sellerAccountId != null) { where.push("o.seller_type = 'distributor' AND o.seller_account_id = ?"); params.push(scope.sellerAccountId); }
}

async function list(scope, f, pg) {
  const where = [], params = [];
  scopeWhere(scope, where, params);
  if (f.status) {
    const st = String(f.status).split(',').filter(function (s) { return sm.STATUSES.indexOf(s) !== -1; });
    if (st.length) { where.push('o.status IN (' + db.placeholders(st) + ')'); params.push.apply(params, st); }
  }
  if (f.buyer_type) { where.push('o.buyer_type = ?'); params.push(String(f.buyer_type)); }
  if (f.seller_type) { where.push('o.seller_type = ?'); params.push(String(f.seller_type)); }
  if (f.buyer_id) { where.push('o.buyer_account_id = ?'); params.push(Number(f.buyer_id)); }
  if (f.seller_id) { where.push('o.seller_account_id = ?'); params.push(Number(f.seller_id)); }
  if (f.payment_status) { where.push('o.payment_status = ?'); params.push(String(f.payment_status)); }
  if (f.on_hold) where.push('o.is_on_hold = 1');
  if (f.unassigned) where.push("o.buyer_type = 'retailer' AND o.seller_type = 'company' AND o.status IN ('pending_admin_approval','approved','assigned')");
  if (f.from) { where.push('o.created_at >= ?'); params.push(f.from + ' 00:00:00'); }
  if (f.to) { where.push('o.created_at <= ?'); params.push(f.to + ' 23:59:59'); }
  if (f.state_id) { where.push('o.buyer_state_id = ?'); params.push(Number(f.state_id)); }
  if (f.q) {
    const t = v.text(f.q, 80);
    if (/^B2B/i.test(t)) { where.push('o.order_no LIKE ?'); params.push(like(t.toUpperCase(), 'prefix')); }
    else if (/^\d{6}$/.test(t)) { where.push('o.ship_pincode = ?'); params.push(t); }
    else if (/^\d{7,10}$/.test(t)) { where.push('o.ship_phone LIKE ?'); params.push(like(t, 'prefix')); }
    else {
      // Name search: find the matching businesses first (a small table), then
      // their orders through the buyer index — never a scan of every order.
      const hits = await db.query('SELECT id FROM b2b_accounts WHERE business_name LIKE ? OR shop_name LIKE ? ORDER BY id DESC LIMIT 300', [like(t), like(t)]);
      if (hits.length) {
        where.push('(o.buyer_account_id IN (' + db.placeholders(hits) + ') OR o.order_no LIKE ?)');
        hits.forEach(function (h) { params.push(h.id); });
        params.push(like(t, 'prefix'));
      } else { where.push('o.order_no LIKE ?'); params.push(like(t, 'prefix')); }
    }
  }
  // Count and page on the orders table alone (index-only where possible), then
  // join the names for just the rows on this page.
  const cond = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_orders o' + cond, params);
  const sort = { total: 'o.grand_total', created: 'o.id', status: 'o.status' };
  const order = sort[f.sort] ? sort[f.sort] + (f.dir === 'asc' ? ' ASC' : ' DESC') + ', o.id DESC' : 'o.id DESC';
  const page = await db.query('SELECT o.id FROM b2b_orders o' + cond + ' ORDER BY ' + order + ' LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  if (!page.length) return { rows: [], total: Number(total.n) };
  const ids = page.map(function (r) { return r.id; });
  const found = await db.query(
    'SELECT o.id, o.order_no, o.status, o.is_on_hold, o.is_first_order, o.buyer_account_id, o.buyer_type, b.business_name AS buyer_name, b.shop_name AS buyer_shop, ' +
    'o.seller_type, o.seller_account_id, s.business_name AS seller_name, o.item_count, o.total_qty, o.grand_total, o.amount_paid, o.payment_method, o.payment_status, ' +
    'o.ship_city, o.ship_pincode, o.ship_phone, o.created_at, o.delivered_at ' +
    'FROM b2b_orders o JOIN b2b_accounts b ON b.id = o.buyer_account_id LEFT JOIN b2b_accounts s ON s.id = o.seller_account_id WHERE o.id IN (' + db.placeholders(ids) + ')', ids);
  const byId = {};
  found.forEach(function (r) { byId[r.id] = r; });
  const rows = ids.map(function (i) { return byId[i]; }).filter(Boolean);
  return { rows: rows, total: Number(total.n) };
}

function viewerFor(scope, order, cancelUntil) {
  if (scope.admin) return { kind: 'admin', permissions: scope.permissions || [] };
  if (scope.sellerAccountId != null && order.seller_type === 'distributor' && Number(order.seller_account_id) === Number(scope.sellerAccountId)) return { kind: 'seller' };
  if (scope.buyerAccountId != null && Number(order.buyer_account_id) === Number(scope.buyerAccountId)) return { kind: 'buyer', cancelUntil: cancelUntil };
  return null;
}

/** One order with everything needed to display it. `scope` decides visibility; out-of-scope ids look like 404. */
async function get(orderId, scope) {
  const where = ['o.id = ?'], params = [orderId];
  scopeWhere(scope, where, params);
  const o = await db.queryOne(
    'SELECT o.*, b.business_name AS buyer_name, b.shop_name AS buyer_shop, b.email AS buyer_email, b.contact_person AS buyer_contact, ' +
    's.business_name AS seller_name, s.mobile AS seller_mobile, w.code AS warehouse_code ' +
    'FROM b2b_orders o JOIN b2b_accounts b ON b.id = o.buyer_account_id LEFT JOIN b2b_accounts s ON s.id = o.seller_account_id ' +
    'LEFT JOIN b2b_warehouses w ON w.id = o.warehouse_id WHERE ' + where.join(' AND '), params);
  if (!o) throw notFound('Order not found');
  const [items, hist, invoice, pays, returns] = await Promise.all([
    db.query('SELECT i.*, p.image_url FROM b2b_order_items i LEFT JOIN b2b_products p ON p.id = i.product_id WHERE i.order_id = ? ORDER BY i.id', [orderId]),
    db.query('SELECT from_status, to_status, note, actor_type, actor_label, created_at FROM b2b_order_status_history WHERE order_id = ? ORDER BY id', [orderId]),
    db.queryOne("SELECT id, invoice_no, invoice_date, due_date, status FROM b2b_invoices WHERE order_id = ? ORDER BY (status = 'final') DESC, id DESC LIMIT 1", [orderId]),
    db.query("SELECT id, method, amount, reference, status, received_at, recorded_by FROM b2b_payments WHERE order_id = ? AND status IN ('received','reversed') ORDER BY id", [orderId]),
    db.query('SELECT id, return_no, status, resolution, created_at FROM b2b_returns WHERE order_id = ? ORDER BY id DESC', [orderId]),
  ]);
  const cancelUntil = await settings.get('orders.buyer_cancel_until');
  const viewer = viewerFor(scope, o, cancelUntil);
  const out = { order: o, items: items, history: hist, invoice: invoice, payments: pays, returns: returns,
    nextStatuses: viewer && !Number(o.is_on_hold) ? sm.nextFor(o.status, viewer).filter(function (s) { return s !== 'partially_delivered'; }) : [],
    outstanding: money.fromPaise(Math.max(0, money.toPaise(o.grand_total) - money.toPaise(o.amount_paid))) };
  if (!scope.admin) {
    // Buyers and sellers never see the company's cost / margin data or internal notes.
    delete o.cost_total; delete o.internal_notes; delete o.idempotency_key;
    items.forEach(function (i) { delete i.base_price; delete i.price_source; delete i.price_rule_id; });
    hist.forEach(function (h) { if (h.actor_type === 'admin') h.actor_label = 'Admin'; });
    pays.forEach(function (p) { delete p.recorded_by; });
  }
  for (const fn of DETAIL_EXTENDERS) {
    try { await fn(out, scope); } catch (e) { console.error('[ORDERS] order detail extension failed:', e.code || e.message); }
  }
  return out;
}

/* ═════════════════ Transitions ═════════════════ */

async function lockOrder(tx, orderId) {
  const o = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [orderId]);
  if (!o) throw notFound('Order not found');
  return o;
}

async function orderItems(tx, orderId) {
  return tx.query('SELECT * FROM b2b_order_items WHERE order_id = ? ORDER BY id', [orderId]);
}

/** After a credit note: reduce what is owed; anything already paid beyond that becomes a refund due. */
async function settleCreditNote(tx, order, creditNote, actor) {
  const fresh = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [order.id]);
  const outstanding = money.toPaise(fresh.grand_total) - money.toPaise(fresh.amount_paid);
  const applied = Math.max(0, Math.min(creditNote.grandTotal, outstanding));
  if (applied > 0) {
    await payments.applyToOrder(tx, fresh, { amount: applied, method: 'credit_note', reference: creditNote.creditNoteNo, note: 'Credit note ' + creditNote.creditNoteNo, actor: actor });
  }
  const refund = creditNote.grandTotal - applied;
  await invoices.setCreditNoteSettlement(tx, creditNote.id, applied, refund);
  return { applied: applied, refund: refund };
}

const STATUS_COPY = {
  approved: ['approved', 'Your order has been approved.'],
  accepted: ['accepted', 'Your order has been accepted and will be processed shortly.'],
  processing: ['is being processed', 'Your order is being prepared.'],
  packed: ['packed', 'Your order is packed and ready for dispatch.'],
  dispatched: ['dispatched', 'Your order has been dispatched.'],
  out_for_delivery: ['out for delivery', 'Your order is out for delivery today.'],
  delivered: ['delivered', 'Your order has been delivered. Thank you for your business.'],
  partially_delivered: ['partially delivered', 'Part of your order has been delivered. A credit note has been raised for the items not delivered.'],
  cancelled: ['cancelled', 'Your order has been cancelled.'],
  returned: ['could not be delivered', 'We could not deliver your order, so the goods have gone back to the warehouse. Please contact us to arrange delivery again.'],
  rejected: ['not approved', 'Your order could not be approved.'],
  refunded: ['refunded', 'The amount paid for this order has been refunded.'],
};

/**
 * Move an order to a new status.
 * scope: { admin: true, permissions } | { sellerAccountId } | { buyerAccountId } | { system: true }
 * opts:  { note, delivered: { <order_item_id>: qty } }
 */
async function transition(orderId, toStatus, scope, actor, opts) {
  opts = opts || {};
  if (sm.STATUSES.indexOf(toStatus) === -1) throw bad('Unknown order status');
  const note = v.text(opts.note, 500);
  const cfg = await settings.all();
  return db.transaction(async function (tx) {
    const order = await lockOrder(tx, orderId);
    const viewer = scope.system ? { kind: 'system' } : viewerFor(scope, order, cfg['orders.buyer_cancel_until']);
    if (!viewer) throw notFound('Order not found');
    if (order.status === toStatus) return { status: order.status, unchanged: true };
    if (Number(order.is_on_hold) && toStatus !== 'cancelled') throw bad('This order is on hold' + (order.hold_reason ? ': ' + order.hold_reason : '') + '. Release the hold first.');
    const items = await orderItems(tx, orderId);

    // Delivery quantities decide between delivered and partially_delivered.
    let delivered = null, shortLines = [];
    if (toStatus === 'delivered' || toStatus === 'partially_delivered') {
      delivered = {};
      items.forEach(function (it) {
        let q = opts.delivered && opts.delivered[it.id] != null ? Number(opts.delivered[it.id]) : Number(it.qty);
        if (!Number.isInteger(q) || q < 0 || q > Number(it.qty)) throw bad('Delivered quantity for ' + it.sku + ' must be between 0 and ' + it.qty);
        delivered[it.id] = q;
        if (q < Number(it.qty)) shortLines.push({ item: it, qty: Number(it.qty) - q });
      });
      if (items.every(function (it) { return delivered[it.id] === 0; })) throw bad('Nothing was delivered — cancel or return the order instead');
      toStatus = shortLines.length ? 'partially_delivered' : 'delivered';
    }
    if (!sm.allowed(order.status, toStatus, viewer)) {
      throw new AppError(409, 'An order that is "' + sm.LABEL[order.status] + '" cannot be moved to "' + sm.LABEL[toStatus] + '"' + (viewer.kind === 'admin' ? ' with your permissions' : ''),
        { code: 'INVALID_TRANSITION', from: order.status, to: toStatus });
    }
    if ((toStatus === 'cancelled' || toStatus === 'rejected') && note.length < 3 && viewer.kind !== 'buyer') throw bad('Please give a reason');
    if (order.status === 'assigned' && toStatus === 'approved' && note.length < 3) throw bad('Please say why the order is being declined');

    const sets = ['status = ?'], params = [toStatus];
    const col = sm.TIMESTAMP_COLUMN[toStatus];
    if (col) sets.push(col + ' = UTC_TIMESTAMP()');
    let extra = {};

    if (toStatus === 'approved' && order.status === 'pending_admin_approval') {
      await tx.query('UPDATE b2b_accounts SET first_order_done = 1 WHERE id = ?', [order.buyer_account_id]);
    }
    if (toStatus === 'packed') await inventory.allocateForOrder(tx, order, items, actor);
    if (toStatus === 'dispatched') {
      if (cfg['orders.require_payment_before_dispatch'] && order.payment_method !== 'credit' && order.payment_status !== 'paid') {
        throw bad('This order must be paid before it can be dispatched');
      }
      await inventory.dispatchOrder(tx, order, actor);
      if (cfg['invoice.generate_on'] === 'dispatched') extra.invoice = await invoices.createForOrder(tx, order, items, actor);
    }
    if (toStatus === 'delivered' || toStatus === 'partially_delivered') {
      await inventory.deliverOrder(tx, order, items, delivered, actor);
      for (const it of items) await tx.query('UPDATE b2b_order_items SET qty_delivered = ? WHERE id = ?', [delivered[it.id], it.id]);
      const invoice = await invoices.createForOrder(tx, order, items, actor);
      extra.invoice = invoice;
      if (shortLines.length) {
        const cn = await invoices.createCreditNote(tx, invoice, shortLines, { reason: 'Short delivery', actor: actor });
        extra.creditNote = Object.assign({ creditNoteNo: cn.creditNoteNo }, await settleCreditNote(tx, order, cn, actor));
      }
      await tx.query('UPDATE b2b_accounts SET first_order_done = 1 WHERE id = ?', [order.buyer_account_id]);
    }
    if (toStatus === 'cancelled' || toStatus === 'rejected') {
      await inventory.releaseForOrder(tx, order, items, actor, toStatus);
      sets.push('stock_reserved = 0', 'cancel_reason = ?'); params.push(note || (viewer.kind === 'buyer' ? 'Cancelled by buyer' : null));
      if (order.payment_method === 'credit') {
        const unpaid = money.toPaise(order.grand_total) - money.toPaise(order.amount_paid);
        if (unpaid > 0) await payments.release(tx, { debtorId: order.buyer_account_id, creditorId: order.seller_account_id || 0, amount: unpaid, orderId: order.id, note: 'Order ' + toStatus, actor: actor });
      }
    }
    if (toStatus === 'returned' && (order.status === 'dispatched' || order.status === 'out_for_delivery')) {
      if (note.length < 3) throw bad('Please say why the order could not be delivered');
      await inventory.returnUndelivered(tx, order, actor, opts.condition === 'damaged' ? 'damaged' : 'good', 'not delivered: ' + note);
      sets.push('stock_reserved = 0', 'cancel_reason = ?'); params.push(note);
      if (order.payment_method === 'credit') {
        const unpaid = money.toPaise(order.grand_total) - money.toPaise(order.amount_paid);
        if (unpaid > 0) await payments.release(tx, { debtorId: order.buyer_account_id, creditorId: order.seller_account_id || 0, amount: unpaid, orderId: order.id, note: 'Order returned undelivered', actor: actor });
      }
    }
    if (toStatus === 'refunded') {
      const refunded = await payments.refundOrder(tx, order, actor, note || 'Refund');
      if (refunded <= 0) throw bad('Nothing has been paid on this order, so there is nothing to refund');
      extra.refunded = money.fromPaise(refunded);
    }

    params.push(orderId);
    await tx.query('UPDATE b2b_orders SET ' + sets.join(', ') + ' WHERE id = ?', params);
    await history(tx, orderId, order.status, toStatus, note, actor);
    await audit.log(tx, actor, 'order.' + toStatus, 'order', orderId, { status: order.status }, { status: toStatus, note: note || null });

    // Chain: an approved order with a seller goes straight to "assigned".
    let finalStatus = toStatus;
    if (toStatus === 'approved' && order.status === 'pending_admin_approval') {
      await tx.query("UPDATE b2b_orders SET status = 'assigned', assigned_at = UTC_TIMESTAMP() WHERE id = ?", [orderId]);
      await history(tx, orderId, 'approved', 'assigned', order.seller_type === 'distributor' ? 'Assigned to mapped distributor' : 'Assigned to company fulfilment', audit.SYSTEM);
      finalStatus = 'assigned';
      if (order.seller_type === 'distributor') {
        await notifications.notifyAccount(tx, order.seller_account_id, { title: 'New retailer order ' + order.order_no,
          lines: [order.ship_name + ' · ' + order.ship_city + ' ' + order.ship_pincode, 'Order value ' + money.inr(money.toPaise(order.grand_total)) + '. Please accept it to start processing.'],
          link: '/b2b/retailer-orders/' + orderId, refType: 'order', refId: orderId });
      }
    }

    const copy = STATUS_COPY[toStatus];
    if (copy) {
      const lines = [copy[1]];
      if (note && (toStatus === 'cancelled' || toStatus === 'rejected' || toStatus === 'returned')) lines.push('Reason: ' + note);
      if (extra.invoice && (toStatus === 'dispatched' || toStatus === 'delivered')) lines.push('Invoice ' + extra.invoice.invoice_no + ' is available in your portal.');
      await notifications.notifyAccount(tx, order.buyer_account_id, { title: 'Order ' + order.order_no + ' ' + copy[0], lines: lines,
        link: '/b2b/orders/' + orderId, refType: 'order', refId: orderId });
    }
    if (order.status === 'assigned' && toStatus === 'approved') {
      await notifications.notifyAdmins(tx, { title: 'Order ' + order.order_no + ' was declined by the distributor', lines: ['Reason: ' + note, 'Please assign another distributor or fulfil it directly.'],
        link: '/admin/b2b/orders.html?open=' + orderId, refType: 'order', refId: orderId });
    }
    if (toStatus === 'cancelled' && viewer.kind === 'buyer' && order.seller_type === 'distributor') {
      await notifications.notifyAccount(tx, order.seller_account_id, { title: 'Order ' + order.order_no + ' was cancelled by the retailer', lines: [note || ''],
        link: '/b2b/retailer-orders/' + orderId, refType: 'order', refId: orderId });
    }
    return { status: finalStatus, from: order.status, invoiceNo: extra.invoice ? extra.invoice.invoice_no : null, creditNote: extra.creditNote || null, refunded: extra.refunded || null };
  }).then(function (result) {
    // after the commit: let other modules (delivery) follow the change; their failure never undoes it
    if (!result.unchanged) TRANSITION_HOOKS.forEach(function (fn) {
      Promise.resolve().then(function () { return fn(orderId, result.from, result.status, actor); }).catch(function (e) { console.error('[ORDERS] after-transition hook failed:', e.code || e.message); });
    });
    return result;
  });
}

/* Other modules may follow order changes and add to the order view (the delivery module does both). */
const TRANSITION_HOOKS = [], DETAIL_EXTENDERS = [];
function onTransition(fn) { TRANSITION_HOOKS.push(fn); }
function extendDetail(fn) { DETAIL_EXTENDERS.push(fn); }

/* ═════════════════ Admin tools ═════════════════ */

async function setHold(orderId, hold, reason, actor) {
  reason = v.text(reason, 300);
  if (hold && reason.length < 3) throw bad('Please give a reason for the hold');
  return db.transaction(async function (tx) {
    const order = await lockOrder(tx, orderId);
    if (sm.OPEN.indexOf(order.status) === -1) throw bad('Only open orders can be put on hold');
    await tx.query('UPDATE b2b_orders SET is_on_hold = ?, hold_reason = ? WHERE id = ?', [hold ? 1 : 0, hold ? reason : null, orderId]);
    await history(tx, orderId, order.status, order.status, hold ? 'On hold: ' + reason : 'Hold released', actor);
    await audit.log(tx, actor, hold ? 'order.hold' : 'order.hold_released', 'order', orderId, { is_on_hold: order.is_on_hold }, { is_on_hold: hold ? 1 : 0, reason: reason });
    return { ok: true };
  });
}

async function recalcTotals(tx, order, interstate) {
  const items = await orderItems(tx, order.id);
  const t = { subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cost: 0, qty: 0 };
  for (const it of items) {
    const a = lineAmounts(money.toPaise(it.unit_price), money.toPaise(it.list_price), Number(it.qty), it.gst_rate, interstate);
    await tx.query('UPDATE b2b_order_items SET discount_amount = ?, taxable_amount = ?, cgst_amount = ?, sgst_amount = ?, igst_amount = ?, line_total = ? WHERE id = ?',
      [money.fromPaise(a.discount), money.fromPaise(a.taxable), money.fromPaise(a.cgst), money.fromPaise(a.sgst), money.fromPaise(a.igst), money.fromPaise(a.total), it.id]);
    t.subtotal += a.gross; t.discount += a.discount; t.taxable += a.taxable; t.cgst += a.cgst; t.sgst += a.sgst; t.igst += a.igst;
    t.cost += money.toPaise(it.base_price) * Number(it.qty); t.qty += Number(it.qty);
  }
  const tax = t.cgst + t.sgst + t.igst;
  const r = money.roundToRupee(t.taxable + tax);
  await tx.query(
    'UPDATE b2b_orders SET item_count = ?, total_qty = ?, subtotal = ?, discount_total = ?, taxable_total = ?, cgst_total = ?, sgst_total = ?, igst_total = ?, tax_total = ?, ' +
    'round_off = ?, grand_total = ?, cost_total = ? WHERE id = ?',
    [items.length, t.qty, money.fromPaise(t.subtotal), money.fromPaise(t.discount), money.fromPaise(t.taxable), money.fromPaise(t.cgst), money.fromPaise(t.sgst),
      money.fromPaise(t.igst), money.fromPaise(tax), money.fromPaise(r.roundOff), money.fromPaise(r.rounded), money.fromPaise(t.cost), order.id]);
  return r.rounded;
}

/** Admin: reduce quantities (or drop lines) on an order that is awaiting approval. Prices are not re-negotiated. */
async function adjustQuantities(orderId, changes, actor) {
  if (!Array.isArray(changes) || !changes.length) throw bad('No quantity changes supplied');
  return db.transaction(async function (tx) {
    const order = await lockOrder(tx, orderId);
    if (order.status !== 'pending_admin_approval') throw bad('Quantities can only be adjusted while the order is awaiting approval');
    const items = await orderItems(tx, orderId);
    const byId = {}; items.forEach(function (it) { byId[it.id] = it; });
    const before = {}, after = {};
    let remaining = items.length;
    for (const c of changes) {
      const it = byId[Number(c.order_item_id)];
      if (!it) throw bad('Order line not found');
      const qty = Number(c.qty);
      if (!Number.isInteger(qty) || qty < 0 || qty > Number(it.qty)) throw bad('Quantity for ' + it.sku + ' must be between 0 and ' + it.qty + ' (quantities can only be reduced)');
      if (qty === Number(it.qty)) continue;
      const diff = Number(it.qty) - qty;
      if (Number(order.stock_reserved) && order.warehouse_id) {
        const ok = await inventory.move(tx, { warehouse_id: order.warehouse_id, product_id: it.product_id, type: 'release', qty: diff, from: 'reserved', to: 'available',
          ref_type: 'order', ref_id: orderId, reason: 'quantity reduced by admin', actor: actor });
        if (!ok) throw new Error('Stock ledger out of sync adjusting order ' + orderId);
      }
      before[it.sku] = Number(it.qty); after[it.sku] = qty;
      if (qty === 0) { await tx.query('DELETE FROM b2b_order_items WHERE id = ?', [it.id]); remaining--; }
      else await tx.query('UPDATE b2b_order_items SET qty = ? WHERE id = ?', [qty, it.id]);
    }
    if (!Object.keys(after).length) return { changed: false };
    if (remaining <= 0) throw bad('An order must keep at least one line — reject the order instead');
    const interstate = order.seller_state_id == null || Number(order.seller_state_id) !== Number(order.buyer_state_id);
    const newTotal = await recalcTotals(tx, order, interstate);
    if (order.payment_method === 'credit') {
      const reduce = money.toPaise(order.grand_total) - newTotal;
      if (reduce > 0) await payments.release(tx, { debtorId: order.buyer_account_id, creditorId: order.seller_account_id || 0, amount: reduce, orderId: orderId, note: 'Quantity reduced', actor: actor });
    }
    await history(tx, orderId, order.status, order.status, 'Quantities adjusted by admin', actor);
    await audit.log(tx, actor, 'order.quantities_adjusted', 'order', orderId, { qty: before, grand_total: order.grand_total }, { qty: after, grand_total: money.fromPaise(newTotal) });
    await notifications.notifyAccount(tx, order.buyer_account_id, { title: 'Order ' + order.order_no + ' was updated',
      lines: ['Some quantities on your order were adjusted during review. The new order total is ' + money.inr(newTotal) + '.'], link: '/b2b/orders/' + orderId, refType: 'order', refId: orderId });
    return { changed: true, grand_total: money.fromPaise(newTotal) };
  });
}

/**
 * Admin: change who supplies an order — another distributor, or the company
 * directly (distributorId = null). Allowed until the seller has accepted it.
 * Stock, credit and the GST split are all moved to the new seller atomically.
 */
async function reassignSeller(orderId, distributorId, reason, actor, canOverrideCredit) {
  reason = v.text(reason, 300);
  if (reason.length < 3) throw bad('Please give a reason for changing the distributor');
  const cfg = await settings.all();
  return db.transaction(async function (tx) {
    const order = await lockOrder(tx, orderId);
    if (['pending_admin_approval', 'approved', 'assigned'].indexOf(order.status) === -1) throw bad('The distributor can only be changed before the order has been accepted');
    if (order.buyer_type !== 'retailer') throw bad('Only retailer orders are supplied by distributors');
    let seller = { type: 'company', accountId: null, name: process.env.BRAND_NAME || 'Sake of Health' };
    if (distributorId != null) {
      const d = await tx.queryOne("SELECT id, business_name, status, account_type FROM b2b_accounts WHERE id = ?", [distributorId]);
      if (!d || d.account_type !== 'distributor') throw bad('Distributor not found');
      if (d.status !== 'approved') throw bad('That distributor is not approved');
      seller = { type: 'distributor', accountId: Number(d.id), name: d.business_name };
    }
    const same = order.seller_type === seller.type && Number(order.seller_account_id || 0) === Number(seller.accountId || 0);
    const items = await orderItems(tx, orderId);
    const unpaid = money.toPaise(order.grand_total) - money.toPaise(order.amount_paid);
    let newTotal = money.toPaise(order.grand_total);
    const sets = [], params = [];
    if (!same) {
      await inventory.releaseForOrder(tx, order, items, actor, 'seller changed');
      if (order.payment_method === 'credit' && unpaid > 0) {
        await payments.release(tx, { debtorId: order.buyer_account_id, creditorId: order.seller_account_id || 0, amount: unpaid, orderId: orderId, note: 'Supplier changed', actor: actor });
      }
      const stateId = await sellerStateId(seller, tx);
      const interstate = stateId == null || Number(stateId) !== Number(order.buyer_state_id);
      newTotal = await recalcTotals(tx, order, interstate);
      const res = await reserveStock(tx, orderId, seller, items.map(function (it) { return { product_id: Number(it.product_id), qty: Number(it.qty), sku: it.sku }; }), cfg, actor);
      let method = order.payment_method;
      if (method === 'gateway' && seller.type !== 'company') method = 'bank_transfer';
      if (method === 'credit') {
        await payments.debit(tx, { debtorId: order.buyer_account_id, creditorId: seller.accountId || 0, amount: newTotal - money.toPaise(order.amount_paid),
          orderId: orderId, note: 'Order ' + order.order_no, actor: actor, force: !!canOverrideCredit });
      }
      sets.push('seller_type = ?', 'seller_account_id = ?', 'seller_state_id = ?', 'warehouse_id = ?', 'stock_reserved = ?', 'payment_method = ?');
      params.push(seller.type, seller.accountId, stateId, res.warehouseId, res.reserved ? 1 : 0, method);
    }
    let status = order.status;
    if (order.status !== 'pending_admin_approval') { status = 'assigned'; sets.push("status = 'assigned'", 'assigned_at = UTC_TIMESTAMP()'); }
    if (sets.length) { params.push(orderId); await tx.query('UPDATE b2b_orders SET ' + sets.join(', ') + ' WHERE id = ?', params); }
    await history(tx, orderId, order.status, status, 'Supplier set to ' + seller.name + ': ' + reason, actor);
    await audit.log(tx, actor, 'order.distributor_changed', 'order', orderId,
      { seller_type: order.seller_type, seller_account_id: order.seller_account_id }, { seller_type: seller.type, seller_account_id: seller.accountId, reason: reason });
    if (seller.type === 'distributor' && status === 'assigned') {
      await notifications.notifyAccount(tx, seller.accountId, { title: 'New retailer order ' + order.order_no,
        lines: [order.ship_name + ' · ' + order.ship_city + ' ' + order.ship_pincode, 'Order value ' + money.inr(newTotal) + '. Please accept it to start processing.'],
        link: '/b2b/retailer-orders/' + orderId, refType: 'order', refId: orderId });
    }
    return { status: status, seller: seller };
  });
}

async function setInternalNote(orderId, note, actor) {
  const o = await db.queryOne('SELECT id FROM b2b_orders WHERE id = ?', [orderId]);
  if (!o) throw notFound('Order not found');
  await db.query('UPDATE b2b_orders SET internal_notes = ? WHERE id = ?', [v.text(note, 1000) || null, orderId]);
  audit.logSoft(actor, 'order.note_updated', 'order', orderId, null, null);
  return { ok: true };
}

/** Admin: raise the invoice manually (e.g. when invoices are set to generate on delivery but one is needed earlier). */
async function generateInvoice(orderId, actor) {
  return db.transaction(async function (tx) {
    const order = await lockOrder(tx, orderId);
    if (['packed', 'dispatched', 'out_for_delivery', 'delivered', 'partially_delivered'].indexOf(order.status) === -1) throw bad('An invoice can be raised once the order is packed');
    const inv = await invoices.createForOrder(tx, order, await orderItems(tx, orderId), actor);
    return { id: Number(inv.id), invoice_no: inv.invoice_no };
  });
}

/* ═════════════════ Reorder ═════════════════ */

/** Rebuild the cart from a past order, re-checked against today's catalogue, MOQ and stock. Prices are today's. */
async function reorder(account, orderId) {
  const order = await db.queryOne('SELECT id, order_no FROM b2b_orders WHERE id = ? AND buyer_account_id = ?', [orderId, account.id]);
  if (!order) throw notFound('Order not found');
  const lines = await db.query(
    'SELECT i.product_id, i.sku, i.name, i.qty, p.is_active, p.avail_retailer, p.avail_distributor, p.effective_from, p.moq, p.case_qty, p.enforce_case_multiple ' +
    'FROM b2b_order_items i JOIN b2b_products p ON p.id = i.product_id WHERE i.order_id = ?', [orderId]);
  const seller = await sellerFor(account);
  const source = await catalogue.stockSourceFor(account, seller.accountId);
  const stock = source.tracked ? await inventory.availability(lines.map(function (l) { return Number(l.product_id); }), source.warehouseIds) : {};
  const today = new Date().toISOString().slice(0, 10);
  const add = [], notes = [];
  lines.forEach(function (l) {
    const eff = l.effective_from ? new Date(l.effective_from).toISOString().slice(0, 10) : null;
    if (!Number(l.is_active) || !Number(l['avail_' + account.account_type]) || (eff && eff > today)) { notes.push({ sku: l.sku, name: l.name, status: 'unavailable', message: 'No longer available' }); return; }
    let qty = Number(l.qty);
    const min = catalogue.minValidQty(l), caseQty = Number(l.case_qty) || 1;
    if (qty < min) qty = min;
    if (caseQty > 1 && Number(l.enforce_case_multiple) && qty % caseQty !== 0) qty = Math.ceil(qty / caseQty) * caseQty;
    if (source.tracked) {
      const have = stock[l.product_id] || 0;
      if (have < min) { notes.push({ sku: l.sku, name: l.name, status: 'out_of_stock', message: 'Out of stock' }); return; }
      if (have < qty) {
        qty = caseQty > 1 && Number(l.enforce_case_multiple) ? Math.floor(have / caseQty) * caseQty : have;
        if (qty < min) { notes.push({ sku: l.sku, name: l.name, status: 'out_of_stock', message: 'Not enough stock' }); return; }
        notes.push({ sku: l.sku, name: l.name, status: 'reduced', message: 'Only ' + qty + ' available (you ordered ' + l.qty + ')' });
      }
    }
    if (qty !== Number(l.qty) && !notes.some(function (n) { return n.sku === l.sku; })) notes.push({ sku: l.sku, name: l.name, status: 'adjusted', message: 'Quantity changed to ' + qty + ' to meet the current MOQ / case size' });
    add.push([account.id, Number(l.product_id), qty]);
  });
  if (!add.length) throw bad('None of the items from that order can be re-ordered right now');
  await db.transaction(async function (tx) {
    await tx.query('DELETE FROM b2b_cart_items WHERE account_id = ?', [account.id]);
    await tx.bulk('INSERT INTO b2b_cart_items (account_id, product_id, qty) VALUES ?', add);
  });
  return { added: add.length, notes: notes, fromOrder: order.order_no };
}

/* ═════════════════ Print data (delivery labels + bills) ═════════════════ */

async function printData(orderIds, scope) {
  const ids = Array.from(new Set((orderIds || []).map(Number).filter(function (n) { return Number.isInteger(n) && n > 0; }))).slice(0, 100);
  if (!ids.length) throw bad('No orders selected');
  const where = ['o.id IN (' + db.placeholders(ids) + ')'], params = ids.slice();
  scopeWhere(scope, where, params);
  const orders = await db.query(
    'SELECT o.id, o.order_no, o.status, o.created_at, o.buyer_type, o.seller_type, o.seller_account_id, o.payment_method, o.payment_status, o.amount_paid, ' +
    'o.item_count, o.total_qty, o.subtotal, o.discount_total, o.taxable_total, o.cgst_total, o.sgst_total, o.igst_total, o.tax_total, o.round_off, o.grand_total, ' +
    'o.buyer_gstin, o.ship_name, o.ship_contact, o.ship_phone, o.ship_line1, o.ship_line2, o.ship_landmark, o.ship_city, o.ship_district, o.ship_state, o.ship_pincode, ' +
    'o.ship_lat, o.ship_lng, o.buyer_notes, b.business_name AS buyer_name ' +
    'FROM b2b_orders o JOIN b2b_accounts b ON b.id = o.buyer_account_id WHERE ' + where.join(' AND ') + ' ORDER BY o.id', params);
  if (!orders.length) throw notFound('Order not found');
  const found = orders.map(function (o) { return Number(o.id); });
  const ph = db.placeholders(found);
  const items = await db.query('SELECT order_id, sku, name, hsn_code, pack_size, qty, mrp, list_price, unit_price, discount_amount, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total ' +
    'FROM b2b_order_items WHERE order_id IN (' + ph + ') ORDER BY id', found);
  const invs = await db.query('SELECT order_id, invoice_no, invoice_date, due_date, is_interstate, place_of_supply, seller_name, seller_gstin, seller_pan, seller_address, seller_state, seller_state_code, seller_phone, seller_email ' +
    'FROM b2b_invoices WHERE live_order_id IN (' + ph + ')', found);
  const invByOrder = {}; invs.forEach(function (i) { invByOrder[i.order_id] = i; });
  const sellers = {};
  const out = [];
  for (const o of orders) {
    const k = o.seller_type + ':' + (o.seller_account_id || 0);
    if (!sellers[k]) sellers[k] = await invoices.sellerCard(o.seller_type, o.seller_account_id);
    const s = sellers[k];
    out.push({
      order: o,
      items: items.filter(function (i) { return Number(i.order_id) === Number(o.id); }),
      invoice: invByOrder[o.id] || null,
      seller: { name: s.name, brand: s.brand || s.name, gstin: s.gstin, pan: s.pan, address: s.address, state: s.state, stateCode: s.stateCode,
        phone: s.phone, email: s.email, bankDetails: s.bankDetails, footer: s.footer },
    });
  }
  return { documents: out };
}

module.exports = {
  PAYMENT_METHODS, sellerFor, quote, getCart, setCartItem, addManyToCart, clearCart, placeOrder,
  list, get, transition, setHold, adjustQuantities, reassignSeller, setInternalNote, generateInvoice, reorder, printData,
  settleCreditNote, lockOrder, orderItems, history, scopeWhere, insertFreeLines, reservationLines, onTransition, extendDetail,
};
