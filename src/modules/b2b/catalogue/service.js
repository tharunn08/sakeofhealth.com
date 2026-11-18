/**
 * Central product master + database-driven categories.
 *
 * One product row serves three channels (avail_b2c / avail_retailer /
 * avail_distributor). B2C keeps its own prices in the existing storefront
 * store; nothing here ever reads or writes a B2C price.
 */
const db = require('../../../db/connection.js');
const v = require('../lib/validate.js');
const money = require('../lib/money.js');
const audit = require('../lib/audit.js');
const settings = require('../lib/settings.js');
const engine = require('../pricing/engine.js');
const inventory = require('../inventory/service.js');
const { bad, notFound, conflict, like } = require('../lib/http.js');

/* ─────────── Categories ─────────── */

async function listCategories(activeOnly) {
  const rows = await db.query(
    'SELECT c.id, c.parent_id, c.name, c.slug, c.sort_order, c.is_active, ' +
    '  (SELECT COUNT(*) FROM b2b_products p WHERE (p.category_id = c.id OR p.subcategory_id = c.id) AND p.is_active = 1) AS product_count ' +
    'FROM b2b_categories c' + (activeOnly ? ' WHERE c.is_active = 1' : '') + ' ORDER BY (c.parent_id IS NOT NULL), c.sort_order, c.name');
  const top = rows.filter(function (r) { return r.parent_id == null; });
  top.forEach(function (t) { t.children = rows.filter(function (r) { return Number(r.parent_id) === Number(t.id); }); });
  return top;
}

async function uniqueSlug(base, ignoreId) {
  let slug = base, n = 1;
  for (;;) {
    const hit = await db.queryOne('SELECT id FROM b2b_categories WHERE slug = ?', [slug]);
    if (!hit || Number(hit.id) === Number(ignoreId)) return slug;
    slug = base + '-' + (++n);
  }
}

async function saveCategory(id, b, actor) {
  const name = v.text(b.name, 100);
  if (name.length < 2) throw bad('Category name is required');
  const parentId = v.posInt(b.parent_id);
  if (parentId) {
    const parent = await db.queryOne('SELECT id, parent_id FROM b2b_categories WHERE id = ?', [parentId]);
    if (!parent) throw bad('Parent category not found');
    if (parent.parent_id != null) throw bad('Sub-categories can only be one level deep');
    if (id && Number(parentId) === Number(id)) throw bad('A category cannot be its own parent');
  }
  const clash = await db.queryOne('SELECT id FROM b2b_categories WHERE name = ? AND parent_id <=> ? AND id <> ?', [name, parentId, id || 0]);
  if (clash) throw conflict('A category with that name already exists here');
  const sortOrder = v.intOrNull(b.sort_order) || 0;
  const active = v.bool(b.is_active, true) ? 1 : 0;
  if (id) {
    const before = await db.queryOne('SELECT * FROM b2b_categories WHERE id = ?', [id]);
    if (!before) throw notFound('Category not found');
    await db.query('UPDATE b2b_categories SET name = ?, parent_id = ?, sort_order = ?, is_active = ? WHERE id = ?', [name, parentId, sortOrder, active, id]);
    await audit.log(null, actor, 'category.updated', 'category', id, before, { name: name, parent_id: parentId, sort_order: sortOrder, is_active: active });
    return { id: Number(id) };
  }
  const slug = await uniqueSlug(v.slug(name));
  const res = await db.query('INSERT INTO b2b_categories (parent_id, name, slug, sort_order, is_active) VALUES (?, ?, ?, ?, ?)', [parentId, name, slug, sortOrder, active]);
  await audit.log(null, actor, 'category.created', 'category', res.insertId, null, { name: name, parent_id: parentId });
  return { id: res.insertId };
}

