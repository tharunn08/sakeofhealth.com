/**
 * Reporting and exports for the B2B back office.
 *
 * "Sales" = orders that were not cancelled / rejected / refunded, by order date.
 * GST figures come from final invoices less credit notes, by invoice date.
 * Company margin is measured on orders the company itself supplied.
 * Dates are India time (IST).
 */
const db = require('../../../db/connection.js');
const v = require('../lib/validate.js');
const exporter = require('../lib/export.js');
const inventory = require('../inventory/service.js');
const payments = require('../payments/service.js');
const { bad, like } = require('../lib/http.js');

const SOLD = "o.status NOT IN ('cancelled','rejected','refunded','draft')";
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

function istToday() { return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10); }
/** IST calendar date → the UTC instant it starts at, as 'YYYY-MM-DD HH:MM:SS'. */
function istStartUtc(isoDate) {
  return new Date(new Date(isoDate + 'T00:00:00Z').getTime() - IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
}
function addDays(isoDate, n) { return new Date(new Date(isoDate + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10); }

/** ?from=&to= (IST dates, inclusive) → validated range; default = last 30 days. Capped at 2 years. */
function range(q) {
  const today = istToday();
  let to = v.date(q.to) || today, from = v.date(q.from) || addDays(to, -29);
  if (from > to) { const t = from; from = to; to = t; }
  if ((new Date(to) - new Date(from)) / 86400000 > 731) throw bad('Choose a date range of two years or less');
  return { from: from, to: to, utcFrom: istStartUtc(from), utcTo: istStartUtc(addDays(to, 1)) };
}

/* ═════════════ Dashboard ═════════════ */

let dashCache = { at: 0, data: null };

async function dashboard(force) {
  if (!force && dashCache.data && Date.now() - dashCache.at < 45000) return dashCache.data;
  const today = istToday();
  const dayStart = istStartUtc(today), monthStart = istStartUtc(today.slice(0, 8) + '01'), d30 = istStartUtc(addDays(today, -29));
  const [accounts, todayRow, monthRow, last30, pendingOrders, statusRows, outstanding, credit, lowStock, expiry,
    topProducts, topSellers, topDistributorBuyers, topRetailers, topDistricts, states, fulfil, notifFailed] = await Promise.all([
    db.query('SELECT account_type, status, COUNT(*) AS n FROM b2b_accounts GROUP BY account_type, status'),
    db.queryOne('SELECT COUNT(*) AS orders, COALESCE(SUM(o.grand_total), 0) AS value FROM b2b_orders o WHERE o.created_at >= ? AND ' + SOLD, [dayStart]),
    db.queryOne('SELECT COUNT(*) AS orders, COALESCE(SUM(o.grand_total), 0) AS value, COALESCE(SUM(o.taxable_total), 0) AS taxable FROM b2b_orders o WHERE o.created_at >= ? AND ' + SOLD, [monthStart]),
    db.queryOne('SELECT COUNT(*) AS orders, COALESCE(SUM(o.grand_total), 0) AS value, COALESCE(AVG(o.grand_total), 0) AS aov FROM b2b_orders o WHERE o.created_at >= ? AND ' + SOLD, [d30]),
    db.queryOne("SELECT COUNT(*) AS n FROM b2b_orders WHERE status = 'pending_admin_approval'"),
    db.query("SELECT status, COUNT(*) AS n FROM b2b_orders WHERE status IN ('pending_admin_approval','approved','assigned','accepted','processing','packed','dispatched','out_for_delivery') GROUP BY status"),
    payments.outstandingTotal({}),
    db.queryOne('SELECT COALESCE(SUM(credit_limit), 0) AS total_limit, COALESCE(SUM(credit_used), 0) AS used FROM b2b_credit_accounts WHERE is_active = 1'),
    db.queryOne('SELECT COUNT(*) AS n FROM b2b_stock st JOIN b2b_warehouses w ON w.id = st.warehouse_id JOIN b2b_products p ON p.id = st.product_id ' +
      'WHERE w.owner_account_id IS NULL AND p.is_active = 1 AND p.low_stock_threshold > 0 AND st.qty_available <= p.low_stock_threshold'),
    inventory.expirySummary({ company_only: true }),
    db.query('SELECT i.product_id, i.sku, i.name, SUM(i.qty) AS qty, SUM(i.taxable_amount) AS value FROM b2b_order_items i JOIN b2b_orders o ON o.id = i.order_id ' +
      'WHERE o.created_at >= ? AND ' + SOLD + ' GROUP BY i.product_id, i.sku, i.name ORDER BY value DESC LIMIT 8', [d30]),
    db.query("SELECT o.seller_account_id AS id, a.business_name AS name, COUNT(*) AS orders, SUM(o.grand_total) AS value FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.seller_account_id " +
      "WHERE o.created_at >= ? AND o.seller_type = 'distributor' AND " + SOLD + ' GROUP BY o.seller_account_id, a.business_name ORDER BY value DESC LIMIT 8', [d30]),
    db.query("SELECT o.buyer_account_id AS id, a.business_name AS name, COUNT(*) AS orders, SUM(o.grand_total) AS value FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id " +
      "WHERE o.created_at >= ? AND o.buyer_type = 'distributor' AND " + SOLD + ' GROUP BY o.buyer_account_id, a.business_name ORDER BY value DESC LIMIT 8', [d30]),
    db.query("SELECT o.buyer_account_id AS id, COALESCE(a.shop_name, a.business_name) AS name, COUNT(*) AS orders, SUM(o.grand_total) AS value FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id " +
      "WHERE o.created_at >= ? AND o.buyer_type = 'retailer' AND " + SOLD + ' GROUP BY o.buyer_account_id, name ORDER BY value DESC LIMIT 8', [d30]),
    db.query('SELECT o.ship_district AS name, COUNT(*) AS orders, SUM(o.grand_total) AS value FROM b2b_orders o WHERE o.created_at >= ? AND ' + SOLD +
      ' GROUP BY o.ship_district ORDER BY value DESC LIMIT 8', [d30]),
    db.query('SELECT o.ship_state AS name, COUNT(*) AS orders, SUM(o.grand_total) AS value FROM b2b_orders o WHERE o.created_at >= ? AND ' + SOLD +
      ' GROUP BY o.ship_state ORDER BY value DESC LIMIT 12', [d30]),
    db.queryOne("SELECT AVG(TIMESTAMPDIFF(MINUTE, o.submitted_at, o.delivered_at)) AS mins, COUNT(*) AS n FROM b2b_orders o WHERE o.delivered_at >= ? AND o.status IN ('delivered','partially_delivered')", [d30]),
    db.queryOne("SELECT COUNT(*) AS n FROM b2b_notification_queue WHERE status = 'failed' AND created_at >= ?", [d30]),
  ]);

  const count = function (type, statuses) {
    return accounts.filter(function (r) { return r.account_type === type && (!statuses || statuses.indexOf(r.status) !== -1); })
      .reduce(function (s, r) { return s + Number(r.n); }, 0);
  };
  const pendingKyc = ['pending', 'under_review'];
  const data = {
    asOf: new Date().toISOString(),
    retailers: { total: count('retailer'), active: count('retailer', ['approved']), pending: count('retailer', pendingKyc), suspended: count('retailer', ['suspended', 'blocked']) },
    distributors: { total: count('distributor'), active: count('distributor', ['approved']), pending: count('distributor', pendingKyc), suspended: count('distributor', ['suspended', 'blocked']) },
    today: { orders: Number(todayRow.orders), value: todayRow.value },
    month: { orders: Number(monthRow.orders), value: monthRow.value, taxable: monthRow.taxable },
    last30: { orders: Number(last30.orders), value: last30.value, averageOrderValue: Number(last30.aov).toFixed(2) },
    pendingApprovals: { accounts: count('retailer', pendingKyc) + count('distributor', pendingKyc), orders: Number(pendingOrders.n) },
    pipeline: statusRows.map(function (r) { return { status: r.status, count: Number(r.n) }; }),
    outstanding: outstanding,
    credit: { totalLimit: credit.total_limit, exposure: credit.used },
    lowStock: Number(lowStock.n),
    expiring: expiry,
    topProducts: topProducts, topDistributors: topSellers, topDistributorBuyers: topDistributorBuyers, topRetailers: topRetailers,
    topDistricts: topDistricts, stateSales: states,
    fulfilment: { averageHours: fulfil.mins == null ? null : Math.round(Number(fulfil.mins) / 6) / 10, deliveredOrders: Number(fulfil.n) },
    failedNotifications: Number(notifFailed.n),
  };
  dashCache = { at: Date.now(), data: data };
  return data;
}

/* ═════════════ Reports ═════════════ */

const col = function (key, label, type) { return { key: key, label: label, type: type || 'text' }; };

const REPORTS = {
  sales: {
    title: 'Sales by day',
    columns: [col('period', 'Date', 'date'), col('orders', 'Orders', 'number'), col('qty', 'Units', 'number'), col('taxable', 'Taxable value', 'money'), col('tax', 'GST', 'money'), col('total', 'Order value', 'money')],
    run: function (r, q) {
      const monthly = q.group === 'month';
      const expr = monthly ? "DATE_FORMAT(o.created_at + INTERVAL 330 MINUTE, '%Y-%m')" : 'DATE(o.created_at + INTERVAL 330 MINUTE)';
      return db.query('SELECT ' + expr + ' AS period, COUNT(*) AS orders, SUM(o.total_qty) AS qty, SUM(o.taxable_total) AS taxable, SUM(o.tax_total) AS tax, SUM(o.grand_total) AS total ' +
        'FROM b2b_orders o WHERE o.created_at >= ? AND o.created_at < ? AND ' + SOLD + ' GROUP BY period ORDER BY period', [r.utcFrom, r.utcTo]);
    },
  },
  products: {
    title: 'Product sales',
    columns: [col('sku', 'SKU'), col('name', 'Product'), col('category', 'Category'), col('orders', 'Orders', 'number'), col('qty', 'Units', 'number'), col('taxable', 'Taxable value', 'money')],
    run: function (r) {
      return db.query('SELECT i.sku, i.name, c.name AS category, COUNT(DISTINCT i.order_id) AS orders, SUM(i.qty) AS qty, SUM(i.taxable_amount) AS taxable ' +
        'FROM b2b_order_items i JOIN b2b_orders o ON o.id = i.order_id LEFT JOIN b2b_products p ON p.id = i.product_id LEFT JOIN b2b_categories c ON c.id = p.category_id ' +
        'WHERE o.created_at >= ? AND o.created_at < ? AND ' + SOLD + ' GROUP BY i.product_id, i.sku, i.name, c.name ORDER BY taxable DESC LIMIT 5000', [r.utcFrom, r.utcTo]);
    },
  },
  retailers: {
    title: 'Retailer purchases',
    columns: [col('name', 'Retailer'), col('shop', 'Shop'), col('city', 'City'), col('pincode', 'Pincode'), col('distributor', 'Distributor'), col('orders', 'Orders', 'number'), col('value', 'Order value', 'money'), col('last_order', 'Last order', 'date')],
    run: function (r) {
      return db.query("SELECT a.business_name AS name, a.shop_name AS shop, a.city, a.pincode, d.business_name AS distributor, COUNT(*) AS orders, SUM(o.grand_total) AS value, MAX(o.created_at) AS last_order " +
        'FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id LEFT JOIN b2b_retailer_distributor_map m ON m.current_retailer_id = a.id LEFT JOIN b2b_accounts d ON d.id = m.distributor_id ' +
        "WHERE o.created_at >= ? AND o.created_at < ? AND o.buyer_type = 'retailer' AND " + SOLD + ' GROUP BY a.id, a.business_name, a.shop_name, a.city, a.pincode, d.business_name ORDER BY value DESC LIMIT 5000', [r.utcFrom, r.utcTo]);
    },
  },
  distributors: {
    title: 'Distributor performance',
    columns: [col('name', 'Distributor'), col('city', 'City'), col('retailers', 'Active retailers', 'number'), col('retailer_orders', 'Retailer orders supplied', 'number'),
      col('retailer_sales', 'Sales to retailers', 'money'), col('purchase_orders', 'Orders from company', 'number'), col('purchases', 'Purchases from company', 'money')],
    run: function (r) {
      return db.query(
        "SELECT a.business_name AS name, a.city, " +
        " (SELECT COUNT(*) FROM b2b_retailer_distributor_map m WHERE m.distributor_id = a.id AND m.status = 'active') AS retailers, " +
        ' COALESCE(s.orders, 0) AS retailer_orders, COALESCE(s.value, 0) AS retailer_sales, COALESCE(b.orders, 0) AS purchase_orders, COALESCE(b.value, 0) AS purchases ' +
        'FROM b2b_accounts a ' +
        'LEFT JOIN (SELECT o.seller_account_id AS id, COUNT(*) AS orders, SUM(o.grand_total) AS value FROM b2b_orders o WHERE o.created_at >= ? AND o.created_at < ? AND ' + SOLD + " AND o.seller_type = 'distributor' GROUP BY o.seller_account_id) s ON s.id = a.id " +
        'LEFT JOIN (SELECT o.buyer_account_id AS id, COUNT(*) AS orders, SUM(o.grand_total) AS value FROM b2b_orders o WHERE o.created_at >= ? AND o.created_at < ? AND ' + SOLD + " AND o.buyer_type = 'distributor' GROUP BY o.buyer_account_id) b ON b.id = a.id " +
        "WHERE a.account_type = 'distributor' AND a.status = 'approved' ORDER BY (COALESCE(s.value, 0) + COALESCE(b.value, 0)) DESC LIMIT 5000",
        [r.utcFrom, r.utcTo, r.utcFrom, r.utcTo]);
    },
  },
  mapping: {
    title: 'Distributor → retailer mapping',
    columns: [col('distributor', 'Distributor'), col('retailer', 'Retailer'), col('shop', 'Shop'), col('mobile', 'Phone'), col('city', 'City'), col('pincode', 'Pincode'), col('status', 'Mapping'), col('method', 'Assigned'), col('since', 'Since', 'date')],
    run: function () {
      return db.query('SELECT d.business_name AS distributor, a.business_name AS retailer, a.shop_name AS shop, a.mobile, a.city, a.pincode, m.status, m.method, m.started_at AS since ' +
        'FROM b2b_retailer_distributor_map m JOIN b2b_accounts a ON a.id = m.retailer_id JOIN b2b_accounts d ON d.id = m.distributor_id ' +
        'WHERE m.current_retailer_id IS NOT NULL ORDER BY d.business_name, a.business_name LIMIT 50000');
    },
  },
  inventory: {
    title: 'Stock position',
    columns: [col('warehouse', 'Warehouse'), col('sku', 'SKU'), col('name', 'Product'), col('available', 'Available', 'number'), col('reserved', 'Reserved', 'number'), col('allocated', 'Allocated', 'number'),
      col('in_transit', 'In transit', 'number'), col('damaged', 'Damaged', 'number'), col('expired', 'Expired', 'number'), col('value', 'Stock value (base price)', 'money')],
    run: function () {
      return db.query('SELECT w.code AS warehouse, p.sku, p.name, st.qty_available AS available, st.qty_reserved AS reserved, st.qty_allocated AS allocated, st.qty_in_transit AS in_transit, ' +
        'st.qty_damaged AS damaged, st.qty_expired AS expired, (st.qty_available + st.qty_reserved + st.qty_allocated) * p.base_price AS value ' +
        'FROM b2b_stock st JOIN b2b_warehouses w ON w.id = st.warehouse_id JOIN b2b_products p ON p.id = st.product_id WHERE w.owner_account_id IS NULL ORDER BY w.code, p.sku LIMIT 50000');
    },
  },
  gst: {
    title: 'GST summary (invoices less credit notes)',
    columns: [col('month', 'Month'), col('seller', 'Seller'), col('gst_rate', 'GST %', 'number'), col('supply', 'Supply'), col('taxable', 'Taxable value', 'money'), col('cgst', 'CGST', 'money'), col('sgst', 'SGST', 'money'), col('igst', 'IGST', 'money'), col('tax', 'Total GST', 'money')],
    run: function (r, q) {
      const seller = q.seller === 'all' ? '' : " AND x.seller_type = 'company'";
      return db.query(
        "SELECT x.month, x.seller, x.gst_rate, x.supply, SUM(x.taxable) AS taxable, SUM(x.cgst) AS cgst, SUM(x.sgst) AS sgst, SUM(x.igst) AS igst, SUM(x.cgst + x.sgst + x.igst) AS tax FROM (" +
        "  SELECT DATE_FORMAT(i.invoice_date, '%Y-%m') AS month, i.seller_name AS seller, i.seller_type, ii.gst_rate, IF(i.is_interstate = 1, 'Inter-state', 'Intra-state') AS supply, " +
        '         ii.taxable_amount AS taxable, ii.cgst_amount AS cgst, ii.sgst_amount AS sgst, ii.igst_amount AS igst ' +
        '  FROM b2b_invoice_items ii JOIN b2b_invoices i ON i.id = ii.invoice_id WHERE i.invoice_date >= ? AND i.invoice_date <= ? ' +
        '  UNION ALL ' +
        "  SELECT DATE_FORMAT(c.note_date, '%Y-%m'), i.seller_name, i.seller_type, ci.gst_rate, IF(i.is_interstate = 1, 'Inter-state', 'Intra-state'), " +
        '         -ci.taxable_amount, -ci.cgst_amount, -ci.sgst_amount, -ci.igst_amount ' +
        '  FROM b2b_credit_note_items ci JOIN b2b_credit_notes c ON c.id = ci.credit_note_id JOIN b2b_invoices i ON i.id = c.invoice_id WHERE c.note_date >= ? AND c.note_date <= ? ' +
        ') x WHERE 1 = 1' + seller + ' GROUP BY x.month, x.seller, x.gst_rate, x.supply ORDER BY x.month, x.seller, x.gst_rate LIMIT 5000', [r.from, r.to, r.from, r.to]);
    },
  },
  margins: {
    title: 'Company margin by product (orders supplied by the company)',
    columns: [col('sku', 'SKU'), col('name', 'Product'), col('channel', 'Sold to'), col('qty', 'Units', 'number'), col('revenue', 'Revenue (ex-GST)', 'money'), col('cost', 'Base cost', 'money'), col('margin', 'Margin', 'money'), col('margin_pct', 'Margin %', 'number')],
    run: function (r) {
      return db.query("SELECT i.sku, i.name, o.buyer_type AS channel, SUM(i.qty) AS qty, SUM(i.taxable_amount) AS revenue, SUM(i.base_price * i.qty) AS cost, " +
        'SUM(i.taxable_amount) - SUM(i.base_price * i.qty) AS margin, ROUND((SUM(i.taxable_amount) - SUM(i.base_price * i.qty)) / NULLIF(SUM(i.taxable_amount), 0) * 100, 2) AS margin_pct ' +
        "FROM b2b_order_items i JOIN b2b_orders o ON o.id = i.order_id WHERE o.created_at >= ? AND o.created_at < ? AND o.seller_type = 'company' AND " + SOLD +
        ' GROUP BY i.product_id, i.sku, i.name, o.buyer_type ORDER BY margin DESC LIMIT 5000', [r.utcFrom, r.utcTo]);
    },
  },
  geographic: {
    title: 'Sales by geography',
    columns: [col('state', 'State'), col('district', 'District'), col('city', 'City'), col('pincode', 'Pincode'), col('buyers', 'Buyers', 'number'), col('orders', 'Orders', 'number'), col('value', 'Order value', 'money')],
    run: function (r, q) {
      const levels = { state: ['o.ship_state'], district: ['o.ship_state', 'o.ship_district'], city: ['o.ship_state', 'o.ship_district', 'o.ship_city'],
        pincode: ['o.ship_state', 'o.ship_district', 'o.ship_city', 'o.ship_pincode'] };
      const g = levels[q.level] || levels.district;
      const sel = ['o.ship_state AS state', g.length > 1 ? 'o.ship_district AS district' : "'' AS district", g.length > 2 ? 'o.ship_city AS city' : "'' AS city", g.length > 3 ? 'o.ship_pincode AS pincode' : "'' AS pincode"];
      return db.query('SELECT ' + sel.join(', ') + ', COUNT(DISTINCT o.buyer_account_id) AS buyers, COUNT(*) AS orders, SUM(o.grand_total) AS value FROM b2b_orders o ' +
        'WHERE o.created_at >= ? AND o.created_at < ? AND ' + SOLD + ' GROUP BY ' + g.join(', ') + ' ORDER BY value DESC LIMIT 5000', [r.utcFrom, r.utcTo]);
    },
  },
};

const SCREEN_ROWS = 400;

async function report(type, q, opts) {
  const def = REPORTS[type];
  if (!def) throw bad('Unknown report');
  const r = range(q);
  const rows = await def.run(r, q);
  const out = { type: type, title: def.title, from: r.from, to: r.to, columns: def.columns, rows: rows, total: rows.length };
  if (opts && opts.screen) {
    // On screen: totals are worked out here over the full result, and only the
    // first SCREEN_ROWS rows travel to the browser. Exports get everything.
    const totals = {};
    def.columns.forEach(function (c) {
      if (c.type !== 'money' && !(c.type === 'number' && !/pct|rate|%/i.test(c.key))) return;
      let paise = 0;
      for (let i = 0; i < rows.length; i++) paise += Math.round(Number(rows[i][c.key] || 0) * 100);
      totals[c.key] = (paise / 100).toFixed(c.type === 'money' ? 2 : 0);
    });
    out.totals = totals;
    out.rows = rows.slice(0, SCREEN_ROWS);
    out.truncated = rows.length > SCREEN_ROWS;
  }
  return out;
}

/* ═════════════ Exports (streamed) ═════════════ */

function accountExport(type) {
  return function (q) {
    const where = ['a.account_type = ?'], params = [type];
    if (q.status) { where.push('a.status = ?'); params.push(String(q.status)); }
    if (q.state_id) { where.push('a.state_id = ?'); params.push(Number(q.state_id)); }
    const cols = [col('id', 'ID', 'number'), col('business_name', type === 'retailer' ? 'Retailer' : 'Distributor')];
    if (type === 'retailer') cols.push(col('shop_name', 'Shop'));
    cols.push(col('status', 'Status'), col('contact_person', 'Contact person'), col('mobile', 'Mobile'), col('email', 'Email'), col('gstin', 'GSTIN'), col('pan', 'PAN'),
      col('business_type', 'Business type'), col('address', 'Address'), col('city', 'City'), col('district_name', 'District'), col('state_name', 'State'), col('pincode', 'Pincode'),
      col('latitude', 'Latitude'), col('longitude', 'Longitude'));
    if (type === 'retailer') cols.push(col('distributor', 'Distributor'));
    cols.push(col('created_at', 'Registered'), col('approved_at', 'Approved'));
    return Object.assign({ name: type + 's', columns: cols }, exporter.keyset(
      "SELECT a.id, a.business_name, a.shop_name, a.status, a.contact_person, a.mobile, a.email, a.gstin, a.pan, a.business_type, CONCAT_WS(', ', a.address_line1, a.address_line2, a.landmark) AS address, " +
      'a.city, a.district_name, s.name AS state_name, a.pincode, a.latitude, a.longitude, d.business_name AS distributor, a.created_at, a.approved_at ' +
      'FROM b2b_accounts a JOIN b2b_states s ON s.id = a.state_id LEFT JOIN b2b_retailer_distributor_map m ON m.current_retailer_id = a.id LEFT JOIN b2b_accounts d ON d.id = m.distributor_id',
      where, params, 'a.id'));
  };
}

const EXPORTS = {
  retailers: accountExport('retailer'),
  distributors: accountExport('distributor'),
  products: function (q) {
    const where = [], params = [];
    if (q.active === '1') where.push('p.is_active = 1');
    if (q.q) { const t = v.text(q.q, 80); where.push('(p.sku LIKE ? OR p.name LIKE ?)'); params.push(like(t, 'prefix'), like(t)); }
    return Object.assign({ name: 'products', columns: [col('sku', 'SKU'), col('name', 'Product Name'), col('category', 'Category'), col('subcategory', 'Subcategory'), col('brand', 'Brand'), col('hsn_code', 'HSN'),
      col('gst_rate', 'GST Rate', 'number'), col('mrp', 'MRP', 'money'), col('base_price', 'Base Price', 'money'), col('distributor_margin', 'Distributor Margin', 'number'), col('retailer_margin', 'Retailer Margin', 'number'),
      col('distributor_price', 'Distributor Price', 'money'), col('retailer_price', 'Retailer Price', 'money'), col('moq', 'MOQ', 'number'), col('case_qty', 'Case Quantity', 'number'), col('pack_size', 'Pack Size'),
      col('barcode', 'Barcode'), col('stock', 'Company Stock', 'number'), col('active', 'Active')] }, exporter.keyset(
      "SELECT p.id, p.sku, p.name, c.name AS category, sc.name AS subcategory, p.brand, p.hsn_code, p.gst_rate, p.mrp, p.base_price, p.distributor_margin, p.retailer_margin, p.distributor_price, p.retailer_price, " +
      "p.moq, p.case_qty, p.pack_size, p.barcode, IF(p.is_active = 1, 'Yes', 'No') AS active, " +
      '(SELECT COALESCE(SUM(st.qty_available), 0) FROM b2b_stock st JOIN b2b_warehouses w ON w.id = st.warehouse_id AND w.owner_account_id IS NULL WHERE st.product_id = p.id) AS stock ' +
      'FROM b2b_products p LEFT JOIN b2b_categories c ON c.id = p.category_id LEFT JOIN b2b_categories sc ON sc.id = p.subcategory_id', where, params, 'p.id'));
  },
  orders: function (q) {
    const r = range(q), where = ['o.created_at >= ?', 'o.created_at < ?'], params = [r.utcFrom, r.utcTo];
    if (q.status) { where.push('o.status = ?'); params.push(String(q.status)); }
    return Object.assign({ name: 'b2b-orders', columns: [col('order_no', 'Order No'), col('created_at', 'Placed (UTC)'), col('status', 'Status'), col('buyer_type', 'Buyer type'), col('buyer', 'Buyer'),
      col('seller', 'Supplied by'), col('total_qty', 'Units', 'number'), col('taxable_total', 'Taxable', 'money'), col('cgst_total', 'CGST', 'money'), col('sgst_total', 'SGST', 'money'), col('igst_total', 'IGST', 'money'),
      col('grand_total', 'Order value', 'money'), col('amount_paid', 'Paid', 'money'), col('payment_method', 'Payment method'), col('payment_status', 'Payment status'), col('ship_city', 'City'),
      col('ship_district', 'District'), col('ship_state', 'State'), col('ship_pincode', 'Pincode'), col('ship_phone', 'Phone'), col('delivered_at', 'Delivered (UTC)')] }, exporter.keyset(
      "SELECT o.id, o.order_no, o.created_at, o.status, o.buyer_type, b.business_name AS buyer, COALESCE(s.business_name, 'Company') AS seller, o.total_qty, o.taxable_total, o.cgst_total, o.sgst_total, o.igst_total, " +
      'o.grand_total, o.amount_paid, o.payment_method, o.payment_status, o.ship_city, o.ship_district, o.ship_state, o.ship_pincode, o.ship_phone, o.delivered_at ' +
      'FROM b2b_orders o JOIN b2b_accounts b ON b.id = o.buyer_account_id LEFT JOIN b2b_accounts s ON s.id = o.seller_account_id', where, params, 'o.id'));
  },
  invoices: function (q) {
    const r = range(q);
    return Object.assign({ name: 'b2b-invoices', columns: [col('invoice_no', 'Invoice No'), col('invoice_date', 'Date', 'date'), col('status', 'Status'), col('order_no', 'Order No'), col('seller_name', 'Seller'),
      col('seller_gstin', 'Seller GSTIN'), col('buyer_name', 'Buyer'), col('buyer_gstin', 'Buyer GSTIN'), col('place_of_supply', 'Place of supply'), col('taxable_total', 'Taxable', 'money'), col('cgst_total', 'CGST', 'money'),
      col('sgst_total', 'SGST', 'money'), col('igst_total', 'IGST', 'money'), col('grand_total', 'Invoice value', 'money'), col('due_date', 'Due date', 'date'), col('payment_status', 'Payment status')] }, exporter.keyset(
      'SELECT i.id, i.invoice_no, i.invoice_date, i.status, o.order_no, i.seller_name, i.seller_gstin, i.buyer_name, i.buyer_gstin, i.place_of_supply, i.taxable_total, i.cgst_total, i.sgst_total, i.igst_total, ' +
      'i.grand_total, i.due_date, o.payment_status FROM b2b_invoices i JOIN b2b_orders o ON o.id = i.order_id', ['i.invoice_date >= ?', 'i.invoice_date <= ?'], [r.from, r.to], 'i.id'));
  },
  payments: function (q) {
    const r = range(q);
    return Object.assign({ name: 'b2b-payments', columns: [col('received_at', 'Received (UTC)'), col('order_no', 'Order No'), col('payer', 'Paid by'), col('payee', 'Paid to'), col('method', 'Method'),
      col('amount', 'Amount', 'money'), col('reference', 'Reference'), col('status', 'Status'), col('recorded_by', 'Recorded by')] }, exporter.keyset(
      "SELECT p.id, p.received_at, o.order_no, a.business_name AS payer, COALESCE(s.business_name, 'Company') AS payee, p.method, p.amount, COALESCE(p.reference, p.gateway_payment_id) AS reference, p.status, p.recorded_by " +
      'FROM b2b_payments p JOIN b2b_orders o ON o.id = p.order_id JOIN b2b_accounts a ON a.id = p.payer_account_id LEFT JOIN b2b_accounts s ON s.id = p.payee_account_id',
      ["p.status IN ('received','reversed')", 'p.received_at >= ?', 'p.received_at < ?'], [r.utcFrom, r.utcTo], 'p.id'));
  },
  outstanding: function () {
    return Object.assign({ name: 'b2b-outstanding', columns: [col('order_no', 'Order No'), col('buyer', 'Buyer'), col('buyer_type', 'Type'), col('mobile', 'Mobile'), col('seller', 'Owed to'), col('invoice_no', 'Invoice'),
      col('due_date', 'Due date', 'date'), col('grand_total', 'Order value', 'money'), col('amount_paid', 'Paid', 'money'), col('outstanding', 'Outstanding', 'money'), col('days_overdue', 'Days overdue', 'number')] }, exporter.keyset(
      "SELECT o.id, o.order_no, a.business_name AS buyer, o.buyer_type, a.mobile, COALESCE(s.business_name, 'Company') AS seller, i.invoice_no, i.due_date, o.grand_total, o.amount_paid, " +
      '(o.grand_total - o.amount_paid) AS outstanding, GREATEST(0, DATEDIFF(UTC_DATE(), i.due_date)) AS days_overdue ' +
      'FROM b2b_orders o JOIN b2b_accounts a ON a.id = o.buyer_account_id LEFT JOIN b2b_accounts s ON s.id = o.seller_account_id LEFT JOIN b2b_invoices i ON i.live_order_id = o.id',
      ["o.status NOT IN ('cancelled','rejected','refunded','draft')", "o.payment_status IN ('pending','partial')"], [], 'o.id'));
  },
  movements: function (q) {
    const r = range(q);
    return Object.assign({ name: 'stock-movements', columns: [col('created_at', 'When (UTC)'), col('warehouse', 'Warehouse'), col('sku', 'SKU'), col('name', 'Product'), col('movement_type', 'Movement'), col('qty', 'Qty', 'number'),
      col('from_status', 'From'), col('to_status', 'To'), col('batch_no', 'Batch'), col('ref_type', 'Reference'), col('ref_id', 'Ref ID', 'number'), col('reason', 'Reason'), col('actor_label', 'User')] }, exporter.keyset(
      'SELECT m.id, m.created_at, w.code AS warehouse, p.sku, p.name, m.movement_type, m.qty, m.from_status, m.to_status, b.batch_no, m.ref_type, m.ref_id, m.reason, m.actor_label ' +
      'FROM b2b_stock_movements m JOIN b2b_warehouses w ON w.id = m.warehouse_id JOIN b2b_products p ON p.id = m.product_id LEFT JOIN b2b_batches b ON b.id = m.batch_id',
      ['m.created_at >= ?', 'm.created_at < ?'], [r.utcFrom, r.utcTo], 'm.id'));
  },
};

/** Stream an export to the response. Report types (sales, gst, margins, …) are exportable too. */
async function exportTo(res, name, q) {
  const format = q.format === 'xlsx' ? 'xlsx' : 'csv';
  if (EXPORTS[name]) return exporter.send(res, EXPORTS[name](q), format);
  if (REPORTS[name]) {
    const r = await report(name, q);
    return exporter.send(res, { name: 'b2b-' + name, columns: r.columns, rows: r.rows }, format);
  }
  throw bad('Unknown export');
}

/* ═════════════ Portal dashboards ═════════════ */

async function retailerDashboard(accountId) {
  const [orders, recent] = await Promise.all([
    db.query('SELECT status, COUNT(*) AS n FROM b2b_orders WHERE buyer_account_id = ? GROUP BY status', [accountId]),
    db.query('SELECT id, order_no, status, grand_total, total_qty, payment_status, created_at FROM b2b_orders WHERE buyer_account_id = ? ORDER BY id DESC LIMIT 5', [accountId]),
  ]);
  const by = {}; orders.forEach(function (r) { by[r.status] = Number(r.n); });
  const open = ['submitted', 'pending_admin_approval', 'approved', 'assigned', 'accepted', 'processing', 'packed', 'dispatched', 'out_for_delivery'].reduce(function (s, k) { return s + (by[k] || 0); }, 0);
  return { orders: { open: open, delivered: (by.delivered || 0) + (by.partially_delivered || 0), total: orders.reduce(function (s, r) { return s + Number(r.n); }, 0) },
    outstanding: await payments.outstandingTotal({ buyerAccountId: accountId }), recentOrders: recent };
}

async function distributorDashboard(accountId) {
  const d30 = istStartUtc(addDays(istToday(), -29));
  const [retailers, statusRows, sales, receivable, recent, own] = await Promise.all([
    db.queryOne("SELECT COUNT(*) AS n FROM b2b_retailer_distributor_map WHERE distributor_id = ? AND status = 'active'", [accountId]),
    db.query("SELECT status, COUNT(*) AS n FROM b2b_orders WHERE seller_type = 'distributor' AND seller_account_id = ? GROUP BY status", [accountId]),
    db.queryOne("SELECT COUNT(*) AS orders, COALESCE(SUM(o.grand_total), 0) AS value FROM b2b_orders o WHERE o.seller_type = 'distributor' AND o.seller_account_id = ? AND o.created_at >= ? AND " + SOLD, [accountId, d30]),
    payments.outstandingTotal({ sellerAccountId: accountId }),
    db.query("SELECT o.id, o.order_no, o.status, o.grand_total, o.total_qty, o.ship_name, o.ship_city, o.created_at FROM b2b_orders o WHERE o.seller_type = 'distributor' AND o.seller_account_id = ? ORDER BY o.id DESC LIMIT 6", [accountId]),
    retailerDashboard(accountId),
  ]);
  const by = {}; statusRows.forEach(function (r) { by[r.status] = Number(r.n); });
  return {
    retailers: Number(retailers.n),
    retailerOrders: { new: by.assigned || 0, pending: (by.assigned || 0) + (by.accepted || 0), processing: (by.processing || 0) + (by.packed || 0),
      inTransit: (by.dispatched || 0) + (by.out_for_delivery || 0), delivered: (by.delivered || 0) + (by.partially_delivered || 0) },
    sales30: { orders: Number(sales.orders), value: sales.value },
    receivable: receivable,
    recentRetailerOrders: recent,
    myOrders: own.orders, myOutstanding: own.outstanding, myRecentOrders: own.recentOrders,
  };
}

module.exports = { dashboard, report, exportTo, retailerDashboard, distributorDashboard, range, REPORTS, EXPORTS, istToday };
