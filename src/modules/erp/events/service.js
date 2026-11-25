/**
 * Events and counter sales (3b.5) on the one central ledger.
 *
 * An event (stall, exhibition, fair) has its own stock point: a warehouse of type 'event'
 * created with it. Stock reaches it by the existing transfers and goes back the same way.
 * Event staff see and sell only at events they are assigned to.
 *
 * A counter sale is a GST invoice (prices are MRP, tax-inclusive; place of supply = the
 * event's state; CGST+SGST inside the company's state, IGST outside). Units leave the event's
 * stock earliest-expiry-first, one ledger row per batch (counter_sale), in the same transaction
 * as the invoice. Every sale carries a device-made idempotency key: a retry, a double press or
 * an offline sync returns the first sale and moves nothing twice.
 *
 * Invoices are never edited. A mistake is corrected by a return (stock back by condition:
 * resaleable → available, damaged, expired) or a void (everything back), both with a reason
 * and an audit row; payments and refunds are insert-only.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const seq = require('../lib/seq.js');
const ledger = require('../inventory/ledger.js');
const fefo = require('../inventory/fefo.js');
const customers = require('../customers/service.js');
const { fail, posId } = require('../lib/http.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = ['cash', 'upi', 'card', 'bank_transfer'];
const CONDITIONS = { resaleable: 'available', damaged: 'damaged', expired: 'expired' };
function need(c, m, code) { if (!c) throw fail(400, m, code); }
const r2 = function (n) { return Math.round(Number(n) * 100) / 100; };
const money = function (n) { return r2(n).toFixed(2); };
function day(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; }
function sqlTime(v) {
  const t = v ? Date.parse(v) : NaN, now = Date.now();
  const ms = Number.isFinite(t) && t <= now + 5 * 60000 && t >= now - 30 * 86400000 ? Math.min(t, now) : now;
  return new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
}

// ── Who may act at which event ──
async function assigned(q, staffId) { return (await (q || db).query('SELECT event_id FROM b2b_event_staff WHERE staff_id = ?', [staffId])).map(function (r) { return Number(r.event_id); }); }
async function mayAct(q, principal, eventId) {
  if (principal.permissions.has('events.manage')) return true;
  return (await assigned(q, principal.id)).indexOf(Number(eventId)) !== -1;
}
async function eventFor(q, principal, eventId, lock) {
  const e = await (q || db).queryOne('SELECT * FROM b2b_events WHERE id = ?' + (lock ? ' FOR UPDATE' : ''), [posId(eventId)]);
  if (!e) throw fail(404, 'Event not found');
  if (!(await mayAct(q, principal, e.id))) throw fail(403, 'You are not assigned to this event', 'event_forbidden');
  return e;
}

// ── Events ──
async function createEvent(tx, actor, principal, b) {
  const code = String(b.code || '').trim().toUpperCase();
  need(/^[A-Z0-9-]{2,20}$/.test(code), 'Code: 2–20 letters, digits or dashes');
  const name = String(b.name || '').trim();
  need(name.length >= 3 && name.length <= 160, 'Name: 3–160 characters');
  const startsOn = day(b.startsOn), endsOn = day(b.endsOn);
  need(startsOn && endsOn && endsOn >= startsOn, 'Start and end dates are required (end on or after start)');
  const prefix = String(b.invoicePrefix || 'EV').trim().toUpperCase();
  need(/^[A-Z][A-Z0-9]{0,4}$/.test(prefix), 'Invoice prefix: 1–5 letters or digits, starting with a letter (GST invoice numbers are at most 16 characters)');
  const stateId = posId(b.stateId) || null;
  if (stateId) need(await tx.queryOne('SELECT id FROM b2b_states WHERE id = ?', [stateId]), 'Unknown state');
  if (await tx.queryOne('SELECT id FROM b2b_events WHERE code = ?', [code])) throw fail(409, 'An event with code ' + code + ' exists', 'event_exists');
  const wcode = ('EV-' + code).slice(0, 30);
  if (await tx.queryOne('SELECT id FROM b2b_warehouses WHERE code = ?', [wcode])) throw fail(409, 'A stock point ' + wcode + ' already exists', 'warehouse_exists');
  const w = await tx.query("INSERT INTO b2b_warehouses (code, name, warehouse_type, address, state_id, city, is_active) VALUES (?, ?, 'event', ?, ?, ?, 1)",
    [wcode, ('Event: ' + name).slice(0, 120), b.venue ? String(b.venue).slice(0, 300) : null, stateId, b.city ? String(b.city).slice(0, 80) : null]);
  const r = await tx.query('INSERT INTO b2b_events (code, name, venue, city, state_id, warehouse_id, starts_on, ends_on, invoice_prefix, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [code, name, b.venue ? String(b.venue).slice(0, 200) : null, b.city ? String(b.city).slice(0, 80) : null, stateId, w.insertId, startsOn, endsOn, prefix, principal.id]);
  await audit.write(tx, actor, { module: 'events', action: 'event.created', entity: 'event', entityId: r.insertId, new: { code: code, name: name, warehouseId: Number(w.insertId), startsOn: startsOn, endsOn: endsOn, prefix: prefix } });
  return getEvent(principal, r.insertId, tx);
}

const NEXT = { planned: ['open', 'closed'], open: ['closed'], closed: [] };
async function setStatus(tx, actor, principal, id, status) {
  const e = await tx.queryOne('SELECT * FROM b2b_events WHERE id = ? FOR UPDATE', [posId(id)]);
  if (!e) throw fail(404, 'Event not found');
  if ((NEXT[e.status] || []).indexOf(status) === -1) throw fail(409, 'An event that is ' + e.status + ' cannot become ' + status, 'bad_status');
  await tx.query('UPDATE b2b_events SET status = ?' + (status === 'closed' ? ', closed_by = ?, closed_at = UTC_TIMESTAMP()' : '') + ' WHERE id = ?',
    status === 'closed' ? [status, principal.id, e.id] : [status, e.id]);
  await audit.write(tx, actor, { module: 'events', action: 'event.' + status, entity: 'event', entityId: e.id, old: { status: e.status }, new: { status: status } });
  return getEvent(principal, e.id, tx);
}

async function setStaff(tx, actor, principal, id, staffIds) {
  const e = await tx.queryOne('SELECT id FROM b2b_events WHERE id = ? FOR UPDATE', [posId(id)]);
  if (!e) throw fail(404, 'Event not found');
  need(Array.isArray(staffIds) && staffIds.length <= 200, 'staffIds must be a list');
  const ids = Array.from(new Set(staffIds.map(posId).filter(Boolean)));
  if (ids.length) {
    const found = await tx.query("SELECT id FROM b2b_staff WHERE status = 'active' AND id IN (" + db.placeholders(ids) + ')', ids);
    need(found.length === ids.length, 'Some staff were not found or are not active', 'unknown_staff');
  }
  const before = (await tx.query('SELECT staff_id FROM b2b_event_staff WHERE event_id = ?', [e.id])).map(function (r) { return Number(r.staff_id); });
  await tx.query('DELETE FROM b2b_event_staff WHERE event_id = ?', [e.id]);
  for (const s of ids) await tx.query('INSERT INTO b2b_event_staff (event_id, staff_id, added_by) VALUES (?, ?, ?)', [e.id, s, principal.id]);
  await audit.write(tx, actor, { module: 'events', action: 'event.staff_set', entity: 'event', entityId: e.id, old: { staff: before }, new: { staff: ids } });
  return { eventId: Number(e.id), staff: ids };
}

function shapeEvent(e) {
  return { id: Number(e.id), code: e.code, name: e.name, venue: e.venue, city: e.city, stateId: e.state_id == null ? null : Number(e.state_id), warehouseId: Number(e.warehouse_id),
    startsOn: e.starts_on, endsOn: e.ends_on, status: e.status, invoicePrefix: e.invoice_prefix, lat: e.lat == null ? null : Number(e.lat), lng: e.lng == null ? null : Number(e.lng) };
}
async function getEvent(principal, id, q) {
  const e = await eventFor(q, principal, id);
  const staff = await (q || db).query('SELECT s.id, s.name, s.email FROM b2b_event_staff es JOIN b2b_staff s ON s.id = es.staff_id WHERE es.event_id = ? ORDER BY s.name', [e.id]);
  return Object.assign(shapeEvent(e), { staff: staff.map(function (s) { return { id: Number(s.id), name: s.name, email: s.email }; }) });
}
async function listEvents(principal, q) {
  const where = [], args = [];
  if (!principal.permissions.has('events.manage') && !principal.permissions.has('events.reports.view')) {
    const ids = await assigned(null, principal.id);
    if (!ids.length) return { items: [] };
    where.push('e.id IN (' + db.placeholders(ids) + ')'); args.push.apply(args, ids);
  }
  if (['planned', 'open', 'closed'].indexOf(q.status) !== -1) { where.push('e.status = ?'); args.push(q.status); }
  const rows = await db.query('SELECT e.*, (SELECT COUNT(*) FROM b2b_counter_sales s WHERE s.event_id = e.id AND s.status = \'completed\') AS sales, ' +
    "(SELECT COALESCE(SUM(s.grand_total), 0) FROM b2b_counter_sales s WHERE s.event_id = e.id AND s.status = 'completed') AS revenue FROM b2b_events e" +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY e.starts_on DESC, e.id DESC LIMIT 500', args);
  return { items: rows.map(function (e) { return Object.assign(shapeEvent(e), { sales: Number(e.sales), revenue: Number(e.revenue) }); }) };
}
/** What the event has to sell: per product, available units and the earliest expiry. */
async function eventStock(principal, id) {
  const e = await eventFor(null, principal, id);
  const rows = await db.query('SELECT p.id, p.sku, p.name, p.mrp, p.gst_rate, p.hsn_code, s.qty_available, s.qty_damaged, s.qty_expired, ' +
    "(SELECT MIN(b.expiry_date) FROM b2b_batches b WHERE b.warehouse_id = s.warehouse_id AND b.product_id = s.product_id AND b.status = 'active' AND b.qty_on_hand > 0) AS next_expiry " +
    'FROM b2b_stock s JOIN b2b_products p ON p.id = s.product_id WHERE s.warehouse_id = ? AND (s.qty_available > 0 OR s.qty_damaged > 0 OR s.qty_expired > 0) ORDER BY p.name', [e.warehouse_id]);
  return { event: shapeEvent(e), items: rows.map(function (r) { return { productId: Number(r.id), sku: r.sku, name: r.name, mrp: Number(r.mrp), gstRate: Number(r.gst_rate), hsn: r.hsn_code,
    available: Number(r.qty_available), damaged: Number(r.qty_damaged), expired: Number(r.qty_expired), nextExpiry: r.next_expiry }; }) };
}

