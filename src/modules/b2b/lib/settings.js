/**
 * Database-backed settings with code defaults and a short cache.
 * Nothing about pricing, GST or the seller is hardcoded elsewhere.
 */
const db = require('../../../db/connection.js');

const DEFAULTS = {
  // Pricing
  'pricing.default_distributor_margin': '12.000',
  'pricing.default_retailer_margin': '18.000',
  // markup_on_base: price = base price × (1 + margin%)   |   off_mrp: price = (MRP ex-GST) × (1 − margin%)
  'pricing.margin_mode': 'markup_on_base',

  // Orders
  'orders.first_order_approval': true,
  'orders.buyer_cancel_until': 'assigned',          // buyers can cancel up to and including this status
  'orders.min_order_value': '0.00',
  'orders.require_payment_before_dispatch': false,  // non-credit orders must be paid before they can be dispatched
  'returns.window_days': 7,                         // 0 = no limit
  'inventory.track_distributor_stock': false,
  'invoice.generate_on': 'dispatched',              // or 'delivered'
  'invoice.prefix': 'SOH',
  'credit.default_days': 15,

  // Seller (the company) — printed on invoices and labels
  'company.legal_name': 'Ixitek Healthcare and Wellness Pvt. Ltd.',
  'company.brand_name': 'Sake of Health',
  'company.gstin': '',
  'company.pan': '',
  'company.address': '',
  'company.city': 'Bengaluru',
  'company.pincode': '',
  'company.state_gst_code': '29',
  'company.phone': '',
  'company.email': '',
  'company.bank_details': '',
  'company.invoice_footer': 'This is a computer generated invoice.',

  // Notifications
  'notify.admin_emails': '',
};

const TTL = 15000;
let cache = { at: 0, values: null };

async function load(force) {
  if (!force && cache.values && Date.now() - cache.at < TTL) return cache.values;
  const rows = await db.query('SELECT setting_key, setting_value FROM b2b_settings');
  const values = Object.assign({}, DEFAULTS);
  rows.forEach(function (r) {
    try { values[r.setting_key] = JSON.parse(r.setting_value); } catch (e) { values[r.setting_key] = r.setting_value; }
  });
  cache = { at: Date.now(), values: values };
  return values;
}

async function get(key) { return (await load())[key]; }
async function all() { return Object.assign({}, await load()); }

const VALIDATORS = {
  'pricing.default_distributor_margin': v => /^\d{1,3}(\.\d{1,3})?$/.test(String(v)) && Number(v) <= 500,
  'pricing.default_retailer_margin': v => /^\d{1,3}(\.\d{1,3})?$/.test(String(v)) && Number(v) <= 500,
  'pricing.margin_mode': v => ['markup_on_base', 'off_mrp'].includes(v),
  'orders.first_order_approval': v => typeof v === 'boolean',
  'orders.buyer_cancel_until': v => ['submitted', 'pending_admin_approval', 'approved', 'assigned', 'accepted'].includes(v),
  'orders.min_order_value': v => /^\d+(\.\d{1,2})?$/.test(String(v)),
  'inventory.track_distributor_stock': v => typeof v === 'boolean',
  'orders.require_payment_before_dispatch': v => typeof v === 'boolean',
  'returns.window_days': v => Number.isInteger(v) && v >= 0 && v <= 365,
  'invoice.generate_on': v => ['dispatched', 'delivered'].includes(v),
  'invoice.prefix': v => /^[A-Z0-9]{2,8}$/.test(String(v)),
  'credit.default_days': v => Number.isInteger(v) && v >= 0 && v <= 365,
  'company.state_gst_code': v => /^\d{2}$/.test(String(v)),
};

/** Save a set of keys. Returns { old, new } for the audit log. Unknown keys are rejected. */
async function setMany(patch, actorLabel) {
  const current = await load(true);
  const before = {}, after = {};
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULTS)) { const e = new Error('Unknown setting: ' + key); e.status = 400; e.expose = true; throw e; }
    let value = patch[key];
    if (typeof DEFAULTS[key] === 'string' && typeof value !== 'string') value = String(value == null ? '' : value);
    if (typeof value === 'string') value = value.trim().slice(0, 1000);
    if (VALIDATORS[key] && !VALIDATORS[key](value)) {
      const e = new Error('Invalid value for ' + key); e.status = 400; e.expose = true; throw e;
    }
    if (JSON.stringify(current[key]) === JSON.stringify(value)) continue;
    before[key] = current[key]; after[key] = value;
    await db.query(
      'INSERT INTO b2b_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
      [key, JSON.stringify(value), actorLabel || null]);
  }
  cache.at = 0;
  return { old: before, new: after };
}

function invalidate() { cache.at = 0; }

module.exports = { get, all, setMany, invalidate, DEFAULTS };
