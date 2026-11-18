/**
 * Excel / CSV product import.
 *
 *   upload → detect columns → map columns → validate → preview → confirm → apply → result
 *
 * Safety rules:
 *  - SKU is the matching key. A SKU that exists is UPDATED, one that does not is CREATED.
 *  - Blank cells never overwrite existing data.
 *  - Nothing touches the product tables until the admin confirms.
 *  - Apply runs in ONE database transaction: it either completes or leaves the
 *    catalogue exactly as it was.
 *  - Every changed product's previous values are kept, so a completed import
 *    can be rolled back.
 */
const fs = require('fs');
const db = require('../../../db/connection.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const uploads = require('../lib/uploads.js');
const catalogue = require('../catalogue/service.js');
const inventory = require('../inventory/service.js');
const { bad, notFound, conflict } = require('../lib/http.js');

const MAX_ROWS = 20000;

/** Importable fields, their template headers and the header spellings recognised automatically. */
const FIELDS = [
  { key: 'sku', label: 'SKU', required: true, aliases: ['sku', 'skucode', 'itemcode', 'productcode', 'code'] },
  { key: 'name', label: 'Product Name', required: true, aliases: ['productname', 'name', 'itemname', 'product', 'title'] },
  { key: 'category', label: 'Category', aliases: ['category', 'cat'] },
  { key: 'subcategory', label: 'Subcategory', aliases: ['subcategory', 'subcat'] },
  { key: 'brand', label: 'Brand', aliases: ['brand'] },
  { key: 'hsn_code', label: 'HSN', aliases: ['hsn', 'hsncode', 'hsnsac'] },
  { key: 'gst_rate', label: 'GST Rate', aliases: ['gstrate', 'gst', 'tax', 'taxrate', 'gstpercent'] },
  { key: 'mrp', label: 'MRP', aliases: ['mrp', 'maxretailprice'] },
  { key: 'base_price', label: 'Base Price', aliases: ['baseprice', 'base', 'costprice', 'cost'] },
  { key: 'distributor_margin', label: 'Distributor Margin', aliases: ['distributormargin', 'distmargin', 'distributormarginpercent'] },
  { key: 'retailer_margin', label: 'Retailer Margin', aliases: ['retailermargin', 'retmargin', 'retailermarginpercent'] },
  { key: 'moq', label: 'MOQ', aliases: ['moq', 'minorderqty', 'minimumorderquantity', 'minqty'] },
  { key: 'case_qty', label: 'Case Quantity', aliases: ['casequantity', 'caseqty', 'casesize', 'unitspercase'] },
  { key: 'pack_size', label: 'Pack Size', aliases: ['packsize', 'pack', 'size'] },
  { key: 'barcode', label: 'Barcode', aliases: ['barcode', 'ean', 'upc', 'gtin'] },
  { key: 'opening_stock', label: 'Opening Stock', aliases: ['openingstock', 'stock', 'openingqty', 'quantity', 'qty'] },
  { key: 'warehouse', label: 'Warehouse', aliases: ['warehouse', 'warehousecode', 'godown'] },
  { key: 'active', label: 'Active', aliases: ['active', 'isactive', 'status', 'enabled'] },
  // Optional extras (not in the standard template, but mapped when present)
  { key: 'description', label: 'Description', aliases: ['description', 'desc'] },
  { key: 'image_url', label: 'Image URL', aliases: ['imageurl', 'image', 'productimage'] },
  { key: 'distributor_price', label: 'Distributor Price', aliases: ['distributorprice'] },
  { key: 'retailer_price', label: 'Retailer Price', aliases: ['retailerprice'] },
  { key: 'batch_no', label: 'Batch', aliases: ['batch', 'batchno', 'batchnumber'] },
  { key: 'expiry_date', label: 'Expiry', aliases: ['expiry', 'expirydate', 'exp'] },
];
const TEMPLATE_KEYS = ['sku', 'name', 'category', 'subcategory', 'brand', 'hsn_code', 'gst_rate', 'mrp', 'base_price', 'distributor_margin',
  'retailer_margin', 'moq', 'case_qty', 'pack_size', 'barcode', 'opening_stock', 'warehouse', 'active'];
const FIELD_BY_KEY = {}; FIELDS.forEach(function (f) { FIELD_BY_KEY[f.key] = f; });

const norm = function (h) { return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, ''); };

