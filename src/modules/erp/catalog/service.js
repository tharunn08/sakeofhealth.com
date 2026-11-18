/**
 * Phase 3: product master, tax rates and versioned price lists.
 *
 *   import  → a DRAFT price list (version n+1 of its code) with one priced item per
 *             matched product. Held rows (rows 188–189 and 204–206 in the 9 Oct 2026
 *             sheet) are never priced or stored as items: they are listed in the
 *             import report for a person to resolve with the brand.
 *   submit  → maker-checker approval ('catalog.price_list').
 *   publish → (after approval, by someone with catalog.pricing.publish + MFA) writes the
 *             enabled tiers' prices to b2b_products, so the EXISTING B2B pricing engine
 *             and order flow use them unchanged. The previous published version of the
 *             same code becomes 'superseded'. Every product change is audited.
 *
 * Pending decisions, while unset (see settings catalogue):
 *   pricing.tiers_enabled            → only retailer and distributor prices are written
 *   pricing.pass_scheme_to_buyers    → scheme % is purchase-side information only
 *   tax.require_approved_rate_...    → publish needs an APPROVED tax rate per product
 *   tax.invoice_hsn_source           → HSN is never overwritten; conflicts are reported
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const settings = require('../core/settings.js');
const chain = require('./divide-chain.js');
const sheet = require('./sheet-import.js');
const { fail, posId } = require('../lib/http.js');

const money = function (v) { return v == null ? null : Number(v).toFixed(2); };
const PRODUCT_FIELDS = {
  name: 'text:255', description: 'text:5000', sap_code: 'code:30', uom: 'text:20', shipper_size: 'int', shelf_life_days: 'int',
  min_shelf_life_pct: 'pct', is_batch_tracked: 'bool', manufacturer_vendor_id: 'id', moq: 'int', case_qty: 'int', pack_size: 'text:60',
};

// ── products ──
async function listProducts(q) {
  const where = ['1=1'], params = [];
  if (q.q) { const t = '%' + String(q.q).replace(/[\\%_]/g, '\\$&').slice(0, 80) + '%'; where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.sap_code LIKE ?)'); params.push(t, t, t); }
  if (q.brand) { where.push('p.brand = ?'); params.push(String(q.brand).slice(0, 100)); }
  if (q.active === '1' || q.active === '0') { where.push('p.is_active = ?'); params.push(Number(q.active)); }
  const after = db.int(q.after, 0, 0, Number.MAX_SAFE_INTEGER), limit = db.int(q.limit, 50, 1, 200);
  if (after) { where.push('p.id > ?'); params.push(after); }
  const rows = await db.query(
    'SELECT p.id, p.sku, p.sap_code, p.name, p.brand, p.uom, p.hsn_code, p.gst_rate, p.mrp, p.base_price, p.retailer_price, p.distributor_price, ' +
    'p.super_stockist_price, p.is_active, p.avail_retailer, p.avail_distributor, p.shelf_life_days, p.is_batch_tracked, ' +
    "(SELECT t.gst_rate FROM b2b_tax_rates t WHERE t.product_id = p.id AND t.status = 'approved' AND t.valid_from <= DATE(UTC_TIMESTAMP()) AND (t.valid_to IS NULL OR t.valid_to >= DATE(UTC_TIMESTAMP())) ORDER BY t.valid_from DESC LIMIT 1) AS approved_gst_rate " +
    'FROM b2b_products p WHERE ' + where.join(' AND ') + ' ORDER BY p.id LIMIT ' + limit, params);
  return { items: rows, next: rows.length === limit ? Number(rows[rows.length - 1].id) : null };
}

function cleanField(kind, v, key) {
  if (v === null) return null;
  const [t, n] = kind.split(':');
  if (t === 'text') { const s = String(v).trim(); if (!s && key === 'name') throw fail(400, 'Name cannot be empty'); return s.slice(0, Number(n)); }
  if (t === 'code') { const s = String(v).trim(); if (!/^[A-Za-z0-9._-]{1,30}$/.test(s)) throw fail(400, key + ' may contain letters, digits, dot, dash and underscore only'); return s; }
  if (t === 'int' || t === 'id') { if (!Number.isInteger(v) || v < (t === 'id' ? 1 : 0) || v > 1e7) throw fail(400, key + ' must be a whole number'); return v; }
  if (t === 'pct') { if (!Number.isInteger(v) || v < 0 || v > 100) throw fail(400, key + ' must be 0–100'); return v; }
  if (t === 'bool') { if (typeof v !== 'boolean') throw fail(400, key + ' must be true or false'); return v ? 1 : 0; }
  throw fail(400, 'Unsupported field');
}

/** Master-data edits only. Prices, GST and HSN change through price lists and tax rates, never here. */
async function updateProduct(tx, actor, id, body) {
  const p = await tx.queryOne('SELECT * FROM b2b_products WHERE id = ? FOR UPDATE', [id]);
  if (!p) throw fail(404, 'Product not found');
  const forbidden = ['mrp', 'base_price', 'retailer_price', 'distributor_price', 'super_stockist_price', 'gst_rate', 'hsn_code'].filter(function (k) { return k in body; });
  if (forbidden.length) throw fail(400, forbidden.join(', ') + ' change only through an approved price list or tax rate', 'use_price_list');
  const set = {}, old = {};
  Object.keys(body).forEach(function (k) {
    if (k === 'reason') return;
    if (!PRODUCT_FIELDS[k]) throw fail(400, 'Unknown or read-only field: ' + k);
    set[k] = cleanField(PRODUCT_FIELDS[k], body[k], k); old[k] = p[k];
  });
  if (!Object.keys(set).length) throw fail(400, 'Nothing to change');
  if (set.manufacturer_vendor_id && !(await tx.queryOne('SELECT id FROM b2b_vendors WHERE id = ?', [set.manufacturer_vendor_id]))) throw fail(400, 'Unknown manufacturer');
  try {
    await tx.query('UPDATE b2b_products SET ' + Object.keys(set).map(function (k) { return '`' + k + '` = ?'; }).join(', ') + ' WHERE id = ?', Object.values(set).concat([id]));
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'Another product already has this SAP code'); throw e; }
  await audit.write(tx, actor, { module: 'catalog', action: 'product.updated', entity: 'product', entityId: id, old: old, new: set, reason: body.reason });
  return { id: Number(id), changed: Object.keys(set) };
}

