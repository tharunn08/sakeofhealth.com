#!/usr/bin/env node
/**
 * Shop (B2C) performance at realistic volumes — PERFORMANCE TESTING ONLY, in a throw-away folder.
 * The shop keeps its data in JSON files that are read from disk on every request (so two processes never
 * disagree) and rewritten atomically on every change. This measures what that costs as orders grow.
 *
 *   node scripts/perf-b2c.js [orders...]      e.g. node scripts/perf-b2c.js 1000 10000 30000
 *
 * For each volume: real orders are placed through the API first (their exact shape), then copied with new
 * ids, dates and customers up to the volume; the server is restarted on that data and each endpoint is
 * called 30 times sequentially and 60 times with 10 at once. Prints a table (p50 / p95 ms) and writes
 * perf-b2c-<time>.json. Never touches real data (refuses a DATA_DIR that is set in the environment).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const VOLUMES = process.argv.slice(2).map(Number).filter(function (n) { return n > 0; });
if (!VOLUMES.length) VOLUMES.push(1000, 10000, 30000);

const ENV = { NODE_ENV: 'test', PAYMENT_MOCK: 'true', AUTO_SEED: 'true', ADMIN_EMAIL: 'perf@test.local', ADMIN_PASSWORD: 'Perf-Test-12345',
  ADMIN_JWT_SECRET: 'perf-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz', CUSTOMER_JWT_SECRET: 'perf-customer-secret-0123456789-abcdefghijklmnopq',
  SMTP_HOST: '', WHATSAPP_TOKEN: '', RAZORPAY_KEY_ID: '', B2B_ENABLED: 'false', ERP_ENABLED: 'false' };

function freePort() { return new Promise(function (res) { const s = net.createServer(); s.listen(0, '127.0.0.1', function () { const p = s.address().port; s.close(function () { res(p); }); }); }); }
async function start(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['index.js'], { cwd: ROOT, env: Object.assign({}, process.env, ENV, { PORT: String(port), DATA_DIR: dataDir, CATALOGUE_DIR: path.join(dataDir, '.cat'), BACKUP_DIR: path.join(dataDir, '.bak') }), stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 200; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch (e) { /* starting */ } await new Promise(function (r) { setTimeout(r, 100); }); }
  return { base: base, stop: function () { return new Promise(function (r) { child.once('exit', r); child.kill('SIGTERM'); }); } };
}
let visitor = 0;
/** Each request comes from its own simulated visitor (X-Forwarded-For; the app trusts one proxy hop, as behind
 *  Hostinger's), so the per-visitor rate limits do not turn the measurement into a measurement of 429s. */
async function call(base, method, url, body, token) {
  visitor++;
  const ip = '10.' + ((visitor >> 16) & 255) + '.' + ((visitor >> 8) & 255) + '.' + (visitor & 255);
  const t = process.hrtime.bigint();
  const r = await fetch(base + url, { method: method, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  const buf = await r.arrayBuffer();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, status: r.status, bytes: buf.byteLength, json: function () { return JSON.parse(Buffer.from(buf).toString('utf8')); } };
}
const pct = function (a, p) { const s = a.slice().sort(function (x, y) { return x - y; }); return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] * 10) / 10; };

