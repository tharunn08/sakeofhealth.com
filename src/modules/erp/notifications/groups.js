/**
 * Recipient groups (N3): a saved fixed list of recipients, or a rule evaluated at send time
 * ("all approved retailers in Karnataka"). Groups only save picking effort: every send still
 * checks the sender's audience permissions, the recipient limit and, for promotions, consent.
 */
'use strict';
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const directory = require('./directory.js');
const { fail, posId } = require('../lib/http.js');

const MAX_MEMBERS = 5000;
const ACCOUNT_TYPES = ['retailer', 'distributor'];
function need(c, m, code) { if (!c) throw fail(400, m, code); }
function canSendTo(principal, type) { return principal.permissions.has('notifications.send.' + directory.AUDIENCE[type]); }

/** A rule: { type, stateId?, districtId? } (geography only for retailers and distributors). */
function readRule(r) {
  need(r && typeof r === 'object' && directory.TYPES.indexOf(r.type) !== -1, 'A rule needs a recipient type', 'rule_type');
  const out = { type: r.type };
  if (r.stateId != null && r.stateId !== '') { need(ACCOUNT_TYPES.indexOf(r.type) !== -1, 'Only retailers and distributors can be chosen by state'); out.stateId = posId(r.stateId); need(out.stateId, 'Unknown state'); }
  if (r.districtId != null && r.districtId !== '') { need(ACCOUNT_TYPES.indexOf(r.type) !== -1, 'Only retailers and distributors can be chosen by district'); out.districtId = posId(r.districtId); need(out.districtId, 'Unknown district'); }
  return out;
}
function readMembers(list) {
  need(Array.isArray(list) && list.length, 'A list group needs at least one member', 'no_members');
  need(list.length <= MAX_MEMBERS, 'At most ' + MAX_MEMBERS + ' members per group');
  const seen = {}, out = [];
  list.forEach(function (m) {
    need(m && directory.TYPES.indexOf(m.type) !== -1 && posId(m.ref), 'Each member needs a recipient type and id');
    const k = m.type + ':' + posId(m.ref);
    if (!seen[k]) { seen[k] = true; out.push({ type: m.type, ref: posId(m.ref) }); }
  });
  return out;
}
function typesOf(g) { return g.kind === 'rule' ? [g.rule.type] : Array.from(new Set(g.members.map(function (m) { return m.type; }))); }

/** Members a rule selects right now (active only), at most cap. */
async function evaluate(rule, cap) {
  if (ACCOUNT_TYPES.indexOf(rule.type) !== -1) {
    const where = ["account_type = ?", "status = 'approved'"], args = [rule.type];
    if (rule.stateId) { where.push('state_id = ?'); args.push(rule.stateId); }
    if (rule.districtId) { where.push('district_id = ?'); args.push(rule.districtId); }
    const rows = await db.query('SELECT id FROM b2b_accounts WHERE ' + where.join(' AND ') + ' ORDER BY id LIMIT ' + db.int(cap, 500, 1, MAX_MEMBERS + 1), args);
    return rows.map(function (r) { return { type: rule.type, ref: Number(r.id) }; });
  }
  return (await directory.all(rule.type, Math.min(cap, 500))).map(function (p) { return { type: p.type, ref: p.ref }; });
}

async function load(run, id) {
  const g = await (run || db).queryOne('SELECT * FROM b2b_recipient_groups WHERE id = ?', [id]);
  if (!g) return null;
  const out = { id: Number(g.id), name: g.name, kind: g.kind, active: Number(g.active) === 1, createdBy: g.created_by_label, updatedAt: g.updated_at };
  if (g.kind === 'rule') { try { out.rule = JSON.parse(g.rule_json); } catch (e) { out.rule = null; } }
  else out.members = (await (run || db).query('SELECT recipient_type AS type, recipient_ref AS ref FROM b2b_recipient_group_members WHERE group_id = ? ORDER BY id', [id]))
    .map(function (m) { return { type: m.type, ref: Number(m.ref) }; });
  return out;
}

async function list(principal) {
  const rows = await db.query('SELECT id FROM b2b_recipient_groups ORDER BY active DESC, name LIMIT 500');
  const out = [];
  for (const r of rows) {
    const g = await load(null, r.id);
    if (!g || (g.kind === 'rule' && !g.rule)) continue;
    g.types = typesOf(g);
    g.mayEdit = g.types.every(function (t) { return canSendTo(principal, t); });   // the caller may send to every type in it
    g.usable = g.active && g.mayEdit;
    g.size = g.kind === 'rule' ? (await evaluate(g.rule, MAX_MEMBERS + 1)).length : g.members.length;
    if (g.members) { g.memberCount = g.members.length; delete g.members; }
    out.push(g);
  }
  return out;
}

