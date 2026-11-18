#!/usr/bin/env node
/**
 * Creates the first TWO ERP Super Admins (bootstrap). Every approval needs a
 * second person (maker ≠ checker), so the platform needs two Super Admins to
 * start. Refuses once two active Super Admins exist — after that, people are
 * added and roles granted inside the ERP, with approvals.
 *
 *   ERP_ADMIN_PASSWORD='<12+ chars>' node scripts/erp-create-admin.js --email you@company.com --name "Your Name"
 *
 * The password is read from the environment so it never appears in shell history
 * as an argument. Turn on two-factor sign-in right after the first login: approvals
 * need it.
 */
'use strict';
require('dotenv').config();
const db = require('../src/db/connection.js');
const security = require('../src/modules/erp/core/security.js');
const audit = require('../src/modules/erp/core/audit.js');

function arg(name) { const i = process.argv.indexOf('--' + name); return i === -1 ? '' : String(process.argv[i + 1] || ''); }

(async function () {
  try {
    const email = arg('email').trim().toLowerCase(), name = arg('name').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || !name) throw new Error('Usage: --email <address> --name "<full name>"');
    const hash = security.hashPassword(process.env.ERP_ADMIN_PASSWORD || '');
    await db.transaction(async function (tx) {
      const role = await tx.queryOne("SELECT id FROM b2b_roles WHERE code = 'super_admin' FOR UPDATE");
      if (!role) throw new Error('Reference data not loaded: run scripts/erp-reference-data.js first');
      const existing = await tx.queryOne("SELECT COUNT(*) AS n FROM b2b_staff_roles sr JOIN b2b_staff s ON s.id = sr.staff_id WHERE sr.role_id = ? AND sr.revoked_at IS NULL AND s.status = 'active'", [role.id]);
      if (Number(existing.n) >= 2) throw new Error('Refused: two Super Admins already exist. Add people from inside the ERP.');
      const r = await tx.query('INSERT INTO b2b_staff (name, email, password_hash) VALUES (?, ?, ?)', [name, email, hash]);
      await tx.query("INSERT INTO b2b_staff_roles (staff_id, role_id, scope_type) VALUES (?, ?, 'all')", [r.insertId, role.id]);
      await audit.write(tx, { type: 'system', id: null, role: 'bootstrap' }, { module: 'core', action: 'staff.bootstrap_super_admin', entity: 'staff', entityId: r.insertId, new: { email: email, name: name } });
    });
    console.log('Super Admin created for ' + email + '. Log in at /admin/erp and turn on two-factor sign-in. (Run once more for a second, different person.)');
  } catch (e) {
    console.error(e.message); process.exitCode = 1;
  } finally { await db.close(); }
})();
