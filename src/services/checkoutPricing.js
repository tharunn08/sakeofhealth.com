/**
 * Server-side cart pricing for the storefront (Phase 0.5.3; BUG-004, BUG-006, BUG-028).
 *
 * The browser's prices and totals are never used. Every line is looked up in
 * the Admin catalogue; unknown, inactive or coming-soon products, impossible
 * quantities and quantities above recorded stock are refused. The total uses
 * the same formula as orders.createOrder (subtotal - discount + shipping), so
 * the quote, the gateway amount and the stored order total are always equal.
 */
const { db } = require('./db.js');
const { validateCoupon } = require('./coupons.js');

const MAX_LINES = 50;

/** Most units of one product in one order. B2C_MAX_LINE_QTY overrides (default 20). */
function maxLineQty() {
  const n = parseInt(process.env.B2C_MAX_LINE_QTY, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function money(n) { return Math.round(Number(n) * 100) / 100; }

function findProduct(id) {
  if (id == null || id === '') return null;
  return db.products.findById(String(id)) || db.products.findOne({ slug: String(id) });
}

/**
 * @param {{items: Array<{id:string, qty:number, price?:number}>, couponCode?: string}} input
 * @returns {{ok:true, lines, subtotal, discount, couponCode, coupon, freeShipping, shipping, total, currency}
 *          | {ok:false, error:string, line?:number}}
 */
function priceCart(input) {
  const items = input && input.items;
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Your cart is empty' };
  if (items.length > MAX_LINES) return { ok: false, error: 'Too many items in one order' };

  const max = maxLineQty();
  const byProduct = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const p = findProduct(it.id);
    if (!p || p.active === false) return { ok: false, line: i, error: 'An item in your cart is no longer available. Please remove it and try again.' };
    if (p.upcoming) return { ok: false, line: i, error: '"' + p.name + '" is coming soon and cannot be ordered yet.' };
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, line: i, error: 'Invalid quantity for "' + p.name + '"' };
    if (!(Number(p.price) > 0)) return { ok: false, line: i, error: '"' + p.name + '" cannot be ordered online right now.' };
    const prev = byProduct.get(p.id);
    if (prev) { prev.qty += qty; if (it.price != null && Number(it.price) !== Number(p.price)) prev.priceChanged = true; continue; }
    byProduct.set(p.id, {
      id: p.id, name: p.name, price: Number(p.price), qty, image: p.image || '',
      priceChanged: it.price != null && Number(it.price) !== Number(p.price),
      _stock: p.stock,
    });
  }

  const lines = [];
  for (const l of byProduct.values()) {
    if (l.qty > max) return { ok: false, error: 'You can order at most ' + max + ' of "' + l.name + '" at a time.' };
    if (l._stock != null && Number.isFinite(Number(l._stock)) && l.qty > Number(l._stock)) {
      return { ok: false, error: Number(l._stock) > 0
        ? 'Only ' + Number(l._stock) + ' of "' + l.name + '" left in stock.'
        : '"' + l.name + '" is out of stock.' };
    }
    delete l._stock;
    lines.push(l);
  }

  const subtotal = money(lines.reduce((s, l) => s + l.price * l.qty, 0));

  let discount = 0, couponCode = null, freeShipping = false, coupon = null;
  if (input.couponCode) {
    const cv = validateCoupon(input.couponCode, subtotal, lines);
    if (cv.valid) {
      discount = money(Math.min(Number(cv.discount) || 0, subtotal));
      couponCode = cv.coupon.code; freeShipping = !!cv.freeShipping;
      coupon = { valid: true, code: couponCode };
    } else {
      coupon = { valid: false, error: cv.error || 'Coupon not applied' };
    }
  }

  const threshold = Number(process.env.FREE_SHIPPING_ABOVE || 499);
  const fee = Number(process.env.SHIPPING_FEE || 49);
  const shipping = (freeShipping || subtotal - discount >= threshold) ? 0 : fee;
  const total = money(Math.max(0, subtotal - discount + shipping));

  return { ok: true, lines, subtotal, discount, couponCode, coupon, freeShipping, shipping, total, currency: 'INR' };
}

/** Customer / address checks shared by quote-to-order paths (unchanged rules from shop.js). */
function validateContact(b) {
  if (!b || !b.customer || !b.customer.name) return 'Name is required';
  if (!b.customer.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.customer.email)) return 'A valid email is required';
  const phone = String(b.customer.phone || '').replace(/\D/g, '');
  if (phone.length < 10) return 'A valid 10-digit phone number is required';
  if (!b.address || !b.address.line1) return 'Delivery address is required';
  if (!b.address.city) return 'City is required';
  if (!/^\d{6}$/.test(String(b.address.pincode || ''))) return 'A valid 6-digit pincode is required';
  return null;
}

/** Strip the fields a priced line carries for the page only. */
function orderLines(lines) {
  return lines.map(l => ({ id: l.id, name: l.name, price: l.price, qty: l.qty, image: l.image }));
}

module.exports = { priceCart, validateContact, orderLines, maxLineQty };
