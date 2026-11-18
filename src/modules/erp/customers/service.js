/**
 * Unified customers (N4). One record per person across the online shop, event counters, field
 * sales and business accounts, matched on a normalised email or Indian mobile. Logins stay where
 * they are: shop customers keep signing in to the shop exactly as before (nobody registers again),
 * and the shop's files are only read (through readonly-adapter.js), never written.
 *
 * Matching: an existing link wins; then the email; then the mobile. When the email points to one
 * record and the mobile to another, the email wins and the link is flagged for review — records
 * are never merged automatically.
 */
'use strict';
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const directory = require('../notifications/directory.js');
const { fail, posId } = require('../lib/http.js');

const SOURCES = ['b2c_customer', 'b2c_login', 'b2b_account', 'event_sale', 'field_retailer'];
function normEmail(e) { const s = String(e == null ? '' : e).trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.slice(0, 190) : null; }
function normMobile(m) { const d = String(m == null ? '' : m).replace(/\D/g, ''); return d.length >= 10 ? '91' + d.slice(-10) : null; }
function sqlTime(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19).replace('T', ' ') : null; }

/**
 * Link a source record to a customer, creating the customer when nobody matches.
 * who = { name, email, mobile, seenAt }. Returns { customerId, created, review } or null when
 * there is nothing to match on (a walk-in with no contact details).
 */