/** header text → field key, for every header we can recognise. */
function detectMapping(headers) {
  const mapping = {}, used = {};
  headers.forEach(function (h) {
    const n = norm(h);
    if (!n) return;
    const field = FIELDS.find(function (f) { return !used[f.key] && (f.aliases.indexOf(n) !== -1 || norm(f.label) === n); });
    if (field) { mapping[h] = field.key; used[field.key] = true; }
  });
  return mapping;
}

/* ─────────── File parsing ─────────── */

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.result !== undefined) return cellText(value.result);                 // formula
    if (Array.isArray(value.richText)) return value.richText.map(function (t) { return t.text; }).join('');
    if (value.text !== undefined) return String(value.text);                       // hyperlink
    if (value.error) return '';
    return '';
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  return String(value).trim();
}

async function parseXlsx(path) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets.find(function (w) { return w.actualRowCount > 0 && !/instruction/i.test(w.name); }) || wb.worksheets[0];
  if (!ws) throw bad('The workbook has no sheets');
  const grid = [];
  ws.eachRow({ includeEmpty: false }, function (row, rowNumber) {
    const cells = [];
    for (let c = 1; c <= Math.min(row.cellCount, 60); c++) cells.push(cellText(row.getCell(c).value));
    grid.push({ n: rowNumber, cells: cells });
  });
  return grid;
}

/** Minimal RFC 4180 CSV reader (quoted fields, escaped quotes, CRLF). */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const grid = [];
  let row = [], field = '', inQuotes = false, line = 1, rowLine = 1;
  const pushRow = function () {
    row.push(field.trim()); field = '';
    if (row.some(function (c) { return c !== ''; })) grid.push({ n: rowLine, cells: row.slice(0, 60) });
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else { if (ch === '\n') line++; field += ch; }
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field.trim()); field = ''; }
    else if (ch === '\n') { pushRow(); line++; rowLine = line; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) pushRow();
  return grid;
}

async function readFile(storedName) {
  const p = uploads.importPath(storedName);
  if (!p) throw notFound('The uploaded file is no longer available');
  const grid = storedName.endsWith('.xlsx') ? await parseXlsx(p) : parseCsv(fs.readFileSync(p, 'utf8'));
  if (!grid.length) throw bad('The file is empty');
  const headerRow = grid[0];
  const headers = headerRow.cells.map(function (h, i) { return h || ''; });
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  if (!headers.filter(Boolean).length) throw bad('The first row must contain column headings');
  const seen = {};
  headers.forEach(function (h, i) {
    if (!h) return;
    if (seen[h.toLowerCase()]) throw bad('Column heading "' + h + '" appears more than once');
    seen[h.toLowerCase()] = true;
  });
  const rows = grid.slice(1).map(function (r) {
    const obj = {};
    headers.forEach(function (h, i) { if (h) obj[h] = r.cells[i] == null ? '' : r.cells[i]; });
    return { rowNo: r.n, data: obj };
  }).filter(function (r) { return Object.keys(r.data).some(function (k) { return r.data[k] !== ''; }); });
  return { headers: headers.filter(Boolean), rows: rows };
}

/* ─────────── 1. Upload ─────────── */

async function upload(file, actor) {
  if (!file) throw bad('Choose an Excel (.xlsx) or CSV file');
  const saved = uploads.saveImportFile(file);
  let parsed;
  try { parsed = await readFile(saved.storedName); }
  catch (e) {
    try { fs.unlinkSync(uploads.importPath(saved.storedName)); } catch (_) { /* ignore */ }
    if (e.expose) throw e;
    throw bad('The file could not be read. Save it as .xlsx or .csv and try again.');
  }
  if (!parsed.rows.length) throw bad('The file has headings but no data rows');
  if (parsed.rows.length > MAX_ROWS) throw bad('The file has ' + parsed.rows.length + ' rows. Import at most ' + MAX_ROWS + ' rows at a time.');
  const mapping = detectMapping(parsed.headers);
  const res = await db.query(
    "INSERT INTO b2b_imports (file_name, stored_name, uploaded_by, status, total_rows, headers_json, mapping_json) VALUES (?, ?, ?, 'uploaded', ?, ?, ?)",
    [saved.originalName, saved.storedName, actor.label, parsed.rows.length, JSON.stringify(parsed.headers), JSON.stringify(mapping)]);
  const importId = res.insertId;
  for (let i = 0; i < parsed.rows.length; i += 500) {
    await db.bulk('INSERT INTO b2b_import_rows (import_id, row_no, raw_json) VALUES ?',
      parsed.rows.slice(i, i + 500).map(function (r) { return [importId, r.rowNo, JSON.stringify(r.data)]; }));
  }
  await audit.log(null, actor, 'import.uploaded', 'import', importId, null, { file: saved.originalName, rows: parsed.rows.length });
  return {
    id: importId, file_name: saved.originalName, total_rows: parsed.rows.length, headers: parsed.headers, mapping: mapping,
    fields: FIELDS.map(function (f) { return { key: f.key, label: f.label, required: !!f.required }; }),
    sample: parsed.rows.slice(0, 5).map(function (r) { return Object.assign({ _row: r.rowNo }, r.data); }),
  };
}

