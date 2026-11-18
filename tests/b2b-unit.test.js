/**
 * Pure logic tests for the B2B module — no server, no database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../src/modules/b2b/lib/money.js');
const v = require('../src/modules/b2b/lib/validate.js');
const engine = require('../src/modules/b2b/pricing/engine.js');
const sm = require('../src/modules/b2b/orders/stateMachine.js');
const catalogue = require('../src/modules/b2b/catalogue/service.js');
const invoices = require('../src/modules/b2b/invoices/service.js');
const imports = require('../src/modules/b2b/imports/service.js');
const rbac = require('../src/modules/b2b/rbac.js');
const uploads = require('../src/modules/b2b/lib/uploads.js');
const exporter = require('../src/modules/b2b/lib/export.js');
const migrate = require('../src/db/migrate.js');

test('money: exact paise arithmetic, never floats', () => {
  assert.equal(money.toPaise('0.1') + money.toPaise('0.2'), 30);          // 0.1 + 0.2 === 0.30 exactly
  assert.equal(money.toPaise('1234.50'), 123450);
  assert.equal(money.toPaise('1,234.5'), 123450);
  assert.equal(money.toPaise(19.99), 1999);
  assert.equal(money.toPaise('10.005'), 1001);                            // half-up on the third decimal
  assert.equal(money.fromPaise(123450), '1234.50');
  assert.equal(money.fromPaise(5), '0.05');
  assert.equal(money.fromPaise(-250), '-2.50');
  assert.equal(money.pctOf(25000, money.toMilliPct('12')), 3000);
  assert.equal(money.pctOf(29500, money.toMilliPct('18')), 5310);
  assert.deepEqual(money.roundToRupee(348149), { rounded: 348100, roundOff: -49 });
  assert.deepEqual(money.roundToRupee(348150), { rounded: 348200, roundOff: 50 });
  assert.equal(money.inr(12345678), '₹1,23,456.78');
  assert.throws(() => money.toPaise('12abc'));
  assert.throws(() => money.toPaise('1e5'));
});

test('validators: GSTIN checksum, PAN, mobile, pincode', () => {
  assert.equal(v.isGstin('27AAPFU0939F1ZV'), true);
  assert.equal(v.isGstin('29AAGCB7383J1Z4'), true);
  assert.equal(v.isGstin('27AAPFU0939F1ZW'), false);       // wrong check digit
  assert.equal(v.isGstin('27AAPFU0939F1Z'), false);
  assert.equal(v.isGstin("27AAPFU0939F1Z' OR 1=1"), false);
  assert.equal(v.isPan('ABCDE1234F'), true);
  assert.equal(v.isPan('ABCD1234FF'), false);
  assert.equal(v.mobile('+91 98765-43210'), '9876543210');
  assert.equal(v.mobile('09876543210'), '9876543210');
  assert.equal(v.isMobile('9876543210'), true);
  assert.equal(v.isMobile('1234567890'), false);
  assert.equal(v.isPincode('560001'), true);
  assert.equal(v.isPincode('060001'), false);
  assert.equal(v.isEmail('a@b.co'), true);
  assert.equal(v.isEmail('a@b'), false);
  assert.equal(v.text('  hi\u0000 there\u0007  ', 20), 'hi there');
  assert.equal(v.date('2026-02-30'), null);
  assert.equal(v.date('31/12/2026'), '2026-12-31');
  assert.equal(v.decimal('12.5%', 3), '12.500');
  assert.equal(v.decimal('-1', 2), null);
  assert.ok(v.passwordProblem('short'));
  assert.ok(v.passwordProblem('allletters'));
  assert.equal(v.passwordProblem('Retail3r!'), null);
});

/* ───────────── Pricing engine ───────────── */

const product = { id: 1, category_id: 10, subcategory_id: 11, base_price: '250.00', mrp: '499.00', gst_rate: '18.00',
  distributor_price: null, retailer_price: null, distributor_margin: null, retailer_margin: null };
let ruleId = 100;
const rule = (o) => Object.assign({ id: ++ruleId, audience: 'retailer', account_id: null, product_id: null, category_id: null,
  min_qty: 1, is_promo: 0, label: null, starts_at: null, ends_at: null, is_active: 1 }, o);
const ctx = (rules, extra) => Object.assign({ audience: 'retailer', accountId: 7, mode: 'markup_on_base', defaultMilliPct: 18000, rules: rules || [], now: Date.now() }, extra || {});
const price = (p, qty, c) => money.fromPaise(engine.resolve(p, qty, c).unitPrice);

test('pricing: default margins (12% distributor, 18% retailer) on base price', () => {
  assert.equal(price(product, 1, ctx()), '295.00');
  assert.equal(price(product, 1, ctx([], { audience: 'distributor', defaultMilliPct: 12000 })), '280.00');
  assert.equal(engine.resolve(product, 1, ctx()).source, 'default');
});

