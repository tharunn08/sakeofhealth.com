/**
 * Catalogue reconciliation (scripts/reconcile-catalogue.js) on the real inputs: the Sri Sri Tattva price list
 * (tests/fixtures/ss-price-list-2026-10-09.xlsx — byte-identical to the file supplied on 19 Nov 2026) and
 * the lines of purchase invoice 4050191465 (docs/reconciliation/invoice-4050191465.lines.json, extracted
 * from the supplied PDF and checked against the invoice's own HSN and grand totals). Read-only throughout.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const XLSX = path.join(ROOT, 'tests/fixtures/ss-price-list-2026-10-09.xlsx');
const INVOICE = path.join(ROOT, 'docs/reconciliation/invoice-4050191465.lines.json');
const rc = require('../scripts/reconcile-catalogue.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('pack sizes and names are normalised the way the price list and the invoice write them', () => {
  assert.equal(rc.size('500gm'), '500g'); assert.equal(rc.size('1 Kg'), '1000g'); assert.equal(rc.size('1liter'), '1000ml');
  assert.equal(rc.size('Cow#s Premium Ghee 1ltr MRP950'), '1000ml'); assert.equal(rc.size('100gm*4'), '100g*4'); assert.equal(rc.size('15 Sticks'), null);
  assert.equal(rc.hsn8('4059020'), '04059020'); assert.equal(rc.hsn8('33010000'), '33010000');
  assert.equal(rc.similarity('Ujjiyara Toilet Cleaner Wintergreen 500ml 1+1 MRP150', 'Ujjiyara Toilet Cleaner Winter Green Fragrance 1+1') > 0.6, true);
  assert.equal(rc.similarity('Honey 500g MRP260', 'Honey'), 1);
  assert.equal(rc.similarity('Aroma Rose 10ml', 'Aroma Sandal'), 0.5);
});

test('the supplied price list and invoice: every finding, and the Excel file is not changed', async () => {
  const before = sha(XLSX);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-recon-'));
  const code = await rc.main(['--price-list', XLSX, '--invoice', INVOICE, '--out', out]);
  assert.equal(code, 0);
  assert.equal(sha(XLSX), before, 'the price list is never modified');
  const r = JSON.parse(fs.readFileSync(path.join(out, 'reconciliation.json'), 'utf8'));
  const p = r.priceLists[0], f = r.findings[0];
  assert.equal(p.sha256, 'ae59b9484c17f3972bccc2e62a2671b0f25db7222efc86c14e1c6f9e7f4e1f96');
  assert.deepEqual(p.sheets.map(s => s.name), ['SS Price List']);
  assert.equal(p.rows.length, 240);
  assert.deepEqual(f.held.map(h => h.sap).sort(), ['14001145', '14004035', '15006236', '15006237', '15006238']);
  assert.deepEqual(f.duplicateSap, []);
  assert.deepEqual(f.duplicateProduct, []);
  assert.deepEqual(f.duplicateSerial.map(d => [Number(d.serial), d.rows]), [[49, [63, 66]], [50, [64, 68]]]);
  assert.equal(f.hsnLeadingZero.length, 26);
  assert.deepEqual(f.hsnNot8, []);

  const inv = r.invoice;
  assert.equal(inv.matched.length, 30); assert.equal(inv.unmatched.length, 0);
  const line = (n) => inv.matched.find(m => m.line === n);
  // MRP conflicts: all ghee — the invoice (22 Aug 2026) predates the list (revised 9 Oct 2026)
  const mrp = inv.matched.filter(m => m.mrp.invoice !== m.mrp.priceList).map(m => [m.line, m.sap, m.mrp.invoice, m.mrp.priceList]);
  assert.deepEqual(mrp, [[20, '15006518', 950, 1050], [21, '15006517', 485, 535], [22, '15006511', 865, 925], [23, '15006510', 440, 470], [24, '15006507', 195, 205]]);
  assert.match(line(20).notes.join(' '), /15006509 Cow's Pure Ghee Jar/, 'the 1-litre product at MRP 950 is named for a person to check');
  // real HSN differences (not only a lost leading zero)
  const hsn = inv.matched.filter(m => rc.hsn8(m.hsn.invoice) !== rc.hsn8(m.hsn.priceList)).map(m => m.line + ':' + m.hsn.invoice + '/' + m.hsn.priceList);
  assert.deepEqual(hsn, ['1:33019031/33010000', '2:33019031/33010000', '3:33019031/33010000', '4:33019031/33010000', '5:33019031/33010000',
    '7:34022010/34029090', '19:09109990/9100000', '25:21069050/21060000', '26:21069050/21060000', '30:17019990/17010000']);
  assert.ok(inv.matched.every(m => m.gst.invoice === m.gst.priceList), 'GST rates agree on every line');
  const md = fs.readFileSync(path.join(out, 'reconciliation.md'), 'utf8');
  assert.match(md, /## Second price list\n\n\*\*Not provided\.\*\*/);
  assert.match(md, /Not compared in this run/);
});

