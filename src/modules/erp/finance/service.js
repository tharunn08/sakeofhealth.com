/**
 * Phase 10: receivables allocation, ageing, bank statement import and reconciliation.
 *
 * No bank API is connected: statements are uploaded as CSV by a person; matching is
 * suggested by amount + reference and confirmed by a person. Nothing posts to a bank.
 * This is not a general ledger / accounting package: it keeps the business documents
 * consistent and exportable for the accountant.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const audit = require('../core/audit.js');
const M = require('../lib/money.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }
const R = M.rupees;

/** Outstanding on a B2B invoice = total − allocations − credit notes against it. */
async function invoiceOpen(q, invoiceId) {
  const r = await q.queryOne("SELECT i.grand_total, i.buyer_account_id, i.status, " +
    '(SELECT COALESCE(SUM(a.amount), 0) FROM b2b_payment_allocations a WHERE a.invoice_id = i.id AND a.reversed_at IS NULL) AS allocated, ' +
    '(SELECT COALESCE(SUM(c.grand_total), 0) FROM b2b_credit_notes c WHERE c.invoice_id = i.id) AS credited, ' +
    "(SELECT COALESCE(SUM(d.grand_total), 0) FROM b2b_debit_notes d WHERE d.invoice_id = i.id AND d.debit_note_no NOT LIKE 'DRAFT-%') AS debited FROM b2b_invoices i WHERE i.id = ?", [invoiceId]);
  if (!r) return null;
  return { buyer: Number(r.buyer_account_id), status: r.status, open: M.paise(r.grand_total) + M.paise(r.debited) - M.paise(r.allocated) - M.paise(r.credited) };
}

async function allocate(tx, actor, paymentId, b) {
  const p = await tx.queryOne("SELECT * FROM b2b_payments WHERE id = ? FOR UPDATE", [paymentId]);
  if (!p) throw fail(404, 'Payment not found');
  need(p.status === 'received', 'Only received payments can be allocated');
  const list = Array.isArray(b.allocations) ? b.allocations : []; need(list.length && list.length <= 200, 'Give 1–200 allocations');
  const already = await tx.queryOne('SELECT COALESCE(SUM(amount), 0) AS n FROM b2b_payment_allocations WHERE payment_id = ? AND reversed_at IS NULL', [paymentId]);
  let total = M.paise(already.n);
  const seen = {};
  for (const a of list) {
    const iid = posId(a.invoiceId); need(iid && !seen[iid], 'Each invoice once'); seen[iid] = 1;
    const amt = M.paise(a.amount); need(amt > 0, 'Allocation must be positive');
    await tx.query('SELECT id FROM b2b_invoices WHERE id = ? FOR UPDATE', [iid]);
    const o = await invoiceOpen(tx, iid);
    need(o, 'Unknown invoice ' + iid);
    need(o.buyer === Number(p.payer_account_id), 'Invoice ' + iid + ' belongs to another customer', 'wrong_customer');
    need(o.status !== 'cancelled', 'Invoice ' + iid + ' is cancelled');
    need(amt <= o.open, 'More than is open on invoice ' + iid + ' (' + R(o.open) + ')', 'over_allocation');
    total += amt;
    need(total <= M.paise(p.amount), 'Allocations exceed the payment amount', 'over_allocation');
    await tx.query('INSERT INTO b2b_payment_allocations (payment_id, invoice_id, amount, allocated_by, allocated_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP()) ' +
      'ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount), allocated_by = VALUES(allocated_by), allocated_at = VALUES(allocated_at)', [paymentId, iid, R(amt), actor.id]);
  }
  await tx.query('UPDATE b2b_payments SET unallocated_amount = ? WHERE id = ?', [R(M.paise(p.amount) - total), paymentId]);
  await audit.write(tx, actor, { module: 'finance', action: 'payment.allocated', entity: 'payment', entityId: paymentId, new: { allocations: list, unallocated: R(M.paise(p.amount) - total) } });
  return { paymentId: paymentId, allocated: R(total), unallocated: R(M.paise(p.amount) - total) };
}

const BUCKETS = [['current', -1e9, 0], ['1_30', 1, 30], ['31_60', 31, 60], ['61_90', 61, 90], ['90_plus', 91, 1e9]];
function bucket(days) { return BUCKETS.find(function (b) { return days >= b[1] && days <= b[2]; })[0]; }