// ── tax rates (always via approval) ──
async function proposeTaxRate(tx, actor, b) {
  const productId = posId(b.productId);
  const p = productId && await tx.queryOne('SELECT id, hsn_code, gst_rate FROM b2b_products WHERE id = ?', [productId]);
  if (!p) throw fail(400, 'Unknown product');
  const hsn = String(b.hsnCode || '').replace(/\D/g, '');
  if (!/^\d{4,8}$/.test(hsn) || [4, 6, 8].indexOf(hsn.length) === -1) throw fail(400, 'HSN must be 4, 6 or 8 digits');
  const minDigits = await settings.get('tax.hsn_min_digits');
  if (minDigits && hsn.length < minDigits) throw fail(400, 'HSN must have at least ' + minDigits + ' digits (approved rule)');
  const rate = Number(b.gstRate);
  if ([0, 0.25, 3, 5, 12, 18, 28, 40].indexOf(rate) === -1) throw fail(400, 'GST rate must be one of 0, 0.25, 3, 5, 12, 18, 28, 40');
  const cess = b.cessRate == null ? 0 : Number(b.cessRate);
  if (!(cess >= 0 && cess <= 100)) throw fail(400, 'Cess must be 0–100');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.validFrom || ''))) throw fail(400, 'validFrom must be a date (YYYY-MM-DD)');
  if (!b.sourceNote || String(b.sourceNote).trim().length < 5) throw fail(400, 'Say where this rate comes from (e.g. CA review, notification number)');
  const r = await tx.query("INSERT INTO b2b_tax_rates (product_id, hsn_code, gst_rate, cess_rate, valid_from, source_note, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)",
    [productId, hsn, rate.toFixed(2), cess.toFixed(2), b.validFrom, String(b.sourceNote).slice(0, 255), actor.id]);
  await audit.write(tx, actor, { module: 'catalog', action: 'tax_rate.proposed', entity: 'tax_rate', entityId: r.insertId,
    new: { productId: productId, hsn: hsn, gstRate: rate, cess: cess, validFrom: b.validFrom }, reason: b.sourceNote });
  const a = await approvals.request(tx, actor, { type: 'catalog.tax_rate', entity: 'tax_rate', entityId: r.insertId, reason: b.reason || b.sourceNote,
    payload: { productId: productId, hsn: hsn, gstRate: rate, currentProductHsn: p.hsn_code, currentProductGst: Number(p.gst_rate) } });
  await tx.query('UPDATE b2b_tax_rates SET approval_id = ? WHERE id = ?', [a.approvalId, r.insertId]);
  return Object.assign({ taxRateId: Number(r.insertId) }, a);
}

