/**
 * Phase 7: distribution network — map data, territories, bulk mapping (through the
 * existing B2B mapping service), GSTIN verification records.
 *
 * GSTIN: only the format/check-digit test and a person's manual verification (with the
 * evidence they looked at) are implemented. No GST-portal API is connected; nothing
 * here claims a GSTIN is "active" unless a person recorded that.
 */
'use strict';
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const mappings = require('../../b2b/mappings/service.js');
const audit = require('../core/audit.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }
function territoryIds(principal) { const s = principal.scopes.territory; return s === 'all' ? null : (Array.isArray(s) ? s : []); }

async function map(principal, q) {
  const where = ["a.account_type IN ('retailer','distributor','super_stockist')"], params = [];
  const t = territoryIds(principal);
  if (t) { if (!t.length) where.push('1=0'); else { where.push('a.territory_id IN (' + db.placeholders(t) + ')'); params.push.apply(params, t); } }
  if (q.type) { where.push('a.account_type = ?'); params.push(String(q.type).slice(0, 20)); }
  if (q.status) { where.push('a.status = ?'); params.push(String(q.status).slice(0, 30)); }
  if (q.stateId) { where.push('a.state_id = ?'); params.push(posId(q.stateId)); }
  if (q.territoryId) { where.push('a.territory_id = ?'); params.push(posId(q.territoryId)); }
  if (q.bbox) {
    const b = String(q.bbox).split(',').map(Number);
    need(b.length === 4 && b.every(isFinite), 'bbox = minLng,minLat,maxLng,maxLat');
    where.push('a.longitude BETWEEN ? AND ? AND a.latitude BETWEEN ? AND ?'); params.push(b[0], b[2], b[1], b[3]);
  }
  const rows = await db.query('SELECT a.id, a.account_type, a.status, a.business_name, a.shop_name, a.city, a.pincode, a.state_id, a.territory_id, a.latitude, a.longitude, a.gst_verification, ' +
    "m.distributor_id, m.status AS mapping_status FROM b2b_accounts a LEFT JOIN b2b_retailer_distributor_map m ON m.current_retailer_id = a.id WHERE " + where.join(' AND ') +
    ' ORDER BY a.id LIMIT ' + db.int(q.limit, 2000, 1, 5000), params);
  const located = rows.filter(function (r) { return r.latitude != null && r.longitude != null; });
  return {
    type: 'FeatureCollection',
    features: located.map(function (r) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [Number(r.longitude), Number(r.latitude)] },
        properties: { id: Number(r.id), kind: r.account_type, status: r.status, name: r.shop_name || r.business_name, city: r.city, pincode: r.pincode,
          territoryId: r.territory_id, distributorId: r.distributor_id ? Number(r.distributor_id) : null, mapping: r.mapping_status, gst: r.gst_verification } };
    }),
    withoutLocation: rows.filter(function (r) { return r.latitude == null || r.longitude == null; }).map(function (r) { return { id: Number(r.id), kind: r.account_type, name: r.shop_name || r.business_name, city: r.city }; }),
    note: 'Map tiles are not bundled; the admin screen draws these points on its own canvas. No third-party map service is called.',
  };
}

async function distributorRetailers(principal, distributorId) {
  const d = await db.queryOne("SELECT id, business_name, territory_id FROM b2b_accounts WHERE id = ? AND account_type = 'distributor'", [distributorId]);
  if (!d) throw fail(404, 'Distributor not found');
  const t = territoryIds(principal);
  if (t && t.indexOf(Number(d.territory_id)) === -1) throw fail(404, 'Distributor not found');
  const rows = await db.query("SELECT a.id, a.business_name, a.shop_name, a.city, a.pincode, a.status, a.latitude, a.longitude, m.method, m.started_at FROM b2b_retailer_distributor_map m " +
    "JOIN b2b_accounts a ON a.id = m.retailer_id WHERE m.distributor_id = ? AND m.current_retailer_id IS NOT NULL ORDER BY a.business_name LIMIT 5000", [distributorId]);
  return { distributor: d, retailers: rows };
}

// ── territories ──
function polygons(geo) {
  if (!geo || typeof geo !== 'object') throw fail(400, 'boundary must be a GeoJSON Polygon or MultiPolygon');
  const g = geo.type === 'Feature' ? geo.geometry : geo;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) throw fail(400, 'boundary must be a GeoJSON Polygon or MultiPolygon');
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let points = 0;
  polys.forEach(function (rings) {
    need(Array.isArray(rings) && rings.length, 'Empty polygon');
    rings.forEach(function (ring) {
      need(Array.isArray(ring) && ring.length >= 4, 'Each ring needs at least 4 points (closed)');
      ring.forEach(function (p) { need(Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90, 'Coordinates must be [lng, lat]'); points++; });
      need(ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1], 'Each ring must be closed (first point = last point)');
    });
  });
  need(points <= 20000, 'Boundary too detailed (max 20,000 points)');
  return { type: g.type, polys: polys };
}
function bbox(polys) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  polys.forEach(function (rings) { rings[0].forEach(function (p) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }); });
  return b;
}
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function contains(polys, pt) {
  return polys.some(function (rings) { return inRing(pt, rings[0]) && !rings.slice(1).some(function (hole) { return inRing(pt, hole); }); });
}

