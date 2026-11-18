/**
 * Pricing administration: rules (CRUD), bulk margin updates with preview,
 * and a price simulator. Every change is written to the audit log.
 */
const db = require('../../../db/connection.js');
const engine = require('./engine.js');
const money = require('../lib/money.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const { bad, notFound, like } = require('../lib/http.js');

const SCOPES = ['account_product', 'account', 'product', 'category', 'default'];
const TYPES = ['margin_pct', 'fixed_price', 'discount_pct'];

async function readRule(b) {
  const scope = String(b.scope || '');
  const audience = String(b.audience || '');
  const type = String(b.rule_type || '');
  if (SCOPES.indexOf(scope) === -1) throw bad('Choose what the rule applies to');
  if (audience !== 'retailer' && audience !== 'distributor') throw bad('Choose Retailer or Distributor pricing');
  if (TYPES.indexOf(type) === -1) throw bad('Choose a rule type');
  const value = v.decimal(b.value, 3, type === 'fixed_price' ? 9999999 : 500);
  if (value == null) throw bad(type === 'fixed_price' ? 'Enter a valid price' : 'Enter a valid percentage');
  if (type === 'discount_pct' && Number(value) > 100) throw bad('A discount cannot exceed 100%');
  const rule = {
    scope: scope, audience: audience, rule_type: type, value: value,
    account_id: null, product_id: null, category_id: null,
    min_qty: Math.max(1, v.posInt(b.min_qty) || 1),
    is_promo: v.bool(b.is_promo, false) ? 1 : 0,
    label: v.text(b.label, 120) || null,
    starts_at: b.starts_at ? new Date(b.starts_at) : null,
    ends_at: b.ends_at ? new Date(b.ends_at) : null,
    is_active: v.bool(b.is_active, true) ? 1 : 0,
  };
  if ((rule.starts_at && Number.isNaN(rule.starts_at.getTime())) || (rule.ends_at && Number.isNaN(rule.ends_at.getTime()))) throw bad('Invalid date');
  if (rule.starts_at && rule.ends_at && rule.ends_at <= rule.starts_at) throw bad('The end date must be after the start date');
  if (rule.is_promo && !rule.ends_at) throw bad('A promotion needs an end date');
  if (scope === 'account_product' || scope === 'account') {
    const acc = await db.queryOne('SELECT id, account_type FROM b2b_accounts WHERE id = ?', [v.posInt(b.account_id) || 0]);
    if (!acc) throw bad('Choose the retailer or distributor this price is for');
    if (acc.account_type !== audience) throw bad('That account is a ' + acc.account_type + ', not a ' + audience);
    rule.account_id = acc.id;
  }
  if (scope === 'account_product' || scope === 'product') {
    const p = await db.queryOne('SELECT id FROM b2b_products WHERE id = ?', [v.posInt(b.product_id) || 0]);
    if (!p) throw bad('Choose a product');
    rule.product_id = p.id;
  }
  if (scope === 'category') {
    const c = await db.queryOne('SELECT id FROM b2b_categories WHERE id = ?', [v.posInt(b.category_id) || 0]);
    if (!c) throw bad('Choose a category');
    rule.category_id = c.id;
  }
  return rule;
}

async function listRules(f, pg) {
  const where = [], params = [];
  if (f.scope && SCOPES.indexOf(f.scope) !== -1) { where.push('r.scope = ?'); params.push(f.scope); }
  if (f.audience) { where.push('r.audience = ?'); params.push(f.audience); }
  if (f.account_id) { where.push('r.account_id = ?'); params.push(Number(f.account_id)); }
  if (f.product_id) { where.push('r.product_id = ?'); params.push(Number(f.product_id)); }
  if (f.category_id) { where.push('r.category_id = ?'); params.push(Number(f.category_id)); }
  if (f.promo === '1') where.push('r.is_promo = 1');
  if (f.active === '1') where.push('r.is_active = 1 AND (r.ends_at IS NULL OR r.ends_at >= UTC_TIMESTAMP())');
  if (f.q) {
    where.push('(p.sku LIKE ? OR p.name LIKE ? OR a.business_name LIKE ? OR r.label LIKE ?)');
    const t = v.text(f.q, 80); params.push(like(t, 'prefix'), like(t), like(t), like(t));
  }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const from = ' FROM b2b_pricing_rules r LEFT JOIN b2b_products p ON p.id = r.product_id ' +
    'LEFT JOIN b2b_accounts a ON a.id = r.account_id LEFT JOIN b2b_categories c ON c.id = r.category_id';
  const total = await db.queryOne('SELECT COUNT(*) AS n' + from + sql, params);
  const rows = await db.query(
    'SELECT r.*, p.sku, p.name AS product_name, a.business_name AS account_name, c.name AS category_name' + from + sql +
    ' ORDER BY r.is_active DESC, r.id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows, total: Number(total.n) };
}

async function createRule(body, actor) {
  const rule = await readRule(body);
  const res = await db.query(
    'INSERT INTO b2b_pricing_rules (scope, audience, account_id, product_id, category_id, rule_type, value, min_qty, is_promo, label, starts_at, ends_at, is_active, created_by) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [rule.scope, rule.audience, rule.account_id, rule.product_id, rule.category_id, rule.rule_type, rule.value, rule.min_qty,
      rule.is_promo, rule.label, rule.starts_at, rule.ends_at, rule.is_active, actor.label]);
  await audit.log(null, actor, 'pricing.rule_created', 'pricing_rule', res.insertId, null, rule);
  return { id: res.insertId };
}

async function updateRule(id, body, actor) {
  const before = await db.queryOne('SELECT * FROM b2b_pricing_rules WHERE id = ?', [id]);
  if (!before) throw notFound('Pricing rule not found');
  const rule = await readRule(Object.assign({}, before, body));
  await db.query(
    'UPDATE b2b_pricing_rules SET scope = ?, audience = ?, account_id = ?, product_id = ?, category_id = ?, rule_type = ?, value = ?, min_qty = ?, ' +
    'is_promo = ?, label = ?, starts_at = ?, ends_at = ?, is_active = ? WHERE id = ?',
    [rule.scope, rule.audience, rule.account_id, rule.product_id, rule.category_id, rule.rule_type, rule.value, rule.min_qty,
      rule.is_promo, rule.label, rule.starts_at, rule.ends_at, rule.is_active, id]);
  await audit.log(null, actor, 'pricing.rule_updated', 'pricing_rule', id, before, rule);
  return { ok: true };
}

/** Rules are retired, not deleted — past orders keep a valid reference. */
async function deactivateRule(id, actor) {
  const before = await db.queryOne('SELECT * FROM b2b_pricing_rules WHERE id = ?', [id]);
  if (!before) throw notFound('Pricing rule not found');
  await db.query('UPDATE b2b_pricing_rules SET is_active = 0 WHERE id = ?', [id]);
  await audit.log(null, actor, 'pricing.rule_deactivated', 'pricing_rule', id, { is_active: before.is_active }, { is_active: 0 });
  return { ok: true };
}

/* ─────────── Bulk margin update (select → preview → confirm → apply) ─────────── */

function selectionSql(sel) {
  sel = sel || {};
  const where = [], params = [];
  if (Array.isArray(sel.ids) && sel.ids.length) {
    const ids = Array.from(new Set(sel.ids.map(Number).filter(function (n) { return Number.isInteger(n) && n > 0; })));
    if (!ids.length) throw bad('No products selected');
    if (ids.length > 20000) throw bad('Too many products selected');
    where.push('p.id IN (' + db.placeholders(ids) + ')'); params.push.apply(params, ids);
  } else if (Array.isArray(sel.skus) && sel.skus.length) {
    const skus = Array.from(new Set(sel.skus.map(function (x) { return v.text(x, 64); }).filter(Boolean)));
    if (skus.length > 20000) throw bad('Too many SKUs');
    where.push('p.sku IN (' + db.placeholders(skus) + ')'); params.push.apply(params, skus);
  } else {
    if (sel.category_id) { where.push('(p.category_id = ? OR p.subcategory_id = ?)'); params.push(Number(sel.category_id), Number(sel.category_id)); }
    if (sel.brand) { where.push('p.brand = ?'); params.push(v.text(sel.brand, 100)); }
    if (sel.q) { const t = v.text(sel.q, 80); where.push('(p.sku LIKE ? OR p.name LIKE ?)'); params.push(like(t, 'prefix'), like(t)); }
    if (sel.active_only !== false) where.push('p.is_active = 1');
    if (!sel.all && !where.filter(function (w) { return w !== 'p.is_active = 1'; }).length) throw bad('Select products, or choose a filter, or confirm "all products"');
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params: params };
}

function readMargins(b) {
  const out = {};
  ['distributor_margin', 'retailer_margin'].forEach(function (k) {
    if (b[k] === undefined || b[k] === '' || b[k] === null) return;
    const m = v.decimal(b[k], 3, 500);
    if (m == null) throw bad('Enter a valid ' + k.replace('_', ' ') + ' percentage');
    out[k] = m;
  });
  if (b.clear_fixed_prices) out.clear_fixed_prices = true;
  if (!Object.keys(out).length) throw bad('Enter at least one margin to apply');
  return out;
}

async function bulkPreview(selection, body) {
  const margins = readMargins(body);
  const s = selectionSql(selection);
  const count = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_products p' + s.sql, s.params);
  const sample = await db.query(
    'SELECT p.id, p.sku, p.name, p.category_id, p.subcategory_id, p.gst_rate, p.mrp, p.base_price, p.distributor_price, p.retailer_price, ' +
    'p.distributor_margin, p.retailer_margin FROM b2b_products p' + s.sql + ' ORDER BY p.sku LIMIT 50', s.params);
  const out = [];
  if (sample.length) {
    const ctxD = await engine.contextFor('distributor', null, sample);
    const ctxR = await engine.contextFor('retailer', null, sample);
    sample.forEach(function (p) {
      const after = Object.assign({}, p);
      if (margins.distributor_margin != null) after.distributor_margin = margins.distributor_margin;
      if (margins.retailer_margin != null) after.retailer_margin = margins.retailer_margin;
      if (margins.clear_fixed_prices) { after.distributor_price = null; after.retailer_price = null; }
      const row = { id: p.id, sku: p.sku, name: p.name, base_price: p.base_price, mrp: p.mrp,
        fixedPriceBlocks: !margins.clear_fixed_prices && (p.distributor_price != null || p.retailer_price != null) };
      [['distributor', ctxD], ['retailer', ctxR]].forEach(function (pair) {
        const a = pair[0];
        row[a] = {
          oldMargin: p[a + '_margin'], newMargin: after[a + '_margin'],
          oldPrice: money.fromPaise(engine.resolve(p, 1, pair[1]).unitPrice),
          newPrice: money.fromPaise(engine.resolve(after, 1, pair[1]).unitPrice),
        };
      });
      out.push(row);
    });
  }
  let missingSkus = [];
  if (selection && Array.isArray(selection.skus) && selection.skus.length) {
    const found = await db.query('SELECT p.sku FROM b2b_products p' + s.sql, s.params);
    const have = {}; found.forEach(function (r) { have[String(r.sku).toLowerCase()] = true; });
    missingSkus = selection.skus.map(function (x) { return v.text(x, 64); }).filter(function (x) { return x && !have[x.toLowerCase()]; }).slice(0, 200);
  }
  return { count: Number(count.n), margins: margins, sample: out, missingSkus: missingSkus };
}

async function bulkApply(selection, body, actor) {
  const margins = readMargins(body);
  const s = selectionSql(selection);
  return db.transaction(async function (tx) {
    const rows = await tx.query(
      'SELECT p.id, p.sku, p.distributor_margin, p.retailer_margin, p.distributor_price, p.retailer_price FROM b2b_products p' + s.sql + ' FOR UPDATE', s.params);
    if (!rows.length) throw bad('No products match the selection');
    const sets = [], params = [];
    if (margins.distributor_margin != null) { sets.push('distributor_margin = ?'); params.push(margins.distributor_margin); }
    if (margins.retailer_margin != null) { sets.push('retailer_margin = ?'); params.push(margins.retailer_margin); }
    if (margins.clear_fixed_prices) sets.push('distributor_price = NULL', 'retailer_price = NULL');
    const ids = rows.map(function (r) { return Number(r.id); });
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      await tx.query('UPDATE b2b_products SET ' + sets.join(', ') + ' WHERE id IN (' + db.placeholders(chunk) + ')', params.concat(chunk));
    }
    // One audit entry with the previous value of every product, so the change can be reviewed or reversed.
    const previous = {};
    rows.forEach(function (r) { previous[r.sku] = [r.distributor_margin, r.retailer_margin, r.distributor_price, r.retailer_price]; });
    await audit.log(tx, actor, 'pricing.bulk_margin_update', 'product', null,
      { count: rows.length, columns: ['distributor_margin', 'retailer_margin', 'distributor_price', 'retailer_price'], previous: previous },
      { count: rows.length, applied: margins });
    return { updated: rows.length };
  });
}