approvals.register('catalog.tax_rate', async function (tx, req, actor) {
  const t = await tx.queryOne('SELECT * FROM b2b_tax_rates WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!t || t.status !== 'draft') throw fail(409, 'This tax rate is no longer a draft');
  // Close the currently open approved rate of the product from the day before.
  await tx.query("UPDATE b2b_tax_rates SET status = 'superseded', valid_to = DATE_SUB(?, INTERVAL 1 DAY) WHERE product_id = ? AND status = 'approved' AND valid_to IS NULL AND valid_from < ?",
    [t.valid_from, t.product_id, t.valid_from]);
  await tx.query("UPDATE b2b_tax_rates SET status = 'approved', approval_id = ? WHERE id = ?", [req.id, t.id]);
  await audit.write(tx, actor, { module: 'catalog', action: 'tax_rate.approved', entity: 'tax_rate', entityId: t.id, approvalId: req.id,
    new: { productId: Number(t.product_id), hsn: t.hsn_code, gstRate: Number(t.gst_rate) } });
  // products.gst_rate / hsn_code are NOT changed here: invoices keep using the product master
  // until a price list that agrees with this rate is published (and HSN only per D-setting).
  return { taxRateId: Number(t.id), status: 'approved' };
});

async function approvedTax(q, productId) {
  return q.queryOne("SELECT gst_rate, hsn_code FROM b2b_tax_rates WHERE product_id = ? AND status = 'approved' AND valid_from <= DATE(UTC_TIMESTAMP()) " +
    'AND (valid_to IS NULL OR valid_to >= DATE(UTC_TIMESTAMP())) ORDER BY valid_from DESC LIMIT 1', [productId]);
}

// ── price lists ──
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 255); }