async function createTerritory(tx, actor, b) {
  const code = v.upper(b.code, 30).replace(/[^A-Z0-9_-]/g, ''); need(code.length >= 2, 'code is required');
  const name = v.text(b.name, 120); need(name, 'name is required');
  const level = ['region', 'area', 'beat'].indexOf(b.level) === -1 ? null : b.level; need(level, 'level must be region, area or beat');
  let parent = null;
  if (b.parentId) { parent = await tx.queryOne('SELECT id, level FROM b2b_territories WHERE id = ?', [posId(b.parentId)]); need(parent, 'Unknown parent'); }
  let geo = null, bb = [null, null, null, null];
  if (b.boundary) { const p = polygons(b.boundary); geo = JSON.stringify(b.boundary.type === 'Feature' ? b.boundary.geometry : b.boundary); bb = bbox(p.polys); }
  let r;
  try {
    r = await tx.query('INSERT INTO b2b_territories (code, name, parent_id, level, state_id, boundary_geojson, bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat, is_active, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)',
      [code, name, parent ? parent.id : null, level, posId(b.stateId) || null, geo, bb[0], bb[1], bb[2], bb[3], actor.id]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'Territory code already exists'); throw e; }
  await audit.write(tx, actor, { module: 'network', action: 'territory.created', entity: 'territory', entityId: r.insertId, new: { code: code, name: name, level: level, bbox: bb } });
  return { territoryId: Number(r.insertId), code: code, bbox: bb };
}

async function listTerritories() {
  return { items: await db.query('SELECT t.id, t.code, t.name, t.level, t.parent_id, t.state_id, t.bbox_min_lng, t.bbox_min_lat, t.bbox_max_lng, t.bbox_max_lat, t.is_active, ' +
    '(SELECT COUNT(*) FROM b2b_accounts a WHERE a.territory_id = t.id) AS accounts FROM b2b_territories t ORDER BY t.code LIMIT 2000') };
}

/** Put every located account inside the boundary into the territory. preview=true writes nothing. */
async function assignAccounts(tx, actor, id, b) {
  const t = await tx.queryOne('SELECT * FROM b2b_territories WHERE id = ? FOR UPDATE', [id]);
  if (!t) throw fail(404, 'Territory not found');
  need(t.boundary_geojson, 'This territory has no boundary');
  const p = polygons(JSON.parse(t.boundary_geojson));
  const cands = await tx.query('SELECT id, territory_id, latitude, longitude FROM b2b_accounts WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?',
    [t.bbox_min_lat, t.bbox_max_lat, t.bbox_min_lng, t.bbox_max_lng]);
  const inside = cands.filter(function (a) { return contains(p.polys, [Number(a.longitude), Number(a.latitude)]); });
  const moving = inside.filter(function (a) { return Number(a.territory_id) !== Number(id); });
  const conflicts = moving.filter(function (a) { return a.territory_id != null; }).map(function (a) { return { accountId: Number(a.id), currentTerritoryId: Number(a.territory_id) }; });
  if (b.preview !== false) return { preview: true, inside: inside.length, toAssign: moving.length, alreadyInOtherTerritory: conflicts };
  if (conflicts.length && b.moveFromOtherTerritories !== true) throw fail(409, conflicts.length + ' account(s) already belong to another territory; confirm with moveFromOtherTerritories', 'territory_conflict', { conflicts: conflicts });
  for (const a of moving) await tx.query('UPDATE b2b_accounts SET territory_id = ? WHERE id = ?', [id, a.id]);
  await audit.write(tx, actor, { module: 'network', action: 'territory.accounts_assigned', entity: 'territory', entityId: id, new: { accounts: moving.map(function (a) { return Number(a.id); }), moved: conflicts } , reason: b.reason });
  return { preview: false, assigned: moving.length };
}

