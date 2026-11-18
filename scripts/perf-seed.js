#!/usr/bin/env node
/**
 * Volume seeder for PERFORMANCE TESTING ONLY.
 *
 * Fills a throw-away database with realistic volumes so slow queries show up
 * before production does:
 *   10,000 products · 1,000 distributors · 12,000 retailers · 100,000 orders
 *
 * Refuses to run unless the database name ends in _test / _dev / _local.
 *   DB_NAME=sakeofhealth_test node scripts/perf-seed.js [scale]
 * scale 1 = the volumes above; 0.1 = a tenth (quick check).
 */
require('dotenv').config();
const db = require('../src/db/connection.js');
const migrate = require('../src/db/migrate.js');
const security = require('../src/modules/b2b/lib/security.js');

const SCALE = Number(process.argv[2] || 1);
const N = { products: Math.round(10000 * SCALE), distributors: Math.round(1000 * SCALE), retailers: Math.round(12000 * SCALE), orders: Math.round(100000 * SCALE) };
const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];
const money = n => (Math.round(n * 100) / 100).toFixed(2);

async function insert(sql, rows, size) {
  for (let i = 0; i < rows.length; i += size || 2000) await db.bulk(sql, rows.slice(i, i + (size || 2000)));
}

async function main() {
  db.assertDisposableDatabase('performance seed');
  await migrate.up();
  const t0 = Date.now();
  const state = await db.queryOne("SELECT id FROM b2b_states WHERE gst_code = '29'");
  const districts = await db.query('SELECT id, name FROM b2b_districts WHERE state_id = ?', [state.id]);
  const cats = await db.query('SELECT id FROM b2b_categories');
  const wh = await db.queryOne('SELECT id FROM b2b_warehouses ORDER BY id LIMIT 1');
  const hash = security.hashPassword('Demo@1234');
  const offP = Number((await db.queryOne('SELECT COALESCE(MAX(id),0) AS m FROM b2b_products')).m);
  const tag = Date.now().toString(36).toUpperCase();

  // products
  const words = ['Vitamin', 'Iron', 'Calcium', 'Omega', 'Protein', 'Millet', 'Herbal', 'Probiotic', 'Zinc', 'Biotin', 'Ashwagandha', 'Curcumin', 'Electrolyte', 'Collagen'];
  const forms = ['Gummies', 'Biscuits', 'Drink', 'Bar', 'Tablets', 'Powder'];
  const products = [];
  for (let i = 1; i <= N.products; i++) {
    const mrp = 99 + rnd(900), base = mrp * (0.45 + Math.random() * 0.1);
    products.push(['P' + tag + String(i).padStart(6, '0'), pick(words) + ' ' + pick(words) + ' ' + pick(forms) + ' ' + i, pick(cats).id, 'Sake of Health',
      '890' + String(1000000000 + i).slice(0, 10), '21069099', pick([5, 12, 18]), money(mrp), money(base), 6, 12, '60 count', 50, 1, 1, 1]);
  }
  await insert('INSERT INTO b2b_products (sku,name,category_id,brand,barcode,hsn_code,gst_rate,mrp,base_price,moq,case_qty,pack_size,low_stock_threshold,avail_retailer,avail_distributor,is_active) VALUES ?', products);
  const pids = (await db.query('SELECT id, sku, name, mrp, base_price, gst_rate FROM b2b_products WHERE id > ? ORDER BY id', [offP]));
  await insert('INSERT INTO b2b_stock (warehouse_id, product_id, qty_available) VALUES ?', pids.map(p => [wh.id, p.id, 500 + rnd(5000)]));
  console.log('products', pids.length, Date.now() - t0, 'ms');

  // accounts
  const offA = Number((await db.queryOne('SELECT COALESCE(MAX(id),0) AS m FROM b2b_accounts')).m);
  const accSql = 'INSERT INTO b2b_accounts (account_type,status,business_name,shop_name,contact_person,mobile,email,address_line1,state_id,district_id,district_name,city,pincode,latitude,longitude,first_order_done,approved_at) VALUES ?';
  const mk = (type, i) => {
    const d = pick(districts), pin = String(560000 + rnd(31000));
    return [type, 'approved', (type === 'distributor' ? 'Distributor ' : 'Retailer ') + tag + ' ' + i, (type === 'distributor' ? 'Trade House ' : 'Medicals ') + i, 'Contact ' + i,
      (type === 'distributor' ? '8' : '7') + String(100000000 + offA + i).slice(-9), type[0] + tag.toLowerCase() + i + '@perf.example.com', i + ' Main Road', state.id, d.id, d.name, d.name, pin,
      (12 + Math.random() * 5).toFixed(7), (74.5 + Math.random() * 3.5).toFixed(7), 1, new Date()];
  };
  await insert(accSql, Array.from({ length: N.distributors }, (_, i) => mk('distributor', i + 1)));
  await insert(accSql, Array.from({ length: N.retailers }, (_, i) => mk('retailer', i + 1)));
  const dists = await db.query("SELECT id, district_id, pincode FROM b2b_accounts WHERE id > ? AND account_type = 'distributor'", [offA]);
  const rets = await db.query("SELECT id, district_id, district_name, city, pincode, shop_name, contact_person, mobile FROM b2b_accounts WHERE id > ? AND account_type = 'retailer'", [offA]);
  const all = await db.query('SELECT id, contact_person, email, mobile, account_type FROM b2b_accounts WHERE id > ?', [offA]);
  await insert('INSERT INTO b2b_users (account_id,name,email,mobile,password_hash,role,is_primary,status) VALUES ?', all.map(a => [a.id, a.contact_person, a.email, a.mobile, hash, a.account_type, 1, 'active']));
  await insert('INSERT INTO b2b_service_areas (distributor_id, area_type, state_id, district_id) VALUES ?', dists.map(d => [d.id, 'district', state.id, d.district_id]));
  await insert('INSERT INTO b2b_service_areas (distributor_id, area_type, state_id, district_id, pincode_from, pincode_to) VALUES ?', dists.map(d => [d.id, 'pincode', state.id, d.district_id, d.pincode, d.pincode]));
  const byDistrict = {};
  dists.forEach(d => { (byDistrict[d.district_id] = byDistrict[d.district_id] || []).push(d.id); });
  const mapOf = {};
  await insert("INSERT INTO b2b_retailer_distributor_map (retailer_id, distributor_id, status, current_retailer_id, method, reason, assigned_by) VALUES ?",
    rets.map(r => { const d = pick(byDistrict[r.district_id] || dists.map(x => x.id)); mapOf[r.id] = d; return [r.id, d, 'active', r.id, 'auto', 'perf seed', 'system']; }));
  console.log('accounts', all.length, Date.now() - t0, 'ms');

  // orders
  const statuses = ['delivered', 'delivered', 'delivered', 'delivered', 'delivered', 'delivered', 'dispatched', 'packed', 'processing', 'accepted', 'assigned', 'cancelled'];
  const now = Date.now();
  let orderRows = [], made = 0;
  const flush = async () => {
    if (!orderRows.length) return;
    const first = Number((await db.queryOne('SELECT COALESCE(MAX(id),0) AS m FROM b2b_orders')).m);
    await db.bulk('INSERT INTO b2b_orders (order_no,buyer_account_id,buyer_type,seller_type,seller_account_id,warehouse_id,status,payment_method,payment_status,amount_paid,item_count,total_qty,subtotal,taxable_total,cgst_total,sgst_total,tax_total,grand_total,cost_total,seller_state_id,buyer_state_id,ship_name,ship_contact,ship_phone,ship_line1,ship_city,ship_district,ship_state,ship_pincode,idempotency_key,submitted_at,delivered_at,created_at) VALUES ?', orderRows.map(o => o.row));
    const ids = await db.query('SELECT id, order_no FROM b2b_orders WHERE id > ? ORDER BY id', [first]);
    const idOf = {}; ids.forEach(r => { idOf[r.order_no] = r.id; });
    const items = [], hist = [];
    for (const o of orderRows) {
      const id = idOf[o.no];
      o.items.forEach(it => items.push([id].concat(it)));
      hist.push([id, null, 'submitted', 'buyer', o.created], [id, 'submitted', o.status, 'system', o.created]);
    }
    await insert('INSERT INTO b2b_order_items (order_id,product_id,sku,name,hsn_code,gst_rate,mrp,base_price,unit_price,qty,qty_delivered,taxable_amount,cgst_amount,sgst_amount,line_total) VALUES ?', items, 4000);
    await insert('INSERT INTO b2b_order_status_history (order_id,from_status,to_status,actor_type,created_at) VALUES ?', hist, 4000);
    orderRows = [];
  };
  for (let i = 1; i <= N.orders; i++) {
    const r = pick(rets), status = pick(statuses), created = new Date(now - rnd(365 * 86400) * 1000);
    const k = 1 + rnd(7), items = []; let taxable = 0, tax = 0, qty = 0, cost = 0;
    for (let j = 0; j < k; j++) {
      const p = pick(pids), q = 6 * (1 + rnd(8)), unit = Number(p.base_price) * 1.18, t = unit * q, g = t * Number(p.gst_rate) / 100;
      taxable += t; tax += g; qty += q; cost += Number(p.base_price) * q;
      items.push([p.id, p.sku, p.name, '21069099', p.gst_rate, p.mrp, p.base_price, money(unit), q, status === 'delivered' ? q : null, money(t), money(g / 2), money(g / 2), money(t + g)]);
    }
    const total = Math.round(taxable + tax), no = 'PF' + tag + String(i).padStart(7, '0'), paid = status === 'delivered' && rnd(10) < 7;
    orderRows.push({ no, status, created, items, row: [no, r.id, 'retailer', 'distributor', mapOf[r.id], null, status, pick(['bank_transfer', 'upi', 'credit']), paid ? 'paid' : 'pending', paid ? total : 0,
      k, qty, money(taxable), money(taxable), money(tax / 2), money(tax / 2), money(tax), total, money(cost), state.id, state.id, r.shop_name, r.contact_person, r.mobile, '1 Main Road', r.city, r.district_name, 'Karnataka', r.pincode,
      'perf-' + tag + '-' + i, created, status === 'delivered' ? new Date(created.getTime() + 3 * 86400000) : null, created] });
    if (orderRows.length >= 1000) { await flush(); made += 1000; if (made % 20000 === 0) console.log('orders', made, Date.now() - t0, 'ms'); }
  }
  await flush();
  await db.query('ANALYZE TABLE b2b_orders, b2b_order_items, b2b_accounts, b2b_products, b2b_users, b2b_stock, b2b_retailer_distributor_map, b2b_service_areas, b2b_order_status_history');
  console.log('done in', Math.round((Date.now() - t0) / 1000), 's — sample logins (password Demo@1234):', all[0].email, '(distributor)', all[all.length - 1].email, '(retailer)');
  await db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