async function importPriceList(tx, actor, file, b) {
  if (!file || !file.buffer) throw fail(400, 'Attach the price list workbook as "file"');
  const code = String(b.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) throw fail(400, 'Price list code: 2–40 letters, digits, dash or underscore (e.g. SST-FMCG)');
  const name = String(b.name || '').trim().slice(0, 160);
  if (!name) throw fail(400, 'Give the price list a name (e.g. "SS Price List revised 9 Oct 2026")');
  if (!(file.buffer[0] === 0x50 && file.buffer[1] === 0x4B)) throw fail(400, 'Upload the Excel (.xlsx) file');
  const parsed = await sheet.parse(file.buffer);
  const createMissing = String(b.createMissing) === 'true';
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const ver = await tx.queryOne('SELECT COALESCE(MAX(version_no), 0) + 1 AS v FROM b2b_price_lists WHERE code = ? FOR UPDATE', [code]);
  const rounding = JSON.stringify({ profile: 'divide_chain_incl_gst', ptr_incl: 'unrounded', others: 'round2 half-up', source_sha256: sha, sheet: parsed.meta.sheet });
  const pl = await tx.query("INSERT INTO b2b_price_lists (code, version_no, name, brand, vendor_id, formula_profile, rounding_json, status, created_by) VALUES (?, ?, ?, ?, ?, 'divide_chain_incl_gst', ?, 'draft', ?)",
    [code, ver.v, name, b.brand ? String(b.brand).slice(0, 100) : null, posId(b.vendorId) || null, rounding.slice(0, 500), actor.id]);
  const listId = Number(pl.insertId);
  const report = { priced: 0, warnings: [], held: [], unmatched: [], created: [], hsnConflicts: [] };
  for (const line of parsed.rows) {
    let prod = await tx.queryOne('SELECT id, sku, hsn_code, gst_rate FROM b2b_products WHERE sap_code = ?', [line.sap]);
    if (!prod) {
      const al = await tx.queryOne("SELECT p.id, p.sku, p.hsn_code, p.gst_rate FROM b2b_product_aliases a JOIN b2b_products p ON p.id = a.product_id WHERE a.source = 'sap' AND a.alias_norm = ?", [norm(line.sap)]);
      prod = al;
    }
    if (line.status === 'held') { report.held.push({ row: line.row, sap: line.sap, desc: line.desc, productId: prod ? Number(prod.id) : null, reasons: line.reasons }); continue; }
    if (!prod && createMissing) {
      // New products are created INACTIVE and unavailable to every channel; publishing a price list never activates them.
      const sku = (await tx.queryOne('SELECT id FROM b2b_products WHERE sku = ?', [line.sap])) ? 'SAP-' + line.sap : line.sap;
      const r = await tx.query('INSERT INTO b2b_products (sku, name, brand, hsn_code, gst_rate, mrp, base_price, sap_code, uom, shipper_size, pack_size, is_active, avail_b2c, avail_retailer, avail_distributor, moq, case_qty) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, 1)',
        [sku, (line.desc + (line.uom ? ' ' + line.uom : '')).slice(0, 255), b.brand ? String(b.brand).slice(0, 100) : null, line.hsn || null,
          (line.gst_bp / 100).toFixed(2), Number(line.mrp).toFixed(2), Number(line.prices.purchase_cost_ex).toFixed(2), line.sap, line.uom.slice(0, 20) || null, line.shipper, line.uom.slice(0, 60) || null]);
      prod = { id: r.insertId, sku: sku, hsn_code: line.hsn, gst_rate: (line.gst_bp / 100).toFixed(2) };
      report.created.push({ row: line.row, sap: line.sap, productId: Number(r.insertId) });
    }
    if (!prod) { report.unmatched.push({ row: line.row, sap: line.sap, desc: line.desc }); continue; }
    if (line.hsn && prod.hsn_code && line.hsn !== String(prod.hsn_code)) report.hsnConflicts.push({ row: line.row, productId: Number(prod.id), sheet: line.hsn, productMaster: prod.hsn_code });
    const p = line.prices;
    try {
      await tx.query('INSERT INTO b2b_price_list_items (price_list_id, product_id, mrp, gst_rate, retailer_margin_pct, distributor_margin_pct, ss_margin_pct, scheme_pct, ' +
        'ptr_incl_raw, ptr_ex, ptd_incl, ptd_ex, ptss_incl, ptss_ex, purchase_cost_ex, source_row_no, check_status, check_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [listId, prod.id, Number(line.mrp).toFixed(2), (line.gst_bp / 100).toFixed(2), (line.retailer_margin_bp / 100).toFixed(4), (line.distributor_margin_bp / 100).toFixed(4),
          (line.ss_margin_bp / 100).toFixed(4), (line.scheme_bp / 100).toFixed(4), p.ptr_incl_raw.toFixed(6), money(p.ptr_ex), money(p.ptd_incl), money(p.ptd_ex),
          money(p.ptss_incl), money(p.ptss_ex), p.purchase_cost_ex.toFixed(4), line.row, line.status === 'warning' ? 'warning' : 'ok', line.reasons.join('; ').slice(0, 500) || null]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') { report.held.push({ row: line.row, sap: line.sap, desc: line.desc, productId: Number(prod.id), reasons: ['two sheet rows map to the same product'] }); continue; }
      throw e;
    }
    report.priced++;
    if (line.status === 'warning') report.warnings.push({ row: line.row, sap: line.sap, reasons: line.reasons });
  }
  await audit.write(tx, actor, { module: 'catalog', action: 'price_list.imported', entity: 'price_list', entityId: listId,
    new: { code: code, version: Number(ver.v), file: String(file.originalname || '').slice(0, 120), sha256: sha, sheet: parsed.meta, report: report } });
  return { priceListId: listId, code: code, version: Number(ver.v), status: 'draft', rows: parsed.rows.length, report: report };
}

async function getList(q, id, lock) {
  const pl = await q.queryOne('SELECT * FROM b2b_price_lists WHERE id = ?' + (lock ? ' FOR UPDATE' : ''), [id]);
  if (!pl) throw fail(404, 'Price list not found');
  return pl;
}

