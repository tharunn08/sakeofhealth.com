/**
 * Admin API — dashboard, orders, products, coupons, customers,
 * reviews, staff, deliveries, analytics and reports.
 */
const { Router } = require('express');
const { db } = require('../services/db.js');
const { adminAuth, requireRole, login, hashPassword } = require('../middleware/adminAuth.js');
const { b2cPermissions } = require('../middleware/b2cPermissions.js');
const orders = require('../services/orders.js');
const reports = require('../services/reports.js');
const { normalise } = require('../services/coupons.js');
const { sendEmail, sendWhatsApp, verifyEmail } = require('../services/notify.js');

const router = Router();

// Staff roles. The first four are the original B2C roles; the rest are B2B
// back-office roles (their permissions live in src/modules/b2b/rbac.js).
const STAFF_ROLES = ['admin', 'manager', 'staff', 'delivery', 'b2b_admin', 'b2b_manager', 'sales', 'inventory', 'finance', 'support'];

/* ══════════════════ AUTH ══════════════════ */

router.post('/login', function (req, res) {
  const result = login(req.body.email, req.body.password);
  if (!result.ok) return res.status(result.unavailable ? 503 : 401).json({ error: result.error });
  db.events.insert({ type: 'admin_login', email: result.user.email, ts: Date.now(), ip: req.ip });
  res.json({ token: result.token, user: result.user });
});

router.get('/me', adminAuth, function (req, res) {
  res.json({ user: { email: req.admin.email, name: req.admin.name, role: req.admin.role } });
});

// Everything below requires authentication, then the role matrix (server-side)
router.use(adminAuth);
router.use(b2cPermissions);

/* ══════════════════ DASHBOARD ══════════════════ */

router.get('/dashboard', function (req, res, next) {
  try { res.json(reports.dashboard()); } catch (e) { next(e); }
});

/* ══════════════════ ORDERS ══════════════════ */

