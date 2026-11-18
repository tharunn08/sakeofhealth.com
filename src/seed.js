/**
 * Seed the database with the existing catalogue, sample coupons,
 * staff and demo orders so the admin panel has data on first run.
 * Safe to run repeatedly — it skips collections that already have data.
 */
require('dotenv').config();
const { db } = require('./services/db.js');
const { hashPassword } = require('./middleware/adminAuth.js');

const PRODUCTS = [
  {
    name: 'Multivitamin Gummies', slug: 'multivitamin', sku: 'SOH-MV-60',
    price: 599, mrp: 799, category: 'multivitamins',
    shortDescription: 'Daily essentials in a delicious mixed-berry gummy.',
    description: 'A complete daily multivitamin with 12 essential vitamins and minerals. Vegan, gelatin-free and made with real fruit pectin. 60 gummies — a 30-day supply.',
    image: '/assets/images/multivitamin.png',
    images: ['/assets/images/carousel/multivitamin-1.png', '/assets/images/carousel/multivitamin-2.png', '/assets/images/carousel/multivitamin-3.png', '/assets/images/carousel/multivitamin-4.png'],
    stock: 240, badge: 'Bestseller', sortOrder: 1,
    highlights: ['12 essential vitamins', 'Vegan & gelatin-free', 'No artificial colours', '30-day supply'],
    tags: ['daily', 'immunity', 'energy'],
  },
  {
    name: 'Iron + Folic Acid Gummies', slug: 'iron', sku: 'SOH-FE-60',
    price: 549, mrp: 699, category: 'iron',
    shortDescription: 'Gentle, non-constipating iron that actually tastes good.',
    description: 'Ferrous fumarate paired with folic acid and vitamin C for maximum absorption. Formulated to avoid the metallic aftertaste and stomach upset of iron tablets.',
    image: '/assets/images/iron.png',
    images: ['/assets/images/carousel/iron-1.png', '/assets/images/carousel/iron-2.png', '/assets/images/carousel/iron-3.png', '/assets/images/carousel/iron-4.png'],
    stock: 180, badge: '', sortOrder: 2,
    highlights: ['Gentle on the stomach', 'With vitamin C for absorption', 'Folic acid included', 'No metallic taste'],
    tags: ['iron', 'women', 'energy'],
  },
  {
    name: 'Curcumin Gummies', slug: 'curcumin', sku: 'SOH-CU-60',
    price: 649, mrp: 849, category: 'athletic',
    shortDescription: 'High-absorption turmeric for recovery and joint comfort.',
    description: 'Curcumin with piperine for up to 20× better bioavailability. Supports joint comfort and post-workout recovery without the earthy taste of turmeric powder.',
    image: '/assets/images/curcumin.png',
    images: ['/assets/images/carousel/curcumin-1.png', '/assets/images/carousel/curcumin-2.png', '/assets/images/carousel/curcumin-3.png', '/assets/images/carousel/curcumin-4.png'],
    stock: 150, badge: 'New', sortOrder: 3,
    highlights: ['20× better absorption', 'Joint & recovery support', 'With black pepper extract', 'Anti-inflammatory'],
    tags: ['recovery', 'joints', 'athletic'],
  },
  {
    name: 'Probiotic Gummies', slug: 'probiotic', sku: 'SOH-PB-60',
    price: 699, mrp: 899, category: 'multivitamins',
    shortDescription: 'Two billion CFU for everyday gut balance.',
    description: 'Shelf-stable Bacillus coagulans delivering 2 billion CFU per serving. Supports digestion and gut balance — no refrigeration required.',
    image: '/assets/images/probiotic.png',
    images: ['/assets/images/carousel/probiotic-1.png', '/assets/images/carousel/probiotic-2.png', '/assets/images/carousel/probiotic-3.png', '/assets/images/carousel/probiotic-4.png'],
    stock: 200, badge: '', sortOrder: 4,
    highlights: ['2 billion CFU', 'Shelf stable', 'Supports digestion', 'No refrigeration needed'],
    tags: ['gut', 'digestion', 'daily'],
  },
  {
    name: 'Sleep & Calm Gummies', slug: 'sleep-calm', sku: 'SOH-SL-60',
    price: 599, mrp: 799, category: 'multivitamins',
    shortDescription: 'Melatonin, ashwagandha and L-theanine for restful nights.',
    description: 'A gentle non-habit-forming blend to help you wind down and stay asleep. Launching soon.',
    image: '/assets/images/multivitamin.png', images: [],
    stock: 0, badge: 'Coming Soon', sortOrder: 5,
    upcoming: true, launchDate: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
    highlights: ['Melatonin + Ashwagandha', 'Non habit-forming', 'L-theanine for calm'],
    tags: ['sleep', 'stress'],
  },
];

