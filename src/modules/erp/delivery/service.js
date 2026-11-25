/**
 * Delivery of trade orders (migration 020): one shipment per order.
 *
 * A shipment carries how the goods travel (own vehicle with a driver or one of our delivery staff,
 * a courier or transporter with its tracking / LR number, or pickup), the e-way bill, the expected
 * delivery time, a tracking timeline, failed attempts, and the proof of delivery (who received it,
 * their phone, a photo or signed copy, where).
 *
 * It does not keep its own stock or order status: every step calls the EXISTING order transition
 * (orders.transition), which moves the stock (allocated → in transit → delivered / back), raises the
 * invoice and credit note, and notifies the buyer. The shipment follows the order; an order moved
 * elsewhere (the trade-orders page, the distributor's portal) is mirrored by the after-transition hook
 * and by the catch-up job, so the two never disagree for long.
 *
 * The delivery challan is issued at dispatch: an immutable snapshot of what left, by product and
 * batch, with its value (for transport and the e-way bill). It is never edited.
 */
'use strict';
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const settings = require('../core/settings.js');
const seq = require('../lib/seq.js');
const v = require('../../b2b/lib/validate.js');
const uploads = require('../../b2b/lib/uploads.js');
const { fail, posId } = require('../lib/http.js');

const MODES = ['own_vehicle', 'courier', 'transporter', 'pickup'];
const MOVING = ['dispatched', 'out_for_delivery', 'attempt_failed'];
const FINAL = ['delivered', 'partially_delivered', 'returned', 'cancelled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_SCOPE = { admin: true, permissions: ['b2b.orders.fulfil'] };

function need(c, m, code) { if (!c) throw fail(400, m, code); }
function orders() { return require('../../b2b/orders/service.js'); }
function notif() { return require('../../b2b/notifications/service.js'); }
function whoOf(actor) {
  if (actor && actor.type === 'business') return { type: 'business', id: actor.id || null, label: actor.label || 'business' };
  if (actor && actor.type === 'system') return { type: 'system', id: null, label: 'system' };
  return { type: 'staff', id: actor && actor.id || null, label: actor && (actor.label || (actor.id ? 'erp-staff:' + actor.id : null)) || 'staff' };
}
function sqlTime(x) {
  if (x == null || x === '') return null;
  const t = Date.parse(x);
  need(Number.isFinite(t), 'Invalid date and time');
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}
function coord(lat, lng) {
  if (lat == null || lat === '' || lng == null || lng === '') return [null, null];
  const a = Number(lat), o = Number(lng);
  need(a >= -90 && a <= 90 && o >= -180 && o <= 180 && !(a === 0 && o === 0), 'Invalid location');
  return [a.toFixed(7), o.toFixed(7)];
}

/** Vehicle numbers: KA01AB1234, KA51C1234, DL1CAB1234, and the BH series 22BH1234AB. */
function vehicleNo(x) {
  if (x == null || x === '') return null;
  const s = String(x).toUpperCase().replace(/[\s-]/g, '');
  need(/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(s) || /^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$/.test(s), 'Vehicle number looks wrong (e.g. KA01AB1234)');
  return s;
}

function clean(b, partial) {
  const o = {};
  if (!partial || b.mode !== undefined) { need(MODES.indexOf(b.mode) !== -1, 'mode must be one of ' + MODES.join(', ')); o.mode = b.mode; }
  if (!partial || b.carrier !== undefined) o.carrier = v.text(b.carrier, 120) || null;
  if (!partial || b.vehicleNo !== undefined) o.vehicle_no = vehicleNo(b.vehicleNo);
  if (!partial || b.driverName !== undefined) o.driver_name = v.text(b.driverName, 120) || null;
  if (!partial || b.driverPhone !== undefined) {
    const p = b.driverPhone ? String(b.driverPhone).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '') : null;
    if (p) need(v.isMobile(p), 'Driver phone must be a 10-digit Indian mobile number');
    o.driver_phone = p || null;
  }
  if (!partial || b.trackingNo !== undefined) o.tracking_no = v.text(b.trackingNo, 60) || null;
  if (!partial || b.lrNo !== undefined) o.lr_no = v.text(b.lrNo, 60) || null;
  if (!partial || b.ewayBillNo !== undefined) {
    const e = b.ewayBillNo ? String(b.ewayBillNo).replace(/\s/g, '') : null;
    if (e) need(/^\d{12}$/.test(e), 'An e-way bill number has 12 digits');
    o.eway_bill_no = e || null;
  }
  if (!partial || b.packages !== undefined) {
    const n = b.packages == null || b.packages === '' ? null : Number(b.packages);
    if (n != null) need(Number.isInteger(n) && n > 0 && n < 10000, 'Packages must be a whole number');
    o.packages = n;
  }
  if (!partial || b.weightKg !== undefined) {
    const w = b.weightKg == null || b.weightKg === '' ? null : Number(b.weightKg);
    if (w != null) need(w > 0 && w < 100000, 'Weight must be in kg');
    o.weight_kg = w == null ? null : w.toFixed(2);
  }
  if (!partial || b.expectedAt !== undefined) o.expected_at = sqlTime(b.expectedAt);
  return o;
}

async function assertDeliveryStaff(q, staffId) {
  const r = await q.queryOne("SELECT s.id FROM b2b_staff s JOIN b2b_staff_roles sr ON sr.staff_id = s.id AND sr.revoked_at IS NULL JOIN b2b_roles r ON r.id = sr.role_id AND r.is_active = 1 " +
    "JOIN b2b_role_permissions rp ON rp.role_id = r.id AND rp.permission_code = 'deliveries.update' WHERE s.id = ? AND s.status = 'active' LIMIT 1", [staffId]);
  need(r, 'That person cannot make deliveries (they need the Delivery Staff role or deliveries.update)', 'not_delivery_staff');
}

/** Is the shipment ready to leave? Returns the list of problems (empty = ready). */
function readiness(s) {
  const p = [];
  if (s.mode === 'courier' || s.mode === 'transporter') {
    if (!s.carrier) p.push('the ' + (s.mode === 'courier' ? 'courier' : 'transporter') + ' name');
    if (!s.tracking_no && !s.lr_no) p.push('the tracking or LR number');
  }
  if (s.mode === 'own_vehicle') {
    if (!s.vehicle_no) p.push('the vehicle number');
    if (!s.driver_name && !s.delivery_staff_id) p.push('the driver or a delivery staff member');
  }
  return p;
}

