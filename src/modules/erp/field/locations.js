/**
 * Event and salesman locations (3b.2): every fix is kept (b2b_location_pings), GPS or typed in,
 * linked to the visit, sale or event it belongs to. Nothing is tracked in the background: a
 * location is recorded only when the person sends one (check-in, visit, sale, stall, manual).
 *
 * Access: locations.view sees everyone; a salesman or event staff member sees only their own
 * fixes and those of the events they are assigned to.
 */
'use strict';
const db = require('../../../db/connection.js');
const { fail, posId } = require('../lib/http.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSES = ['check_in', 'visit', 'sale', 'stall', 'route', 'manual'];
function need(c, m, code) { if (!c) throw fail(400, m, code); }

function coords(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180 || (a === 0 && b === 0)) return null;
  return { lat: Math.round(a * 1e7) / 1e7, lng: Math.round(b * 1e7) / 1e7 };
}
/** Device time if it is sane (not in the future, not older than 30 days), else now. */
function capturedAt(v) {
  const t = v ? Date.parse(v) : NaN, now = Date.now();
  const ms = Number.isFinite(t) && t <= now + 5 * 60000 && t >= now - 30 * 86400000 ? Math.min(t, now) : now;
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

async function salesmanOf(q, staffId) { return (q || db).queryOne('SELECT id, staff_id FROM b2b_salesmen WHERE staff_id = ? AND is_active = 1', [staffId]); }
async function eventsOf(q, staffId) { return (await (q || db).query('SELECT event_id FROM b2b_event_staff WHERE staff_id = ?', [staffId])).map(function (r) { return Number(r.event_id); }); }

/**
 * Record one location. b = { clientUuid, subject: 'salesman'|'event', eventId?, lat, lng, accuracy?, source: 'gps'|'manual',
 *   purpose?, visitId?, refType?, refId?, note?, capturedAt? }. A repeated clientUuid returns the first record.
 */
async function capture(tx, principal, b) {
  const uuid = String(b.clientUuid || '');
  need(UUID.test(uuid), 'clientUuid (a UUID made by the device) is required so a retry never records twice', 'client_uuid');
  const dup = await tx.queryOne('SELECT id FROM b2b_location_pings WHERE client_uuid = ?', [uuid]);
  if (dup) return { id: Number(dup.id), duplicate: true };
  const c = coords(b.lat, b.lng);
  need(c, 'A valid latitude and longitude are required', 'bad_coordinates');
  const source = b.source === 'gps' ? 'gps' : 'manual';
  const purpose = PURPOSES.indexOf(b.purpose) !== -1 ? b.purpose : (source === 'gps' ? 'route' : 'manual');
  let subjectType, subjectId;
  if (b.subject === 'event') {
    const eventId = posId(b.eventId);
    need(eventId, 'eventId is required for an event location');
    const ev = await tx.queryOne('SELECT id, status FROM b2b_events WHERE id = ?', [eventId]);
    if (!ev) throw fail(404, 'Event not found');
    if (!principal.permissions.has('events.manage') && (await eventsOf(tx, principal.id)).indexOf(eventId) === -1) throw fail(403, 'You are not assigned to this event', 'event_forbidden');
    subjectType = 'event'; subjectId = eventId;
  } else {
    const sm = await salesmanOf(tx, principal.id);
    if (!sm) throw fail(403, 'Only salesmen record a salesman location', 'not_salesman');
    subjectType = 'salesman'; subjectId = Number(sm.id);
  }
  let visitId = posId(b.visitId) || null;
  if (visitId) {
    const v = await tx.queryOne('SELECT salesman_id FROM b2b_visits WHERE id = ?', [visitId]);
    need(v && subjectType === 'salesman' && Number(v.salesman_id) === subjectId, 'That visit is not yours', 'visit_mismatch');
  }
  const accuracy = Number.isFinite(Number(b.accuracy)) && Number(b.accuracy) >= 0 ? Math.min(Math.round(Number(b.accuracy)), 100000) : null;
  const r = await tx.query('INSERT INTO b2b_location_pings (subject_type, subject_id, staff_id, lat, lng, accuracy_m, source, purpose, visit_id, ref_type, ref_id, note, captured_at, client_uuid) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [subjectType, subjectId, principal.id, c.lat, c.lng, accuracy, source, purpose, visitId, b.refType ? String(b.refType).slice(0, 30) : null, b.refId != null ? String(b.refId).slice(0, 40) : null,
      b.note ? String(b.note).slice(0, 255) : null, capturedAt(b.capturedAt), uuid]);
  // the stall's own position follows its latest manual or stall fix
  if (subjectType === 'event' && (purpose === 'stall' || source === 'manual')) await tx.query('UPDATE b2b_events SET lat = ?, lng = ? WHERE id = ?', [c.lat, c.lng, subjectId]);
  return { id: Number(r.insertId), subjectType: subjectType, subjectId: subjectId, capturedAt: capturedAt(b.capturedAt) };
}