/* ─────────── 2. Validate ─────────── */

function applyMapping(raw, mapping) {
  const out = {};
  Object.keys(mapping).forEach(function (header) {
    const key = mapping[header];
    if (key && raw[header] !== undefined) out[key] = typeof raw[header] === 'string' ? raw[header].trim() : raw[header];
  });
  return out;
}

function cleanMapping(input, headers) {
  const mapping = {}, used = {};
  Object.keys(input || {}).forEach(function (h) {
    const key = input[h];
    if (!key) return;
    if (headers.indexOf(h) === -1) throw bad('Unknown column "' + h + '"');
    if (!FIELD_BY_KEY[key]) throw bad('Unknown field "' + key + '"');
    if (used[key]) throw bad('"' + FIELD_BY_KEY[key].label + '" is mapped to more than one column');
    used[key] = true; mapping[h] = key;
  });
  FIELDS.filter(function (f) { return f.required; }).forEach(function (f) {
    if (!used[f.key]) throw bad('Map a column to "' + f.label + '" — it is required');
  });
  return mapping;
}

/** Validate one mapped row against the catalogue. Returns { action, errors, product }. */
function checkRow(m, existing, mode, warehouses, defaultWarehouse) {
  const errors = [];
  const isUpdate = !!existing;
  const input = { sku: m.sku, name: m.name, brand: m.brand, description: m.description, image_url: m.image_url, barcode: m.barcode,
    hsn_code: m.hsn_code, gst_rate: m.gst_rate, mrp: m.mrp, base_price: m.base_price, distributor_margin: m.distributor_margin,
    retailer_margin: m.retailer_margin, distributor_price: m.distributor_price, retailer_price: m.retailer_price,
    moq: m.moq, case_qty: m.case_qty, pack_size: m.pack_size, is_active: m.active };
  // Blank cells mean "leave as is" on update, and "use the default" on create.
  Object.keys(input).forEach(function (k) { if (input[k] === undefined || input[k] === '') delete input[k]; });
  if (!isUpdate) { input.gst_rate = input.gst_rate === undefined ? '' : input.gst_rate; input.mrp = input.mrp === undefined ? '' : input.mrp; input.base_price = input.base_price === undefined ? '' : input.base_price; }
  if (input.sku === undefined) input.sku = '';
  if (!isUpdate && input.name === undefined) input.name = '';
  const r = catalogue.readProduct(input, isUpdate);
  r.errors.forEach(function (e) { errors.push(e.replace('Invalid margin', 'Invalid margin')); });

  let stockQty = 0, warehouseId = null;
  if (m.opening_stock !== undefined && m.opening_stock !== '') {
    const n = Number(m.opening_stock);
    if (!Number.isInteger(n) || n < 0 || n > 10000000) errors.push('Invalid opening stock');
    else stockQty = n;
  }
  if (m.warehouse) {
    const wh = warehouses[String(m.warehouse).trim().toLowerCase()];
    if (!wh) errors.push('Unknown warehouse "' + m.warehouse + '"'); else warehouseId = wh;
  } else if (stockQty > 0) {
    if (!defaultWarehouse) errors.push('No warehouse given and no default warehouse exists'); else warehouseId = defaultWarehouse;
  }
  if (m.expiry_date && !v.date(m.expiry_date)) errors.push('Invalid expiry date');
  if (m.subcategory && !m.category && !isUpdate) errors.push('Subcategory given without a category');

  let action = isUpdate ? 'update' : 'create';
  if (isUpdate && r.data.is_active === 0 && Number(existing.is_active) === 1) action = 'deactivate';
  if ((mode === 'create_only' && isUpdate) || (mode === 'update_only' && !isUpdate)) action = 'skip';
  return { action: action, errors: errors, product: r.data,
    extra: { category: v.text(m.category, 100), subcategory: v.text(m.subcategory, 100), stockQty: stockQty, warehouseId: warehouseId,
      batch_no: v.text(m.batch_no, 60), expiry_date: m.expiry_date ? v.date(m.expiry_date) : null } };
}