// ── bulk retailer → distributor mapping (existing B2B mapping service does the write) ──
async function mappingPreview(b) {
  const ids = Array.from(new Set((b.retailerIds || []).map(posId).filter(Boolean)));
  need(ids.length && ids.length <= 2000, 'Choose 1–2000 retailers');
  const dist = await db.queryOne("SELECT id, business_name, status FROM b2b_accounts WHERE id = ? AND account_type = 'distributor'", [posId(b.distributorId)]);
  need(dist, 'Unknown distributor'); need(dist.status === 'approved', 'Distributor is not approved');
  const rows = await db.query("SELECT a.id, a.business_name, a.account_type, m.distributor_id FROM b2b_accounts a LEFT JOIN b2b_retailer_distributor_map m ON m.current_retailer_id = a.id WHERE a.id IN (" + db.placeholders(ids) + ')', ids);
  const notRetailer = rows.filter(function (r) { return r.account_type !== 'retailer'; }).map(function (r) { return Number(r.id); });
  const open = await db.query("SELECT buyer_account_id, COUNT(*) AS n FROM b2b_orders WHERE buyer_account_id IN (" + db.placeholders(ids) + ") AND status IN ('submitted','pending_admin_approval','approved','assigned','accepted','processing','packed','dispatched','out_for_delivery','pending_otp') GROUP BY buyer_account_id", ids);
  return { distributor: dist, changes: rows.filter(function (r) { return r.account_type === 'retailer'; }).map(function (r) {
    const o = open.find(function (x) { return Number(x.buyer_account_id) === Number(r.id); });
    return { retailerId: Number(r.id), name: r.business_name, from: r.distributor_id ? Number(r.distributor_id) : null, to: Number(dist.id), unchanged: Number(r.distributor_id) === Number(dist.id), openOrders: o ? Number(o.n) : 0 };
  }), notRetailers: notRetailer, missing: ids.filter(function (i) { return !rows.find(function (r) { return Number(r.id) === i; }); }),
    note: 'Open orders keep their current seller; only new orders go to the new distributor.' };
}
async function mappingApply(actor, b) {
  need(b.reason && String(b.reason).trim().length >= 5, 'A reason is required');
  const pv = await mappingPreview(b);
  need(!pv.notRetailers.length && !pv.missing.length, 'Some ids are not retailers or do not exist');
  const r = await mappings.bulkRemap(pv.changes.map(function (c) { return c.retailerId; }), pv.distributor.id, { type: 'admin', label: 'erp-staff:' + actor.id, id: actor.id }, b.reason);
  await audit.write(null, actor, { module: 'network', action: 'mapping.bulk_applied', entity: 'distributor', entityId: pv.distributor.id, new: r, reason: b.reason });
  return r;
}

// ── GSTIN verification records ──
async function verifyGstin(tx, actor, b) {
  const type = b.partyType === 'vendor' ? 'vendor' : (b.partyType === 'account' ? 'account' : null);
  need(type, 'partyType must be account or vendor');
  const id = posId(b.partyId);
  const party = type === 'account' ? await tx.queryOne('SELECT id, gstin, business_name AS name FROM b2b_accounts WHERE id = ? FOR UPDATE', [id])
    : await tx.queryOne('SELECT id, gstin, legal_name AS name FROM b2b_vendors WHERE id = ? FOR UPDATE', [id]);
  if (!party) throw fail(404, 'Party not found');
  need(party.gstin, 'This party has no GSTIN on record');
  const source = b.source === 'manual' ? 'manual' : 'checksum';
  let result, nameMatch = 'not_checked';
  if (source === 'checksum') result = v.isGstin(party.gstin) ? 'format_ok' : 'format_invalid';
  else {
    result = ['active', 'cancelled', 'suspended', 'not_found'].indexOf(b.result) === -1 ? null : b.result;
    need(result, 'For a manual check give the result you saw on the GST portal: active, cancelled, suspended or not_found');
    need(b.evidence && String(b.evidence).trim().length >= 5, 'Say what you checked (e.g. screenshot reference, date) in evidence');
    if (b.legalName) {
      const a = String(party.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''), c = String(b.legalName).toLowerCase().replace(/[^a-z0-9]/g, '');
      nameMatch = a === c ? 'exact' : (a && c && (a.indexOf(c) !== -1 || c.indexOf(a) !== -1) ? 'close' : 'mismatch');
    }
  }
  const r = await tx.query('INSERT INTO b2b_gst_verifications (gstin, party_type, party_id, source, result, legal_name, state_code, name_match, evidence_doc, checked_by, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?, UTC_TIMESTAMP())',
    [party.gstin, type, id, source, result, v.text(b.legalName, 200) || null, party.gstin.slice(0, 2), nameMatch, v.text(b.evidence, 255) || null, actor.id]);
  if (type === 'account') {
    const flag = source === 'checksum' ? (result === 'format_ok' ? 'checksum_ok' : 'failed') : (result === 'active' && nameMatch !== 'mismatch' ? 'manual_verified' : 'failed');
    await tx.query('UPDATE b2b_accounts SET gst_verification = ? WHERE id = ?', [flag, id]);
  }
  await audit.write(tx, actor, { module: 'network', action: 'gstin.checked', entity: type, entityId: id, new: { source: source, result: result, nameMatch: nameMatch } });
  return { verificationId: Number(r.insertId), source: source, result: result, nameMatch: nameMatch, note: 'No GST-portal API is connected; "active" is only ever recorded from a person\'s manual check.' };
}

module.exports = { map, distributorRetailers, createTerritory, listTerritories, assignAccounts, mappingPreview, mappingApply, verifyGstin, contains, polygons, territoryIds };
