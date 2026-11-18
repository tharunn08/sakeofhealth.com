/**
 * GST invoices and credit notes.
 *
 *  - Tax type comes from seller state vs buyer state (place of supply):
 *    same state → CGST + SGST, different state → IGST. No state is hardcoded.
 *  - Numbers are unique and gap-free per seller per financial year: the
 *    counter row is locked in the same transaction that inserts the invoice.
 *  - A finalised invoice is never edited. Corrections are made by a credit
 *    note (partial) or by cancelling with a full credit note and re-issuing.
 */
const db = require('../../../db/connection.js');
const money = require('../lib/money.js');
const settings = require('../lib/settings.js');
const v = require('../lib/validate.js');
const audit = require('../lib/audit.js');
const { bad, notFound, like } = require('../lib/http.js');

/* ─────────── Dates (India) ─────────── */

function istDate(d) {
  return new Date((d ? new Date(d).getTime() : Date.now()) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
/** Indian financial year (April–March) as '2627' for FY 2026-27. */
function financialYear(isoDate) {
  const y = Number(isoDate.slice(0, 4)), m = Number(isoDate.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return String(start).slice(2) + String(start + 1).slice(2);
}
function addDays(isoDate, days) {
  return new Date(new Date(isoDate + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);
}

/* ─────────── Sequences ─────────── */

async function nextNumber(tx, key) {
  await tx.query('INSERT IGNORE INTO b2b_sequences (seq_key, next_val) VALUES (?, 1)', [key]);
  const row = await tx.queryOne('SELECT next_val FROM b2b_sequences WHERE seq_key = ? FOR UPDATE', [key]);
  await tx.query('UPDATE b2b_sequences SET next_val = next_val + 1 WHERE seq_key = ?', [key]);
  return Number(row.next_val);
}

/** GST invoice numbers may be at most 16 characters. e.g. SOH2627-00001 */
function formatNumber(prefix, fy, n, marker) {
  const seq = String(n).padStart(5, '0');
  const tail = (marker || '') + fy + '-' + seq;
  return String(prefix).slice(0, Math.max(1, 16 - tail.length)) + tail;
}

/* ─────────── Parties ─────────── */

const stateCache = { at: 0, byCode: {}, byId: {} };
async function states() {
  if (Date.now() - stateCache.at < 300000 && Object.keys(stateCache.byId).length) return stateCache;
  const rows = await db.query('SELECT id, name, gst_code FROM b2b_states');
  stateCache.byCode = {}; stateCache.byId = {};
  rows.forEach(function (r) { stateCache.byCode[r.gst_code] = r; stateCache.byId[r.id] = r; });
  stateCache.at = Date.now();
  return stateCache;
}

/** Seller details as they should appear on documents — the company, or the supplying distributor. */
async function sellerCard(sellerType, sellerAccountId, q) {
  const st = await states();
  if (sellerType === 'distributor' && sellerAccountId) {
    const run = q ? q.queryOne.bind(q) : db.queryOne;
    const a = await run('SELECT * FROM b2b_accounts WHERE id = ?', [sellerAccountId]);
    if (!a) throw notFound('Seller not found');
    const s = st.byId[a.state_id] || { name: '', gst_code: '' };
    return {
      type: 'distributor', accountId: Number(a.id), name: a.business_name, gstin: a.gstin || '', pan: a.pan || '',
      address: [a.address_line1, a.address_line2, a.landmark, a.city, a.district_name, s.name + ' ' + a.pincode].filter(Boolean).join(', '),
      state: s.name, stateCode: s.gst_code, stateId: Number(a.state_id), phone: a.mobile, email: a.email,
      invoicePrefix: a.invoice_prefix || ('D' + a.id), city: a.city, pincode: a.pincode, bankDetails: '', footer: '',
    };
  }
  const cfg = await settings.all();
  const s = st.byCode[cfg['company.state_gst_code']] || { id: null, name: '', gst_code: cfg['company.state_gst_code'] };
  return {
    type: 'company', accountId: null, name: cfg['company.legal_name'], brand: cfg['company.brand_name'],
    gstin: cfg['company.gstin'], pan: cfg['company.pan'],
    address: [cfg['company.address'], cfg['company.city'], (s.name + ' ' + (cfg['company.pincode'] || '')).trim()].filter(Boolean).join(', '),
    state: s.name, stateCode: s.gst_code, stateId: s.id == null ? null : Number(s.id),
    phone: cfg['company.phone'] || process.env.SUPPORT_PHONE || '', email: cfg['company.email'] || process.env.SUPPORT_EMAIL || '',
    invoicePrefix: cfg['invoice.prefix'], city: cfg['company.city'], pincode: cfg['company.pincode'],
    bankDetails: cfg['company.bank_details'], footer: cfg['company.invoice_footer'],
  };
}

/* ─────────── Tax arithmetic (paise) ─────────── */

/** GST for one taxable amount. Intra-state splits into two equal halves. */
function gstSplit(taxablePaise, gstRate, interstate) {
  const milli = money.toMilliPct(gstRate);
  if (interstate) return { cgst: 0, sgst: 0, igst: money.pctOf(taxablePaise, milli) };
  const half = Math.round(taxablePaise * milli / 200000);
  return { cgst: half, sgst: half, igst: 0 };
}

/* ─────────── Invoices ─────────── */

async function liveInvoiceFor(orderId, q) {
  const run = q ? q.queryOne.bind(q) : db.queryOne;
  return run('SELECT * FROM b2b_invoices WHERE live_order_id = ?', [orderId]);
}

/** Create the invoice for an order (idempotent: returns the existing live invoice if there is one). */
async function createForOrder(tx, order, items, actor) {
  const existing = await liveInvoiceFor(order.id, tx);
  if (existing) return existing;
  const seller = await sellerCard(order.seller_type, order.seller_account_id, tx);
  const buyer = await tx.queryOne('SELECT a.*, s.name AS state_name, s.gst_code FROM b2b_accounts a JOIN b2b_states s ON s.id = a.state_id WHERE a.id = ?', [order.buyer_account_id]);
  const interstate = seller.stateId == null || Number(seller.stateId) !== Number(order.buyer_state_id);
  const date = istDate();
  const fy = financialYear(date);
  const n = await nextNumber(tx, 'inv:' + (seller.accountId || 0) + ':' + fy);
  const invoiceNo = formatNumber(seller.invoicePrefix, fy, n, '');

  let dueDate = date;
  if (order.payment_method === 'credit') {
    const c = await tx.queryOne('SELECT credit_days FROM b2b_credit_accounts WHERE debtor_account_id = ? AND creditor_account_id = ?', [order.buyer_account_id, order.seller_account_id || 0]);
    dueDate = addDays(date, c ? Number(c.credit_days) : 0);
  }
  const res = await tx.query(
    'INSERT INTO b2b_invoices (invoice_no, order_id, status, live_order_id, invoice_date, financial_year, seller_type, seller_account_id, seller_name, seller_gstin, seller_pan, ' +
    ' seller_address, seller_state, seller_state_code, seller_phone, seller_email, buyer_account_id, buyer_name, buyer_gstin, buyer_address, buyer_state, buyer_state_code, buyer_phone, ' +
    ' place_of_supply, is_interstate, taxable_total, cgst_total, sgst_total, igst_total, tax_total, discount_total, round_off, grand_total, due_date, created_by) ' +
    "VALUES (?, ?, 'final', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [invoiceNo, order.id, order.id, date, fy, order.seller_type, order.seller_account_id, seller.name, seller.gstin || null, seller.pan || null,
      seller.address || '-', seller.state || '-', seller.stateCode || '00', seller.phone || null, seller.email || null,
      order.buyer_account_id, buyer.shop_name ? buyer.business_name + ' (' + buyer.shop_name + ')' : buyer.business_name, order.buyer_gstin || buyer.gstin || null,
      [order.ship_line1, order.ship_line2, order.ship_landmark, order.ship_city, order.ship_district, order.ship_state + ' ' + order.ship_pincode].filter(Boolean).join(', '),
      order.ship_state, buyer.gst_code, order.ship_phone, buyer.gst_code + ' - ' + order.ship_state, interstate ? 1 : 0,
      order.taxable_total, order.cgst_total, order.sgst_total, order.igst_total, order.tax_total, order.discount_total, order.round_off, order.grand_total,
      dueDate, (actor && actor.label) || 'system']);
  const rows = items.map(function (it) {
    return [res.insertId, it.id, it.sku, it.name, it.hsn_code, it.qty, it.list_price, it.discount_amount, it.taxable_amount, it.gst_rate,
      it.cgst_amount, it.sgst_amount, it.igst_amount, it.line_total];
  });
  await tx.bulk('INSERT INTO b2b_invoice_items (invoice_id, order_item_id, sku, name, hsn_code, qty, unit_price, discount_amount, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total) VALUES ?', rows);
  await audit.log(tx, actor || audit.SYSTEM, 'invoice.created', 'invoice', res.insertId, null,
    { invoice_no: invoiceNo, order_id: Number(order.id), order_no: order.order_no, grand_total: order.grand_total });
  return tx.queryOne('SELECT * FROM b2b_invoices WHERE id = ?', [res.insertId]);
}

/**
 * Issue a credit note against an invoice.
 * lines = [{ item: <order item row>, qty }]. Amounts are recalculated from the
 * invoiced unit price with the same tax type as the invoice.
 */
async function createCreditNote(tx, invoice, lines, o) {
  const seller = await sellerCard(invoice.seller_type, invoice.seller_account_id, tx);
  const date = istDate();
  const fy = financialYear(date);
  const n = await nextNumber(tx, 'cn:' + (seller.accountId || 0) + ':' + fy);
  const noteNo = formatNumber(seller.invoicePrefix, fy, n, 'C');
  const interstate = !!Number(invoice.is_interstate);
  let taxable = 0, cgst = 0, sgst = 0, igst = 0;
  const rows = lines.filter(function (l) { return l.qty > 0; }).map(function (l) {
    const t = money.toPaise(l.item.unit_price) * l.qty;
    const g = gstSplit(t, l.item.gst_rate, interstate);
    taxable += t; cgst += g.cgst; sgst += g.sgst; igst += g.igst;
    return [null, l.item.id, l.item.sku, l.item.name, l.item.hsn_code, l.qty, l.item.unit_price, money.fromPaise(t), l.item.gst_rate,
      money.fromPaise(g.cgst), money.fromPaise(g.sgst), money.fromPaise(g.igst), money.fromPaise(t + g.cgst + g.sgst + g.igst)];
  });
  if (!rows.length) throw bad('A credit note needs at least one item');
  // A full cancellation mirrors the invoice exactly (including its rounding).
  const grand = o.full ? money.toPaise(invoice.grand_total) : taxable + cgst + sgst + igst;
  const res = await tx.query(
    'INSERT INTO b2b_credit_notes (credit_note_no, invoice_id, order_id, return_id, seller_type, seller_account_id, buyer_account_id, note_date, reason, is_full_cancellation, ' +
    ' taxable_total, cgst_total, sgst_total, igst_total, grand_total, applied_amount, refund_amount, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [noteNo, invoice.id, invoice.order_id, o.returnId || null, invoice.seller_type, invoice.seller_account_id, invoice.buyer_account_id, date,
      String(o.reason || 'Credit note').slice(0, 300), o.full ? 1 : 0, money.fromPaise(taxable), money.fromPaise(cgst), money.fromPaise(sgst), money.fromPaise(igst),
      money.fromPaise(grand), money.fromPaise(o.applied || 0), money.fromPaise(o.refund || 0), (o.actor && o.actor.label) || 'system']);
  rows.forEach(function (r) { r[0] = res.insertId; });
  await tx.bulk('INSERT INTO b2b_credit_note_items (credit_note_id, order_item_id, sku, name, hsn_code, qty, unit_price, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, line_total) VALUES ?', rows);
  await audit.log(tx, o.actor || audit.SYSTEM, 'credit_note.created', 'credit_note', res.insertId, null,
    { credit_note_no: noteNo, invoice_no: invoice.invoice_no, grand_total: money.fromPaise(grand), reason: o.reason });
  return { id: res.insertId, creditNoteNo: noteNo, grandTotal: grand };
}

async function setCreditNoteSettlement(tx, creditNoteId, applied, refund) {
  await tx.query('UPDATE b2b_credit_notes SET applied_amount = ?, refund_amount = ? WHERE id = ?', [money.fromPaise(applied), money.fromPaise(refund), creditNoteId]);
}

/**
 * Cancel a finalised invoice: a full credit note is issued and the invoice is
 * marked cancelled (never edited or deleted). The order can then be re-invoiced.
 */
async function cancelInvoice(invoiceId, reason, actor) {
  reason = v.text(reason, 300);
  if (reason.length < 3) throw bad('Please give a reason for cancelling the invoice');
  return db.transaction(async function (tx) {
    const inv = await tx.queryOne('SELECT * FROM b2b_invoices WHERE id = ? FOR UPDATE', [invoiceId]);
    if (!inv) throw notFound('Invoice not found');
    if (inv.status !== 'final') throw bad('This invoice is already cancelled');
    const items = await tx.query('SELECT ii.*, ii.order_item_id AS id FROM b2b_invoice_items ii WHERE ii.invoice_id = ?', [invoiceId]);
    const lines = items.map(function (it) {
      // unit price net of discount, so the note mirrors the invoiced taxable value
      const unit = money.fromPaise(Math.round(money.toPaise(it.taxable_amount) / Number(it.qty)));
      return { item: { id: it.order_item_id, sku: it.sku, name: it.name, hsn_code: it.hsn_code, unit_price: unit, gst_rate: it.gst_rate }, qty: Number(it.qty) };
    });
    const cn = await createCreditNote(tx, inv, lines, { reason: 'Invoice cancelled: ' + reason, full: true, actor: actor });
    await tx.query("UPDATE b2b_invoices SET status = 'cancelled', live_order_id = NULL, cancelled_at = UTC_TIMESTAMP(), cancel_reason = ? WHERE id = ?", [reason, invoiceId]);
    await audit.log(tx, actor, 'invoice.cancelled', 'invoice', invoiceId, { status: 'final' }, { status: 'cancelled', reason: reason, credit_note_no: cn.creditNoteNo });
    return { ok: true, creditNoteNo: cn.creditNoteNo };
  });
}

/* ─────────── Read models ─────────── */

function scopeWhere(scope, where, params) {
  if (scope.buyerAccountId != null) { where.push('i.buyer_account_id = ?'); params.push(scope.buyerAccountId); }
  if (scope.sellerAccountId != null) { where.push("i.seller_type = 'distributor' AND i.seller_account_id = ?"); params.push(scope.sellerAccountId); }
}

async function list(scope, f, pg) {
  const where = [], params = [];
  scopeWhere(scope, where, params);
  if (f.status) { where.push('i.status = ?'); params.push(f.status === 'cancelled' ? 'cancelled' : 'final'); }
  if (f.payment === 'unpaid') where.push("o.payment_status IN ('pending','partial') AND i.status = 'final'");
  if (f.payment === 'paid') where.push("o.payment_status = 'paid'");
  if (f.from) { where.push('i.invoice_date >= ?'); params.push(String(f.from)); }
  if (f.to) { where.push('i.invoice_date <= ?'); params.push(String(f.to)); }
  if (f.seller_type) { where.push('i.seller_type = ?'); params.push(String(f.seller_type)); }
  if (f.q) { const t = v.text(f.q, 80); where.push('(i.invoice_no LIKE ? OR o.order_no LIKE ? OR i.buyer_name LIKE ? OR i.buyer_gstin LIKE ?)'); params.push(like(t, 'prefix'), like(t, 'prefix'), like(t), like(t.toUpperCase(), 'prefix')); }
  const sql = ' FROM b2b_invoices i JOIN b2b_orders o ON o.id = i.order_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const total = await db.queryOne("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN i.status = 'final' THEN i.grand_total ELSE 0 END), 0) AS amount" + sql, params);
  const rows = await db.query(
    'SELECT i.id, i.invoice_no, i.invoice_date, i.due_date, i.status, i.order_id, o.order_no, i.seller_type, i.seller_name, i.buyer_account_id, i.buyer_name, i.buyer_gstin, ' +
    'i.is_interstate, i.taxable_total, i.tax_total, i.grand_total, o.payment_status, o.amount_paid, o.payment_method' + sql +
    ' ORDER BY i.id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows, total: Number(total.n), amount: total.amount };
}

/** Full invoice for display / print. `scope` restricts who may read it. */
async function get(invoiceId, scope) {
  const where = ['i.id = ?'], params = [invoiceId];
  scopeWhere(scope || {}, where, params);
  const inv = await db.queryOne(
    'SELECT i.*, o.order_no, o.payment_status, o.payment_method, o.amount_paid, o.created_at AS order_date FROM b2b_invoices i JOIN b2b_orders o ON o.id = i.order_id WHERE ' + where.join(' AND '), params);
  if (!inv) throw notFound('Invoice not found');
  const items = await db.query('SELECT * FROM b2b_invoice_items WHERE invoice_id = ? ORDER BY id', [invoiceId]);
  const notes = await db.query('SELECT id, credit_note_no, note_date, reason, grand_total, is_full_cancellation FROM b2b_credit_notes WHERE invoice_id = ? ORDER BY id', [invoiceId]);
  const seller = await sellerCard(inv.seller_type, inv.seller_account_id);
  return { invoice: inv, items: items, creditNotes: notes, bankDetails: seller.bankDetails || '', footer: seller.footer || '' };
}

async function listCreditNotes(scope, f, pg) {
  const where = [], params = [];
  if (scope.buyerAccountId != null) { where.push('c.buyer_account_id = ?'); params.push(scope.buyerAccountId); }
  if (scope.sellerAccountId != null) { where.push("c.seller_type = 'distributor' AND c.seller_account_id = ?"); params.push(scope.sellerAccountId); }
  if (f.from) { where.push('c.note_date >= ?'); params.push(String(f.from)); }
  if (f.to) { where.push('c.note_date <= ?'); params.push(String(f.to)); }
  if (f.q) { const t = v.text(f.q, 80); where.push('(c.credit_note_no LIKE ? OR i.invoice_no LIKE ? OR a.business_name LIKE ?)'); params.push(like(t, 'prefix'), like(t, 'prefix'), like(t)); }
  const sql = ' FROM b2b_credit_notes c JOIN b2b_invoices i ON i.id = c.invoice_id JOIN b2b_accounts a ON a.id = c.buyer_account_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const total = await db.queryOne('SELECT COUNT(*) AS n, COALESCE(SUM(c.grand_total), 0) AS amount' + sql, params);
  const rows = await db.query(
    'SELECT c.id, c.credit_note_no, c.note_date, c.reason, c.is_full_cancellation, c.taxable_total, c.cgst_total, c.sgst_total, c.igst_total, c.grand_total, ' +
    'c.applied_amount, c.refund_amount, c.order_id, i.invoice_no, a.business_name AS buyer_name' + sql + ' ORDER BY c.id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows, total: Number(total.n), amount: total.amount };
}

module.exports = {
  istDate, financialYear, addDays, nextNumber, formatNumber, sellerCard, states, gstSplit,
  liveInvoiceFor, createForOrder, createCreditNote, setCreditNoteSettlement, cancelInvoice, list, get, listCreditNotes,
};