async function warehouseIndex() {
  const list = await inventory.companyWarehouses();
  const idx = {};
  list.forEach(function (w) { idx[String(w.code).toLowerCase()] = w.id; idx[String(w.name).toLowerCase()] = w.id; });
  return { index: idx, defaultId: list.length ? list[0].id : null };
}

async function existingBySku(skus, q) {
  const run = q ? q.query.bind(q) : db.query;
  const out = {};
  for (let i = 0; i < skus.length; i += 1000) {
    const chunk = skus.slice(i, i + 1000);
    if (!chunk.length) continue;
    (await run('SELECT * FROM b2b_products WHERE sku IN (' + db.placeholders(chunk) + ')', chunk)).forEach(function (p) { out[String(p.sku).toLowerCase()] = p; });
  }
  return out;
}

async function validate(importId, body, actor) {
  const imp = await db.queryOne('SELECT * FROM b2b_imports WHERE id = ?', [importId]);
  if (!imp) throw notFound('Import not found');
  if (['uploaded', 'ready'].indexOf(imp.status) === -1) throw bad('This import is ' + imp.status.replace('_', ' ') + ' and can no longer be changed');
  const headers = JSON.parse(imp.headers_json || '[]');
  const mapping = cleanMapping(body.mapping || JSON.parse(imp.mapping_json || '{}'), headers);
  const mode = ['create_update', 'create_only', 'update_only'].indexOf(body.mode) !== -1 ? body.mode : 'create_update';
  const claimed = await db.query("UPDATE b2b_imports SET status = 'validating', mapping_json = ?, options_json = ? WHERE id = ? AND status IN ('uploaded','ready')",
    [JSON.stringify(mapping), JSON.stringify({ mode: mode }), importId]);
  if (!claimed.affectedRows) throw conflict('This import is already being processed');

  try {
    const wh = await warehouseIndex();
    const counts = { valid: 0, invalid: 0, create: 0, update: 0, deactivate: 0, skip: 0 };
    const seenSku = {};
    let lastId = 0;
    for (;;) {
      const rows = await db.query('SELECT id, row_no, raw_json FROM b2b_import_rows WHERE import_id = ? AND id > ? ORDER BY id LIMIT 500', [importId, lastId]);
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;
      const mapped = rows.map(function (r) { return { id: r.id, rowNo: r.row_no, m: applyMapping(JSON.parse(r.raw_json), mapping) }; });
      const existing = await existingBySku(mapped.map(function (x) { return v.text(x.m.sku, 64); }).filter(Boolean));
      await db.transaction(async function (tx) {
        for (const x of mapped) {
          const skuKey = v.text(x.m.sku, 64).toLowerCase();
          const res = checkRow(x.m, skuKey ? existing[skuKey] : null, mode, wh.index, wh.defaultId);
          if (skuKey) {
            if (seenSku[skuKey]) res.errors.push('Duplicate SKU (also on row ' + seenSku[skuKey] + ')');
            else seenSku[skuKey] = x.rowNo;
          }
          const ok = res.errors.length === 0;
          if (ok) { counts.valid++; counts[res.action]++; } else counts.invalid++;
          await tx.query('UPDATE b2b_import_rows SET action = ?, is_valid = ?, errors_json = ?, product_id = ? WHERE id = ?',
            [res.action, ok ? 1 : 0, ok ? null : JSON.stringify(res.errors), skuKey && existing[skuKey] ? existing[skuKey].id : null, x.id]);
        }
      });
    }
    await db.query("UPDATE b2b_imports SET status = 'ready', valid_rows = ?, invalid_rows = ?, created_count = 0, updated_count = 0, deactivated_count = 0, skipped_count = 0, error_message = NULL WHERE id = ?",
      [counts.valid, counts.invalid, importId]);
    return { id: Number(importId), status: 'ready', total_rows: Number(imp.total_rows), valid: counts.valid, invalid: counts.invalid,
      willCreate: counts.create, willUpdate: counts.update, willDeactivate: counts.deactivate, willSkip: counts.skip, mode: mode };
  } catch (e) {
    await db.query("UPDATE b2b_imports SET status = 'uploaded', error_message = ? WHERE id = ?", [String(e.message).slice(0, 500), importId]);
    throw e;
  }
}

