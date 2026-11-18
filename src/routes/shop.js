/**
 * Public storefront API — products, coupon validation, order placement,
 * order tracking, reviews and geocoding proxy.
 */
const { Router } = require('express');
const { db } = require('../services/db.js');
const ordersService = require('../services/orders.js');
const { validateCoupon, publicCoupons } = require('../services/coupons.js');
const payments = require('../services/payments.js');
const checkoutFlow = require('../services/checkoutFlow.js');
const { priceCart, orderLines } = require('../services/checkoutPricing.js');

const router = Router();

/* ══════════════════ PRODUCTS ══════════════════ */

function publicProduct(p) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    shortDescription: p.shortDescription,
    price: p.price,
    mrp: p.mrp,
    category: p.category,
    tags: p.tags,
    image: p.image,
    images: p.images,
    badge: p.badge,
    highlights: p.highlights,
    upcoming: !!p.upcoming,
    launchDate: p.launchDate,
    inStock: p.stock == null ? true : p.stock > 0,
    rating: productRating(p.id),
  };
}

function productRating(productId) {
  const list = db.reviews.all().filter(r => r.productId === productId && r.status === 'approved');
  if (!list.length) return { average: 0, count: 0 };
  return {
    average: Math.round((list.reduce((s, r) => s + r.rating, 0) / list.length) * 10) / 10,
    count: list.length,
  };
}

router.get('/products', function (req, res) {
  let list = db.products.all().filter(p => p.active !== false);
  if (req.query.category) list = list.filter(p => p.category === req.query.category);
  if (req.query.upcoming === 'true') list = list.filter(p => p.upcoming);
  else if (req.query.upcoming === 'false') list = list.filter(p => !p.upcoming);
  list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  res.json({ products: list.map(publicProduct) });
});

router.get('/products/:slug', function (req, res) {
  const p = db.products.findOne({ slug: req.params.slug }) || db.products.findById(req.params.slug);
  if (!p || p.active === false) return res.status(404).json({ error: 'Product not found' });
  const reviews = db.reviews.all()
    .filter(r => r.productId === p.id && r.status === 'approved')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20)
    .map(r => ({ name: r.name, rating: r.rating, title: r.title, body: r.body, createdAt: r.createdAt, reply: r.reply || null }));
  res.json({ product: publicProduct(p), reviews: reviews });
});

/* ══════════════════ COUPONS ══════════════════ */

router.get('/coupons', function (req, res) {
  res.json({ coupons: publicCoupons() });
});

router.post('/coupons/validate', function (req, res) {
  const result = validateCoupon(req.body.code, Number(req.body.subtotal) || 0, req.body.items);
  if (!result.valid) return res.status(400).json({ error: result.error });
  res.json(result);
});

/* ══════════════════ ORDERS ══════════════════ */

function validateOrderInput(b) {
  if (!b.items || !Array.isArray(b.items) || !b.items.length) return 'Your cart is empty';
  if (!b.customer || !b.customer.name) return 'Name is required';
  if (!b.customer.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.customer.email)) return 'A valid email is required';
  const phone = String(b.customer.phone || '').replace(/\D/g, '');
  if (phone.length < 10) return 'A valid 10-digit phone number is required';
  if (!b.address || !b.address.line1) return 'Delivery address is required';
  if (!b.address.city) return 'City is required';
  if (!/^\d{6}$/.test(String(b.address.pincode || ''))) return 'A valid 6-digit pincode is required';
  return null;
}

/**
 * Price a cart on the server (Phase 0.5.3; BUG-028). The checkout page shows
 * this quote; the payment and the order use the same figures.
 */
router.post('/quote', function (req, res) {
  const q = priceCart({ items: req.body && req.body.items, couponCode: req.body && req.body.couponCode });
  if (!q.ok) return res.status(400).json({ error: q.error, line: q.line });
  res.json(checkoutFlow.publicQuote(q));
});

/**
 * Place an order (Phase 0.5.3–0.5.5; BUG-002, BUG-003, BUG-004, BUG-006).
 *  - live (Razorpay): the order is built from the checkout the server priced
 *    when payment started; the payment is fetched from Razorpay and must pay
 *    exactly that amount, in that currency, for that gateway order; a payment
 *    id can belong to one order only. Repeating the call returns the same order.
 *  - mock: development/test only, never in production; lines are still
 *    validated and re-priced from the catalogue.
 *  - unavailable: 503, nothing is created.
 */