/** What would this buyer pay for this product at this quantity — and why. */
async function simulate(productId, accountId, audience, qty) {
  const product = await db.queryOne('SELECT * FROM b2b_products WHERE id = ?', [productId]);
  if (!product) throw notFound('Product not found');
  let aud = audience;
  if (accountId) {
    const acc = await db.queryOne('SELECT account_type FROM b2b_accounts WHERE id = ?', [accountId]);
    if (!acc) throw notFound('Account not found');
    aud = acc.account_type;
  }
  if (aud !== 'retailer' && aud !== 'distributor') throw bad('Choose Retailer or Distributor');
  const ctx = await engine.contextFor(aud, accountId || null, [product]);
  const r = engine.resolve(product, qty || 1, ctx);
  return {
    sku: product.sku, name: product.name, audience: aud, qty: qty || 1, mode: ctx.mode,
    basePrice: product.base_price, mrp: product.mrp, gstRate: product.gst_rate,
    unitPrice: money.fromPaise(r.unitPrice), listPrice: money.fromPaise(r.listPrice),
    source: r.source, marginPct: r.marginPct, belowCost: r.belowCost, promo: r.promo, trace: r.trace,
    slabs: engine.slabs(product, ctx),
  };
}

module.exports = { listRules, createRule, updateRule, deactivateRule, bulkPreview, bulkApply, simulate, SCOPES, TYPES };