async function create(tx, actor, principal, b) {
  const name = String(b.name || '').trim();
  need(name.length >= 3 && name.length <= 120, 'Name: 3–120 characters');
  need(['list', 'rule'].indexOf(b.kind) !== -1, 'kind must be list or rule');
  const g = { kind: b.kind };
  if (g.kind === 'rule') g.rule = readRule(b.rule); else g.members = readMembers(b.members);
  typesOf(g).forEach(function (t) { if (!canSendTo(principal, t)) throw fail(403, 'You may not send messages to ' + t + 's', 'audience_forbidden'); });
  if (g.members) {
    const found = await directory.resolve(g.members);
    need(found.length === g.members.length, 'Some members were not found', 'unknown_member');
  }
  let res;
  try {
    res = await tx.query('INSERT INTO b2b_recipient_groups (name, kind, rule_json, created_by_label) VALUES (?, ?, ?, ?)', [name, g.kind, g.rule ? JSON.stringify(g.rule) : null, actor.label || null]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A group called ' + name + ' already exists', 'group_exists'); throw e; }
  const id = Number(res.insertId);
  for (const m of g.members || []) await tx.query('INSERT INTO b2b_recipient_group_members (group_id, recipient_type, recipient_ref) VALUES (?, ?, ?)', [id, m.type, m.ref]);
  await audit.write(tx, actor, { module: 'notifications', action: 'group.created', entity: 'recipient_group', entityId: id,
    new: { name: name, kind: g.kind, rule: g.rule || null, members: g.members ? g.members.length : null } });
  return load(tx, id);
}

async function update(tx, actor, principal, id, b) {
  const old = await load(tx, id);
  if (!old) throw fail(404, 'Group not found');
  typesOf(old).forEach(function (t) { if (!canSendTo(principal, t)) throw fail(403, 'You may not change a group of ' + t + 's', 'audience_forbidden'); });
  const next = { kind: old.kind, rule: old.rule, members: old.members };
  if (b.rule !== undefined && old.kind === 'rule') next.rule = readRule(b.rule);
  if (b.members !== undefined && old.kind === 'list') next.members = readMembers(b.members);
  typesOf(next).forEach(function (t) { if (!canSendTo(principal, t)) throw fail(403, 'You may not send messages to ' + t + 's', 'audience_forbidden'); });
  const name = b.name !== undefined ? String(b.name).trim() : old.name;
  need(name.length >= 3 && name.length <= 120, 'Name: 3–120 characters');
  const active = b.active !== undefined ? !!b.active : old.active;
  try {
    await tx.query('UPDATE b2b_recipient_groups SET name = ?, rule_json = ?, active = ? WHERE id = ?', [name, next.rule ? JSON.stringify(next.rule) : null, active ? 1 : 0, id]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A group called ' + name + ' already exists', 'group_exists'); throw e; }
  if (b.members !== undefined && old.kind === 'list') {
    const found = await directory.resolve(next.members);
    need(found.length === next.members.length, 'Some members were not found', 'unknown_member');
    await tx.query('DELETE FROM b2b_recipient_group_members WHERE group_id = ?', [id]);
    for (const m of next.members) await tx.query('INSERT INTO b2b_recipient_group_members (group_id, recipient_type, recipient_ref) VALUES (?, ?, ?)', [id, m.type, m.ref]);
  }
  await audit.write(tx, actor, { module: 'notifications', action: 'group.updated', entity: 'recipient_group', entityId: id,
    old: { name: old.name, active: old.active, rule: old.rule || null, members: old.members ? old.members.length : null },
    new: { name: name, active: active, rule: next.rule || null, members: next.members ? next.members.length : null } });
  return load(tx, id);
}

/** Recipients of these groups now, for a send ({type, ref} list; the send checks permissions and limits). */
async function expand(principal, ids, cap) {
  const out = [];
  for (const raw of ids) {
    const id = posId(raw);
    const g = id ? await load(null, id) : null;
    if (!g) throw fail(400, 'Unknown group ' + raw, 'unknown_group');
    need(g.active, 'Group ' + g.name + ' is switched off', 'group_inactive');
    typesOf(g).forEach(function (t) { if (!canSendTo(principal, t)) throw fail(403, 'You may not send messages to ' + t + 's', 'audience_forbidden'); });
    (g.kind === 'rule' ? await evaluate(g.rule, cap + 1) : g.members).forEach(function (m) { out.push(m); });
  }
  return out;
}

module.exports = { list, create, update, expand, load, readRule, readMembers, evaluate, MAX_MEMBERS };