async function link(tx, who, source, sourceRef) {
  if (SOURCES.indexOf(source) === -1) throw new Error('Unknown customer source ' + source);
  const ref = String(sourceRef).slice(0, 64);
  const em = normEmail(who.email), mo = normMobile(who.mobile), seen = sqlTime(who.seenAt) || sqlTime(new Date().toISOString());
  const have = await tx.queryOne('SELECT customer_id FROM b2b_customer_links WHERE source = ? AND source_ref = ?', [source, ref]);
  if (have) { await touch(tx, Number(have.customer_id), who, em, mo, seen); return { customerId: Number(have.customer_id), created: false, review: false, existing: true }; }
  if (!em && !mo) return null;
  const byEmail = em ? await tx.queryOne('SELECT id FROM b2b_customers WHERE email_norm = ? FOR UPDATE', [em]) : null;
  const byMobile = mo ? await tx.queryOne('SELECT id FROM b2b_customers WHERE mobile_norm = ? FOR UPDATE', [mo]) : null;
  let id, rule, review = false, note = null, created = false;
  if (byEmail && byMobile && Number(byEmail.id) !== Number(byMobile.id)) {
    id = Number(byEmail.id); rule = 'email'; review = true; note = 'Mobile also belongs to customer #' + byMobile.id;
  } else if (byEmail) { id = Number(byEmail.id); rule = 'email'; }
  else if (byMobile) { id = Number(byMobile.id); rule = 'mobile'; }
  else {
    try {
      const r = await tx.query('INSERT INTO b2b_customers (display_name, email, email_norm, mobile, mobile_norm, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [who.name ? String(who.name).slice(0, 160) : null, em ? String(who.email).trim().slice(0, 190) : null, em, mo ? String(who.mobile).slice(0, 15) : null, mo, seen, seen]);
      id = Number(r.insertId); rule = 'new'; created = true;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;   // another request created them a moment ago
      return link(tx, who, source, sourceRef);
    }
  }
  if (!created) await touch(tx, id, who, em, mo, seen);
  await tx.query('INSERT IGNORE INTO b2b_customer_links (customer_id, source, source_ref, match_rule, review, review_note) VALUES (?, ?, ?, ?, ?, ?)', [id, source, ref, rule, review ? 1 : 0, note]);
  return { customerId: id, created: created, review: review };
}

/** Fill in a missing email/mobile/name when nobody else holds it; keep first/last seen. */
async function touch(tx, id, who, em, mo, seen) {
  const c = await tx.queryOne('SELECT display_name, email_norm, mobile_norm, first_seen_at, last_seen_at FROM b2b_customers WHERE id = ? FOR UPDATE', [id]);
  if (!c) return;
  const sets = [], args = [];
  if (!c.display_name && who.name) { sets.push('display_name = ?'); args.push(String(who.name).slice(0, 160)); }
  if (!c.email_norm && em && !(await tx.queryOne('SELECT id FROM b2b_customers WHERE email_norm = ?', [em]))) { sets.push('email = ?, email_norm = ?'); args.push(String(who.email).trim().slice(0, 190), em); }
  if (!c.mobile_norm && mo && !(await tx.queryOne('SELECT id FROM b2b_customers WHERE mobile_norm = ?', [mo]))) { sets.push('mobile = ?, mobile_norm = ?'); args.push(String(who.mobile).slice(0, 15), mo); }
  if (seen && (!c.first_seen_at || seen < sqlTime(c.first_seen_at))) { sets.push('first_seen_at = ?'); args.push(seen); }
  if (seen && (!c.last_seen_at || seen > sqlTime(c.last_seen_at))) { sets.push('last_seen_at = ?'); args.push(seen); }
  if (sets.length) { args.push(id); await tx.query('UPDATE b2b_customers SET ' + sets.join(', ') + ' WHERE id = ?', args); }
}

/** Record (or refresh) one order in the customer's cross-channel history. */
async function recordOrder(tx, customerId, o) {
  await tx.query('INSERT INTO b2b_customer_orders (customer_id, channel, source_order_id, order_no, status, total, item_count, ordered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE status = VALUES(status), total = VALUES(total), item_count = VALUES(item_count)',
    [customerId, o.channel, String(o.sourceOrderId).slice(0, 64), o.orderNo ? String(o.orderNo).slice(0, 40) : null, o.status ? String(o.status).slice(0, 30) : null,
      o.total == null ? null : Number(o.total), o.itemCount == null ? null : Number(o.itemCount), sqlTime(o.orderedAt)]);
}

/**
 * Bring the shop's customers, logins and orders in (read-only). Idempotent: links and order rows
 * are keyed by the shop's own ids. shop = { customers, accounts, orders } as read by the adapter.
 */
async function importShop(shop) {
  let linked = 0, created = 0, review = 0, orders = 0, skipped = 0;
  const one = async function (who, source, ref) {
    const r = await db.transaction(function (tx) { return link(tx, who, source, ref); });
    if (!r) { skipped++; return null; }
    if (!r.existing) { linked++; if (r.created) created++; if (r.review) review++; }
    return r.customerId;
  };
  for (const c of shop.customers || []) { if (c && c.id) await one({ name: c.name, email: c.email, mobile: c.phone, seenAt: c.firstOrderAt || c.createdAt }, 'b2c_customer', c.id); }
  for (const a of shop.accounts || []) { if (a && a.id) await one({ name: a.name, email: a.email, seenAt: a.createdAt }, 'b2c_login', a.id); }
  for (const o of shop.orders || []) {
    const oid = o && (o.id || o._id); if (!oid || !o.customer) continue;
    const cid = await one({ name: o.customer.name, email: o.customer.email, mobile: o.customer.phone, seenAt: o.createdAt }, 'b2c_customer', 'order:' + oid);
    if (!cid) continue;
    await db.transaction(function (tx) {
      return recordOrder(tx, cid, { channel: 'b2c', sourceOrderId: oid, orderNo: o.orderId, status: o.status, total: o.total, itemCount: Array.isArray(o.items) ? o.items.length : null, orderedAt: o.createdAt });
    });
    orders++;
  }
  return { linked: linked, created: created, review: review, orders: orders, skipped: skipped };
}

/** Business accounts (retailers/distributors) as customers too, so one person is one record. */
async function importAccounts() {
  let linked = 0;
  const rows = await db.query("SELECT id, business_name, email, mobile, created_at FROM b2b_accounts WHERE account_type IN ('retailer','distributor')");
  for (const a of rows) {
    const r = await db.transaction(function (tx) { return link(tx, { name: a.business_name, email: a.email, mobile: a.mobile, seenAt: a.created_at }, 'b2b_account', a.id); });
    if (r && !r.existing) linked++;
  }
  return { linked: linked };
}

/**
 * Everything at once (staff button, or the daily job when customers.import.enabled is set): the
 * shop's customers, logins and orders through the read-only adapter, then the business accounts.
 * Only names, emails, mobiles and order summaries are taken; login passwords are never read
 * out of the shop's records. Safe to repeat: every link is keyed by the shop's own ids.
 */
async function importAll() {
  const adapter = require('../b2cfeed/readonly-adapter.js');
  const pickC = function (c) { return c && { id: c.id, name: c.name, email: c.email, phone: c.phone, firstOrderAt: c.firstOrderAt, createdAt: c.createdAt }; };
  const pickA = function (a) { return a && { id: a.id, name: a.name, email: a.email, createdAt: a.createdAt }; };
  const pickO = function (o) { return o && { id: o.id, _id: o._id, orderId: o.orderId, status: o.status, total: o.total, items: Array.isArray(o.items) ? o.items.map(function () { return 1; }) : null, createdAt: o.createdAt,
    customer: o.customer ? { name: o.customer.name, email: o.customer.email, phone: o.customer.phone } : null }; };
  const c = adapter.readShop('customers'), a = adapter.readShop('accounts'), o = adapter.readShopOrders();
  const shop = await importShop({ customers: c.items.map(pickC), accounts: a.items.map(pickA), orders: o.orders.map(pickO) });
  const acc = await importAccounts();
  return Object.assign(shop, { accounts: acc.linked, unreadable: [c, a].filter(function (x) { return !x.ok; }).map(function (x) { return x.reason; }).concat(o.ok ? [] : [o.reason]) });
}

function canSee(principal) { return principal.permissions.has('customers.contacts.view'); }
function view(principal, c) {
  const see = canSee(principal);
  return { id: Number(c.id), name: c.display_name, email: see ? c.email : directory.maskEmail(c.email), mobile: see ? c.mobile : directory.maskMobile(c.mobile),
    firstSeenAt: c.first_seen_at, lastSeenAt: c.last_seen_at };
}

async function list(principal, q) {
  const where = [], args = [];
  if (q.q) {
    const t = String(q.q).trim().slice(0, 80);
    const em = normEmail(t), mo = normMobile(t);
    // contacts are searched exactly (no partial matching on someone's email or mobile without the right to see them)
    if (em) { where.push('c.email_norm = ?'); args.push(em); }
    else if (mo && /^[\d\s+-]{10,}$/.test(t)) { where.push('c.mobile_norm = ?'); args.push(mo); }
    else { where.push('c.display_name LIKE ?'); args.push('%' + t + '%'); }
  }
  if (q.channel && ['b2c', 'event', 'b2b', 'field'].indexOf(q.channel) !== -1) { where.push('EXISTS (SELECT 1 FROM b2b_customer_orders o WHERE o.customer_id = c.id AND o.channel = ?)'); args.push(q.channel); }
  if (q.review === '1') where.push('EXISTS (SELECT 1 FROM b2b_customer_links l WHERE l.customer_id = c.id AND l.review = 1)');
  const page = db.int(q.page, 1, 1, 100000), size = 50;
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_customers c' + w, args);
  const rows = await db.query('SELECT c.*, (SELECT COUNT(*) FROM b2b_customer_orders o WHERE o.customer_id = c.id) AS orders, ' +
    '(SELECT COALESCE(SUM(o.total), 0) FROM b2b_customer_orders o WHERE o.customer_id = c.id AND (o.status IS NULL OR o.status NOT IN (\'cancelled\',\'voided\',\'refunded\'))) AS spent, ' +
    '(SELECT GROUP_CONCAT(DISTINCT l.source) FROM b2b_customer_links l WHERE l.customer_id = c.id) AS sources, ' +
    '(SELECT MAX(l.review) FROM b2b_customer_links l WHERE l.customer_id = c.id) AS review FROM b2b_customers c' + w +
    ' ORDER BY c.last_seen_at DESC, c.id DESC LIMIT ' + size + ' OFFSET ' + ((page - 1) * size), args);
  return { total: Number(total.n), page: page, size: size, items: rows.map(function (r) {
    return Object.assign(view(principal, r), { orders: Number(r.orders), spent: Number(r.spent), sources: r.sources ? String(r.sources).split(',') : [], review: Number(r.review) === 1 });
  }) };
}

async function detail(principal, id) {
  const c = await db.queryOne('SELECT * FROM b2b_customers WHERE id = ?', [posId(id)]);
  if (!c) throw fail(404, 'Customer not found');
  const links = await db.query('SELECT id, source, source_ref, match_rule, review, review_note, linked_at FROM b2b_customer_links WHERE customer_id = ? ORDER BY id', [c.id]);
  const orders = await db.query('SELECT channel, source_order_id, order_no, status, total, item_count, ordered_at FROM b2b_customer_orders WHERE customer_id = ? ORDER BY ordered_at DESC LIMIT 500', [c.id]);
  return { customer: view(principal, c),
    links: links.map(function (l) { return { id: Number(l.id), source: l.source, ref: l.source_ref, rule: l.match_rule, review: Number(l.review) === 1, note: l.review_note, linkedAt: l.linked_at }; }),
    orders: orders.map(function (o) { return { channel: o.channel, id: o.source_order_id, orderNo: o.order_no, status: o.status, total: o.total == null ? null : Number(o.total), items: o.item_count, at: o.ordered_at }; }) };
}

/** Staff confirm a flagged link, or move it to another customer (audited). */
async function resolveLink(tx, actor, linkId, b) {
  const l = await tx.queryOne('SELECT * FROM b2b_customer_links WHERE id = ? FOR UPDATE', [posId(linkId)]);
  if (!l) throw fail(404, 'Link not found');
  const note = String(b.note || '').trim();
  if (note.length < 5) throw fail(400, 'Say why (at least 5 characters)', 'reason_required');
  let to = Number(l.customer_id);
  if (b.moveTo != null) {
    to = posId(b.moveTo);
    if (!to || !(await tx.queryOne('SELECT id FROM b2b_customers WHERE id = ?', [to]))) throw fail(400, 'Unknown customer to move to');
    await tx.query('UPDATE b2b_customer_links SET customer_id = ?, match_rule = \'manual\', review = 0, review_note = ? WHERE id = ?', [to, note.slice(0, 255), l.id]);
    if (/^order:/.test(l.source_ref)) await tx.query("UPDATE b2b_customer_orders SET customer_id = ? WHERE channel = 'b2c' AND source_order_id = ?", [to, l.source_ref.slice(6)]);
  } else {
    await tx.query('UPDATE b2b_customer_links SET review = 0, review_note = ? WHERE id = ?', [note.slice(0, 255), l.id]);
  }
  await audit.write(tx, actor, { module: 'customers', action: b.moveTo != null ? 'customer.link_moved' : 'customer.link_confirmed', entity: 'customer_link', entityId: l.id,
    old: { customerId: Number(l.customer_id) }, new: { customerId: to }, reason: note });
  return { linkId: Number(l.id), customerId: to };
}

module.exports = { link, recordOrder, importShop, importAccounts, importAll, list, detail, resolveLink, normEmail, normMobile, SOURCES };