/** Find a category by name (optionally under a parent), creating it if needed. Used by the Excel import. */
async function ensureCategory(tx, name, parentId, cache) {
  name = v.text(name, 100);
  if (!name) return null;
  const key = (parentId || 0) + '|' + name.toLowerCase();
  if (cache && cache[key]) return cache[key];
  let row = await tx.queryOne('SELECT id FROM b2b_categories WHERE name = ? AND parent_id <=> ?', [name, parentId || null]);
  if (!row) {
    let slug = v.slug(name), n = 1;
    while (await tx.queryOne('SELECT id FROM b2b_categories WHERE slug = ?', [slug])) slug = v.slug(name) + '-' + (++n);
    const res = await tx.query('INSERT INTO b2b_categories (parent_id, name, slug) VALUES (?, ?, ?)', [parentId || null, name, slug]);
    row = { id: res.insertId };
  }
  if (cache) cache[key] = Number(row.id);
  return Number(row.id);
}

/* ─────────── Products (admin) ─────────── */

const PRODUCT_FIELDS = ['sku', 'name', 'category_id', 'subcategory_id', 'brand', 'description', 'image_url', 'barcode', 'hsn_code',
  'gst_rate', 'mrp', 'base_price', 'distributor_price', 'retailer_price', 'distributor_margin', 'retailer_margin', 'moq', 'case_qty',
  'enforce_case_multiple', 'pack_size', 'low_stock_threshold', 'avail_b2c', 'avail_retailer', 'avail_distributor', 'b2c_ref',
  'is_active', 'effective_from'];
