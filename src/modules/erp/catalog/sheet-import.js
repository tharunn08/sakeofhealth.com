/**
 * Reads a brand price list workbook (the "SS Price List" layout: S.No, SAP Code,
 * Product Description, UM, HSN Code, Shipper Size, MRP, GST %, margins, Scheme)
 * and turns each product row into a checked, priced line.
 *
 * Nothing is guessed. A row is HELD (not priced, never published) when the sheet
 * itself is unreliable:
 *   - the MRP cell is not a number (e.g. "195 175" — an offer written as text);
 *   - the margin-amount or PTR formula prices on a typed number instead of the MRP cell;
 * Held rows need a person to enter brand-confirmed values in a later version.
 * A row whose own Excel results differ from our calculation by more than ₹0.005 is
 * kept as a WARNING for a person to look at.
 */
'use strict';
const ExcelJS = require('exceljs');
const chain = require('./divide-chain.js');

const HEADERS = {
  sap: /^sap\s*code$/i, desc: /^product\s*description$/i, uom: /^u\.?m$|^uom$/i, hsn: /^hsn/i, shipper: /^shipper/i,
  mrp: /^mrp$/i, gst: /^gst\s*%?$/i, rm: /^retailer'?s?\s*margin\s*\(%\)$/i, rmAmt: /^retailer'?s?\s*margin\s*\(amount\)$/i,
  ptrIncl: /^ptr\s*incl/i, ptrEx: /^ptr\s*before/i, dm: /^distributor'?s?\s*margin\s*\(%\)$/i, ptdEx: /^ptd\s*before/i,
  ptdIncl: /^ptd\s*incl/i, sm: /^super\s*stockist\s*margin\s*\(%\)$/i, ptssEx: /^ptss\s*before/i, ptssIncl: /^ptss\s*incl/i, scheme: /^scheme$/i,
};

function cellValue(c) {
  const v = c.value;
  if (v && typeof v === 'object') {
    if ('result' in v) return v.result && typeof v.result === 'object' ? null : v.result;
    if (v.richText) return v.richText.map(function (t) { return t.text; }).join('');
    return null;
  }
  return v;
}
function cellFormula(c) { const v = c.value; return v && typeof v === 'object' && typeof v.formula === 'string' ? v.formula : null; }
function text(v) { return v == null ? '' : String(v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }
function bp(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 10000) : null; }

function findHeader(ws) {
  for (let r = 1; r <= Math.min(ws.rowCount, 30); r++) {
    const cols = {};
    ws.getRow(r).eachCell(function (c, i) {
      const t = text(cellValue(c)).replace(/\s+/g, ' ');
      Object.keys(HEADERS).forEach(function (k) { if (cols[k] == null && HEADERS[k].test(t)) cols[k] = i; });
    });
    if (cols.sap && cols.mrp && cols.gst && cols.rm && cols.dm) return { row: r, cols: cols };
  }
  return null;
}

/** Does a formula on row r price from the MRP cell (e.g. G7) rather than a typed number? */
function usesMrpCell(formula, mrpLetter, r) {
  if (!formula) return true;                       // shared formulas copy the master row's (checked) pattern
  const f = formula.replace(/\$/g, '').toUpperCase();
  return new RegExp('(^|[^A-Z])' + mrpLetter + r + '([^0-9]|$)').test(f);
}
function leadingNumber(formula) { const m = /^\s*=?\s*(\d+(?:\.\d+)?)/.exec(formula || ''); return m ? m[1] : null; }

async function parse(source) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(source)) await wb.xlsx.load(source); else await wb.xlsx.readFile(source);
  const ws = wb.worksheets.find(function (w) { return findHeader(w); });
  if (!ws) throw Object.assign(new Error('No price-list header row (SAP Code, MRP, GST %, margins) found in the workbook'), { status: 400, expose: true });
  const hdr = findHeader(ws), C = hdr.cols;
  const mrpLetter = ws.getColumn(C.mrp).letter;
  const meta = { sheet: ws.name, title: [1, 2, 3].map(function (r) { return text(cellValue(ws.getRow(r).getCell(1))); }).filter(Boolean).join(' · '), headerRow: hdr.row };
  const rows = [];
  const seen = {};
  for (let r = hdr.row + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sap = text(cellValue(row.getCell(C.sap)));
    if (!/^\d{4,20}$/.test(sap)) continue;             // section headings ("FOOD", "BROWN SUGAR") and blanks
    const g = function (k) { return C[k] ? cellValue(row.getCell(C[k])) : null; };
    const f = function (k) { return C[k] ? cellFormula(row.getCell(C[k])) : null; };
    const line = {
      row: r, sap: sap, desc: text(g('desc')), uom: text(g('uom')), hsn: text(g('hsn')).replace(/\D/g, ''),
      shipper: Number.isInteger(g('shipper')) ? g('shipper') : null,
      mrp: g('mrp'), gst_bp: bp(g('gst')), retailer_margin_bp: bp(g('rm')), distributor_margin_bp: bp(g('dm')),
      ss_margin_bp: bp(g('sm')), scheme_bp: bp(g('scheme')) || 0,
      sheet: { ptr_ex: g('ptrEx'), ptd_incl: g('ptdIncl'), ptd_ex: g('ptdEx'), ptss_incl: g('ptssIncl'), ptss_ex: g('ptssEx') },
      status: 'ok', reasons: [],
    };
    const hold = function (m) { line.status = 'held'; line.reasons.push(m); };
    if (typeof line.mrp !== 'number' || !isFinite(line.mrp) || line.mrp <= 0) {
      hold('MRP cell is not a number (' + JSON.stringify(text(line.mrp)) + '); the brand must confirm the MRP/offer price');
    }
    ['gst_bp', 'retailer_margin_bp', 'distributor_margin_bp', 'ss_margin_bp'].forEach(function (k) {
      if (line[k] == null || line[k] < 0 || line[k] > 10000) hold(k.replace(/_bp$/, '').replace(/_/g, ' ') + ' is missing or not a percentage');
    });
    const fAmt = f('rmAmt'), fPtr = f('ptrIncl');
    const amtOk = usesMrpCell(fAmt, mrpLetter, r), ptrOk = usesMrpCell(fPtr, mrpLetter, r);
    if (!ptrOk) hold('PTR formula uses a typed value (' + leadingNumber(fPtr) + ') instead of the MRP cell');
    if (!amtOk) hold('margin-amount formula uses a typed value (' + leadingNumber(fAmt) + ')' + (ptrOk ? ' while PTR uses the MRP cell — the sheet is internally inconsistent' : ''));
    if (seen[sap]) hold('SAP code appears twice in the sheet (row ' + seen[sap] + ')');
    seen[sap] = r;
    if (line.status === 'ok') {
      line.prices = chain.price(line);
      const diffs = Object.keys(line.sheet).filter(function (k) {
        return typeof line.sheet[k] === 'number' && Math.abs(line.sheet[k] - line.prices[k]) > 0.0049;
      });
      if (diffs.length) { line.status = 'warning'; line.reasons.push('sheet result differs from the formula for ' + diffs.join(', ')); }
    }
    rows.push(line);
  }
  return { meta: meta, rows: rows };
}

module.exports = { parse, usesMrpCell };