test('pricing: precedence — account+product > account > product > category > default', () => {
  const category = rule({ scope: 'category', category_id: 10, rule_type: 'margin_pct', value: '20.000' });
  const subcat = rule({ scope: 'category', category_id: 11, rule_type: 'margin_pct', value: '22.000' });
  const account = rule({ scope: 'account', account_id: 7, rule_type: 'margin_pct', value: '15.000' });
  const accountProduct = rule({ scope: 'account_product', account_id: 7, product_id: 1, rule_type: 'fixed_price', value: '270.000' });
  const otherAccount = rule({ scope: 'account_product', account_id: 99, product_id: 1, rule_type: 'fixed_price', value: '1.000' });

  assert.equal(price(product, 1, ctx([category])), '300.00');
  assert.equal(engine.resolve(product, 1, ctx([category])).source, 'category');
  assert.equal(price(product, 1, ctx([category, subcat])), '305.00', 'sub-category beats category');

  const withProductMargin = Object.assign({}, product, { retailer_margin: '25.000' });
  assert.equal(price(withProductMargin, 1, ctx([category, subcat])), '312.50', 'product margin beats category');
  const withProductPrice = Object.assign({}, withProductMargin, { retailer_price: '299.00' });
  assert.equal(price(withProductPrice, 1, ctx([category])), '299.00', 'explicit product price beats product margin');

  assert.equal(price(withProductPrice, 1, ctx([category, account])), '287.50', 'account override beats product pricing');
  assert.equal(price(withProductPrice, 1, ctx([category, account, accountProduct])), '270.00', 'customer-specific price wins');
  assert.equal(engine.resolve(withProductPrice, 1, ctx([category, account, accountProduct])).source, 'account_product');
  assert.equal(price(product, 1, ctx([otherAccount])), '295.00', "another customer's price never applies");
});

test('pricing: audience isolation, inactive and out-of-window rules ignored', () => {
  const distRule = rule({ scope: 'product', product_id: 1, audience: 'distributor', rule_type: 'fixed_price', value: '200.000' });
  const inactive = rule({ scope: 'product', product_id: 1, rule_type: 'fixed_price', value: '100.000', is_active: 0 });
  const future = rule({ scope: 'product', product_id: 1, rule_type: 'fixed_price', value: '100.000', starts_at: new Date(Date.now() + 86400000) });
  const expired = rule({ scope: 'product', product_id: 1, rule_type: 'fixed_price', value: '100.000', ends_at: new Date(Date.now() - 1000) });
  assert.equal(price(product, 1, ctx([distRule, inactive, future, expired])), '295.00');
});

test('pricing: quantity slabs, volume discounts and promotions', () => {
  const slab20 = rule({ scope: 'product', product_id: 1, rule_type: 'margin_pct', value: '15.000', min_qty: 20 });
  const slab100 = rule({ scope: 'product', product_id: 1, rule_type: 'margin_pct', value: '13.000', min_qty: 100 });
  assert.equal(price(product, 19, ctx([slab20, slab100])), '295.00');
  assert.equal(price(product, 20, ctx([slab20, slab100])), '287.50');
  assert.equal(price(product, 150, ctx([slab20, slab100])), '282.50');

  const volume = rule({ scope: 'default', rule_type: 'discount_pct', value: '2.000', min_qty: 50 });
  assert.equal(price(product, 49, ctx([volume])), '295.00');
  assert.equal(price(product, 50, ctx([volume])), '289.10');
  assert.equal(engine.resolve(product, 50, ctx([volume])).listPrice, 29500);

  const promo = rule({ scope: 'product', product_id: 1, rule_type: 'fixed_price', value: '260.000', is_promo: 1, label: 'Diwali', ends_at: new Date(Date.now() + 86400000) });
  const r = engine.resolve(product, 1, ctx([promo]));
  assert.equal(money.fromPaise(r.unitPrice), '260.00');
  assert.equal(r.promo, 'Diwali');
  const worsePromo = rule({ scope: 'product', product_id: 1, rule_type: 'fixed_price', value: '400.000', is_promo: 1, ends_at: new Date(Date.now() + 86400000) });
  assert.equal(price(product, 1, ctx([worsePromo])), '295.00', 'a promotion never raises the price');

  const slabs = engine.slabs(product, ctx([slab20, slab100]));
  assert.deepEqual(slabs, [{ minQty: 1, unitPrice: '295.00' }, { minQty: 20, unitPrice: '287.50' }, { minQty: 100, unitPrice: '282.50' }]);
});

