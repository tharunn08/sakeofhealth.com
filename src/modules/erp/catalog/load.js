/**
 * Reference data loader (permissions, system roles, their permissions).
 * INSERT IGNORE only: never updates or removes; a role that already exists keeps
 * whatever permissions people have given it. Used by scripts/erp-reference-data.js.
 */
'use strict';
const ref = require('./reference-data.json');
const audit = require('../core/audit.js');

async function plan(q) {
  const haveP = new Set((await q.query('SELECT code FROM b2b_permissions')).map(function (r) { return r.code; }));
  const haveR = {}; (await q.query('SELECT id, code FROM b2b_roles')).forEach(function (r) { haveR[r.code] = Number(r.id); });
  return { haveR: haveR, missingPermissions: ref.permissions.filter(function (p) { return !haveP.has(p.code); }),
    missingRoles: ref.roles.filter(function (r) { return !haveR[r.code]; }) };
}

async function apply(tx) {
  const p = await plan(tx);
  for (const x of ref.permissions) await tx.query('INSERT IGNORE INTO b2b_permissions (code, module, description, is_sensitive) VALUES (?, ?, ?, ?)', [x.code, x.module, x.description, x.is_sensitive ? 1 : 0]);
  let superLinks = 0;
  for (const r of ref.roles) {
    if (p.haveR[r.code]) {
      // Super Admin holds every permission by definition: new permissions of a release are linked to it.
      // Every other existing role keeps exactly what people gave it (changes go through approval).
      if (r.code === 'super_admin') for (const perm of r.permissions) { const x = await tx.query('INSERT IGNORE INTO b2b_role_permissions (role_id, permission_code) VALUES (?, ?)', [p.haveR[r.code], perm]); superLinks += x.affectedRows || 0; }
      continue;
    }
    const ins = await tx.query('INSERT IGNORE INTO b2b_roles (code, name, is_system) VALUES (?, ?, 1)', [r.code, r.name]);
    const id = ins.insertId || Number((await tx.queryOne('SELECT id FROM b2b_roles WHERE code = ?', [r.code])).id);
    for (const perm of r.permissions) await tx.query('INSERT IGNORE INTO b2b_role_permissions (role_id, permission_code) VALUES (?, ?)', [id, perm]);
  }
  await audit.write(tx, audit.SYSTEM, { module: 'core', action: 'reference_data.loaded', entity: 'reference_data', entityId: ref.version,
    new: { permissionsAdded: p.missingPermissions.length, rolesAdded: p.missingRoles.length, superAdminLinksAdded: superLinks } });
  return { permissionsAdded: p.missingPermissions.length, rolesAdded: p.missingRoles.length, superAdminLinksAdded: superLinks };
}

module.exports = { plan, apply, ref };