async function lockShipment(tx, id) {
  const s = await tx.queryOne('SELECT * FROM b2b_shipments WHERE id = ? FOR UPDATE', [id]);
  if (!s) throw fail(404, 'Shipment not found');
  return s;
}

/** Who may see / act on a shipment. by = { staff: principal } | { sellerAccountId }. */
function canSee(s, by) {
  if (by.sellerAccountId != null) return s.seller_type === 'distributor' && Number(s.seller_account_id) === Number(by.sellerAccountId);
  const p = by.staff;
  if (!p) return false;
  if (p.permissions.has('deliveries.view') || p.permissions.has('deliveries.manage')) return true;
  return p.permissions.has('deliveries.update') && Number(s.delivery_staff_id) === Number(p.id);
}
function canManage(by) { return by.sellerAccountId != null || (by.staff && by.staff.permissions.has('deliveries.manage')); }
/**
 * The trade order history records who changed an order as admin, business or system. An ERP staff member is
 * recorded as admin, with their e-mail as the label (the ERP's own 'staff' type does not fit that column).
 * viaShipment tells the after-transition hook that this shipment already records the step itself.
 */
function orderActor(actor) { const t = actor && actor.type; return Object.assign({}, actor, { type: t === 'business' || t === 'system' ? t : 'admin', viaShipment: true }); }
function orderScope(by) { return by.sellerAccountId != null ? { sellerAccountId: by.sellerAccountId } : ADMIN_SCOPE; }

async function addEvent(tx, shipmentId, kind, actor, f) {
  f = f || {};
  const who = whoOf(actor);
  const ll = coord(f.lat, f.lng);
  try {
    await tx.query('INSERT INTO b2b_shipment_events (shipment_id, kind, note, place, lat, lng, actor_type, actor_id, actor_label, client_uuid) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [shipmentId, kind, f.note ? String(f.note).slice(0, 500) : null, f.place ? v.text(f.place, 160) : null, ll[0], ll[1], who.type, who.id, (who.label || '').slice(0, 160) || null, f.clientUuid || null]);
    return true;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' && f.clientUuid) return false;   // the same offline update, sent again
    throw e;
  }
}

// ─────────────────────────── create / change ───────────────────────────

/**
 * Create the shipment of an order. The order must be packed (or already on its way: then the shipment
 * records how it travels and its challan is issued now). by: { staff } or { sellerAccountId } (distributor).
 */
async function create(tx, actor, by, b) {
  need(canManage(by), 'You cannot create shipments');
  const orderId = posId(b.orderId); need(orderId, 'Choose the order');
  const o = await tx.queryOne('SELECT * FROM b2b_orders WHERE id = ? FOR UPDATE', [orderId]);
  if (!o || (by.sellerAccountId != null && !(o.seller_type === 'distributor' && Number(o.seller_account_id) === Number(by.sellerAccountId)))) throw fail(404, 'Order not found');
  need(['packed', 'dispatched', 'out_for_delivery'].indexOf(o.status) !== -1, 'A shipment is created once the order is packed (this order is ' + o.status + ')', 'order_not_packed');
  const ex = await tx.queryOne('SELECT id FROM b2b_shipments WHERE order_id = ?', [orderId]);
  if (ex) throw fail(409, 'This order already has a shipment', 'shipment_exists', { shipmentId: Number(ex.id) });
  const c = clean(b, false);
  let staffId = null;
  if (b.deliveryStaffId) {
    need(by.staff, 'Only our own staff can be assigned');
    staffId = posId(b.deliveryStaffId); need(staffId, 'Unknown delivery staff');
    await assertDeliveryStaff(tx, staffId);
  }
  const status = o.status === 'packed' ? 'ready' : o.status;
  const no = await seq.next(tx, 'SHP');
  const who = whoOf(actor);
  const r = await tx.query('INSERT INTO b2b_shipments (shipment_no, order_id, seller_type, seller_account_id, warehouse_id, mode, carrier, vehicle_no, driver_name, driver_phone, delivery_staff_id, tracking_no, lr_no, eway_bill_no, packages, weight_kg, status, expected_at, dispatched_at, out_at, created_by_type, created_by_id) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [no, orderId, o.seller_type, o.seller_account_id || null, o.warehouse_id || null, c.mode, c.carrier, c.vehicle_no, c.driver_name, c.driver_phone, staffId, c.tracking_no, c.lr_no, c.eway_bill_no, c.packages, c.weight_kg,
      status, c.expected_at, o.dispatched_at || null, o.out_for_delivery_at || null, who.type === 'system' ? 'system' : who.type, who.id]);
  const id = Number(r.insertId);
  await addEvent(tx, id, 'created', actor, { note: 'Shipment ' + no + ' (' + c.mode.replace('_', ' ') + ')' });
  if (status !== 'ready') await issueChallan(tx, id, actor);
  await audit.write(tx, actor, { module: 'delivery', action: 'shipment.created', entity: 'shipment', entityId: id, new: { orderId: orderId, shipmentNo: no, mode: c.mode, status: status } });
  return { id: id, shipmentNo: no, status: status };
}

async function update(tx, actor, by, id, b) {
  const s = await lockShipment(tx, id);
  if (!canSee(s, by) || !canManage(by)) throw fail(404, 'Shipment not found');
  need(FINAL.indexOf(s.status) === -1, 'This shipment is ' + s.status + ' and can no longer change');
  const c = clean(b, true);
  if (b.deliveryStaffId !== undefined) {
    need(by.staff, 'Only our own staff can be assigned');
    const sid = b.deliveryStaffId ? posId(b.deliveryStaffId) : null;
    if (sid) await assertDeliveryStaff(tx, sid);
    c.delivery_staff_id = sid;
  }
  const keys = Object.keys(c).filter(function (k) { return String(c[k] == null ? '' : c[k]) !== String(s[k] == null ? '' : (s[k] instanceof Date ? s[k].toISOString().slice(0, 19).replace('T', ' ') : s[k])); });
  if (!keys.length) return { id: Number(id), unchanged: true };
  await tx.query('UPDATE b2b_shipments SET ' + keys.map(function (k) { return k + ' = ?'; }).join(', ') + ' WHERE id = ?', keys.map(function (k) { return c[k]; }).concat([id]));
  const old = {}; keys.forEach(function (k) { old[k] = s[k]; });
  await addEvent(tx, id, 'details_changed', actor, { note: keys.join(', ') });
  await audit.write(tx, actor, { module: 'delivery', action: 'shipment.updated', entity: 'shipment', entityId: id, old: old, new: c });
  return { id: Number(id), changed: keys };
}

