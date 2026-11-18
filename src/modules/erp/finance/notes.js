/**
 * Customer debit notes and distributor settlements.
 *
 * Debit note (company-sold invoices only): raises what the customer owes when the invoice
 * under-charged (e.g. price corrected upward, freight agreed later). Per invoice line: an extra
 * taxable amount; GST at that line's rate, split the same way as the invoice. Approval first;
 * the number is issued on approval. Receivables ageing and allocation include it.
 *
 * Distributor settlement for a period (what the company owes a distributor):
 *   scheme claims   = promotional discount the distributor gave on its own delivered sales
 *                     (company-funded promotions: list price − promo price) × qty
 *   return credits  = refund part of credit notes the company issued to the distributor
 *                     (the part already set off against its dues is NOT counted again)
 *   other           = a signed manual adjustment with a reason
 * Approval, then "settled" with the bank reference. No money moves through this system.
 */
'use strict';
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const seq = require('../lib/seq.js');
const M = require('../lib/money.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }
const R = M.rupees;

async function createDebitNote(tx, actor, b) {
  const inv = await tx.queryOne('SELECT * FROM b2b_invoices WHERE id = ? FOR UPDATE', [posId(b.invoiceId)]);
  need(inv, 'Unknown invoice');
  need(inv.status !== 'cancelled', 'The invoice is cancelled');
  need(inv.seller_type === 'company', 'Debit notes are raised by the seller; this invoice was issued by a distributor', 'not_company_invoice');
  const reason = v.text(b.reason, 300); need(reason.length >= 10, 'Explain the reason (10+ characters)');
  const lines = Array.isArray(b.lines) ? b.lines : []; need(lines.length, 'Add at least one line');
  const items = await tx.query('SELECT id, gst_rate FROM b2b_invoice_items WHERE invoice_id = ?', [inv.id]);
  const inter = !!Number(inv.is_interstate);
  const t = { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
  for (const l of lines) {
    const it = items.find(function (i) { return Number(i.id) === posId(l.invoiceItemId); }); need(it, 'Unknown invoice line');
    const amt = M.paise(l.extraTaxable); need(amt > 0, 'extraTaxable must be positive');
    const tax = M.mulDiv(amt, Math.round(Number(it.gst_rate) * 100), 10000);
    const cg = inter ? 0 : Math.floor(tax / 2);
    t.taxable += amt; t.cgst += cg; t.sgst += inter ? 0 : tax - cg; t.igst += inter ? tax : 0;
  }
  const grand = t.taxable + t.cgst + t.sgst + t.igst;
  const r = await tx.query('INSERT INTO b2b_debit_notes (debit_note_no, invoice_id, buyer_account_id, note_date, reason, taxable_total, cgst_total, sgst_total, igst_total, grand_total, created_by) VALUES (?, ?, ?, DATE(UTC_TIMESTAMP()), ?, ?, ?, ?, ?, ?, ?)',
    ['DRAFT-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6), inv.id, inv.buyer_account_id, reason, R(t.taxable), R(t.cgst), R(t.sgst), R(t.igst), R(grand), actor.id]);
  const a = await approvals.request(tx, actor, { type: 'finance.debit_note', entity: 'debit_note', entityId: r.insertId, amount: R(grand), reason: reason, payload: { invoiceNo: inv.invoice_no } });
  await tx.query('UPDATE b2b_debit_notes SET approval_id = ? WHERE id = ?', [a.approvalId, r.insertId]);
  await audit.write(tx, actor, { module: 'finance', action: 'debit_note.proposed', entity: 'debit_note', entityId: r.insertId, new: { invoiceId: Number(inv.id), grand: R(grand), lines: lines }, reason: reason });
  return Object.assign({}, a, { debitNoteId: Number(r.insertId), grandTotal: R(grand), status: 'pending_approval' });
}
approvals.register('finance.debit_note', async function (tx, req, actor) {
  const d = await tx.queryOne('SELECT * FROM b2b_debit_notes WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!d || !/^DRAFT-/.test(d.debit_note_no)) throw fail(409, 'Debit note already issued');
  const no = await seq.next(tx, 'DBN');
  await tx.query('UPDATE b2b_debit_notes SET debit_note_no = ?, note_date = DATE(UTC_TIMESTAMP()) WHERE id = ?', [no, d.id]);
  await audit.write(tx, actor, { module: 'finance', action: 'debit_note.issued', entity: 'debit_note', entityId: d.id, approvalId: req.id, new: { debitNoteNo: no } });
  return { debitNoteId: Number(d.id), debitNoteNo: no };
});

async function computeSettlement(q, distributorId, from, to) {
  const scheme = await q.queryOne("SELECT COALESCE(SUM(GREATEST(oi.list_price - oi.unit_price, 0) * COALESCE(oi.qty_delivered, oi.qty)), 0) AS n FROM b2b_order_items oi JOIN b2b_orders o ON o.id = oi.order_id " +
    "WHERE o.seller_type = 'distributor' AND o.seller_account_id = ? AND oi.price_source = 'promo' AND o.status IN ('delivered','partially_delivered','returned') AND DATE(o.delivered_at) BETWEEN ? AND ?", [distributorId, from, to]);
  const credits = await q.queryOne("SELECT COALESCE(SUM(c.refund_amount), 0) AS n FROM b2b_credit_notes c WHERE c.buyer_account_id = ? AND c.seller_type = 'company' AND c.note_date BETWEEN ? AND ?", [distributorId, from, to]);
  return { scheme: M.paise(Number(scheme.n).toFixed(2)), credits: M.paise(Number(credits.n).toFixed(2)) };
}

async function createSettlement(tx, actor, b) {
  const d = await tx.queryOne("SELECT id, status FROM b2b_accounts WHERE id = ? AND account_type = 'distributor'", [posId(b.distributorId)]);
  need(d, 'Unknown distributor');
  const from = v.date(b.periodFrom), to = v.date(b.periodTo); need(from && to && from <= to, 'periodFrom and periodTo are required (from ≤ to)');
  const overlap = await tx.queryOne("SELECT settlement_no FROM b2b_distributor_settlements WHERE distributor_id = ? AND status <> 'cancelled' AND period_from <= ? AND period_to >= ?", [d.id, to, from]);
  need(!overlap, 'Overlaps settlement ' + (overlap && overlap.settlement_no), 'overlap');
  const c = await computeSettlement(tx, d.id, from, to);
  const other = b.otherAdjustments == null || b.otherAdjustments === '' ? 0 : M.paise(b.otherAdjustments);
  if (other) need(b.reason && String(b.reason).trim().length >= 10, 'Explain the manual adjustment (10+ characters)');
  const net = c.scheme + c.credits + other;
  const no = await seq.next(tx, 'DSET');
  const r = await tx.query("INSERT INTO b2b_distributor_settlements (settlement_no, distributor_id, period_from, period_to, scheme_claims, return_credits, other_adjustments, net_amount, status, created_by) VALUES (?,?,?,?,?,?,?,?, 'draft', ?)",
    [no, d.id, from, to, R(c.scheme), R(c.credits), R(other), R(net), actor.id]);
  await audit.write(tx, actor, { module: 'finance', action: 'settlement.drafted', entity: 'distributor_settlement', entityId: r.insertId, new: { no: no, scheme: R(c.scheme), credits: R(c.credits), other: R(other), net: R(net) }, reason: b.reason });
  return { settlementId: Number(r.insertId), settlementNo: no, schemeClaims: R(c.scheme), returnCredits: R(c.credits), otherAdjustments: R(other), netAmount: R(net), status: 'draft' };
}
async function submitSettlement(tx, actor, id, reason) {
  const s = await tx.queryOne('SELECT * FROM b2b_distributor_settlements WHERE id = ? FOR UPDATE', [id]);
  if (!s) throw fail(404, 'Settlement not found');
  if (s.status !== 'draft') throw fail(409, 'Only a draft can be submitted');
  // recompute: figures must not have changed since the draft
  const c = await computeSettlement(tx, s.distributor_id, lotsDate(s.period_from), lotsDate(s.period_to));
  if (c.scheme !== M.paise(s.scheme_claims) || c.credits !== M.paise(s.return_credits)) throw fail(409, 'The figures changed since the draft; cancel it and draft again', 'stale');
  const a = await approvals.request(tx, actor, { type: 'finance.distributor_settlement', entity: 'distributor_settlement', entityId: id, amount: s.net_amount, reason: reason || 'Settlement ' + s.settlement_no, payload: { no: s.settlement_no } });
  await tx.query("UPDATE b2b_distributor_settlements SET status = 'pending_approval', approval_id = ? WHERE id = ?", [a.approvalId, id]);
  return a;
}
function lotsDate(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
approvals.register('finance.distributor_settlement', async function (tx, req, actor) {
  const s = await tx.queryOne('SELECT * FROM b2b_distributor_settlements WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!s || s.status !== 'pending_approval') throw fail(409, 'Settlement is no longer awaiting approval');
  await tx.query("UPDATE b2b_distributor_settlements SET status = 'approved' WHERE id = ?", [s.id]);
  await audit.write(tx, actor, { module: 'finance', action: 'settlement.approved', entity: 'distributor_settlement', entityId: s.id, approvalId: req.id });
  return { settlementId: Number(s.id), status: 'approved' };
});
async function markSettled(tx, actor, id, b) {
  const s = await tx.queryOne('SELECT * FROM b2b_distributor_settlements WHERE id = ? FOR UPDATE', [id]);
  if (!s) throw fail(404, 'Settlement not found');
  if (s.status !== 'approved') throw fail(409, 'Only an approved settlement can be marked settled');
  if (Number(s.created_by) === Number(actor.id)) throw fail(403, 'The person who drafted it cannot confirm it was paid', 'maker_cannot_check');
  const ref = v.text(b.reference, 120); need(ref.length >= 4, 'Enter the bank reference');
  await tx.query("UPDATE b2b_distributor_settlements SET status = 'settled' WHERE id = ?", [id]);
  await audit.write(tx, actor, { module: 'finance', action: 'settlement.settled', entity: 'distributor_settlement', entityId: id, new: { reference: ref } });
  return { settlementId: id, status: 'settled' };
}
async function cancelSettlement(tx, actor, id, reason) {
  const s = await tx.queryOne('SELECT * FROM b2b_distributor_settlements WHERE id = ? FOR UPDATE', [id]);
  if (!s) throw fail(404, 'Settlement not found');
  if (['draft', 'pending_approval'].indexOf(s.status) === -1) throw fail(409, 'Settlement is ' + s.status);
  need(reason && String(reason).trim().length >= 5, 'A reason is required');
  await tx.query("UPDATE b2b_distributor_settlements SET status = 'cancelled' WHERE id = ?", [id]);
  if (s.approval_id) await tx.query("UPDATE b2b_approval_requests SET status = 'withdrawn', open_key = NULL, decided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'", [s.approval_id]);
  await audit.write(tx, actor, { module: 'finance', action: 'settlement.cancelled', entity: 'distributor_settlement', entityId: id, reason: reason });
  return { settlementId: id, status: 'cancelled' };
}
async function listSettlements(q) {
  const where = ['1=1'], params = [];
  if (q.distributorId) { where.push('s.distributor_id = ?'); params.push(posId(q.distributorId)); }
  return { items: await db.query('SELECT s.*, a.business_name FROM b2b_distributor_settlements s JOIN b2b_accounts a ON a.id = s.distributor_id WHERE ' + where.join(' AND ') + ' ORDER BY s.id DESC LIMIT 200', params) };
}

module.exports = { createDebitNote, createSettlement, submitSettlement, markSettled, cancelSettlement, listSettlements, computeSettlement };