router.post('/orders', async function (req, res, next) {
  try {
    const b = req.body || {};
    const m = payments.mode();
    if (m === 'unavailable') return res.status(503).json({ error: 'Online payment is temporarily unavailable. Please try again later.' });

    const error = validateOrderInput(b);
    if (error) return res.status(400).json({ error: error });

    if (m === 'razorpay') {
      const pay = b.payment || {};
      if (!pay.paymentId || !pay.gatewayOrderId || !pay.signature) {
        return res.status(400).json({ error: 'Payment is required before placing the order.' });
      }
      if (!payments.verifyCheckoutSignature(pay.gatewayOrderId, pay.paymentId, pay.signature)) {
        return res.status(400).json({ error: 'Payment verification failed' });
      }
      let payment;
      try { payment = await payments.fetchPayment(pay.paymentId); }
      catch (e) {
        if (e instanceof payments.GatewayError && e.status === 400) return res.status(400).json({ error: 'Payment verification failed: payment not found' });
        throw e;
      }
      const r = await checkoutFlow.complete({ gatewayOrderId: pay.gatewayOrderId, payment, source: 'browser' });
      return res.status(r.status).json(r.body);
    }

    // Test (mock) mode — never reachable in production (see payments.mode()).
    const q = priceCart({ items: b.items, couponCode: b.couponCode });
    if (!q.ok) return res.status(400).json({ error: q.error, line: q.line });
    const order = await ordersService.createOrder({
      items: orderLines(q.lines),
      subtotal: q.subtotal,
      discount: q.discount,
      couponCode: q.couponCode,
      shipping: q.shipping,
      customer: b.customer,
      address: b.address,
      location: b.location,
      payment: { method: 'online', status: 'paid', gateway: 'mock', paymentId: 'mock_pay_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) },
      notes: b.notes,
      currency: 'INR',
    });

    res.status(201).json({
      ok: true,
      orderId: order.orderId,
      id: order.id,
      total: order.total,
      status: order.status,
    });
  } catch (e) {
    if (e instanceof payments.GatewayError) return res.status(e.status === 400 ? 400 : 502).json({ error: e.message });
    next(e);
  }
});

/* ══════════════════ TRACKING ══════════════════ */

router.post('/track', function (req, res) {
  const result = ordersService.trackOrder(req.body.orderId, req.body.phone);
  if (!result) {
    return res.status(404).json({ error: 'No order found matching that Order ID and phone number. Please check and try again.' });
  }
  res.json(result);
});

/* ══════════════════ REVIEWS ══════════════════ */

router.post('/reviews', function (req, res) {
  const b = req.body;
  const rating = Number(b.rating);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Please select a star rating' });
  if (!b.name || String(b.name).trim().length < 2) return res.status(400).json({ error: 'Please enter your name' });
  if (!b.body || String(b.body).trim().length < 10) return res.status(400).json({ error: 'Please write at least 10 characters' });

  // Optional photo — a data URL. Cap the size so the JSON stays small.
  let photo = '';
  if (b.photo && typeof b.photo === 'string' && b.photo.startsWith('data:image/')) {
    if (b.photo.length > 2_800_000) { // ~2MB of base64
      return res.status(400).json({ error: 'Photo is too large. Please use an image under 2MB.' });
    }
    photo = b.photo;
  }

  // Verified purchase check
  let verified = false;
  if (b.email) {
    const email = String(b.email).toLowerCase();
    verified = db.orders.all().some(o =>
      o.customer.email === email &&
      o.status === 'delivered' &&
      (!b.productId || o.items.some(i => i.id === b.productId))
    );
  }

  const review = db.reviews.insert({
    productId: b.productId || null,
    productName: b.productName || '',
    name: String(b.name || 'Anonymous').slice(0, 60),
    email: b.email ? String(b.email).toLowerCase() : '',
    city: String(b.city || '').slice(0, 60),
    rating: rating,
    title: String(b.title || '').slice(0, 120),
    body: String(b.body).slice(0, 2000),
    photo: photo,
    verified: verified,
    status: 'pending',
    featured: false,
  });
  res.status(201).json({ ok: true, id: review.id, message: 'Thank you! Your review will appear once approved by our team.' });
});

/* Approved reviews for public display (homepage testimonials). */
router.get('/reviews', function (req, res) {
  const approved = db.reviews.all()
    .filter(r => r.status === 'approved')
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, Number(req.query.limit) || 12)
    .map(r => ({
      name: r.name,
      city: r.city || '',
      rating: r.rating,
      title: r.title || '',
      body: r.body,
      photo: r.photo || '',
      verified: !!r.verified,
      productName: r.productName || '',
      createdAt: r.createdAt,
    }));
  res.json({ reviews: approved });
});

