#!/usr/bin/env node
/**
 * Initial role accounts for a LOCAL TRIAL installation — never production.
 *
 * Creates one ready-to-use login for each of the 15 roles, each with its own
 * strong random temporary password that must be changed at the first sign-in
 * (/login asks for a new one; every server refuses other actions until then).
 *
 * Refuses unless ALL of these hold:
 *  - NODE_ENV is not production;
 *  - DB_NAME ends in _local (a NEW trial database, e.g. sakeofhealth_local);
 *  - the MySQL account has no privilege outside that database;
 *  - that database holds only this project's tables (b2b_*), or nothing yet;
 *  - DATA_DIR is set to a trial data folder (not the default live-data folder)
 *    that holds no orders and no customers;
 *  - migrations 013/014 are not in this checkout.
 * With --migrate it applies the project's migrations (001–012, 015) to that new
 * trial database first, and loads the ERP reference data (roles, permissions).
 *
 * Never overwrites: an e-mail that already exists in a store is left untouched
 * and reported as "exists — unchanged". Re-running is safe.
 *
 * Credentials report: written OUTSIDE the project (default ~/sakeofhealth-private/),
 * readable only by you (chmod 600 / Windows icacls), and printed once on screen.
 * The login IDs are e-mail-style names only: no mailbox exists for them.
 *
 * Usage (PowerShell; the MySQL password is asked at a hidden prompt):
 *   $env:DB_HOST="127.0.0.1"; $env:DB_USER="soh_local"; $env:DB_NAME="sakeofhealth_local"
 *   $env:DATA_DIR="$HOME\sakeofhealth-local-data"; $env:B2B_ENABLED="true"; $env:ERP_ENABLED="true"
 *   node scripts\seed-accounts.js --migrate
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DOMAIN = 'sakeofhealth.local';
const MARK = 'LOCAL TEST — not a real business';

/**
 * The 15 role accounts. shop: role in staff.json (shop/trade admin); erp: ERP role code;
 * salesman: also a field-sales record; vendor/business: a supplier or business-portal login.
 */
const PLAN = [
  { n: 1, role: 'Super Admin', id: 'superadmin', shop: 'admin', erp: 'super_admin' },
  { n: 2, role: 'Admin', id: 'admin', shop: 'admin', erp: 'business_admin' },
  { n: 3, role: 'Manager', id: 'manager', shop: 'manager', erp: 'auditor' },
  { n: 4, role: 'Finance', id: 'finance', shop: 'finance', erp: 'finance_manager' },
  { n: 5, role: 'Inventory Manager', id: 'inventory.manager', shop: 'inventory', erp: 'warehouse_manager' },
  { n: 6, role: 'Procurement Manager', id: 'procurement', erp: 'procurement_manager' },
  { n: 7, role: 'Support Staff', id: 'support', shop: 'staff', erp: 'customer_support' },
  { n: 8, role: 'Sales Manager', id: 'sales.manager', shop: 'sales', erp: 'sales_manager' },
  { n: 9, role: 'Salesman', id: 'salesman', erp: 'salesman', salesman: true },
  { n: 10, role: 'Manufacturer', id: 'manufacturer', vendor: 'Manufacturer' },
  { n: 11, role: 'Supplier', id: 'supplier', vendor: 'Supplier' },
  { n: 12, role: 'Distributor', id: 'distributor', business: 'distributor' },
  { n: 13, role: 'Retailer', id: 'retailer', business: 'retailer' },
  { n: 14, role: 'Quality Control Staff', id: 'quality', erp: 'quality_control' },
  { n: 15, role: 'Warehouse Staff', id: 'warehouse', erp: 'inventory_executive' },
];
const emailOf = p => p.id + '@' + DOMAIN;