const PRICE_FIELDS = ['mrp', 'base_price', 'distributor_price', 'retailer_price', 'distributor_margin', 'retailer_margin', 'gst_rate'];
const GST_RATES = [0, 0.1, 0.25, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

/**
 * Validate + normalise product input. `partial` = only validate keys present.
 * Returns { data, errors[] } — also used row-by-row by the Excel import.
 */
function readProduct(b, partial) {
  const errors = [], data = {};
  const has = function (k) { return b[k] !== undefined && !(partial && b[k] === ''); };
  const need = function (k) { return !partial || b[k] !== undefined; };

  if (need('sku')) {
    data.sku = v.text(b.sku, 64);
    if (!data.sku) errors.push('Missing SKU'); else if (!v.isSku(data.sku)) errors.push('Invalid SKU (letters, digits, . _ - / only)');
  }
  if (need('name')) { data.name = v.text(b.name, 200); if (data.name.length < 2) errors.push('Missing product name'); }
  if (has('brand')) data.brand = v.text(b.brand, 100) || null;
  if (has('description')) data.description = String(b.description || '').slice(0, 5000) || null;
  if (has('image_url')) {
    data.image_url = v.text(b.image_url, 500) || null;
    if (data.image_url && !/^(https:\/\/|\/)[^\s"'<>]+$/i.test(data.image_url)) errors.push('Image must be an https:// link or a /path on this site');
  }
  if (has('barcode')) { data.barcode = v.text(b.barcode, 64) || null; if (data.barcode && !/^[0-9A-Za-z\-]{4,64}$/.test(data.barcode)) errors.push('Invalid barcode'); }
  if (has('hsn_code')) { data.hsn_code = v.text(b.hsn_code, 10) || null; if (data.hsn_code && !v.isHsn(data.hsn_code)) errors.push('Invalid HSN (4, 6 or 8 digits)'); }
  if (need('gst_rate')) {
    const g = v.decimal(b.gst_rate, 2, 100);
    if (g == null) errors.push('Invalid GST'); else if (GST_RATES.indexOf(Number(g)) === -1) errors.push('Invalid GST (not a valid GST slab)'); else data.gst_rate = g;
  }
  if (need('mrp')) { const m = v.decimal(b.mrp, 2, 9999999); if (m == null) errors.push('Invalid MRP'); else data.mrp = m; }
  if (need('base_price')) { const m = v.decimal(b.base_price, 2, 9999999); if (m == null) errors.push('Invalid base price'); else data.base_price = m; }
  ['distributor_price', 'retailer_price'].forEach(function (k) {
    if (b[k] === undefined) return;
    if (b[k] === '' || b[k] === null) { data[k] = null; return; }
    const m = v.decimal(b[k], 2, 9999999); if (m == null) errors.push('Invalid ' + k.replace('_', ' ')); else data[k] = m;
  });
  ['distributor_margin', 'retailer_margin'].forEach(function (k) {
    if (b[k] === undefined) return;
    if (b[k] === '' || b[k] === null) { data[k] = null; return; }
    const m = v.decimal(b[k], 3, 500); if (m == null) errors.push('Invalid margin'); else data[k] = m;
  });
  ['moq', 'case_qty'].forEach(function (k) {
    if (b[k] === undefined || b[k] === '') { if (!partial) data[k] = 1; return; }
    const n = v.posInt(b[k]); if (!n || n > 1000000) errors.push('Invalid ' + (k === 'moq' ? 'MOQ' : 'case quantity')); else data[k] = n;
  });
  if (has('low_stock_threshold')) { const n = v.intOrNull(b.low_stock_threshold); if (n == null || n < 0) errors.push('Invalid low-stock threshold'); else data.low_stock_threshold = n; }
  if (has('pack_size')) data.pack_size = v.text(b.pack_size, 60) || null;
  if (has('b2c_ref')) data.b2c_ref = v.text(b.b2c_ref, 64) || null;
  ['enforce_case_multiple', 'avail_b2c', 'avail_retailer', 'avail_distributor', 'is_active'].forEach(function (k) {
    if (b[k] === undefined || b[k] === '') return;
    const val = v.bool(b[k], null);
    if (val == null) errors.push('Invalid ' + k.replace(/_/g, ' ') + ' (use Yes/No)'); else data[k] = val ? 1 : 0;
  });
  if (b.effective_from !== undefined) {
    if (b.effective_from === '' || b.effective_from === null) data.effective_from = null;
    else { const d = v.date(b.effective_from); if (!d) errors.push('Invalid effective date'); else data.effective_from = d; }
  }
  if (data.mrp != null && data.base_price != null && Number(data.mrp) > 0 && Number(data.base_price) > Number(data.mrp)) errors.push('Base price is higher than MRP');
  return { data: data, errors: errors };
}

async function checkCategories(data) {
  for (const k of ['category_id', 'subcategory_id']) {
    if (data[k] == null) continue;
    const c = await db.queryOne('SELECT id, parent_id FROM b2b_categories WHERE id = ?', [data[k]]);
    if (!c) throw bad('Unknown ' + (k === 'category_id' ? 'category' : 'sub-category'));
    if (k === 'subcategory_id' && data.category_id != null && Number(c.parent_id) !== Number(data.category_id)) throw bad('That sub-category does not belong to the selected category');
  }
}

async function createProduct(b, actor) {
  const r = readProduct(b, false);
  if (r.errors.length) throw bad(r.errors[0], { errors: r.errors });
  r.data.category_id = v.posInt(b.category_id); r.data.subcategory_id = v.posInt(b.subcategory_id);
  await checkCategories(r.data);
  const cols = Object.keys(r.data);
  try {
    const res = await db.query('INSERT INTO b2b_products (' + cols.join(', ') + ') VALUES (' + db.placeholders(cols) + ')', cols.map(function (c) { return r.data[c]; }));
    await audit.log(null, actor, 'product.created', 'product', res.insertId, null, r.data);
    return { id: res.insertId };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('A product with SKU "' + r.data.sku + '" already exists');
    throw e;
  }
}

async function updateProduct(id, b, actor) {
  const before = await db.queryOne('SELECT * FROM b2b_products WHERE id = ?', [id]);
  if (!before) throw notFound('Product not found');
  const r = readProduct(b, true);
  if (r.errors.length) throw bad(r.errors[0], { errors: r.errors });
  if (b.category_id !== undefined) r.data.category_id = v.posInt(b.category_id);
  if (b.subcategory_id !== undefined) r.data.subcategory_id = v.posInt(b.subcategory_id);
  await checkCategories(Object.assign({ category_id: before.category_id }, r.data));
  const oldV = {}, newV = {}, sets = [], params = [];
  Object.keys(r.data).forEach(function (k) {
    if (PRODUCT_FIELDS.indexOf(k) === -1) return;
    let prev = before[k];
    if (prev instanceof Date) prev = prev.toISOString().slice(0, 10);
    const a = prev == null ? null : String(prev), n = r.data[k] == null ? null : String(r.data[k]);
    const same = a === n || (a != null && n != null && PRICE_FIELDS.indexOf(k) !== -1 && Number(a) === Number(n));
    if (same) return;
    sets.push(k + ' = ?'); params.push(r.data[k]); oldV[k] = prev; newV[k] = r.data[k];
  });
  if (!sets.length) return { changed: false };
  params.push(id);
  try { await db.query('UPDATE b2b_products SET ' + sets.join(', ') + ' WHERE id = ?', params); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('Another product already uses that SKU'); throw e; }
  const priceChanged = Object.keys(newV).some(function (k) { return PRICE_FIELDS.indexOf(k) !== -1; });
  await audit.log(null, actor, priceChanged ? 'product.price_changed' : 'product.updated', 'product', id, oldV, newV);
  return { changed: true };
}

async function adminList(f, pg) {
  const where = [], params = [];
  if (f.q) {
    const t = v.text(f.q, 80);
    where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.barcode = ? OR p.brand LIKE ?)'); params.push(like(t, 'prefix'), like(t), t, like(t, 'prefix'));
  }
  if (f.category_id) { where.push('(p.category_id = ? OR p.subcategory_id = ?)'); params.push(Number(f.category_id), Number(f.category_id)); }
  if (f.active === '1') where.push('p.is_active = 1'); else if (f.active === '0') where.push('p.is_active = 0');
  if (f.channel === 'retailer') where.push('p.avail_retailer = 1'); else if (f.channel === 'distributor') where.push('p.avail_distributor = 1'); else if (f.channel === 'b2c') where.push('p.avail_b2c = 1');
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_products p' + sql, params);
  const sort = { sku: 'p.sku', name: 'p.name', mrp: 'p.mrp', base: 'p.base_price', updated: 'p.updated_at' };
  const order = sort[f.sort] ? sort[f.sort] + (f.dir === 'desc' ? ' DESC' : ' ASC') : 'p.sku ASC';
  const rows = await db.query(
    'SELECT p.*, c.name AS category_name, sc.name AS subcategory_name FROM b2b_products p ' +
    'LEFT JOIN b2b_categories c ON c.id = p.category_id LEFT JOIN b2b_categories sc ON sc.id = p.subcategory_id' + sql +
    ' ORDER BY ' + order + ' LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  if (rows.length) {
    const ids = rows.map(function (r) { return Number(r.id); });
    const whs = (await inventory.companyWarehouses()).map(function (w) { return w.id; });
    const stock = await inventory.availability(ids, whs);
    const ctxD = await engine.contextFor('distributor', null, rows), ctxR = await engine.contextFor('retailer', null, rows);
    rows.forEach(function (p) {
      p.company_stock = stock[p.id] || 0;
      const d = engine.resolve(p, p.moq, ctxD), r = engine.resolve(p, p.moq, ctxR);
      p.computed = {
        distributor: { price: money.fromPaise(d.unitPrice), source: d.source, marginPct: d.marginPct, belowCost: d.belowCost },
        retailer: { price: money.fromPaise(r.unitPrice), source: r.source, marginPct: r.marginPct, belowCost: r.belowCost },
      };
    });
  }
  return { rows: rows, total: Number(total.n) };
}

async function getProduct(id) {
  const p = await db.queryOne(
    'SELECT p.*, c.name AS category_name, sc.name AS subcategory_name FROM b2b_products p ' +
    'LEFT JOIN b2b_categories c ON c.id = p.category_id LEFT JOIN b2b_categories sc ON sc.id = p.subcategory_id WHERE p.id = ?', [id]);
  if (!p) throw notFound('Product not found');
  return p;
}

/** Copy the storefront catalogue into the product master by SKU. Creates missing products only; never touches B2C data. */
async function syncFromB2C(actor) {
  const { db: jsonDb } = require('../../../services/db.js');
  const list = jsonDb.products.all();
  let created = 0, linked = 0, skipped = 0;
  for (const p of list) {
    const sku = v.text(p.sku, 64);
    if (!sku || !v.isSku(sku)) { skipped++; continue; }
    const existing = await db.queryOne('SELECT id, b2c_ref FROM b2b_products WHERE sku = ?', [sku]);
    if (existing) {
      if (!existing.b2c_ref) { await db.query('UPDATE b2b_products SET b2c_ref = ?, avail_b2c = 1 WHERE id = ?', [String(p.id), existing.id]); linked++; }
      else skipped++;
      continue;
    }
    // B2C price is deliberately NOT copied into any B2B price field. MRP is public information.
    await db.query(
      'INSERT INTO b2b_products (sku, name, description, image_url, mrp, base_price, avail_b2c, avail_retailer, avail_distributor, b2c_ref, is_active) ' +
      'VALUES (?, ?, ?, ?, ?, 0.00, 1, 0, 0, ?, ?)',
      [sku, v.text(p.name, 200), String(p.description || '').slice(0, 5000) || null, v.text(p.image, 500) || null,
        v.decimal(p.mrp || p.price || 0, 2) || '0.00', String(p.id), p.active === false || p.upcoming ? 0 : 1]);
    created++;
  }
  await audit.log(null, actor, 'catalogue.synced_from_b2c', 'product', null, null, { created: created, linked: linked, skipped: skipped });
  return { created: created, linked: linked, skipped: skipped,
    note: created ? 'New products were added with trade sales switched OFF. Set a base price, GST and HSN, then enable Retailer / Distributor availability.' : '' };
}

/* ─────────── Quantity rules ─────────── */

/** MOQ + case-quantity validation. Returns an error string or null. Always enforced server-side. */
function qtyProblem(product, qty) {
  qty = Number(qty);
  if (!Number.isInteger(qty) || qty <= 0) return 'Quantity must be a whole number';
  if (qty > 1000000) return 'Quantity is too large';
  const moq = Number(product.moq) || 1, caseQty = Number(product.case_qty) || 1;
  if (qty < moq) return 'Minimum order quantity is ' + moq;
  if (caseQty > 1 && Number(product.enforce_case_multiple) && qty % caseQty !== 0) return 'Order in multiples of ' + caseQty + ' (case quantity)';
  return null;
}

/** Smallest valid quantity for a product (used for "add to cart" defaults and re-orders). */
function minValidQty(product) {
  const moq = Number(product.moq) || 1, caseQty = Number(product.case_qty) || 1;
  if (caseQty > 1 && Number(product.enforce_case_multiple)) return Math.ceil(moq / caseQty) * caseQty;
  return moq;
}

/* ─────────── Catalogue as a buyer sees it ─────────── */

const VISIBLE = function (aud) {
  return 'p.is_active = 1 AND p.avail_' + aud + ' = 1 AND (p.effective_from IS NULL OR p.effective_from <= UTC_DATE())';
};

/** Where does this buyer's stock come from, and should it be shown? */
async function stockSourceFor(account, sellerAccountId) {
  if (account.account_type === 'distributor' || !sellerAccountId) {
    return { tracked: true, warehouseIds: (await inventory.companyWarehouses()).map(function (w) { return w.id; }) };
  }
  if (!(await settings.get('inventory.track_distributor_stock'))) return { tracked: false, warehouseIds: [] };
  return { tracked: true, warehouseIds: (await inventory.distributorWarehouses(sellerAccountId)).map(function (w) { return w.id; }) };
}

function stockLabel(qty, product) {
  if (qty <= 0) return 'out';
  const low = Number(product.low_stock_threshold) || 0;
  return qty < Math.max(low, minValidQty(product) * 2) ? 'low' : 'in';
}

/** Shape one product row for the portal, with its server-calculated price. Never exposes cost or margins. */
function portalProduct(p, ctx, stock, source) {
  const minQty = minValidQty(p);
  const price = engine.resolve(p, minQty, ctx);
  const qty = source.tracked ? (stock[p.id] || 0) : null;
  return {
    id: Number(p.id), sku: p.sku, name: p.name, brand: p.brand, description: p.description, image_url: p.image_url,
    category_id: p.category_id, category_name: p.category_name, subcategory_name: p.subcategory_name,
    pack_size: p.pack_size, barcode: p.barcode, hsn_code: p.hsn_code,
    gst_rate: p.gst_rate, mrp: p.mrp,
    moq: Number(p.moq), case_qty: Number(p.case_qty), enforce_case_multiple: !!Number(p.enforce_case_multiple), min_qty: minQty,
    unit_price: money.fromPaise(price.unitPrice),
    list_price: price.listPrice !== price.unitPrice ? money.fromPaise(price.listPrice) : null,
    promo: price.promo,
    slabs: engine.slabs(p, ctx),
    stock: qty == null ? 'in' : stockLabel(qty, p),
    is_favorite: !!p.is_favorite,
    in_cart: p.cart_qty == null ? 0 : Number(p.cart_qty),
  };
}

async function portalList(account, sellerAccountId, f, pg) {
  const aud = account.account_type;
  const where = [VISIBLE(aud)], params = [account.id, account.id];
  if (f.q) {
    const t = v.text(f.q, 80);
    where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.barcode = ? OR p.brand LIKE ?)'); params.push(like(t, 'prefix'), like(t), t, like(t, 'prefix'));
  }
  if (f.category_id) { where.push('(p.category_id = ? OR p.subcategory_id = ?)'); params.push(Number(f.category_id), Number(f.category_id)); }
  let join = '';
  if (f.favorites) where.push('fav.product_id IS NOT NULL');
  if (f.frequent) {
    // "Frequently ordered" / "Buy again": products from this buyer's own past orders, most ordered first.
    join = ' JOIN (SELECT i.product_id, SUM(i.qty) AS bought, COUNT(DISTINCT i.order_id) AS times FROM b2b_order_items i ' +
      "JOIN b2b_orders o ON o.id = i.order_id WHERE o.buyer_account_id = ? AND o.status NOT IN ('cancelled','rejected') GROUP BY i.product_id) freq ON freq.product_id = p.id";
    params.unshift(account.id);
  }
  const base = ' FROM b2b_products p' + join +
    ' LEFT JOIN b2b_favorites fav ON fav.product_id = p.id AND fav.account_id = ?' +
    ' LEFT JOIN b2b_cart_items ci ON ci.product_id = p.id AND ci.account_id = ?' +
    ' LEFT JOIN b2b_categories c ON c.id = p.category_id LEFT JOIN b2b_categories sc ON sc.id = p.subcategory_id' +
    ' WHERE ' + where.join(' AND ');
  const total = await db.queryOne('SELECT COUNT(*) AS n' + base, params);
  const order = f.frequent ? 'freq.times DESC, freq.bought DESC, p.name' : (f.sort === 'sku' ? 'p.sku' : 'p.name');
  const rows = await db.query(
    'SELECT p.*, c.name AS category_name, sc.name AS subcategory_name, (fav.product_id IS NOT NULL) AS is_favorite, ci.qty AS cart_qty' + base +
    ' ORDER BY ' + order + ' LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  if (!rows.length) return { rows: [], total: Number(total.n) };
  const ctx = await engine.contextFor(aud, account.id, rows);
  const source = await stockSourceFor(account, sellerAccountId);
  const stock = source.tracked ? await inventory.availability(rows.map(function (r) { return Number(r.id); }), source.warehouseIds) : {};
  return { rows: rows.map(function (p) { return portalProduct(p, ctx, stock, source); }), total: Number(total.n) };
}

/** Find products by exact SKU or barcode for the quick-order grid. */
async function portalLookup(account, codes) {
  const list = Array.from(new Set((codes || []).map(function (c) { return v.text(c, 64); }).filter(Boolean))).slice(0, 200);
  if (!list.length) return [];
  const ph = db.placeholders(list);
  return db.query('SELECT p.* FROM b2b_products p WHERE ' + VISIBLE(account.account_type) + ' AND (p.sku IN (' + ph + ') OR p.barcode IN (' + ph + '))', list.concat(list));
}

async function setFavorite(accountId, productId, on) {
  const p = await db.queryOne('SELECT id FROM b2b_products WHERE id = ?', [productId]);
  if (!p) throw notFound('Product not found');
  if (on) await db.query('INSERT IGNORE INTO b2b_favorites (account_id, product_id) VALUES (?, ?)', [accountId, productId]);
  else await db.query('DELETE FROM b2b_favorites WHERE account_id = ? AND product_id = ?', [accountId, productId]);
  return { favorite: !!on };
}

module.exports = {
  listCategories, saveCategory, ensureCategory,
  readProduct, createProduct, updateProduct, adminList, getProduct, syncFromB2C, PRODUCT_FIELDS, GST_RATES,
  qtyProblem, minValidQty, VISIBLE, stockSourceFor, portalProduct, portalList, portalLookup, setFavorite,
};