async function listPriceLists(q) {
  const where = ['1=1'], params = [];
  if (q.code) { where.push('code = ?'); params.push(String(q.code).slice(0, 40)); }
  if (q.status) { where.push('status = ?'); params.push(String(q.status).slice(0, 20)); }
  const rows = await db.query('SELECT pl.id, pl.code, pl.version_no, pl.name, pl.brand, pl.status, pl.valid_from, pl.published_at, pl.created_at, pl.approval_id, ' +
    '(SELECT COUNT(*) FROM b2b_price_list_items i WHERE i.price_list_id = pl.id) AS items FROM b2b_price_lists pl WHERE ' + where.join(' AND ') +
    ' ORDER BY pl.id DESC LIMIT ' + db.int(q.limit, 50, 1, 200), params);
  return { items: rows };
}

async function report(id) {
  await getList(db, id);
  const a = await db.queryOne("SELECT new_value FROM b2b_audit_logs WHERE module = 'catalog' AND action = 'price_list.imported' AND entity = 'price_list' AND entity_id = ? ORDER BY id LIMIT 1", [String(id)]);
  return a ? JSON.parse(a.new_value) : null;
}

/** What publishing would change, product by product, against the product master as it is now. */
async function diff(id, q) {
  const pl = await getList(db, id);
  const tiers = await enabledTiers();
  const rows = await db.query('SELECT i.*, p.sku, p.name, p.mrp AS cur_mrp, p.gst_rate AS cur_gst, p.base_price AS cur_base, p.retailer_price AS cur_retailer, ' +
    'p.distributor_price AS cur_distributor, p.super_stockist_price AS cur_ss FROM b2b_price_list_items i JOIN b2b_products p ON p.id = i.product_id ' +
    'WHERE i.price_list_id = ? ORDER BY i.source_row_no, i.id LIMIT ' + db.int(q && q.limit, 1000, 1, 5000), [id]);
  const items = [];
  for (const r of rows) {
    const next = targetValues(r, tiers);
    const changes = {};
    const cur = { mrp: r.cur_mrp, gst_rate: r.cur_gst, base_price: r.cur_base, retailer_price: r.cur_retailer, distributor_price: r.cur_distributor, super_stockist_price: r.cur_ss };
    Object.keys(next).forEach(function (k) { if (money(cur[k]) !== money(next[k])) changes[k] = { from: money(cur[k]), to: money(next[k]) }; });
    const tax = await approvedTax(db, r.product_id);
    items.push({ productId: Number(r.product_id), sku: r.sku, name: r.name, row: r.source_row_no, check: r.check_status, changes: changes,
      approvedGstRate: tax ? Number(tax.gst_rate) : null, taxOk: !!tax && Number(tax.gst_rate) === Number(r.gst_rate) });
  }
  return { priceListId: Number(id), code: pl.code, version: Number(pl.version_no), status: pl.status, tiersWritten: tiers, items: items,
    blockers: await blockers(db, id) };
}

async function enabledTiers() {
  const t = await settings.get('pricing.tiers_enabled');
  return Array.isArray(t) && t.length ? t : ['retailer', 'distributor'];   // fail-safe: the tiers the B2B already sells
}

function targetValues(item, tiers) {
  const v = { mrp: item.mrp, gst_rate: item.gst_rate, base_price: Number(item.purchase_cost_ex).toFixed(2) };
  if (tiers.indexOf('retailer') !== -1) v.retailer_price = item.ptr_ex;
  if (tiers.indexOf('distributor') !== -1) v.distributor_price = item.ptd_ex;
  if (tiers.indexOf('super_stockist') !== -1) v.super_stockist_price = item.ptss_ex;
  return v;
}

/** Reasons the list cannot be submitted/published yet. Fail closed. */
async function blockers(q, id) {
  const out = [];
  const n = await q.queryOne('SELECT COUNT(*) AS n, SUM(check_status = \'warning\') AS w FROM b2b_price_list_items WHERE price_list_id = ?', [id]);
  if (!Number(n.n)) out.push('The price list has no priced items');
  if (Number(n.w)) out.push(Number(n.w) + ' item(s) have a calculation warning — correct or remove them first');
  const requireRate = await settings.get('tax.require_approved_rate_for_new_price_lists');
  if (requireRate !== false) {   // unset → required (fail closed for the new flow)
    const bad = await q.query("SELECT i.product_id, i.gst_rate, (SELECT t.gst_rate FROM b2b_tax_rates t WHERE t.product_id = i.product_id AND t.status = 'approved' " +
      'AND t.valid_from <= DATE(UTC_TIMESTAMP()) AND (t.valid_to IS NULL OR t.valid_to >= DATE(UTC_TIMESTAMP())) ORDER BY t.valid_from DESC LIMIT 1) AS approved ' +
      'FROM b2b_price_list_items i WHERE i.price_list_id = ?', [id]);
    const missing = bad.filter(function (r) { return r.approved == null; }).length;
    const mismatch = bad.filter(function (r) { return r.approved != null && Number(r.approved) !== Number(r.gst_rate); }).length;
    if (missing) out.push(missing + ' product(s) have no approved tax rate');
    if (mismatch) out.push(mismatch + ' product(s) have a GST % different from their approved tax rate');
  }
  return out;
}