async function ageing(q) {
  const asOf = q.asOf ? v.date(q.asOf) : new Date().toISOString().slice(0, 10);
  need(asOf, 'asOf must be a date');
  const side = q.side === 'payables' ? 'payables' : 'receivables';
  let rows;
  if (side === 'receivables') {
    rows = await db.query("SELECT i.id, i.invoice_no AS doc_no, i.buyer_account_id AS party_id, a.business_name AS party, i.invoice_date AS doc_date, COALESCE(i.due_date, i.invoice_date) AS due_date, i.grand_total, " +
      '(SELECT COALESCE(SUM(x.amount), 0) FROM b2b_payment_allocations x WHERE x.invoice_id = i.id AND x.reversed_at IS NULL) AS paid, ' +
      '(SELECT COALESCE(SUM(c.grand_total), 0) FROM b2b_credit_notes c WHERE c.invoice_id = i.id) AS credited, ' +
      "(SELECT COALESCE(SUM(d.grand_total), 0) FROM b2b_debit_notes d WHERE d.invoice_id = i.id AND d.debit_note_no NOT LIKE 'DRAFT-%') AS debited " +
      "FROM b2b_invoices i JOIN b2b_accounts a ON a.id = i.buyer_account_id WHERE i.status <> 'cancelled' AND i.invoice_date <= ?" +
      (q.sellerType === 'distributor' ? " AND i.seller_type = 'distributor'" : (q.sellerType === 'company' ? " AND i.seller_type = 'company'" : '')) + ' LIMIT 20000', [asOf]);
  } else {
    rows = await db.query("SELECT si.id, si.invoice_no AS doc_no, si.vendor_id AS party_id, vd.legal_name AS party, si.invoice_date AS doc_date, COALESCE(si.due_date, si.invoice_date) AS due_date, si.grand_total, " +
      "(SELECT COALESCE(SUM(a.amount), 0) FROM b2b_supplier_payment_allocations a JOIN b2b_supplier_payments p ON p.id = a.supplier_payment_id WHERE a.supplier_invoice_id = si.id AND p.status = 'paid') AS paid, 0 AS credited, 0 AS debited " +
      "FROM b2b_supplier_invoices si JOIN b2b_vendors vd ON vd.id = si.vendor_id WHERE si.status NOT IN ('cancelled') AND si.invoice_kind = 'tax_invoice' AND si.invoice_date <= ? LIMIT 20000", [asOf]);
  }
  const parties = {}, totals = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0 };
  const asOfMs = Date.parse(asOf);
  rows.forEach(function (r) {
    const open = M.paise(r.grand_total) + M.paise(r.debited) - M.paise(r.paid) - M.paise(r.credited);
    if (open <= 0) return;
    const due = r.due_date instanceof Date ? r.due_date.getTime() : Date.parse(r.due_date);
    const days = Math.floor((asOfMs - due) / 86400000);
    const k = bucket(days);
    const p = parties[r.party_id] = parties[r.party_id] || { partyId: Number(r.party_id), party: r.party, current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0, documents: 0 };
    p[k] += open; p.total += open; p.documents++; totals[k] += open; totals.total += open;
  });
  if (side === 'payables') {
    // debit notes approved but not yet adjusted reduce what we owe the vendor
    const dns = await db.query("SELECT pr.vendor_id, vd.legal_name, SUM(pr.grand_total) AS n FROM b2b_purchase_returns pr JOIN b2b_vendors vd ON vd.id = pr.vendor_id WHERE pr.status IN ('approved','dispatched','acknowledged') GROUP BY pr.vendor_id, vd.legal_name");
    dns.forEach(function (d) {
      const amt = M.paise(d.n);
      const p = parties[d.vendor_id] = parties[d.vendor_id] || { partyId: Number(d.vendor_id), party: d.legal_name, current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0, documents: 0 };
      p.debitNotesPending = (p.debitNotesPending || 0) + amt; p.current -= amt; p.total -= amt; totals.current -= amt; totals.total -= amt;
    });
  }
  const fmt = function (o) { const x = Object.assign({}, o); ['current', '1_30', '31_60', '61_90', '90_plus', 'total', 'debitNotesPending'].forEach(function (k) { if (o[k] != null) x[k] = R(o[k]); }); return x; };
  return { side: side, asOf: asOf, parties: Object.values(parties).sort(function (a, b) { return b.total - a.total; }).map(fmt), totals: fmt(totals),
    basis: side === 'receivables' ? 'Invoice total less allocated receipts and credit notes; days past due date (invoice date when no due date).' : 'Supplier tax invoices less PAID supplier payments.' };
}