const COUPONS = [
  { code: 'WELCOME10', type: 'percent', value: 10, description: '10% off your first order', minOrderValue: 499, maxDiscount: 150, showOnSite: true, active: true },
  { code: 'FLAT100', type: 'flat', value: 100, description: '₹100 off orders above ₹899', minOrderValue: 899, showOnSite: true, active: true },
  { code: 'FREESHIP', type: 'free_shipping', value: 0, description: 'Free delivery on any order', minOrderValue: 0, showOnSite: true, active: true },
  { code: 'BULK20', type: 'percent', value: 20, description: '20% off orders above ₹1999', minOrderValue: 1999, maxDiscount: 500, usageLimit: 100, showOnSite: false, active: true },
];

const CITIES = [
  { city: 'Bengaluru', state: 'Karnataka', pincode: '560001', lat: 12.9716, lng: 77.5946 },
  { city: 'Mumbai', state: 'Maharashtra', pincode: '400001', lat: 19.076, lng: 72.8777 },
  { city: 'Delhi', state: 'Delhi', pincode: '110001', lat: 28.6139, lng: 77.209 },
  { city: 'Hyderabad', state: 'Telangana', pincode: '500001', lat: 17.385, lng: 78.4867 },
  { city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', lat: 13.0827, lng: 80.2707 },
  { city: 'Pune', state: 'Maharashtra', pincode: '411001', lat: 18.5204, lng: 73.8567 },
];

const NAMES = ['Aarav Sharma', 'Diya Patel', 'Vihaan Reddy', 'Ananya Iyer', 'Arjun Nair', 'Ishita Gupta',
  'Kabir Singh', 'Meera Krishnan', 'Rohan Desai', 'Saanvi Rao', 'Aditya Menon', 'Priya Verma',
  'Karthik Subramanian', 'Nisha Joshi', 'Rahul Bhat', 'Tanvi Kulkarni'];

const STATUSES = ['pending', 'accepted', 'prepared', 'out_for_delivery', 'delivered'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

/**
 * @param {{withStaff?: boolean}} [opts]
 *   withStaff — also create the demo staff accounts (local development only).
 * Refuses to run in production (Phase 0.5.8, BUG-008): a live shop must never
 * be refilled with demo data or staff accounts whose passwords are published.
 */
function seed(opts) {
  opts = opts || {};
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production. Demo data and demo staff are for development only.');
  }
  let created = { products: 0, coupons: 0, staff: 0, orders: 0, reviews: 0 };

  /* ── Products ── */
  if (db.products.count() === 0) {
    PRODUCTS.forEach(p => {
      db.products.insert(Object.assign({ active: true, upcoming: false }, p));
      created.products++;
    });
  }

  /* ── Coupons ── */
  if (db.coupons.count() === 0) {
    COUPONS.forEach(c => {
      db.coupons.insert(Object.assign({
        usedCount: 0, expiresAt: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
        appliesTo: [], createdBy: 'seed',
      }, c));
      created.coupons++;
    });
  }

  /* ── Staff — only when explicitly asked for (npm run seed -- --with-staff) ── */
  if (opts.withStaff && db.staff.count() === 0) {
    [
      { name: 'Operations Manager', email: 'manager@sakeofhealth.com', role: 'manager', phone: '9876543210', password: 'manager@1234' },
      { name: 'Ravi Kumar', email: 'ravi@sakeofhealth.com', role: 'delivery', phone: '9876543211', password: 'delivery@1234' },
      { name: 'Sunil Yadav', email: 'sunil@sakeofhealth.com', role: 'delivery', phone: '9876543212', password: 'delivery@1234' },
      { name: 'Support Desk', email: 'support@sakeofhealth.com', role: 'staff', phone: '9876543213', password: 'support@1234' },
    ].forEach(s => {
      db.staff.insert({
        name: s.name, email: s.email, phone: s.phone, role: s.role,
        passwordHash: hashPassword(s.password), active: true, createdBy: 'seed',
      });
      created.staff++;
    });
  }

  /* ── Demo orders across the last 45 days ──
     Off by default so a fresh install starts clean. Set SEED_DEMO_DATA=true
     in .env if you want sample orders to explore the dashboard. ── */
  const includeDemo = String(process.env.SEED_DEMO_DATA || 'false') === 'true';
  if (includeDemo && db.orders.count() === 0) {
    const products = db.products.all().filter(p => !p.upcoming);
    const orderIdCounters = {};

    for (let i = 0; i < 68; i++) {
      const daysAgo = Math.floor(Math.pow(Math.random(), 1.6) * 45);
      const created_at = new Date(Date.now() - daysAgo * 86400000 - randInt(0, 20) * 3600000);
      const dateKey = created_at.getFullYear() + String(created_at.getMonth() + 1).padStart(2, '0') + String(created_at.getDate()).padStart(2, '0');
      orderIdCounters[dateKey] = (orderIdCounters[dateKey] || 0) + 1;

      const loc = pick(CITIES);
      const name = pick(NAMES);
      const itemCount = randInt(1, 3);
      const chosen = [];
      for (let j = 0; j < itemCount; j++) {
        const p = pick(products);
        if (chosen.some(c => c.id === p.id)) continue;
        chosen.push({ id: p.id, name: p.name, price: p.price, qty: randInt(1, 2), image: p.image });
      }
      const subtotal = chosen.reduce((s, it) => s + it.price * it.qty, 0);

      let discount = 0, couponCode = null;
      if (Math.random() < 0.35) {
        const c = pick(db.coupons.all().filter(x => subtotal >= (x.minOrderValue || 0)));
        if (c) {
          couponCode = c.code;
          discount = c.type === 'percent'
            ? Math.min(Math.round(subtotal * c.value / 100), c.maxDiscount || Infinity)
            : (c.type === 'flat' ? Math.min(c.value, subtotal) : 0);
        }
      }
      const shipping = subtotal - discount >= 499 ? 0 : 49;
      const total = subtotal - discount + shipping;

      // Older orders are more likely to be complete
      let status;
      if (daysAgo > 7) status = Math.random() < 0.93 ? 'delivered' : 'cancelled';
      else if (daysAgo > 3) status = pick(['delivered', 'delivered', 'out_for_delivery', 'cancelled']);
      else if (daysAgo > 1) status = pick(['out_for_delivery', 'prepared', 'delivered', 'accepted']);
      else status = pick(['pending', 'pending', 'accepted', 'prepared']);

      const stageIndex = STATUSES.indexOf(status);
      const timeline = [];
      if (status === 'cancelled') {
        timeline.push({ status: 'pending', at: created_at.toISOString(), by: 'system', note: 'Order placed' });
        timeline.push({ status: 'cancelled', at: new Date(created_at.getTime() + 7200000).toISOString(), by: 'admin', note: 'Customer requested cancellation' });
      } else {
        for (let s = 0; s <= stageIndex; s++) {
          timeline.push({
            status: STATUSES[s],
            at: new Date(created_at.getTime() + s * randInt(4, 20) * 3600000).toISOString(),
            by: s === 0 ? 'system' : 'admin',
            note: s === 0 ? 'Order placed' : '',
          });
        }
      }

      const method = Math.random() < 0.72 ? 'online' : 'cod';
      const email = name.toLowerCase().replace(/\s+/g, '.') + '@example.com';
      const phone = '9' + String(randInt(100000000, 999999999));

      const order = db.orders.insert({
        orderId: 'SOH-' + dateKey + '-' + String(orderIdCounters[dateKey]).padStart(4, '0'),
        createdAt: created_at.toISOString(),
        items: chosen, subtotal: subtotal, discount: discount, couponCode: couponCode,
        shipping: shipping, total: total, currency: 'INR',
        customer: { name: name, email: email, phone: phone },
        address: {
          line1: randInt(1, 400) + ', ' + pick(['Green Park Residency', 'Lake View Apartments', 'MG Road', 'Sunrise Enclave', 'Palm Grove']),
          line2: pick(['Sector 4', 'Phase 2', 'Block C', '2nd Cross', '']),
          city: loc.city, state: loc.state, pincode: loc.pincode,
          landmark: pick(['Near metro station', 'Opposite the park', 'Behind the mall', '']),
        },
        location: {
          lat: loc.lat + (Math.random() - 0.5) * 0.12,
          lng: loc.lng + (Math.random() - 0.5) * 0.12,
          accuracy: randInt(8, 60), source: pick(['gps', 'map_pin']),
          formatted: loc.city + ', ' + loc.state, capturedAt: created_at.toISOString(),
        },
        payment: {
          method: method,
          status: status === 'delivered' ? 'paid' : (method === 'online' ? 'paid' : 'pending'),
          gateway: method === 'online' ? 'razorpay' : null,
          paymentId: method === 'online' ? 'pay_demo_' + Math.random().toString(36).slice(2, 12) : null,
        },
        status: status, timeline: timeline,
        deliveredAt: status === 'delivered' ? timeline[timeline.length - 1].at : null,
        notes: '', assignedTo: null,
      });
      created.orders++;
      require('./services/orders.js').upsertCustomer(order);
    }
  }

  /* ── Reviews ── */
  if (includeDemo && db.reviews.count() === 0) {
    const products = db.products.all().filter(p => !p.upcoming);
    const bodies = [
      { r: 5, t: 'Actually works', b: 'I have been taking these for six weeks now and my energy levels through the afternoon are noticeably better. Taste is great too — no chalky aftertaste.' },
      { r: 5, t: 'Kids love them', b: 'Finally something my daughter takes without a fight every morning. Packaging is lovely and delivery was quick.' },
      { r: 4, t: 'Good, slightly pricey', b: 'Quality is clearly there and I like the clean ingredient list. Would give five stars if the subscription price were a bit lower.' },
      { r: 5, t: 'No more iron tablets', b: 'The iron gummies have been a revelation. No stomach upset at all, which was always the problem with the tablets my doctor prescribed.' },
      { r: 4, t: 'Solid daily supplement', b: 'Been using for a month. Nothing dramatic but I feel consistently better and the convenience of not swallowing pills is real.' },
      { r: 3, t: 'Decent but sweet', b: 'Effective enough and delivery was fast, but they are sweeter than I expected. Would prefer a less sugary version.' },
      { r: 5, t: 'Great for recovery', b: 'The curcumin ones have genuinely helped with post-workout soreness. Two weeks in and my knees feel better on running days.' },
    ];
    bodies.forEach((x, i) => {
      const p = products[i % products.length];
      db.reviews.insert({
        productId: p.id, productName: p.name,
        name: pick(NAMES), email: 'reviewer' + i + '@example.com',
        rating: x.r, title: x.t, body: x.b,
        verified: true,
        status: i < 5 ? 'approved' : 'pending',
        featured: i === 0,
        createdAt: new Date(Date.now() - randInt(1, 40) * 86400000).toISOString(),
      });
      created.reviews++;
    });
  }

  db.flushSync();
  return created;
}

if (require.main === module) {
  const withStaff = process.argv.indexOf('--with-staff') !== -1;
  let result;
  try { result = seed({ withStaff: withStaff }); }
  catch (e) { console.error('✗ ' + e.message); process.exit(1); }
  console.log('\n✓ Database seeded');
  Object.keys(result).forEach(k => {
    console.log('  ' + k + ': ' + (result[k] || (k === 'staff' && !withStaff ? 'not created (add --with-staff for local demo logins)' : 'already present — skipped')));
  });
  if (result.staff) {
    console.log('\nDemo staff logins (local development only):');
    console.log('  manager@sakeofhealth.com / manager@1234   (manager)');
    console.log('  ravi@sakeofhealth.com    / delivery@1234  (delivery)');
    console.log('  support@sakeofhealth.com / support@1234   (staff)');
  }
  console.log('\nRoot admin comes from ADMIN_EMAIL / ADMIN_PASSWORD in .env\n');
}

module.exports = { seed };
