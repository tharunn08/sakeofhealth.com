/**
 * B2B pricing engine — the ONLY place a trade price is calculated.
 * Prices sent by a browser are never used; orders are always priced here.
 *
 * PRECEDENCE (first level that has a matching price/margin wins):
 *
 *   1. account_product   Customer-specific price for this product
 *   2. account           Retailer/Distributor-specific override (all products)
 *   3. product           Product pricing (product rule, else the product's own price / margin)
 *   4. category          Category pricing (sub-category beats category)
 *   5. default           Default B2B margin (default rule, else the margin in Settings)
 *
 * Within a level, quantity slabs apply: the rule with the highest min_qty
 * that the ordered quantity reaches is used.
 *
 * THEN, on top of that base price:
 *   • Volume discount — the best-matching non-promo `discount_pct` rule
 *     (most specific level first, then highest slab).
 *   • Promotional price — any active promo rule; applied only when it makes
 *     the price lower.
 *
 * Rules carry optional start / end dates (effective dating).
 *
 * MARGIN MODE (Settings → pricing.margin_mode):
 *   markup_on_base   price = base price × (1 + margin%)        ← default
 *   off_mrp          price = (MRP ÷ (1 + GST%)) × (1 − margin%)
 *
 * All prices are exclusive of GST. All arithmetic is in integer paise.
 */
const db = require('../../../db/connection.js');
const settings = require('../lib/settings.js');
const money = require('../lib/money.js');

const LEVELS = ['account_product', 'account', 'product', 'category', 'default'];

function priceFromMargin(product, milliPct, mode) {
  const base = money.toPaise(product.base_price);
  if (mode === 'off_mrp') {
    const mrp = money.toPaise(product.mrp);
    const gst = money.toMilliPct(product.gst_rate);
    const mrpExGst = Math.round(mrp * 100000 / (100000 + gst));
    return Math.max(0, mrpExGst - money.pctOf(mrpExGst, milliPct));
  }
  return base + money.pctOf(base, milliPct);
}

function ruleLevel(rule, product, accountId) {
  switch (rule.scope) {
    case 'account_product':
      return Number(rule.account_id) === Number(accountId) && Number(rule.product_id) === Number(product.id) ? 0 : -1;
    case 'account': return Number(rule.account_id) === Number(accountId) ? 1 : -1;
    case 'product': return Number(rule.product_id) === Number(product.id) ? 2 : -1;
    case 'category':
      if (rule.category_id == null) return -1;
      if (product.subcategory_id != null && Number(rule.category_id) === Number(product.subcategory_id)) return 3;
      if (product.category_id != null && Number(rule.category_id) === Number(product.category_id)) return 3;
      return -1;
    case 'default': return 4;
    default: return -1;
  }
}

function inWindow(rule, now) {
  if (rule.starts_at && new Date(rule.starts_at).getTime() > now) return false;
  if (rule.ends_at && new Date(rule.ends_at).getTime() < now) return false;
  return true;
}

/** Prefer: higher slab → sub-category over category → newest rule. */
function better(a, b, product) {
  if (!b) return true;
  if (Number(a.min_qty) !== Number(b.min_qty)) return Number(a.min_qty) > Number(b.min_qty);
  if (a.scope === 'category' && product.subcategory_id != null) {
    const aSub = Number(a.category_id) === Number(product.subcategory_id);
    const bSub = Number(b.category_id) === Number(product.subcategory_id);
    if (aSub !== bSub) return aSub;
  }
  return Number(a.id) > Number(b.id);
}

/**
 * Price one product for one buyer and quantity.
 * ctx = { audience: 'retailer'|'distributor', accountId, mode, defaultMilliPct, rules: [...], now }
 */