function order(i, live) {
  const p = live[i % live.length];
  return { items: [{ id: p.id, qty: 1 + (i % 3) }], customer: { name: 'Perf Customer ' + i, email: 'perf' + i + '@test.local', phone: '9' + String(800000000 + i).slice(-9) },
    address: { line1: (i % 90 + 1) + ' MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '5600' + String(10 + (i % 80)).padStart(2, '0') } };
}

async function measureVolume(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-perf-b2c-'));
  // 1. real orders through the API: their exact shape
  let s = await start(dir);
  const live = (await call(s.base, 'GET', '/api/shop/products')).json().products.filter(function (p) { return !p.upcoming; });
  for (let i = 0; i < 20; i++) { const r = await call(s.base, 'POST', '/api/shop/orders', order(i, live)); if (r.status !== 200 && r.status !== 201) throw new Error('order failed ' + r.status); }
  await s.stop();
  // 2. copy them up to n orders and n×0.6 customers (dates spread over 18 months)
  const orders = JSON.parse(fs.readFileSync(path.join(dir, 'orders.json'), 'utf8'));
  const customers = JSON.parse(fs.readFileSync(path.join(dir, 'customers.json'), 'utf8'));
  const outOrders = [], outCustomers = [];
  const now = Date.now(), span = 540 * 86400000;
  for (let i = 0; i < n; i++) {
    const src = orders[i % orders.length];
    const c = i % Math.max(1, Math.round(n * 0.6));
    const o = JSON.parse(JSON.stringify(src));
    o.id = 'perf-' + i; o.orderId = 'SOH' + String(100000 + i);
    o.createdAt = new Date(now - Math.floor((i / n) * span)).toISOString();
    if (o.customer) { o.customer.name = 'Perf Customer ' + c; o.customer.email = 'perf' + c + '@test.local'; o.customer.phone = '9' + String(800000000 + c).slice(-9); }
    o.status = ['placed', 'confirmed', 'dispatched', 'delivered', 'delivered', 'delivered'][i % 6];
    outOrders.push(o);
  }
  for (let c = 0; c < Math.round(n * 0.6); c++) {
    const src = customers[c % customers.length] || {};
    outCustomers.push(Object.assign({}, src, { id: 'perfc-' + c, name: 'Perf Customer ' + c, email: 'perf' + c + '@test.local', phone: '9' + String(800000000 + c).slice(-9), orderCount: 1 + (c % 4), totalSpent: 600 * (1 + (c % 4)), lastOrderAt: new Date(now - c * 60000).toISOString() }));
  }
  fs.writeFileSync(path.join(dir, 'orders.json'), JSON.stringify(outOrders, null, 2));
  fs.writeFileSync(path.join(dir, 'customers.json'), JSON.stringify(outCustomers, null, 2));
  const sizes = { ordersMB: Math.round(fs.statSync(path.join(dir, 'orders.json')).size / 1e5) / 10, customersMB: Math.round(fs.statSync(path.join(dir, 'customers.json')).size / 1e5) / 10 };
  // 3. measure
  s = await start(dir);
  const token = (await call(s.base, 'POST', '/api/admin/login', { email: ENV.ADMIN_EMAIL, password: ENV.ADMIN_PASSWORD })).json().token;
  const endpoints = [
    ['shop: product list', 'GET', '/api/shop/products'],
    ['shop: product page', 'GET', '/api/shop/products/' + encodeURIComponent(live[0].slug || live[0].id)],
    ['shop: track an order', 'POST', '/api/shop/track', false, { orderId: outOrders[Math.floor(n / 2)].orderId, phone: outOrders[Math.floor(n / 2)].customer.phone }],
    ['admin: orders, page 1', 'GET', '/api/admin/orders?page=1&limit=25', true],
    ['admin: orders, search', 'GET', '/api/admin/orders?search=perf123', true],
    ['admin: customers (all)', 'GET', '/api/admin/customers', true],
    ['admin: dashboard', 'GET', '/api/admin/dashboard', true],
    ['admin: analytics', 'GET', '/api/admin/analytics', true],
  ];
  const results = [];
  for (const e of endpoints) {
    const seq = [];
    let status = null, bytes = 0;
    for (let i = 0; i < 30; i++) { const r = await call(s.base, e[1], e[2], e[4] || null, e[3] ? token : null); seq.push(r.ms); status = r.status; bytes = r.bytes; }
    const conc = [];
    for (let round = 0; round < 6; round++) {
      const rs = await Promise.all(Array.from({ length: 10 }, function () { return call(s.base, e[1], e[2], e[4] || null, e[3] ? token : null); }));
      rs.forEach(function (r) { conc.push(r.ms); });
    }
    results.push({ endpoint: e[0], status: status, kb: Math.round(bytes / 102.4) / 10, p50: pct(seq, 50), p95: pct(seq, 95), conc10_p50: pct(conc, 50), conc10_p95: pct(conc, 95) });
  }
  // the write path: placing an order rewrites orders.json
  const w = [];
  for (let i = 0; i < 15; i++) { const r = await call(s.base, 'POST', '/api/shop/orders', order(n + i, live)); if (r.status >= 300) throw new Error('order at volume failed ' + r.status); w.push(r.ms); }
  results.push({ endpoint: 'shop: place an order (write)', status: 200, kb: 0, p50: pct(w, 50), p95: pct(w, 95), conc10_p50: null, conc10_p95: null });
  await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  return { orders: n, customers: Math.round(n * 0.6), sizes: sizes, results: results };
}

(async function () {
  const all = [];
  for (const n of VOLUMES) {
    process.stdout.write('measuring ' + n + ' orders … ');
    const r = await measureVolume(n);
    console.log('orders.json ' + r.sizes.ordersMB + ' MB, customers.json ' + r.sizes.customersMB + ' MB');
    r.results.forEach(function (x) { console.log('  ' + x.endpoint.padEnd(32) + ' ' + String(x.p50).padStart(7) + ' / ' + String(x.p95).padStart(7) + ' ms   10 at once: ' + (x.conc10_p50 == null ? '—' : x.conc10_p50 + ' / ' + x.conc10_p95 + ' ms') + '   ' + x.kb + ' kB  [' + x.status + ']'); });
    all.push(r);
  }
  const file = path.join(process.cwd(), 'perf-b2c-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify({ node: process.version, cpus: os.cpus().length, cpu: os.cpus()[0] && os.cpus()[0].model, measuredAt: new Date().toISOString(), volumes: all }, null, 1));
  console.log('written ' + file);
})().catch(function (e) { console.error(e); process.exit(1); });
