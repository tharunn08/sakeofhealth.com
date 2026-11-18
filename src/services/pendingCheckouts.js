/**
 * Pending storefront checkouts (Phase 0.5.4–0.5.5).
 *
 * When a customer starts paying, the server-priced cart, contact details and
 * the Razorpay order id are recorded here. The order is later created ONLY
 * from this record — by the browser callback or, if that is lost, by the
 * Razorpay webhook — so the amount charged and the order total cannot differ.
 *
 * Stored in DATA_DIR/checkouts.json (a separate file; the protected db.js
 * collection list is unchanged). One order per checkout is enforced with an
 * exclusive lock file (DATA_DIR/checkout-locks/<gatewayOrderId>), which also
 * holds across several Node processes sharing the same DATA_DIR.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db } = require('./db.js');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data');
const FILE = path.join(DATA_DIR, 'checkouts.json');
const LOCKS = path.join(DATA_DIR, 'checkout-locks');
const KEEP_DAYS = 45;
const MAX_EVENTS = 5000;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { checkouts: d.checkouts || {}, events: Array.isArray(d.events) ? d.events : [] };
  } catch (e) {
    return { checkouts: {}, events: [] };
  }
}

function save(d) {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const k of Object.keys(d.checkouts)) {
    const c = d.checkouts[k];
    if (!c.orderId && new Date(c.createdAt).getTime() < cutoff) delete d.checkouts[k];
  }
  if (d.events.length > MAX_EVENTS) d.events = d.events.slice(-MAX_EVENTS);
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, FILE);
}

function put(rec) {
  const d = load();
  d.checkouts[rec.gatewayOrderId] = rec;
  save(d);
  return rec;
}

function get(gatewayOrderId) {
  return load().checkouts[gatewayOrderId] || null;
}

function update(gatewayOrderId, patch) {
  const d = load();
  if (!d.checkouts[gatewayOrderId]) return null;
  Object.assign(d.checkouts[gatewayOrderId], patch);
  save(d);
  return d.checkouts[gatewayOrderId];
}

function seenEvent(id) { return !!id && load().events.indexOf(id) !== -1; }
function markEvent(id) { if (!id) return; const d = load(); if (d.events.indexOf(id) === -1) { d.events.push(id); save(d); } }

function lockName(gatewayOrderId) { return path.join(LOCKS, String(gatewayOrderId).replace(/[^A-Za-z0-9_-]/g, '_')); }

/** true if this caller now owns the right to create the order for the checkout. */
function tryLock(gatewayOrderId) {
  fs.mkdirSync(LOCKS, { recursive: true });
  try { fs.closeSync(fs.openSync(lockName(gatewayOrderId), 'wx')); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}
function unlock(gatewayOrderId) { try { fs.unlinkSync(lockName(gatewayOrderId)); } catch (e) { /* already gone */ } }

/** An existing B2C order that already carries this gateway payment id. */
function orderWithPayment(paymentId) {
  return db.orders.all().find(o => o.payment && o.payment.paymentId === paymentId) || null;
}

module.exports = { get, put, update, seenEvent, markEvent, tryLock, unlock, orderWithPayment, FILE };