// ─────────────────────────── the challan ───────────────────────────

/** Issue the challan once (no-op when it exists). Snapshot of what left: product, batch, expiry, qty, value. */
async function issueChallan(tx, shipmentId, actor) {
  const ex = await tx.queryOne('SELECT id, challan_no FROM b2b_delivery_challans WHERE shipment_id = ?', [shipmentId]);
  if (ex) return { challanNo: ex.challan_no, existing: true };
  const s = await tx.queryOne('SELECT * FROM b2b_shipments WHERE id = ?', [shipmentId]);
  const items = await tx.query('SELECT i.id, i.product_id, i.sku, i.name, i.hsn_code, i.qty, i.unit_price, i.gst_rate, i.line_total FROM b2b_order_items i WHERE i.order_id = ? ORDER BY i.id', [s.order_id]);
  const allocs = await tx.query('SELECT a.order_item_id, a.qty, b.batch_no, b.mfg_date, b.expiry_date FROM b2b_order_item_allocations a LEFT JOIN b2b_batches b ON b.id = a.batch_id WHERE a.order_id = ? ORDER BY a.id', [s.order_id]);
  let value = 0;
  const lines = items.map(function (it) {
    const parts = allocs.filter(function (a) { return Number(a.order_item_id) === Number(it.id); });
    value += Number(it.line_total);
    return { sku: it.sku, name: it.name, hsn: it.hsn_code, qty: Number(it.qty), unitPrice: Number(it.unit_price), gstRate: Number(it.gst_rate), value: Number(it.line_total),
      batches: parts.length ? parts.map(function (a) { return { batchNo: a.batch_no || null, mfg: a.mfg_date ? new Date(a.mfg_date).toISOString().slice(0, 10) : null, expiry: a.expiry_date ? new Date(a.expiry_date).toISOString().slice(0, 10) : null, qty: Number(a.qty) }; }) : [] };
  });
  const no = await seq.next(tx, 'DC');
  const who = whoOf(actor);
  await tx.query('INSERT INTO b2b_delivery_challans (challan_no, shipment_id, order_id, lines_json, value_total, issued_by_type, issued_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [no, shipmentId, s.order_id, JSON.stringify(lines), (Math.round(value * 100) / 100).toFixed(2), who.type, who.id]);
  return { challanNo: no };
}

// ─────────────────────────── moving the goods ───────────────────────────

async function step(by, id, fn) {
  const s = await db.queryOne('SELECT * FROM b2b_shipments WHERE id = ?', [id]);
  if (!s || !canSee(s, by)) throw fail(404, 'Shipment not found');
  return fn(s);
}

/** ready → dispatched: the order is dispatched (stock to in transit, invoice per settings), the challan issued. */
async function dispatch(actor, by, id, b) {
  b = b || {};
  return step(by, id, async function (s) {
    need(canManage(by), 'You cannot dispatch shipments');
    if (s.status !== 'ready') {
      if (MOVING.indexOf(s.status) !== -1) return { id: Number(id), status: s.status, unchanged: true };
      throw fail(409, 'This shipment is ' + s.status);
    }
    const missing = readiness(s);
    need(!missing.length, 'Before dispatch, add ' + missing.join(' and '), 'shipment_incomplete');
    const o = await db.queryOne('SELECT grand_total, status FROM b2b_orders WHERE id = ?', [s.order_id]);
    const warnings = [];
    if (!s.eway_bill_no && s.mode !== 'pickup') {
      const limit = await settings.get('delivery.eway_bill_required_above');
      if (limit != null && Number(o.grand_total) > Number(limit)) throw fail(400, 'This consignment is worth ₹' + Number(o.grand_total).toFixed(2) + ': add the e-way bill number before dispatch', 'eway_bill_required');
      if (limit == null && Number(o.grand_total) > 50000) warnings.push('Worth more than ₹50,000 and no e-way bill number recorded. Generate one on the e-way bill portal if the law requires it for this movement.');
    }
    let result = { status: o.status };
    if (o.status === 'packed') result = await orders().transition(s.order_id, 'dispatched', orderScope(by), orderActor(actor), { note: 'Shipment ' + s.shipment_no });
    return db.transaction(async function (tx) {
      const cur = await lockShipment(tx, id);
      if (cur.status === 'ready') {
        await tx.query("UPDATE b2b_shipments SET status = 'dispatched', dispatched_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
        await addEvent(tx, id, 'dispatched', actor, { note: [cur.carrier, cur.vehicle_no, cur.tracking_no || cur.lr_no].filter(Boolean).join(' · ') || null });
      }
      const ch = await issueChallan(tx, id, actor);
      await audit.write(tx, actor, { module: 'delivery', action: 'shipment.dispatched', entity: 'shipment', entityId: id, new: { orderId: Number(s.order_id), challanNo: ch.challanNo, warnings: warnings } });
      return { id: Number(id), status: 'dispatched', challanNo: ch.challanNo, invoiceNo: result.invoiceNo || null, warnings: warnings };
    });
  });
}

/** dispatched / attempt_failed → out_for_delivery (today's run). */
async function outForDelivery(actor, by, id, b) {
  b = b || {};
  return step(by, id, async function (s) {
    if (s.status === 'out_for_delivery') return { id: Number(id), status: s.status, unchanged: true };
    need(s.status === 'dispatched' || s.status === 'attempt_failed', 'The shipment must be dispatched first (it is ' + s.status + ')');
    const o = await db.queryOne('SELECT status FROM b2b_orders WHERE id = ?', [s.order_id]);
    if (o.status === 'dispatched') await orders().transition(s.order_id, 'out_for_delivery', orderScope(by), orderActor(actor), { note: 'Shipment ' + s.shipment_no + ' out for delivery' });
    return db.transaction(async function (tx) {
      await lockShipment(tx, id);
      const fresh = await addEvent(tx, id, 'out_for_delivery', actor, { place: b.place, lat: b.lat, lng: b.lng, clientUuid: UUID.test(b.clientUuid || '') ? b.clientUuid : null });
      await tx.query("UPDATE b2b_shipments SET status = 'out_for_delivery', out_at = COALESCE(out_at, UTC_TIMESTAMP()) WHERE id = ?", [id]);
      if (fresh) await audit.write(tx, actor, { module: 'delivery', action: 'shipment.out_for_delivery', entity: 'shipment', entityId: id });
      return { id: Number(id), status: 'out_for_delivery' };
    });
  });
}

/** A position or note on the way (the timeline the buyer sees). */
async function location(actor, by, id, b) {
  b = b || {};
  return step(by, id, async function (s) {
    need(MOVING.indexOf(s.status) !== -1, 'The shipment is not on its way');
    need(b.place || (b.lat != null && b.lng != null) || b.note, 'Give a place, a GPS position or a note');
    return db.transaction(async function (tx) {
      await lockShipment(tx, id);
      const fresh = await addEvent(tx, id, b.place || b.lat != null ? 'location' : 'note', actor, { place: b.place, lat: b.lat, lng: b.lng, note: v.text(b.note, 300), clientUuid: UUID.test(b.clientUuid || '') ? b.clientUuid : null });
      return { id: Number(id), recorded: fresh };
    });
  });
}

/** A delivery attempt that failed (shop closed, refused, wrong address). The buyer is told. */
async function attemptFailed(actor, by, id, b) {
  b = b || {};
  const reason = v.text(b.reason, 300);
  need(reason.length >= 3, 'Say why the delivery failed');
  return step(by, id, async function (s) {
    need(s.status === 'out_for_delivery' || s.status === 'dispatched', 'Only a shipment on its way can have a failed attempt (it is ' + s.status + ')');
    const max = await settings.get('delivery.max_attempts');
    return db.transaction(async function (tx) {
      const cur = await lockShipment(tx, id);
      const fresh = await addEvent(tx, id, 'attempt_failed', actor, { note: reason, place: b.place, lat: b.lat, lng: b.lng, clientUuid: UUID.test(b.clientUuid || '') ? b.clientUuid : null });
      if (!fresh) return { id: Number(id), status: cur.status, duplicate: true };
      const attempts = Number(cur.attempts) + 1;
      await tx.query("UPDATE b2b_shipments SET status = 'attempt_failed', attempts = ? WHERE id = ?", [attempts, id]);
      const o = await tx.queryOne('SELECT order_no, buyer_account_id FROM b2b_orders WHERE id = ?', [s.order_id]);
      const last = max != null && attempts >= Number(max);
      await notif().notifyAccount(tx, o.buyer_account_id, { event: 'delivery.attempt_failed', title: 'Delivery attempt failed for order ' + o.order_no,
        lines: ['Reason: ' + reason, last ? 'This was the last attempt; the goods will go back to the warehouse unless you contact us.' : 'We will try again. Contact us if you want to change the time or address.'],
        link: '/b2b/orders/' + s.order_id, refType: 'order', refId: s.order_id });
      await audit.write(tx, actor, { module: 'delivery', action: 'shipment.attempt_failed', entity: 'shipment', entityId: id, new: { attempts: attempts, reason: reason } });
      return { id: Number(id), status: 'attempt_failed', attempts: attempts, lastAttempt: last };
    });
  });
}

/**
 * Delivered, with proof. b = { receivedBy, receiverPhone?, note?, delivered?: { orderItemId: qty }, lat?, lng?, clientUuid? }
 * file (optional) = photo of the goods / signed challan (PDF, JPG, PNG, WEBP). Short quantities raise the
 * credit note in the order flow, exactly as before.
 */
async function deliver(actor, by, id, b, file) {
  b = b || {};
  const receivedBy = v.text(b.receivedBy, 120);
  need(receivedBy.length >= 2, 'Write who received the goods');
  const phone = b.receiverPhone ? String(b.receiverPhone).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '') : null;
  if (phone) need(v.isMobile(phone), 'Receiver phone must be a 10-digit mobile number');
  const ll = coord(b.lat, b.lng);
  return step(by, id, async function (s) {
    if (s.status === 'delivered' || s.status === 'partially_delivered') return { id: Number(id), status: s.status, unchanged: true };
    need(MOVING.indexOf(s.status) !== -1, 'The shipment must be on its way (it is ' + s.status + ')');
    const saved = file ? await uploads.saveDocument(file) : null;   // checked by content; stored before any transaction
    try {
      return await recordDelivery(s, saved);
    } catch (e) {
      if (saved) await uploads.removeDocument(saved.storedName);   // a retry uploads the photo again; no orphan file
      throw e;
    }
  });
  async function recordDelivery(s, saved) {
    const o = await db.queryOne('SELECT status FROM b2b_orders WHERE id = ?', [s.order_id]);
    let r = { status: o.status };
    if (o.status === 'dispatched' || o.status === 'out_for_delivery') {
      r = await orders().transition(s.order_id, 'delivered', orderScope(by), orderActor(actor), { note: 'Received by ' + receivedBy + (b.note ? ' · ' + v.text(b.note, 200) : ''), delivered: b.delivered || undefined });
    }
    const final = r.status === 'partially_delivered' ? 'partially_delivered' : 'delivered';
    return db.transaction(async function (tx) {
      await lockShipment(tx, id);
      await tx.query('UPDATE b2b_shipments SET status = ?, delivered_at = UTC_TIMESTAMP(), pod_received_by = ?, pod_phone = ?, pod_note = ?, pod_stored_name = ?, pod_mime = ?, pod_sha256 = ?, pod_lat = ?, pod_lng = ? WHERE id = ?',
        [final, receivedBy, phone, v.text(b.note, 300) || null, saved ? saved.storedName : null, saved ? saved.mime : null, saved ? saved.sha256 : null, ll[0], ll[1], id]);
      await addEvent(tx, id, final, actor, { note: 'Received by ' + receivedBy + (saved ? ' · proof attached' : ''), lat: b.lat, lng: b.lng, clientUuid: UUID.test(b.clientUuid || '') ? b.clientUuid : null });
      await audit.write(tx, actor, { module: 'delivery', action: 'shipment.' + final, entity: 'shipment', entityId: id, new: { receivedBy: receivedBy, proof: saved ? saved.sha256 : null, invoiceNo: r.invoiceNo || null } });
      return { id: Number(id), status: final, invoiceNo: r.invoiceNo || null, creditNote: r.creditNote || null };
    });
  }
}

/** Nothing could be delivered: the goods go back (good → available, damaged → damaged). The order becomes "returned". */
async function returnToWarehouse(actor, by, id, b) {
  b = b || {};
  const reason = v.text(b.reason, 300);
  need(reason.length >= 5, 'Say why the goods are coming back (at least 5 characters)');
  const condition = b.condition === 'damaged' ? 'damaged' : 'good';
  return step(by, id, async function (s) {
    need(canManage(by), 'Only the warehouse can take goods back');
    if (s.status === 'returned') return { id: Number(id), status: 'returned', unchanged: true };
    need(MOVING.indexOf(s.status) !== -1, 'Only a shipment on its way can come back (it is ' + s.status + ')');
    const o = await db.queryOne('SELECT status FROM b2b_orders WHERE id = ?', [s.order_id]);
    if (o.status === 'dispatched' || o.status === 'out_for_delivery') await orders().transition(s.order_id, 'returned', orderScope(by), orderActor(actor), { note: reason, condition: condition });
    return db.transaction(async function (tx) {
      await lockShipment(tx, id);
      await tx.query("UPDATE b2b_shipments SET status = 'returned', returned_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
      await addEvent(tx, id, 'returned', actor, { note: reason + ' (' + condition + ')' });
      await audit.write(tx, actor, { module: 'delivery', action: 'shipment.returned', entity: 'shipment', entityId: id, new: { reason: reason, condition: condition } });
      return { id: Number(id), status: 'returned' };
    });
  });
}

// ─────────────────────────── reading ───────────────────────────

const SHIP_SELECT = 'SELECT s.*, o.order_no, o.status AS order_status, o.grand_total, o.amount_paid, o.payment_method, o.payment_status, o.total_qty, o.item_count, o.ship_name, o.ship_contact, o.ship_phone, o.ship_line1, o.ship_line2, o.ship_city, o.ship_state, o.ship_pincode, o.ship_lat, o.ship_lng, ' +
  'o.buyer_account_id, a.business_name AS buyer_name, a.shop_name AS buyer_shop, st.name AS staff_name, w.code AS warehouse_code, dc.challan_no ' +
  'FROM b2b_shipments s JOIN b2b_orders o ON o.id = s.order_id JOIN b2b_accounts a ON a.id = o.buyer_account_id LEFT JOIN b2b_staff st ON st.id = s.delivery_staff_id ' +
  'LEFT JOIN b2b_warehouses w ON w.id = s.warehouse_id LEFT JOIN b2b_delivery_challans dc ON dc.shipment_id = s.id';

function shipOut(s, forBuyer) {
  const exp = s.expected_at ? new Date(s.expected_at).getTime() : null;
  const out = {
    id: Number(s.id), shipmentNo: s.shipment_no, orderId: Number(s.order_id), orderNo: s.order_no, orderStatus: s.order_status, status: s.status, mode: s.mode,
    carrier: s.carrier, vehicleNo: s.vehicle_no, driverName: s.driver_name, driverPhone: s.driver_phone, trackingNo: s.tracking_no, lrNo: s.lr_no, ewayBillNo: s.eway_bill_no,
    packages: s.packages, weightKg: s.weight_kg == null ? null : Number(s.weight_kg), expectedAt: s.expected_at, dispatchedAt: s.dispatched_at, outAt: s.out_at, deliveredAt: s.delivered_at, returnedAt: s.returned_at,
    attempts: Number(s.attempts), challanNo: s.challan_no || null, receivedBy: s.pod_received_by, hasProof: !!s.pod_stored_name,
    late: !!(exp && exp < Date.now() && MOVING.indexOf(s.status) !== -1),
  };
  if (!forBuyer) Object.assign(out, {
    sellerType: s.seller_type, warehouse: s.warehouse_code || null, deliveryStaffId: s.delivery_staff_id == null ? null : Number(s.delivery_staff_id), deliveryStaff: s.staff_name || null,
    buyer: s.buyer_shop || s.buyer_name, value: s.grand_total == null ? null : Number(s.grand_total), receiverPhone: s.pod_phone, podNote: s.pod_note,
    // what the buyer still owes on the order (for the driver: whether payment is expected at the door; the office records any money received)
    payment: s.grand_total == null ? null : { method: s.payment_method || null, status: s.payment_status || null, paid: Number(s.amount_paid || 0), due: Math.max(0, Math.round((Number(s.grand_total) - Number(s.amount_paid || 0)) * 100) / 100) },
    units: s.total_qty == null ? null : Number(s.total_qty), lines: s.item_count == null ? null : Number(s.item_count),
    address: { name: s.ship_name, contact: s.ship_contact, phone: s.ship_phone, line1: s.ship_line1, line2: s.ship_line2, city: s.ship_city, state: s.ship_state, pincode: s.ship_pincode,
      lat: s.ship_lat == null ? null : Number(s.ship_lat), lng: s.ship_lng == null ? null : Number(s.ship_lng) },
    missing: s.status === 'ready' ? readiness(s) : [],
  });
  return out;
}

async function list(by, q) {
  q = q || {};
  const where = [], params = [];
  if (by.sellerAccountId != null) { where.push("s.seller_type = 'distributor' AND s.seller_account_id = ?"); params.push(by.sellerAccountId); }
  else if (!(by.staff.permissions.has('deliveries.view') || by.staff.permissions.has('deliveries.manage'))) { where.push('s.delivery_staff_id = ?'); params.push(by.staff.id); }
  const done = q.status === 'done';
  if (q.status === 'open') where.push("s.status IN ('ready','dispatched','out_for_delivery','attempt_failed')");
  else if (done) {
    // finished shipments of the last N days (default 30): the driver's history
    where.push("s.status IN ('delivered','partially_delivered','returned','cancelled') AND COALESCE(s.delivered_at, s.returned_at, s.updated_at) >= UTC_TIMESTAMP() - INTERVAL " + db.int(q.days, 30, 1, 365) + ' DAY');
  } else if (q.status) { where.push('s.status = ?'); params.push(String(q.status)); }
  if (q.late === '1' || q.late === true) where.push("s.status IN ('dispatched','out_for_delivery','attempt_failed') AND s.expected_at < UTC_TIMESTAMP()");
  if (posId(q.staffId)) { where.push('s.delivery_staff_id = ?'); params.push(posId(q.staffId)); }
  if (q.q) { const t = v.text(q.q, 60); where.push('(s.shipment_no = ? OR o.order_no = ? OR s.tracking_no = ? OR s.lr_no = ? OR s.vehicle_no = ? OR dc.challan_no = ?)'); params.push(t, t, t, t, t.toUpperCase().replace(/[\s-]/g, ''), t); }
  const order = done ? ' ORDER BY COALESCE(s.delivered_at, s.returned_at, s.updated_at) DESC, s.id DESC LIMIT 300'
    : " ORDER BY FIELD(s.status, 'attempt_failed','out_for_delivery','dispatched','ready') DESC, s.expected_at IS NULL, s.expected_at, s.id DESC LIMIT 300";
  const rows = await db.query(SHIP_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + order, params);
  const out = { items: rows.map(function (s) { return shipOut(s, false); }) };
  if (canManage(by)) {
    // packed orders that still need a shipment
    const w = ["o.status = 'packed'", 'NOT EXISTS (SELECT 1 FROM b2b_shipments x WHERE x.order_id = o.id)'], p = [];
    if (by.sellerAccountId != null) { w.push("o.seller_type = 'distributor' AND o.seller_account_id = ?"); p.push(by.sellerAccountId); }
    const ready = await db.query('SELECT o.id, o.order_no, o.packed_at, o.grand_total, o.total_qty, o.ship_city, o.ship_pincode, o.seller_type, a.business_name, a.shop_name, w.code AS warehouse_code ' +
      'FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id LEFT JOIN b2b_warehouses w ON w.id = o.warehouse_id WHERE ' + w.join(' AND ') + ' ORDER BY o.packed_at, o.id LIMIT 200', p);
    out.toShip = ready.map(function (o) { return { orderId: Number(o.id), orderNo: o.order_no, packedAt: o.packed_at, value: Number(o.grand_total), units: Number(o.total_qty), city: o.ship_city, pincode: o.ship_pincode, buyer: o.shop_name || o.business_name, sellerType: o.seller_type, warehouse: o.warehouse_code }; });
  }
  return out;
}

async function detail(by, id) {
  const s = await db.queryOne(SHIP_SELECT + ' WHERE s.id = ?', [id]);
  if (!s || !canSee(s, by)) throw fail(404, 'Shipment not found');
  const out = shipOut(s, false);
  out.events = (await db.query('SELECT kind, note, place, lat, lng, actor_type, actor_label, created_at FROM b2b_shipment_events WHERE shipment_id = ? ORDER BY id', [id]))
    .map(function (e) { return { kind: e.kind, note: e.note, place: e.place, lat: e.lat == null ? null : Number(e.lat), lng: e.lng == null ? null : Number(e.lng), by: e.actor_label || e.actor_type, at: e.created_at }; });
  out.items = (await db.query('SELECT id, sku, name, qty, qty_delivered FROM b2b_order_items WHERE order_id = ? ORDER BY id', [s.order_id]))
    .map(function (i) { return { id: Number(i.id), sku: i.sku, name: i.name, qty: Number(i.qty), delivered: i.qty_delivered == null ? null : Number(i.qty_delivered) }; });
  const maxAttempts = await settings.get('delivery.max_attempts');
  out.maxAttempts = maxAttempts == null ? null : Number(maxAttempts);
  out.canManage = canManage(by);
  return out;
}

async function proof(by, id) {
  const s = await db.queryOne('SELECT * FROM b2b_shipments WHERE id = ?', [id]);
  if (!s || !canSee(s, by) || !s.pod_stored_name) throw fail(404, 'No proof of delivery');
  return {
    mime: s.pod_mime,
    /** Sends the photo (headers only once it exists); a missing file is a 404. */
    send: async function (res, headers) {
      if (!(await uploads.sendDocument(res, s.pod_stored_name, headers))) throw fail(404, 'No proof of delivery');
    },
  };
}

/** The challan of an order, for staff (by.staff), the seller (by.sellerAccountId) or the buyer (by.buyerAccountId). */
async function challan(by, f) {
  const row = await db.queryOne('SELECT dc.*, s.shipment_no, s.mode, s.carrier, s.vehicle_no, s.driver_name, s.tracking_no, s.lr_no, s.eway_bill_no, s.packages, s.weight_kg, s.seller_type, s.seller_account_id, s.delivery_staff_id, ' +
    'o.order_no, o.buyer_account_id, o.ship_name, o.ship_line1, o.ship_line2, o.ship_city, o.ship_state, o.ship_pincode, o.buyer_gstin, o.created_at AS order_date ' +
    'FROM b2b_delivery_challans dc JOIN b2b_shipments s ON s.id = dc.shipment_id JOIN b2b_orders o ON o.id = dc.order_id WHERE ' + (f.shipmentId ? 'dc.shipment_id = ?' : 'dc.order_id = ?'), [f.shipmentId || f.orderId]);
  if (!row) throw fail(404, 'No delivery challan yet (it is issued at dispatch)');
  if (by.buyerAccountId != null) { if (Number(row.buyer_account_id) !== Number(by.buyerAccountId)) throw fail(404, 'No delivery challan'); }
  else if (!canSee(row, by)) throw fail(404, 'No delivery challan');
  const sellerCard = await require('../../b2b/invoices/service.js').sellerCard(row.seller_type, row.seller_account_id);
  return render(row, JSON.parse(row.lines_json), sellerCard);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function render(c, lines, seller) {
  const rows = [];
  lines.forEach(function (l, i) {
    const bs = l.batches && l.batches.length ? l.batches : [{ batchNo: null, expiry: null, qty: l.qty }];
    bs.forEach(function (b, j) {
      rows.push('<tr><td>' + (j ? '' : i + 1) + '</td><td>' + (j ? '' : esc(l.name) + '<br><small>' + esc(l.sku) + (l.hsn ? ' · HSN ' + esc(l.hsn) : '') + '</small>') + '</td><td>' + esc(b.batchNo || '—') + '</td><td>' + esc(b.expiry || '—') +
        '</td><td class="n">' + esc(b.qty) + '</td><td class="n">' + (j ? '' : '₹' + Number(l.value).toFixed(2)) + '</td></tr>');
    });
  });
  const addr = [c.ship_line1, c.ship_line2, c.ship_city, c.ship_state, c.ship_pincode].filter(Boolean).map(esc).join(', ');
  const travel = [c.mode.replace('_', ' '), c.carrier, c.vehicle_no ? 'Vehicle ' + c.vehicle_no : null, c.driver_name ? 'Driver ' + c.driver_name : null, c.tracking_no ? 'Tracking ' + c.tracking_no : null, c.lr_no ? 'LR ' + c.lr_no : null]
    .filter(Boolean).map(esc).join(' · ');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Delivery challan ' + esc(c.challan_no) + '</title><style>' +
    'body{font:13px/1.45 system-ui,sans-serif;color:#111;max-width:800px;margin:24px auto;padding:0 16px}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin:12px 0}' +
    'th,td{border:1px solid #bbb;padding:6px;text-align:left;vertical-align:top}th{background:#f2f2f2}.n{text-align:right}.top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}' +
    '.box{border:1px solid #bbb;padding:8px;flex:1;min-width:220px}.sign{display:flex;justify-content:space-between;margin-top:48px}.sign div{border-top:1px solid #333;padding-top:4px;width:40%}' +
    '@media print{button{display:none}}</style></head><body>' +
    '<button onclick="window.print()">Print / save as PDF</button>' +
    '<div class="top"><div><h1>Delivery challan</h1><div>' + esc(c.challan_no) + ' · ' + esc(new Date(c.issued_at).toISOString().slice(0, 10)) + '</div></div>' +
    '<div><b>' + esc(seller.name || seller.legal_name || 'Sake of Health') + '</b><br>' + esc(seller.address || '') + (seller.gstin ? '<br>GSTIN ' + esc(seller.gstin) : '') + '</div></div>' +
    '<div class="top" style="margin-top:12px"><div class="box"><b>Deliver to</b><br>' + esc(c.ship_name) + '<br>' + addr + (c.buyer_gstin ? '<br>GSTIN ' + esc(c.buyer_gstin) : '') + '</div>' +
    '<div class="box"><b>Order</b> ' + esc(c.order_no) + '<br><b>Shipment</b> ' + esc(c.shipment_no) + '<br>' + travel + (c.eway_bill_no ? '<br><b>E-way bill</b> ' + esc(c.eway_bill_no) : '') +
    (c.packages ? '<br>' + esc(c.packages) + ' package(s)' : '') + (c.weight_kg ? ' · ' + esc(Number(c.weight_kg)) + ' kg' : '') + '</div></div>' +
    '<table><thead><tr><th>#</th><th>Item</th><th>Batch</th><th>Expiry</th><th class="n">Qty</th><th class="n">Value</th></tr></thead><tbody>' + rows.join('') +
    '</tbody><tfoot><tr><th colspan="5" class="n">Value of goods (incl. GST)</th><th class="n">₹' + Number(c.value_total).toFixed(2) + '</th></tr></tfoot></table>' +
    '<p><small>This challan records the movement of goods. It is not a tax invoice.</small></p>' +
    '<div class="sign"><div>For the sender</div><div>Received in good condition (name, signature, date)</div></div></body></html>';
}

// ─────────────────────────── keeping in step with the order ───────────────────────────

const MIRROR = { dispatched: 'dispatched', out_for_delivery: 'out_for_delivery', delivered: 'delivered', partially_delivered: 'partially_delivered', returned: 'returned', cancelled: 'cancelled', rejected: 'cancelled' };

/** The order moved (anywhere). Bring its shipment along; issue the challan once it left. */
async function followOrder(orderId, actor) {
  return db.transaction(async function (tx) {
    const s = await tx.queryOne('SELECT * FROM b2b_shipments WHERE order_id = ? FOR UPDATE', [orderId]);
    if (!s) return { followed: false };
    const o = await tx.queryOne('SELECT status, dispatched_at, out_for_delivery_at, delivered_at FROM b2b_orders WHERE id = ?', [orderId]);
    const want = MIRROR[o.status];
    const rank = { ready: 0, dispatched: 1, out_for_delivery: 2, attempt_failed: 2, delivered: 3, partially_delivered: 3, returned: 3, cancelled: 3 };
    if (!want || want === s.status || rank[want] < rank[s.status] || (FINAL.indexOf(s.status) !== -1)) {
      if (o.status !== 'packed' && o.status !== 'cancelled' && o.status !== 'rejected' && s.status !== 'ready' && s.status !== 'cancelled') await issueChallan(tx, s.id, actor || { type: 'system' });
      return { followed: false };
    }
    const col = { dispatched: 'dispatched_at', out_for_delivery: 'out_at', delivered: 'delivered_at', partially_delivered: 'delivered_at', returned: 'returned_at' }[want];
    await tx.query('UPDATE b2b_shipments SET status = ?' + (col ? ', ' + col + ' = COALESCE(' + col + ', UTC_TIMESTAMP())' : '') + ' WHERE id = ?', [want, s.id]);
    await addEvent(tx, s.id, want === 'cancelled' ? 'cancelled' : want, actor || { type: 'system' }, { note: 'Order marked ' + o.status.replace(/_/g, ' ') });
    if (want !== 'cancelled') await issueChallan(tx, s.id, actor || { type: 'system' });
    return { followed: true, status: want };
  });
}

/** Catch-up for anything the hook missed (process restart between commit and hook). */
async function syncFromOrders() {
  const rows = await db.query("SELECT s.order_id FROM b2b_shipments s JOIN b2b_orders o ON o.id = s.order_id WHERE s.status NOT IN ('delivered','partially_delivered','returned','cancelled') AND " +
    "((o.status IN ('dispatched','out_for_delivery','delivered','partially_delivered','returned','cancelled','rejected') AND o.status <> s.status AND NOT (s.status = 'attempt_failed' AND o.status IN ('dispatched','out_for_delivery'))) " +
    "OR (o.status IN ('dispatched','out_for_delivery') AND NOT EXISTS (SELECT 1 FROM b2b_delivery_challans dc WHERE dc.shipment_id = s.id))) LIMIT 200");
  let n = 0;
  for (const r of rows) { const x = await followOrder(r.order_id, { type: 'system' }); if (x.followed) n++; }
  return { checked: rows.length, followed: n };
}

/** Shipments past their expected time (plus the decided grace hours) are alerted once to the back office. */
async function alertLate() {
  const hours = await settings.get('delivery.delay_alert_hours');
  if (!hours) return { alerted: 0, reason: 'delivery.delay_alert_hours is not decided' };
  const rows = await db.query("SELECT s.id, s.shipment_no, s.expected_at, o.order_no, o.id AS order_id FROM b2b_shipments s JOIN b2b_orders o ON o.id = s.order_id WHERE s.status IN ('dispatched','out_for_delivery','attempt_failed') " +
    'AND s.delay_alerted_at IS NULL AND s.expected_at < UTC_TIMESTAMP() - INTERVAL ? HOUR LIMIT 100', [Number(hours)]);
  for (const s of rows) {
    await db.transaction(async function (tx) {
      const r = await tx.query('UPDATE b2b_shipments SET delay_alerted_at = UTC_TIMESTAMP() WHERE id = ? AND delay_alerted_at IS NULL', [s.id]);
      if (r.affectedRows !== 1) return;
      await notif().notifyAdmins(tx, { event: 'delivery.late', title: 'Late delivery: ' + s.shipment_no + ' (order ' + s.order_no + ')', lines: ['Expected ' + new Date(s.expected_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC and not delivered yet.'], refType: 'order', refId: s.order_id });
    });
  }
  return { alerted: rows.length };
}

/** Order view (portal and admin): the shipment, its timeline and challan; buyers do not see staff or proof files. */
async function extendOrderDetail(out, scope) {
  const s = await db.queryOne(SHIP_SELECT + ' WHERE s.order_id = ?', [out.order.id]).catch(function (e) { if (e.code === 'ER_NO_SUCH_TABLE') return null; throw e; });
  if (!s) { out.shipment = null; return; }
  const forBuyer = !scope.admin && scope.sellerAccountId == null;
  const sh = shipOut(s, forBuyer);
  sh.events = (await db.query('SELECT kind, note, place, created_at FROM b2b_shipment_events WHERE shipment_id = ? ORDER BY id', [s.id]))
    .filter(function (e) { return !forBuyer || e.kind !== 'details_changed'; })
    .map(function (e) { return { kind: e.kind, note: forBuyer && e.kind === 'created' ? null : e.note, place: e.place, at: e.created_at }; });
  out.shipment = sh;
}

/** Wire into the order flow (called once when the business platform starts). */
function attach() {
  const o = orders();
  if (attach.done) return;
  attach.done = true;
  o.onTransition(function (orderId, from, to, actor) {
    if (['dispatched', 'out_for_delivery', 'delivered', 'partially_delivered', 'returned', 'cancelled', 'rejected'].indexOf(to) === -1) return null;
    if (actor && actor.viaShipment) return null;   // started from the shipment, which records the step itself (no double timeline entry)
    return followOrder(orderId, actor).catch(function (e) { if (e.code === 'ER_NO_SUCH_TABLE') return null; throw e; });
  });
  o.extendDetail(extendOrderDetail);
}

/** People who can be assigned deliveries (active, holding deliveries.update). */
async function deliveryStaff() {
  const rows = await db.query("SELECT DISTINCT s.id, s.name, s.mobile FROM b2b_staff s JOIN b2b_staff_roles sr ON sr.staff_id = s.id AND sr.revoked_at IS NULL JOIN b2b_roles r ON r.id = sr.role_id AND r.is_active = 1 " +
    "JOIN b2b_role_permissions rp ON rp.role_id = r.id AND rp.permission_code = 'deliveries.update' WHERE s.status = 'active' ORDER BY s.name");
  return { items: rows.map(function (r) { return { id: Number(r.id), name: r.name, mobile: r.mobile }; }) };
}

/**
 * Delivery dashboard (staff with deliveries.view or deliveries.manage): shipments by status, late, delivered
 * and failed today, packed orders still waiting for a shipment, and each delivery person's workload.
 */
async function summary() {
  const IST = 330 * 60000, day = new Date(Date.now() + IST).toISOString().slice(0, 10);
  const start = new Date(Date.parse(day + 'T00:00:00Z') - IST).toISOString().slice(0, 19).replace('T', ' ');
  const byStatus = {};
  (await db.query('SELECT status, COUNT(*) AS n FROM b2b_shipments GROUP BY status')).forEach(function (r) { byStatus[r.status] = Number(r.n); });
  const one = async function (sql, p) { return Number((await db.queryOne(sql, p || [])).n); };
  const staff = (await deliveryStaff()).items;
  const load = await db.query("SELECT delivery_staff_id AS id, SUM(status IN ('ready','dispatched','out_for_delivery','attempt_failed')) AS open_n, " +
    "SUM(status IN ('delivered','partially_delivered') AND delivered_at >= ?) AS done_today, SUM(status = 'attempt_failed') AS failed, " +
    "SUM(status IN ('dispatched','out_for_delivery','attempt_failed') AND expected_at < UTC_TIMESTAMP()) AS late_n FROM b2b_shipments WHERE delivery_staff_id IS NOT NULL GROUP BY delivery_staff_id", [start]);
  const map = {}; load.forEach(function (l) { map[Number(l.id)] = l; });
  return {
    day: day,
    byStatus: byStatus,
    open: (byStatus.ready || 0) + (byStatus.dispatched || 0) + (byStatus.out_for_delivery || 0) + (byStatus.attempt_failed || 0),
    late: await one("SELECT COUNT(*) AS n FROM b2b_shipments WHERE status IN ('dispatched','out_for_delivery','attempt_failed') AND expected_at < UTC_TIMESTAMP()"),
    deliveredToday: await one("SELECT COUNT(*) AS n FROM b2b_shipments WHERE status IN ('delivered','partially_delivered') AND delivered_at >= ?", [start]),
    failedToday: await one("SELECT COUNT(*) AS n FROM b2b_shipment_events WHERE kind = 'attempt_failed' AND created_at >= ?", [start]),
    waitingForShipment: await one("SELECT COUNT(*) AS n FROM b2b_orders o WHERE o.status = 'packed' AND NOT EXISTS (SELECT 1 FROM b2b_shipments x WHERE x.order_id = o.id)"),
    unassignedOwnVehicle: await one("SELECT COUNT(*) AS n FROM b2b_shipments WHERE mode = 'own_vehicle' AND delivery_staff_id IS NULL AND status IN ('ready','dispatched','out_for_delivery','attempt_failed')"),
    staff: staff.map(function (p) { const l = map[p.id] || {}; return { id: p.id, name: p.name, mobile: p.mobile, open: Number(l.open_n || 0), deliveredToday: Number(l.done_today || 0), failed: Number(l.failed || 0), late: Number(l.late_n || 0) }; }),
  };
}

module.exports = { orderActor,
  summary,
  MODES, clean, deliveryStaff, vehicleNo, readiness, canSee,
  create, update, dispatch, outForDelivery, location, attemptFailed, deliver, returnToWarehouse,
  list, detail, proof, challan, render, issueChallan, followOrder, syncFromOrders, alertLate, extendOrderDetail, attach,
};
