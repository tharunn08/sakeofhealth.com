/**
 * Offline operations (3b.6). The field and event apps keep what they could not send in a queue
 * on the device (a buffer only; MySQL is the record). When the connection returns they send
 * each operation here with the id the device gave it. This log (b2b_offline_ops) is the server's
 * memory of every operation ever received — never deleted, never silently dropped:
 *
 *   applied    done; the result is stored and returned again for any repeat
 *   duplicate  (answer only) the same operation arrived again: nothing done twice
 *   conflict   the world changed while offline (no stock left, event closed): waits for staff
 *   failed     refused (bad data, no permission) or failed for a temporary reason (retried)
 *   resolved   staff settled it (retried successfully, or handled by hand) with a note
 *   discarded  staff decided it must not happen, with a note (the record stays)
 *
 * Each kind runs the same service function as the online screen, with its own idempotency key,
 * inside one transaction: an operation either happens completely or not at all.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const identity = require('../core/identity.js');
const { fail, posId } = require('../lib/http.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['event_sale', 'event_payment', 'field_order', 'visit', 'location'];
const CONFLICT = ['insufficient_stock', 'event_not_open', 'voided', 'not_approved', 'retailer_inactive', 'bad_status'];
const MAX_BATCH = 50;

/** How an error ends: 'conflict' (staff decide), 'failed' (refused; staff decide), 'retry' (temporary: the device tries again). */
function classify(e) {
  const status = e && e.status;
  if (status === 409 && CONFLICT.indexOf(e.code) !== -1) return 'conflict';
  if (status && status >= 400 && status < 500 && e.expose) return 'failed';
  return 'retry';
}
function sha(o) { return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex'); }

/** Run one kind with the original staff member's rights. */
async function run(tx, actor, principal, kind, p, opId) {
  if (kind === 'event_sale') return require('../events/service.js').sell(tx, actor, principal, Object.assign({}, p, { idempotencyKey: p.idempotencyKey || opId, offline: true }));
  if (kind === 'event_payment') {
    need(principal.permissions.has('events.sell'), 'You may not take payments at events', 'forbidden', 403);
    const s = p.saleKey ? await tx.queryOne('SELECT id FROM b2b_counter_sales WHERE idempotency_key = ?', [String(p.saleKey)]) : null;
    if (!s) throw fail(409, 'The sale this payment belongs to has not arrived yet', 'bad_status');
    return require('../events/service.js').addPayment(tx, actor, principal, s.id, Object.assign({}, p, { idempotencyKey: 'off:' + opId }));
  }
  if (kind === 'location') {
    need(principal.permissions.has('locations.capture'), 'You may not record locations', 'forbidden', 403);
    return require('../field/locations.js').capture(tx, principal, Object.assign({}, p, { clientUuid: p.clientUuid || opId }));
  }
  // field sales: the same rules as the salesman app
  const sm = await tx.queryOne('SELECT * FROM b2b_salesmen WHERE staff_id = ? AND is_active = 1', [principal.id]);
  if (!sm) throw fail(403, 'You are not set up as a salesman', 'not_salesman');
  const sales = require('../sales/service.js');
  if (kind === 'visit') {
    need(principal.permissions.has('sales.visits.create'), 'You may not record visits', 'forbidden', 403);
    return sales.checkIn(tx, actor, principal, sm, Object.assign({}, p, { clientUuid: p.clientUuid || opId }));
  }
  need(principal.permissions.has('sales.orders.create'), 'You may not take orders', 'forbidden', 403);
  return sales.createOrder(tx, actor, principal, sm, Object.assign({}, p, { clientUuid: p.clientUuid || opId }));
}
function need(c, m, code, status) { if (!c) throw fail(status || 400, m, code); }

/** One operation from a device. Returns what the device should do with it. */
async function apply(principal, actor, op) {
  const opId = String(op && op.clientOpId || '');
  if (!UUID.test(opId)) return { clientOpId: opId || null, status: 'failed', error: 'clientOpId must be a UUID made by the device', code: 'client_op_id' };
  if (KINDS.indexOf(op.kind) === -1) return { clientOpId: opId, status: 'failed', error: 'Unknown kind ' + op.kind, code: 'bad_kind' };
  const payload = op.payload && typeof op.payload === 'object' ? op.payload : {};
  const digest = sha({ kind: op.kind, payload: payload });
  const createdOffline = op.createdAt && Number.isFinite(Date.parse(op.createdAt)) ? new Date(Date.parse(op.createdAt)).toISOString().slice(0, 23).replace('T', ' ') : null;
  const seen = await db.queryOne('SELECT * FROM b2b_offline_ops WHERE client_op_id = ?', [opId]);
  if (seen) {
    if (Number(seen.staff_id) !== Number(principal.id)) return { clientOpId: opId, status: 'failed', error: 'This operation id belongs to someone else', code: 'op_not_yours' };
    if (seen.payload_sha256 !== digest) return { clientOpId: opId, status: 'failed', error: 'This operation id was already used for different content', code: 'op_reused' };
    if (seen.status === 'applied' || seen.status === 'resolved') return { clientOpId: opId, status: 'duplicate', result: seen.result_json ? JSON.parse(seen.result_json) : null };
    if (seen.status === 'conflict' || seen.status === 'discarded' || (seen.status === 'failed' && seen.error_code !== 'temporary')) {
      return { clientOpId: opId, status: seen.status, error: seen.error, code: seen.error_code, serverId: Number(seen.id) };
    }
    // a temporary failure: try again
  } else {
    try {
      await db.query("INSERT INTO b2b_offline_ops (client_op_id, device_id, staff_id, kind, payload_json, payload_sha256, status, attempts, error_code, created_offline_at) VALUES (?, ?, ?, ?, ?, ?, 'failed', 0, 'temporary', ?)",
        [opId, op.deviceId ? String(op.deviceId).slice(0, 64) : null, principal.id, op.kind, JSON.stringify(payload).slice(0, 1000000), digest, createdOffline]);
    } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }   // two sends of the same op at once: one does the work
  }
  return attempt(principal, actor, opId, op.kind, payload);
}