function resolve(product, qty, ctx) {
  qty = Math.max(1, Number(qty) || 1);
  const now = ctx.now || Date.now();
  const aud = ctx.audience;
  const trace = [];

  const baseByLevel = [null, null, null, null, null];
  const discountByLevel = [null, null, null, null, null];
  const promos = [];
  for (let i = 0; i < ctx.rules.length; i++) {
    const r = ctx.rules[i];
    if (r.audience !== aud || !r.is_active || Number(r.min_qty) > qty || !inWindow(r, now)) continue;
    if (r.rule_type === 'free_qty') continue;   // free-goods schemes (migration 005) are not a price; never treat them as a margin
    const level = ruleLevel(r, product, ctx.accountId);
    if (level < 0) continue;
    if (r.is_promo) { promos.push(r); continue; }
    if (r.rule_type === 'discount_pct') { if (better(r, discountByLevel[level], product)) discountByLevel[level] = r; }
    else if (better(r, baseByLevel[level], product)) baseByLevel[level] = r;
  }

  let price = null, source = null, ruleId = null;
  for (let level = 0; level < 5 && price == null; level++) {
    const r = baseByLevel[level];
    if (r) {
      price = r.rule_type === 'fixed_price' ? money.toPaise(r.value) : priceFromMargin(product, money.toMilliPct(r.value), ctx.mode);
      source = LEVELS[level]; ruleId = Number(r.id);
      trace.push(LEVELS[level] + ' rule #' + r.id + ' (' + (r.rule_type === 'fixed_price' ? 'fixed ₹' + r.value : Number(r.value) + '% margin') +
        (Number(r.min_qty) > 1 ? ', from ' + r.min_qty + ' units' : '') + ')');
    } else if (level === 2) {
      const fixed = product[aud + '_price'], margin = product[aud + '_margin'];
      if (fixed != null && fixed !== '') {
        price = money.toPaise(fixed); source = 'product';
        trace.push('product ' + aud + ' price ₹' + fixed);
      } else if (margin != null && margin !== '') {
        price = priceFromMargin(product, money.toMilliPct(margin), ctx.mode); source = 'product';
        trace.push('product ' + aud + ' margin ' + Number(margin) + '%');
      }
    } else if (level === 4) {
      price = priceFromMargin(product, ctx.defaultMilliPct, ctx.mode); source = 'default';
      trace.push('default ' + aud + ' margin ' + (ctx.defaultMilliPct / 1000) + '%');
    }
  }
  const listPrice = price;

  let discountMilliPct = 0;
  for (let level = 0; level < 5; level++) {
    const d = discountByLevel[level];
    if (!d) continue;
    discountMilliPct = money.toMilliPct(d.value);
    price = Math.max(0, price - money.pctOf(price, discountMilliPct));
    trace.push('volume discount ' + Number(d.value) + '% (' + LEVELS[level] + ' rule #' + d.id + ', from ' + d.min_qty + ' units)');
    break;
  }

  let promoLabel = null;
  for (let i = 0; i < promos.length; i++) {
    const p = promos[i];
    let candidate;
    if (p.rule_type === 'fixed_price') candidate = money.toPaise(p.value);
    else if (p.rule_type === 'discount_pct') candidate = Math.max(0, price - money.pctOf(price, money.toMilliPct(p.value)));
    else candidate = priceFromMargin(product, money.toMilliPct(p.value), ctx.mode);
    if (candidate < price) {
      price = candidate; promoLabel = p.label || 'Promotion'; ruleId = Number(p.id);
      trace.push('promotion "' + promoLabel + '" (rule #' + p.id + ')');
    }
  }

  const base = money.toPaise(product.base_price);
  return {
    unitPrice: price,                 // paise, ex-GST
    listPrice: listPrice,             // paise, before volume discount / promo
    source: promoLabel ? 'promo' : source,
    ruleId: ruleId,
    promo: promoLabel,
    discountPct: discountMilliPct / 1000,
    marginPct: base > 0 ? Math.round(((price - base) / base) * 10000) / 100 : null,
    belowCost: base > 0 && price < base,
    trace: trace,
  };
}