/** A strong random temporary password: 20 characters, upper/lower/digit/symbol, no look-alikes. */
function newPassword(rand) {
  rand = rand || crypto.randomInt;
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%*-_=+?'];
  const all = sets.join('');
  const chars = sets.map(s => s[rand(s.length)]);
  while (chars.length < 20) chars.push(all[rand(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = rand(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

/** One distinct password per account. */
function passwordsFor(plan, rand) {
  const used = new Set(), out = {};
  for (const p of plan) {
    let pw, tries = 0;
    do {
      if (++tries > 50) throw new Error('the random source keeps repeating passwords — refusing to continue');
      pw = newPassword(rand);
    } while (used.has(pw));
    used.add(pw); out[p.id] = pw;
  }
  return out;
}

/** Reasons not to run (before connecting). Pure. */
function preflight(env, migrationFiles, dataDirInfo) {
  const why = [];
  if (env.NODE_ENV === 'production') why.push('NODE_ENV is production — initial accounts are for local trial installations only.');
  if (!/^[A-Za-z0-9_]+_local$/.test(env.DB_NAME || '')) why.push('DB_NAME must be a new local trial database whose name ends in _local (e.g. sakeofhealth_local).');
  if (!env.DB_USER || env.DB_USER.toLowerCase() === 'root') why.push('DB_USER must be a dedicated account with rights only on the trial database (not root).');
  const held = migrationFiles.filter(f => /^01[34]_/.test(f));
  if (held.length) why.push('migrations ' + held.join(', ') + ' are present in this checkout (D5 pending). Use a fresh copy from the ZIP.');
  if (!env.DATA_DIR) why.push('DATA_DIR must point to a trial data folder (e.g. %USERPROFILE%\\sakeofhealth-local-data), not your live shop data.');
  else if (dataDirInfo.isDefault) why.push('DATA_DIR is the default live-data folder — use a separate trial folder.');
  else if (dataDirInfo.orders || dataDirInfo.customers) why.push('DATA_DIR holds ' + dataDirInfo.orders + ' order(s) and ' + dataDirInfo.customers + ' customer(s) — use an empty trial folder.');
  if (String(env.B2B_ENABLED).toLowerCase() !== 'true' || String(env.ERP_ENABLED).toLowerCase() !== 'true') why.push('Set B2B_ENABLED=true and ERP_ENABLED=true (the role accounts live in the business platform).');
  return why;
}

function inspectDataDir(dir) {
  const def = path.join(os.homedir(), 'sakeofhealth-data');
  const count = f => { try { const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return Array.isArray(a) ? a.length : 0; } catch (e) { return 0; } };
  return { isDefault: !!dir && path.resolve(dir) === path.resolve(def), orders: dir ? count('orders.json') : 0, customers: dir ? count('customers.json') : 0 };
}

/** The credentials report (plain text). Pure. */
function reportText(rows, info) {
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  const lines = [
    'Sake of Health — initial role accounts (LOCAL TRIAL: ' + info.db + ', data folder ' + info.dataDir + ')',
    'Created ' + info.at + '. Keep this file private; delete it once everyone has set their own password.',
    'Sign in at http://localhost:' + (info.port || 3000) + '/login . Each account must choose a new password at its first sign-in.',
    'The login IDs are names only — no e-mail inbox exists for them.', '',
    pad('#', 4) + pad('Role', 24) + pad('Login (e-mail)', 38) + pad('Temporary password', 24) + 'Opens',
  ];
  rows.forEach(r => lines.push(pad(r.n, 4) + pad(r.role, 24) + pad(r.email, 38) + pad(r.password || '(exists — unchanged)', 24) + r.opens));
  return lines.join('\n') + '\n';
}

function opensFor(p) {
  if (p.vendor) return 'Supplier portal (' + p.vendor.toLowerCase() + ')';
  if (p.business) return 'Business portal (' + p.business + ')';
  const parts = [];
  if (p.shop) parts.push('Admin panel: shop/trade (' + p.shop + ')');
  if (p.erp) parts.push('ERP (' + p.erp + ')');
  if (p.salesman) parts.push('Field sales app');
  return parts.join(' + ');
}

/** True when dir is the project folder or inside it (case-insensitive on Windows). */
function insideProject(dir, root, platform) {
  const norm = x => ((platform || process.platform) === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x)).replace(/[\\/]+$/, '');
  const d = norm(dir), r = norm(root);
  return d === r || d.startsWith(r + '/') || d.startsWith(r + '\\');
}

function restrictFile(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (user) require('child_process').spawnSync('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { stdio: 'ignore' });
  } else fs.chmodSync(file, 0o600);
}

/* ── Database work (runs only on the owner's machine) ── */
async function seed(env, passwords, log) {
  const sql = require('../src/db/connection.js');
  const erpSec = require('../src/modules/erp/core/security.js');
  const b2bSec = require('../src/modules/b2b/lib/security.js');
  const adminAuth = require('../src/middleware/adminAuth.js');
  const { db } = require('../src/services/db.js');
  const rows = [], shopLater = [];

  const exists = async (table, email) => !!(await sql.queryOne('SELECT id FROM ' + table + ' WHERE email = ?', [email]));
  await sql.transaction(async function (tx) {
    const ka = await tx.queryOne("SELECT id FROM b2b_states WHERE country_code = 'IN' AND gst_code = '29'");
    for (const p of PLAN) {
      const email = emailOf(p), pw = passwords[p.id];
      let created = false;
      if (p.shop && !db.staff.findOne({ email })) {
        // written to staff.json only after the database part has committed (below)
        shopLater.push({ name: p.role + ' (local test)', email, phone: '', role: p.shop, active: true, passwordHash: adminAuth.hashPassword(pw),
          mustChangePassword: true, createdBy: 'seed-accounts', createdAt: new Date().toISOString() });
        created = true;
      }
      if (p.erp && !(await exists('b2b_staff', email))) {
        const r = await tx.query('INSERT INTO b2b_staff (name, email, password_hash, must_change_password) VALUES (?, ?, ?, 1)', [p.role + ' (local test)', email, erpSec.hashPassword(pw)]);
        const role = await tx.queryOne('SELECT id FROM b2b_roles WHERE code = ?', [p.erp]);
        if (!role) throw new Error('ERP role ' + p.erp + ' is missing — run with --migrate to load the reference data.');
        await tx.query("INSERT INTO b2b_staff_roles (staff_id, role_id, scope_type) VALUES (?, ?, 'all')", [r.insertId, role.id]);
        if (p.salesman) await tx.query('INSERT INTO b2b_salesmen (staff_id) VALUES (?)', [r.insertId]);
        created = true;
      }
      if (p.vendor && !(await exists('b2b_vendor_users', email))) {
        const v = await tx.query("INSERT INTO b2b_vendors (legal_name, status, onboarding) VALUES (?, 'approved', 'invited')", [MARK + ' — ' + p.vendor]);
        await tx.query("INSERT INTO b2b_vendor_users (vendor_id, name, email, mobile, role, status, password_hash, must_change_password) VALUES (?, ?, ?, ?, 'owner', 'active', ?, 1)",
          [v.insertId, p.role + ' (local test)', email, '90000001' + String(p.n).padStart(2, '0'), erpSec.hashPassword(pw)]);
        created = true;
      }
      if (p.business && !(await exists('b2b_users', email))) {
        const a = await tx.query("INSERT INTO b2b_accounts (account_type, business_name, contact_person, mobile, email, address_line1, state_id, district_name, city, pincode, status, approved_at) " +
          "VALUES (?, ?, ?, ?, ?, 'Local trial address', ?, 'Bengaluru Urban', 'Bengaluru', '560001', 'approved', UTC_TIMESTAMP())",
          [p.business, MARK + ' — ' + p.role, p.role + ' (local test)', '90000002' + String(p.n).padStart(2, '0'), email, ka.id]);
        await tx.query('INSERT INTO b2b_users (account_id, name, email, mobile, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)',
          [a.insertId, p.role + ' (local test)', email, '90000002' + String(p.n).padStart(2, '0'), b2bSec.hashPassword(pw), p.business]);
        created = true;
      }
      rows.push({ n: p.n, role: p.role, email, password: created ? pw : null, opens: opensFor(p) });
      log((created ? 'created ' : 'exists, unchanged ') + email);
    }
  });
  shopLater.forEach(r => db.staff.insert(r));
  return rows;
}

async function serverChecks(env) {
  const run = require('./run-mysql-tests.js');
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({ host: env.DB_HOST || '127.0.0.1', port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME });
  try { return (await run.serverChecks(conn, env.DB_NAME)).problems; } finally { await conn.end(); }
}

async function main() {
  const env = process.env, ROOT = path.join(__dirname, '..');
  const why = preflight(env, fs.readdirSync(path.join(ROOT, 'src', 'db', 'migrations')), inspectDataDir(env.DATA_DIR));
  if (why.length) { console.error('Refusing to create accounts:\n - ' + why.join('\n - ')); process.exit(2); }
  if (env.DB_PASSWORD == null) env.DB_PASSWORD = await require('./lib/hidden-prompt.js')('MySQL password for ' + env.DB_USER + ' (hidden): ');
  const problems = await serverChecks(env).catch(e => ['cannot reach the trial database: ' + e.message]);
  if (problems.length) { console.error('Refusing to create accounts:\n - ' + problems.join('\n - ')); process.exit(4); }
  if (process.argv.includes('--migrate')) {
    console.log('Applying migrations to the new trial database ' + env.DB_NAME + ' …');
    await require('../src/db/migrate.js').up();
    await require('../src/db/connection.js').transaction(tx => require('../src/modules/erp/catalog/load.js').apply(tx));
  }
  const rows = await seed(env, passwordsFor(PLAN), t => console.log('  ' + t));
  const dir = path.resolve(env.CREDENTIALS_DIR || path.join(os.homedir(), 'sakeofhealth-private'));
  if (insideProject(dir, ROOT)) { console.error('CREDENTIALS_DIR must be outside the project folder.'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'local-credentials-' + env.DB_NAME + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt');
  const text = reportText(rows, { db: env.DB_NAME, dataDir: env.DATA_DIR, at: new Date().toISOString(), port: env.PORT });
  fs.writeFileSync(file, text, { mode: 0o600 });
  restrictFile(file);
  console.log('\n' + text + '\nSaved (readable only by you): ' + file);
  await require('../src/db/connection.js').close();
}

if (require.main === module) main().catch(e => { console.error('seed-accounts failed: ' + e.message); process.exit(1); });
module.exports = { PLAN, DOMAIN, MARK, emailOf, newPassword, passwordsFor, preflight, inspectDataDir, reportText, opensFor, insideProject, seed };
