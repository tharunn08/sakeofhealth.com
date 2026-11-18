/**
 * Coupon engine — percentage / flat / free-shipping discounts with
 * validity windows, usage caps and minimum-cart rules.
 */
const { db } = require('./db.js');

function normalise(code) {
  return String(code || '').trim().toUpperCase();
}

/**
 * Validate a coupon against a cart subtotal.
 * @returns {{valid:boolean, error?:string, discount?:number, coupon?:object}}
 */
function validateCoupon(code, subtotal, cartItems) {
  const c = db.coupons.findOne({ code: normalise(code) });
  if (!c) return { valid: false, error: 'Coupon code not found' };
  if (c.active === false) return { valid: false, error: 'This coupon is no longer active' };

  const now = Date.now();
  if (c.startsAt && now < new Date(c.startsAt).getTime()) {
    return { valid: false, error: 'This coupon is not active yet' };
  }
  if (c.expiresAt && now > new Date(c.expiresAt).getTime()) {
    return { valid: false, error: 'This coupon has expired' };
  }
  if (c.usageLimit && (c.usedCount || 0) >= c.usageLimit) {
    return { valid: false, error: 'This coupon has reached its usage limit' };
  }
  if (c.minOrderValue && subtotal < c.minOrderValue) {
    return { valid: false, error: 'Minimum order of ₹' + c.minOrderValue + ' required for this coupon' };
  }

  // Product restriction
  if (Array.isArray(c.appliesTo) && c.appliesTo.length && Array.isArray(cartItems)) {
    const hasMatch = cartItems.some(i => c.appliesTo.indexOf(i.id) !== -1);
    if (!hasMatch) return { valid: false, error: 'This coupon does not apply to items in your cart' };
  }

  let discount = 0;
  if (c.type === 'percent') {
    discount = Math.round(subtotal * (Number(c.value) / 100));
    if (c.maxDiscount) discount = Math.min(discount, Number(c.maxDiscount));
  } else if (c.type === 'flat') {
    discount = Math.min(Number(c.value), subtotal);
  } else if (c.type === 'free_shipping') {
    discount = 0;
  }

  return {
    valid: true,
    discount: discount,
    freeShipping: c.type === 'free_shipping' || !!c.freeShipping,
    coupon: {
      code: c.code,
      type: c.type,
      value: c.value,
      description: c.description || '',
    },
  };
}

/** Coupons safe to advertise publicly on the storefront. */
function publicCoupons() {
  const now = Date.now();
  return db.coupons.all()
    .filter(c => c.active !== false && c.showOnSite === true &&
      (!c.expiresAt || now < new Date(c.expiresAt).getTime()) &&
      (!c.startsAt || now >= new Date(c.startsAt).getTime()) &&
      (!c.usageLimit || (c.usedCount || 0) < c.usageLimit))
    .map(c => ({
      code: c.code,
      type: c.type,
      value: c.value,
      description: c.description || '',
      minOrderValue: c.minOrderValue || 0,
      maxDiscount: c.maxDiscount || null,
      expiresAt: c.expiresAt || null,
    }));
}

module.exports = { validateCoupon, publicCoupons, normalise };