// ── Counter sales ──
async function sellerState(q) {
  const s = await require('../../b2b/invoices/service.js').sellerCard('company', null, q);
  return s;
}

/** Tax for one line: MRP is tax-inclusive. Returns taxable, cgst, sgst, igst (rounded to paise). */
function taxLine(gross, rate, interstate) {
  const taxable = r2(gross / (1 + Number(rate) / 100));
  const tax = r2(gross - taxable);
  if (interstate) return { taxable: taxable, cgst: 0, sgst: 0, igst: tax };
  const cgst = r2(tax / 2);
  return { taxable: taxable, cgst: cgst, sgst: r2(tax - cgst), igst: 0 };
}

/**
 * Sell at the counter. b = { idempotencyKey, eventId, items: [{ productId, qty, discount? }],
 *   customer?: { name, mobile, email, gstin }, payments?: [{ method, amount, reference? }],
 *   soldAt?, offline?, lat?, lng?, notes? }
 * Short stock → 409 insufficient_stock with the lines (an offline sale then becomes a conflict
 * for staff to settle; nothing is half-sold).
 */
async function sell(tx, actor, principal, b) {
  const key = String(b.idempotencyKey || '');
  need(UUID.test(key), 'idempotencyKey (a UUID made by the device) is required so a retry never sells twice', 'idempotency_key');
  const dup = await tx.queryOne('SELECT id FROM b2b_counter_sales WHERE idempotency_key = ?', [key]);
  if (dup) return Object.assign(await saleView(tx, Number(dup.id)), { duplicate: true });
  const e = await eventFor(tx, principal, b.eventId, true);
  if (e.status !== 'open') throw fail(409, 'Event ' + e.code + ' is ' + e.status + ': sales are only taken while it is open', 'event_not_open');
  const want = {};
  need(Array.isArray(b.items) && b.items.length && b.items.length <= 100, 'Add 1–100 items');
  b.items.forEach(function (it) {
    const pid = posId(it && it.productId), qty = Number(it && it.qty);
    need(pid && Number.isInteger(qty) && qty > 0 && qty <= 10000, 'Each item needs a product and a whole quantity');
    const d = Number(it.discount || 0);
    need(Number.isFinite(d) && d >= 0, 'A discount cannot be negative');
    want[pid] = want[pid] || { qty: 0, discount: 0 };
    want[pid].qty += qty; want[pid].discount = r2(want[pid].discount + d);
  });
  const ids = Object.keys(want).map(Number).sort(function (a, z) { return a - z; });
  const prods = await tx.query("SELECT id, sku, name, hsn_code, gst_rate, mrp, is_active FROM b2b_products WHERE id IN (" + db.placeholders(ids) + ')', ids);
  const byId = {}; prods.forEach(function (p) { byId[Number(p.id)] = p; });
  ids.forEach(function (pid) { need(byId[pid], 'Unknown product ' + pid, 'unknown_product'); need(Number(byId[pid].mrp) > 0, byId[pid].name + ' has no price (MRP)', 'no_price'); });
  // stock under lock, all lines first (nothing is half-sold)
  const short = [];
  for (const pid of ids) {
    const st = await tx.queryOne('SELECT qty_available FROM b2b_stock WHERE warehouse_id = ? AND product_id = ? FOR UPDATE', [e.warehouse_id, pid]);
    const have = st ? Number(st.qty_available) : 0;
    if (have < want[pid].qty) short.push({ productId: pid, name: byId[pid].name, wanted: want[pid].qty, available: have });
  }
  if (short.length) throw fail(409, 'Not enough stock at ' + e.code + ': ' + short.map(function (s) { return s.name + ' (' + s.available + ' of ' + s.wanted + ')'; }).join(', '), 'insufficient_stock', { short: short });
  const seller = await sellerState(tx);
  const sellerStateId = seller && seller.stateId != null ? Number(seller.stateId) : null;
  const pos = e.state_id == null ? sellerStateId : Number(e.state_id);
  const interstate = !!(sellerStateId && pos && sellerStateId !== pos);
  const cust = b.customer && typeof b.customer === 'object' ? b.customer : {};
  const gstin = cust.gstin ? String(cust.gstin).trim().toUpperCase() : null;
  if (gstin) need(/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin), 'GSTIN must be 15 characters', 'bad_gstin');
  // lines: one invoice row per batch picked, discount shared in proportion
  const rows = [];
  let subtotal = 0, discountTotal = 0, taxableTotal = 0, cgst = 0, sgst = 0, igst = 0;
  for (const pid of ids) {
    const p = byId[pid], w = want[pid];
    const gross = r2(Number(p.mrp) * w.qty);
    need(w.discount <= gross, 'The discount on ' + p.name + ' is more than its price', 'bad_discount');
    const picks = await fefo.pick(tx, e.warehouse_id, pid, w.qty);
    let discLeft = w.discount;
    picks.forEach(function (pk, i) {
      const lineGross = r2(Number(p.mrp) * pk.qty);
      const disc = i === picks.length - 1 ? r2(discLeft) : r2(w.discount * pk.qty / w.qty);
      discLeft = r2(discLeft - disc);
      const net = r2(lineGross - disc);
      const t = taxLine(net, p.gst_rate, interstate);
      rows.push({ pid: pid, p: p, pk: pk, qty: pk.qty, unit: Number(p.mrp), disc: disc, net: net, t: t });
      subtotal = r2(subtotal + lineGross); discountTotal = r2(discountTotal + disc); taxableTotal = r2(taxableTotal + t.taxable);
      cgst = r2(cgst + t.cgst); sgst = r2(sgst + t.sgst); igst = r2(igst + t.igst);
    });
  }
  const exact = r2(subtotal - discountTotal);
  const grand = Math.round(exact), roundOff = r2(grand - exact);
  // payments (optional at sale time; split allowed; never more than the bill)
  const pays = Array.isArray(b.payments) ? b.payments : [];
  let paid = 0;
  pays.forEach(function (p) {
    need(METHODS.indexOf(p && p.method) !== -1, 'Payment method must be cash, upi, card or bank_transfer');
    const a = r2(p.amount);
    need(a > 0, 'A payment amount must be positive');
    paid = r2(paid + a);
  });
  need(paid <= grand, 'Payments (' + money(paid) + ') are more than the bill (' + money(grand) + ')', 'overpaid');
  const invoiceNo = await seq.next(tx, e.invoice_prefix);
  const soldAt = sqlTime(b.soldAt);
  const lat = Number(b.lat), lng = Number(b.lng);
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const ins = await tx.query('INSERT INTO b2b_counter_sales (invoice_no, event_id, warehouse_id, customer_name, customer_mobile, customer_email, customer_gstin, place_of_supply_state_id, is_interstate, ' +
    'item_count, total_qty, subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, amount_paid, payment_status, idempotency_key, sold_by, sold_at, offline, lat, lng, notes) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [invoiceNo, e.id, e.warehouse_id, cust.name ? String(cust.name).slice(0, 160) : null, cust.mobile ? String(cust.mobile).replace(/[^\d+]/g, '').slice(0, 15) : null,
      cust.email ? String(cust.email).trim().slice(0, 190) : null, gstin, pos, interstate ? 1 : 0, ids.length, ids.reduce(function (s, pid) { return s + want[pid].qty; }, 0),
      money(subtotal), money(discountTotal), money(taxableTotal), money(cgst), money(sgst), money(igst), money(roundOff), money(grand), money(paid),
      paid === 0 ? 'unpaid' : (paid < grand ? 'partial' : 'paid'), key, principal.id, soldAt, b.offline ? 1 : 0, hasLoc ? lat : null, hasLoc ? lng : null,
      b.notes ? String(b.notes).slice(0, 500) : null]);
  const saleId = Number(ins.insertId);
  for (const x of rows) {
    await tx.query('INSERT INTO b2b_counter_sale_items (sale_id, product_id, sku, name, hsn_code, batch_id, lot_id, batch_no, expiry_date, qty, unit_price, discount_amount, gst_rate, taxable_amount, cgst_amount, sgst_amount, igst_amount, line_total) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [saleId, x.pid, x.p.sku, x.p.name, x.p.hsn_code, x.pk.batchId, x.pk.lotId, x.pk.batchNo, x.pk.expiryDate, x.qty, money(x.unit), money(x.disc), x.p.gst_rate,
        money(x.t.taxable), money(x.t.cgst), money(x.t.sgst), money(x.t.igst), money(x.net)]);
    await ledger.mustMove(tx, { warehouseId: e.warehouse_id, productId: x.pid, batchId: x.pk.batchId, lotId: x.pk.lotId, type: 'counter_sale', qty: x.qty, from: 'available',
      refType: 'counter_sale', refId: saleId, reason: 'Invoice ' + invoiceNo, actor: actor, idemKey: 'cs:' + key + ':' + x.pid + ':' + (x.pk.batchId || 'nb') });
  }
  let n = 0;
  for (const p of pays) {
    n++;
    await tx.query("INSERT INTO b2b_counter_payments (sale_id, method, amount, direction, reference, recorded_by, idempotency_key) VALUES (?, ?, ?, 'in', ?, ?, ?)",
      [saleId, p.method, money(p.amount), p.reference ? String(p.reference).slice(0, 80) : null, principal.id, key + ':pay:' + n]);
  }
  // N4: one customer record across channels (walk-ins with no contact stay anonymous)
  const c = await customers.link(tx, { name: cust.name, email: cust.email, mobile: cust.mobile, seenAt: soldAt.replace(' ', 'T') + 'Z' }, 'event_sale', saleId);
  if (c) {
    await tx.query('UPDATE b2b_counter_sales SET customer_id = ? WHERE id = ?', [c.customerId, saleId]);
    await customers.recordOrder(tx, c.customerId, { channel: 'event', sourceOrderId: saleId, orderNo: invoiceNo, status: 'completed', total: grand, itemCount: ids.length, orderedAt: soldAt.replace(' ', 'T') + 'Z' });
  }
  await audit.write(tx, actor, { module: 'events', action: 'counter_sale.created', entity: 'counter_sale', entityId: saleId,
    new: { invoiceNo: invoiceNo, eventId: Number(e.id), total: grand, paid: paid, lines: rows.length, offline: !!b.offline } });
  // the invoice by WhatsApp (an approved utility template) and/or email, through the one outbox
  await sendInvoice(tx, saleId, invoiceNo, e, grand, cust);
  return saleView(tx, saleId);
}

