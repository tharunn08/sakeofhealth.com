#!/usr/bin/env node
/**
 * Catalogue reconciliation — READ-ONLY. Compares brand price lists (Excel), purchase invoice lines and,
 * optionally, the trade product master in MySQL and the shop's four protected products. It never
 * imports, changes or deletes anything: the Excel files are opened read-only (their SHA-256 is checked
 * before and after), the database is read inside a READ ONLY transaction, and the report is written to a
 * new folder.
 *
 *   node scripts/reconcile-catalogue.js --price-list "C:\path\SS_Price_list.xlsx" [--price-list second.xlsx]
 *        [--invoice docs/reconciliation/invoice-4050191465.lines.json] [--database] [--shop] [--out folder]
 *
 *   --database  read b2b_products with the DB_* settings in .env (SELECT only; refuses NODE_ENV=production
 *               unless --i-understand-read-only is also given — it still only reads)
 *   --shop      check the four protected shop products in DATA_DIR against src/catalogue/protected-products.json
 *
 * Report: <out>/reconciliation.md and reconciliation.json — existing, missing, duplicate and conflicting
 * records, each with the reason. Exit code 0 (report written; findings are data, not failures), 2 on bad use.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
if (fs.existsSync(path.join(ROOT, '.env'))) require('dotenv').config({ path: path.join(ROOT, '.env') });

/* ── normalising names and pack sizes ─────────────────────────────────── */
const UNIT = { g: ['g', 1], gm: ['g', 1], gms: ['g', 1], gram: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000], ltr: ['ml', 1000], liter: ['ml', 1000], litre: ['ml', 1000], lt: ['ml', 1000] };
/** "500gm" → "500g", "1 Kg" → "1000g", "1liter" → "1000ml", "100gm*4" → "100g*4"; null when there is no size. */
function size(text) {
  const m = /(\d+(?:\.\d+)?)\s*(kg|gms|gm|gram|g|ml|ltr|liter|litre|lt|l)\b(?:\s*\*\s*(\d+))?/i.exec(String(text || ''));
  if (!m) return null;
  const u = UNIT[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * u[1]) + u[0] + (m[3] ? '*' + m[3] : '');
}
const STOP = new Set(['mrp', 'with', 'pack', 'of', 'the', 'and', 'pc', 'free', 'units', 'unit']);
function words(text) {
  return String(text || '').toLowerCase().replace(/cow#s/g, "cow's").replace(/mrp\s*\d*/g, ' ').replace(/\d+\s*\+\s*\d+/g, ' ')
    .replace(/(\d+(?:\.\d+)?)\s*(kg|gms|gm|gram|g|ml|ltr|liter|litre|lt|l)\b/g, ' ').replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/).map(function (w) { return w.replace(/'s$/, '').replace(/s$/, ''); }).filter(function (w) { return w && w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w); });
}
/** Shared words / words of the longer name; "Winter Green" also matches "Wintergreen". 0…1. */
function similarity(a, b) {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const joined = function (w) { const s = new Set(w); for (let i = 0; i + 1 < w.length; i++) s.add(w[i] + w[i + 1]); return s; };
  const A = joined(wa), B = joined(wb);
  const hits = function (base, other) { return base.filter(function (w) { return other.has(w); }).length; };
  const merged = function (base, other) {   // a joined pair found in the other name counts for its two words
    let n = hits(base, other);
    for (let i = 0; i + 1 < base.length; i++) if (!other.has(base[i]) && !other.has(base[i + 1]) && other.has(base[i] + base[i + 1])) n += 1;
    return n;
  };
  const both = Math.max(merged(wa, B), merged(wb, A));
  return Math.min(1, both / Math.max(new Set(wa).size, new Set(wb).size));
}
/** Excel stores HSN as a number, so a leading zero is lost (04059020 → 4059020). 8 digits, zero-padded. */
function hsn8(h) { const d = String(h || '').replace(/\D/g, ''); return d.length && d.length < 8 ? d.padStart(8, '0') : d; }
const sha = function (file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); };

/* ── price lists ──────────────────────────────────────────────────────── */
async function readPriceList(file) {
  const before = sha(file);
  const parsed = await require('../src/modules/erp/catalog/sheet-import.js').parse(file);   // reads only
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  const sheets = wb.worksheets.map(function (w) { return { name: w.name, rows: w.rowCount, columns: w.columnCount }; });
  // the serial-number column (S.No) of the price-list sheet, by row
  const serials = {};
  const ws = wb.worksheets.find(function (w) { return w.name === parsed.meta.sheet; });
  const hdr = ws.getRow(parsed.meta.headerRow);
  let col = null;
  hdr.eachCell(function (c, n) { if (/^s\.?\s*no\.?$/i.test(String(c.value || '').trim())) col = n; });
  if (col) parsed.rows.forEach(function (r) { const raw = ws.getRow(r.row).getCell(col).value; const v = raw && typeof raw === 'object' ? raw.result : raw; if (typeof v === 'number') serials[r.row] = v; });   // S.No is often a formula (=A61+1)
  const after = sha(file);
  if (before !== after) throw new Error(file + ' changed while it was being read');
  return { file: path.basename(file), sha256: before, sheets: sheets, meta: parsed.meta, rows: parsed.rows, serials: serials };
}

function checkList(list) {
  const f = { held: [], warnings: [], duplicateSap: [], duplicateProduct: [], duplicateSerial: [], hsnLeadingZero: [], hsnNot8: [] };
  const bySerial = {};
  Object.keys(list.serials || {}).forEach(function (row) { const n = list.serials[row]; (bySerial[n] = bySerial[n] || []).push(Number(row)); });
  Object.keys(bySerial).forEach(function (n) {
    if (bySerial[n].length > 1) f.duplicateSerial.push({ serial: n, rows: bySerial[n], products: bySerial[n].map(function (row) { const r = list.rows.find(function (x) { return x.row === row; }); return r ? r.sap + ' ' + r.desc + ' ' + r.uom : 'row ' + row; }) });
  });
  const bySap = {}, byProduct = {};
  list.rows.forEach(function (r) {
    if (r.status === 'held') f.held.push({ row: r.row, sap: r.sap, description: r.desc, uom: r.uom, reasons: r.reasons });
    if (r.status === 'warning') f.warnings.push({ row: r.row, sap: r.sap, description: r.desc, reasons: r.reasons });
    (bySap[r.sap] = bySap[r.sap] || []).push(r);
    const k = r.desc.toLowerCase().replace(/[^a-z0-9]+/g, '') + '|' + (size(r.uom) || r.uom.toLowerCase().replace(/\s+/g, ''));
    (byProduct[k] = byProduct[k] || []).push(r);
    const d = String(r.hsn || '');
    if (d.length === 7) f.hsnLeadingZero.push({ row: r.row, sap: r.sap, description: r.desc, sheet: d, likely: hsn8(d) });
    else if (d.length !== 8) f.hsnNot8.push({ row: r.row, sap: r.sap, description: r.desc, sheet: d });
  });
  Object.keys(bySap).forEach(function (k) { if (bySap[k].length > 1) f.duplicateSap.push({ sap: k, rows: bySap[k].map(function (r) { return r.row; }) }); });
  Object.keys(byProduct).forEach(function (k) {
    const rs = byProduct[k];
    if (rs.length > 1) f.duplicateProduct.push({ product: rs[0].desc + ' ' + rs[0].uom, rows: rs.map(function (r) { return { row: r.row, sap: r.sap, mrp: r.mrp, description: r.desc }; }) });
  });
  return f;
}

/** Two price lists: the same SAP code with a different name, pack, MRP, HSN or GST; codes in one list only. */
function compareLists(a, b) {
  const A = {}, B = {}; a.rows.forEach(function (r) { A[r.sap] = r; }); b.rows.forEach(function (r) { B[r.sap] = r; });
  const out = { onlyInFirst: [], onlyInSecond: [], conflicts: [], same: 0 };
  Object.keys(A).forEach(function (k) {
    if (!B[k]) return out.onlyInFirst.push({ sap: k, description: A[k].desc, uom: A[k].uom });
    const diff = fieldDiff(A[k], B[k]);
    if (diff.length) out.conflicts.push({ sap: k, description: A[k].desc, differences: diff }); else out.same++;
  });
  Object.keys(B).forEach(function (k) { if (!A[k]) out.onlyInSecond.push({ sap: k, description: B[k].desc, uom: B[k].uom }); });
  return out;
}
function fieldDiff(x, y) {
  const d = [];
  if (x.desc !== y.desc) d.push({ field: 'description', first: x.desc, second: y.desc });
  if ((size(x.uom) || x.uom) !== (size(y.uom) || y.uom)) d.push({ field: 'pack', first: x.uom, second: y.uom });
  if (x.mrp !== y.mrp) d.push({ field: 'mrp', first: x.mrp, second: y.mrp });
  if (hsn8(x.hsn) !== hsn8(y.hsn)) d.push({ field: 'hsn', first: x.hsn, second: y.hsn });
  if (x.gst_bp !== y.gst_bp) d.push({ field: 'gst', first: x.gst_bp / 100 + '%', second: y.gst_bp / 100 + '%' });
  return d;
}

/* ── invoice lines against the price list ─────────────────────────────── */
function matchInvoice(inv, list) {
  const out = { invoice: { no: inv.invoice_no, date: inv.invoice_date, supplier: inv.supplier, lines: inv.items.length }, matched: [], unmatched: [] };
  inv.items.forEach(function (it) {
    const s = size(it.description);
    const candidates = list.rows.filter(function (r) { return !s || size(r.uom) === s; })
      .map(function (r) { return { r: r, score: similarity(it.description, r.desc) }; })
      .filter(function (c) { return c.score >= 0.5; })
      .sort(function (p, q) { return q.score - p.score || (Math.abs(p.r.mrp - it.mrp) - Math.abs(q.r.mrp - it.mrp)); });
    if (!candidates.length) return out.unmatched.push({ line: it.line, description: it.description, mrp: it.mrp, hsn: it.hsn, reason: 'no price-list product with the same pack size and name' });
    const best = candidates[0], r = best.r;
    const gstInvoice = Math.round((it.cgst_pct + it.sgst_pct) * 100);
    const m = { line: it.line, invoice: it.description, sap: r.sap, priceList: r.desc + ' ' + r.uom, score: Math.round(best.score * 100) / 100,
      mrp: { invoice: it.mrp, priceList: r.mrp }, hsn: { invoice: it.hsn, priceList: r.hsn }, gst: { invoice: gstInvoice / 100 + '%', priceList: r.gst_bp / 100 + '%' }, notes: [] };
    if (it.mrp !== r.mrp) {
      m.notes.push('MRP differs (invoice ' + it.mrp + ', price list ' + r.mrp + ')');
      const same = list.rows.filter(function (x) { return x !== r && x.mrp === it.mrp && size(x.uom) === s && similarity(it.description, x.desc) >= 0.4; });
      if (same.length) m.notes.push('price-list products of this size at MRP ' + it.mrp + ': ' + same.map(function (x) { return x.sap + ' ' + x.desc; }).join(', ') + ' — check which product was delivered');
    }
    if (hsn8(it.hsn) !== hsn8(r.hsn)) m.notes.push('HSN differs (invoice ' + it.hsn + ', price list ' + r.hsn + ')');
    else if (it.hsn !== r.hsn) m.notes.push('HSN only lost its leading zero in Excel (' + r.hsn + ' → ' + it.hsn + ')');
    if (gstInvoice !== r.gst_bp) m.notes.push('GST differs (invoice ' + gstInvoice / 100 + '%, price list ' + r.gst_bp / 100 + '%)');
    if (best.score < 1) m.notes.push('name matched partly (' + Math.round(best.score * 100) + '%) — confirm it is the same product');
    if (candidates.length > 1 && candidates[1].score === best.score) m.notes.push('also matches ' + candidates.slice(1).filter(function (c) { return c.score === best.score; }).map(function (c) { return c.r.sap + ' ' + c.r.desc; }).join(', '));
    out.matched.push(m);
  });
  return out;
}

/* ── database (read-only) ─────────────────────────────────────────────── */
async function readDatabase(allowProduction) {
  if (process.env.NODE_ENV === 'production' && !allowProduction) throw new Error('NODE_ENV is production: add --i-understand-read-only to read the live product master (SELECT only).');
  const db = require('../src/db/connection.js');
  if (!db.isConfigured()) throw new Error('DB_HOST / DB_USER / DB_NAME are not set');
  try {
    return await db.withConnection(async function (c) {
      await c.raw.query('START TRANSACTION READ ONLY');   // MySQL refuses any write in this transaction
      try {
        const cols = (await c.query("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'b2b_products'")).map(function (r) { return r.c; });
        if (!cols.length) return { products: [], note: 'b2b_products does not exist in this database' };
        const want = ['id', 'sku', 'sap_code', 'name', 'uom', 'pack_size', 'hsn_code', 'gst_rate', 'mrp', 'is_active', 'b2c_ref', 'brand'].filter(function (k) { return cols.indexOf(k) !== -1; });
        const products = await c.query('SELECT ' + want.join(', ') + ' FROM b2b_products ORDER BY id');
        return { products: products, columns: want };
      } finally { await c.raw.query('ROLLBACK'); }
    });
  } finally { await db.close(); }
}
function compareDatabase(list, dbr) {
  const out = { inBoth: 0, missingInDatabase: [], onlyInDatabase: [], conflicts: [], duplicatesInDatabase: [], withoutSapCode: 0 };
  const bySap = {};
  dbr.products.forEach(function (p) {
    if (!p.sap_code) { out.withoutSapCode++; return; }
    (bySap[p.sap_code] = bySap[p.sap_code] || []).push(p);
  });
  Object.keys(bySap).forEach(function (k) { if (bySap[k].length > 1) out.duplicatesInDatabase.push({ sap: k, ids: bySap[k].map(function (p) { return Number(p.id); }), skus: bySap[k].map(function (p) { return p.sku; }) }); });
  const seen = {};
  list.rows.forEach(function (r) {
    const p = (bySap[r.sap] || [])[0];
    seen[r.sap] = true;
    if (!p) return out.missingInDatabase.push({ sap: r.sap, description: r.desc, uom: r.uom, mrp: r.mrp });
    out.inBoth++;
    const d = [];
    if (p.mrp != null && Number(p.mrp) !== Number(r.mrp)) d.push({ field: 'mrp', database: Number(p.mrp), priceList: r.mrp });
    if (p.hsn_code && hsn8(p.hsn_code) !== hsn8(r.hsn)) d.push({ field: 'hsn', database: p.hsn_code, priceList: r.hsn });
    if (p.gst_rate != null && Math.round(Number(p.gst_rate) * 100) !== r.gst_bp) d.push({ field: 'gst', database: Number(p.gst_rate) + '%', priceList: r.gst_bp / 100 + '%' });
    if (similarity(p.name, r.desc) < 0.5) d.push({ field: 'name', database: p.name, priceList: r.desc });
    if (d.length) out.conflicts.push({ sap: r.sap, id: Number(p.id), sku: p.sku, differences: d });
  });
  Object.keys(bySap).forEach(function (k) { if (!seen[k]) out.onlyInDatabase.push({ sap: k, id: Number(bySap[k][0].id), sku: bySap[k][0].sku, name: bySap[k][0].name }); });
  return out;
}

/* ── the four protected shop products ─────────────────────────────────── */
function checkShop(dbr) {
  const protection = require('../src/services/productProtection.js');
  const { db } = require('../src/services/db.js');
  const v = protection.verify(db.products.all());
  const out = { dataDir: (process.env.DATA_DIR || './data').replace(/^.*[\\/](?=[^\\/]+$)/, '…/'), integrity: v.ok ? 'ok' : 'FAILED', problems: v.problems || [], products: [] };
  protection.PRODUCTS.forEach(function (e) {
    const row = { id: e.id, name: e.name, slug: e.slug, sku: e.sku || null, skuCandidate: e.skuCandidate || null, toConfirm: e.toConfirm || [], inPriceLists: 'no — the price lists are another brand (Sri Sri Tattva); the four shop products are Sake of Health gummies' };
    if (dbr) {
      const linked = dbr.products.filter(function (p) { return p.b2c_ref === e.id || (e.skuCandidate && p.sku === e.skuCandidate); });
      row.tradeMaster = linked.length ? linked.map(function (p) { return { id: Number(p.id), sku: p.sku, b2c_ref: p.b2c_ref }; }) : 'not in b2b_products (the shop→trade copy skips products without a confirmed SKU)';
    }
    out.products.push(row);
  });
  return out;
}

/* ── report ───────────────────────────────────────────────────────────── */
function markdown(r) {
  const L = [];
  const t = function (rows) { return rows.length ? rows : ['_none_']; };
  L.push('# Catalogue reconciliation', '', 'Generated ' + r.generatedAt + ' by `scripts/reconcile-catalogue.js` (read-only: nothing was imported, changed or deleted).', '');
  r.priceLists.forEach(function (p, i) {
    const f = r.findings[i];
    L.push('## Price list ' + (i + 1) + ': ' + p.file, '', '- Title: ' + p.meta.title, '- SHA-256: `' + p.sha256 + '` (unchanged after reading)',
      '- Worksheets: ' + p.sheets.map(function (s) { return '"' + s.name + '" (' + s.rows + ' rows × ' + s.columns + ' columns)'; }).join(', '),
      '- Product rows: **' + p.rows.length + '** (SAP codes); held for a person: **' + f.held.length + '**; formula warnings: ' + f.warnings.length, '');
    L.push('### Held rows (not usable until the brand confirms)', '');
    t(f.held.map(function (h) { return '- row ' + h.row + ' · SAP ' + h.sap + ' · ' + h.description + ' ' + h.uom + ' — ' + h.reasons.join('; '); })).forEach(function (x) { L.push(x); });
    L.push('', '### Duplicates', '');
    t(f.duplicateSap.map(function (d) { return '- SAP ' + d.sap + ' appears on rows ' + d.rows.join(', '); })
      .concat(f.duplicateSerial.map(function (d) { return '- serial number (S.No) ' + d.serial + ' is used twice, for different products: ' + d.products.join(' · ') + ' (rows ' + d.rows.join(', ') + ') — numbering only; the SAP codes differ'; }))
      .concat(f.duplicateProduct.map(function (d) { return '- the same product under ' + d.rows.length + ' SAP codes: ' + d.rows.map(function (x) { return 'row ' + x.row + ' SAP ' + x.sap + ' "' + x.description + '" MRP ' + x.mrp; }).join(' · '); }))).forEach(function (x) { L.push(x); });
    L.push('', '### HSN codes', '', '- ' + f.hsnLeadingZero.length + ' codes have 7 digits — Excel dropped the leading zero (e.g. ' + f.hsnLeadingZero.slice(0, 3).map(function (h) { return h.sheet + ' → ' + h.likely; }).join(', ') + '). Store them as 8-digit text.');
    if (f.hsnNot8.length) L.push('- ' + f.hsnNot8.length + ' codes are neither 7 nor 8 digits: ' + f.hsnNot8.map(function (h) { return 'row ' + h.row + ' "' + h.sheet + '"'; }).join(', '));
    L.push('');
  });
  if (r.listComparison) {
    const c = r.listComparison;
    L.push('## The two price lists compared', '', '- Same SAP code, same values: ' + c.same, '- Conflicts: ' + c.conflicts.length, '- Only in the first: ' + c.onlyInFirst.length, '- Only in the second: ' + c.onlyInSecond.length, '');
    c.conflicts.forEach(function (x) { L.push('- SAP ' + x.sap + ' ' + x.description + ': ' + x.differences.map(function (d) { return d.field + ' ' + d.first + ' ≠ ' + d.second; }).join('; ')); });
    L.push('');
  } else {
    L.push('## Second price list', '', '**Not provided.** Only one Excel file was supplied; the comparison between two price lists could not be made. Run this script again with both files (`--price-list` twice).', '');
  }
  if (r.invoice) {
    const v = r.invoice;
    L.push('## Purchase invoice ' + v.invoice.no + ' (' + v.invoice.date + ', ' + v.invoice.supplier + ') against price list 1', '',
      v.invoice.lines + ' invoice lines: ' + v.matched.length + ' matched to a price-list product, ' + v.unmatched.length + ' not matched. Matching is by pack size and name; every partial match is marked for a person to confirm. The invoice is dated ' + v.invoice.date + ' and the price list says "' + r.priceLists[0].meta.title + '", so an MRP difference may be a price revision rather than an error.', '',
      '| Line | Invoice | Price list (SAP) | MRP inv / list | HSN inv / list | Notes |', '|---|---|---|---|---|---|');
    v.matched.forEach(function (m) { L.push('| ' + m.line + ' | ' + m.invoice + ' | ' + m.priceList + ' (' + m.sap + ') | ' + m.mrp.invoice + ' / ' + m.mrp.priceList + ' | ' + m.hsn.invoice + ' / ' + m.hsn.priceList + ' | ' + (m.notes.join('; ') || 'same') + ' |'); });
    v.unmatched.forEach(function (u) { L.push('| ' + u.line + ' | ' + u.description + ' | — | ' + u.mrp + ' / — | ' + u.hsn + ' / — | ' + u.reason + ' |'); });
    L.push('');
  }
  if (r.database) {
    const d = r.database;
    L.push('## Trade product master (MySQL, read-only)', '');
    if (d.error) L.push('**Not read:** ' + d.error, '');
    else {
      L.push('- Products in the database: ' + d.count + ' (' + d.compare.withoutSapCode + ' without a SAP code)', '- In both (by SAP code): ' + d.compare.inBoth,
        '- In the price list but missing from the database: ' + d.compare.missingInDatabase.length, '- In the database with a SAP code not in the price list: ' + d.compare.onlyInDatabase.length,
        '- Conflicting values: ' + d.compare.conflicts.length, '- Duplicate SAP codes in the database: ' + d.compare.duplicatesInDatabase.length, '');
      d.compare.conflicts.forEach(function (x) { L.push('- id ' + x.id + ' (' + x.sku + ', SAP ' + x.sap + '): ' + x.differences.map(function (f) { return f.field + ' database ' + f.database + ' ≠ list ' + f.priceList; }).join('; ')); });
      d.compare.duplicatesInDatabase.forEach(function (x) { L.push('- duplicate SAP ' + x.sap + ': ids ' + x.ids.join(', ') + ' (SKUs ' + x.skus.join(', ') + ')'); });
      L.push('');
    }
  } else {
    L.push('## Trade product master (MySQL)', '', '**Not compared in this run** (no `--database`). Run it on the computer that can reach the database: `node scripts/reconcile-catalogue.js --price-list <file> --database`.', '');
  }
  if (r.shop) {
    L.push('## The four protected shop products', '', '- Shop data: ' + r.shop.dataDir + ' — integrity check: **' + r.shop.integrity + '**', '');
    r.shop.problems.forEach(function (p) { L.push('- PROBLEM: ' + p.slug + ' — ' + p.problem); });
    L.push('| Registry id | Name | SKU | SKU candidate (to confirm) | In the price lists | Trade master |', '|---|---|---|---|---|---|');
    r.shop.products.forEach(function (p) { L.push('| `' + p.id + '` | ' + p.name + ' | ' + (p.sku || '— (to confirm)') + ' | ' + (p.skuCandidate || '—') + ' | no | ' + (p.tradeMaster ? (typeof p.tradeMaster === 'string' ? p.tradeMaster : p.tradeMaster.map(function (x) { return 'id ' + x.id + ' ' + x.sku; }).join(', ')) : 'not checked') + ' |'); });
    L.push('');
  }
  return L.join('\n') + '\n';
}

async function main(argv) {
  const lists = [], opts = { invoice: null, database: false, shop: false, out: null, allowProd: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--price-list') lists.push(argv[++i]);
    else if (a === '--invoice') opts.invoice = argv[++i];
    else if (a === '--database') opts.database = true;
    else if (a === '--shop') opts.shop = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--i-understand-read-only') opts.allowProd = true;
    else { console.error('Unknown option ' + a); return 2; }
  }
  if (!lists.length || lists.some(function (f) { return !f || !fs.existsSync(f); })) { console.error('Give at least one existing --price-list <file.xlsx>.'); return 2; }
  const r = { generatedAt: new Date().toISOString(), priceLists: [], findings: [] };
  for (const f of lists) { const p = await readPriceList(f); r.priceLists.push(p); r.findings.push(checkList(p)); }
  if (r.priceLists.length > 1) r.listComparison = compareLists(r.priceLists[0], r.priceLists[1]);
  if (opts.invoice) r.invoice = matchInvoice(JSON.parse(fs.readFileSync(opts.invoice, 'utf8')), r.priceLists[0]);
  let dbr = null;
  if (opts.database) {
    try { dbr = await readDatabase(opts.allowProd); r.database = dbr.note ? { error: dbr.note } : { count: dbr.products.length, compare: compareDatabase(r.priceLists[0], dbr) }; }
    catch (e) { r.database = { error: e.code || e.message }; }
  }
  if (opts.shop) r.shop = checkShop(dbr);
  const out = path.resolve(opts.out || ('reconciliation-' + r.generatedAt.replace(/[:.]/g, '-')));
  fs.mkdirSync(out, { recursive: true });
  const json = Object.assign({}, r, { priceLists: r.priceLists.map(function (p) { return Object.assign({}, p, { rows: p.rows.map(function (x) { return { row: x.row, sap: x.sap, description: x.desc, uom: x.uom, hsn: x.hsn, mrp: x.mrp, gst_bp: x.gst_bp, status: x.status, reasons: x.reasons }; }) }); }) });
  fs.writeFileSync(path.join(out, 'reconciliation.json'), JSON.stringify(json, null, 1));
  fs.writeFileSync(path.join(out, 'reconciliation.md'), markdown(r));
  console.log('Report: ' + path.join(out, 'reconciliation.md'));
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then(function (c) { process.exitCode = c; }, function (e) { console.error(e.message); process.exitCode = 1; });
module.exports = { main, size, words, similarity, hsn8, checkList, compareLists, matchInvoice, compareDatabase };
