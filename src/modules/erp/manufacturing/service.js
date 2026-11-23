/**
 * Manufacturers and manufacturing (migration 020), on the one ledger.
 *
 * Who is who:
 *  - manufacturer (vendor capability 'manufacturer'): makes its own branded products that we buy;
 *  - contract manufacturer ('contract_manufacturer'): makes OUR products to our specification;
 *  - supplier / authorised distributor: sells goods it did not make.
 *  The same legal vendor may hold several capabilities; each is approved separately (vendors).
 *
 * Manufacturing orders (MO):
 *  - contract: we ask a (contract) manufacturer for planned_qty of a product, normally against a
 *    purchase order. The manufacturer accepts, posts production updates, records each batch with
 *    its manufacture and expiry dates and uploads the Certificate of Analysis. Our QC releases or
 *    rejects each batch BEFORE it ships: a dispatch notice (ASN) for that PO can carry only released
 *    batches, and goods enter stock through the existing goods receipt (GRN).
 *  - in_house: made in our own facility. Materials are issued from the warehouse by the bill of
 *    materials (FEFO, ledger 'production_issue'); output enters QUARANTINE as a batch (ledger
 *    'production'); QC releases it to available or rejects it to damaged. The person who recorded
 *    the output cannot release it.
 *  A batch is released only with a Certificate of Analysis or test report attached.
 *
 * Every stock change posts through ledger.move with a key, so a retry moves nothing twice.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const settings = require('../core/settings.js');
const seq = require('../lib/seq.js');
const ledger = require('../inventory/ledger.js');
const lots = require('../inventory/lots.js');
const fefo = require('../inventory/fefo.js');
const v = require('../../b2b/lib/validate.js');
const uploads = require('../../b2b/lib/uploads.js');
const { fail, posId } = require('../lib/http.js');

const MAKER_CAPS = ['manufacturer', 'contract_manufacturer'];
const OPEN = ['draft', 'released', 'accepted', 'in_production'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOC_TYPES = ['coa', 'test_report', 'production_record', 'other'];
const OVER_PRODUCTION = 0.10;   // batches may total up to 10 % above the planned quantity

function need(c, m, code) { if (!c) throw fail(400, m, code); }
function today() { return new Date().toISOString().slice(0, 10); }
function d10(x) { return x == null ? null : (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10)); }
function qtyOf(x, name) { const n = Number(x); if (!Number.isInteger(n) || n <= 0 || n > 10000000) throw fail(400, (name || 'Quantity') + ' must be a whole number above 0'); return n; }
function staffActor(a) { return { type: 'staff', id: a.id || null, label: a.label || (a.id ? 'erp-staff:' + a.id : 'system') }; }
function vendorActor(vendor) { return { type: 'vendor', id: vendor.userId, label: 'vendor-user:' + vendor.userId, role: 'vendor_' + vendor.role }; }

async function event(tx, moId, kind, who, f) {
  f = f || {};
  await tx.query('INSERT INTO b2b_mfg_order_events (mo_id, kind, stage, qty, note, actor_type, actor_id, actor_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [moId, kind, f.stage ? String(f.stage).slice(0, 60) : null, f.qty == null ? null : f.qty, f.note ? String(f.note).slice(0, 500) : null,
      who.type === 'vendor' ? 'vendor' : (who.type === 'system' ? 'system' : 'staff'), who.id || null, (who.label || '').slice(0, 160) || null]);
}

/** Email the manufacturer's main contact (queued, recorded in the Notification Center). Never fails the action. */
async function notifyVendor(tx, vendorId, title, lines, refType, refId) {
  const notif = require('../../b2b/notifications/service.js');
  const u = await tx.queryOne("SELECT u.email, vd.legal_name FROM b2b_vendor_users u JOIN b2b_vendors vd ON vd.id = u.vendor_id WHERE u.vendor_id = ? AND u.status = 'active' AND u.email IS NOT NULL ORDER BY (u.role = 'owner') DESC, u.id LIMIT 1", [vendorId]);
  if (!u) return;
  const site = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  const link = site ? site + '/vendor/' : '';
  const html = notif.emailHtml(title, lines, link);
  const rec = await notif.recordWorkflow(tx, { event: 'manufacturing.' + refType, title: title, text: title + '\n\n' + lines.join('\n') + (link ? '\n\n' + link : ''), html: html,
    channels: ['email'], refType: refType, refId: refId, queued: 1, recipients: [{ type: 'manufacturer', ref: Number(vendorId), name: u.legal_name, email: u.email }] });
  await notif.enqueue(tx, Object.assign({ channel: 'email', recipient: u.email, subject: title, body: html, refType: refType, refId: refId },
    rec ? { messageId: rec.messageId, sendId: rec.sendId, messageRecipientId: rec.rows[0] } : {}));
}

// ─────────────────────────── manufacturers ───────────────────────────

async function makerCaps(q, vendorId) {
  return (await q.query('SELECT capability, status FROM b2b_vendor_capabilities WHERE vendor_id = ?', [vendorId]))
    .filter(function (c) { return MAKER_CAPS.indexOf(c.capability) !== -1; });
}

async function assertMaker(q, vendorId) {
  const vd = await q.queryOne('SELECT id, legal_name, status FROM b2b_vendors WHERE id = ?', [vendorId]);
  if (!vd) throw fail(404, 'Manufacturer not found');
  need(vd.status === 'approved', vd.legal_name + ' is not an approved vendor (status: ' + vd.status + ')', 'vendor_not_approved');
  const caps = await makerCaps(q, vendorId);
  need(caps.some(function (c) { return c.status === 'approved'; }), vd.legal_name + ' has no approved manufacturer or contract-manufacturer capability', 'not_a_manufacturer');
  return vd;
}

/** Performance from real records: purchase orders, receipts, QC decisions and dispatch notices. */
async function performance(vendorId) {
  const po = await db.queryOne("SELECT COUNT(*) AS pos, COALESCE(SUM(grand_total), 0) AS value FROM b2b_purchase_orders WHERE vendor_id = ? AND status NOT IN ('draft','pending_approval','approved','cancelled')", [vendorId]);
  const fill = await db.queryOne("SELECT COALESCE(SUM(poi.qty_ordered), 0) AS ordered, COALESCE(SUM(poi.qty_received), 0) AS received, COALESCE(SUM(poi.qty_rejected), 0) AS rejected " +
    "FROM b2b_purchase_order_items poi JOIN b2b_purchase_orders p ON p.id = poi.po_id WHERE p.vendor_id = ? AND p.status IN ('partially_received','received','closed')", [vendorId]);
  const grn = await db.queryOne("SELECT COUNT(*) AS receipts, SUM(CASE WHEN p.delivery_by IS NOT NULL AND DATE(g.received_at) <= p.delivery_by THEN 1 ELSE 0 END) AS on_time, " +
    "SUM(CASE WHEN p.delivery_by IS NOT NULL THEN 1 ELSE 0 END) AS with_date, AVG(CASE WHEN p.sent_at IS NOT NULL THEN TIMESTAMPDIFF(HOUR, p.sent_at, g.received_at) / 24 END) AS lead_days " +
    "FROM b2b_grns g JOIN b2b_purchase_orders p ON p.id = g.po_id WHERE p.vendor_id = ? AND g.status = 'posted'", [vendorId]);
  const qc = await db.queryOne("SELECT SUM(b.status = 'released') AS released, SUM(b.status = 'rejected') AS rejected, SUM(b.status = 'submitted') AS waiting, COALESCE(SUM(b.rejected_qty), 0) AS rejected_units " +
    "FROM b2b_mfg_batches b JOIN b2b_mfg_orders m ON m.id = b.mo_id WHERE m.vendor_id = ?", [vendorId]);
  const late = await db.queryOne("SELECT COUNT(*) AS n FROM b2b_asns WHERE vendor_id = ? AND status IN ('dispatched','arrived') AND expected_at IS NOT NULL AND expected_at < UTC_TIMESTAMP()", [vendorId]);
  const pct = function (a, b) { return Number(b) > 0 ? Math.round(Number(a) * 1000 / Number(b)) / 10 : null; };
  return {
    purchaseOrders: Number(po.pos), purchaseValue: Number(po.value),
    fillRatePct: pct(fill.received, fill.ordered), receiptRejectPct: pct(fill.rejected, Number(fill.received) + Number(fill.rejected)),
    receipts: Number(grn.receipts), onTimePct: pct(grn.on_time, grn.with_date), avgLeadDays: grn.lead_days == null ? null : Math.round(Number(grn.lead_days) * 10) / 10,
    batchesReleased: Number(qc.released || 0), batchesRejected: Number(qc.rejected || 0), batchesWaiting: Number(qc.waiting || 0), unitsRejectedAtQc: Number(qc.rejected_units || 0),
    lateDeliveries: Number(late.n),
  };
}

