'use strict';
/**
 * CSV and Excel downloads on every ERP table, the logo in the portals and business e-mails,
 * My Work (each person's day), and the Smart Insights drill-down. No database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function exportsModule() {
  const src = read('erp-web/admin/app.js');
  const start = src.indexOf('  var Exports = (function () {'), end = src.indexOf('\n  })();', start) + '\n  })();'.length;
  assert.ok(start > 0 && end > start, 'the export helper is in app.js');
  const ctx = { TextEncoder, out: null };
  vm.runInNewContext(src.slice(start, end) + '\nout = Exports;', ctx);
  return ctx.out;
}

/** Reads a stored (uncompressed) zip: → { name: text }, checking every CRC and the central directory. */
function unzip(buf) {
  const files = {};
  let off = 0, n = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const crc = buf.readUInt32LE(off + 14), size = buf.readUInt32LE(off + 18), nameLen = buf.readUInt16LE(off + 26), extra = buf.readUInt16LE(off + 28);
    assert.equal(buf.readUInt16LE(off + 8), 0, 'stored');
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const data = buf.slice(off + 30 + nameLen + extra, off + 30 + nameLen + extra + size);
    assert.equal(zlib.crc32(data) >>> 0, crc, 'CRC of ' + name);
    files[name] = data.toString('utf8');
    off += 30 + nameLen + extra + size; n++;
  }
  const endAt = buf.length - 22;
  assert.equal(buf.readUInt32LE(endAt), 0x06054b50, 'end of central directory');
  assert.equal(buf.readUInt16LE(endAt + 10), n, 'central directory lists every file');
  assert.equal(buf.readUInt32LE(endAt + 16), off, 'central directory starts after the files');
  return files;
}

test('Excel download: a valid .xlsx (stored zip, correct CRCs), numbers as numbers, text never a formula, bold header', () => {
  const X = exportsModule();
  const rows = [['Product', 'Qty', 'Amount (₹)', 'Note'], ['Jaggery 1kg', '12', '₹1,250', '=HYPERLINK("x")'], ['Ghee "A2" <b>', '0', '3.50', 'a, b'], ['Code', '007', '-5', '@x']];
  const buf = Buffer.concat(X.xlsx(rows).map((p) => Buffer.from(p)));
  const files = unzip(buf);
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="B2"><v>12<\/v><\/c>/);
  assert.match(sheet, /<c r="C2"><v>1250<\/v><\/c>/, '₹ and thousands commas removed for the number');
  assert.match(sheet, /<c r="B4" t="inlineStr"><is><t xml:space="preserve">007<\/t>/, 'leading zeros stay text');
  assert.match(sheet, /<c r="D2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK\(&quot;x&quot;\)<\/t>/, 'a formula-looking value is plain text');
  assert.doesNotMatch(sheet, /<f>/, 'no formulas at all');
  assert.match(sheet, /Ghee &quot;A2&quot; &lt;b&gt;/);
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1">/, 'header row bold');
  assert.equal(X.crc32(new TextEncoder().encode('hello')), zlib.crc32('hello') >>> 0);
});

test('CSV download: Excel-friendly (BOM, CRLF), quoting, formula injection neutralised', () => {
  const X = exportsModule();
  const csv = X.csv([['A', 'B'], ['=1+1', 'x, "y"'], ['-5', '@cmd'], ['+91 98450', '-x']]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.slice(1), 'A,B\r\n\'=1+1,"x, ""y"""\r\n-5,\'@cmd\r\n\'+91 98450,\'-x\r\n');
  assert.match(X.fileName('Stock & Batches'), /^stock-batches-\d{4}-\d{2}-\d{2}$/);
});

