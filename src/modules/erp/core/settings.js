/**
 * Business decisions as settings. Stored in the EXISTING b2b_settings table under
 * "erp." keys (JSON values, the same format the B2B settings use). There are NO
 * defaults: an absent key means "not decided" and callers must use the fail-safe
 * behaviour documented in settings-catalog.json. Changing a value needs an approval
 * by someone other than the requester; the approver and time are in the audit log.
 */
'use strict';
const db = require('../../../db/connection.js');
const approvals = require('./approvals.js');
const audit = require('./audit.js');
const CATALOG = require('./settings-catalog.json').settings;

const PREFIX = 'erp.';
function fail(msg) { return Object.assign(new Error(msg), { status: 400, expose: true }); }
function entry(key) { const e = CATALOG.find(function (s) { return s.key === key; }); if (!e) throw Object.assign(new Error('Unknown setting'), { status: 404, expose: true }); return e; }

/** Validates a value against the catalogue type; returns the normalised value. */
function validate(key, value) {
  const t = entry(key).type;
  if (RULE_KEYS[key]) { bandsOf(key, value); return value; }
  const isInt = function (v) { return Number.isInteger(v); };
  if (/^integer 0-100/.test(t)) { if (!isInt(value) || value < 0 || value > 100) throw fail('Expected a whole number 0–100'); return value; }
  if (t === 'integer 4|6|8') { if ([4, 6, 8].indexOf(value) === -1) throw fail('Expected 4, 6 or 8'); return value; }
  if (t === 'integer') { if (!isInt(value) || value < 1 || value > 50) throw fail('Expected a whole number 1–50'); return value; }
  if (t === 'number') { if (typeof value !== 'number' || !isFinite(value) || value < 0) throw fail('Expected a number ≥ 0'); return value; }
  if (t === 'boolean') { if (typeof value !== 'boolean') throw fail('Expected true or false'); return value; }
  if (/^enum:/.test(t)) { const opts = t.slice(5).split('|').map(function (s) { return s.trim(); }); if (opts.indexOf(value) === -1) throw fail('Expected one of ' + opts.join(', ')); return value; }
  if (/^set of/.test(t)) {
    const opts = t.slice(7).split('|').map(function (s) { return s.trim(); });
    if (!Array.isArray(value) || !value.length || value.some(function (v) { return opts.indexOf(v) === -1; })) throw fail('Expected a list of ' + opts.join(', '));
    return Array.from(new Set(value));
  }
  if (key === 'sales.otp') {
    const need = { length: [6, 8], expiry_min: [3, 30], max_attempts: [3, 10], resend_cooldown_s: [30, 300], max_resends: [1, 5], stock_hold_min: [10, 120] };
    Object.keys(need).forEach(function (k) {
      if (!isInt(value && value[k]) || value[k] < need[k][0] || value[k] > need[k][1]) throw fail('sales.otp.' + k + ' must be ' + need[k][0] + '–' + need[k][1]);
    });
    return value;
  }
  if (value == null || typeof value !== 'object') throw fail('Expected a JSON object or list');
  return value;   // structured values (tolerances, maps) are validated by the module that uses them
}

/** undefined = not decided. Never returns a default. */
async function get(key) {
  entry(key);
  const r = await db.queryOne('SELECT setting_value FROM b2b_settings WHERE setting_key = ?', [PREFIX + key]);
  if (!r) return undefined;
  try { return JSON.parse(r.setting_value); } catch (e) { return undefined; }
}

async function list() {
  const rows = await db.query("SELECT setting_key, setting_value, updated_by, updated_at FROM b2b_settings WHERE setting_key LIKE 'erp.%'");
  const set = {}; rows.forEach(function (r) { set[r.setting_key.slice(PREFIX.length)] = r; });
  return CATALOG.map(function (s) {
    const r = set[s.key];
    let value; if (r) { try { value = JSON.parse(r.setting_value); } catch (e) { value = undefined; } }
    return { key: s.key, decision: s.decision, type: s.type, status: r ? 'decided' : s.status, value: r ? value : null,
      proposal: s.proposal, whileUnset: s.while_unset, decidedBy: r ? r.updated_by : null, decidedAt: r ? r.updated_at : null };
  });
}