/* ══════════════════ GEOCODING ══════════════════ */

/** Reverse geocode lat/lng → address. Uses Google if keyed, else OpenStreetMap. */
router.get('/geocode/reverse', async function (req, res) {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });

  try {
    if (process.env.GOOGLE_MAPS_API_KEY) {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json?latlng=' + lat + ',' + lng +
        '&key=' + process.env.GOOGLE_MAPS_API_KEY;
      const r = await fetch(url);
      const d = await r.json();
      if (d.results && d.results.length) return res.json(parseGoogle(d.results[0], lat, lng));
    }
    const url = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&addressdetails=1';
    const r = await fetch(url, { headers: { 'User-Agent': (process.env.BRAND_NAME || 'SakeOfHealth') + '/1.0' } });
    const d = await r.json();
    return res.json(parseNominatim(d, lat, lng));
  } catch (e) {
    console.error('[GEOCODE]', e.message);
    // Still return the coordinates so the pin is saved; the shopper fills the
    // address fields manually. Failing soft is better than losing the location.
    res.json({
      lat: lat, lng: lng, formatted: '',
      line1: '', line2: '', city: '', state: '', pincode: '', country: 'India',
      lookupFailed: true,
    });
  }
});

/** Forward geocode / address search for the map picker. */
router.get('/geocode/search', async function (req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  try {
    if (process.env.GOOGLE_MAPS_API_KEY) {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(q) +
        '&components=country:IN&key=' + process.env.GOOGLE_MAPS_API_KEY;
      const r = await fetch(url);
      const d = await r.json();
      return res.json({
        results: (d.results || []).slice(0, 6).map(x =>
          parseGoogle(x, x.geometry.location.lat, x.geometry.location.lng)),
      });
    }
    const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=in&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'User-Agent': (process.env.BRAND_NAME || 'SakeOfHealth') + '/1.0' } });
    const d = await r.json();
    return res.json({ results: (d || []).map(x => parseNominatim(x, Number(x.lat), Number(x.lon))) });
  } catch (e) {
    console.error('[GEOCODE SEARCH]', e.message);
    res.json({ results: [] });
  }
});

function parseGoogle(result, lat, lng) {
  const get = types => {
    const c = (result.address_components || []).find(x => types.some(t => x.types.indexOf(t) !== -1));
    return c ? c.long_name : '';
  };
  const streetNumber = get(['street_number']);
  const route = get(['route']);
  return {
    formatted: result.formatted_address || '',
    lat: lat, lng: lng,
    line1: [streetNumber, route].filter(Boolean).join(' ') || get(['premise', 'neighborhood']),
    line2: get(['sublocality_level_1', 'sublocality', 'neighborhood']),
    city: get(['locality', 'administrative_area_level_2']),
    state: get(['administrative_area_level_1']),
    pincode: get(['postal_code']),
    country: get(['country']) || 'India',
  };
}

function parseNominatim(d, lat, lng) {
  const a = d.address || {};
  return {
    formatted: d.display_name || '',
    lat: lat, lng: lng,
    line1: [a.house_number, a.road].filter(Boolean).join(' ') || a.building || a.amenity || '',
    line2: a.suburb || a.neighbourhood || a.village || '',
    city: a.city || a.town || a.state_district || a.county || '',
    state: a.state || '',
    pincode: a.postcode || '',
    country: a.country || 'India',
  };
}

module.exports = router;