/** Queue the invoice message; skipped quietly when there is no contact or no template configured. */
async function sendInvoice(tx, saleId, invoiceNo, e, grand, cust) {
  const outbox = require('../../b2b/notifications/service.js');
  const link = invoiceLink(saleId);
  const name = cust.name ? String(cust.name).slice(0, 60) : 'Customer';
  let qid = null;
  if (cust.mobile && String(cust.mobile).replace(/\D/g, '').length >= 10 && process.env.WHATSAPP_TEMPLATE_EVENT_INVOICE) {
    qid = await outbox.enqueue(tx, { channel: 'whatsapp', recipient: String(cust.mobile).replace(/[^\d]/g, ''), body: 'Invoice ' + invoiceNo + ' for Rs ' + money(grand) + (link ? ': ' + link : ''),
      refType: 'counter_sale', refId: saleId, templateName: 'event_invoice', templateParams: [name, invoiceNo, money(grand), link || invoiceNo] });
    if (qid) await tx.query('UPDATE b2b_counter_sales SET whatsapp_queue_id = ? WHERE id = ?', [qid, saleId]);
  }
  if (cust.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(cust.email).trim())) {
    await outbox.enqueue(tx, { channel: 'email', recipient: String(cust.email).trim(), subject: 'Your invoice ' + invoiceNo + ' from ' + e.name,
      body: outbox.emailHtml('Invoice ' + invoiceNo, ['Thank you for your purchase at ' + e.name + '.', 'Total: Rs ' + money(grand) + '.'], link || ''), refType: 'counter_sale', refId: saleId });
  }
  return qid;
}