// ── bank statements ──
async function addBankAccount(tx, actor, b) {
  const name = v.text(b.bankName, 120); need(name, 'bankName is required');
  const last4 = String(b.accountLast4 || ''); need(/^\d{4}$/.test(last4), 'accountLast4: the last 4 digits only (the full number is not stored)');
  const ifsc = v.upper(b.ifsc, 11); need(/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc), 'IFSC is not valid');
  const r = await tx.query("INSERT INTO b2b_bank_accounts (owner_type, owner_account_id, bank_name, account_last4, ifsc, is_active) VALUES ('company', NULL, ?, ?, ?, 1)", [name, last4, ifsc]);
  await audit.write(tx, actor, { module: 'finance', action: 'bank_account.added', entity: 'bank_account', entityId: r.insertId, new: { bank: name, last4: last4, ifsc: ifsc } });
  return { bankAccountId: Number(r.insertId) };
}

/** Very small CSV reader: quoted fields, commas, CRLF. */
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (x) { return String(x).trim(); }); });
}
function amt(s) { const t = String(s || '').replace(/[,₹\s]/g, ''); if (!t) return 0; need(/^-?\d+(\.\d{1,2})?$/.test(t), 'Amount "' + s + '" is not a number'); return M.paise(t); }

async function importStatement(tx, actor, bankAccountId, file) {
  const ba = await tx.queryOne('SELECT id FROM b2b_bank_accounts WHERE id = ? AND is_active = 1', [bankAccountId]);
  need(ba, 'Unknown bank account');
  need(file && file.buffer && file.buffer.length < 5 * 1024 * 1024, 'Attach the statement CSV (max 5 MB) as "file"');
  const rows = parseCsv(file.buffer.toString('utf8').replace(/^﻿/, ''));
  need(rows.length >= 2, 'The file has no rows');
  const head = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const col = function (re) { return head.findIndex(function (h) { return re.test(h); }); };
  const C = { date: col(/date/), desc: col(/desc|narration|particular/), ref: col(/ref|cheque|utr/), debit: col(/debit|withdraw/), credit: col(/credit|deposit/), bal: col(/balance/) };
  need(C.date >= 0 && C.desc >= 0 && C.debit >= 0 && C.credit >= 0, 'The CSV needs Date, Description, Debit and Credit columns');
  let added = 0, dup = 0; const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    try {
      const d = v.date(r[C.date]); need(d, 'bad date');
      const debit = amt(r[C.debit]), credit = amt(r[C.credit]);
      need((debit > 0) !== (credit > 0), 'one of debit/credit must be set');
      const desc = v.text(r[C.desc], 255), ref = C.ref >= 0 ? v.text(r[C.ref], 120) : '';
      const bal = C.bal >= 0 && String(r[C.bal] || '').trim() ? R(amt(r[C.bal])) : null;
      const hash = crypto.createHash('sha256').update([bankAccountId, d, desc, ref, debit, credit, bal].join('|')).digest('hex');
      const ins = await tx.query("INSERT IGNORE INTO b2b_bank_statement_lines (bank_account_id, txn_date, description, reference, debit, credit, balance, line_hash, match_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmatched')",
        [bankAccountId, d, desc, ref || null, R(debit), R(credit), bal, hash]);
      if (ins.affectedRows) added++; else dup++;
    } catch (e) { errors.push({ row: i + 1, error: e.message }); }
  }
  const suggested = await suggest(tx, bankAccountId);
  await audit.write(tx, actor, { module: 'finance', action: 'bank_statement.imported', entity: 'bank_account', entityId: bankAccountId, new: { added: added, duplicates: dup, errors: errors.length } });
  return { added: added, duplicatesSkipped: dup, errors: errors.slice(0, 50), suggested: suggested };
}