async function removeItem(tx, actor, id, productId, reason) {
  const pl = await getList(tx, id, true);
  if (pl.status !== 'draft') throw fail(409, 'Only a draft can be changed');
  const it = await tx.queryOne('SELECT * FROM b2b_price_list_items WHERE price_list_id = ? AND product_id = ?', [id, productId]);
  if (!it) throw fail(404, 'Item not found');
  await tx.query('DELETE FROM b2b_price_list_items WHERE id = ?', [it.id]);   // draft line only; the import record stays in the audit log
  await audit.write(tx, actor, { module: 'catalog', action: 'price_list.item_removed', entity: 'price_list', entityId: id, old: it, reason: reason });
  return { removed: Number(productId) };
}

async function submit(tx, actor, id, b) {
  const pl = await getList(tx, id, true);
  if (pl.status !== 'draft') throw fail(409, 'Only a draft can be submitted');
  const block = await blockers(tx, id);
  if (block.length) throw fail(409, 'Cannot submit: ' + block.join('; '), 'blocked', { blockers: block });
  let validFrom = null;
  if (b.validFrom) {
    const d = new Date(b.validFrom);
    if (isNaN(d.getTime())) throw fail(400, 'validFrom must be a date-time');
    validFrom = d.toISOString().slice(0, 19).replace('T', ' ');
  }
  const a = await approvals.request(tx, actor, { type: 'catalog.price_list', entity: 'price_list', entityId: id, reason: b.reason,
    payload: { code: pl.code, version: Number(pl.version_no), validFrom: validFrom } });
  await tx.query("UPDATE b2b_price_lists SET status = 'submitted', approval_id = ?, valid_from = ? WHERE id = ?", [a.approvalId, validFrom, id]);
  await audit.write(tx, actor, { module: 'catalog', action: 'price_list.submitted', entity: 'price_list', entityId: id, approvalId: a.approvalId, reason: b.reason });
  return a;
}

approvals.register('catalog.price_list', async function (tx, req, actor) {
  const pl = await getList(tx, req.entityId, true);
  if (pl.status !== 'submitted') throw fail(409, 'This price list is no longer submitted');
  await tx.query("UPDATE b2b_price_lists SET status = 'approved' WHERE id = ?", [pl.id]);
  await audit.write(tx, actor, { module: 'catalog', action: 'price_list.approved', entity: 'price_list', entityId: pl.id, approvalId: req.id });
  return { priceListId: Number(pl.id), status: 'approved' };
});

/** A rejected approval puts the list back to draft so it can be corrected. */
async function syncRejected(tx, id) {
  const pl = await getList(tx, id, true);
  if (pl.status !== 'submitted') return;
  const a = await tx.queryOne('SELECT status FROM b2b_approval_requests WHERE id = ?', [pl.approval_id]);
  if (a && (a.status === 'rejected' || a.status === 'withdrawn')) await tx.query("UPDATE b2b_price_lists SET status = 'rejected' WHERE id = ?", [id]);
}