/** A signed, read-only link to the invoice (for the customer's WhatsApp / email). */
function secret() { return process.env.ERP_JWT_SECRET || ''; }
function invoiceToken(saleId) {
  if (!secret()) return null;
  const body = Buffer.from(JSON.stringify({ s: Number(saleId) })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret()).update('invoice:' + body).digest('base64url');
}
function readInvoiceToken(t) {
  const parts = String(t || '').split('.');
  if (parts.length !== 2 || !secret()) return null;
  const want = Buffer.from(crypto.createHmac('sha256', secret()).update('invoice:' + parts[0]).digest('base64url')), got = Buffer.from(parts[1]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const o = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); return posId(o.s); } catch (e) { return null; }
}
function invoiceLink(saleId) {
  const site = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  const t = invoiceToken(saleId);
  return site && t ? site + '/api/erp/public/invoice?t=' + encodeURIComponent(t) : null;
}

async function saleView(q, id) {
  const s = await (q || db).queryOne('SELECT cs.*, e.code AS event_code, e.name AS event_name, st.name AS seller_name FROM b2b_counter_sales cs JOIN b2b_events e ON e.id = cs.event_id ' +
    'JOIN b2b_staff st ON st.id = cs.sold_by WHERE cs.id = ?', [id]);
  if (!s) throw fail(404, 'Sale not found');
  const items = await (q || db).query('SELECT * FROM b2b_counter_sale_items WHERE sale_id = ? ORDER BY id', [id]);
  const pays = await (q || db).query('SELECT p.*, st.name AS by_name FROM b2b_counter_payments p JOIN b2b_staff st ON st.id = p.recorded_by WHERE p.sale_id = ? ORDER BY p.id', [id]);
  const rets = await (q || db).query('SELECT * FROM b2b_counter_returns WHERE sale_id = ? ORDER BY id', [id]);
  return {
    id: Number(s.id), invoiceNo: s.invoice_no, event: { id: Number(s.event_id), code: s.event_code, name: s.event_name }, status: s.status, soldAt: s.sold_at, seller: s.seller_name,
    customer: { id: s.customer_id == null ? null : Number(s.customer_id), name: s.customer_name, mobile: s.customer_mobile, email: s.customer_email, gstin: s.customer_gstin },
    interstate: Number(s.is_interstate) === 1, offline: Number(s.offline) === 1,
    totals: { subtotal: Number(s.subtotal), discount: Number(s.discount_total), taxable: Number(s.taxable_total), cgst: Number(s.cgst_total), sgst: Number(s.sgst_total), igst: Number(s.igst_total),
      roundOff: Number(s.round_off), grand: Number(s.grand_total), paid: Number(s.amount_paid) }, paymentStatus: s.payment_status,
    items: items.map(function (i) { return { id: Number(i.id), productId: Number(i.product_id), sku: i.sku, name: i.name, hsn: i.hsn_code, batchNo: i.batch_no, expiry: i.expiry_date, qty: Number(i.qty),
      unitPrice: Number(i.unit_price), discount: Number(i.discount_amount), gstRate: Number(i.gst_rate), taxable: Number(i.taxable_amount), cgst: Number(i.cgst_amount), sgst: Number(i.sgst_amount),
      igst: Number(i.igst_amount), total: Number(i.line_total), returned: Number(i.returned_qty) }; }),
    payments: pays.map(function (p) { return { id: Number(p.id), method: p.method, amount: Number(p.amount), direction: p.direction, reference: p.reference, by: p.by_name, at: p.recorded_at }; }),
    returns: rets.map(function (r) { return { id: Number(r.id), returnNo: r.return_no, reason: r.reason, refund: Number(r.refund_amount), method: r.refund_method, at: r.created_at }; }),
    voided: s.status === 'voided' ? { at: s.voided_at, reason: s.void_reason } : null,
  };
}
async function getSale(principal, id) {
  const s = await db.queryOne('SELECT event_id FROM b2b_counter_sales WHERE id = ?', [posId(id)]);
  if (!s) throw fail(404, 'Sale not found');
  if (!principal.permissions.has('events.reports.view') && !(await mayAct(null, principal, s.event_id))) throw fail(403, 'You are not assigned to this event', 'event_forbidden');
  return saleView(null, posId(id));
}
async function listSales(principal, q) {
  const where = [], args = [];
  if (!principal.permissions.has('events.reports.view') && !principal.permissions.has('events.manage')) {
    const ids = await assigned(null, principal.id);
    if (!ids.length) return { items: [] };
    where.push('cs.event_id IN (' + db.placeholders(ids) + ')'); args.push.apply(args, ids);
  }
  if (posId(q.eventId)) { where.push('cs.event_id = ?'); args.push(posId(q.eventId)); }
  if (['completed', 'voided'].indexOf(q.status) !== -1) { where.push('cs.status = ?'); args.push(q.status); }
  if (day(q.from)) { where.push('cs.sold_at >= ?'); args.push(day(q.from)); }
  if (day(q.to)) { where.push('cs.sold_at < (? + INTERVAL 1 DAY)'); args.push(day(q.to)); }
  if (q.q) { where.push('(cs.invoice_no = ? OR cs.customer_mobile = ?)'); args.push(String(q.q), String(q.q).replace(/[^\d+]/g, '')); }
  const rows = await db.query('SELECT cs.id, cs.invoice_no, cs.event_id, e.code, cs.customer_name, cs.grand_total, cs.amount_paid, cs.payment_status, cs.status, cs.sold_at, cs.offline, st.name AS seller ' +
    'FROM b2b_counter_sales cs JOIN b2b_events e ON e.id = cs.event_id JOIN b2b_staff st ON st.id = cs.sold_by' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY cs.sold_at DESC, cs.id DESC LIMIT ' + db.int(q.limit, 200, 1, 1000), args);
  return { items: rows.map(function (r) { return { id: Number(r.id), invoiceNo: r.invoice_no, eventId: Number(r.event_id), eventCode: r.code, customer: r.customer_name, total: Number(r.grand_total),
    paid: Number(r.amount_paid), paymentStatus: r.payment_status, status: r.status, soldAt: r.sold_at, offline: Number(r.offline) === 1, seller: r.seller }; }) };
}

async function lockSale(tx, principal, id) {
  const s = await tx.queryOne('SELECT * FROM b2b_counter_sales WHERE id = ? FOR UPDATE', [posId(id)]);
  if (!s) throw fail(404, 'Sale not found');
  if (!(await mayAct(tx, principal, s.event_id))) throw fail(403, 'You are not assigned to this event', 'event_forbidden');
  return s;
}
function payStatus(paid, grand) { return paid <= 0 ? 'unpaid' : (paid < grand ? 'partial' : 'paid'); }

/** Take a payment later (a partial payment completed). Idempotent by its key. */
async function addPayment(tx, actor, principal, id, b) {
  const s = await lockSale(tx, principal, id);
  const key = String(b.idempotencyKey || '');
  need(/^[0-9a-zA-Z:-]{8,80}$/.test(key), 'idempotencyKey is required', 'idempotency_key');
  if (await tx.queryOne('SELECT id FROM b2b_counter_payments WHERE idempotency_key = ?', [key])) return Object.assign(await saleView(tx, s.id), { duplicate: true });
  if (s.status !== 'completed') throw fail(409, 'This invoice is voided', 'voided');
  need(METHODS.indexOf(b.method) !== -1, 'Payment method must be cash, upi, card or bank_transfer');
  const a = r2(b.amount);
  need(a > 0, 'The amount must be positive');
  const paid = r2(Number(s.amount_paid) + a);
  need(paid <= Number(s.grand_total), 'That would be more than the bill', 'overpaid');
  await tx.query("INSERT INTO b2b_counter_payments (sale_id, method, amount, direction, reference, recorded_by, idempotency_key) VALUES (?, ?, ?, 'in', ?, ?, ?)",
    [s.id, b.method, money(a), b.reference ? String(b.reference).slice(0, 80) : null, principal.id, key]);
  await tx.query('UPDATE b2b_counter_sales SET amount_paid = ?, payment_status = ? WHERE id = ?', [money(paid), payStatus(paid, Number(s.grand_total)), s.id]);
  await audit.write(tx, actor, { module: 'events', action: 'counter_sale.payment', entity: 'counter_sale', entityId: s.id, new: { method: b.method, amount: a } });
  return saleView(tx, s.id);
}

/**
 * Return some units. b = { idempotencyKey, items: [{ saleItemId, qty, condition }], reason, refundMethod }.
 * Stock goes back by condition; the refund is the returned lines' share of what was charged,
 * never more than was paid in. The invoice itself is not changed.
 */
async function returnItems(tx, actor, principal, id, b) {
  const s = await lockSale(tx, principal, id);
  const key = String(b.idempotencyKey || '');
  need(UUID.test(key), 'idempotencyKey (UUID) is required', 'idempotency_key');
  const dup = await tx.queryOne('SELECT id FROM b2b_counter_returns WHERE idempotency_key = ?', [key]);
  if (dup) return Object.assign(await saleView(tx, s.id), { duplicate: true });
  if (s.status !== 'completed') throw fail(409, 'This invoice is voided', 'voided');
  const reason = String(b.reason || '').trim();
  need(reason.length >= 5, 'Give a reason (at least 5 characters)', 'reason_required');
  const method = ['cash', 'upi', 'card', 'bank_transfer', 'none'].indexOf(b.refundMethod) !== -1 ? b.refundMethod : 'none';
  need(Array.isArray(b.items) && b.items.length, 'Choose what comes back');
  const lines = await tx.query('SELECT * FROM b2b_counter_sale_items WHERE sale_id = ? FOR UPDATE', [s.id]);
  const byId = {}; lines.forEach(function (l) { byId[Number(l.id)] = l; });
  const ret = [];
  let refund = 0;
  for (const it of b.items) {
    const l = byId[posId(it && it.saleItemId)];
    need(l, 'That line is not on this invoice', 'not_on_invoice');
    const qty = Number(it.qty);
    need(Number.isInteger(qty) && qty > 0 && qty <= Number(l.qty) - Number(l.returned_qty), 'Return at most ' + (Number(l.qty) - Number(l.returned_qty)) + ' of ' + l.name, 'too_many');
    need(CONDITIONS[it.condition], 'condition must be resaleable, damaged or expired');
    const amount = r2(Number(l.line_total) * qty / Number(l.qty));
    refund = r2(refund + amount);
    ret.push({ l: l, qty: qty, condition: it.condition, amount: amount });
  }
  const refundable = r2(Math.max(0, Number(s.amount_paid)));
  const refundNow = method === 'none' ? 0 : Math.min(refund, refundable);
  const no = await seq.next(tx, 'CR');
  const r = await tx.query('INSERT INTO b2b_counter_returns (return_no, sale_id, reason, refund_amount, refund_method, idempotency_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [no, s.id, reason.slice(0, 300), money(refundNow), method, key, principal.id]);
  for (const x of ret) {
    await tx.query('INSERT INTO b2b_counter_return_items (return_id, sale_item_id, qty, item_condition, refund_amount) VALUES (?, ?, ?, ?, ?)', [r.insertId, x.l.id, x.qty, x.condition, money(x.amount)]);
    await tx.query('UPDATE b2b_counter_sale_items SET returned_qty = returned_qty + ? WHERE id = ?', [x.qty, x.l.id]);
    const bucket = CONDITIONS[x.condition];
    await ledger.mustMove(tx, { warehouseId: s.warehouse_id, productId: x.l.product_id, batchId: x.l.batch_id, lotId: x.l.lot_id, type: 'counter_return', qty: x.qty, to: bucket,
      refType: 'counter_return', refId: Number(r.insertId), reason: (no + ': ' + reason).slice(0, 255), actor: actor, idemKey: 'cr:' + key + ':' + x.l.id });
    if (bucket === 'available') await fefo.putBack(tx, [{ batchId: x.l.batch_id ? Number(x.l.batch_id) : null, qty: x.qty }], 'available');
  }
  if (refundNow > 0) {
    await tx.query("INSERT INTO b2b_counter_payments (sale_id, method, amount, direction, reference, recorded_by, idempotency_key) VALUES (?, ?, ?, 'refund', ?, ?, ?)",
      [s.id, method, money(refundNow), no, principal.id, key + ':refund']);
    const paid = r2(Number(s.amount_paid) - refundNow);
    const allBack = lines.every(function (l) { const x = ret.find(function (y) { return Number(y.l.id) === Number(l.id); }); return Number(l.returned_qty) + (x ? x.qty : 0) >= Number(l.qty); });
    await tx.query('UPDATE b2b_counter_sales SET amount_paid = ?, payment_status = ? WHERE id = ?', [money(paid), allBack && paid <= 0 ? 'refunded' : payStatus(paid, Number(s.grand_total)), s.id]);
  }
  await audit.write(tx, actor, { module: 'events', action: 'counter_sale.returned', entity: 'counter_sale', entityId: s.id,
    new: { returnNo: no, lines: ret.map(function (x) { return { item: Number(x.l.id), qty: x.qty, condition: x.condition }; }), refund: refundNow, method: method }, reason: reason });
  return saleView(tx, s.id);
}

/** Void an invoice (wrong customer, test sale): every unit back to available, everything paid refunded. */
async function voidSale(tx, actor, principal, id, b) {
  const s = await lockSale(tx, principal, id);
  if (s.status === 'voided') return Object.assign(await saleView(tx, s.id), { duplicate: true });
  const reason = String((b && b.reason) || '').trim();
  need(reason.length >= 5, 'Give a reason (at least 5 characters)', 'reason_required');
  if (await tx.queryOne('SELECT id FROM b2b_counter_returns WHERE sale_id = ? LIMIT 1', [s.id])) throw fail(409, 'This invoice has returns: return the rest instead of voiding', 'has_returns');
  const lines = await tx.query('SELECT * FROM b2b_counter_sale_items WHERE sale_id = ?', [s.id]);
  for (const l of lines) {
    await ledger.mustMove(tx, { warehouseId: s.warehouse_id, productId: l.product_id, batchId: l.batch_id, lotId: l.lot_id, type: 'counter_return', qty: Number(l.qty), to: 'available',
      refType: 'counter_void', refId: Number(s.id), reason: ('void ' + s.invoice_no + ': ' + reason).slice(0, 255), actor: actor, idemKey: 'cv:' + s.id + ':' + l.id });
    await fefo.putBack(tx, [{ batchId: l.batch_id ? Number(l.batch_id) : null, qty: Number(l.qty) }], 'available');
  }
  const paid = Number(s.amount_paid);
  if (paid > 0) {
    await tx.query("INSERT INTO b2b_counter_payments (sale_id, method, amount, direction, reference, recorded_by, idempotency_key) VALUES (?, ?, ?, 'refund', ?, ?, ?)",
      [s.id, ['cash', 'upi', 'card', 'bank_transfer'].indexOf(b.refundMethod) !== -1 ? b.refundMethod : 'cash', money(paid), 'void', principal.id, 'void:' + s.id]);
  }
  await tx.query("UPDATE b2b_counter_sales SET status = 'voided', voided_by = ?, voided_at = UTC_TIMESTAMP(), void_reason = ?, amount_paid = 0, payment_status = ? WHERE id = ?",
    [principal.id, reason.slice(0, 300), paid > 0 ? 'refunded' : 'unpaid', s.id]);
  if (s.customer_id) await tx.query("UPDATE b2b_customer_orders SET status = 'voided' WHERE channel = 'event' AND source_order_id = ?", [String(s.id)]);
  await audit.write(tx, actor, { module: 'events', action: 'counter_sale.voided', entity: 'counter_sale', entityId: s.id, old: { status: 'completed', paid: paid }, new: { status: 'voided' }, reason: reason });
  return saleView(tx, s.id);
}

/** Event-wise report: totals, by product, by payment method, by day, returns. */
async function report(principal, q) {
  const where = ["cs.status = 'completed'"], args = [];
  if (posId(q.eventId)) {
    if (!principal.permissions.has('events.reports.view') && !(await mayAct(null, principal, posId(q.eventId)))) throw fail(403, 'You are not assigned to this event', 'event_forbidden');
    where.push('cs.event_id = ?'); args.push(posId(q.eventId));
  } else if (!principal.permissions.has('events.reports.view')) throw fail(403, 'Choose one of your events', 'event_forbidden');
  if (day(q.from)) { where.push('cs.sold_at >= ?'); args.push(day(q.from)); }
  if (day(q.to)) { where.push('cs.sold_at < (? + INTERVAL 1 DAY)'); args.push(day(q.to)); }
  const w = ' WHERE ' + where.join(' AND ');
  const totals = await db.queryOne('SELECT COUNT(*) AS invoices, COALESCE(SUM(grand_total),0) AS revenue, COALESCE(SUM(taxable_total),0) AS taxable, COALESCE(SUM(cgst_total+sgst_total+igst_total),0) AS tax, ' +
    'COALESCE(SUM(discount_total),0) AS discount, COALESCE(SUM(amount_paid),0) AS collected, COALESCE(SUM(total_qty),0) AS units FROM b2b_counter_sales cs' + w, args);
  const byEvent = await db.query('SELECT e.id, e.code, e.name, COUNT(*) AS invoices, SUM(cs.grand_total) AS revenue, SUM(cs.total_qty) AS units FROM b2b_counter_sales cs JOIN b2b_events e ON e.id = cs.event_id' + w +
    ' GROUP BY e.id, e.code, e.name ORDER BY revenue DESC', args);
  const byProduct = await db.query('SELECT i.product_id, i.sku, i.name, SUM(i.qty) AS units, SUM(i.returned_qty) AS returned, SUM(i.line_total) AS revenue FROM b2b_counter_sale_items i JOIN b2b_counter_sales cs ON cs.id = i.sale_id' + w +
    ' GROUP BY i.product_id, i.sku, i.name ORDER BY revenue DESC LIMIT 200', args);
  const byMethod = await db.query("SELECT p.method, SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END) AS net FROM b2b_counter_payments p JOIN b2b_counter_sales cs ON cs.id = p.sale_id" + w +
    ' GROUP BY p.method ORDER BY net DESC', args);
  const byDay = await db.query('SELECT DATE(cs.sold_at) AS d, COUNT(*) AS invoices, SUM(cs.grand_total) AS revenue FROM b2b_counter_sales cs' + w + ' GROUP BY DATE(cs.sold_at) ORDER BY d', args);
  const returns = await db.query('SELECT ri.item_condition, SUM(ri.qty) AS units, SUM(ri.refund_amount) AS refunded FROM b2b_counter_return_items ri JOIN b2b_counter_returns r ON r.id = ri.return_id ' +
    'JOIN b2b_counter_sales cs ON cs.id = r.sale_id' + w + ' GROUP BY ri.item_condition', args);
  const num = function (o) { const out = {}; Object.keys(o).forEach(function (k) { out[k] = o[k] != null && !isNaN(Number(o[k])) && !/(code|name|sku|method|condition|^d$)/.test(k) ? Number(o[k]) : o[k]; }); return out; };
  return { totals: num(totals), byEvent: byEvent.map(num), byProduct: byProduct.map(num), byMethod: byMethod.map(num), byDay: byDay.map(num), returns: returns.map(num) };
}

module.exports = { createEvent, setStatus, setStaff, getEvent, listEvents, eventStock, sell, addPayment, returnItems, voidSale, getSale, listSales, report, saleView,
  taxLine, invoiceToken, readInvoiceToken, invoiceLink, mayAct, METHODS, CONDITIONS };