async function attempt(principal, actor, opId, kind, payload) {
  // the row lock makes two concurrent sends of the same operation run one after the other
  try {
    const result = await db.transaction(async function (tx) {
      const row = await tx.queryOne('SELECT id, status FROM b2b_offline_ops WHERE client_op_id = ? FOR UPDATE', [opId]);
      if (row.status === 'applied' || row.status === 'resolved') return { already: true };
      const r = await run(tx, actor, principal, kind, payload, opId);
      const summary = summarize(kind, r);
      await tx.query("UPDATE b2b_offline_ops SET status = 'applied', attempts = attempts + 1, result_json = ?, error = NULL, error_code = NULL, last_attempt_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
        [JSON.stringify(summary), row.id]);
      return summary;
    });
    if (result && result.already) {
      const row = await db.queryOne('SELECT result_json FROM b2b_offline_ops WHERE client_op_id = ?', [opId]);
      return { clientOpId: opId, status: 'duplicate', result: row && row.result_json ? JSON.parse(row.result_json) : null };
    }
    return { clientOpId: opId, status: 'applied', result: result };
  } catch (e) {
    const how = classify(e);
    const status = how === 'retry' ? 'failed' : how;
    const code = how === 'retry' ? 'temporary' : (e.code || 'refused');
    const msg = how === 'retry' ? 'Temporary problem on the server; it will be sent again' : String(e.message || 'refused').slice(0, 500);
    await db.query('UPDATE b2b_offline_ops SET status = ?, attempts = attempts + 1, error = ?, error_code = ?, last_attempt_at = CURRENT_TIMESTAMP(3) WHERE client_op_id = ?', [status, msg, String(code).slice(0, 60), opId])
      .catch(function () { /* the database itself is down: the device keeps the operation */ });
    if (how === 'retry') console.error('[OFFLINE] temporary failure for ' + opId + ':', e.code || e.message);
    return { clientOpId: opId, status: how, error: msg, code: code, details: e.extra || undefined };
  }
}
function summarize(kind, r) {
  if (!r || typeof r !== 'object') return { ok: true };
  if (kind === 'event_sale' || kind === 'event_payment') return { saleId: r.id, invoiceNo: r.invoiceNo, total: r.totals && r.totals.grand, paymentStatus: r.paymentStatus, duplicate: !!r.duplicate };
  if (kind === 'field_order') return { orderId: r.orderId || r.id, orderNo: r.orderNo || null, status: r.status || null, duplicate: !!r.duplicate };
  return { id: r.id || null, duplicate: !!r.duplicate };
}

/** A batch from one device, applied in the order the device made them (a payment after its sale). */
async function sync(principal, actor, ops) {
  if (!Array.isArray(ops)) throw fail(400, 'ops must be a list');
  if (ops.length > MAX_BATCH) throw fail(400, 'At most ' + MAX_BATCH + ' operations per sync', 'too_many');
  const sorted = ops.slice().sort(function (a, b) { return String(a && a.createdAt || '').localeCompare(String(b && b.createdAt || '')); });
  const results = [];
  for (const op of sorted) results.push(await apply(principal, actor, op));
  return { results: results };
}