test('database comparison: existing, missing, only-in-database, conflicts and duplicate SAP codes', () => {
  const list = { rows: [
    { sap: '1', desc: 'Honey', uom: '250gm', mrp: 150, hsn: '4090000', gst_bp: 500 },
    { sap: '2', desc: 'Organic Brown Sugar', uom: '500gm', mrp: 90, hsn: '17010000', gst_bp: 500 },
    { sap: '3', desc: 'Pink Salt (Iodised)', uom: '1kg', mrp: 80, hsn: '25010020', gst_bp: 0 },
  ] };
  const db = { products: [
    { id: 10, sku: 'SST-HONEY-250', sap_code: '1', name: 'Honey 250g', mrp: '150.00', hsn_code: '04090000', gst_rate: '5.00' },
    { id: 11, sku: 'SST-BS-500', sap_code: '2', name: 'Organic Brown Sugar', mrp: '95.00', hsn_code: '17019990', gst_rate: '5.00' },
    { id: 12, sku: 'SST-BS-500-B', sap_code: '2', name: 'Organic Brown Sugar', mrp: '90.00', hsn_code: '17010000', gst_rate: '5.00' },
    { id: 13, sku: 'OLD-1', sap_code: '9', name: 'Discontinued', mrp: '1.00' },
    { id: 14, sku: 'NO-SAP', sap_code: null, name: 'Own brand' },
  ] };
  const c = rc.compareDatabase(list, db);
  assert.equal(c.inBoth, 2);
  assert.deepEqual(c.missingInDatabase.map(x => x.sap), ['3']);
  assert.deepEqual(c.onlyInDatabase.map(x => x.sap), ['9']);
  assert.deepEqual(c.duplicatesInDatabase, [{ sap: '2', ids: [11, 12], skus: ['SST-BS-500', 'SST-BS-500-B'] }]);
  assert.deepEqual(c.conflicts.map(x => [x.id, x.differences.map(d => d.field)]), [[11, ['mrp', 'hsn']]], 'a lost leading zero is not a conflict');
  assert.equal(c.withoutSapCode, 1);
});

test('the database is only read: READ ONLY transaction, rolled back; production needs an explicit flag', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/reconcile-catalogue.js'), 'utf8');
  assert.match(src, /START TRANSACTION READ ONLY/);
  assert.match(src, /finally \{ await c\.raw\.query\('ROLLBACK'\); \}/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|TRUNCATE)\s+(INTO\s+)?b2b_/i.test(src), 'no write statement in the script');
  const r = spawnSync(process.execPath, ['scripts/reconcile-catalogue.js', '--price-list', XLSX, '--database', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'soh-recon-p-'))],
    { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { NODE_ENV: 'production', DB_HOST: '' }) });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(r.stdout.trim().replace(/^Report: /, '').split('\n').pop().replace(/^Report: /, ''), 'utf8');
  assert.match(md, /\*\*Not read:\*\* NODE_ENV is production: add --i-understand-read-only/);
});

test('the invoice extraction matches the invoice\'s own totals', () => {
  const inv = JSON.parse(fs.readFileSync(INVOICE, 'utf8'));
  assert.equal(inv.items.length, 30);
  assert.deepEqual(inv.checks, { lines: 30, line_numbers_1_to_n: true, taxable_total: 45974.9, invoice_taxable_total: 45974.9, hsn_summary_matches: true, each_line_taxable_eq_rate_x_qty_minus_discount: true });
  const taxable = Math.round(inv.items.reduce((a, it) => a + it.taxable, 0) * 100) / 100;
  const tax = Math.round(inv.items.reduce((a, it) => a + it.cgst + it.sgst, 0) * 100) / 100;
  assert.equal(taxable, 45974.9);
  assert.equal(tax, 4144.16, 'CGST + SGST as printed on the invoice');
});
