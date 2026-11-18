#!/usr/bin/env node
/**
 * Optional DEVELOPMENT seed for the B2B platform: a few distributors,
 * retailers, products, stock and orders at different stages, so every screen
 * has something to show on a fresh local database.
 *
 *   npm run migrate && npm run b2b:seed-dev
 *
 * SAFETY: refuses to run unless NODE_ENV is not "production" AND DB_NAME ends
 * with _dev, _test or _local. It can never touch a production database.
 * Everything is created through the same service code the application uses.
 */
require('dotenv').config();
const db = require('../src/db/connection.js');

const PASSWORD = 'Demo@1234';
const SYSTEM = { type: 'admin', id: 'seed', label: 'seed-script', role: 'admin' };

async function main() {
  db.assertDisposableDatabase('B2B development seed');
  const migrate = require('../src/db/migrate.js');
  const check = await migrate.verify();
  if (!check.ok) throw new Error('Run "npm run migrate" first — the schema is not complete.');
  const existing = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_accounts');
  if (Number(existing.n) > 0) { console.log('Accounts already exist — nothing seeded. (Use a fresh *_dev database to seed again.)'); return; }

  const security = require('../src/modules/b2b/lib/security.js');
  const { gstinCheckDigit } = require('../src/modules/b2b/lib/validate.js');
  const accounts = require('../src/modules/b2b/accounts/service.js');
  const mappings = require('../src/modules/b2b/mappings/service.js');
  const catalogue = require('../src/modules/b2b/catalogue/service.js');
  const inventory = require('../src/modules/b2b/inventory/service.js');
  const orders = require('../src/modules/b2b/orders/service.js');
  const payments = require('../src/modules/b2b/payments/service.js');
  const settings = require('../src/modules/b2b/lib/settings.js');

  const ka = await db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'");
  const district = async (name) => (await db.queryOne('SELECT id FROM b2b_districts WHERE state_id = ? AND name = ?', [ka.id, name])).id;
  const gstin = (pan) => { const f = '29' + pan + '1Z'; return f + gstinCheckDigit(f); };

  async function account(type, a) {
    const res = await db.query(
      'INSERT INTO b2b_accounts (account_type, status, business_name, shop_name, contact_person, mobile, email, gstin, pan, business_type, address_line1, landmark, ' +
      "state_id, district_id, district_name, city, pincode, latitude, longitude, risk_flags) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')",
      [type, a.name, a.shop || null, a.contact, a.mobile, a.email, a.pan ? gstin(a.pan) : null, a.pan || null, a.btype || 'Proprietorship', a.address, a.landmark || null,
        ka.id, await district(a.district), a.district, a.city, a.pincode, a.lat, a.lng]);
    await db.query('INSERT INTO b2b_users (account_id, name, email, mobile, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)',
      [res.insertId, a.contact, a.email, a.mobile, security.hashPassword(PASSWORD), type]);
    await db.query("INSERT INTO b2b_account_status_history (account_id, to_status, reason, actor_type, actor_label) VALUES (?, 'pending', 'Seeded', 'system', 'seed-script')", [res.insertId]);
    return res.insertId;
  }
  const identity = async (accountId) => {
    const a = await accounts.getAccount(accountId);
    const u = await db.queryOne('SELECT id, name, email, mobile FROM b2b_users WHERE account_id = ?', [accountId]);
    return { account: a, user: { id: Number(u.id), name: u.name, email: u.email, mobile: u.mobile } };
  };
  const actorOf = (id) => ({ type: 'business', id: id.user.id, label: id.user.email, role: id.account.account_type });

  console.log('• company profile');
  await settings.setMany({ 'company.address': '14, 2nd Main, Industrial Suburb, Yeshwanthpur', 'company.city': 'Bengaluru', 'company.pincode': '560022',
    'company.gstin': gstin('AAGCI4521K'), 'company.pan': 'AAGCI4521K', 'company.phone': '+91 74839 27125', 'company.email': 'trade@sakeofhealth.com',
    'company.bank_details': 'Ixitek Healthcare and Wellness Pvt. Ltd.\nHDFC Bank, Yeshwanthpur · A/c 5020 0012 3456 78 · IFSC HDFC0000123' }, 'seed-script');

  console.log('• distributors');
  const d1 = await account('distributor', { name: 'Bengaluru Trade Links', contact: 'Ramesh Rao', mobile: '9845000001', email: 'distributor1@example.com', pan: 'AAACB1234C', btype: 'Private Limited',
    address: '14 Industrial Layout, Peenya', district: 'Bengaluru Urban', city: 'Bengaluru', pincode: '560058', lat: '13.0285000', lng: '77.5197000' });
  const d2 = await account('distributor', { name: 'Mysuru Wellness Distributors', contact: 'Kavya Gowda', mobile: '9845000002', email: 'distributor2@example.com', pan: 'AAACM5678D', btype: 'Partnership',
    address: '8 Hebbal Industrial Area', district: 'Mysuru', city: 'Mysuru', pincode: '570016', lat: '12.3524000', lng: '76.6127000' });
  for (const id of [d1, d2]) await accounts.changeStatus(id, 'approved', '', SYSTEM);
  await mappings.addServiceArea(d1, { area_type: 'district', district_id: await district('Bengaluru Urban') }, SYSTEM);
  await mappings.addPincodes(d1, '560001 560002 560003 560004 560008 560034 560038', SYSTEM);
  await mappings.addServiceArea(d2, { area_type: 'district', district_id: await district('Mysuru') }, SYSTEM);
  await mappings.addServiceArea(d2, { area_type: 'district', district_id: await district('Mandya') }, SYSTEM);

  console.log('• retailers');
  const retailers = [
    { name: 'Lakshmi Stores', shop: 'Lakshmi Medicals', contact: 'Lakshmi Narayan', mobile: '9845000011', email: 'retailer1@example.com', address: '22 MG Road', landmark: 'Opp. Metro Station', district: 'Bengaluru Urban', city: 'Bengaluru', pincode: '560001', lat: '12.9756000', lng: '77.6050000' },
    { name: 'Green Leaf Organics', shop: 'Green Leaf Wellness', contact: 'Anita Shetty', mobile: '9845000014', email: 'retailer2@example.com', address: '5th Block, Koramangala', landmark: 'Near Forum Mall', district: 'Bengaluru Urban', city: 'Bengaluru', pincode: '560034', lat: '12.9352000', lng: '77.6245000', pan: 'AAFCG7788H' },
    { name: 'Chamundi Pharma', shop: 'Chamundi Pharma', contact: 'Suresh Kumar', mobile: '9845000012', email: 'retailer3@example.com', address: '41 Sayyaji Rao Road', landmark: 'Next to Devaraja Market', district: 'Mysuru', city: 'Mysuru', pincode: '570001', lat: '12.3115000', lng: '76.6520000' },
    { name: 'Hubli Health Mart', shop: 'Hubli Health Mart', contact: 'Prakash Patil', mobile: '9845000013', email: 'retailer4@example.com', address: '9 Lamington Road', district: 'Dharwad', city: 'Hubballi', pincode: '580020', lat: '15.3647000', lng: '75.1240000' },
    { name: 'Udupi Daily Needs', shop: 'Udupi Daily Needs', contact: 'Deepa Bhat', mobile: '9845000015', email: 'retailer5@example.com', address: 'Car Street', district: 'Udupi', city: 'Udupi', pincode: '576101', lat: '13.3409000', lng: '74.7421000' },
  ];
  const rIds = [];
  for (const r of retailers) rIds.push(await account('retailer', r));
  for (const id of rIds.slice(0, 4)) await accounts.changeStatus(id, 'approved', '', SYSTEM);   // the fifth stays pending for the approvals queue

  console.log('• catalogue + stock');
  const cats = await catalogue.listCategories(false);
  const cat = (n) => cats.find(c => c.name === n).id;
  const products = [
    { sku: 'GUM001', name: 'Multivitamin Gummies 30 Count', category_id: cat('Gummies'), brand: 'Sake of Health', hsn_code: '21069099', gst_rate: 18, mrp: 499, base_price: 250, moq: 10, case_qty: 20, pack_size: '30 gummies', barcode: '8901234500011', image_url: '/assets/images/multivitamin.png', low_stock_threshold: 100, stock: 1200, batch: 'MV-2609', expiry: 420 },
    { sku: 'GUM002', name: 'Multivitamin Gummies 60 Count', category_id: cat('Gummies'), brand: 'Sake of Health', hsn_code: '21069099', gst_rate: 18, mrp: 799, base_price: 410, moq: 6, case_qty: 12, pack_size: '60 gummies', barcode: '8901234500028', image_url: '/assets/images/multivitamin.png', low_stock_threshold: 60, stock: 600, batch: 'MV-2608', expiry: 380 },
    { sku: 'GUM003', name: 'Iron + Folic Acid Gummies', category_id: cat('Gummies'), brand: 'Sake of Health', hsn_code: '21069099', gst_rate: 18, mrp: 699, base_price: 350, moq: 6, case_qty: 12, pack_size: '60 gummies', barcode: '8901234500035', image_url: '/assets/images/iron.png', low_stock_threshold: 60, stock: 480, batch: 'FE-2607', expiry: 55 },
    { sku: 'GUM004', name: 'Curcumin Gummies', category_id: cat('Gummies'), brand: 'Sake of Health', hsn_code: '21069099', gst_rate: 18, mrp: 849, base_price: 430, moq: 6, case_qty: 12, pack_size: '60 gummies', barcode: '8901234500042', image_url: '/assets/images/curcumin.png', low_stock_threshold: 60, stock: 40, batch: 'CU-2609', expiry: 400 },
    { sku: 'GUM005', name: 'Probiotic Gummies', category_id: cat('Gummies'), brand: 'Sake of Health', hsn_code: '21069099', gst_rate: 18, mrp: 899, base_price: 460, moq: 6, case_qty: 12, pack_size: '60 gummies', barcode: '8901234500059', image_url: '/assets/images/probiotic.png', low_stock_threshold: 60, stock: 360, batch: 'PB-2609', expiry: 300 },
    { sku: 'BIS001', name: 'Millet Protein Biscuits 200 g', category_id: cat('Biscuits'), brand: 'Sake of Health', hsn_code: '19053100', gst_rate: 18, mrp: 120, base_price: 62, moq: 24, case_qty: 24, pack_size: '200 g', barcode: '8901234500066', low_stock_threshold: 240, stock: 2400, batch: 'BS-2610', expiry: 150 },
    { sku: 'NRG001', name: 'Natural Energy Drink 250 ml', category_id: cat('Energy Drinks'), brand: 'Sake of Health', hsn_code: '22029920', gst_rate: 40, mrp: 99, base_price: 42, moq: 24, case_qty: 24, pack_size: '250 ml can', barcode: '8901234500073', low_stock_threshold: 480, stock: 1920, batch: 'ED-2610', expiry: 240 },
  ];
  const wh = (await inventory.companyWarehouses())[0];
  const pid = {};
  for (const p of products) {
    const body = Object.assign({}, p); delete body.stock; delete body.batch; delete body.expiry;
    pid[p.sku] = (await catalogue.createProduct(body, SYSTEM)).id;
    await inventory.manualEntry({ warehouse_id: wh.id, product_id: pid[p.sku], operation: 'opening', qty: p.stock, batch_no: p.batch,
      expiry_date: new Date(Date.now() + p.expiry * 86400000).toISOString().slice(0, 10) }, SYSTEM);
  }

  console.log('• credit + orders');
  await payments.setCreditTerms(d1, 0, { credit_limit: 500000, credit_days: 30 }, SYSTEM);
  await payments.setCreditTerms(d2, 0, { credit_limit: 200000, credit_days: 21 }, SYSTEM);
  await payments.setCreditTerms(rIds[0], d1, { credit_limit: 50000, credit_days: 15 }, SYSTEM);

  const adminScope = { admin: true, permissions: require('../src/modules/b2b/rbac.js').permissionsFor('admin') };
  let k = 0;
  async function order(accountId, lines, method, upTo, sellerSteps) {
    const who = await identity(accountId);
    await orders.addManyToCart(who.account, lines, true);
    const placed = await orders.placeOrder(who, { idempotencyKey: 'seed-order-' + (++k) + '-' + Date.now(), payment_method: method }, actorOf(who));
    const id = placed.order.id;
    let status = placed.order.status;
    if (status === 'pending_admin_approval' && upTo !== 'pending_admin_approval') status = (await orders.transition(id, 'approved', adminScope, SYSTEM, { note: 'Seed approval' })).status;
    const flow = ['accepted', 'processing', 'packed', 'dispatched', 'out_for_delivery', 'delivered'];
    const stop = flow.indexOf(upTo);
    for (let i = 0; i <= stop; i++) {
      const scope = sellerSteps ? { sellerAccountId: sellerSteps } : adminScope;
      await orders.transition(id, flow[i], scope, sellerSteps ? actorOf(await identity(sellerSteps)) : SYSTEM, {});
    }
    return id;
  }

  // Distributors stock up from the company.
  const po1 = await order(d1, [{ sku: 'GUM001', qty: 200 }, { sku: 'GUM002', qty: 60 }, { sku: 'GUM003', qty: 60 }, { sku: 'BIS001', qty: 240 }], 'credit', 'delivered');
  await order(d2, [{ sku: 'GUM001', qty: 100 }, { sku: 'GUM005', qty: 36 }, { sku: 'NRG001', qty: 240 }], 'credit', 'dispatched');
  await order(d1, [{ sku: 'GUM005', qty: 60 }, { sku: 'NRG001', qty: 480 }], 'bank_transfer', 'processing');
  await payments.recordManual(po1, { method: 'bank_transfer', amount: 60000, reference: 'NEFT-SEED-0001' }, SYSTEM, { admin: true });

  // Retailers order from their distributors.
  await order(rIds[0], [{ sku: 'GUM001', qty: 20 }, { sku: 'GUM002', qty: 12 }, { sku: 'BIS001', qty: 48 }], 'credit', 'delivered', d1);
  await order(rIds[0], [{ sku: 'GUM003', qty: 12 }, { sku: 'GUM001', qty: 40 }], 'upi', 'packed', d1);
  await order(rIds[1], [{ sku: 'GUM001', qty: 20 }, { sku: 'GUM005', qty: 12 }], 'bank_transfer', 'accepted', d1);
  await order(rIds[1], [{ sku: 'BIS001', qty: 24 }], 'upi', null, d1);
  await order(rIds[2], [{ sku: 'GUM001', qty: 40 }, { sku: 'NRG001', qty: 48 }], 'bank_transfer', 'out_for_delivery', d2);
  await order(rIds[3], [{ sku: 'GUM001', qty: 20 }, { sku: 'GUM004', qty: 12 }], 'bank_transfer', 'pending_admin_approval');   // no distributor in Hubballi → supplied directly, awaiting first-order approval

  console.log('\n✓ Seeded. Business logins (password ' + PASSWORD + '):');
  console.log('    Distributor  distributor1@example.com   (Bengaluru)   · distributor2@example.com (Mysuru)');
  console.log('    Retailer     retailer1@example.com      (Bengaluru)   · retailer3@example.com (Mysuru) · retailer4@example.com (Hubballi, unmapped)');
  console.log('    Pending      retailer5@example.com      (awaiting approval)');
}

main()
  .catch(function (e) { console.error('✗ Seed failed: ' + (e.sqlMessage || e.message)); if (process.env.DEBUG) console.error(e); process.exitCode = 1; })
  .finally(function () { return db.close(); });