async function listManufacturers(q) {
  q = q || {};
  const where = ["c.capability IN ('manufacturer','contract_manufacturer')"], params = [];
  if (q.q) { where.push('(vd.legal_name LIKE ? OR vd.trade_name LIKE ? OR vd.gstin = ? OR vd.vendor_code = ?)'); const like = '%' + v.text(q.q, 80) + '%'; params.push(like, like, v.text(q.q, 15).toUpperCase(), v.text(q.q, 20)); }
  if (q.status) { where.push('vd.status = ?'); params.push(String(q.status)); }
  if (q.capability && MAKER_CAPS.indexOf(q.capability) !== -1) { where.push('c.capability = ?'); params.push(q.capability); }
  const rows = await db.query(
    'SELECT vd.id, vd.vendor_code, vd.legal_name, vd.trade_name, vd.gstin, vd.fssai_licence, vd.fssai_valid_to, vd.status, ' +
    "GROUP_CONCAT(DISTINCT CONCAT(c.capability, ':', c.status) ORDER BY c.capability) AS caps, " +
    '(SELECT COUNT(*) FROM b2b_mfg_facilities f WHERE f.vendor_id = vd.id AND f.status = \'active\') AS facilities, ' +
    "(SELECT COUNT(*) FROM b2b_vendor_products vp WHERE vp.vendor_id = vd.id AND vp.status = 'approved') AS products_approved, " +
    "(SELECT COUNT(*) FROM b2b_vendor_products vp WHERE vp.vendor_id = vd.id AND vp.status IN ('submitted','under_review')) AS products_pending, " +
    "(SELECT COUNT(*) FROM b2b_mfg_orders m WHERE m.vendor_id = vd.id AND m.status IN ('released','accepted','in_production')) AS open_mos, " +
    "(SELECT COUNT(*) FROM b2b_mfg_batches b JOIN b2b_mfg_orders m ON m.id = b.mo_id WHERE m.vendor_id = vd.id AND b.status = 'submitted') AS batches_waiting, " +
    "(SELECT COUNT(*) FROM b2b_asns a WHERE a.vendor_id = vd.id AND a.status IN ('dispatched','arrived') AND a.expected_at < UTC_TIMESTAMP()) AS late_deliveries " +
    'FROM b2b_vendors vd JOIN b2b_vendor_capabilities c ON c.vendor_id = vd.id WHERE ' + where.join(' AND ') + ' GROUP BY vd.id ORDER BY vd.legal_name LIMIT 500', params);
  return { items: rows.map(function (r) {
    return { id: Number(r.id), code: r.vendor_code, name: r.legal_name, tradeName: r.trade_name, gstin: r.gstin, fssai: r.fssai_licence, fssaiValidTo: d10(r.fssai_valid_to),
      fssaiExpired: r.fssai_valid_to ? d10(r.fssai_valid_to) < today() : null, status: r.status,
      capabilities: String(r.caps || '').split(',').filter(Boolean).map(function (x) { const p = x.split(':'); return { capability: p[0], status: p[1] }; }),
      facilities: Number(r.facilities), productsApproved: Number(r.products_approved), productsPending: Number(r.products_pending), openOrders: Number(r.open_mos),
      batchesWaiting: Number(r.batches_waiting), lateDeliveries: Number(r.late_deliveries) };
  }) };
}

async function manufacturerDetail(vendorId) {
  const vd = await db.queryOne('SELECT id, vendor_code, legal_name, trade_name, gstin, pan, cin, fssai_licence, fssai_valid_to, msme_udyam, website, status, payment_terms_days, default_lead_days, categories_note, brands_note, capabilities_note, state_id, approved_at, created_at FROM b2b_vendors WHERE id = ?', [vendorId]);
  if (!vd) throw fail(404, 'Manufacturer not found');
  const caps = await db.query('SELECT capability, status FROM b2b_vendor_capabilities WHERE vendor_id = ?', [vendorId]);
  if (!caps.some(function (c) { return MAKER_CAPS.indexOf(c.capability) !== -1; })) throw fail(404, 'This vendor is not a manufacturer');
  const contact = await db.queryOne("SELECT name, email, mobile FROM b2b_vendor_users WHERE vendor_id = ? AND status = 'active' ORDER BY (role = 'owner') DESC, id LIMIT 1", [vendorId]);
  const [facilities, docs, products, prices, pos, asns, mos, batches] = await Promise.all([
    db.query('SELECT * FROM b2b_mfg_facilities WHERE vendor_id = ? ORDER BY status, name', [vendorId]),
    db.query('SELECT id, doc_type, original_name, review_status, review_note, valid_to, created_at FROM b2b_vendor_documents WHERE vendor_id = ? ORDER BY id DESC', [vendorId]),
    db.query('SELECT vp.id, vp.product_id, vp.name, vp.vendor_sku, vp.hsn_code, vp.mrp, vp.pack_size, vp.shelf_life_days, vp.moq, vp.lead_days, vp.status, vp.review_note, p.sku FROM b2b_vendor_products vp LEFT JOIN b2b_products p ON p.id = vp.product_id WHERE vp.vendor_id = ? ORDER BY vp.status, vp.name', [vendorId]),
    db.query('SELECT pl.id, pl.vendor_product_id, vp.name, pl.unit_price, pl.gst_rate, pl.valid_from, pl.valid_to, pl.status FROM b2b_vendor_price_lists pl JOIN b2b_vendor_products vp ON vp.id = pl.vendor_product_id WHERE pl.vendor_id = ? ORDER BY pl.id DESC LIMIT 100', [vendorId]),
    db.query('SELECT id, po_no, status, grand_total, delivery_by, sent_at, created_at FROM b2b_purchase_orders WHERE vendor_id = ? ORDER BY id DESC LIMIT 50', [vendorId]),
    asnList({ vendorId: vendorId, limit: 50 }),
    db.query('SELECT m.id, m.mo_no, m.mode, m.status, m.planned_qty, m.produced_qty, m.released_qty, m.rejected_qty, m.planned_end, p.sku, p.name FROM b2b_mfg_orders m JOIN b2b_products p ON p.id = m.product_id WHERE m.vendor_id = ? ORDER BY m.id DESC LIMIT 50', [vendorId]),
    db.query('SELECT b.id, b.batch_no, b.mfg_date, b.expiry_date, b.qty, b.status, b.released_qty, b.rejected_qty, b.qc_note, b.coa_document_id, m.mo_no, p.sku, p.name FROM b2b_mfg_batches b JOIN b2b_mfg_orders m ON m.id = b.mo_id JOIN b2b_products p ON p.id = b.product_id WHERE m.vendor_id = ? ORDER BY b.id DESC LIMIT 100', [vendorId]),
  ]);
  return {
    manufacturer: Object.assign(vd, { fssai_valid_to: d10(vd.fssai_valid_to), fssaiExpired: vd.fssai_valid_to ? d10(vd.fssai_valid_to) < today() : null }),
    capabilities: caps, contact: contact || null, facilities: facilities.map(facilityOut), documents: docs, products: products,
    approvedProducts: products.filter(function (p) { return p.status === 'approved'; }).length,
    pendingProducts: products.filter(function (p) { return p.status === 'submitted' || p.status === 'under_review'; }).length,
    priceLists: prices, purchaseOrders: pos, deliveries: asns.items, manufacturingOrders: mos,
    batches: batches.map(function (b) { return Object.assign(b, { mfg_date: d10(b.mfg_date), expiry_date: d10(b.expiry_date) }); }),
    rejectedBatches: batches.filter(function (b) { return b.status === 'rejected' || Number(b.rejected_qty) > 0; }).length,
    performance: await performance(vendorId),
  };
}

// ─────────────────────────── facilities ───────────────────────────

function facilityOut(f) {
  return { id: Number(f.id), vendorId: f.vendor_id == null ? null : Number(f.vendor_id), own: f.vendor_id == null, name: f.name, address: f.address, city: f.city, stateId: f.state_id, pincode: f.pincode,
    fssai: f.fssai_licence, fssaiValidTo: d10(f.fssai_valid_to), capacityPerMonth: f.capacity_per_month == null ? null : Number(f.capacity_per_month), capacityUom: f.capacity_uom,
    categories: f.categories_note, status: f.status };
}