async function requestChange(tx, actor, key, value, reason) {
  const v = validate(key, value);
  const current = await tx.queryOne('SELECT setting_value FROM b2b_settings WHERE setting_key = ?', [PREFIX + key]);
  return approvals.request(tx, actor, { type: 'core.setting', entity: 'setting', entityId: Math.abs(hashKey(key)), reason: reason,
    payload: { key: key, value: v, previous: current ? current.setting_value : null } });
}

// approval_requests.entity_id is numeric: a stable 31-bit number per setting key
function hashKey(k) { let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

approvals.register('core.setting', async function (tx, req, actor) {
  const v = validate(req.data.key, req.data.value);
  await tx.query('INSERT INTO b2b_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
    [PREFIX + req.data.key, JSON.stringify(v), 'erp-approval:' + req.id]);
  await audit.write(tx, actor, { module: 'core', action: 'setting.changed', entity: 'setting', entityId: req.data.key,
    old: req.data.previous, new: v, approvalId: req.id });
  if (RULE_KEYS[req.data.key]) await syncApprovalRules(tx, actor, req.data.key, v, req.id);
  return { key: req.data.key, value: v };
});

/**
 * Approval thresholds are business decisions (D6/D7). Once one is approved here, the
 * approval engine's rule table is rewritten from it (old rules deactivated, never deleted).
 * Until then every request of that type falls back to one Super Admin step.
 */
const RULE_KEYS = {
  'approvals.po.value_bands': { type: 'procurement.po', bands: true },
  'approvals.supplier_payment.value_bands': { type: 'finance.supplier_payment', bands: true },
  'approvals.price_list.steps': { type: 'catalog.price_list', bands: false, permission: 'catalog.pricing.publish' },
};
function bandsOf(key, v) {
  const spec = RULE_KEYS[key];
  if (!spec.bands) {
    if (!Number.isInteger(v) || v < 1 || v > 3) throw fail('Expected 1, 2 or 3 approval steps');
    return [{ min_amount: 0, steps: v, permission: spec.permission }];
  }
  if (!Array.isArray(v) || !v.length || v.length > 10) throw fail('Expected 1–10 bands: [{ "min_amount": 0, "steps": 1, "permission": "…" }]');
  let last = -1;
  return v.map(function (b) {
    const min = Number(b && b.min_amount);
    if (!(min >= 0) || min <= last) throw fail('Bands must start at 0 and increase (min_amount)');
    if (last === -1 && min !== 0) throw fail('The first band must start at min_amount 0');
    last = min;
    if (!Number.isInteger(b.steps) || b.steps < 1 || b.steps > 3) throw fail('steps must be 1, 2 or 3');
    if (!/^[a-z_.]{3,60}$/.test(String(b.permission || ''))) throw fail('Each band needs an approver permission');
    return { min_amount: min, steps: b.steps, permission: b.permission };
  });
}
async function syncApprovalRules(tx, actor, key, v, approvalId) {
  const bands = bandsOf(key, v);
  for (const b of bands) {
    const p = await tx.queryOne('SELECT code, is_sensitive FROM b2b_permissions WHERE code = ?', [b.permission]);
    if (!p) throw fail('Unknown permission ' + b.permission);
    if (!Number(p.is_sensitive)) throw fail('Approver permission ' + b.permission + ' must be one that needs two-factor sign-in');
  }
  await tx.query('UPDATE b2b_approval_rules SET is_active = 0 WHERE approval_type = ? AND is_active = 1', [RULE_KEYS[key].type]);
  for (const b of bands) {
    await tx.query('INSERT INTO b2b_approval_rules (approval_type, min_amount, steps_required, approver_permission, is_active) VALUES (?, ?, ?, ?, 1)',
      [RULE_KEYS[key].type, b.min_amount.toFixed(2), b.steps, b.permission]);
  }
  await audit.write(tx, actor, { module: 'core', action: 'approval_rules.replaced', entity: 'approval_rules', entityId: RULE_KEYS[key].type, new: bands, approvalId: approvalId });
}

module.exports = { get, list, requestChange, validate, CATALOG, hashKey };