/** Suggest (never auto-confirm) matches: same amount, and the reference appears in the bank text. */
async function suggest(q, bankAccountId) {
  const lines = await q.query("SELECT * FROM b2b_bank_statement_lines WHERE bank_account_id = ? AND match_status = 'unmatched' LIMIT 2000", [bankAccountId]);
  let n = 0;
  for (const l of lines) {
    const text = (String(l.description) + ' ' + String(l.reference || '')).toUpperCase();
    let hit = null;
    if (Number(l.credit) > 0) {
      const cands = await q.query("SELECT id, reference FROM b2b_payments WHERE status = 'received' AND amount = ? AND reference IS NOT NULL AND id NOT IN (SELECT matched_id FROM b2b_bank_statement_lines WHERE matched_type = 'payment' AND match_status = 'matched') LIMIT 20", [l.credit]);
      hit = cands.find(function (c) { return c.reference && text.indexOf(String(c.reference).toUpperCase()) !== -1; });
      if (hit) hit = { type: 'payment', id: hit.id };
    } else {
      const cands = await q.query("SELECT id, reference FROM b2b_supplier_payments WHERE status = 'paid' AND amount = ? AND id NOT IN (SELECT matched_id FROM b2b_bank_statement_lines WHERE matched_type = 'supplier_payment' AND match_status = 'matched') LIMIT 20", [l.debit]);
      hit = cands.find(function (c) { return c.reference && text.indexOf(String(c.reference).toUpperCase()) !== -1; });
      if (hit) hit = { type: 'supplier_payment', id: hit.id };
    }
    if (hit) { await q.query("UPDATE b2b_bank_statement_lines SET match_status = 'suggested', matched_type = ?, matched_id = ? WHERE id = ?", [hit.type, hit.id, l.id]); n++; }
  }
  return n;
}

async function matchLine(tx, actor, lineId, b) {
  const l = await tx.queryOne('SELECT * FROM b2b_bank_statement_lines WHERE id = ? FOR UPDATE', [lineId]);
  if (!l) throw fail(404, 'Line not found');
  need(l.match_status !== 'matched', 'Already matched');
  if (b.action === 'ignore') {
    need(b.reason && String(b.reason).trim().length >= 5, 'Say why this line is ignored');
    await tx.query("UPDATE b2b_bank_statement_lines SET match_status = 'ignored', matched_type = 'other', matched_by = ?, matched_at = UTC_TIMESTAMP() WHERE id = ?", [actor.id, lineId]);
    await audit.write(tx, actor, { module: 'finance', action: 'bank_line.ignored', entity: 'bank_line', entityId: lineId, reason: b.reason });
    return { lineId: lineId, status: 'ignored' };
  }
  const type = b.type || l.matched_type, id = posId(b.id) || (l.matched_id && Number(l.matched_id));
  need(['payment', 'supplier_payment'].indexOf(type) !== -1 && id, 'Give type (payment | supplier_payment) and id, or confirm the suggestion');
  const doc = type === 'payment' ? await tx.queryOne("SELECT amount, status FROM b2b_payments WHERE id = ?", [id]) : await tx.queryOne("SELECT amount, status FROM b2b_supplier_payments WHERE id = ?", [id]);
  need(doc, 'Unknown ' + type);
  const lineAmt = type === 'payment' ? l.credit : l.debit;
  need(M.paise(doc.amount) === M.paise(lineAmt), 'Amounts differ (' + doc.amount + ' vs ' + lineAmt + ')', 'amount_mismatch');
  need((type === 'payment' && doc.status === 'received') || (type === 'supplier_payment' && doc.status === 'paid'), 'The ' + type + ' is not settled yet');
  const taken = await tx.queryOne("SELECT id FROM b2b_bank_statement_lines WHERE matched_type = ? AND matched_id = ? AND match_status = 'matched'", [type, id]);
  need(!taken, 'That ' + type + ' is already matched to another bank line', 'already_matched');
  await tx.query("UPDATE b2b_bank_statement_lines SET match_status = 'matched', matched_type = ?, matched_id = ?, matched_by = ?, matched_at = UTC_TIMESTAMP() WHERE id = ?", [type, id, actor.id, lineId]);
  await audit.write(tx, actor, { module: 'finance', action: 'bank_line.matched', entity: 'bank_line', entityId: lineId, new: { type: type, id: id } });
  return { lineId: lineId, status: 'matched', type: type, id: id };
}

async function lines(q) {
  const where = ['1=1'], params = [];
  if (q.bankAccountId) { where.push('bank_account_id = ?'); params.push(posId(q.bankAccountId)); }
  if (q.status) { where.push('match_status = ?'); params.push(String(q.status).slice(0, 20)); }
  return { items: await db.query('SELECT * FROM b2b_bank_statement_lines WHERE ' + where.join(' AND ') + ' ORDER BY txn_date DESC, id DESC LIMIT ' + db.int(q.limit, 200, 1, 2000), params) };
}

module.exports = { allocate, ageing, addBankAccount, importStatement, matchLine, lines, parseCsv, invoiceOpen };
