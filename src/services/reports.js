/**
 * Dashboard metrics, analytics aggregation and CSV report generation.
 */
const { db } = require('./db.js');

const DAY = 86400000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function inRange(order, from, to) {
  const t = new Date(order.createdAt).getTime();
  return t >= from && t < to;
}

function sum(arr, fn) {
  return arr.reduce((s, x) => s + (fn(x) || 0), 0);
}

/** Headline numbers for the dashboard cards. */
function dashboard() {
  const orders = db.orders.all();
  const now = Date.now();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY;
  const weekStart = todayStart - 6 * DAY;
  const monthStart = todayStart - 29 * DAY;

  const today = orders.filter(o => inRange(o, todayStart, now + 1));
  const yesterday = orders.filter(o => inRange(o, yesterdayStart, todayStart));
  const week = orders.filter(o => inRange(o, weekStart, now + 1));
  const month = orders.filter(o => inRange(o, monthStart, now + 1));

  const paid = o => o.status !== 'cancelled';
  const revenue = list => sum(list.filter(paid), o => o.total);

  const todayRev = revenue(today);
  const yestRev = revenue(yesterday);

  const byStatus = {};
  ['pending', 'accepted', 'prepared', 'out_for_delivery', 'delivered', 'cancelled'].forEach(s => {
    byStatus[s] = orders.filter(o => o.status === s).length;
  });

  return {
    totals: {
      orders: orders.length,
      revenue: revenue(orders),
      customers: db.customers.count(),
      products: db.products.count({ active: true }),
      avgOrderValue: orders.length ? Math.round(revenue(orders) / orders.filter(paid).length || 0) : 0,
    },
    today: {
      orders: today.length,
      revenue: todayRev,
      items: sum(today, o => sum(o.items, i => i.qty)),
    },
    yesterday: {
      orders: yesterday.length,
      revenue: yestRev,
      items: sum(yesterday, o => sum(o.items, i => i.qty)),
    },
    deltas: {
      orders: pctChange(today.length, yesterday.length),
      revenue: pctChange(todayRev, yestRev),
    },
    week: { orders: week.length, revenue: revenue(week) },
    month: { orders: month.length, revenue: revenue(month) },
    byStatus: byStatus,
    pendingAction: orders.filter(o => o.status === 'pending' || o.status === 'accepted').length,
    recentOrders: orders
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map(slimOrder),
  };
}

function pctChange(now, before) {
  if (!before) return now > 0 ? 100 : 0;
  return Math.round(((now - before) / before) * 100);
}

function slimOrder(o) {
  return {
    id: o.id,
    orderId: o.orderId,
    customer: o.customer.name,
    phone: o.customer.phone,
    total: o.total,
    status: o.status,
    items: sum(o.items, i => i.qty),
    createdAt: o.createdAt,
    city: (o.address && o.address.city) || '',
  };
}

/** Time series + breakdowns for the analytics page. */
function analytics(days) {
  days = Number(days) || 30;
  const orders = db.orders.all().filter(o => o.status !== 'cancelled');
  const todayStart = startOfDay(Date.now());

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = todayStart - i * DAY;
    const dayOrders = orders.filter(o => inRange(o, from, from + DAY));
    series.push({
      date: new Date(from).toISOString().slice(0, 10),
      orders: dayOrders.length,
      revenue: sum(dayOrders, o => o.total),
      units: sum(dayOrders, o => sum(o.items, it => it.qty)),
    });
  }

  // Top products
  const productMap = {};
  orders.forEach(o => o.items.forEach(i => {
    if (!productMap[i.id]) productMap[i.id] = { id: i.id, name: i.name, units: 0, revenue: 0 };
    productMap[i.id].units += i.qty;
    productMap[i.id].revenue += i.price * i.qty;
  }));
  const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  // Geography
  const cityMap = {};
  orders.forEach(o => {
    const city = ((o.address && o.address.city) || 'Unknown').trim() || 'Unknown';
    if (!cityMap[city]) cityMap[city] = { city: city, orders: 0, revenue: 0 };
    cityMap[city].orders++;
    cityMap[city].revenue += o.total;
  });
  const topCities = Object.values(cityMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

  // Coupons
  const couponMap = {};
  orders.filter(o => o.couponCode).forEach(o => {
    if (!couponMap[o.couponCode]) couponMap[o.couponCode] = { code: o.couponCode, uses: 0, discount: 0, revenue: 0 };
    couponMap[o.couponCode].uses++;
    couponMap[o.couponCode].discount += o.discount || 0;
    couponMap[o.couponCode].revenue += o.total;
  });

  // Payment split
  const paymentMap = {};
  orders.forEach(o => {
    const m = (o.payment && o.payment.method) || 'unknown';
    paymentMap[m] = (paymentMap[m] || 0) + 1;
  });

  // Repeat rate
  const customers = db.customers.all();
  const repeat = customers.filter(c => (c.orderCount || 0) > 1).length;

  return {
    series: series,
    topProducts: topProducts,
    topCities: topCities,
    coupons: Object.values(couponMap).sort((a, b) => b.uses - a.uses),
    paymentSplit: paymentMap,
    customers: {
      total: customers.length,
      repeat: repeat,
      repeatRate: customers.length ? Math.round((repeat / customers.length) * 100) : 0,
      new: customers.filter(c => new Date(c.firstOrderAt).getTime() > todayStart - 30 * DAY).length,
    },
    fulfilment: fulfilmentStats(),
  };
}