test('every ERP table gets Download CSV / Excel, a search box when long, and sortable headings', () => {
  const app = read('erp-web/admin/app.js');
  const t = app.slice(app.indexOf('  function table(head, rows) {'), app.indexOf('  var Exports = (function () {'));
  assert.match(t, /text: 'CSV'/); assert.match(t, /text: 'Excel'/);
  assert.match(t, /if \(rows\.length > 8\)/);
  assert.match(t, /placeholder: 'Search this table'/);
  assert.match(t, /aria-sort/);
  assert.match(t, /action columns have no heading/);
  assert.match(app, /window\.ERP = \{[^}]*exports: Exports/);
  for (const f of ['erp-web/admin/app.css', 'platform-web/erp-embed.css']) assert.match(read(f), /\.table-tools\{/, f);
});

test('logo in the trade portal, supplier portal, field app and business e-mails', () => {
  assert.match(read('b2b-web/portal/app.js'), /<div class="side-brand"><img class="brand-logo" src="\/assets\/images\/logo-mark\.svg"/);
  assert.match(read('b2b-web/portal/app.js'), /<a class="top-brand"[^']*><img class="brand-logo sm"/);
  for (const f of ['b2b-web/portal/login.html', 'b2b-web/portal/register.html']) assert.match(read(f), /class="wm"><img src="\/assets\/images\/logo-mark\.svg"/, f);
  for (const f of ['erp-web/vendor/index.html', 'erp-web/sales/index.html']) assert.match(read(f), /<header class="brandbar"><img src="\/assets\/images\/logo-mark\.svg"/, f);
  const saved = { p: process.env.PUBLIC_SITE_URL, s: process.env.SITE_URL };
  try {
    const notif = require('../src/modules/b2b/notifications/service.js');
    process.env.PUBLIC_SITE_URL = 'https://www.sakeofhealth.com';
    assert.match(notif.emailHtml('Order placed', ['Thanks'], ''), /<img src="https:\/\/www\.sakeofhealth\.com\/assets\/images\/logo-mark\.png"/);
    delete process.env.PUBLIC_SITE_URL; delete process.env.SITE_URL;
    assert.doesNotMatch(notif.emailHtml('Order placed', ['Thanks'], ''), /<img/, 'no site address: no broken picture');
  } finally {
    if (saved.p === undefined) delete process.env.PUBLIC_SITE_URL; else process.env.PUBLIC_SITE_URL = saved.p;
    if (saved.s === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = saved.s;
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'frontend/assets/images/logo-mark.png')), 'the PNG used in e-mails exists');
  assert.doesNotMatch(read('src/services/notify.js'), /logo-mark/, 'the shop\'s own order e-mails are not changed');
});

test('My Work: one card per area the role covers, live endpoints only, links to the screens', () => {
  const src = read('erp-web/admin/enterprise.js');
  const wanted = [
    ["'Waiting for your approval', ['core.approvals.view']", '/api/erp/core/approvals'],
    ["'Money owed to you', ['finance.reports.view']", '/api/erp/finance/ageing'],
    ["'Bills you owe suppliers', ['finance.reports.view']", '/api/erp/finance/ageing?side=payables'],
    ["'Field cash to confirm', ['sales.collections.confirm']", '/api/erp/sales/collections/pending'],
    ["'Deliveries today', ['deliveries.view', 'deliveries.manage']", '/api/erp/deliveries/summary'],
    ["'Manufacturing', ['manufacturing.view']", '/api/erp/manufacturing/batches?status=submitted'],
  ];
  for (const [card, url] of wanted) { assert.ok(src.includes(card), card); assert.ok(src.includes("'" + url + "'"), url); }
  assert.match(src, /window\.ERP_VIEWS\.push\(\{ id: 'mywork', label: 'My Work', perm: 'core\.self\.view', render: mywork \}\)/);
  const reg = require('../src/platform/registry.js');
  const p = reg.PAGES.find((x) => x.view === 'mywork');
  assert.deepEqual([p.path, p.perm], ['/admin/business/my-work', 'core.self.view']);
  // the endpoints it reads exist with those permissions
  assert.match(read('src/modules/erp/routes/returns-finance.js'), /r\.get\('\/finance\/ageing', can\('finance\.reports\.view'\)/);
  assert.match(read('src/modules/erp/routes/sales.js'), /office\.get\('\/collections\/pending', can\('sales\.collections\.confirm'\)/);
  assert.match(read('src/modules/erp/routes/deliveries.js'), /r\.get\('\/summary', any\('deliveries\.view', 'deliveries\.manage'\)/);
  assert.match(read('src/modules/erp/routes/manufacturing.js'), /r\.get\('\/batches', can\('manufacturing\.view'\)/);
});

test('Smart Insights: products open a detail panel with their own figures', () => {
  const src = read('erp-web/admin/insights.js');
  assert.match(src, /function detailPanel\(holder, title, pairs, weeks\)/);
  assert.equal((src.match(/opener\(p\.name \+ ' \(' \+ p\.sku \+ '\)', open\)/g) || []).length, 2, 'forecast and stock tables');
  for (const field of ['p.reorderPoint', 'p.safetyStock', 'p.inTransit', 'p.onOrder', 'p.sold26Weeks']) assert.ok(src.includes(field), field);
  const svc = read('src/modules/erp/insights/service.js');
  for (const field of ['reorderPoint:', 'safetyStock:', 'inTransit:', 'onOrder:', 'sold26Weeks:']) assert.ok(svc.includes(field), 'the server sends ' + field);
});