async function publish(tx, actor, id, opts) {
  await syncRejected(tx, id);
  const pl = await getList(tx, id, true);
  if (pl.status !== 'approved') throw fail(409, 'Only an approved price list can be published (status: ' + pl.status + ')', 'not_approved');
  if (pl.valid_from && new Date(pl.valid_from).getTime() > Date.now() && !(opts && opts.scheduled)) {
    throw fail(409, 'This list is scheduled for ' + pl.valid_from + ' UTC and will publish then', 'scheduled');
  }
  const block = await blockers(tx, id);
  if (block.length) throw fail(409, 'Cannot publish: ' + block.join('; '), 'blocked', { blockers: block });
  const tiers = await enabledTiers();
  const items = await tx.query('SELECT * FROM b2b_price_list_items WHERE price_list_id = ?', [id]);
  let changed = 0;
  for (const it of items) {
    const p = await tx.queryOne('SELECT id, mrp, gst_rate, base_price, retailer_price, distributor_price, super_stockist_price, retailer_margin, distributor_margin FROM b2b_products WHERE id = ? FOR UPDATE', [it.product_id]);
    const next = targetValues(it, tiers);
    const old = {}; Object.keys(next).forEach(function (k) { old[k] = p[k]; });
    await tx.query('UPDATE b2b_products SET ' + Object.keys(next).map(function (k) { return '`' + k + '` = ?'; }).join(', ') + ' WHERE id = ?', Object.values(next).map(String).concat([p.id]));
    if (tiers.indexOf('super_stockist') !== -1) await tx.query('UPDATE b2b_products SET avail_super_stockist = 1 WHERE id = ?', [p.id]);   // SS tier enabled by decision
    await audit.write(tx, actor, { module: 'catalog', action: 'product.prices_published', entity: 'product', entityId: p.id, old: old, new: next,
      reason: 'price list ' + pl.code + ' v' + pl.version_no, approvalId: pl.approval_id });
    changed++;
  }
  await tx.query("UPDATE b2b_price_lists SET status = 'superseded', valid_to = UTC_TIMESTAMP() WHERE code = ? AND status = 'published' AND id <> ?", [pl.code, id]);
  await tx.query("UPDATE b2b_price_lists SET status = 'published', published_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'catalog', action: 'price_list.published', entity: 'price_list', entityId: id, approvalId: pl.approval_id,
    new: { products: changed, tiers: tiers, scheduled: !!(opts && opts.scheduled) } });
  return { priceListId: Number(id), status: 'published', products: changed, tiersWritten: tiers };
}

/** Background job: publish approved lists whose time has come (the publish was approved; timing was part of it). */
async function publishDue() {
  const due = await db.query("SELECT id FROM b2b_price_lists WHERE status = 'approved' AND valid_from IS NOT NULL AND valid_from <= UTC_TIMESTAMP() ORDER BY valid_from LIMIT 20");
  const out = [];
  for (const d of due) {
    try { out.push(await db.transaction(function (tx) { return publish(tx, audit.SYSTEM, Number(d.id), { scheduled: true }); })); }
    catch (e) { out.push({ priceListId: Number(d.id), error: e.message }); }
  }
  return out;
}

// ── simulation (read-only) ──
async function simulate(b) {
  if (b.productId) {
    const engine = require('../../b2b/pricing/engine.js');
    const product = await db.queryOne('SELECT * FROM b2b_products WHERE id = ?', [posId(b.productId)]);
    if (!product) throw fail(404, 'Product not found');
    const audience = ['retailer', 'distributor'].indexOf(b.audience) === -1 ? 'retailer' : b.audience;
    const accountId = posId(b.accountId) || null;
    const ctx = await engine.contextFor(audience, accountId, [product]);
    const r = engine.resolve(product, db.int(b.qty, 1, 1, 100000), ctx);
    const free = engine.freeGoods(product, db.int(b.qty, 1, 1, 100000), ctx);
    return { mode: 'existing_engine', audience: audience, unitPriceExGst: (r.unitPrice / 100).toFixed(2), listPriceExGst: (r.listPrice / 100).toFixed(2), source: r.source, trace: r.trace, belowCost: r.belowCost,
      freeQty: free ? free.qty : 0, freeScheme: free ? free.label : null };
  }
  const input = { mrp: Number(b.mrp), gst_bp: Math.round(Number(b.gstPct) * 100), retailer_margin_bp: Math.round(Number(b.retailerMarginPct) * 100),
    distributor_margin_bp: Math.round(Number(b.distributorMarginPct) * 100), ss_margin_bp: Math.round(Number(b.ssMarginPct || 0) * 100), scheme_bp: Math.round(Number(b.schemePct || 0) * 100) };
  if (!(input.mrp > 0)) throw fail(400, 'mrp must be a positive number');
  ['gst_bp', 'retailer_margin_bp', 'distributor_margin_bp', 'ss_margin_bp', 'scheme_bp'].forEach(function (k) { if (!(input[k] >= 0 && input[k] <= 10000)) throw fail(400, k.replace('_bp', '') + ' must be 0–100'); });
  return Object.assign({ mode: 'divide_chain_incl_gst' }, chain.price(input));
}