function fulfilmentStats() {
  const delivered = db.orders.all().filter(o => o.status === 'delivered' && o.deliveredAt);
  if (!delivered.length) return { avgHours: 0, delivered: 0 };
  const hours = delivered.map(o =>
    (new Date(o.deliveredAt).getTime() - new Date(o.createdAt).getTime()) / 3600000
  );
  return {
    delivered: delivered.length,
    avgHours: Math.round(sum(hours, h => h) / hours.length * 10) / 10,
    fastest: Math.round(Math.min.apply(null, hours) * 10) / 10,
    slowest: Math.round(Math.max.apply(null, hours) * 10) / 10,
  };
}

/* ─── CSV export ─── */

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCSV(rows, headers) {
  const head = headers.map(h => csvEscape(h.label)).join(',');
  const body = rows.map(r => headers.map(h => csvEscape(h.get(r))).join(',')).join('\n');
  return head + '\n' + body;
}

function ordersCSV(filters) {
  filters = filters || {};
  let orders = db.orders.all();
  if (filters.from) orders = orders.filter(o => new Date(o.createdAt) >= new Date(filters.from));
  if (filters.to) orders = orders.filter(o => new Date(o.createdAt) <= new Date(filters.to + 'T23:59:59'));
  if (filters.status) orders = orders.filter(o => o.status === filters.status);

  return toCSV(orders, [
    { label: 'Order ID', get: o => o.orderId },
    { label: 'Date', get: o => new Date(o.createdAt).toLocaleString('en-IN') },
    { label: 'Status', get: o => o.status },
    { label: 'Customer', get: o => o.customer.name },
    { label: 'Email', get: o => o.customer.email },
    { label: 'Phone', get: o => o.customer.phone },
    { label: 'Items', get: o => o.items.map(i => i.name + ' x' + i.qty).join('; ') },
    { label: 'Subtotal', get: o => o.subtotal },
    { label: 'Discount', get: o => o.discount || 0 },
    { label: 'Coupon', get: o => o.couponCode || '' },
    { label: 'Shipping', get: o => o.shipping || 0 },
    { label: 'Total', get: o => o.total },
    { label: 'Payment', get: o => (o.payment && o.payment.method) + '/' + (o.payment && o.payment.status) },
    { label: 'Address', get: o => [o.address.line1, o.address.line2, o.address.city, o.address.state, o.address.pincode].filter(Boolean).join(', ') },
    { label: 'Latitude', get: o => o.location ? o.location.lat : '' },
    { label: 'Longitude', get: o => o.location ? o.location.lng : '' },
    { label: 'Delivered At', get: o => o.deliveredAt ? new Date(o.deliveredAt).toLocaleString('en-IN') : '' },
  ]);
}

function customersCSV() {
  return toCSV(db.customers.all(), [
    { label: 'Name', get: c => c.name },
    { label: 'Email', get: c => c.email },
    { label: 'Phone', get: c => c.phone },
    { label: 'Orders', get: c => c.orderCount || 0 },
    { label: 'Total Spent', get: c => c.totalSpent || 0 },
    { label: 'First Order', get: c => c.firstOrderAt ? new Date(c.firstOrderAt).toLocaleDateString('en-IN') : '' },
    { label: 'Last Order', get: c => c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString('en-IN') : '' },
    { label: 'City', get: c => (c.lastAddress && c.lastAddress.city) || '' },
  ]);
}