// ── Staff ──
function shape(r, full) {
  const o = { id: Number(r.id), clientOpId: r.client_op_id, deviceId: r.device_id, staffId: Number(r.staff_id), staffName: r.staff_name, kind: r.kind, status: r.status, attempts: Number(r.attempts),
    error: r.error, code: r.error_code, createdOfflineAt: r.created_offline_at, firstReceivedAt: r.first_received_at, lastAttemptAt: r.last_attempt_at,
    resolvedBy: r.resolver_name || null, resolvedAt: r.resolved_at, note: r.resolution_note, result: r.result_json ? JSON.parse(r.result_json) : null };
  if (full) o.payload = JSON.parse(r.payload_json);
  return o;
}
async function list(principal, q) {
  const where = [], args = [];
  if (!principal.permissions.has('offline.view')) { where.push('o.staff_id = ?'); args.push(principal.id); }
  if (['applied', 'conflict', 'failed', 'resolved', 'discarded'].indexOf(q.status) !== -1) { where.push('o.status = ?'); args.push(q.status); }
  if (q.status === 'attention') where.push("o.status IN ('conflict','failed')");
  if (KINDS.indexOf(q.kind) !== -1) { where.push('o.kind = ?'); args.push(q.kind); }
  if (posId(q.staffId)) { where.push('o.staff_id = ?'); args.push(posId(q.staffId)); }
  const rows = await db.query('SELECT o.*, s.name AS staff_name, rs.name AS resolver_name FROM b2b_offline_ops o JOIN b2b_staff s ON s.id = o.staff_id LEFT JOIN b2b_staff rs ON rs.id = o.resolved_by' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY o.last_attempt_at DESC, o.id DESC LIMIT 300', args);
  const counts = await db.query('SELECT status, COUNT(*) AS n FROM b2b_offline_ops' + (principal.permissions.has('offline.view') ? '' : ' WHERE staff_id = ?') + ' GROUP BY status',
    principal.permissions.has('offline.view') ? [] : [principal.id]);
  const c = {}; counts.forEach(function (r) { c[r.status] = Number(r.n); });
  return { counts: c, items: rows.map(function (r) { return shape(r, false); }) };
}
async function detail(principal, id) {
  const r = await db.queryOne('SELECT o.*, s.name AS staff_name, rs.name AS resolver_name FROM b2b_offline_ops o JOIN b2b_staff s ON s.id = o.staff_id LEFT JOIN b2b_staff rs ON rs.id = o.resolved_by WHERE o.id = ?', [posId(id)]);
  if (!r) throw fail(404, 'Not found');
  if (!principal.permissions.has('offline.view') && Number(r.staff_id) !== Number(principal.id)) throw fail(404, 'Not found');
  return shape(r, true);
}

/** Retry as the person who made it (their current rights), e.g. after stock was moved to the event. */
async function retry(resolver, actor, id) {
  const r = await db.queryOne('SELECT * FROM b2b_offline_ops WHERE id = ?', [posId(id)]);
  if (!r) throw fail(404, 'Not found');
  if (['conflict', 'failed'].indexOf(r.status) === -1) throw fail(409, 'Only a failed or conflicting operation can be retried', 'bad_status');
  const staff = await db.queryOne('SELECT id, token_version FROM b2b_staff WHERE id = ?', [r.staff_id]);
  const owner = staff ? await identity.principal({ sid: staff.id, tv: staff.token_version }) : null;
  if (!owner) throw fail(409, 'The person who made this is no longer active; resolve it by hand or discard it', 'owner_inactive');
  await db.query("UPDATE b2b_offline_ops SET status = 'failed', error_code = 'temporary' WHERE id = ?", [r.id]);
  const out = await attempt(owner, actor, r.client_op_id, r.kind, JSON.parse(r.payload_json));
  if (out.status === 'applied') await db.query('UPDATE b2b_offline_ops SET resolved_by = ?, resolved_at = UTC_TIMESTAMP(), resolution_note = ? WHERE id = ?', [resolver.id, 'retried by staff', r.id]);
  await audit.write(null, actor, { module: 'offline', action: 'op.retried', entity: 'offline_op', entityId: r.id, old: { status: r.status }, new: { status: out.status, code: out.code || null } });
  return Object.assign({ id: Number(r.id) }, out);
}
/** Settle by hand (done another way) or discard (must not happen). A note is required; the record stays. */
async function close(tx, resolver, actor, id, how, note) {
  const r = await tx.queryOne('SELECT * FROM b2b_offline_ops WHERE id = ? FOR UPDATE', [posId(id)]);
  if (!r) throw fail(404, 'Not found');
  if (['conflict', 'failed'].indexOf(r.status) === -1) throw fail(409, 'Only a failed or conflicting operation can be settled', 'bad_status');
  const n = String(note || '').trim();
  if (n.length < 5) throw fail(400, 'Say what was done (at least 5 characters)', 'reason_required');
  const status = how === 'discard' ? 'discarded' : 'resolved';
  await tx.query('UPDATE b2b_offline_ops SET status = ?, resolved_by = ?, resolved_at = UTC_TIMESTAMP(), resolution_note = ? WHERE id = ?', [status, resolver.id, n.slice(0, 500), r.id]);
  await audit.write(tx, actor, { module: 'offline', action: 'op.' + status, entity: 'offline_op', entityId: r.id, old: { status: r.status }, new: { status: status }, reason: n });
  return { id: Number(r.id), status: status };
}

module.exports = { apply, sync, list, detail, retry, close, classify, KINDS, MAX_BATCH };