/* ─────────── 3. Preview ─────────── */

async function preview(importId, f, pg) {
  const imp = await db.queryOne('SELECT * FROM b2b_imports WHERE id = ?', [importId]);
  if (!imp) throw notFound('Import not found');
  const where = ['import_id = ?'], params = [importId];
  if (f.filter === 'invalid') where.push('is_valid = 0'); else if (f.filter === 'valid') where.push('is_valid = 1');
  if (f.action) { where.push('action = ?'); params.push(String(f.action)); }
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_import_rows WHERE ' + where.join(' AND '), params);
  const rows = await db.query('SELECT row_no, raw_json, action, is_valid, errors_json, applied FROM b2b_import_rows WHERE ' + where.join(' AND ') +
    ' ORDER BY row_no LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  const mapping = JSON.parse(imp.mapping_json || '{}');
  return {
    import: summary(imp), total: Number(total.n),
    rows: rows.map(function (r) {
      return { row: r.row_no, action: r.action, valid: r.is_valid == null ? null : !!Number(r.is_valid), applied: !!Number(r.applied),
        errors: r.errors_json ? JSON.parse(r.errors_json) : [], values: applyMapping(JSON.parse(r.raw_json), mapping) };
    }),
  };
}

function summary(imp) {
  return { id: Number(imp.id), file_name: imp.file_name, uploaded_by: imp.uploaded_by, status: imp.status, total_rows: Number(imp.total_rows),
    valid_rows: Number(imp.valid_rows), invalid_rows: Number(imp.invalid_rows), created: Number(imp.created_count), updated: Number(imp.updated_count),
    deactivated: Number(imp.deactivated_count), skipped: Number(imp.skipped_count), error_message: imp.error_message,
    created_at: imp.created_at, started_at: imp.started_at, finished_at: imp.finished_at,
    headers: JSON.parse(imp.headers_json || '[]'), mapping: JSON.parse(imp.mapping_json || '{}'), options: JSON.parse(imp.options_json || '{}') };
}

async function get(importId) {
  const imp = await db.queryOne('SELECT * FROM b2b_imports WHERE id = ?', [importId]);
  if (!imp) throw notFound('Import not found');
  return summary(imp);
}

async function list(pg) {
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_imports');
  const rows = await db.query('SELECT * FROM b2b_imports ORDER BY id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset);
  return { rows: rows.map(summary), total: Number(total.n) };
}

/** "Row 42: Invalid GST" — one line per problem, as CSV. */
async function errorReport(importId) {
  const rows = await db.query('SELECT row_no, raw_json, errors_json FROM b2b_import_rows WHERE import_id = ? AND is_valid = 0 ORDER BY row_no LIMIT 20000', [importId]);
  const esc = function (s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = ['Row,SKU,Error'];
  rows.forEach(function (r) {
    const raw = JSON.parse(r.raw_json);
    const sku = raw.SKU || raw.sku || Object.values(raw)[0] || '';
    JSON.parse(r.errors_json || '[]').forEach(function (e) { lines.push([r.row_no, esc(sku), esc(e)].join(',')); });
  });
  return lines.join('\r\n');
}

/* ─────────── 4. Apply (one transaction) ─────────── */

const SNAPSHOT_COLUMNS = ['name', 'category_id', 'subcategory_id', 'brand', 'description', 'image_url', 'barcode', 'hsn_code', 'gst_rate', 'mrp', 'base_price',
  'distributor_price', 'retailer_price', 'distributor_margin', 'retailer_margin', 'moq', 'case_qty', 'pack_size', 'is_active'];

async function runApply(importId, actor) {
  const imp = await db.queryOne('SELECT * FROM b2b_imports WHERE id = ?', [importId]);
  const mapping = JSON.parse(imp.mapping_json || '{}');
  const mode = (JSON.parse(imp.options_json || '{}').mode) || 'create_update';
  const wh = await warehouseIndex();
  const counts = { create: 0, update: 0, deactivate: 0, skip: 0 };

  await db.transaction(async function (tx) {
    const catCache = {};
    let lastId = 0;
    for (;;) {
      const rows = await tx.query('SELECT id, row_no, raw_json FROM b2b_import_rows WHERE import_id = ? AND is_valid = 1 AND id > ? ORDER BY id LIMIT 500', [importId, lastId]);
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;
      const mapped = rows.map(function (r) { return { id: r.id, rowNo: r.row_no, m: applyMapping(JSON.parse(r.raw_json), mapping) }; });
      // Re-read the catalogue inside the transaction: it may have changed since the preview.
      const existing = await existingBySku(mapped.map(function (x) { return v.text(x.m.sku, 64); }), tx);
      for (const x of mapped) {
        const skuKey = v.text(x.m.sku, 64).toLowerCase();
        const current = existing[skuKey] || null;
        const res = checkRow(x.m, current, mode, wh.index, wh.defaultId);
        if (res.errors.length) throw new Error('Row ' + x.rowNo + ' is no longer valid (' + res.errors[0] + '). Validate the file again.');
        if (res.action === 'skip') { counts.skip++; await tx.query("UPDATE b2b_import_rows SET action = 'skip', applied = 0 WHERE id = ?", [x.id]); continue; }

        const data = Object.assign({}, res.product);
        if (res.extra.category) {
          data.category_id = await catalogue.ensureCategory(tx, res.extra.category, null, catCache);
          data.subcategory_id = res.extra.subcategory ? await catalogue.ensureCategory(tx, res.extra.subcategory, data.category_id, catCache) : (current ? undefined : null);
          if (data.subcategory_id === undefined) delete data.subcategory_id;
        } else if (res.extra.subcategory && current && current.category_id) {
          data.subcategory_id = await catalogue.ensureCategory(tx, res.extra.subcategory, current.category_id, catCache);
        }

        let productId, before = null;
        if (current) {
          delete data.sku;
          const sets = [], params = [];
          before = {};
          Object.keys(data).forEach(function (k) {
            const prev = current[k];
            const same = String(prev == null ? '' : prev) === String(data[k] == null ? '' : data[k]) ||
              (prev != null && data[k] != null && !Number.isNaN(Number(prev)) && !Number.isNaN(Number(data[k])) && Number(prev) === Number(data[k]) && typeof prev !== 'object');
            if (same) return;
            sets.push(k + ' = ?'); params.push(data[k]);
          });
          SNAPSHOT_COLUMNS.forEach(function (k) { before[k] = current[k]; });
          productId = current.id;
          if (sets.length) { params.push(productId); await tx.query('UPDATE b2b_products SET ' + sets.join(', ') + ' WHERE id = ?', params); }
          counts[res.action]++;
        } else {
          const cols = Object.keys(data);
          const ins = await tx.query('INSERT INTO b2b_products (' + cols.join(', ') + ') VALUES (' + db.placeholders(cols) + ')', cols.map(function (c) { return data[c]; }));
          productId = ins.insertId;
          existing[skuKey] = Object.assign({ id: productId, is_active: 1 }, data);
          counts.create++;
        }

        // Opening stock is only posted where no stock record exists yet — re-importing a file never double-counts.
        let stockPosted = 0;
        if (res.extra.stockQty > 0 && res.extra.warehouseId) {
          const has = await tx.queryOne('SELECT 1 AS x FROM b2b_stock WHERE warehouse_id = ? AND product_id = ?', [res.extra.warehouseId, productId]);
          if (!has) {
            await inventory.receive(tx, { warehouse_id: res.extra.warehouseId, product_id: productId, qty: res.extra.stockQty, type: 'opening',
              batch_no: res.extra.batch_no, expiry_date: res.extra.expiry_date, ref_type: 'import', ref_id: importId, reason: 'Excel import #' + importId, actor: actor });
            stockPosted = res.extra.stockQty;
          }
        }
        await tx.query('UPDATE b2b_import_rows SET action = ?, applied = 1, product_id = ?, before_json = ? WHERE id = ?',
          [res.action, productId, JSON.stringify({ before: before, stock: stockPosted, warehouse_id: res.extra.warehouseId }), x.id]);
      }
    }
    await tx.query("UPDATE b2b_imports SET status = 'completed', created_count = ?, updated_count = ?, deactivated_count = ?, skipped_count = ?, finished_at = UTC_TIMESTAMP(), error_message = NULL WHERE id = ?",
      [counts.create, counts.update, counts.deactivate, counts.skip, importId]);
    await audit.log(tx, actor, 'import.completed', 'import', importId, null,
      { file: imp.file_name, created: counts.create, updated: counts.update, deactivated: counts.deactivate, skipped: counts.skip, invalid_rows_not_imported: Number(imp.invalid_rows) });
  }, { attempts: 1 });
  return counts;
}

/**
 * Confirm + apply. Returns immediately; the work continues in the background
 * and the import's status moves processing → completed | failed. Poll GET /imports/:id.
 */
async function apply(importId, actor, opts) {
  const imp = await db.queryOne('SELECT * FROM b2b_imports WHERE id = ?', [importId]);
  if (!imp) throw notFound('Import not found');
  if (imp.status !== 'ready') throw bad('Validate the file before importing (status: ' + imp.status.replace('_', ' ') + ')');
  if (!Number(imp.valid_rows)) throw bad('There are no valid rows to import');
  const claimed = await db.query("UPDATE b2b_imports SET status = 'processing', started_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'ready'", [importId]);
  if (!claimed.affectedRows) throw conflict('This import has already been started');
  const job = runApply(importId, actor).catch(async function (e) {
    console.error('[B2B IMPORT] import ' + importId + ' failed and was rolled back:', e.code || e.message);
    const msg = e.expose || /^Row \d+/.test(e.message) ? e.message : 'The import failed and nothing was changed. Please try again.';
    await db.query("UPDATE b2b_imports SET status = 'failed', finished_at = UTC_TIMESTAMP(), error_message = ? WHERE id = ?", [String(msg).slice(0, 500), importId]).catch(function () {});
    await audit.log(null, actor, 'import.failed', 'import', importId, null, { error: String(e.code || e.message).slice(0, 300) }).catch(function () {});
  });
  if (opts && opts.wait) await job;
  return { id: Number(importId), status: 'processing' };
}

/* ─────────── 5. Roll back a completed import ─────────── */

async function rollback(importId, actor) {
  const claimed = await db.query("UPDATE b2b_imports SET status = 'processing' WHERE id = ? AND status = 'completed'", [importId]);
  if (!claimed.affectedRows) {
    const imp = await db.queryOne('SELECT status FROM b2b_imports WHERE id = ?', [importId]);
    if (!imp) throw notFound('Import not found');
    throw bad('Only a completed import can be rolled back (status: ' + imp.status.replace('_', ' ') + ')');
  }
  try {
    const result = await db.transaction(async function (tx) {
      let restored = 0, deactivated = 0, stockReversed = 0, stockSkipped = 0, lastId = 0;
      for (;;) {
        const rows = await tx.query('SELECT id, action, product_id, before_json FROM b2b_import_rows WHERE import_id = ? AND applied = 1 AND id > ? ORDER BY id LIMIT 500', [importId, lastId]);
        if (!rows.length) break;
        lastId = rows[rows.length - 1].id;
        for (const r of rows) {
          const snap = JSON.parse(r.before_json || '{}');
          if (snap.before) {
            const cols = Object.keys(snap.before);
            await tx.query('UPDATE b2b_products SET ' + cols.map(function (c) { return c + ' = ?'; }).join(', ') + ' WHERE id = ?',
              cols.map(function (c) { return snap.before[c]; }).concat([r.product_id]));
            restored++;
          } else {
            // Created by this import: retire it rather than delete it, in case it is already on an order.
            await tx.query('UPDATE b2b_products SET is_active = 0 WHERE id = ?', [r.product_id]);
            deactivated++;
          }
          if (snap.stock > 0 && snap.warehouse_id) {
            const ok = await inventory.move(tx, { warehouse_id: snap.warehouse_id, product_id: r.product_id, type: 'adjustment', qty: snap.stock, from: 'available',
              ref_type: 'import', ref_id: importId, reason: 'Rollback of import #' + importId, actor: actor });
            if (ok) stockReversed++; else stockSkipped++;
          }
          await tx.query('UPDATE b2b_import_rows SET applied = 0 WHERE id = ?', [r.id]);
        }
      }
      await tx.query("UPDATE b2b_imports SET status = 'rolled_back', finished_at = UTC_TIMESTAMP() WHERE id = ?", [importId]);
      await audit.log(tx, actor, 'import.rolled_back', 'import', importId, null, { restored: restored, deactivated: deactivated, stockReversed: stockReversed, stockNotReversed: stockSkipped });
      return { status: 'rolled_back', restored: restored, deactivated: deactivated, stockReversed: stockReversed, stockNotReversed: stockSkipped };
    }, { attempts: 1 });
    return result;
  } catch (e) {
    await db.query("UPDATE b2b_imports SET status = 'completed' WHERE id = ? AND status = 'processing'", [importId]);
    throw e;
  }
}

/** On boot: an import that was mid-flight when the process died was rolled back by MySQL — say so. */
async function recoverInterrupted() {
  await db.query(
    "UPDATE b2b_imports SET status = 'failed', finished_at = UTC_TIMESTAMP(), error_message = 'The server restarted during this import. Nothing was changed — please run it again.' " +
    "WHERE status = 'processing' AND started_at < (UTC_TIMESTAMP() - INTERVAL 15 MINUTE)");
  await db.query("UPDATE b2b_imports SET status = 'uploaded' WHERE status = 'validating' AND created_at < (UTC_TIMESTAMP() - INTERVAL 15 MINUTE)");
}

/* ─────────── Template ─────────── */

async function templateWorkbook() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sake of Health';
  const ws = wb.addWorksheet('Products');
  ws.columns = TEMPLATE_KEYS.map(function (k) { return { header: FIELD_BY_KEY[k].label, key: k, width: Math.max(14, FIELD_BY_KEY[k].label.length + 4) }; });
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5D1F' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.addRow({ sku: 'GUM001', name: 'SOH Gummies 30 Count', category: 'Gummies', subcategory: 'Multivitamin', brand: 'Sake of Health', hsn_code: '21069099',
    gst_rate: 18, mrp: 499, base_price: 250, distributor_margin: 12, retailer_margin: 18, moq: 10, case_qty: 20, pack_size: '30 gummies',
    barcode: '8901234567890', opening_stock: 500, warehouse: 'BLR-MAIN', active: 'Yes' });
  ws.addRow({ sku: 'GUM002', name: 'SOH Gummies 60 Count', category: 'Gummies', subcategory: 'Multivitamin', brand: 'Sake of Health', hsn_code: '21069099',
    gst_rate: 18, mrp: 899, base_price: 450, distributor_margin: '', retailer_margin: '', moq: 10, case_qty: 10, pack_size: '60 gummies',
    barcode: '8901234567906', opening_stock: 300, warehouse: 'BLR-MAIN', active: 'Yes' });
  const help = wb.addWorksheet('Instructions');
  help.columns = [{ width: 24 }, { width: 100 }];
  [['Column', 'How it is used'],
    ['SKU', 'Required. The matching key: an existing SKU is updated, a new SKU is created. Must be unique in the file.'],
    ['Product Name', 'Required for new products.'],
    ['Category / Subcategory', 'Created automatically if they do not exist yet.'],
    ['HSN', '4, 6 or 8 digits.'],
    ['GST Rate', 'Percent, e.g. 5, 12, 18. Required for new products.'],
    ['MRP / Base Price', 'Rupees. Required for new products. Base Price is your price before trade margin, excluding GST.'],
    ['Distributor / Retailer Margin', 'Percent. Leave blank to use the category or default margin.'],
    ['MOQ / Case Quantity', 'Whole numbers. Orders must be at least the MOQ and in multiples of the case quantity.'],
    ['Opening Stock / Warehouse', 'Posted once, when the product has no stock record in that warehouse. Warehouse = code (e.g. BLR-MAIN); blank = default warehouse.'],
    ['Active', 'Yes / No. "No" on an existing product deactivates it.'],
    ['Blank cells', 'On an existing product a blank cell leaves the current value unchanged — it never clears data.'],
    ['Delete the two sample rows', 'before uploading your own data.'],
  ].forEach(function (r, i) { const row = help.addRow(r); if (i === 0) row.font = { bold: true }; });
  return wb;
}

module.exports = { FIELDS, TEMPLATE_KEYS, detectMapping, parseCsv, upload, validate, preview, get, list, errorReport, apply, rollback, recoverInterrupted, templateWorkbook, MAX_ROWS };