function productsCSV() {
  const analytics = {};
  db.orders.all().forEach(o => o.items.forEach(i => {
    if (!analytics[i.id]) analytics[i.id] = { units: 0, revenue: 0 };
    analytics[i.id].units += i.qty;
    analytics[i.id].revenue += i.price * i.qty;
  }));
  return toCSV(db.products.all(), [
    { label: 'SKU', get: p => p.sku || p.id },
    { label: 'Name', get: p => p.name },
    { label: 'Category', get: p => p.category || '' },
    { label: 'Price', get: p => p.price },
    { label: 'MRP', get: p => p.mrp || '' },
    { label: 'Stock', get: p => p.stock == null ? '' : p.stock },
    { label: 'Status', get: p => p.active === false ? 'inactive' : (p.upcoming ? 'upcoming' : 'live') },
    { label: 'Units Sold', get: p => (analytics[p.id] || {}).units || 0 },
    { label: 'Revenue', get: p => (analytics[p.id] || {}).revenue || 0 },
  ]);
}

function applyDateFilter(orders, filters) {
  filters = filters || {};
  if (filters.from) orders = orders.filter(o => new Date(o.createdAt) >= new Date(filters.from));
  if (filters.to) orders = orders.filter(o => new Date(o.createdAt) <= new Date(filters.to + 'T23:59:59'));
  return orders;
}

// Sales report — one row per order, focused on money and fulfilment.
function salesCSV(filters) {
  let orders = applyDateFilter(db.orders.all(), filters)
    .filter(o => o.status !== 'cancelled')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return toCSV(orders, [
    { label: 'Order ID', get: o => o.orderId },
    { label: 'Date', get: o => new Date(o.createdAt).toLocaleDateString('en-IN') },
    { label: 'Time', get: o => new Date(o.createdAt).toLocaleTimeString('en-IN') },
    { label: 'Customer', get: o => o.customer.name },
    { label: 'Items', get: o => o.items.reduce((s, i) => s + i.qty, 0) },
    { label: 'Subtotal', get: o => o.subtotal },
    { label: 'Discount', get: o => o.discount || 0 },
    { label: 'Coupon', get: o => o.couponCode || '' },
    { label: 'Shipping', get: o => o.shipping || 0 },
    { label: 'Total', get: o => o.total },
    { label: 'Payment Method', get: o => (o.payment && o.payment.method) || '' },
    { label: 'Payment Status', get: o => (o.payment && o.payment.status) || '' },
    { label: 'Payment ID', get: o => (o.payment && o.payment.paymentId) || '' },
    { label: 'Order Status', get: o => o.status },
  ]);
}

// Deliveries report — one row per order, focused on address, location and agent.
function deliveriesCSV(filters) {
  let orders = applyDateFilter(db.orders.all(), filters)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return toCSV(orders, [
    { label: 'Order ID', get: o => o.orderId },
    { label: 'Date', get: o => new Date(o.createdAt).toLocaleDateString('en-IN') },
    { label: 'Status', get: o => o.status },
    { label: 'Customer', get: o => o.customer.name },
    { label: 'Phone', get: o => o.customer.phone },
    { label: 'Door / Flat', get: o => (o.address && o.address.doorNo) || '' },
    { label: 'Address', get: o => [o.address.line1, o.address.line2].filter(Boolean).join(', ') },
    { label: 'Landmark', get: o => (o.address && o.address.landmark) || '' },
    { label: 'City', get: o => (o.address && o.address.city) || '' },
    { label: 'State', get: o => (o.address && o.address.state) || '' },
    { label: 'Pincode', get: o => (o.address && o.address.pincode) || '' },
    { label: 'Latitude', get: o => o.location ? o.location.lat : '' },
    { label: 'Longitude', get: o => o.location ? o.location.lng : '' },
    { label: 'Map Link', get: o => o.location ? ('https://www.google.com/maps?q=' + o.location.lat + ',' + o.location.lng) : '' },
    { label: 'Assigned Agent', get: o => (o.assignedTo && o.assignedTo.name) || '' },
    { label: 'Agent Phone', get: o => (o.assignedTo && o.assignedTo.phone) || '' },
    { label: 'Delivered At', get: o => o.deliveredAt ? new Date(o.deliveredAt).toLocaleString('en-IN') : '' },
  ]);
}

module.exports = { dashboard, analytics, ordersCSV, customersCSV, productsCSV, salesCSV, deliveriesCSV, slimOrder };