test('pricing: off-MRP margin mode and below-cost flag', () => {
  // MRP 499 incl. 18% GST → 422.88 ex-GST; 30% off → 296.02
  assert.equal(price(product, 1, ctx([], { mode: 'off_mrp', defaultMilliPct: 30000 })), '296.02');
  const loss = rule({ scope: 'product', product_id: 1, rule_type: 'fixed_price', value: '200.000' });
  assert.equal(engine.resolve(product, 1, ctx([loss])).belowCost, true);
});

/* ───────────── MOQ / case quantity ───────────── */

test('MOQ and case quantity: MOQ 10, case 20 → 20/40/60 valid, 15 invalid', () => {
  const p = { moq: 10, case_qty: 20, enforce_case_multiple: 1 };
  [20, 40, 60].forEach(q => assert.equal(catalogue.qtyProblem(p, q), null));
  assert.match(catalogue.qtyProblem(p, 15), /multiples of 20/);
  assert.match(catalogue.qtyProblem(p, 5), /Minimum order quantity is 10/);
  assert.ok(catalogue.qtyProblem(p, 0));
  assert.ok(catalogue.qtyProblem(p, 2.5));
  assert.ok(catalogue.qtyProblem(p, -20));
  assert.equal(catalogue.minValidQty(p), 20);
  assert.equal(catalogue.qtyProblem({ moq: 10, case_qty: 20, enforce_case_multiple: 0 }, 15), null, 'unless configured otherwise');
  assert.equal(catalogue.minValidQty({ moq: 25, case_qty: 10, enforce_case_multiple: 1 }), 30);
});

/* ───────────── GST ───────────── */

test('GST: intra-state splits CGST/SGST equally, inter-state is IGST', () => {
  assert.deepEqual(invoices.gstSplit(590000, '18.00', false), { cgst: 53100, sgst: 53100, igst: 0 });
  assert.deepEqual(invoices.gstSplit(590000, '18.00', true), { cgst: 0, sgst: 0, igst: 106200 });
  assert.deepEqual(invoices.gstSplit(10001, '5.00', false), { cgst: 250, sgst: 250, igst: 0 });
  assert.deepEqual(invoices.gstSplit(10000, '0.00', true), { cgst: 0, sgst: 0, igst: 0 });
});

test('invoice numbering: Indian financial year and 16-character limit', () => {
  assert.equal(invoices.financialYear('2026-10-07'), '2627');
  assert.equal(invoices.financialYear('2027-03-31'), '2627');
  assert.equal(invoices.financialYear('2027-04-01'), '2728');
  assert.equal(invoices.formatNumber('SOH', '2627', 1, ''), 'SOH2627-00001');
  assert.equal(invoices.formatNumber('SOH', '2627', 123456, ''), 'SOH2627-123456');
  assert.ok(invoices.formatNumber('LONGPREFIXXX', '2627', 7, 'C').length <= 16);
  assert.equal(invoices.addDays('2026-12-25', 15), '2027-01-09');
});

/* ───────────── Order state machine ───────────── */

test('state machine: only defined transitions, per actor', () => {
  const admin = { kind: 'admin', permissions: rbac.permissionsFor('admin') };
  const support = { kind: 'admin', permissions: rbac.permissionsFor('support') };
  const seller = { kind: 'seller' };
  const buyer = { kind: 'buyer', cancelUntil: 'assigned' };

  assert.equal(sm.allowed('pending_admin_approval', 'approved', admin), true);
  assert.equal(sm.allowed('pending_admin_approval', 'approved', support), false);
  assert.equal(sm.allowed('pending_admin_approval', 'approved', seller), false);
  assert.equal(sm.allowed('pending_admin_approval', 'approved', buyer), false);
  assert.equal(sm.allowed('pending_admin_approval', 'delivered', admin), false, 'no skipping ahead');
  assert.equal(sm.allowed('assigned', 'accepted', seller), true);
  assert.equal(sm.allowed('assigned', 'packed', seller), false);
  assert.equal(sm.allowed('delivered', 'processing', admin), false, 'no going backwards');
  assert.equal(sm.allowed('cancelled', 'approved', admin), false, 'cancelled is final');
  assert.equal(sm.allowed('assigned', 'cancelled', buyer), true);
  assert.equal(sm.allowed('accepted', 'cancelled', buyer), false, 'buyer cancel window closed');
  assert.equal(sm.allowed('accepted', 'cancelled', { kind: 'buyer', cancelUntil: 'accepted' }), true);
  assert.equal(sm.allowed('dispatched', 'cancelled', admin), false);
  assert.equal(sm.allowed('delivered', 'returned', admin), false, 'returned only through the returns workflow');
  assert.equal(sm.allowed('delivered', 'returned', { kind: 'system' }), true);
  assert.deepEqual(sm.nextFor('packed', seller), ['dispatched', 'cancelled']);
  sm.STATUSES.forEach(s => assert.ok(sm.EDGES[s], s + ' is in the transition table'));
});

