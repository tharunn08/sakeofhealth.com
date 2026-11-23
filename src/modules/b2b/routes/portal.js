/**
 * Business portal API — mounted at /api/b2b.
 *
 * Data isolation: every query below is scoped by the caller's own account id,
 * taken from the server-side session (req.b2b), never from the request body.
 * A retailer can only reach its own orders/invoices/payments; a distributor
 * can only reach orders it supplies and retailers mapped to it. Anything else
 * answers 404, exactly as if it did not exist.
 */
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('../../../db/connection.js');
const config = require('../config.js');
const { h, paging, paged, bad, notFound, clientIp } = require('../lib/http.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const uploads = require('../lib/uploads.js');
const security = require('../lib/security.js');
const { requireBusiness, requireApproved, requireType } = require('../auth/portalAuth.js');
const accounts = require('../accounts/service.js');
const mappings = require('../mappings/service.js');
const catalogue = require('../catalogue/service.js');
const inventory = require('../inventory/service.js');
const orders = require('../orders/service.js');
const invoices = require('../invoices/service.js');
const payments = require('../payments/service.js');
const returns = require('../returns/service.js');
const reports = require('../reports/service.js');

const router = express.Router();
const isTest = process.env.NODE_ENV === 'test';
const limit = function (windowMs, max, message) {
  return rateLimit({ windowMs: windowMs, max: isTest ? 100000 : max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
};
const loginLimit = rateLimit({ windowMs: 15 * 60000, max: isTest ? 100000 : 15, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' } });
const registerLimit = limit(60 * 60000, 10, 'Too many registrations from this connection. Please try again later.');
const orderLimit = limit(60000, 12, 'Too many orders placed. Please wait a moment.');
const writeLimit = limit(60000, 120, 'Too many requests. Please slow down.');

const id = function (req, name) { const n = Number(req.params[name || 'id']); if (!Number.isInteger(n) || n <= 0) throw notFound(); return n; };

/* ═════════════ Public ═════════════ */

router.get('/config', function (req, res) {
  res.json({
    enabled: true, brand: process.env.BRAND_NAME || 'Sake of Health',
    businessTypes: accounts.BUSINESS_TYPES, requiredDocuments: accounts.REQUIRED_DOCS, documentLabels: accounts.DOC_LABEL,
    maxUploadMb: Math.round(config.maxUploadBytes() / 1048576),
    supportPhone: process.env.SUPPORT_PHONE || '', supportEmail: process.env.SUPPORT_EMAIL || '',
    paymentMock: process.env.PAYMENT_MOCK === 'true' || !process.env.RAZORPAY_KEY_ID,
  });
});

router.get('/geo/states', h(async function (req, res) { res.json({ states: await accounts.listStates() }); }));
router.get('/geo/districts', h(async function (req, res) { res.json({ districts: await accounts.listDistricts(req.query.state_id) }); }));

router.post('/auth/register/:type', registerLimit, uploads.documentUpload, h(async function (req, res) {
  const result = await accounts.register(req.params.type, req.body, req.files, { ip: clientIp(req) });
  const user = await db.queryOne('SELECT id, account_id, role, token_version, name, email FROM b2b_users WHERE id = ?', [result.userId]);
  res.status(201).json({
    ok: true, accountId: result.accountId, accountStatus: 'pending',
    message: 'Registration received. Your account will be activated once our team has verified your details.',
    token: security.signToken({ uid: Number(user.id), aid: Number(user.account_id), role: user.role, tv: Number(user.token_version) }),
    user: { id: Number(user.id), name: user.name, email: user.email, role: user.role },
  });
}));

router.post('/auth/login', loginLimit, h(async function (req, res) {
  const b = req.body || {};
  res.json(await accounts.login(b.identifier || b.email || b.mobile, b.password, b.role, clientIp(req)));
}));

/* ═════════════ Signed-in (any status) ═════════════ */

router.use(requireBusiness);

function publicAccount(a) {
  return {
    id: a.id, account_type: a.account_type, status: a.status, business_name: a.business_name, shop_name: a.shop_name, contact_person: a.contact_person,
    mobile: a.mobile, email: a.email, gstin: a.gstin, pan: a.pan, business_type: a.business_type, address_line1: a.address_line1, address_line2: a.address_line2,
    landmark: a.landmark, city: a.city, district_name: a.district_name, state_name: a.state_name, state_id: a.state_id, pincode: a.pincode,
    latitude: a.latitude, longitude: a.longitude, created_at: a.created_at, approved_at: a.approved_at,
  };
}

router.get('/me', h(async function (req, res) {
  const a = req.b2b.account;
  const unread = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_notifications WHERE account_id = ? AND is_read = 0', [a.id]);
  const out = { user: req.b2b.user, account: publicAccount(a), unreadNotifications: Number(unread.n) };
  if (a.status !== 'approved') {
    const last = await db.queryOne("SELECT reason, to_status, created_at FROM b2b_account_status_history WHERE account_id = ? ORDER BY id DESC LIMIT 1", [a.id]);
    out.statusReason = last && ['rejected', 'suspended'].indexOf(last.to_status) !== -1 ? last.reason : null;
  }
  res.json(out);
}));

router.patch('/me/profile', writeLimit, h(async function (req, res) {
  res.json(await accounts.selfUpdate(req.b2b.account, req.body || {}, audit.businessActor(req)));
}));

router.post('/me/password', writeLimit, h(async function (req, res) {
  const token = await accounts.changePassword(req.b2b.user.id, (req.body || {}).current_password, (req.body || {}).new_password);
  audit.logSoft(audit.businessActor(req), 'auth.password_changed', 'account', req.b2b.account.id, null, null);
  // N5 security event: told by email; a failure to queue must not undo the password change
  require('../notifications/service.js').notifyAccount(null, req.b2b.account.id, { event: 'security.password_changed', channels: ['email'], title: 'Your password was changed',
    lines: ['The password for your business portal login was changed just now. Other devices have been signed out.', 'If this was not you, contact us straight away.'],
    link: '/b2b/login', refType: 'account', refId: req.b2b.account.id }).catch(function (e) { console.error('[B2B] password notice not queued:', e.code || e.message); });
  res.json({ ok: true, token: token });
}));

// Promotional messages: the business decides for itself, per channel (D4). Recorded with the
// address it applies to; order, payment and account messages are not affected.
const PORTAL_CHANNELS = ['email', 'whatsapp'];
function consentStore() { return require('../../erp/notifications/consent.js'); }
async function myCommunication(a) {
  const c = consentStore(), out = {};
  for (const ch of PORTAL_CHANNELS) {
    const address = ch === 'email' ? a.email : a.mobile;
    const p = await c.prefsOf(null, ch, c.hash(ch, address));
    out[ch] = { hasAddress: !!c.normalize(ch, address), offers: p.promotional === 'opted_in' && p.all !== 'opted_out', stoppedAll: p.all === 'opted_out' };
  }
  return out;
}
router.get('/me/communication', h(async function (req, res) {
  try { res.json({ available: true, channels: await myCommunication(req.b2b.account) }); }
  catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ available: false }); throw e; }
}));
router.put('/me/communication', writeLimit, h(async function (req, res) {
  const a = req.b2b.account, b = req.body || {};
  const c = consentStore(), actor = audit.businessActor(req);
  for (const ch of PORTAL_CHANNELS) {
    if (typeof b[ch] !== 'boolean') continue;
    const address = ch === 'email' ? a.email : a.mobile;
    if (!c.normalize(ch, address)) throw bad('No ' + (ch === 'email' ? 'email address' : 'mobile number') + ' on file for ' + ch);
    await c.record(null, actor, { channel: ch, address: address, recipient: { type: a.account_type, ref: a.id }, scope: 'promotional', state: b[ch] ? 'opted_in' : 'opted_out', source: 'portal',
      note: b[ch] ? 'Turned on in the business portal by ' + req.b2b.user.email : 'Turned off in the business portal' });
  }
  res.json({ available: true, channels: await myCommunication(a) });
}));

router.get('/me/documents', h(async function (req, res) { res.json({ documents: await accounts.documentsFor(req.b2b.account.id), labels: accounts.DOC_LABEL }); }));

router.post('/me/documents', writeLimit, uploads.documentUpload, h(async function (req, res) {
  const field = uploads.DOC_FIELDS.find(function (f) { return req.files && req.files[f] && req.files[f][0]; });
  if (!field) throw bad('Choose a file to upload');
  res.status(201).json(await accounts.addDocument(req.b2b.account.id, field, req.files[field][0], req.b2b.user.email));
}));

router.get('/me/documents/:id/file', h(async function (req, res) {
  const f = await accounts.documentFile(id(req), req.b2b.account.id);     // scoped: only this account's own documents
  await f.send(res, { 'Content-Type': f.doc.mime_type, 'Content-Disposition': 'inline; filename="document-' + f.doc.id + '.' + f.doc.stored_name.split('.').pop() + '"',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
}));

router.get('/notifications', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const rows = await db.query('SELECT id, title, body, link, is_read, created_at FROM b2b_notifications WHERE account_id = ? ORDER BY id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, [req.b2b.account.id]);
  res.json({ items: rows });
}));

router.post('/notifications/read', h(async function (req, res) {
  await db.query('UPDATE b2b_notifications SET is_read = 1 WHERE account_id = ? AND is_read = 0', [req.b2b.account.id]);
  res.json({ ok: true });
}));

/* ═════════════ Approved accounts only ═════════════ */

router.use(requireApproved);

const me = function (req) { return req.b2b.account; };
const asBuyer = function (req) { return { buyerAccountId: req.b2b.account.id }; };
const asSeller = function (req) { return { sellerAccountId: req.b2b.account.id }; };

router.get('/dashboard', h(async function (req, res) {
  const a = me(req);
  const out = a.account_type === 'distributor' ? await reports.distributorDashboard(a.id) : await reports.retailerDashboard(a.id);
  const seller = await orders.sellerFor(a);
  out.credit = await payments.getCredit(a.id, seller.accountId || 0);
  if (a.account_type === 'retailer') {
    const m = await mappings.currentMapping(a.id);
    out.distributor = m && m.status === 'active' ? { name: m.distributor_name, contact_person: m.distributor_contact, mobile: m.distributor_mobile, city: m.distributor_city } : null;
  }
  res.json(out);
}));

/* ─── Retailer: my distributor ─── */
router.get('/my-distributor', requireType('retailer'), h(async function (req, res) {
  const m = await mappings.currentMapping(me(req).id);
  if (!m || m.status !== 'active') return res.json({ distributor: null, message: 'No distributor is assigned to you yet. Your orders are supplied directly by ' + (process.env.BRAND_NAME || 'Sake of Health') + '.' });
  const areas = await mappings.listServiceAreas(m.distributor_id);
  res.json({
    distributor: {
      name: m.distributor_name, contact_person: m.distributor_contact, phone: m.distributor_mobile, email: m.distributor_email,
      address: [m.address_line1, m.address_line2, m.distributor_city, m.distributor_district, m.distributor_pincode].filter(Boolean).join(', '),
      service_area: areas.filter(function (x) { return Number(x.is_active); }).slice(0, 40).map(function (x) {
        if (x.area_type === 'pincode') return x.pincode_from;
        if (x.area_type === 'pincode_range') return x.pincode_from + '–' + x.pincode_to;
        if (x.area_type === 'city') return x.city;
        if (x.area_type === 'district') return x.district_name + ' district';
        return x.state_name;
      }),
      since: m.started_at,
    },
    credit: await payments.getCredit(me(req).id, m.distributor_id),
  });
}));

/* ─── Catalogue ─── */
router.get('/categories', h(async function (req, res) { res.json({ categories: await catalogue.listCategories(true) }); }));

router.get('/products', h(async function (req, res) {
  const pg = paging(req.query, 24, 60);
  const seller = await orders.sellerFor(me(req));
  const r = await catalogue.portalList(me(req), seller.accountId, {
    q: req.query.q, category_id: req.query.category_id, favorites: req.query.favorites === '1', frequent: req.query.frequent === '1', sort: req.query.sort }, pg);
  res.json(paged(r.rows, r.total, pg));
}));

router.put('/favorites/:productId', writeLimit, h(async function (req, res) { res.json(await catalogue.setFavorite(me(req).id, id(req, 'productId'), true)); }));
router.delete('/favorites/:productId', writeLimit, h(async function (req, res) { res.json(await catalogue.setFavorite(me(req).id, id(req, 'productId'), false)); }));

/* ─── Cart ─── */
router.get('/cart', h(async function (req, res) { res.json(await orders.getCart(me(req))); }));
router.put('/cart/items/:productId', writeLimit, h(async function (req, res) {
  await orders.setCartItem(me(req), id(req, 'productId'), (req.body || {}).qty);
  res.json(await orders.getCart(me(req)));
}));
router.post('/cart/bulk', writeLimit, h(async function (req, res) {
  const r = await orders.addManyToCart(me(req), (req.body || {}).lines, !!(req.body || {}).replace);
  res.json(Object.assign(r, { cart: await orders.getCart(me(req)) }));
}));
router.delete('/cart', writeLimit, h(async function (req, res) { res.json(await orders.clearCart(me(req).id)); }));

/* ─── Orders (as buyer) ─── */
router.post('/orders', orderLimit, h(async function (req, res) {
  const b = req.body || {};
  const r = await orders.placeOrder(req.b2b, { idempotencyKey: req.headers['idempotency-key'] || b.idempotencyKey, payment_method: b.payment_method, notes: b.notes }, audit.businessActor(req));
  res.status(r.duplicate ? 200 : 201).json({ ok: true, duplicate: r.duplicate, order: r.order });
}));

router.get('/orders', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await orders.list(asBuyer(req), { status: req.query.status, q: req.query.q, from: v.date(req.query.from), to: v.date(req.query.to), payment_status: req.query.payment_status }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/orders/:id', h(async function (req, res) { res.json(await orders.get(id(req), asBuyer(req))); }));
router.post('/orders/:id/cancel', writeLimit, h(async function (req, res) {
  res.json(await orders.transition(id(req), 'cancelled', asBuyer(req), audit.businessActor(req), { note: (req.body || {}).reason }));
}));
router.post('/orders/:id/reorder', writeLimit, h(async function (req, res) {
  const r = await orders.reorder(me(req), id(req));
  res.json(Object.assign(r, { cart: await orders.getCart(me(req)) }));
}));
router.post('/orders/:id/pay/initiate', writeLimit, h(async function (req, res) { res.json(await payments.gatewayInitiate(id(req), me(req).id)); }));
router.post('/orders/:id/pay/confirm', writeLimit, h(async function (req, res) {
  const b = req.body || {};
  res.json(await payments.gatewayConfirm({ buyerAccountId: me(req).id, gateway: b.gateway, gatewayOrderId: b.gatewayOrderId, gatewayPaymentId: b.paymentId, signature: b.signature }));
}));
router.post('/orders/:id/returns', writeLimit, h(async function (req, res) {
  res.status(201).json(await returns.create(me(req), id(req), req.body || {}, audit.businessActor(req)));
}));

/* ─── Invoices, payments, credit, returns (as buyer) ─── */
router.get('/invoices', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await invoices.list(asBuyer(req), { q: req.query.q, payment: req.query.payment, from: v.date(req.query.from), to: v.date(req.query.to) }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/invoices/:id', h(async function (req, res) { res.json(await invoices.get(id(req), asBuyer(req))); }));
router.get('/payments', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await payments.listPayments(asBuyer(req), { from: v.date(req.query.from), to: v.date(req.query.to) }, pg);
  res.json(paged(r.rows.map(function (p) { delete p.recorded_by; return p; }), r.total, pg));
}));
router.get('/credit', h(async function (req, res) {
  const seller = await orders.sellerFor(me(req));
  const pg = paging(req.query, 20, 50);
  res.json({ credit: await payments.getCredit(me(req).id, seller.accountId || 0), outstanding: await payments.outstandingTotal(asBuyer(req)),
    history: await payments.creditHistory(me(req).id, seller.accountId || 0, pg) });
}));
router.get('/returns', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await returns.list(asBuyer(req), { status: req.query.status }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
router.get('/returns/:id', h(async function (req, res) { res.json(await returns.get(id(req), asBuyer(req))); }));
router.post('/returns/:id/cancel', writeLimit, h(async function (req, res) { res.json(await returns.act(id(req), 'cancel', req.body, asBuyer(req), audit.businessActor(req))); }));

/* ─── Print (bill / delivery label data) ─── */
const idsOf = function (req) { return String(req.query.ids || '').split(',').map(Number); };
router.get('/print', h(async function (req, res) { res.json(await orders.printData(idsOf(req), asBuyer(req))); }));

/* ═════════════ Distributor area ═════════════ */

const dist = express.Router();
dist.use(requireType('distributor'));

async function assertMyRetailer(req, retailerId) {
  const m = await db.queryOne('SELECT id FROM b2b_retailer_distributor_map WHERE current_retailer_id = ? AND distributor_id = ?', [retailerId, me(req).id]);
  if (!m) throw notFound('Retailer not found');
}

dist.get('/retailers', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const where = ['m.distributor_id = ?', 'm.current_retailer_id IS NOT NULL'], params = [me(req).id];
  if (req.query.q) {
    const t = v.text(req.query.q, 80);
    where.push('(a.business_name LIKE ? OR a.shop_name LIKE ? OR a.mobile LIKE ? OR a.pincode = ?)');
    params.push('%' + t.replace(/[\\%_]/g, '\\$&') + '%', '%' + t.replace(/[\\%_]/g, '\\$&') + '%', t.replace(/[\\%_]/g, '\\$&') + '%', t);
  }
  const sql = ' FROM b2b_retailer_distributor_map m JOIN b2b_accounts a ON a.id = m.retailer_id WHERE ' + where.join(' AND ');
  const total = await db.queryOne('SELECT COUNT(*) AS n' + sql, params);
  const rows = await db.query(
    'SELECT a.id, a.business_name AS retailer, a.shop_name AS shop, a.contact_person, a.mobile AS phone, a.city, a.district_name, a.pincode, a.address_line1, a.latitude, a.longitude, ' +
    'm.status AS mapping_status, m.started_at, ' +
    "(SELECT COUNT(*) FROM b2b_orders o WHERE o.buyer_account_id = a.id AND o.seller_account_id = m.distributor_id AND o.status NOT IN ('cancelled','rejected')) AS orders, " +
    "(SELECT COALESCE(SUM(o.grand_total - o.amount_paid), 0) FROM b2b_orders o WHERE o.buyer_account_id = a.id AND o.seller_account_id = m.distributor_id AND o.status NOT IN ('cancelled','rejected','refunded') AND o.payment_status IN ('pending','partial')) AS outstanding, " +
    '(SELECT MAX(o.created_at) FROM b2b_orders o WHERE o.buyer_account_id = a.id AND o.seller_account_id = m.distributor_id) AS last_order ' + sql +
    ' ORDER BY a.business_name LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  res.json(paged(rows, total.n, pg));
}));

dist.get('/retailers/:id', h(async function (req, res) {
  const rid = id(req);
  await assertMyRetailer(req, rid);
  const a = await accounts.getAccount(rid);
  res.json({ retailer: accounts.contactCard(a), credit: await payments.getCredit(rid, me(req).id) });
}));

dist.put('/retailers/:id/credit', writeLimit, h(async function (req, res) {
  const rid = id(req);
  await assertMyRetailer(req, rid);
  res.json(await payments.setCreditTerms(rid, me(req).id, req.body || {}, audit.businessActor(req), me(req).id));
}));

dist.get('/retailer-orders', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await orders.list(asSeller(req), { status: req.query.status, q: req.query.q, from: v.date(req.query.from), to: v.date(req.query.to), buyer_id: req.query.retailer_id, payment_status: req.query.payment_status }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
dist.get('/retailer-orders/:id', h(async function (req, res) { res.json(await orders.get(id(req), asSeller(req))); }));
dist.post('/retailer-orders/:id/status', writeLimit, h(async function (req, res) {
  const b = req.body || {};
  res.json(await orders.transition(id(req), String(b.status || ''), asSeller(req), audit.businessActor(req), { note: b.note, delivered: b.delivered, condition: b.condition }));
}));

// Delivery details and challans (the delivery module, migration 020). Before 020 is applied: 503.
const delivery = function () { return require('../../erp/delivery/service.js'); };
function deliveryReady(e) {
  if (e && e.code === 'ER_NO_SUCH_TABLE') return Object.assign(new Error('Delivery details are not available yet'), { status: 503, expose: true });
  return e;
}
function challanOut(res, html) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
  res.type('html').send(html);
}
/** The distributor records how its order travels (vehicle, driver, courier, tracking, e-way bill, expected time). */
dist.post('/retailer-orders/:id/shipment', writeLimit, h(async function (req, res) {
  const actor = audit.businessActor(req), sc = { sellerAccountId: req.b2b.account.id };
  const b = Object.assign({}, req.body || {});
  delete b.deliveryStaffId;
  try {
    const ex = await db.queryOne('SELECT id FROM b2b_shipments WHERE order_id = ?', [id(req)]);
    if (ex) return res.json(await db.transaction(function (t) { return delivery().update(t, actor, sc, Number(ex.id), b); }));
    b.orderId = id(req);
    res.status(201).json(await db.transaction(function (t) { return delivery().create(t, actor, sc, b); }));
  } catch (e) { throw deliveryReady(e); }
}));
dist.get('/retailer-orders/:id/challan', h(async function (req, res) {
  try { challanOut(res, await delivery().challan({ sellerAccountId: req.b2b.account.id }, { orderId: id(req) })); } catch (e) { throw deliveryReady(e); }
}));
router.get('/orders/:id/challan', h(async function (req, res) {
  try { challanOut(res, await delivery().challan({ buyerAccountId: req.b2b.account.id }, { orderId: id(req) })); } catch (e) { throw deliveryReady(e); }
}));
dist.post('/retailer-orders/:id/payments', writeLimit, h(async function (req, res) {
  res.status(201).json(await payments.recordManual(id(req), req.body || {}, audit.businessActor(req), asSeller(req)));
}));
dist.get('/retailer-invoices', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await invoices.list(asSeller(req), { q: req.query.q, payment: req.query.payment, from: v.date(req.query.from), to: v.date(req.query.to) }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
dist.get('/retailer-invoices/:id', h(async function (req, res) { res.json(await invoices.get(id(req), asSeller(req))); }));
dist.get('/retailer-payments', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await payments.listPayments(asSeller(req), { from: v.date(req.query.from), to: v.date(req.query.to), q: req.query.q }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
dist.get('/receivables', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await payments.listOutstanding(asSeller(req), { q: req.query.q }, pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { amount: r.amount }));
}));
dist.get('/retailer-returns', h(async function (req, res) {
  const pg = paging(req.query, 20, 50);
  const r = await returns.list(asSeller(req), { status: req.query.status, open: req.query.open === '1' }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
dist.get('/retailer-returns/:id', h(async function (req, res) { res.json(await returns.get(id(req), asSeller(req))); }));
dist.post('/retailer-returns/:id/:action', writeLimit, h(async function (req, res) {
  const a = req.params.action;
  if (a === 'inspect') return res.json(await returns.inspect(id(req), req.body || {}, asSeller(req), audit.businessActor(req)));
  if (a === 'complete') return res.json(await returns.complete(id(req), req.body || {}, asSeller(req), audit.businessActor(req)));
  res.json(await returns.act(id(req), a, req.body, asSeller(req), audit.businessActor(req)));
}));

dist.get('/retailer-orders-print', h(async function (req, res) { res.json(await orders.printData(idsOf(req), asSeller(req))); }));

/* Distributor's own stock point */
dist.get('/stock', h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await inventory.listStock({ owner_account_id: me(req).id, q: req.query.q, low: req.query.low === '1', out: req.query.out === '1' }, pg);
  res.json(Object.assign(paged(r.rows, r.total, pg), { warehouses: await inventory.distributorWarehouses(me(req).id) }));
}));
dist.get('/stock/movements', h(async function (req, res) {
  const pg = paging(req.query, 25, 100);
  const r = await inventory.listMovements({ owner_account_id: me(req).id, q: req.query.q, product_id: req.query.product_id }, pg);
  res.json(paged(r.rows, r.total, pg));
}));
dist.post('/stock/entry', writeLimit, h(async function (req, res) {
  const b = req.body || {};
  if (['opening', 'adjust_increase', 'adjust_decrease', 'damage', 'expiry'].indexOf(b.operation) === -1) throw bad('Unknown stock operation');
  const whs = await inventory.distributorWarehouses(me(req).id);
  if (!whs.length) throw bad('No stock point is set up for your account yet');
  res.json(await inventory.manualEntry(Object.assign({}, b, { warehouse_id: whs[0].id }), audit.businessActor(req), me(req).id));
}));
dist.get('/service-areas', h(async function (req, res) { res.json({ areas: await mappings.listServiceAreas(me(req).id) }); }));

router.use(dist);

module.exports = router;