async function listFacilities(q) {
  q = q || {};
  const where = [], params = [];
  if (q.vendorId === 'own') where.push('vendor_id IS NULL');
  else if (posId(q.vendorId)) { where.push('vendor_id = ?'); params.push(posId(q.vendorId)); }
  return { items: (await db.query('SELECT * FROM b2b_mfg_facilities' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY vendor_id IS NOT NULL, name', params)).map(facilityOut) };
}

async function saveFacility(tx, actor, b, id) {
  const name = v.text(b.name, 160);
  need(name.length >= 2, 'Give the facility a name');
  const vendorId = b.vendorId == null || b.vendorId === '' ? null : posId(b.vendorId);
  if (b.vendorId != null && b.vendorId !== '' && !vendorId) throw fail(400, 'Unknown manufacturer');
  if (vendorId) await assertMaker(tx, vendorId);
  const fssai = b.fssai ? String(b.fssai).replace(/\D/g, '') : null;
  if (fssai) need(/^\d{14}$/.test(fssai), 'An FSSAI licence number has 14 digits');
  const validTo = b.fssaiValidTo ? v.date(b.fssaiValidTo) : null;
  if (b.fssaiValidTo) need(validTo, 'Invalid FSSAI validity date');
  const pin = b.pincode ? String(b.pincode).replace(/\D/g, '') : null;
  if (pin) need(/^[1-9]\d{5}$/.test(pin), 'A pincode has 6 digits');
  const cap = b.capacityPerMonth == null || b.capacityPerMonth === '' ? null : Number(b.capacityPerMonth);
  if (cap != null) need(Number.isInteger(cap) && cap >= 0 && cap <= 1e9, 'Capacity must be a whole number');
  const stateId = b.stateId ? posId(b.stateId) : null;
  const vals = [vendorId, name, v.text(b.address, 400) || null, v.text(b.city, 80) || null, stateId, pin, fssai, validTo, cap, v.text(b.capacityUom, 20) || null, v.text(b.categories, 500) || null,
    b.status === 'inactive' ? 'inactive' : 'active'];
  try {
    if (id) {
      const old = await tx.queryOne('SELECT * FROM b2b_mfg_facilities WHERE id = ? FOR UPDATE', [id]);
      if (!old) throw fail(404, 'Facility not found');
      need(Number(old.vendor_id || 0) === Number(vendorId || 0), 'A facility cannot move to another manufacturer');
      await tx.query('UPDATE b2b_mfg_facilities SET vendor_id = ?, name = ?, address = ?, city = ?, state_id = ?, pincode = ?, fssai_licence = ?, fssai_valid_to = ?, capacity_per_month = ?, capacity_uom = ?, categories_note = ?, status = ? WHERE id = ?', vals.concat([id]));
      await audit.write(tx, actor, { module: 'manufacturing', action: 'facility.updated', entity: 'mfg_facility', entityId: id, old: facilityOut(old), new: { name: name, status: vals[11] } });
      return { id: Number(id) };
    }
    const r = await tx.query('INSERT INTO b2b_mfg_facilities (vendor_id, name, address, city, state_id, pincode, fssai_licence, fssai_valid_to, capacity_per_month, capacity_uom, categories_note, status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', vals.concat([actor.id || null]));
    await audit.write(tx, actor, { module: 'manufacturing', action: 'facility.created', entity: 'mfg_facility', entityId: r.insertId, new: { vendorId: vendorId, name: name } });
    return { id: Number(r.insertId) };
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'This manufacturer already has a facility with that name'); throw e; }
}

// ─────────────────────────── bills of materials ───────────────────────────

async function product(q, id, label) {
  const p = await q.queryOne('SELECT id, sku, name, item_kind, is_batch_tracked, shelf_life_days, manufacturer_vendor_id, uom FROM b2b_products WHERE id = ?', [id]);
  if (!p) throw fail(400, 'Unknown ' + (label || 'product'));
  return p;
}

async function listBoms(q) {
  q = q || {};
  const where = [], params = [];
  if (posId(q.productId)) { where.push('b.product_id = ?'); params.push(posId(q.productId)); }
  if (q.status) { where.push('b.status = ?'); params.push(String(q.status)); }
  const rows = await db.query('SELECT b.*, p.sku, p.name, (SELECT COUNT(*) FROM b2b_bom_lines l WHERE l.bom_id = b.id) AS lines FROM b2b_boms b JOIN b2b_products p ON p.id = b.product_id' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY p.name, b.version DESC LIMIT 500', params);
  return { items: rows.map(function (b) { return { id: Number(b.id), productId: Number(b.product_id), sku: b.sku, name: b.name, version: b.version, outputQty: b.output_qty, status: b.status, lines: Number(b.lines), note: b.note, createdBy: b.created_by, approvedAt: b.approved_at, createdAt: b.created_at }; }) };
}

async function bomDetail(q, id) {
  const b = await q.queryOne('SELECT b.*, p.sku, p.name FROM b2b_boms b JOIN b2b_products p ON p.id = b.product_id WHERE b.id = ?', [id]);
  if (!b) throw fail(404, 'Bill of materials not found');
  const lines = await q.query('SELECT l.*, p.sku, p.name, p.uom, p.item_kind FROM b2b_bom_lines l JOIN b2b_products p ON p.id = l.component_product_id WHERE l.bom_id = ? ORDER BY l.id', [id]);
  return { id: Number(b.id), productId: Number(b.product_id), sku: b.sku, name: b.name, version: b.version, outputQty: b.output_qty, status: b.status, note: b.note,
    createdBy: b.created_by, approvedBy: b.approved_by, approvedAt: b.approved_at,
    lines: lines.map(function (l) { return { id: Number(l.id), productId: Number(l.component_product_id), sku: l.sku, name: l.name, uom: l.uom, kind: l.item_kind, qty: Number(l.qty), scrapPct: Number(l.scrap_pct), note: l.note }; }) };
}

async function createBom(tx, actor, b) {
  const prodId = posId(b.productId); need(prodId, 'Choose the finished product');
  const p = await product(tx, prodId);
  need(p.item_kind === 'finished' || p.item_kind == null, p.name + ' is a ' + p.item_kind + ', not a finished product');
  const out = qtyOf(b.outputQty, 'Output quantity');
  const list = Array.isArray(b.lines) ? b.lines : [];
  need(list.length >= 1 && list.length <= 200, 'A bill of materials needs 1–200 lines');
  const seen = {};
  const clean = [];
  for (const l of list) {
    const cid = posId(l.productId); need(cid, 'Every line needs a material');
    need(cid !== prodId, 'A product cannot be a material of itself');
    need(!seen[cid], 'A material appears twice; combine the lines'); seen[cid] = true;
    const c = await product(tx, cid, 'material');
    const qty = Number(l.qty); need(qty > 0 && qty <= 1e9 && Math.round(qty * 10000) === qty * 10000, 'Material quantity must be above 0 (up to 4 decimals)');
    const scrap = l.scrapPct == null || l.scrapPct === '' ? 0 : Number(l.scrapPct); need(scrap >= 0 && scrap < 100, 'Scrap % must be 0–99.99');
    clean.push({ c: c, qty: qty, scrap: scrap, note: v.text(l.note, 200) || null });
  }
  const last = await tx.queryOne('SELECT COALESCE(MAX(version), 0) AS v FROM b2b_boms WHERE product_id = ? FOR UPDATE', [prodId]);
  const version = Number(last.v) + 1;
  const r = await tx.query("INSERT INTO b2b_boms (product_id, version, output_qty, status, note, created_by) VALUES (?, ?, ?, 'draft', ?, ?)", [prodId, version, out, v.text(b.note, 500) || null, actor.id || null]);
  for (const l of clean) await tx.query('INSERT INTO b2b_bom_lines (bom_id, component_product_id, qty, scrap_pct, note) VALUES (?, ?, ?, ?, ?)', [r.insertId, l.c.id, l.qty.toFixed(4), l.scrap.toFixed(2), l.note]);
  await audit.write(tx, actor, { module: 'manufacturing', action: 'bom.created', entity: 'bom', entityId: r.insertId, new: { productId: prodId, version: version, lines: clean.length } });
  return { id: Number(r.insertId), version: version, status: 'draft' };
}

/** Activate a draft (a different person from its author). The previous active version is archived. */
async function activateBom(tx, actor, id) {
  const b = await tx.queryOne('SELECT * FROM b2b_boms WHERE id = ? FOR UPDATE', [id]);
  if (!b) throw fail(404, 'Bill of materials not found');
  if (b.status !== 'draft') throw fail(409, 'Only a draft can be activated (this one is ' + b.status + ')');
  if (b.created_by && actor.id && Number(b.created_by) === Number(actor.id)) throw fail(403, 'A different person must activate the bill of materials you wrote', 'same_person');
  const prev = await tx.queryOne("SELECT id FROM b2b_boms WHERE product_id = ? AND status = 'active' FOR UPDATE", [b.product_id]);
  if (prev) await tx.query("UPDATE b2b_boms SET status = 'archived' WHERE id = ?", [prev.id]);
  await tx.query("UPDATE b2b_boms SET status = 'active', approved_by = ?, approved_at = UTC_TIMESTAMP() WHERE id = ?", [actor.id || null, id]);
  await audit.write(tx, actor, { module: 'manufacturing', action: 'bom.activated', entity: 'bom', entityId: id, old: { previousActive: prev ? Number(prev.id) : null }, new: { status: 'active' } });
  return { id: Number(id), status: 'active', archived: prev ? Number(prev.id) : null };
}

async function archiveBom(tx, actor, id) {
  const b = await tx.queryOne('SELECT * FROM b2b_boms WHERE id = ? FOR UPDATE', [id]);
  if (!b) throw fail(404, 'Bill of materials not found');
  if (b.status === 'archived') return { id: Number(id), status: 'archived' };
  const used = await tx.queryOne("SELECT COUNT(*) AS n FROM b2b_mfg_orders WHERE bom_id = ? AND status IN ('released','accepted','in_production')", [id]);
  need(Number(used.n) === 0, 'Open manufacturing orders use this bill of materials; finish or cancel them first', 'bom_in_use');
  await tx.query("UPDATE b2b_boms SET status = 'archived' WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'manufacturing', action: 'bom.archived', entity: 'bom', entityId: id, old: { status: b.status }, new: { status: 'archived' } });
  return { id: Number(id), status: 'archived' };
}

/** Units of each material an order needs: qty per output × planned / output, plus scrap, rounded up. */
function requirement(lines, outputQty, planned) {
  return lines.map(function (l) {
    const need0 = Number(l.qty) * Number(planned) / Number(outputQty) * (1 + Number(l.scrapPct || l.scrap_pct || 0) / 100);
    return { productId: Number(l.productId || l.component_product_id), required: Math.ceil(need0 - 1e-9) };
  });
}

// ─────────────────────────── manufacturing orders ───────────────────────────

async function lockMo(tx, id) {
  const m = await tx.queryOne('SELECT * FROM b2b_mfg_orders WHERE id = ? FOR UPDATE', [id]);
  if (!m) throw fail(404, 'Manufacturing order not found');
  return m;
}

async function createMo(tx, actor, b) {
  const mode = b.mode === 'in_house' ? 'in_house' : (b.mode === 'contract' ? 'contract' : null);
  need(mode, 'mode must be contract or in_house');
  const prodId = posId(b.productId); need(prodId, 'Choose the product to make');
  const p = await product(tx, prodId);
  need(p.item_kind === 'finished' || p.item_kind == null, p.name + ' is a ' + p.item_kind + ', not a finished product');
  const planned = qtyOf(b.plannedQty, 'Planned quantity');
  const whId = posId(b.warehouseId); need(whId, 'Choose the warehouse');
  const wh = await tx.queryOne('SELECT id, warehouse_type, is_active FROM b2b_warehouses WHERE id = ?', [whId]);
  need(wh && wh.warehouse_type === 'company' && Number(wh.is_active) !== 0, 'Choose an active company warehouse');
  const start = b.plannedStart ? v.date(b.plannedStart) : null, end = b.plannedEnd ? v.date(b.plannedEnd) : null;
  if (b.plannedStart) need(start, 'Invalid start date');
  if (b.plannedEnd) need(end, 'Invalid end date');
  if (start && end) need(end >= start, 'The end date must not be before the start date');
  let vendorId = null, facilityId = null, bomId = null, poId = null;
  if (b.facilityId) {
    facilityId = posId(b.facilityId); need(facilityId, 'Unknown facility');
  }
  if (mode === 'contract') {
    vendorId = posId(b.vendorId); need(vendorId, 'Choose the manufacturer');
    await assertMaker(tx, vendorId);
    if (b.poId) {
      poId = posId(b.poId); need(poId, 'Unknown purchase order');
      const po = await tx.queryOne('SELECT id, vendor_id, status, ship_to_warehouse_id FROM b2b_purchase_orders WHERE id = ?', [poId]);
      need(po && Number(po.vendor_id) === vendorId, 'The purchase order must be with the same manufacturer');
      need(['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'partially_accepted', 'partially_received'].indexOf(po.status) !== -1, 'The purchase order is ' + po.status);
      const line = await tx.queryOne('SELECT id FROM b2b_purchase_order_items WHERE po_id = ? AND product_id = ? LIMIT 1', [poId, prodId]);
      need(line, 'The purchase order has no line for ' + p.name);
      need(Number(po.ship_to_warehouse_id) === whId, 'The warehouse must be the purchase order\'s delivery warehouse');
    }
  } else {
    need(!b.vendorId, 'An in-house order has no outside manufacturer');
    const bom = b.bomId ? await tx.queryOne('SELECT id, product_id, status FROM b2b_boms WHERE id = ?', [posId(b.bomId)])
      : await tx.queryOne("SELECT id, product_id, status FROM b2b_boms WHERE product_id = ? AND status = 'active'", [prodId]);
    need(bom && Number(bom.product_id) === prodId && bom.status === 'active', 'An in-house order needs an active bill of materials for ' + p.name, 'no_active_bom');
    bomId = Number(bom.id);
  }
  if (facilityId) {
    const f = await tx.queryOne('SELECT id, vendor_id, status FROM b2b_mfg_facilities WHERE id = ?', [facilityId]);
    need(f && f.status === 'active', 'Choose an active facility');
    need(Number(f.vendor_id || 0) === Number(vendorId || 0), mode === 'contract' ? 'The facility must belong to the manufacturer' : 'An in-house order runs in one of our own facilities');
  }
  const no = await seq.next(tx, 'MO');
  const r = await tx.query("INSERT INTO b2b_mfg_orders (mo_no, mode, vendor_id, facility_id, product_id, bom_id, po_id, warehouse_id, planned_qty, planned_start, planned_end, status, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)",
    [no, mode, vendorId, facilityId, prodId, bomId, poId, whId, planned, start, end, v.text(b.note, 500) || null, actor.id || null]);
  await event(tx, r.insertId, 'status', staffActor(actor), { stage: 'draft', note: 'Created' });
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mo.created', entity: 'mfg_order', entityId: r.insertId, new: { moNo: no, mode: mode, productId: prodId, plannedQty: planned, vendorId: vendorId, poId: poId } });
  return { id: Number(r.insertId), moNo: no, status: 'draft' };
}

async function setStatus(tx, m, to, who, note, extraSet) {
  const col = { released: 'released_at', accepted: 'accepted_at', in_production: 'started_at', completed: 'completed_at', closed: 'closed_at' }[to];
  await tx.query('UPDATE b2b_mfg_orders SET status = ?' + (col ? ', ' + col + ' = UTC_TIMESTAMP()' : '') + (extraSet || '') + ' WHERE id = ?', [to, m.id]);
  await event(tx, m.id, 'status', who, { stage: to, note: note });
}

/** draft → released: the manufacturer (contract) or the floor (in-house) may start. */
async function releaseMo(tx, actor, id) {
  const m = await lockMo(tx, id);
  if (m.status !== 'draft') throw fail(409, 'Only a draft can be released (this order is ' + m.status + ')');
  if (m.mode === 'contract') await assertMaker(tx, m.vendor_id);
  await setStatus(tx, m, 'released', staffActor(actor), 'Released');
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mo.released', entity: 'mfg_order', entityId: id, new: { status: 'released' } });
  if (m.mode === 'contract') {
    const p = await product(tx, m.product_id);
    await notifyVendor(tx, m.vendor_id, 'New manufacturing order ' + m.mo_no, [p.name + ' — ' + m.planned_qty + ' units' + (m.planned_end ? ', needed by ' + d10(m.planned_end) : '') + '.',
      'Please accept it in the supplier portal, then post production updates, record each batch and upload its Certificate of Analysis.'], 'mfg_order', m.id);
  }
  return { id: Number(id), status: 'released' };
}

async function cancelMo(tx, actor, id, reason) {
  const m = await lockMo(tx, id);
  reason = v.text(reason, 300);
  need(reason.length >= 5, 'Give a reason (at least 5 characters)');
  if (['draft', 'released', 'accepted'].indexOf(m.status) === -1) throw fail(409, 'An order that is ' + m.status + ' cannot be cancelled; complete or close it instead');
  const batches = await tx.queryOne('SELECT COUNT(*) AS n FROM b2b_mfg_batches WHERE mo_id = ?', [id]);
  need(Number(batches.n) === 0, 'Batches were recorded on this order; it cannot be cancelled');
  const issued = await netIssued(tx, id);
  need(Object.keys(issued).every(function (k) { return issued[k] === 0; }), 'Materials were issued to this order; return them to the warehouse first', 'materials_issued');
  await tx.query('UPDATE b2b_mfg_orders SET cancel_reason = ? WHERE id = ?', [reason, id]);
  await setStatus(tx, m, 'cancelled', staffActor(actor), reason);
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mo.cancelled', entity: 'mfg_order', entityId: id, old: { status: m.status }, new: { status: 'cancelled', reason: reason } });
  if (m.mode === 'contract' && m.status !== 'draft') await notifyVendor(tx, m.vendor_id, 'Manufacturing order ' + m.mo_no + ' was cancelled', ['Reason: ' + reason], 'mfg_order', m.id);
  return { id: Number(id), status: 'cancelled' };
}

/** in_production → completed (no more batches); completed → closed once every batch has a QC decision. */
async function completeMo(tx, actor, id) {
  const m = await lockMo(tx, id);
  if (m.status !== 'in_production') throw fail(409, 'Only an order in production can be completed (this one is ' + m.status + ')');
  await setStatus(tx, m, 'completed', staffActor(actor), 'Production completed');
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mo.completed', entity: 'mfg_order', entityId: id, new: { produced: m.produced_qty } });
  return { id: Number(id), status: 'completed' };
}
async function closeMo(tx, actor, id) {
  const m = await lockMo(tx, id);
  if (m.status !== 'completed') throw fail(409, 'Complete the order before closing it');
  const waiting = await tx.queryOne("SELECT COUNT(*) AS n FROM b2b_mfg_batches WHERE mo_id = ? AND status = 'submitted'", [id]);
  need(Number(waiting.n) === 0, 'Some batches are still waiting for a QC decision', 'qc_pending');
  await setStatus(tx, m, 'closed', staffActor(actor), 'Closed');
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mo.closed', entity: 'mfg_order', entityId: id, new: { released: m.released_qty, rejected: m.rejected_qty } });
  return { id: Number(id), status: 'closed' };
}

/** Production update: a stage, a quantity made so far, a note. Moves released/accepted → in_production. */
async function progress(tx, who, m, b) {
  const stage = v.text(b.stage, 60), note = v.text(b.note, 500);
  need(stage || note, 'Say what happened (a stage or a note)');
  const qty = b.qty == null || b.qty === '' ? null : Number(b.qty);
  if (qty != null) need(Number.isInteger(qty) && qty >= 0 && qty <= 10000000, 'Quantity must be a whole number');
  need(['released', 'accepted', 'in_production'].indexOf(m.status) !== -1, 'Updates can be posted while the order is released, accepted or in production (it is ' + m.status + ')');
  if (m.mode === 'contract' && m.status === 'released') throw fail(409, 'The manufacturer must accept the order first', 'not_accepted');
  if (m.status !== 'in_production') await setStatus(tx, m, 'in_production', who, 'Production started');
  await event(tx, m.id, 'progress', who, { stage: stage, qty: qty, note: note });
  return { id: Number(m.id), status: 'in_production' };
}
async function staffProgress(tx, actor, id, b) {
  const m = await lockMo(tx, id);
  const r = await progress(tx, staffActor(actor), m, b);
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mo.progress', entity: 'mfg_order', entityId: id, new: { stage: v.text(b.stage, 60) || null } });
  return r;
}

// ── materials (in-house) ──
async function netIssued(q, moId) {
  const rows = await q.query("SELECT product_id, SUM(CASE WHEN kind = 'issue' THEN qty ELSE -qty END) AS n FROM b2b_mfg_material_issues WHERE mo_id = ? GROUP BY product_id", [moId]);
  const out = {}; rows.forEach(function (r) { out[r.product_id] = Number(r.n); });
  return out;
}

/**
 * Issue materials to an in-house order (FEFO, never expired). b = { idempotencyKey, lines: [{ productId, qty }] }.
 * Only materials of the order's bill of materials; more than its requirement needs a reason.
 */
async function issueMaterials(tx, actor, id, b) {
  const key = String(b.idempotencyKey || '');
  need(UUID.test(key), 'idempotencyKey must be a UUID made on the device', 'bad_key');
  const m = await lockMo(tx, id);
  need(m.mode === 'in_house', 'Materials are issued only to in-house orders');
  const again = await tx.queryOne('SELECT COUNT(*) AS n FROM b2b_mfg_material_issues WHERE idem_key LIKE ?', ['mi:' + key + ':%']);
  if (Number(again.n) > 0) return { id: Number(id), duplicate: true };
  need(['released', 'in_production'].indexOf(m.status) !== -1, 'Materials can be issued while the order is released or in production');
  const bom = await bomDetail(tx, m.bom_id);
  const req = {}; requirement(bom.lines, bom.outputQty, m.planned_qty).forEach(function (r) { req[r.productId] = r.required; });
  const issued = await netIssued(tx, id);
  const list = Array.isArray(b.lines) ? b.lines : [];
  need(list.length >= 1 && list.length <= 100, 'Issue at least one material');
  const over = [];
  const picksOut = [];
  const sorted = list.map(function (l) { return { productId: posId(l.productId), qty: qtyOf(l.qty) }; }).sort(function (a, c) { return a.productId - c.productId; });
  for (const l of sorted) {
    need(req[l.productId] != null, 'Product ' + l.productId + ' is not on the bill of materials');
    if ((issued[l.productId] || 0) + l.qty > req[l.productId]) over.push(l.productId);
  }
  const reason = v.text(b.reason, 300);
  if (over.length) need(reason.length >= 5, 'More than the bill of materials needs is being issued for product(s) ' + over.join(', ') + ': give a reason', 'over_issue');
  let n = 0;
  for (const l of sorted) {
    const picks = await fefo.pick(tx, m.warehouse_id, l.productId, l.qty);
    for (const pk of picks) {
      const ik = 'mi:' + key + ':' + l.productId + ':' + (pk.batchId || 0);
      await ledger.mustMove(tx, { warehouseId: m.warehouse_id, productId: l.productId, batchId: pk.batchId, lotId: pk.lotId, type: 'production_issue', qty: pk.qty, from: 'available',
        refType: 'mfg_order', refId: m.id, reason: over.indexOf(l.productId) !== -1 ? 'over issue: ' + reason : 'issued to ' + m.mo_no, actor: actor, idemKey: ik });
      await tx.query("INSERT INTO b2b_mfg_material_issues (mo_id, product_id, warehouse_id, batch_id, qty, kind, idem_key, issued_by) VALUES (?, ?, ?, ?, ?, 'issue', ?, ?)",
        [m.id, l.productId, m.warehouse_id, pk.batchId, pk.qty, ik, actor.id || null]);
      picksOut.push({ productId: l.productId, batchId: pk.batchId, batchNo: pk.batchNo, qty: pk.qty });
      n += pk.qty;
    }
  }
  if (m.status === 'released') await setStatus(tx, m, 'in_production', staffActor(actor), 'Materials issued');
  await event(tx, m.id, 'material_issue', staffActor(actor), { qty: n, note: sorted.map(function (l) { return l.productId + '×' + l.qty; }).join(', ') + (over.length ? ' · over: ' + reason : '') });
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mo.materials_issued', entity: 'mfg_order', entityId: id, new: { picks: picksOut, over: over } });
  return { id: Number(id), issued: picksOut };
}

/** Unused materials back to available (to the batch they came from). b = { idempotencyKey, lines: [{ productId, batchId?, qty }] } */
async function returnMaterials(tx, actor, id, b) {
  const key = String(b.idempotencyKey || '');
  need(UUID.test(key), 'idempotencyKey must be a UUID made on the device', 'bad_key');
  const m = await lockMo(tx, id);
  need(m.mode === 'in_house', 'Only in-house orders have issued materials');
  const again = await tx.queryOne('SELECT COUNT(*) AS n FROM b2b_mfg_material_issues WHERE idem_key LIKE ?', ['mr:' + key + ':%']);
  if (Number(again.n) > 0) return { id: Number(id), duplicate: true };
  const list = Array.isArray(b.lines) ? b.lines : [];
  need(list.length >= 1, 'Return at least one material');
  const back = [];
  for (const l of list) {
    const pid = posId(l.productId), bid = l.batchId ? posId(l.batchId) : null, qty = qtyOf(l.qty);
    const have = await tx.queryOne("SELECT COALESCE(SUM(CASE WHEN kind = 'issue' THEN qty ELSE -qty END), 0) AS n FROM b2b_mfg_material_issues WHERE mo_id = ? AND product_id = ? AND " + (bid ? 'batch_id = ?' : 'batch_id IS NULL'),
      bid ? [id, pid, bid] : [id, pid]);
    need(Number(have.n) >= qty, 'Only ' + Number(have.n) + ' of product ' + pid + (bid ? ' (batch ' + bid + ')' : '') + ' were issued to this order', 'over_return');
    const ik = 'mr:' + key + ':' + pid + ':' + (bid || 0);
    let lotId = null;
    if (bid) {
      const bt = await tx.queryOne('SELECT lot_id FROM b2b_batches WHERE id = ? FOR UPDATE', [bid]);
      lotId = bt ? bt.lot_id : null;
    }
    await ledger.mustMove(tx, { warehouseId: m.warehouse_id, productId: pid, batchId: bid, lotId: lotId, type: 'return', qty: qty, to: 'available', refType: 'mfg_order', refId: m.id,
      reason: 'unused material returned from ' + m.mo_no, actor: actor, idemKey: ik });
    if (bid) await tx.query("UPDATE b2b_batches SET qty_on_hand = qty_on_hand + ?, status = 'active' WHERE id = ?", [qty, bid]);
    await tx.query("INSERT INTO b2b_mfg_material_issues (mo_id, product_id, warehouse_id, batch_id, qty, kind, idem_key, issued_by) VALUES (?, ?, ?, ?, ?, 'return', ?, ?)", [m.id, pid, m.warehouse_id, bid, qty, ik, actor.id || null]);
    back.push({ productId: pid, batchId: bid, qty: qty });
  }
  await event(tx, m.id, 'material_issue', staffActor(actor), { note: 'returned ' + back.map(function (x) { return x.productId + '×' + x.qty; }).join(', ') });
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mo.materials_returned', entity: 'mfg_order', entityId: id, new: { lines: back } });
  return { id: Number(id), returned: back };
}

// ── batches and documents ──
function cleanBatch(b, p) {
  const batchNo = v.text(b.batchNo, 60);
  const norm = lots.normBatch(batchNo);
  need(norm, 'Give the batch number');
  const mfg = v.date(b.mfgDate), exp = v.date(b.expiryDate);
  need(mfg && exp, 'Manufacture and expiry dates are required');
  need(exp > mfg, 'Expiry must be after manufacture');
  need(mfg <= today(), 'The manufacture date cannot be in the future');
  need(exp > today(), 'This batch has already expired');
  if (p.shelf_life_days) {
    const days = Math.round((Date.parse(exp) - Date.parse(mfg)) / 86400000);
    need(days <= Number(p.shelf_life_days) + 1, 'Expiry is ' + days + ' days after manufacture; ' + p.name + ' has a shelf life of ' + p.shelf_life_days + ' days');
  }
  return { batchNo: batchNo, norm: norm, mfg: mfg, exp: exp, qty: qtyOf(b.qty) };
}

/**
 * Record a manufactured batch. Contract: by the manufacturer (or staff for it) — no stock yet.
 * In-house: by staff with manufacturing.issue — the units enter QUARANTINE at the order's warehouse,
 * as a lot whose manufacturer is the vendor record decided for our own plant.
 */
async function recordBatch(tx, who, m, b) {
  need(['accepted', 'in_production', 'released'].indexOf(m.status) !== -1, 'Batches can be recorded while the order is in production (it is ' + m.status + ')');
  if (m.mode === 'contract') need(m.status !== 'released', 'The manufacturer must accept the order first', 'not_accepted');
  const p = await product(tx, m.product_id);
  const c = cleanBatch(b, p);
  const produced = Number(m.produced_qty) + c.qty;
  need(produced <= Math.floor(Number(m.planned_qty) * (1 + OVER_PRODUCTION)), 'Batches would total ' + produced + ', more than 10% above the planned ' + m.planned_qty, 'over_production');
  let ownMaker = null;
  if (m.mode === 'in_house') {
    ownMaker = await settings.get('manufacturing.own_manufacturer_vendor_id');
    need(ownMaker, 'Decide which vendor record stands for our own plant first (Administration → Business Decisions → manufacturing.own_manufacturer_vendor_id)', 'own_maker_undecided');
  }
  const maker = m.mode === 'contract' ? m.vendor_id : ownMaker;
  const clash = await tx.queryOne('SELECT expiry_date, status FROM b2b_lots WHERE product_id = ? AND manufacturer_vendor_id = ? AND batch_no_norm = ?', [m.product_id, maker, c.norm]);
  if (clash) need(false, 'Batch ' + c.batchNo + ' of this product already exists from this manufacturer (expiry ' + d10(clash.expiry_date) + ', ' + clash.status + '); use a new batch number', 'batch_exists');
  const coa = b.coaDocumentId ? posId(b.coaDocumentId) : null;
  if (coa) {
    const d = await tx.queryOne('SELECT id, mo_id, batch_id, doc_type FROM b2b_mfg_documents WHERE id = ?', [coa]);
    need(d && Number(d.mo_id) === Number(m.id) && !d.batch_id && (d.doc_type === 'coa' || d.doc_type === 'test_report'), 'The certificate must be a CoA or test report uploaded on this order and not yet used');
  }
  let r;
  try {
    r = await tx.query('INSERT INTO b2b_mfg_batches (mo_id, product_id, batch_no, batch_no_norm, mfg_date, expiry_date, qty, status, coa_document_id, created_by_type, created_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, \'submitted\', ?, ?, ?)',
      [m.id, m.product_id, c.batchNo, c.norm, c.mfg, c.exp, c.qty, coa, who.type === 'vendor' ? 'vendor' : 'staff', who.id || null]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'Batch ' + c.batchNo + ' is already recorded on this order'); throw e; }
  const batchRowId = Number(r.insertId);
  if (coa) await tx.query('UPDATE b2b_mfg_documents SET batch_id = ? WHERE id = ?', [batchRowId, coa]);
  if (m.mode === 'in_house') {
    const lot = await lots.upsert(tx, { productId: m.product_id, manufacturerId: maker, batchNo: c.batchNo, mfg: c.mfg, expiry: c.exp, mrp: null });
    const stockBatch = await ledger.batchFor(tx, m.warehouse_id, lot);
    await ledger.mustMove(tx, { warehouseId: m.warehouse_id, productId: m.product_id, batchId: stockBatch, lotId: lot.id, type: 'production', qty: c.qty, to: 'quarantine',
      refType: 'mfg_batch', refId: batchRowId, reason: 'made on ' + m.mo_no + ', waiting for QC', actor: who.type === 'vendor' ? { type: 'system', label: who.label } : who, idemKey: 'mfgb:' + batchRowId + ':output' });
    await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine + ? WHERE id = ?', [c.qty, stockBatch]);
    await tx.query('UPDATE b2b_mfg_batches SET lot_id = ?, stock_batch_id = ? WHERE id = ?', [lot.id, stockBatch, batchRowId]);
  }
  await tx.query('UPDATE b2b_mfg_orders SET produced_qty = produced_qty + ? WHERE id = ?', [c.qty, m.id]);
  if (m.status !== 'in_production') await setStatus(tx, m, 'in_production', who, 'Production started');
  await event(tx, m.id, 'batch', who, { stage: c.batchNo, qty: c.qty, note: 'mfg ' + c.mfg + ', expiry ' + c.exp });
  return { batchId: batchRowId, batchNo: c.batchNo, status: 'submitted' };
}

async function staffBatch(tx, actor, id, b) {
  const m = await lockMo(tx, id);
  const r = await recordBatch(tx, staffActor(actor), m, b);
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mfg_batch.recorded', entity: 'mfg_batch', entityId: r.batchId, new: { moId: Number(id), batchNo: r.batchNo, qty: Number(b.qty) } });
  return r;
}

/** Checks before the file is stored (so a bad request stores nothing). */
function checkDocumentRequest(file, b) {
  need(file, 'Attach the file as "file"');
  const type = String((b || {}).docType || '');
  need(DOC_TYPES.indexOf(type) !== -1, 'docType must be one of ' + DOC_TYPES.join(', '));
  return type;
}
/** saved = the stored file (uploads.withDocument stores it before the transaction and removes it if this fails). */
async function saveDocument(tx, who, m, saved, b) {
  const type = checkDocumentRequest(saved, b);
  need(m.status !== 'cancelled', 'This order was cancelled');
  let batchId = null;
  if (b.batchId) {
    batchId = posId(b.batchId);
    const bt = await tx.queryOne('SELECT id, mo_id, coa_document_id FROM b2b_mfg_batches WHERE id = ?', [batchId]);
    need(bt && Number(bt.mo_id) === Number(m.id), 'Unknown batch on this order');
  }
  const r = await tx.query('INSERT INTO b2b_mfg_documents (mo_id, batch_id, doc_type, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by_type, uploaded_by_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [m.id, batchId, type, saved.originalName, saved.storedName, saved.mime, saved.size, saved.sha256, who.type === 'vendor' ? 'vendor' : 'staff', who.id || null]);
  if (batchId && (type === 'coa' || type === 'test_report')) await tx.query('UPDATE b2b_mfg_batches SET coa_document_id = COALESCE(coa_document_id, ?) WHERE id = ?', [r.insertId, batchId]);
  await event(tx, m.id, 'document', who, { stage: type, note: saved.originalName });
  return { documentId: Number(r.insertId), docType: type };
}

async function documentFile(q, docId, vendorId) {
  const d = await q.queryOne('SELECT d.*, m.vendor_id FROM b2b_mfg_documents d JOIN b2b_mfg_orders m ON m.id = d.mo_id WHERE d.id = ?', [docId]);
  if (!d || (vendorId != null && Number(d.vendor_id) !== Number(vendorId))) throw fail(404, 'Document not found');
  return {
    mime: d.mime_type, name: d.original_name,
    /** Sends the file (headers and before() only once it exists); a missing file is a 404. */
    send: async function (res, headers, before) {
      if (!(await uploads.sendDocument(res, d.stored_name, headers, before))) throw fail(404, 'Document not found');
    },
  };
}

/**
 * QC decision on a batch: b = { result: pass|fail|partial, releasedQty?, rejectedQty?, note, checklist? }.
 * pass = everything released; fail = everything rejected; partial = both, adding up to the batch.
 * Needs a CoA or test report on the batch. In-house: quarantine → available / → damaged, and the
 * person who recorded the output cannot release it. Contract: no stock moves (goods arrive by GRN);
 * only released batches can be put on a dispatch notice.
 */
async function qcDecide(tx, actor, batchId, b) {
  const bt = await tx.queryOne('SELECT * FROM b2b_mfg_batches WHERE id = ? FOR UPDATE', [batchId]);
  if (!bt) throw fail(404, 'Batch not found');
  if (bt.status !== 'submitted') throw fail(409, 'This batch already has a QC decision (' + bt.status + ')');
  const m = await lockMo(tx, bt.mo_id);
  need(m.status !== 'cancelled', 'This order was cancelled');
  const result = String(b.result || '');
  need(['pass', 'fail', 'partial'].indexOf(result) !== -1, 'result must be pass, fail or partial');
  const note = v.text(b.note, 500);
  need(note.length >= 3, 'Write what QC found (a short note)');
  const qty = Number(bt.qty);
  let rel = result === 'pass' ? qty : (result === 'fail' ? 0 : Number(b.releasedQty));
  let rej = result === 'pass' ? 0 : (result === 'fail' ? qty : Number(b.rejectedQty));
  need(Number.isInteger(rel) && Number.isInteger(rej) && rel >= 0 && rej >= 0 && rel + rej === qty, 'Released + rejected must equal the batch quantity (' + qty + ')');
  if (result === 'partial') need(rel > 0 && rej > 0, 'A partial decision releases some and rejects some');
  if (rel > 0) {
    const doc = await tx.queryOne("SELECT id FROM b2b_mfg_documents WHERE batch_id = ? AND doc_type IN ('coa','test_report') LIMIT 1", [batchId]);
    need(doc || bt.coa_document_id, 'Attach the Certificate of Analysis or test report before releasing', 'coa_required');
  }
  if (bt.created_by_type === 'staff' && bt.created_by_id && actor.id && Number(bt.created_by_id) === Number(actor.id)) {
    throw fail(403, 'A different person must decide QC on a batch you recorded', 'same_person');
  }
  if (m.mode === 'in_house') {
    if (rel) {
      await ledger.mustMove(tx, { warehouseId: m.warehouse_id, productId: bt.product_id, batchId: bt.stock_batch_id, lotId: bt.lot_id, type: 'quarantine_out', qty: rel, from: 'quarantine', to: 'available',
        refType: 'mfg_batch', refId: bt.id, reason: 'QC released: ' + note, actor: actor, idemKey: 'mfgb:' + bt.id + ':released' });
      await tx.query("UPDATE b2b_batches SET qty_quarantine = qty_quarantine - ?, qty_on_hand = qty_on_hand + ?, status = 'active' WHERE id = ?", [rel, rel, bt.stock_batch_id]);
    }
    if (rej) {
      await ledger.mustMove(tx, { warehouseId: m.warehouse_id, productId: bt.product_id, batchId: bt.stock_batch_id, lotId: bt.lot_id, type: 'damage', qty: rej, from: 'quarantine', to: 'damaged',
        refType: 'mfg_batch', refId: bt.id, reason: 'QC rejected: ' + note, actor: actor, idemKey: 'mfgb:' + bt.id + ':rejected' });
      await tx.query('UPDATE b2b_batches SET qty_quarantine = qty_quarantine - ? WHERE id = ?', [rej, bt.stock_batch_id]);
    }
  }
  const status = rel > 0 ? 'released' : 'rejected';
  await tx.query('UPDATE b2b_mfg_batches SET status = ?, released_qty = ?, rejected_qty = ?, qc_note = ?, qc_checklist_json = ?, qc_by = ?, qc_at = UTC_TIMESTAMP() WHERE id = ?',
    [status, rel, rej, note, b.checklist ? JSON.stringify(b.checklist).slice(0, 5000) : null, actor.id || null, bt.id]);
  await tx.query('UPDATE b2b_mfg_orders SET released_qty = released_qty + ?, rejected_qty = rejected_qty + ? WHERE id = ?', [rel, rej, m.id]);
  await event(tx, m.id, 'qc', staffActor(actor), { stage: bt.batch_no + ' ' + status, qty: rel, note: (rej ? rej + ' rejected · ' : '') + note });
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mfg_batch.qc_' + status, entity: 'mfg_batch', entityId: bt.id, new: { result: result, released: rel, rejected: rej, note: note } });
  if (m.mode === 'contract') {
    await notifyVendor(tx, m.vendor_id, 'Batch ' + bt.batch_no + ' (' + m.mo_no + '): ' + (status === 'released' ? 'released for dispatch' : 'rejected'),
      [rel ? rel + ' units released for dispatch. Put this batch on your dispatch notice.' : 'The batch failed quality control and must not be dispatched.', rej ? rej + ' units rejected.' : '', 'QC note: ' + note].filter(Boolean), 'mfg_batch', bt.id);
  }
  return { batchId: Number(bt.id), status: status, releasedQty: rel, rejectedQty: rej };
}

// ── reading ──
function moOut(m) {
  return { id: Number(m.id), moNo: m.mo_no, mode: m.mode, vendorId: m.vendor_id == null ? null : Number(m.vendor_id), vendor: m.vendor_name || null, facilityId: m.facility_id == null ? null : Number(m.facility_id), facility: m.facility_name || null,
    productId: Number(m.product_id), sku: m.sku, product: m.product_name, bomId: m.bom_id == null ? null : Number(m.bom_id), poId: m.po_id == null ? null : Number(m.po_id), poNo: m.po_no || null,
    warehouseId: Number(m.warehouse_id), warehouse: m.warehouse_code || null, plannedQty: Number(m.planned_qty), producedQty: Number(m.produced_qty), releasedQty: Number(m.released_qty), rejectedQty: Number(m.rejected_qty),
    plannedStart: d10(m.planned_start), plannedEnd: d10(m.planned_end), status: m.status, note: m.note, cancelReason: m.cancel_reason,
    late: !!(m.planned_end && OPEN.indexOf(m.status) !== -1 && d10(m.planned_end) < today()), createdAt: m.created_at };
}
const MO_SELECT = 'SELECT m.*, vd.legal_name AS vendor_name, f.name AS facility_name, p.sku, p.name AS product_name, po.po_no, w.code AS warehouse_code FROM b2b_mfg_orders m ' +
  'JOIN b2b_products p ON p.id = m.product_id LEFT JOIN b2b_vendors vd ON vd.id = m.vendor_id LEFT JOIN b2b_mfg_facilities f ON f.id = m.facility_id ' +
  'LEFT JOIN b2b_purchase_orders po ON po.id = m.po_id LEFT JOIN b2b_warehouses w ON w.id = m.warehouse_id';

async function listMos(q, vendorId) {
  q = q || {};
  const where = [], params = [];
  if (vendorId != null) { where.push('m.vendor_id = ?', "m.status <> 'draft'"); params.push(vendorId); }
  else if (posId(q.vendorId)) { where.push('m.vendor_id = ?'); params.push(posId(q.vendorId)); }
  if (q.status === 'open') where.push("m.status IN ('draft','released','accepted','in_production')");
  else if (q.status) { where.push('m.status = ?'); params.push(String(q.status)); }
  if (q.mode === 'contract' || q.mode === 'in_house') { where.push('m.mode = ?'); params.push(q.mode); }
  if (q.q) { where.push('(m.mo_no = ? OR p.sku = ? OR p.name LIKE ?)'); params.push(v.text(q.q, 40), v.text(q.q, 64), '%' + v.text(q.q, 80) + '%'); }
  const rows = await db.query(MO_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY m.id DESC LIMIT 300', params);
  return { items: rows.map(moOut) };
}

async function moDetail(id, vendorId) {
  const m = await db.queryOne(MO_SELECT + ' WHERE m.id = ?', [id]);
  if (!m || (vendorId != null && (Number(m.vendor_id) !== Number(vendorId) || m.status === 'draft'))) throw fail(404, 'Manufacturing order not found');
  const [events, batches, docs] = await Promise.all([
    db.query('SELECT id, kind, stage, qty, note, actor_type, actor_label, created_at FROM b2b_mfg_order_events WHERE mo_id = ? ORDER BY id', [id]),
    db.query('SELECT * FROM b2b_mfg_batches WHERE mo_id = ? ORDER BY id', [id]),
    db.query('SELECT id, batch_id, doc_type, original_name, mime_type, size_bytes, uploaded_by_type, created_at FROM b2b_mfg_documents WHERE mo_id = ? ORDER BY id', [id]),
  ]);
  const out = moOut(m);
  out.events = events.map(function (e) { return { kind: e.kind, stage: e.stage, qty: e.qty, note: e.note, by: vendorId != null && e.actor_type === 'staff' ? 'Sake of Health' : (e.actor_label || e.actor_type), at: e.created_at }; });
  out.batches = batches.map(function (b) {
    return { id: Number(b.id), batchNo: b.batch_no, mfgDate: d10(b.mfg_date), expiryDate: d10(b.expiry_date), qty: Number(b.qty), status: b.status, releasedQty: Number(b.released_qty), rejectedQty: Number(b.rejected_qty),
      qcNote: b.qc_note, qcAt: b.qc_at, coaDocumentId: b.coa_document_id == null ? null : Number(b.coa_document_id), hasCoa: docs.some(function (d) { return Number(d.batch_id) === Number(b.id) && (d.doc_type === 'coa' || d.doc_type === 'test_report'); }) };
  });
  out.documents = docs.map(function (d) { return { id: Number(d.id), batchId: d.batch_id == null ? null : Number(d.batch_id), type: d.doc_type, name: d.original_name, mime: d.mime_type, size: d.size_bytes, by: d.uploaded_by_type, at: d.created_at }; });
  if (m.mode === 'in_house' && vendorId == null) {
    const bom = await bomDetail(db, m.bom_id);
    const issued = await netIssued(db, id);
    const req = requirement(bom.lines, bom.outputQty, m.planned_qty);
    out.bom = { id: bom.id, version: bom.version, outputQty: bom.outputQty };
    out.materials = bom.lines.map(function (l) {
      const r = req.filter(function (x) { return x.productId === l.productId; })[0];
      return { productId: l.productId, sku: l.sku, name: l.name, uom: l.uom, required: r.required, issued: issued[l.productId] || 0 };
    });
    out.issues = await db.query('SELECT i.product_id, i.batch_id, b.batch_no, i.qty, i.kind, i.issued_at FROM b2b_mfg_material_issues i LEFT JOIN b2b_batches b ON b.id = i.batch_id WHERE i.mo_id = ? ORDER BY i.id', [id]);
  }
  if (m.mode === 'contract' && m.po_id) {
    // what actually arrived, by batch: posted goods receipts of the PO for this product
    const rec = await db.query("SELECT gi.batch_no, SUM(gi.qty_received) AS received, SUM(gi.qty_accepted) AS accepted, SUM(gi.qty_rejected) AS rejected FROM b2b_grn_items gi JOIN b2b_grns g ON g.id = gi.grn_id " +
      "WHERE g.po_id = ? AND gi.product_id = ? AND g.status = 'posted' GROUP BY gi.batch_no", [m.po_id, m.product_id]);
    out.receipts = rec.map(function (r) { return { batchNo: r.batch_no, received: Number(r.received), accepted: Number(r.accepted), rejected: Number(r.rejected) }; });
  }
  return out;
}

/** Batches waiting for (or past) QC across all orders. */
async function listBatches(q) {
  q = q || {};
  const where = [], params = [];
  if (q.status) { where.push('b.status = ?'); params.push(String(q.status)); }
  if (posId(q.vendorId)) { where.push('m.vendor_id = ?'); params.push(posId(q.vendorId)); }
  const rows = await db.query('SELECT b.*, m.mo_no, m.mode, vd.legal_name AS vendor_name, p.sku, p.name, ' +
    "(SELECT COUNT(*) FROM b2b_mfg_documents d WHERE d.batch_id = b.id AND d.doc_type IN ('coa','test_report')) AS coas " +
    'FROM b2b_mfg_batches b JOIN b2b_mfg_orders m ON m.id = b.mo_id JOIN b2b_products p ON p.id = b.product_id LEFT JOIN b2b_vendors vd ON vd.id = m.vendor_id' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY (b.status = \'submitted\') DESC, b.id DESC LIMIT 300', params);
  return { items: rows.map(function (b) {
    return { id: Number(b.id), moId: Number(b.mo_id), moNo: b.mo_no, mode: b.mode, vendor: b.vendor_name || 'In-house', sku: b.sku, product: b.name, batchNo: b.batch_no, mfgDate: d10(b.mfg_date), expiryDate: d10(b.expiry_date),
      qty: Number(b.qty), status: b.status, releasedQty: Number(b.released_qty), rejectedQty: Number(b.rejected_qty), hasCoa: Number(b.coas) > 0, qcNote: b.qc_note, qcAt: b.qc_at, recordedBy: b.created_by_type, createdAt: b.created_at };
  }) };
}

// ── inbound deliveries from manufacturers (dispatch notices) ──
async function asnList(q) {
  q = q || {};
  const where = [], params = [];
  if (q.vendorId) { where.push('a.vendor_id = ?'); params.push(q.vendorId); }
  if (q.late) where.push("a.status IN ('dispatched','arrived') AND a.expected_at < UTC_TIMESTAMP()");
  else if (q.status) { where.push('a.status = ?'); params.push(String(q.status)); }
  const rows = await db.query('SELECT a.*, po.po_no, vd.legal_name AS vendor_name, (SELECT COALESCE(SUM(qty), 0) FROM b2b_asn_items ai WHERE ai.asn_id = a.id) AS units, ' +
    "(SELECT MAX(g.posted_at) FROM b2b_grns g WHERE g.asn_id = a.id AND g.status = 'posted') AS received_at " +
    'FROM b2b_asns a JOIN b2b_purchase_orders po ON po.id = a.po_id JOIN b2b_vendors vd ON vd.id = a.vendor_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY a.id DESC LIMIT ' + Math.min(500, Number(q.limit) || 300), params);
  const now = Date.now();
  return { items: rows.map(function (a) {
    const exp = a.expected_at ? new Date(a.expected_at).getTime() : null;
    return { id: Number(a.id), poId: Number(a.po_id), poNo: a.po_no, vendorId: Number(a.vendor_id), vendor: a.vendor_name, deliveryNoteNo: a.delivery_note_no, invoiceNo: a.vendor_invoice_no, ewayBillNo: a.eway_bill_no,
      transporter: a.transporter, lrNo: a.lr_no, dispatchedAt: a.dispatched_at, expectedAt: a.expected_at, receivedAt: a.received_at, status: a.status, units: Number(a.units),
      late: !!(exp && exp < now && (a.status === 'dispatched' || a.status === 'arrived')), lateHours: exp && exp < now && (a.status === 'dispatched' || a.status === 'arrived') ? Math.round((now - exp) / 3600000) : 0 };
  }) };
}

// ── manufacturer portal (vendor tokens; every query is fenced by vendor.vendorId) ──
async function vendorMo(tx, vendor, id) {
  const m = await lockMo(tx, id);
  if (Number(m.vendor_id) !== Number(vendor.vendorId) || m.status === 'draft') throw fail(404, 'Manufacturing order not found');
  return m;
}
async function vendorRespond(tx, vendor, id, b) {
  const m = await vendorMo(tx, vendor, id);
  if (m.status !== 'released') throw fail(409, 'This order is ' + m.status + '; only a newly released order can be accepted or declined');
  const who = vendorActor(vendor);
  if (b.response === 'accepted') {
    await setStatus(tx, m, 'accepted', who, v.text(b.note, 500) || 'Accepted by the manufacturer');
  } else if (b.response === 'declined') {
    const note = v.text(b.note, 500); need(note.length >= 5, 'Say why you cannot take this order');
    await setStatus(tx, m, 'draft', who, 'Declined by the manufacturer: ' + note, ', released_at = NULL');
    const notif = require('../../b2b/notifications/service.js');
    await notif.notifyAdmins(tx, { event: 'manufacturing.mo_declined', title: 'Manufacturing order ' + m.mo_no + ' was declined', lines: ['Reason: ' + note, 'It is back in draft: change it or choose another manufacturer.'], refType: 'mfg_order', refId: m.id });
  } else throw fail(400, 'response must be accepted or declined');
  await audit.write(tx, who, { module: 'manufacturing', action: 'mo.' + b.response, entity: 'mfg_order', entityId: id, new: { note: v.text(b.note, 500) || null } });
  return { id: Number(id), status: b.response === 'accepted' ? 'accepted' : 'draft' };
}
async function vendorProgress(tx, vendor, id, b) {
  const m = await vendorMo(tx, vendor, id);
  const r = await progress(tx, vendorActor(vendor), m, b);
  await audit.write(tx, vendorActor(vendor), { module: 'manufacturing', action: 'mo.progress', entity: 'mfg_order', entityId: id, new: { stage: v.text(b.stage, 60) || null } });
  return r;
}
async function vendorBatch(tx, vendor, id, b) {
  const m = await vendorMo(tx, vendor, id);
  const r = await recordBatch(tx, vendorActor(vendor), m, b);
  await audit.write(tx, vendorActor(vendor), { module: 'manufacturing', action: 'mfg_batch.recorded', entity: 'mfg_batch', entityId: r.batchId, new: { moId: Number(id), batchNo: r.batchNo, qty: Number(b.qty) } });
  const notif = require('../../b2b/notifications/service.js');
  await notif.notifyAdmins(tx, { event: 'manufacturing.batch_recorded', title: 'Batch ' + r.batchNo + ' recorded on ' + m.mo_no + ' — waiting for QC', lines: [Number(b.qty) + ' units. Review the Certificate of Analysis and release or reject it.'], refType: 'mfg_batch', refId: r.batchId });
  return r;
}
async function vendorDocument(tx, vendor, id, saved, b) {
  const m = await vendorMo(tx, vendor, id);
  const r = await saveDocument(tx, vendorActor(vendor), m, saved, b);
  await audit.write(tx, vendorActor(vendor), { module: 'manufacturing', action: 'mfg_document.uploaded', entity: 'mfg_order', entityId: id, new: r });
  return r;
}
async function staffDocument(tx, actor, id, saved, b) {
  const m = await lockMo(tx, id);
  const r = await saveDocument(tx, staffActor(actor), m, saved, b);
  await audit.write(tx, actor, { module: 'manufacturing', action: 'mfg_document.uploaded', entity: 'mfg_order', entityId: id, new: r });
  return r;
}

/** Invoices we hold from this vendor and the payments made against them. */
async function vendorAccounts(vendor) {
  const invoices = await db.query("SELECT i.id, i.invoice_no, i.invoice_date, i.grand_total, i.due_date, i.status, po.po_no, " +
    '(SELECT COALESCE(SUM(a.amount), 0) FROM b2b_supplier_payment_allocations a JOIN b2b_supplier_payments sp ON sp.id = a.supplier_payment_id WHERE a.supplier_invoice_id = i.id AND sp.status = \'paid\') AS paid ' +
    'FROM b2b_supplier_invoices i LEFT JOIN b2b_purchase_orders po ON po.id = i.po_id WHERE i.vendor_id = ? ORDER BY i.id DESC LIMIT 200', [vendor.vendorId]);
  const payments = await db.query("SELECT id, payment_no, method, amount, tds_amount, reference, status, paid_at FROM b2b_supplier_payments WHERE vendor_id = ? AND status = 'paid' ORDER BY id DESC LIMIT 200", [vendor.vendorId]);
  return {
    invoices: invoices.map(function (i) { const due = Math.max(0, Math.round((Number(i.grand_total) - Number(i.paid)) * 100) / 100); return { id: Number(i.id), invoiceNo: i.invoice_no, date: d10(i.invoice_date), poNo: i.po_no, total: Number(i.grand_total), paid: Number(i.paid), outstanding: due, dueDate: d10(i.due_date), status: i.status }; }),
    payments: payments.map(function (p) { return { id: Number(p.id), paymentNo: p.payment_no, method: p.method, amount: Number(p.amount), tds: Number(p.tds_amount), reference: p.reference, paidAt: p.paid_at }; }),
  };
}

/** Daily: dispatch notices past their expected time are alerted once (when delivery.delay_alert_hours is decided). */
async function alertLateAsns() {
  const hours = await settings.get('delivery.delay_alert_hours');
  if (!hours) return { alerted: 0, reason: 'delivery.delay_alert_hours is not decided' };
  const rows = await db.query("SELECT a.id, a.expected_at, po.po_no, vd.legal_name FROM b2b_asns a JOIN b2b_purchase_orders po ON po.id = a.po_id JOIN b2b_vendors vd ON vd.id = a.vendor_id " +
    "WHERE a.status IN ('dispatched','arrived') AND a.delay_alerted_at IS NULL AND a.expected_at < UTC_TIMESTAMP() - INTERVAL ? HOUR LIMIT 100", [Number(hours)]);
  const notif = require('../../b2b/notifications/service.js');
  for (const a of rows) {
    await db.transaction(async function (tx) {
      const r = await tx.query('UPDATE b2b_asns SET delay_alerted_at = UTC_TIMESTAMP() WHERE id = ? AND delay_alerted_at IS NULL', [a.id]);
      if (r.affectedRows !== 1) return;
      await notif.notifyAdmins(tx, { event: 'manufacturing.delivery_late', title: 'Late delivery from ' + a.legal_name + ' (' + a.po_no + ')', lines: ['Expected ' + new Date(a.expected_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC; not received yet.'], refType: 'asn', refId: a.id });
    });
  }
  return { alerted: rows.length };
}

/** What the manufacturing forms need to offer choices (names and ids only). */
async function lookups() {
  const [products, warehouses, makers, facilities, boms, pos] = await Promise.all([
    db.query("SELECT id, sku, name, item_kind, uom FROM b2b_products WHERE is_active = 1 ORDER BY name LIMIT 2000"),
    db.query("SELECT id, code, name FROM b2b_warehouses WHERE warehouse_type = 'company' AND is_active = 1 ORDER BY code"),
    db.query("SELECT DISTINCT vd.id, vd.legal_name FROM b2b_vendors vd JOIN b2b_vendor_capabilities c ON c.vendor_id = vd.id AND c.capability IN ('manufacturer','contract_manufacturer') AND c.status = 'approved' WHERE vd.status = 'approved' ORDER BY vd.legal_name"),
    db.query("SELECT id, vendor_id, name FROM b2b_mfg_facilities WHERE status = 'active' ORDER BY name"),
    db.query("SELECT b.id, b.product_id, b.version FROM b2b_boms b WHERE b.status = 'active'"),
    db.query("SELECT p.id, p.po_no, p.vendor_id, p.status, p.ship_to_warehouse_id FROM b2b_purchase_orders p WHERE p.status IN ('draft','pending_approval','approved','sent','accepted','partially_accepted','partially_received') ORDER BY p.id DESC LIMIT 500"),
  ]);
  return {
    products: products.map(function (p) { return { id: Number(p.id), sku: p.sku, name: p.name, kind: p.item_kind || 'finished', uom: p.uom }; }),
    warehouses: warehouses.map(function (w) { return { id: Number(w.id), code: w.code, name: w.name }; }),
    manufacturers: makers.map(function (m) { return { id: Number(m.id), name: m.legal_name }; }),
    facilities: facilities.map(function (f) { return { id: Number(f.id), vendorId: f.vendor_id == null ? null : Number(f.vendor_id), name: f.name }; }),
    activeBoms: boms.map(function (b) { return { id: Number(b.id), productId: Number(b.product_id), version: b.version }; }),
    purchaseOrders: pos.map(function (p) { return { id: Number(p.id), poNo: p.po_no, vendorId: Number(p.vendor_id), status: p.status, warehouseId: Number(p.ship_to_warehouse_id) }; }),
  };
}

module.exports = {
  MAKER_CAPS, requirement, cleanBatch, lookups,
  listManufacturers, manufacturerDetail, performance, assertMaker,
  listFacilities, saveFacility,
  listBoms, bomDetail, createBom, activateBom, archiveBom,
  createMo, releaseMo, cancelMo, completeMo, closeMo, staffProgress, issueMaterials, returnMaterials, staffBatch, staffDocument, qcDecide,
  listMos, moDetail, listBatches, asnList, documentFile, checkDocumentRequest,
  vendorRespond, vendorProgress, vendorBatch, vendorDocument, vendorAccounts, alertLateAsns,
};