router.get('/orders', function (req, res, next) {
  try {
    let list = db.orders.all();
    const q = req.query;

    if (q.status) list = list.filter(o => o.status === q.status);
    if (q.range === 'today') {
      const t = new Date(); t.setHours(0, 0, 0, 0);
      list = list.filter(o => new Date(o.createdAt) >= t);
    } else if (q.range === 'yesterday') {
      const t = new Date(); t.setHours(0, 0, 0, 0);
      const y = new Date(t.getTime() - 86400000);
      list = list.filter(o => new Date(o.createdAt) >= y && new Date(o.createdAt) < t);
    } else if (q.range === 'week') {
      const t = new Date(); t.setHours(0, 0, 0, 0);
      list = list.filter(o => new Date(o.createdAt) >= new Date(t.getTime() - 6 * 86400000));
    }
    if (q.from) list = list.filter(o => new Date(o.createdAt) >= new Date(q.from));
    if (q.to) list = list.filter(o => new Date(o.createdAt) <= new Date(q.to + 'T23:59:59'));

    if (q.search) {
      const s = String(q.search).toLowerCase();
      list = list.filter(o =>
        String(o.orderId).toLowerCase().includes(s) ||
        String(o.customer.name).toLowerCase().includes(s) ||
        String(o.customer.phone).includes(s) ||
        String(o.customer.email).toLowerCase().includes(s)
      );
    }

    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Number(q.limit) || 25);
    const total = list.length;

    res.json({
      orders: list.slice((page - 1) * limit, page * limit),
      total: total,
      page: page,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (e) { next(e); }
});

router.get('/orders/:id', function (req, res) {
  const order = db.orders.findById(req.params.id) || db.orders.findOne({ orderId: req.params.id });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
});

router.patch('/orders/:id/status', async function (req, res, next) {
  try {
    // Cancelling from the status menu follows the same rules as "Cancel order":
    // a reason (the note) is required and recorded (Phase 0.5.7, D10).
    const updated = req.body.status === 'cancelled'
      ? await orders.cancelOrder(req.params.id, { reason: req.body.note, actor: req.admin.email })
      : await orders.updateStatus(req.params.id, req.body.status, req.admin.email, req.body.note);
    res.json(updated);
  } catch (e) {
    if (e instanceof orders.OrderError) return res.status(e.status).json({ error: e.message });
    if (/not found|Invalid status/.test(e.message)) return res.status(400).json({ error: e.message });
    next(e);
  }
});

// Cancel an order (manager+): kept on file with reason, actor and time (Phase 0.5.7, D10).
router.post('/orders/:id/cancel', async function (req, res, next) {
  try {
    const updated = await orders.cancelOrder(req.params.id, { reason: req.body && req.body.reason, actor: req.admin.email });
    res.json(updated);
  } catch (e) {
    if (e instanceof orders.OrderError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.patch('/orders/:id', function (req, res) {
  const allowed = {};
  ['notes', 'assignedTo', 'address', 'payment'].forEach(k => {
    if (req.body[k] !== undefined) allowed[k] = req.body[k];
  });
  const updated = db.orders.update(req.params.id, allowed);
  if (!updated) return res.status(404).json({ error: 'Order not found' });
  res.json(updated);
});

router.post('/orders/:id/resend-notification', async function (req, res, next) {
  try {
    const order = db.orders.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const { notifyStatusChange } = require('../services/notify.js');
    await notifyStatusChange(order, order.status);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Orders are no longer deleted (Phase 0.5.7, D10): use POST /orders/:id/cancel
// with a reason. The route answers 410 so an old admin page fails visibly
// instead of silently removing records.
router.delete('/orders/:id', function (req, res) {
  res.status(410).json({ error: 'Orders can no longer be deleted. Use "Cancel order" and give a reason — the order is kept for your records.' });
});

/* ══════════════════ PRODUCTS ══════════════════ */

// The four protected products (src/services/productProtection.js): the store refuses deletion,
// deactivation and identity changes; other edits need a reason and are logged.
const protection = require('../services/productProtection.js');
function adminActor(req) { return 'admin:' + ((req.admin && (req.admin.email || req.admin.sub)) || 'unknown') + (req.admin && req.admin.role ? ' (' + req.admin.role + ')' : ''); }
function protectedError(res, e) {
  if (e instanceof protection.ProtectedProductError) { res.status(e.status).json({ error: e.message, code: e.code, fields: e.detail && e.detail.fields }); return true; }
  return false;
}

router.get('/products', function (req, res) {
  let list = db.products.all().map(function (p) {
    const e = protection.entryFor(p);
    return e ? Object.assign({}, p, { protected: true, toConfirm: e.toConfirm }) : p;
  });
  if (req.query.category) list = list.filter(p => p.category === req.query.category);
  if (req.query.status === 'upcoming') list = list.filter(p => p.upcoming);
  if (req.query.status === 'live') list = list.filter(p => !p.upcoming && p.active !== false);
  list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ products: list });
});

router.post('/products', function (req, res) {
  const b = req.body;
  if (!b.name || b.price == null) return res.status(400).json({ error: 'Name and price are required' });
  let product;
  try { product = protection.run({ actor: adminActor(req), reason: b.reason, via: 'admin:create' }, function () { return db.products.insert({
    name: String(b.name).trim(),
    slug: (b.slug || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    sku: b.sku || '',
    description: b.description || '',
    shortDescription: b.shortDescription || '',
    price: Number(b.price),
    mrp: b.mrp ? Number(b.mrp) : null,
    category: b.category || 'general',
    tags: Array.isArray(b.tags) ? b.tags : [],
    image: b.image || '',
    images: Array.isArray(b.images) ? b.images : [],
    stock: b.stock == null ? null : Number(b.stock),
    active: b.active !== false,
    upcoming: !!b.upcoming,
    launchDate: b.launchDate || null,
    badge: b.badge || '',
    sortOrder: Number(b.sortOrder) || 0,
    highlights: Array.isArray(b.highlights) ? b.highlights : [],
  }); }); } catch (e) { if (protectedError(res, e)) return; throw e; }
  res.status(201).json(product);
});

router.patch('/products/:id', function (req, res) {
  const patch = Object.assign({}, req.body);
  const reason = patch.reason;
  delete patch.id; delete patch.createdAt; delete patch.reason; delete patch.protected; delete patch.toConfirm;
  if (patch.price != null) patch.price = Number(patch.price);
  if (patch.mrp != null) patch.mrp = Number(patch.mrp);
  if (patch.stock != null) patch.stock = Number(patch.stock);
  let updated;
  try { updated = protection.run({ actor: adminActor(req), reason: reason, via: 'admin:edit' }, function () { return db.products.update(req.params.id, patch); }); }
  catch (e) { if (protectedError(res, e)) return; throw e; }
  if (!updated) return res.status(404).json({ error: 'Product not found' });
  res.json(updated);
});

// Change log of a protected product (who, when, why, before → after).
router.get('/products/:id/history', function (req, res) {
  const p = db.products.findById(req.params.id);
  const e = protection.entryFor(p);
  if (!e) return res.status(404).json({ error: 'Only the protected products keep a change log' });
  res.json({ productId: e.id, changes: protection.history(e.id, 200) });
});

router.delete('/products/:id', requireRole('manager'), function (req, res) {
  // The four protected products are permanent: the store refuses (src/services/productProtection.js).
  let ok;
  try { ok = protection.run({ actor: adminActor(req), via: 'admin:delete' }, function () { return db.products.remove(req.params.id); }); }
  catch (e) { if (protectedError(res, e)) return; throw e; }
  if (!ok) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
});

/* ══════════════════ COUPONS ══════════════════ */

router.get('/coupons', function (req, res) {
  const list = db.coupons.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ coupons: list });
});

router.post('/coupons', function (req, res) {
  const b = req.body;
  const code = normalise(b.code);
  if (!code) return res.status(400).json({ error: 'Coupon code is required' });
  if (db.coupons.findOne({ code: code })) return res.status(409).json({ error: 'That coupon code already exists' });
  if (['percent', 'flat', 'free_shipping'].indexOf(b.type) === -1) {
    return res.status(400).json({ error: 'Type must be percent, flat or free_shipping' });
  }
  const coupon = db.coupons.insert({
    code: code,
    type: b.type,
    value: Number(b.value) || 0,
    description: b.description || '',
    minOrderValue: Number(b.minOrderValue) || 0,
    maxDiscount: b.maxDiscount ? Number(b.maxDiscount) : null,
    usageLimit: b.usageLimit ? Number(b.usageLimit) : null,
    usedCount: 0,
    perCustomerLimit: b.perCustomerLimit ? Number(b.perCustomerLimit) : null,
    startsAt: b.startsAt || null,
    expiresAt: b.expiresAt || null,
    active: b.active !== false,
    showOnSite: !!b.showOnSite,
    appliesTo: Array.isArray(b.appliesTo) ? b.appliesTo : [],
    createdBy: req.admin.email,
  });
  res.status(201).json(coupon);
});

router.patch('/coupons/:id', function (req, res) {
  const patch = Object.assign({}, req.body);
  delete patch.id; delete patch.usedCount; delete patch.createdAt;
  if (patch.code) patch.code = normalise(patch.code);
  const updated = db.coupons.update(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Coupon not found' });
  res.json(updated);
});

router.delete('/coupons/:id', function (req, res) {
  const ok = db.coupons.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Coupon not found' });
  res.json({ ok: true });
});

/* ══════════════════ CUSTOMERS ══════════════════ */

router.get('/customers', function (req, res) {
  let list = db.customers.all();
  if (req.query.search) {
    const s = String(req.query.search).toLowerCase();
    list = list.filter(c =>
      String(c.name).toLowerCase().includes(s) ||
      String(c.email).toLowerCase().includes(s) ||
      String(c.phone).includes(s)
    );
  }
  const sort = req.query.sort || 'recent';
  if (sort === 'spent') list.sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0));
  else if (sort === 'orders') list.sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0));
  else list.sort((a, b) => new Date(b.lastOrderAt || 0) - new Date(a.lastOrderAt || 0));
  res.json({ customers: list, total: list.length });
});

router.get('/customers/:id', function (req, res) {
  const customer = db.customers.findById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const history = db.orders.all()
    .filter(o => o.customer.email === customer.email || o.customer.phone === customer.phone)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ customer: customer, orders: history });
});

router.patch('/customers/:id', function (req, res) {
  const updated = db.customers.update(req.params.id, {
    tags: req.body.tags, notes: req.body.notes,
  });
  if (!updated) return res.status(404).json({ error: 'Customer not found' });
  res.json(updated);
});

/* ══════════════════ REVIEWS ══════════════════ */

router.get('/reviews', function (req, res) {
  let list = db.reviews.all();
  if (req.query.status) list = list.filter(r => (r.status || 'pending') === req.query.status);
  if (req.query.productId) list = list.filter(r => r.productId === req.query.productId);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const stats = {
    total: db.reviews.count(),
    pending: db.reviews.all().filter(r => (r.status || 'pending') === 'pending').length,
    approved: db.reviews.count({ status: 'approved' }),
    avgRating: avgRating(db.reviews.all().filter(r => r.status === 'approved')),
  };
  res.json({ reviews: list, stats: stats });
});

function avgRating(list) {
  if (!list.length) return 0;
  return Math.round((list.reduce((s, r) => s + (r.rating || 0), 0) / list.length) * 10) / 10;
}

router.patch('/reviews/:id', function (req, res) {
  const patch = {};
  if (req.body.status) patch.status = req.body.status;
  if (req.body.reply !== undefined) {
    patch.reply = req.body.reply;
    patch.repliedBy = req.admin.email;
    patch.repliedAt = new Date().toISOString();
  }
  if (req.body.featured !== undefined) patch.featured = !!req.body.featured;
  const updated = db.reviews.update(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Review not found' });
  res.json(updated);
});

router.delete('/reviews/:id', function (req, res) {
  const ok = db.reviews.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Review not found' });
  res.json({ ok: true });
});

/* ══════════════════ STAFF ══════════════════ */

router.get('/staff', requireRole('manager'), function (req, res) {
  const list = db.staff.all().map(s => ({
    id: s.id, name: s.name, email: s.email, role: s.role,
    phone: s.phone, active: s.active !== false,
    lastLogin: s.lastLogin || null, createdAt: s.createdAt,
  }));
  res.json({ staff: list });
});

router.post('/staff', requireRole('manager'), function (req, res) {
  const b = req.body;
  const email = String(b.email || '').trim().toLowerCase();
  if (!email || !b.password) return res.status(400).json({ error: 'Email and password are required' });
  if (String(b.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.staff.findOne({ email: email })) return res.status(409).json({ error: 'A staff member with that email already exists' });

  const member = db.staff.insert({
    name: b.name || email,
    email: email,
    phone: b.phone || '',
    role: STAFF_ROLES.indexOf(b.role) !== -1 ? b.role : 'staff',
    passwordHash: hashPassword(String(b.password)),
    active: true,
    createdBy: req.admin.email,
  });
  res.status(201).json({ id: member.id, name: member.name, email: member.email, role: member.role });
});

router.patch('/staff/:id', requireRole('manager'), function (req, res) {
  const patch = {};
  ['name', 'phone', 'role', 'active'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  if (patch.role !== undefined && STAFF_ROLES.indexOf(patch.role) === -1) {
    return res.status(400).json({ error: 'Unknown role' });
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    patch.passwordHash = hashPassword(String(req.body.password));
    patch.passwordChangedAt = new Date().toISOString();   // clears the demo-account warning (BUG-008)
  }
  const updated = db.staff.update(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Staff member not found' });
  res.json({ id: updated.id, name: updated.name, email: updated.email, role: updated.role, active: updated.active });
});

router.delete('/staff/:id', requireRole('manager'), function (req, res) {
  const ok = db.staff.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Staff member not found' });
  res.json({ ok: true });
});

/* ══════════════════ DELIVERIES ══════════════════ */

router.get('/deliveries', function (req, res) {
  // Delivery agents see only the orders assigned to them.
  const mineOnly = req.admin.role === 'delivery';
  const active = db.orders.all()
    .filter(o => ['accepted', 'prepared', 'out_for_delivery'].indexOf(o.status) !== -1)
    .filter(o => !mineOnly || (o.assignedTo && String(o.assignedTo.id) === String(req.admin.sub)))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const agents = db.staff.all()
    .filter(s => s.role === 'delivery' && s.active !== false)
    .map(s => ({ id: s.id, name: s.name, phone: s.phone, email: s.email }));

  res.json({
    deliveries: active.map(o => ({
      id: o.id,
      orderId: o.orderId,
      status: o.status,
      customer: o.customer,
      address: o.address,
      location: o.location,
      total: o.total,
      items: o.items.reduce((s, i) => s + i.qty, 0),
      assignedTo: o.assignedTo,
      createdAt: o.createdAt,
      paymentMethod: o.payment && o.payment.method,
    })),
    agents: agents,
    counts: {
      accepted: active.filter(o => o.status === 'accepted').length,
      prepared: active.filter(o => o.status === 'prepared').length,
      out_for_delivery: active.filter(o => o.status === 'out_for_delivery').length,
      unassigned: active.filter(o => !o.assignedTo).length,
    },
  });
});

router.post('/deliveries/:orderId/assign', function (req, res) {
  const order = db.orders.findById(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const agent = db.staff.findById(req.body.agentId);
  if (!agent) return res.status(400).json({ error: 'Delivery agent not found' });

  const updated = db.orders.update(order.id, {
    assignedTo: { id: agent.id, name: agent.name, phone: agent.phone },
  });

  if (agent.phone) {
    const addr = order.address;
    sendWhatsApp(agent.phone,
      'New delivery assigned\n\nOrder: ' + order.orderId +
      '\nCustomer: ' + order.customer.name + ' (' + order.customer.phone + ')' +
      '\nAddress: ' + [addr.line1, addr.line2, addr.city, addr.pincode].filter(Boolean).join(', ') +
      (order.location ? '\nMap: https://www.google.com/maps?q=' + order.location.lat + ',' + order.location.lng : '') +
      '\nAmount: ₹' + order.total + ' (PAID)'
    ).catch(() => {});
  }
  res.json(updated);
});

/* ══════════════════ ANALYTICS & REPORTS ══════════════════ */

router.get('/analytics', function (req, res, next) {
  try { res.json(reports.analytics(req.query.days)); } catch (e) { next(e); }
});

router.get('/reports/:type.csv', function (req, res, next) {
  try {
    const type = req.params.type;
    let csv, filename;
    if (type === 'orders') { csv = reports.ordersCSV(req.query); filename = 'orders'; }
    else if (type === 'sales') { csv = reports.salesCSV(req.query); filename = 'sales'; }
    else if (type === 'deliveries') { csv = reports.deliveriesCSV(req.query); filename = 'deliveries'; }
    else if (type === 'customers') { csv = reports.customersCSV(); filename = 'customers'; }
    else if (type === 'products') { csv = reports.productsCSV(); filename = 'products'; }
    else return res.status(400).json({ error: 'Unknown report type' });

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '-' + stamp + '.csv"');
    res.send('\uFEFF' + csv);
  } catch (e) { next(e); }
});

/* ══════════════════ SETTINGS ══════════════════ */

router.get('/settings', async function (req, res, next) {
  try {
    const s = db.settings.findOne({ key: 'store' }) || { key: 'store', value: {} };
    let emailDiag = { ok: false, configured: false, reason: '' };
    try { emailDiag = await verifyEmail(); } catch (e) { emailDiag.reason = e.message; }
    res.json({
      settings: s.value,
      integrations: {
        email: !!(process.env.SMTP_HOST && process.env.SMTP_USER),
        emailStatus: emailDiag,
        whatsapp: !!(process.env.WHATSAPP_TOKEN || process.env.TWILIO_ACCOUNT_SID),
        razorpay: !!process.env.RAZORPAY_KEY_ID,
        paymentMock: process.env.PAYMENT_MOCK === 'true',
        maps: !!process.env.GOOGLE_MAPS_API_KEY,
        codEnabled: false,
      },
    });
  } catch (e) { next(e); }
});

router.put('/settings', function (req, res) {
  const existing = db.settings.findOne({ key: 'store' });
  if (existing) db.settings.update(existing.id, { value: req.body });
  else db.settings.insert({ key: 'store', value: req.body });
  res.json({ ok: true });
});

/* ─── Staff order-notification emails ───────────────────────────────────
   A list of extra email addresses that receive a copy of every new order,
   in addition to ADMIN_EMAIL. Managed here so it can be changed without
   touching the .env file. Only admin and manager roles may view or edit. */

const RX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getNotifyEmails() {
  const row = db.settings.findOne({ key: 'notifyEmails' });
  const list = row && Array.isArray(row.value) ? row.value : [];
  return list;
}

router.get('/notify-emails', requireRole('manager'), function (req, res) {
  res.json({ emails: getNotifyEmails() });
});

router.put('/notify-emails', requireRole('manager'), function (req, res) {
  const input = Array.isArray(req.body.emails) ? req.body.emails : [];

  // Clean: trim, lowercase, validate, de-duplicate, cap the list length.
  const seen = {};
  const clean = [];
  for (let i = 0; i < input.length && clean.length < 25; i++) {
    const e = String(input[i] || '').trim().toLowerCase();
    if (!e) continue;
    if (!RX_EMAIL.test(e)) return res.status(400).json({ error: 'Invalid email address: ' + input[i] });
    if (seen[e]) continue;
    seen[e] = true;
    clean.push(e);
  }

  const existing = db.settings.findOne({ key: 'notifyEmails' });
  if (existing) db.settings.update(existing.id, { value: clean });
  else db.settings.insert({ key: 'notifyEmails', value: clean });

  db.events.insert({ type: 'notify_emails_updated', by: req.admin.email, count: clean.length, ts: Date.now() });
  res.json({ ok: true, emails: clean });
});

/* ─── Print centre: sender details shown on delivery labels and bills ───
   Stored under its own settings key, so saving the Settings page never
   touches it. Any signed-in staff member can read it (they print labels);
   only admin and manager can change it. */

function getPrintSender() {
  const row = db.settings.findOne({ key: 'printSender' });
  const saved = (row && row.value) || {};
  return {
    businessName: saved.businessName || process.env.BRAND_NAME || 'Sake of Health',
    address: saved.address || '',
    phone: saved.phone || process.env.SUPPORT_PHONE || '',
    email: saved.email || process.env.SUPPORT_EMAIL || '',
    gstin: saved.gstin || '',
    footer: saved.footer || 'Thank you for shopping with us.',
  };
}

router.get('/print-settings', function (req, res) {
  res.json({ sender: getPrintSender(), canEdit: req.admin.role === 'admin' || req.admin.role === 'manager' });
});

router.put('/print-settings', requireRole('manager'), function (req, res) {
  const b = req.body || {};
  const clean = function (v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max); };
  const value = {
    businessName: clean(b.businessName, 120),
    address: clean(b.address, 300),
    phone: clean(b.phone, 30),
    email: clean(b.email, 120),
    gstin: clean(b.gstin, 15).toUpperCase(),
    footer: clean(b.footer, 300),
  };
  if (!value.businessName) return res.status(400).json({ error: 'Business name is required' });
  const existing = db.settings.findOne({ key: 'printSender' });
  if (existing) db.settings.update(existing.id, { value: value });
  else db.settings.insert({ key: 'printSender', value: value });
  res.json({ ok: true, sender: getPrintSender() });
});

// Diagnose the email setup without sending anything.
router.get('/email-status', async function (req, res, next) {
  try { res.json(await verifyEmail()); } catch (e) { next(e); }
});

router.post('/test-notification', async function (req, res) {
  const to = req.body.email || req.admin.email;
  const phone = req.body.phone;
  const results = {};

  if (to) {
    const diag = await verifyEmail();
    if (!diag.ok && !diag.configured) {
      results.email = { ok: false, mock: true, reason: diag.reason };
    } else {
      results.email = await sendEmail(to, 'Test notification — ' + (process.env.BRAND_NAME || 'Sake of Health'),
        '<p>Your email integration is working correctly. If you can read this, order confirmations will reach your customers.</p>');
      if (!results.email.ok && diag.reason) results.email.reason = diag.reason;
    }
  }
  if (phone) results.whatsapp = await sendWhatsApp(phone, 'Test notification — your WhatsApp integration is working.');
  res.json(results);
});

module.exports = router;
