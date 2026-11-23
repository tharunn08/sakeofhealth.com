/**
 * Notification recipients (N2). Only business recipients and ERP staff: shop customers are
 * not included (owner decision D1) and the shop's staff.json is never read (D9).
 *
 *   retailer / distributor   approved b2b_accounts of that type (account email + mobile)
 *   salesman                 active ERP staff with an active b2b_salesmen row
 *   supplier / manufacturer  approved vendors with that approved capability; contact = first active vendor user
 *   staff                    active ERP staff (b2b_staff)
 *
 * A recipient is "eligible" when active; each channel also needs its address. Contacts are
 * masked unless the caller may see them (notifications.contacts.view).
 */
'use strict';
const db = require('../../../db/connection.js');

const TYPES = ['retailer', 'distributor', 'salesman', 'supplier', 'manufacturer', 'staff'];
const AUDIENCE = { retailer: 'trade', distributor: 'trade', salesman: 'salesmen', supplier: 'vendors', manufacturer: 'vendors', staff: 'staff',
  address: 'staff' };   // 'address': a plain address on an automatic message (the administrators' alert emails, N5); never offered in the picker
const CAPABILITY = { manufacturer: ['manufacturer', 'contract_manufacturer'], supplier: ['supplier_wholesaler', 'authorised_distributor'] };

function maskEmail(e) {
  if (!e) return null;
  const at = String(e).indexOf('@');
  if (at < 1) return '•••';
  return e[0] + '•••' + e.slice(at);
}
function maskMobile(m) {
  const d = String(m || '').replace(/\D/g, '');
  if (d.length < 6) return d ? '•••' : null;
  return d.slice(0, 2) + '•'.repeat(Math.max(3, d.length - 5)) + d.slice(-3);
}
const validEmail = function (e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); };
const validMobile = function (m) { return String(m || '').replace(/\D/g, '').length >= 10; };

/** SQL for one recipient type: id, name, email, mobile, active (1/0). */
function source(type) {
  if (type === 'retailer' || type === 'distributor') {
    return { sql: "SELECT a.id, COALESCE(a.business_name, a.shop_name) AS name, a.email, a.mobile, (a.status = 'approved') AS active FROM b2b_accounts a WHERE a.account_type = '" + type + "'", search: ['a.business_name', 'a.shop_name', 'a.email', 'a.mobile'], idCol: 'a.id' };
  }
  if (type === 'salesman') {
    return { sql: "SELECT st.id, st.name, st.email, st.mobile, (st.status = 'active' AND sm.is_active = 1) AS active FROM b2b_staff st JOIN b2b_salesmen sm ON sm.staff_id = st.id WHERE 1=1", search: ['st.name', 'st.email', 'st.mobile'], idCol: 'st.id' };
  }
  if (type === 'staff') {
    return { sql: "SELECT st.id, st.name, st.email, st.mobile, (st.status = 'active') AS active FROM b2b_staff st WHERE 1=1", search: ['st.name', 'st.email', 'st.mobile'], idCol: 'st.id' };
  }
  if (type === 'supplier' || type === 'manufacturer') {
    const caps = CAPABILITY[type].map(function (c) { return "'" + c + "'"; }).join(', ');
    return {
      sql: 'SELECT v.id, COALESCE(v.trade_name, v.legal_name) AS name, ' +
        "(SELECT u.email FROM b2b_vendor_users u WHERE u.vendor_id = v.id AND u.status = 'active' ORDER BY u.id LIMIT 1) AS email, " +
        "(SELECT u.mobile FROM b2b_vendor_users u WHERE u.vendor_id = v.id AND u.status = 'active' ORDER BY u.id LIMIT 1) AS mobile, " +
        "(v.status = 'approved') AS active FROM b2b_vendors v WHERE EXISTS (SELECT 1 FROM b2b_vendor_capabilities c WHERE c.vendor_id = v.id AND c.status = 'approved' AND c.capability IN (" + caps + '))',
      search: ['v.legal_name', 'v.trade_name'], idCol: 'v.id',
    };
  }
  throw Object.assign(new Error('Unknown recipient type ' + type), { status: 400, expose: true });
}

function shape(type, r, showContacts) {
  return {
    type: type, ref: Number(r.id), name: r.name || '(no name)',
    email: showContacts ? (r.email || null) : maskEmail(r.email), mobile: showContacts ? (r.mobile || null) : maskMobile(r.mobile),
    active: Number(r.active) === 1, hasEmail: validEmail(r.email), hasMobile: validMobile(r.mobile),
  };
}

/** Search one type (for the picker). Only active recipients are offered. */
async function search(type, q, showContacts, limit) {
  const s = source(type), params = [];
  let sql = s.sql;
  if (q) { sql += ' AND (' + s.search.map(function (c) { params.push('%' + String(q).slice(0, 60) + '%'); return c + ' LIKE ?'; }).join(' OR ') + ')'; }
  sql = 'SELECT * FROM (' + sql + ') x WHERE x.active = 1 ORDER BY x.name LIMIT ' + db.int(limit, 50, 1, 500);
  const rows = await db.query(sql, params);
  return rows.map(function (r) { return shape(type, r, showContacts); });
}

/** Every active recipient of a type (for "all retailers" style selection), capped. */
async function all(type, cap) { return search(type, null, true, cap); }

/** Full, current details of chosen recipients (contacts unmasked: used for sending). */
async function resolve(list) {
  const out = [];
  const byType = {};
  list.forEach(function (x) { if (TYPES.indexOf(x.type) === -1) throw Object.assign(new Error('Unknown recipient type ' + x.type), { status: 400, expose: true }); (byType[x.type] = byType[x.type] || []).push(Number(x.ref)); });
  for (const type of Object.keys(byType)) {
    const ids = byType[type].filter(function (n) { return Number.isInteger(n) && n > 0; });
    if (!ids.length) continue;
    const s = source(type);
    const rows = await db.query('SELECT * FROM (' + s.sql + ' AND ' + s.idCol + ' IN (' + db.placeholders(ids) + ')) x', ids);
    rows.forEach(function (r) { out.push(shape(type, r, true)); });
  }
  return out;
}

module.exports = { TYPES, AUDIENCE, search, all, resolve, maskEmail, maskMobile, validEmail, validMobile };