/* ───────────── RBAC ───────────── */

test('RBAC: roles get only their permissions', () => {
  assert.equal(rbac.has('admin', 'b2b.system.migrate'), true);
  assert.equal(rbac.has('manager', 'b2b.system.migrate'), false);
  assert.equal(rbac.has('support', 'b2b.users.view'), true);
  assert.equal(rbac.has('support', 'b2b.users.approve'), false);
  assert.equal(rbac.has('finance', 'b2b.payments.record'), true);
  assert.equal(rbac.has('finance', 'b2b.pricing.edit'), false);
  assert.equal(rbac.has('inventory', 'b2b.inventory.edit'), true);
  assert.equal(rbac.has('inventory', 'b2b.payments.record'), false);
  assert.equal(rbac.has('sales', 'b2b.users.approve'), true);
  assert.equal(rbac.has('sales', 'b2b.imports.execute'), false);
  assert.deepEqual(rbac.permissionsFor('delivery'), []);
  assert.deepEqual(rbac.permissionsFor('nonexistent'), []);
  Object.keys(rbac.ROLE_PERMISSIONS).forEach(role => rbac.ROLE_PERMISSIONS[role].forEach(p => assert.ok(rbac.PERMISSIONS.includes(p), role + ' → ' + p)));
});

/* ───────────── Uploads, import parsing, export escaping, migration guard ───────────── */

test('uploads: file type comes from the bytes, not the name', () => {
  assert.deepEqual(uploads.sniff(Buffer.from('%PDF-1.7 ................')), { ext: 'pdf', mime: 'application/pdf' });
  assert.equal(uploads.sniff(Buffer.from('MZ\x90\x00 this is an exe pretending')), null);
  assert.equal(uploads.sniff(Buffer.from('<?php echo 1; ?>            ')), null);
  assert.equal(uploads.sniff(Buffer.from('<svg onload=alert(1)></svg>   ')), null);
  assert.equal(uploads.safeDisplayName('../../etc/passwd'), 'passwd');
  assert.equal(uploads.safeDisplayName('C:\\Users\\x\\gst<cert>.pdf'), 'gstcert.pdf');
  assert.equal(uploads.documentPath('../../../etc/passwd'), null);
  assert.equal(uploads.documentPath('not-a-stored-name.pdf'), null);
});

test('import: header detection and CSV parsing', () => {
  const m = imports.detectMapping(['SKU', 'Product Name', 'GST Rate', 'gst %', 'Base Price', 'Distributor Margin', 'Case Quantity', 'Opening Stock', 'Random']);
  assert.equal(m.SKU, 'sku');
  assert.equal(m['Product Name'], 'name');
  assert.equal(m['GST Rate'], 'gst_rate');
  assert.equal(m['gst %'], undefined, 'a field is only mapped once');
  assert.equal(m['Base Price'], 'base_price');
  assert.equal(m['Case Quantity'], 'case_qty');
  assert.equal(m.Random, undefined);
  const grid = imports.parseCsv('\uFEFFSKU,Name,Notes\r\nA1,"Gummies, 30 ct","He said ""hi"""\r\n\r\nA2,Plain,\r\n');
  assert.equal(grid.length, 3);
  assert.deepEqual(grid[1].cells, ['A1', 'Gummies, 30 ct', 'He said "hi"']);
  assert.equal(grid[2].n, 4, 'row numbers follow the file, blank lines included');
  assert.equal(imports.TEMPLATE_KEYS.length, 18);
});

test('exports: spreadsheet formula injection is neutralised', () => {
  assert.equal(exporter.csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(exporter.csvCell('+919876543210'), "'+919876543210");
  assert.equal(exporter.csvCell('-125.50'), '-125.50');
  assert.equal(exporter.csvCell('a,b'), '"a,b"');
  assert.equal(exporter.csvCell(null), '');
});

test('migrations: files are ordered, idempotent and contain nothing destructive', () => {
  const fs = require('fs'), path = require('path');
  const files = migrate.listFiles();
  assert.ok(files.length >= 2);
  assert.deepEqual(files, files.slice().sort());
  files.filter(f => f.endsWith('.sql')).forEach(f => {
    const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations', f), 'utf8');
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|DATABASE)|\bTRUNCATE\b/i, f + ' must not drop or truncate');
    migrate.splitSql(sql).forEach(stmt => {
      if (/^CREATE TABLE/i.test(stmt)) {
        assert.match(stmt, /^CREATE TABLE IF NOT EXISTS/i, 'idempotent CREATE in ' + f);
        assert.match(stmt, /ENGINE=InnoDB/i, 'InnoDB in ' + f);
        assert.doesNotMatch(stmt, /\b(FLOAT|DOUBLE)\b/i, 'no floating point columns in ' + f);
      }
    });
  });
});
