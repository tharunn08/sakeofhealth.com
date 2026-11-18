/**
 * Retailer ↔ distributor mapping.
 *
 * Automatic ranking (in this order — distance is only the final tie-breaker):
 *   1. Service territory   pincode > pincode range > city > district > state, then the area's own priority
 *   2. Active status       only approved distributors with an active service area are considered
 *   3. Stock availability  share of the catalogue the distributor has in stock (when distributor stock is tracked)
 *   4. Capacity            distributors already at max_retailers are ranked last
 *   5. Current workload    open orders relative to daily capacity, then number of retailers served
 *   6. Distance            great-circle distance between the two saved locations
 */
const db = require('../../../db/connection.js');
const audit = require('../lib/audit.js');
const settings = require('../lib/settings.js');
const { bad, notFound } = require('../lib/http.js');

const TERRITORY_SCORE = { pincode: 5, pincode_range: 4, city: 3, district: 2, state: 1 };
const OPEN_ORDER_STATUSES = ['assigned', 'accepted', 'processing', 'packed', 'dispatched', 'out_for_delivery'];

function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(function (v) { return v == null || v === ''; })) return null;
  const toRad = function (d) { return Number(d) * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/**
 * Rank every eligible distributor for a location.
 * `loc` = { state_id, district_id, city, pincode, latitude, longitude }
 */
async function rankDistributors(loc, q) {
  const run = q ? q.query.bind(q) : db.query;
  const areas = await run(
    'SELECT sa.distributor_id, sa.area_type, sa.priority, a.business_name, a.contact_person, a.mobile, a.city, a.pincode, ' +
    '       a.latitude, a.longitude, a.max_retailers, a.daily_order_capacity ' +
    'FROM b2b_service_areas sa JOIN b2b_accounts a ON a.id = sa.distributor_id ' +
    "WHERE sa.is_active = 1 AND a.account_type = 'distributor' AND a.status = 'approved' AND sa.state_id = ? AND ( " +
    "  (sa.area_type = 'pincode' AND sa.pincode_from = ?) " +
    "  OR (sa.area_type = 'pincode_range' AND ? BETWEEN sa.pincode_from AND sa.pincode_to) " +
    "  OR (sa.area_type = 'city' AND sa.city = ?) " +
    "  OR (sa.area_type = 'district' AND sa.district_id = ?) " +
    "  OR (sa.area_type = 'state') )",
    [loc.state_id, loc.pincode, loc.pincode, String(loc.city || '').toLowerCase(), loc.district_id || 0]);
  if (!areas.length) return [];

  const best = {};
  areas.forEach(function (r) {
    const score = TERRITORY_SCORE[r.area_type] * 1000 + Number(r.priority);
    if (!best[r.distributor_id] || score > best[r.distributor_id].territoryScore) {
      best[r.distributor_id] = Object.assign({}, r, { territoryScore: score, matchedBy: r.area_type });
    }
  });
  const ids = Object.keys(best).map(Number);
  const ph = db.placeholders(ids);

  const retailerCounts = await run(
    'SELECT distributor_id, COUNT(*) AS n FROM b2b_retailer_distributor_map ' +
    "WHERE status = 'active' AND distributor_id IN (" + ph + ') GROUP BY distributor_id', ids);
  const openOrders = await run(
    'SELECT seller_account_id AS distributor_id, COUNT(*) AS n FROM b2b_orders ' +
    'WHERE seller_account_id IN (' + ph + ') AND status IN (' + db.placeholders(OPEN_ORDER_STATUSES) + ') GROUP BY seller_account_id',
    ids.concat(OPEN_ORDER_STATUSES));
  const trackStock = !!(await settings.get('inventory.track_distributor_stock'));
  let stock = [];
  let catalogueSize = 0;
  if (trackStock) {
    stock = await run(
      'SELECT w.owner_account_id AS distributor_id, COUNT(DISTINCT s.product_id) AS n ' +
      'FROM b2b_warehouses w JOIN b2b_stock s ON s.warehouse_id = w.id AND s.qty_available > 0 ' +
      'WHERE w.owner_account_id IN (' + ph + ') AND w.is_active = 1 GROUP BY w.owner_account_id', ids);
    const c = await run('SELECT COUNT(*) AS n FROM b2b_products WHERE is_active = 1 AND avail_retailer = 1');
    catalogueSize = Number(c[0].n) || 0;
  }
  const byId = function (rows) { const m = {}; rows.forEach(function (r) { m[r.distributor_id] = Number(r.n); }); return m; };
  const rc = byId(retailerCounts), oo = byId(openOrders), st = byId(stock);

  const list = ids.map(function (id) {
    const d = best[id];
    const retailers = rc[id] || 0, open = oo[id] || 0;
    const atCapacity = d.max_retailers != null && retailers >= Number(d.max_retailers);
    const dailyCap = Number(d.daily_order_capacity) || 50;
    const stockCoverage = trackStock && catalogueSize ? Math.min(1, (st[id] || 0) / catalogueSize) : null;
    return {
      distributorId: id,
      name: d.business_name,
      contactPerson: d.contact_person,
      mobile: d.mobile,
      city: d.city,
      pincode: d.pincode,
      matchedBy: d.matchedBy,
      territoryScore: d.territoryScore,
      stockCoverage: stockCoverage,
      stockBucket: stockCoverage == null ? 0 : Math.round(stockCoverage * 4),   // quarters, so tiny differences don't outrank workload
      atCapacity: atCapacity,
      activeRetailers: retailers,
      maxRetailers: d.max_retailers == null ? null : Number(d.max_retailers),
      openOrders: open,
      workload: Math.round((open / dailyCap) * 100) / 100,
      distanceKm: haversineKm(loc.latitude, loc.longitude, d.latitude, d.longitude),
    };
  });

  list.sort(function (a, b) {
    return (b.territoryScore - a.territoryScore) ||
      (b.stockBucket - a.stockBucket) ||
      ((a.atCapacity ? 1 : 0) - (b.atCapacity ? 1 : 0)) ||
      (a.workload - b.workload) ||
      (a.activeRetailers - b.activeRetailers) ||
      ((a.distanceKm == null ? 1e9 : a.distanceKm) - (b.distanceKm == null ? 1e9 : b.distanceKm)) ||
      (a.distributorId - b.distributorId);
  });
  list.forEach(function (c, i) { c.rank = i + 1; });
  return list;
}

async function currentMapping(retailerId, q) {
  const run = q ? q.queryOne.bind(q) : db.queryOne;
  return run(
    'SELECT m.*, a.business_name AS distributor_name, a.contact_person AS distributor_contact, a.mobile AS distributor_mobile, ' +
    '       a.email AS distributor_email, a.address_line1, a.address_line2, a.city AS distributor_city, a.pincode AS distributor_pincode, ' +
    '       a.district_name AS distributor_district, a.status AS distributor_status ' +
    'FROM b2b_retailer_distributor_map m JOIN b2b_accounts a ON a.id = m.distributor_id WHERE m.current_retailer_id = ?', [retailerId]);
}

/**
 * Point a retailer at a distributor (or at nobody when distributorId is null).
 * Ends the current mapping row and inserts a new one — history is never overwritten.
 */
async function assign(tx, retailerId, distributorId, opts) {
  opts = opts || {};
  const retailer = await tx.queryOne("SELECT id, account_type FROM b2b_accounts WHERE id = ? FOR UPDATE", [retailerId]);
  if (!retailer || retailer.account_type !== 'retailer') throw notFound('Retailer not found');
  if (distributorId != null) {
    const dist = await tx.queryOne('SELECT id, account_type, status FROM b2b_accounts WHERE id = ?', [distributorId]);
    if (!dist || dist.account_type !== 'distributor') throw bad('Distributor not found');
    if (dist.status !== 'approved') throw bad('That distributor is not approved and cannot be assigned retailers');
  }
  const current = await tx.queryOne('SELECT * FROM b2b_retailer_distributor_map WHERE current_retailer_id = ? FOR UPDATE', [retailerId]);
  if (current && distributorId != null && Number(current.distributor_id) === Number(distributorId) && current.status === 'active') {
    return { changed: false, mappingId: current.id };
  }
  const actorLabel = (opts.actor && opts.actor.label) || 'system';
  if (current) {
    await tx.query(
      "UPDATE b2b_retailer_distributor_map SET status = 'ended', current_retailer_id = NULL, ended_at = UTC_TIMESTAMP(), ended_by = ? WHERE id = ?",
      [actorLabel, current.id]);
  }
  let mappingId = null;
  if (distributorId != null) {
    const res = await tx.query(
      'INSERT INTO b2b_retailer_distributor_map (retailer_id, distributor_id, status, current_retailer_id, method, reason, score_json, assigned_by) ' +
      "VALUES (?, ?, 'active', ?, ?, ?, ?, ?)",
      [retailerId, distributorId, retailerId, opts.method || 'manual', opts.reason ? String(opts.reason).slice(0, 500) : null,
        opts.score ? JSON.stringify(opts.score).slice(0, 4000) : null, actorLabel]);
    mappingId = res.insertId;
  }
  await audit.log(tx, opts.actor || audit.SYSTEM, distributorId == null ? 'mapping.removed' : 'mapping.changed', 'retailer', retailerId,
    { distributorId: current ? Number(current.distributor_id) : null },
    { distributorId: distributorId == null ? null : Number(distributorId), method: opts.method || 'manual', reason: opts.reason || null });
  return { changed: true, mappingId: mappingId, previousDistributorId: current ? Number(current.distributor_id) : null };
}

/** Auto-map a retailer using the ranking above. Returns the chosen candidate or null. */
async function autoAssign(tx, retailerId, actor) {
  const r = await tx.queryOne('SELECT id, state_id, district_id, city, pincode, latitude, longitude FROM b2b_accounts WHERE id = ?', [retailerId]);
  if (!r) throw notFound('Retailer not found');
  const ranked = await rankDistributors(r, tx);
  const chosen = ranked.find(function (c) { return !c.atCapacity; }) || null;
  if (!chosen) return { assigned: null, candidates: ranked };
  await assign(tx, retailerId, chosen.distributorId, {
    method: 'auto', actor: actor || audit.SYSTEM,
    reason: 'Automatic: best match by ' + chosen.matchedBy.replace('_', ' '),
    score: { chosen: chosen, alternatives: ranked.slice(0, 5).map(function (c) { return { id: c.distributorId, rank: c.rank, matchedBy: c.matchedBy }; }) },
  });
  return { assigned: chosen, candidates: ranked };
}

async function setMappingStatus(tx, retailerId, status, actor, reason) {
  if (['active', 'suspended'].indexOf(status) === -1) throw bad('Invalid mapping status');
  const current = await tx.queryOne('SELECT * FROM b2b_retailer_distributor_map WHERE current_retailer_id = ? FOR UPDATE', [retailerId]);
  if (!current) throw bad('This retailer has no distributor mapping');
  if (current.status === status) return { changed: false };
  await tx.query('UPDATE b2b_retailer_distributor_map SET status = ?, reason = ? WHERE id = ?',
    [status, reason ? String(reason).slice(0, 500) : current.reason, current.id]);
  await audit.log(tx, actor, 'mapping.' + (status === 'suspended' ? 'suspended' : 'resumed'), 'retailer', retailerId,
    { status: current.status }, { status: status, reason: reason || null, distributorId: Number(current.distributor_id) });
  return { changed: true };
}

/** Move many retailers to one distributor in a single transaction. */
async function bulkRemap(retailerIds, distributorId, actor, reason) {
  const ids = Array.from(new Set((retailerIds || []).map(Number).filter(function (n) { return Number.isInteger(n) && n > 0; })));
  if (!ids.length) throw bad('Select at least one retailer');
  if (ids.length > 2000) throw bad('Remap at most 2,000 retailers at a time');
  return db.transaction(async function (tx) {
    let changed = 0;
    for (const id of ids) {
      const r = await assign(tx, id, distributorId, { method: 'bulk', actor: actor, reason: reason });
      if (r.changed) changed++;
    }
    return { requested: ids.length, changed: changed };
  });
}

async function history(retailerId) {
  return db.query(
    'SELECT m.id, m.distributor_id, a.business_name AS distributor_name, m.status, m.method, m.reason, m.assigned_by, m.ended_by, m.started_at, m.ended_at ' +
    'FROM b2b_retailer_distributor_map m JOIN b2b_accounts a ON a.id = m.distributor_id WHERE m.retailer_id = ? ORDER BY m.id DESC LIMIT 100',
    [retailerId]);
}

/* ─────────── Service areas ─────────── */

async function listServiceAreas(distributorId) {
  return db.query(
    'SELECT sa.*, s.name AS state_name, d.name AS district_name FROM b2b_service_areas sa ' +
    'JOIN b2b_states s ON s.id = sa.state_id LEFT JOIN b2b_districts d ON d.id = sa.district_id ' +
    'WHERE sa.distributor_id = ? ORDER BY sa.is_active DESC, sa.area_type, sa.pincode_from, sa.city', [distributorId]);
}

async function addServiceArea(distributorId, body, actor) {
  const type = String(body.area_type || '');
  if (!TERRITORY_SCORE[type]) throw bad('Choose an area type');
  const dist = await db.queryOne("SELECT id, state_id FROM b2b_accounts WHERE id = ? AND account_type = 'distributor'", [distributorId]);
  if (!dist) throw notFound('Distributor not found');
  const stateId = Number(body.state_id) || Number(dist.state_id);
  const state = await db.queryOne('SELECT id FROM b2b_states WHERE id = ?', [stateId]);
  if (!state) throw bad('Unknown state');
  const row = { district_id: null, city: null, pincode_from: null, pincode_to: null };
  const pin = /^[1-9]\d{5}$/;
  if (type === 'district') {
    const d = await db.queryOne('SELECT id FROM b2b_districts WHERE id = ? AND state_id = ?', [Number(body.district_id) || 0, stateId]);
    if (!d) throw bad('Choose a district in the selected state');
    row.district_id = d.id;
  } else if (type === 'city') {
    row.city = String(body.city || '').trim().toLowerCase().slice(0, 80);
    if (!row.city) throw bad('City is required');
  } else if (type === 'pincode') {
    if (!pin.test(String(body.pincode_from || body.pincode || ''))) throw bad('Enter a valid 6-digit pincode');
    row.pincode_from = String(body.pincode_from || body.pincode);
    row.pincode_to = row.pincode_from;
  } else if (type === 'pincode_range') {
    if (!pin.test(String(body.pincode_from || '')) || !pin.test(String(body.pincode_to || ''))) throw bad('Enter valid 6-digit pincodes for the range');
    if (String(body.pincode_from) > String(body.pincode_to)) throw bad('The range must start at the lower pincode');
    row.pincode_from = String(body.pincode_from); row.pincode_to = String(body.pincode_to);
  }
  const priority = Math.max(-100, Math.min(100, Number(body.priority) || 0));
  const dup = await db.queryOne(
    'SELECT id FROM b2b_service_areas WHERE distributor_id = ? AND area_type = ? AND state_id = ? AND is_active = 1 ' +
    'AND district_id <=> ? AND city <=> ? AND pincode_from <=> ? AND pincode_to <=> ?',
    [distributorId, type, stateId, row.district_id, row.city, row.pincode_from, row.pincode_to]);
  if (dup) throw bad('This service area already exists for the distributor');
  const res = await db.query(
    'INSERT INTO b2b_service_areas (distributor_id, area_type, state_id, district_id, city, pincode_from, pincode_to, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [distributorId, type, stateId, row.district_id, row.city, row.pincode_from, row.pincode_to, priority]);
  audit.logSoft(actor, 'service_area.added', 'distributor', distributorId, null, Object.assign({ id: res.insertId, area_type: type, state_id: stateId, priority: priority }, row));
  return { id: res.insertId };
}

/** Add many single pincodes at once ("560001, 560002 560003"). */
async function addPincodes(distributorId, text, actor) {
  const pins = Array.from(new Set(String(text || '').split(/[\s,;]+/).filter(function (p) { return /^[1-9]\d{5}$/.test(p); })));
  if (!pins.length) throw bad('Enter at least one valid 6-digit pincode');
  if (pins.length > 1000) throw bad('Add at most 1,000 pincodes at a time');
  let added = 0;
  for (const p of pins) {
    try { await addServiceArea(distributorId, { area_type: 'pincode', pincode_from: p }, actor); added++; }
    catch (e) { if (!e.expose) throw e; }
  }
  return { requested: pins.length, added: added };
}

async function setServiceAreaActive(areaId, active, actor) {
  const area = await db.queryOne('SELECT * FROM b2b_service_areas WHERE id = ?', [areaId]);
  if (!area) throw notFound('Service area not found');
  await db.query('UPDATE b2b_service_areas SET is_active = ? WHERE id = ?', [active ? 1 : 0, areaId]);
  audit.logSoft(actor, active ? 'service_area.enabled' : 'service_area.disabled', 'distributor', area.distributor_id,
    { id: area.id, is_active: area.is_active }, { id: area.id, is_active: active ? 1 : 0 });
  return { ok: true };
}

module.exports = {
  rankDistributors, currentMapping, assign, autoAssign, setMappingStatus, bulkRemap, history,
  listServiceAreas, addServiceArea, addPincodes, setServiceAreaActive, haversineKm, OPEN_ORDER_STATUSES,
};