/** What this person may see: 'all', or { salesmanId, eventIds }. */
async function visibility(principal) {
  if (principal.permissions.has('locations.view')) return 'all';
  const sm = await salesmanOf(null, principal.id);
  return { salesmanId: sm ? Number(sm.id) : null, eventIds: await eventsOf(null, principal.id) };
}
function scopeWhere(vis, where, args) {
  if (vis === 'all') return;
  const parts = [];
  if (vis.salesmanId) { parts.push("(p.subject_type = 'salesman' AND p.subject_id = ?)"); args.push(vis.salesmanId); }
  if (vis.eventIds.length) { parts.push("(p.subject_type = 'event' AND p.subject_id IN (" + db.placeholders(vis.eventIds) + '))'); args.push.apply(args, vis.eventIds); }
  where.push(parts.length ? '(' + parts.join(' OR ') + ')' : '1 = 0');
}

/** History with filters: subject, salesmanId, eventId, staffId, from, to (dates), purpose. */
async function history(principal, q) {
  const vis = await visibility(principal);
  const where = [], args = [];
  scopeWhere(vis, where, args);
  if (q.salesmanId && posId(q.salesmanId)) { where.push("p.subject_type = 'salesman' AND p.subject_id = ?"); args.push(posId(q.salesmanId)); }
  if (q.eventId && posId(q.eventId)) { where.push("p.subject_type = 'event' AND p.subject_id = ?"); args.push(posId(q.eventId)); }
  if (q.subject === 'salesman' || q.subject === 'event') { where.push('p.subject_type = ?'); args.push(q.subject); }
  if (q.staffId && posId(q.staffId)) { where.push('p.staff_id = ?'); args.push(posId(q.staffId)); }
  if (q.purpose && PURPOSES.indexOf(q.purpose) !== -1) { where.push('p.purpose = ?'); args.push(q.purpose); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { where.push('p.captured_at >= ?'); args.push(q.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { where.push('p.captured_at < (? + INTERVAL 1 DAY)'); args.push(q.to); }
  const limit = db.int(q.limit, 200, 1, 2000);
  const rows = await db.query(
    'SELECT p.id, p.subject_type, p.subject_id, p.staff_id, st.name AS staff_name, p.lat, p.lng, p.accuracy_m, p.source, p.purpose, p.visit_id, p.ref_type, p.ref_id, p.note, p.captured_at, p.received_at, ' +
    "CASE WHEN p.subject_type = 'event' THEN e.name ELSE sst.name END AS subject_name " +
    'FROM b2b_location_pings p LEFT JOIN b2b_staff st ON st.id = p.staff_id ' +
    "LEFT JOIN b2b_events e ON p.subject_type = 'event' AND e.id = p.subject_id " +
    "LEFT JOIN b2b_salesmen sm ON p.subject_type = 'salesman' AND sm.id = p.subject_id LEFT JOIN b2b_staff sst ON sst.id = sm.staff_id " +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY p.captured_at DESC, p.id DESC LIMIT ' + limit, args);
  return { items: rows.map(shape) };
}
function shape(r) {
  return { id: Number(r.id), subject: r.subject_type, subjectId: Number(r.subject_id), subjectName: r.subject_name || null, staffId: r.staff_id == null ? null : Number(r.staff_id),
    staffName: r.staff_name || null, lat: Number(r.lat), lng: Number(r.lng), accuracyM: r.accuracy_m == null ? null : Number(r.accuracy_m), source: r.source, purpose: r.purpose,
    visitId: r.visit_id == null ? null : Number(r.visit_id), ref: r.ref_type ? { type: r.ref_type, id: r.ref_id } : null, note: r.note, capturedAt: r.captured_at, receivedAt: r.received_at };
}

/** The map: the latest fix of every salesman and every event (and the events' stall pins). */
async function map(principal, q) {
  const vis = await visibility(principal);
  const where = [], args = [];
  scopeWhere(vis, where, args);
  if (q.subject === 'salesman' || q.subject === 'event') { where.push('p.subject_type = ?'); args.push(q.subject); }
  if (q.eventId && posId(q.eventId)) { where.push("p.subject_type = 'event' AND p.subject_id = ?"); args.push(posId(q.eventId)); }
  if (q.salesmanId && posId(q.salesmanId)) { where.push("p.subject_type = 'salesman' AND p.subject_id = ?"); args.push(posId(q.salesmanId)); }
  const days = db.int(q.days, 7, 1, 90);
  where.push('p.captured_at >= (UTC_TIMESTAMP() - INTERVAL ' + days + ' DAY)');
  const latest = await db.query(
    'SELECT p.* FROM b2b_location_pings p JOIN (SELECT subject_type, subject_id, MAX(id) AS id FROM b2b_location_pings GROUP BY subject_type, subject_id) m ON m.id = p.id ' +
    'WHERE ' + where.join(' AND ') + ' ORDER BY p.captured_at DESC LIMIT 1000', args);
  const evs = await db.query('SELECT id, code, name, status, lat, lng, city, starts_on, ends_on FROM b2b_events WHERE lat IS NOT NULL' +
    (vis === 'all' ? '' : (vis.eventIds.length ? ' AND id IN (' + db.placeholders(vis.eventIds) + ')' : ' AND 1 = 0')) + ' ORDER BY starts_on DESC LIMIT 500', vis === 'all' ? [] : vis.eventIds);
  const names = {};
  (await db.query('SELECT sm.id, st.name FROM b2b_salesmen sm JOIN b2b_staff st ON st.id = sm.staff_id')).forEach(function (r) { names['salesman:' + r.id] = r.name; });
  evs.forEach(function (e) { names['event:' + e.id] = e.name; });
  return {
    points: latest.map(function (r) { const s = shape(r); s.subjectName = names[s.subject + ':' + s.subjectId] || null; return s; }),
    events: evs.map(function (e) { return { id: Number(e.id), code: e.code, name: e.name, status: e.status, lat: Number(e.lat), lng: Number(e.lng), city: e.city, startsOn: e.starts_on, endsOn: e.ends_on }; }),
    note: 'Drawn from recorded fixes only; no map service is called. A fix is recorded only when the person sends one.',
  };
}

/** Attendance: first and last fix per person per day, with the number of visits that day. */
async function attendance(principal, q) {
  const vis = await visibility(principal);
  const where = ["p.subject_type = 'salesman'"], args = [];
  scopeWhere(vis, where, args);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : new Date().toISOString().slice(0, 10);
  where.push('p.captured_at >= ? AND p.captured_at < (? + INTERVAL 1 DAY)'); args.push(from, to);
  const rows = await db.query(
    'SELECT p.subject_id AS salesman_id, st.name, DATE(p.captured_at) AS day, MIN(p.captured_at) AS first_fix, MAX(p.captured_at) AS last_fix, COUNT(*) AS fixes, ' +
    '(SELECT COUNT(*) FROM b2b_visits v WHERE v.salesman_id = p.subject_id AND DATE(v.checked_in_at) = DATE(p.captured_at)) AS visits ' +
    'FROM b2b_location_pings p JOIN b2b_salesmen sm ON sm.id = p.subject_id JOIN b2b_staff st ON st.id = sm.staff_id WHERE ' + where.join(' AND ') +
    ' GROUP BY p.subject_id, st.name, DATE(p.captured_at) ORDER BY day DESC, st.name LIMIT 2000', args);
  return { from: from, to: to, items: rows.map(function (r) { return { salesmanId: Number(r.salesman_id), name: r.name, day: r.day, firstFix: r.first_fix, lastFix: r.last_fix, fixes: Number(r.fixes), visits: Number(r.visits) }; }) };
}

module.exports = { capture, history, map, attendance, visibility, coords, capturedAt, PURPOSES };
