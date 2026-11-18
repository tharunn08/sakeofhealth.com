/**
 * Reference implementation of the "divide_chain_incl_gst" formula profile —
 * the rules derived from "SS Price List" (Sri Sri Tattva, revised 9 Oct 2026).
 * Exact integer arithmetic (BigInt), no floating point.
 *
 *   PTR incl  = MRP / (1 + retailer margin)                    (not rounded)
 *   PTR ex    = round2(PTR incl / (1 + GST))
 *   PTD incl  = round2(PTR incl / (1 + distributor margin))
 *   PTD ex    = round2(PTD incl / (1 + GST))
 *   PTSS incl = round2(PTD incl / (1 + super-stockist margin))
 *   PTSS ex   = round2(PTSS incl / (1 + GST))
 *   purchase cost ex (what Ixitek pays the brand) = PTD ex × (1 − scheme)
 *
 * Rates are basis points (15 % = 1500), money is paise. round2 = half-up,
 * matching Excel's ROUND() for positive numbers.
 *
 * Run:  node divide_chain.js ss_price_list_golden.json
 */
'use strict';

const BP = 10000n;

/** round(n / d) half-up for non-negative BigInts. */
function divRound(n, d) {
  return (2n * n + d) / (2n * d);
}

function price(input) {
  if (typeof input.mrp !== 'number' || !isFinite(input.mrp)) {
    throw new Error('MRP is not a number (' + JSON.stringify(input.mrp) + ') — needs an explicit offer price');
  }
  const mrp = BigInt(Math.round(input.mrp * 100));          // paise
  const gst = BigInt(input.gst_bp), rm = BigInt(input.retailer_margin_bp);
  const dm = BigInt(input.distributor_margin_bp), sm = BigInt(input.ss_margin_bp);
  const scheme = BigInt(input.scheme_bp || 0);

  // PTR incl stays an exact fraction mrp*BP/(BP+rm); the next steps divide it directly.
  const ptrEx = divRound(mrp * BP * BP, (BP + rm) * (BP + gst));
  const ptdIncl = divRound(mrp * BP * BP, (BP + rm) * (BP + dm));
  const ptdEx = divRound(ptdIncl * BP, BP + gst);
  const ptssIncl = divRound(ptdIncl * BP, BP + sm);
  const ptssEx = divRound(ptssIncl * BP, BP + gst);
  const purchaseCostEx4 = divRound(ptdEx * (BP - scheme) * 100n, BP);  // 4 decimal places (paise × 100)
  const r = function (p) { return Number(p) / 100; };
  return {
    ptr_incl_raw: Number(mrp * BP) / Number(BP + rm) / 100,
    ptr_ex: r(ptrEx), ptd_incl: r(ptdIncl), ptd_ex: r(ptdEx), ptss_incl: r(ptssIncl), ptss_ex: r(ptssEx),
    purchase_cost_ex: Number(purchaseCostEx4) / 10000,
  };
}

/**
 * Import gate. A row is HELD (never priced, never published) when the sheet itself
 * is unreliable: MRP cell not a number, or its formulas use a typed value instead of
 * the MRP cell, or the margin-amount and PTR formulas use different bases.
 * Held rows need a person to enter brand-confirmed values; nothing is inferred.
 */
function importCheck(row) {
  if (row.status === 'held') return { publishable: false, reasons: row.hold_reasons || ['held'] };
  if (typeof row.mrp !== 'number' || !isFinite(row.mrp)) return { publishable: false, reasons: ['MRP is not a number'] };
  ['gst_bp', 'retailer_margin_bp', 'distributor_margin_bp', 'ss_margin_bp'].forEach(function (k) {
    if (!Number.isInteger(row[k]) || row[k] < 0) throw new Error('row ' + row.row + ': ' + k + ' missing or negative');
  });
  return { publishable: true, reasons: [] };
}

/** Splits an import into what may be submitted for approval and what stays held. */
function publishPlan(rows) {
  const plan = { publishable: [], held: [] };
  rows.forEach(function (r) {
    const c = importCheck(r);
    if (c.publishable) plan.publishable.push({ row: r.row, sap: r.sap, prices: price(r) });
    else plan.held.push({ row: r.row, sap: r.sap, desc: r.desc, reasons: c.reasons });
  });
  return plan;
}

module.exports = { price, importCheck, publishPlan };

