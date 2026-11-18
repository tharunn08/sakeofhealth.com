/**
 * CSV / Excel exports that stream.
 *
 * Rows are read from MySQL in pages (keyset pagination) and written straight
 * to the HTTP response with back-pressure, so a 200,000-row export uses a few
 * megabytes of memory and never blocks other requests.
 */
const db = require('../../../db/connection.js');

const MAX_ROWS = { csv: 200000, xlsx: 100000 };
const PAGE = 1000;

function csvCell(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().replace('T', ' ').slice(0, 19);
  let s = String(value);
  // Neutralise spreadsheet formula injection (=, +, -, @ at the start of a cell).
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function xlsxCell(value, col) {
  if (value == null) return '';
  if (value instanceof Date) return col.type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString().replace('T', ' ').slice(0, 19);
  if (col.type === 'number' || col.type === 'money') { const n = Number(value); return Number.isFinite(n) ? n : ''; }
  const s = String(value);
  return /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
}

function write(res, chunk) {
  return new Promise(function (resolve, reject) {
    if (res.destroyed || res.writableEnded) return reject(new Error('client disconnected'));
    if (res.write(chunk)) return resolve();
    res.once('drain', resolve);
  });
}

function fileName(base, format) {
  return base.replace(/[^a-z0-9\-]/gi, '-') + '-' + new Date().toISOString().slice(0, 10) + '.' + format;
}

/**
 * Stream a dataset.
 * def = { name, columns: [{ key, label, type }], page: async (cursor, limit) => rows, cursorOf: row => value }
 * `page` must return rows ordered by the cursor, strictly after `cursor` (null on the first call).
 * For small pre-computed result sets pass { rows: [...] } instead of page/cursorOf.
 */
async function send(res, def, format) {
  format = format === 'xlsx' ? 'xlsx' : 'csv';
  const cap = MAX_ROWS[format];
  let count = 0;
  const pages = async function* () {
    if (def.rows) { yield def.rows.slice(0, cap); return; }
    let cursor = null;
    for (;;) {
      const rows = await def.page(cursor, PAGE);
      if (!rows.length) return;
      yield rows;
      count += rows.length;
      if (rows.length < PAGE || count >= cap) return;
      cursor = def.cursorOf(rows[rows.length - 1]);
    }
  };

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fileName(def.name, format) + '"');

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    await write(res, '﻿' + def.columns.map(function (c) { return csvCell(c.label); }).join(',') + '\r\n');
    for await (const rows of pages()) {
      let out = '';
      for (const r of rows) out += def.columns.map(function (c) { return csvCell(r[c.key]); }).join(',') + '\r\n';
      await write(res, out);
    }
    return res.end();
  }

  const ExcelJS = require('exceljs');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  const ws = wb.addWorksheet(def.sheet || 'Export');
  ws.columns = def.columns.map(function (c) {
    return { header: c.label, key: c.key, width: Math.max(12, Math.min(40, c.label.length + 6)),
      style: c.type === 'money' ? { numFmt: '#,##0.00' } : {} };
  });
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).commit();
  for await (const rows of pages()) {
    for (const r of rows) {
      const obj = {};
      def.columns.forEach(function (c) { obj[c.key] = xlsxCell(r[c.key], c); });
      ws.addRow(obj).commit();
    }
    await new Promise(function (r) { setImmediate(r); });   // let other requests run between pages
  }
  ws.commit();
  await wb.commit();
}

/** Helper for the common case: one table-ish query with a numeric id cursor. */
function keyset(sqlHead, whereParts, params, idExpr, tail) {
  return {
    page: function (cursor, limit) {
      const where = whereParts.slice(), p = params.slice();
      if (cursor != null) { where.push(idExpr + ' > ?'); p.push(cursor); }
      return db.query(sqlHead + (where.length ? ' WHERE ' + where.join(' AND ') : '') + (tail || '') + ' ORDER BY ' + idExpr + ' LIMIT ' + db.int(limit, PAGE, 1, 5000), p);
    },
    cursorOf: function (row) { return row.id; },
  };
}

module.exports = { send, keyset, csvCell, MAX_ROWS };