// ── selling schemes (promotions) — created inactive, activated only by approval ──
async function proposeScheme(tx, actor, b) {
  const audience = String(b.audience || '');
  if (['retailer', 'distributor'].indexOf(audience) === -1) throw fail(400, 'audience must be retailer or distributor');
  const type = String(b.ruleType || '');
  if (['discount_pct', 'fixed_price', 'free_qty'].indexOf(type) === -1) throw fail(400, 'ruleType must be discount_pct, fixed_price or free_qty');
  let buyQty = null, freeQty = null;
  if (type === 'free_qty') {
    buyQty = Number(b.buyQty); freeQty = Number(b.freeQty);
    if (!Number.isInteger(buyQty) || buyQty < 1 || !Number.isInteger(freeQty) || freeQty < 1 || freeQty > buyQty * 10) throw fail(400, 'buyQty and freeQty must be whole numbers (e.g. buy 10 get 1)');
  }
  const value = type === 'free_qty' ? 0 : Number(b.value);
  if (type !== 'free_qty' && (!(value > 0) || (type === 'discount_pct' && value >= 100))) throw fail(400, 'value must be positive (a discount below 100%)');
  const scope = b.productId ? 'product' : (b.categoryId ? 'category' : null);
  if (!scope) throw fail(400, 'Give a productId or a categoryId');
  const productId = b.productId ? posId(b.productId) : null;
  const categoryId = b.categoryId ? posId(b.categoryId) : null;
  if (productId && !(await tx.queryOne('SELECT id FROM b2b_products WHERE id = ?', [productId]))) throw fail(400, 'Unknown product');
  if (categoryId && !(await tx.queryOne('SELECT id FROM b2b_categories WHERE id = ?', [categoryId]))) throw fail(400, 'Unknown category');
  const d = function (v) { if (!v) return null; const t = new Date(v); if (isNaN(t)) throw fail(400, 'Invalid date'); return t.toISOString().slice(0, 19).replace('T', ' '); };
  const starts = d(b.startsAt), ends = d(b.endsAt);
  if (!ends) throw fail(400, 'A scheme needs an end date');
  if (starts && ends <= starts) throw fail(400, 'endsAt must be after startsAt');
  const r = await tx.query('INSERT INTO b2b_pricing_rules (scope, audience, product_id, category_id, rule_type, value, min_qty, is_promo, label, starts_at, ends_at, is_active, created_by, buy_qty, free_qty) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
    [scope, audience, productId, categoryId, type, value.toFixed(2), db.int(b.minQty, 1, 1, 100000), type === 'free_qty' ? 0 : 1,
      String(b.label || (type === 'free_qty' ? 'Buy ' + buyQty + ' get ' + freeQty + ' free' : 'Scheme')).slice(0, 120), starts, ends, 'erp-staff:' + actor.id, buyQty, freeQty]);
  await audit.write(tx, actor, { module: 'catalog', action: 'scheme.proposed', entity: 'pricing_rule', entityId: r.insertId, new: b, reason: b.reason });
  const a = await approvals.request(tx, actor, { type: 'catalog.scheme', entity: 'pricing_rule', entityId: r.insertId, reason: b.reason, payload: { ruleId: Number(r.insertId) } });
  return Object.assign({ ruleId: Number(r.insertId), active: false }, a);
}
approvals.register('catalog.scheme', async function (tx, req, actor) {
  await tx.query('UPDATE b2b_pricing_rules SET is_active = 1 WHERE id = ? AND is_active = 0', [req.entityId]);
  await audit.write(tx, actor, { module: 'catalog', action: 'scheme.activated', entity: 'pricing_rule', entityId: req.entityId, approvalId: req.id });
  return { ruleId: req.entityId, active: true };
});

module.exports = { listProducts, updateProduct, proposeTaxRate, importPriceList, listPriceLists, report, diff, removeItem, submit, publish, publishDue,
  simulate, proposeScheme, blockers, enabledTiers, targetValues };