/** Load everything `resolve` needs for a set of products and one buyer — a single query, no N+1. */
async function contextFor(audience, accountId, products, q) {
  const run = q ? q.query.bind(q) : db.query;
  const all = await settings.all();
  const productIds = products.map(function (p) { return Number(p.id); });
  const catIds = [];
  products.forEach(function (p) {
    if (p.category_id != null && catIds.indexOf(Number(p.category_id)) === -1) catIds.push(Number(p.category_id));
    if (p.subcategory_id != null && catIds.indexOf(Number(p.subcategory_id)) === -1) catIds.push(Number(p.subcategory_id));
  });
  const clauses = ["scope = 'default'"], params = [audience];
  if (accountId) { clauses.push("(scope IN ('account_product','account') AND account_id = ?)"); params.push(accountId); }
  if (productIds.length) { clauses.push("(scope = 'product' AND product_id IN (" + db.placeholders(productIds) + '))'); params.push.apply(params, productIds); }
  if (catIds.length) { clauses.push("(scope = 'category' AND category_id IN (" + db.placeholders(catIds) + '))'); params.push.apply(params, catIds); }
  const rules = await run(
    // SELECT * so the optional buy_qty / free_qty columns (ERP migration 005) are read when present.
    'SELECT * ' +
    'FROM b2b_pricing_rules WHERE is_active = 1 AND audience = ? AND (ends_at IS NULL OR ends_at >= UTC_TIMESTAMP()) AND (' + clauses.join(' OR ') + ')',
    params);
  return {
    audience: audience,
    accountId: accountId || null,
    mode: all['pricing.margin_mode'],
    defaultMilliPct: money.toMilliPct(all['pricing.default_' + audience + '_margin']),
    rules: rules,
    now: Date.now(),
  };
}

/**
 * Free goods ("buy N, get M free") for one product line. Most specific level wins
 * (account+product, account, product, category, default), then the rule giving the most.
 * Free units are a separate zero-price line; under GST the paid price is the value of the
 * whole supply (CBIC circular 92/11/2019), so the free line carries no separate tax.
 */
function freeGoods(product, qty, ctx) {
  qty = Number(qty) || 0;
  const now = ctx.now || Date.now();
  let best = null, bestLevel = 9, bestFree = 0;
  (ctx.rules || []).forEach(function (r) {
    if (r.rule_type !== 'free_qty' || r.audience !== ctx.audience || !r.is_active || !inWindow(r, now)) return;
    const buy = Number(r.buy_qty), get = Number(r.free_qty);
    if (!(buy > 0) || !(get > 0) || qty < Math.max(buy, Number(r.min_qty) || 1)) return;
    const level = ruleLevel(r, product, ctx.accountId);
    if (level < 0) return;
    const free = Math.floor(qty / buy) * get;
    if (level < bestLevel || (level === bestLevel && free > bestFree)) { best = r; bestLevel = level; bestFree = free; }
  });
  return best ? { qty: bestFree, ruleId: Number(best.id), label: best.label || ('Buy ' + best.buy_qty + ' get ' + best.free_qty + ' free') } : null;
}

/** Quantity slabs to show a buyer ("20+ units: ₹…"). */
function slabs(product, ctx) {
  const points = { 1: true };
  ctx.rules.forEach(function (r) {
    if (r.audience === ctx.audience && Number(r.min_qty) > 1 && ruleLevel(r, product, ctx.accountId) >= 0 && inWindow(r, ctx.now)) points[Number(r.min_qty)] = true;
  });
  const qtys = Object.keys(points).map(Number).sort(function (a, b) { return a - b; });
  if (qtys.length < 2) return [];
  const out = [];
  let last = null;
  qtys.forEach(function (qty) {
    const p = resolve(product, qty, ctx).unitPrice;
    if (p !== last) { out.push({ minQty: qty, unitPrice: money.fromPaise(p) }); last = p; }
  });
  return out.length > 1 ? out : [];
}

module.exports = { resolve, contextFor, slabs, priceFromMargin, freeGoods, LEVELS };
