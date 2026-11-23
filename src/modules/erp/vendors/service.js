/**
 * Phase 4: vendors (suppliers/manufacturers) and the vendor portal.
 *
 * Tenant isolation: every portal query is filtered by the vendor id taken from the
 * signed-in vendor user's record (re-read on every request) — never from the URL or
 * the body. A vendor asking for another vendor's record gets 404, not 403, so ids
 * cannot be probed.
 *
 * Lifecycle: draft/submitted → under_verification → (more_info_required) → approved.
 * Verification stages are recorded by staff; approval of the vendor itself is a
 * maker-checker request ('vendors.approve') and needs MFA.
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const v = require('../../b2b/lib/validate.js');
const uploads = require('../../b2b/lib/uploads.js');
const security = require('../core/security.js');
const audit = require('../core/audit.js');
const approvals = require('../core/approvals.js');
const monitor = require('../core/monitor.js');
const { fail, posId } = require('../lib/http.js');

const CAPS = ['manufacturer', 'authorised_distributor', 'supplier_wholesaler', 'contract_manufacturer'];   // contract_manufacturer needs migration 020
const DOC_TYPES = ['gst_certificate', 'pan', 'business_registration', 'bank_proof', 'cancelled_cheque', 'fssai_licence', 'other_licence',
  'quality_certificate', 'product_catalogue', 'manufacturer_authorisation', 'contract', 'other'];
const STAGES = ['verification', 'document_review', 'procurement', 'finance_compliance', 'admin'];
const vendorActor = function (u, req) { return { type: 'vendor', id: u.id, label: 'vendor-user:' + u.id, role: 'vendor_' + u.role, ip: req ? String(req.ip || '').slice(0, 45) : null }; };

function cleanVendor(b, partial) {
  const out = {};
  const legal = v.text(b.legalName, 200);
  if (!partial || b.legalName !== undefined) { if (!legal) throw fail(400, 'Legal name is required'); out.legal_name = legal; }
  if (b.tradeName !== undefined) out.trade_name = v.text(b.tradeName, 200) || null;
  if (b.gstin !== undefined) {
    const g = v.upper(b.gstin, 15);
    if (g && !v.isGstin(g)) throw fail(400, 'GSTIN is not valid (format or check digit)');
    out.gstin = g || null;
  }
  if (b.pan !== undefined) { const p = v.upper(b.pan, 10); if (p && !v.isPan(p)) throw fail(400, 'PAN is not valid'); out.pan = p || null; }
  if (out.gstin && out.pan && out.gstin.slice(2, 12) !== out.pan) throw fail(400, 'PAN does not match the GSTIN');
  if (out.gstin && !out.pan) out.pan = out.gstin.slice(2, 12);
  ['cin:cin:30', 'fssaiLicence:fssai_licence:20', 'msmeUdyam:msme_udyam:30', 'website:website:200', 'categoriesNote:categories_note:500', 'brandsNote:brands_note:500'].forEach(function (s) {
    const [k, col, n] = s.split(':'); if (b[k] !== undefined) out[col] = v.text(b[k], Number(n)) || null;
  });
  if (b.fssaiValidTo !== undefined) { const d = v.date(b.fssaiValidTo); if (b.fssaiValidTo && !d) throw fail(400, 'Invalid FSSAI validity date'); out.fssai_valid_to = d; }
  if (b.stateId !== undefined) out.state_id = posId(b.stateId) || null;
  return out;
}

async function stateOfGstin(q, gstin) {
  if (!gstin) return null;
  const s = await q.queryOne('SELECT id FROM b2b_states WHERE gst_code = ?', [gstin.slice(0, 2)]);
  return s ? Number(s.id) : null;
}

// ── self-registration (public, rate-limited at the route) ──
async function register(tx, b, ip) {
  const vendor = cleanVendor(b.vendor || b);
  const caps = pickCaps(b.capabilities);
  const u = b.user || {};
  const name = v.text(u.name, 120), email = v.email(u.email), mobile = v.mobile(u.mobile);
  if (!name || !v.isEmail(email)) throw fail(400, 'Your name and a valid e-mail are required');
  if (!mobile) throw fail(400, 'A valid 10-digit mobile number is required');
  const hash = security.hashPassword(u.password);
  if (vendor.gstin) vendor.state_id = vendor.state_id || await stateOfGstin(tx, vendor.gstin);
  let r;
  try {
    r = await tx.query('INSERT INTO b2b_vendors (' + Object.keys(vendor).concat(['status', 'onboarding']).join(', ') + ') VALUES (' +
      Object.keys(vendor).map(function () { return '?'; }).concat(["'submitted'", "'self'"]).join(', ') + ')', Object.values(vendor));
  } catch (e) {
    // Same answer whether the GSTIN or the e-mail exists: no account discovery.
    if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'We could not register this business. If you already registered, sign in or contact us.', 'registration_refused');
    throw e;
  }
  const vendorId = Number(r.insertId);
  for (const c of caps) await tx.query("INSERT INTO b2b_vendor_capabilities (vendor_id, capability, status) VALUES (?, ?, 'requested')", [vendorId, c]);
  if (b.address && (b.address.line1 || b.address.city || b.address.pincode)) await insertAddress(tx, vendorId, Object.assign({ type: 'registered' }, b.address));
  try {
    await tx.query("INSERT INTO b2b_vendor_users (vendor_id, name, email, mobile, password_hash, role, status) VALUES (?, ?, ?, ?, ?, 'owner', 'active')", [vendorId, name, email, mobile, hash]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'We could not register this business. If you already registered, sign in or contact us.', 'registration_refused');
    throw e;
  }
  await audit.write(tx, { type: 'vendor', id: null, label: email, role: 'vendor_owner', ip: ip }, { module: 'vendors', action: 'vendor.registered', entity: 'vendor', entityId: vendorId,
    new: { legal: vendor.legal_name, gstin: vendor.gstin, capabilities: caps } });
  return { vendorId: vendorId, status: 'submitted' };
}

// ── staff invite: a one-time token (shown once; no e-mail provider is configured) ──
async function invite(tx, actor, b) {
  const vendor = cleanVendor(b);
  const u = b.user || {};
  const name = v.text(u.name, 120), email = v.email(u.email), mobile = v.mobile(u.mobile);
  if (!name || !v.isEmail(email) || !mobile) throw fail(400, 'Contact name, e-mail and mobile are required');
  if (vendor.gstin) vendor.state_id = vendor.state_id || await stateOfGstin(tx, vendor.gstin);
  let r;
  try {
    r = await tx.query('INSERT INTO b2b_vendors (' + Object.keys(vendor).concat(['status', 'onboarding']).join(', ') + ') VALUES (' +
      Object.keys(vendor).map(function () { return '?'; }).concat(["'draft'", "'invited'"]).join(', ') + ')', Object.values(vendor));
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A vendor with this GSTIN already exists'); throw e; }
  const vendorId = Number(r.insertId);
  for (const c of pickCaps(b.capabilities)) await tx.query("INSERT INTO b2b_vendor_capabilities (vendor_id, capability, status) VALUES (?, ?, 'requested')", [vendorId, c]);
  if (b.address && (b.address.line1 || b.address.city || b.address.pincode)) await insertAddress(tx, vendorId, Object.assign({ type: 'registered' }, b.address));
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    await tx.query("INSERT INTO b2b_vendor_users (vendor_id, name, email, mobile, role, status, invite_token_hash, invite_expires_at) VALUES (?, ?, ?, ?, 'owner', 'invited', ?, UTC_TIMESTAMP() + INTERVAL 7 DAY)",
      [vendorId, name, email, mobile, sha(token)]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A vendor user with this e-mail already exists'); throw e; }
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.invited', entity: 'vendor', entityId: vendorId, new: { legal: vendor.legal_name, email: email } });
  return { vendorId: vendorId, inviteToken: token, invitePath: '/vendor-portal/?invite=' + token, expiresInDays: 7,
    note: 'Share this one-time link privately. It is not stored and cannot be shown again.' };
}
function pickCaps(list) {
  const caps = Array.isArray(list) ? list.filter(function (c, i, a) { return CAPS.indexOf(c) !== -1 && a.indexOf(c) === i; }) : [];
  if (!caps.length) throw fail(400, 'Choose at least one: manufacturer, contract manufacturer, authorised distributor or supplier / wholesaler');
  return caps;
}

/** A readable one-time password (shown once to the person who created it; must be changed at first sign-in). */
function temporaryPassword() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) out += abc[bytes[i] % abc.length];
  return out.slice(0, 5) + '-' + out.slice(5, 10) + '-' + out.slice(10) + '7';
}
async function setMustChange(tx, userId) {
  try { await tx.query('UPDATE b2b_vendor_users SET must_change_password = 1 WHERE id = ?', [userId]); return true; }
  catch (e) { if (require('../../../db/mustChange.js').missingColumn(e)) return false; throw e; }
}
async function insertLogin(tx, vendorId, u, role) {
  const name = v.text(u.name, 120), email = v.email(u.email), mobile = v.mobile(u.mobile);
  if (!name || name.length < 2) throw fail(400, 'Give the person\'s name');
  if (!v.isEmail(email)) throw fail(400, 'A valid e-mail is required (it is the sign-in name)');
  if (!mobile) throw fail(400, 'A valid 10-digit mobile number is required');
  if (['owner', 'sales', 'dispatch', 'accounts'].indexOf(role) === -1) throw fail(400, 'Role must be owner, sales, dispatch or accounts');
  const temp = temporaryPassword();
  let r;
  try {
    r = await tx.query("INSERT INTO b2b_vendor_users (vendor_id, name, email, mobile, password_hash, role, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
      [vendorId, name, email, mobile, security.hashPassword(temp), role]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'Someone already signs in with this e-mail'); throw e; }
  const forced = await setMustChange(tx, r.insertId);
  return { userId: Number(r.insertId), email: email, temporaryPassword: temp, mustChangeAtFirstSignIn: forced };
}

/**
 * Staff add a manufacturer or supplier directly, with its owner's sign-in. The temporary password is shown
 * once (never stored in clear, never e-mailed by us); the owner signs in at /login and must choose their own.
 */
async function createWithLogin(tx, actor, b) {
  const vendor = cleanVendor(b);
  const caps = pickCaps(b.capabilities);
  if (vendor.gstin) vendor.state_id = vendor.state_id || await stateOfGstin(tx, vendor.gstin);
  ['paymentTermsDays:payment_terms_days', 'defaultLeadDays:default_lead_days'].forEach(function (x) {
    const [k, col] = x.split(':'); if (b[k] !== undefined && b[k] !== '' && b[k] != null) { const n = Number(b[k]); if (!(Number.isInteger(n) && n >= 0 && n <= 365)) throw fail(400, k + ' must be 0–365 days'); vendor[col] = n; }
  });
  let r;
  try {
    r = await tx.query('INSERT INTO b2b_vendors (' + Object.keys(vendor).concat(['status', 'onboarding']).join(', ') + ') VALUES (' +
      Object.keys(vendor).map(function () { return '?'; }).concat(["'submitted'", "'invited'"]).join(', ') + ')', Object.values(vendor));
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A manufacturer or supplier with this GSTIN already exists'); throw e; }
  const vendorId = Number(r.insertId);
  for (const c of caps) await tx.query("INSERT INTO b2b_vendor_capabilities (vendor_id, capability, status) VALUES (?, ?, 'requested')", [vendorId, c]);
  if (b.address && (b.address.line1 || b.address.city || b.address.pincode)) await insertAddress(tx, vendorId, Object.assign({ type: 'registered' }, b.address));
  const login = await insertLogin(tx, vendorId, b.user || {}, 'owner');
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.created', entity: 'vendor', entityId: vendorId, new: { legal: vendor.legal_name, gstin: vendor.gstin, capabilities: caps, owner: login.email } });
  return { vendorId: vendorId, status: 'submitted', login: login, signInAt: '/login' };
}

// ── addresses (registered office, factory, warehouse, billing) ──
const ADDRESS_TYPES = ['registered', 'factory', 'warehouse', 'billing'];
async function insertAddress(tx, vendorId, b) {
  const type = String(b.type || b.addressType || '');
  if (ADDRESS_TYPES.indexOf(type) === -1) throw fail(400, 'Address type must be registered, factory, warehouse or billing');
  const line1 = v.text(b.line1, 200), city = v.text(b.city, 80), pin = String(b.pincode || '').replace(/\D/g, '');
  if (!line1) throw fail(400, 'Address line 1 is required');
  if (!city) throw fail(400, 'City is required');
  if (!/^[1-9]\d{5}$/.test(pin)) throw fail(400, 'PIN code must be 6 digits');
  const stateId = posId(b.stateId);
  if (!stateId || !(await tx.queryOne('SELECT id FROM b2b_states WHERE id = ?', [stateId]))) throw fail(400, 'Choose the state');
  const num = function (x, lim) { if (x == null || x === '') return null; const n = Number(x); if (!(Math.abs(n) <= lim)) throw fail(400, 'Invalid map position'); return n; };
  const r = await tx.query('INSERT INTO b2b_vendor_addresses (vendor_id, address_type, line1, line2, city, state_id, pincode, latitude, longitude) VALUES (?,?,?,?,?,?,?,?,?)',
    [vendorId, type, line1, v.text(b.line2, 200) || null, city, stateId, pin, num(b.latitude, 90), num(b.longitude, 180)]);
  return Number(r.insertId);
}
async function addAddress(tx, actor, vendorId, b) {
  if (!(await tx.queryOne('SELECT id FROM b2b_vendors WHERE id = ?', [vendorId]))) throw fail(404, 'Vendor not found');
  const addressId = await insertAddress(tx, vendorId, b || {});
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.address_added', entity: 'vendor', entityId: vendorId, new: Object.assign({ addressId: addressId }, b) });
  return { addressId: addressId };
}
async function removeAddress(tx, actor, vendorId, addressId) {
  const a = await tx.queryOne('SELECT * FROM b2b_vendor_addresses WHERE id = ? AND vendor_id = ? FOR UPDATE', [addressId, vendorId]);
  if (!a) throw fail(404, 'Address not found');
  await tx.query('DELETE FROM b2b_vendor_addresses WHERE id = ?', [addressId]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.address_removed', entity: 'vendor', entityId: vendorId, old: a });
  return { ok: true };
}
async function listAddresses(vendorId) {
  const rows = await db.query('SELECT a.id, a.address_type, a.line1, a.line2, a.city, a.state_id, s.name AS state, a.pincode, a.latitude, a.longitude FROM b2b_vendor_addresses a ' +
    'LEFT JOIN b2b_states s ON s.id = a.state_id WHERE a.vendor_id = ? ORDER BY FIELD(a.address_type, \'registered\', \'factory\', \'warehouse\', \'billing\'), a.id', [vendorId]);
  return rows.map(function (a) { return { id: Number(a.id), type: a.address_type, line1: a.line1, line2: a.line2, city: a.city, stateId: Number(a.state_id), state: a.state, pincode: a.pincode,
    latitude: a.latitude == null ? null : Number(a.latitude), longitude: a.longitude == null ? null : Number(a.longitude) }; });
}

// ── bank accounts (masked everywhere; the full number is encrypted at rest) ──
async function listBankAccounts(vendorId) {
  const rows = await db.query('SELECT b.id, b.account_name, b.account_last4, b.ifsc, b.status, b.created_at, st.name AS verified_by_name FROM b2b_vendor_bank_accounts b ' +
    'LEFT JOIN b2b_staff st ON st.id = b.verified_by WHERE b.vendor_id = ? ORDER BY b.id DESC', [vendorId]);
  return rows.map(function (b) { return { id: Number(b.id), accountName: b.account_name, accountMasked: 'XXXX' + b.account_last4, ifsc: b.ifsc, status: b.status, verifiedBy: b.verified_by_name || null, addedAt: b.created_at }; });
}

// ── people who sign in for the vendor ──
async function addUser(tx, actor, vendorId, b) {
  if (!(await tx.queryOne('SELECT id FROM b2b_vendors WHERE id = ?', [vendorId]))) throw fail(404, 'Vendor not found');
  const login = await insertLogin(tx, vendorId, b || {}, String((b || {}).role || 'sales'));
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.user_added', entity: 'vendor', entityId: vendorId, new: { userId: login.userId, email: login.email, role: (b || {}).role } });
  return login;
}
async function resetUserPassword(tx, actor, vendorId, userId) {
  const u = await tx.queryOne("SELECT id, email, status FROM b2b_vendor_users WHERE id = ? AND vendor_id = ? FOR UPDATE", [userId, vendorId]);
  if (!u) throw fail(404, 'User not found');
  if (u.status === 'disabled') throw fail(409, 'Turn the sign-in back on first');
  const temp = temporaryPassword();
  await tx.query("UPDATE b2b_vendor_users SET password_hash = ?, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL, failed_logins = 0, locked_until = NULL, token_version = token_version + 1 WHERE id = ?",
    [security.hashPassword(temp), userId]);
  const forced = await setMustChange(tx, userId);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.user_password_reset', entity: 'vendor', entityId: vendorId, new: { userId: userId } });
  return { userId: userId, email: u.email, temporaryPassword: temp, mustChangeAtFirstSignIn: forced };
}
async function setUserStatus(tx, actor, vendorId, userId, status, byVendorUserId) {
  if (['active', 'disabled'].indexOf(status) === -1) throw fail(400, 'status must be active or disabled');
  const u = await tx.queryOne('SELECT id, role, status, password_hash FROM b2b_vendor_users WHERE id = ? AND vendor_id = ? FOR UPDATE', [userId, vendorId]);
  if (!u) throw fail(404, 'User not found');
  if (byVendorUserId && Number(byVendorUserId) === Number(userId)) throw fail(409, 'You cannot turn off your own sign-in');
  if (status === 'disabled' && u.role === 'owner') {
    const others = await tx.queryOne("SELECT COUNT(*) AS n FROM b2b_vendor_users WHERE vendor_id = ? AND role = 'owner' AND status = 'active' AND id <> ?", [vendorId, userId]);
    if (!Number(others.n)) throw fail(409, 'This is the only active owner. Add another owner first.');
  }
  if (status === 'active' && !u.password_hash) throw fail(409, 'This person has not set a password yet: reset the password instead');
  await tx.query('UPDATE b2b_vendor_users SET status = ?, token_version = token_version + 1 WHERE id = ?', [status, userId]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.user_' + status, entity: 'vendor', entityId: vendorId, old: { status: u.status }, new: { userId: userId, status: status } });
  return { userId: userId, status: status };
}
async function listUsers(vendorId) {
  const rows = await db.query('SELECT * FROM b2b_vendor_users WHERE vendor_id = ? ORDER BY role = \'owner\' DESC, id', [vendorId]);
  return rows.map(function (u) { return { id: Number(u.id), name: u.name, email: u.email, mobile: u.mobile, role: u.role, status: u.status, lastLoginAt: u.last_login_at,
    mustChangePassword: Number(u.must_change_password) === 1, locked: !!(u.locked_until && new Date(u.locked_until).getTime() > Date.now()), invited: u.status === 'invited' }; });
}

// ── staff edit of the vendor record (identity changes re-checked; all audited) ──
async function staffUpdate(tx, actor, vendorId, b) {
  const old = await tx.queryOne('SELECT * FROM b2b_vendors WHERE id = ? FOR UPDATE', [vendorId]);
  if (!old) throw fail(404, 'Vendor not found');
  const set = cleanVendor(b, true);
  ['paymentTermsDays:payment_terms_days', 'defaultLeadDays:default_lead_days'].forEach(function (x) {
    const [k, col] = x.split(':');
    if (b[k] === undefined) return;
    if (b[k] === '' || b[k] == null) { set[col] = null; return; }
    const n = Number(b[k]); if (!(Number.isInteger(n) && n >= 0 && n <= 365)) throw fail(400, 'Days must be 0–365'); set[col] = n;
  });
  if (b.creditTermsNote !== undefined) set.credit_terms_note = v.text(b.creditTermsNote, 255) || null;
  if (b.capabilitiesNote !== undefined) set.capabilities_note = v.text(b.capabilitiesNote, 1000) || null;
  if (set.gstin && set.gstin !== old.gstin && b.stateId === undefined) set.state_id = await stateOfGstin(tx, set.gstin);
  if (!Object.keys(set).length) throw fail(400, 'Nothing to change');
  try {
    await tx.query('UPDATE b2b_vendors SET ' + Object.keys(set).map(function (k) { return k + ' = ?'; }).join(', ') + ' WHERE id = ?', Object.values(set).concat([vendorId]));
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'Another manufacturer or supplier has this GSTIN'); throw e; }
  const before = {}; Object.keys(set).forEach(function (k) { before[k] = old[k]; });
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.updated', entity: 'vendor', entityId: vendorId, old: before, new: set, reason: b.reason || null });
  return { vendorId: vendorId, changed: Object.keys(set) };
}

/** Approve, reject or suspend one capability (e.g. a supplier who later asks to be a contract manufacturer). */
async function decideCapability(tx, actor, vendorId, b) {
  const cap = String(b.capability || ''), status = String(b.status || '');
  if (CAPS.indexOf(cap) === -1) throw fail(400, 'Unknown capability');
  if (['approved', 'rejected', 'suspended'].indexOf(status) === -1) throw fail(400, 'status must be approved, rejected or suspended');
  const vd = await tx.queryOne('SELECT status FROM b2b_vendors WHERE id = ?', [vendorId]);
  if (!vd) throw fail(404, 'Vendor not found');
  if (status === 'approved' && vd.status !== 'approved') throw fail(409, 'Approve the business first (all verification stages)');
  const c = await tx.queryOne('SELECT status FROM b2b_vendor_capabilities WHERE vendor_id = ? AND capability = ? FOR UPDATE', [vendorId, cap]);
  if (!c) throw fail(404, 'This capability was not requested');
  await tx.query('UPDATE b2b_vendor_capabilities SET status = ?, decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE vendor_id = ? AND capability = ?', [status, actor.id, vendorId, cap]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.capability_' + status, entity: 'vendor', entityId: vendorId, old: { capability: cap, status: c.status }, new: { capability: cap, status: status }, reason: b.note || null });
  return { capability: cap, status: status };
}
/** The vendor asks for another capability; our team decides. */
async function requestCapability(tx, vendor, cap) {
  if (CAPS.indexOf(cap) === -1) throw fail(400, 'Unknown capability');
  const c = await tx.queryOne('SELECT status FROM b2b_vendor_capabilities WHERE vendor_id = ? AND capability = ?', [vendor.vendorId, cap]);
  if (c && c.status !== 'rejected') throw fail(409, 'Already ' + c.status);
  if (c) await tx.query("UPDATE b2b_vendor_capabilities SET status = 'requested', decided_by = NULL, decided_at = NULL WHERE vendor_id = ? AND capability = ?", [vendor.vendorId, cap]);
  else await tx.query("INSERT INTO b2b_vendor_capabilities (vendor_id, capability, status) VALUES (?, ?, 'requested')", [vendor.vendorId, cap]);
  await audit.write(tx, vendorActor({ id: vendor.userId, role: vendor.role }), { module: 'vendors', action: 'vendor.capability_requested', entity: 'vendor', entityId: vendor.vendorId, new: { capability: cap } });
  return { capability: cap, status: 'requested' };
}
function sha(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

async function acceptInvite(tx, token, password, ip) {
  const u = await tx.queryOne("SELECT * FROM b2b_vendor_users WHERE invite_token_hash = ? AND status = 'invited' AND invite_expires_at > UTC_TIMESTAMP() FOR UPDATE", [sha(token)]);
  if (!u) throw fail(400, 'This invitation link is not valid or has expired');
  await tx.query("UPDATE b2b_vendor_users SET password_hash = ?, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL WHERE id = ?", [security.hashPassword(password), u.id]);
  await tx.query("UPDATE b2b_vendors SET status = 'submitted' WHERE id = ? AND status = 'draft'", [u.vendor_id]);
  await audit.write(tx, vendorActor(u, { ip: ip }), { module: 'vendors', action: 'vendor.invite_accepted', entity: 'vendor', entityId: u.vendor_id });
  return { ok: true };
}

// ── vendor login and request principal ──
/** opts.countFailure — false only from the central sign-in when another account accepted this password. */
async function login(email, password, ip, opts) {
  opts = opts || {};
  email = v.email(email);
  const generic = fail(401, 'Invalid email or password', 'bad_credentials');
  if (!email || !password) throw generic;
  const u = await db.queryOne('SELECT u.*, vd.status AS vendor_status FROM b2b_vendor_users u JOIN b2b_vendors vd ON vd.id = u.vendor_id WHERE u.email = ?', [email]);
  if (!u || u.status !== 'active' || !u.password_hash) { security.burnTime(password); throw generic; }
  if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) throw fail(423, 'Too many failed attempts. Try again in 15 minutes.', 'locked');
  if (['rejected', 'suspended'].indexOf(u.vendor_status) !== -1) { security.burnTime(password); throw generic; }
  if (!security.verifyPassword(password, u.password_hash)) {
    if (opts.countFailure === false) throw generic;
    await db.query('UPDATE b2b_vendor_users SET locked_until = IF(failed_logins + 1 >= 5, UTC_TIMESTAMP() + INTERVAL 15 MINUTE, locked_until), failed_logins = failed_logins + 1 WHERE id = ?', [u.id]);
    await monitor.event('auth', 'warning', 'vendor_login_failed', 'Failed vendor login', { actorType: 'vendor', actorId: u.id, ip: ip });
    throw generic;
  }
  await db.query('UPDATE b2b_vendor_users SET failed_logins = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [u.id]);
  return { token: security.sign({ vu: Number(u.id), tv: Number(u.token_version) }, null, 'vendor'), vendorStatus: u.vendor_status,
    user: { id: Number(u.id), name: u.name, email: u.email }, mustChangePassword: Number(u.must_change_password) === 1 };
}

function requireVendor(req, res, next) {
  const a = req.headers['authorization'] || '';
  const p = security.verify(a.startsWith('Bearer ') ? a.slice(7) : '', null, 'vendor');
  if (!p || !p.vu) return res.status(401).json({ error: 'Please log in to continue' });
  db.queryOne("SELECT u.id, u.vendor_id, u.name, u.email, u.role, u.status, u.token_version, vd.status AS vendor_status, vd.legal_name FROM b2b_vendor_users u " +
    'JOIN b2b_vendors vd ON vd.id = u.vendor_id WHERE u.id = ?', [p.vu]).then(function (u) {
    if (!u || u.status !== 'active' || Number(u.token_version) !== Number(p.tv) || ['rejected', 'suspended'].indexOf(u.vendor_status) !== -1) {
      return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
    }
    req.vendor = { userId: Number(u.id), vendorId: Number(u.vendor_id), role: u.role, status: u.vendor_status, name: u.name, email: u.email, legalName: u.legal_name };
    return require('../../../db/mustChange.js').get('vendor', u.id).then(function (must) {
      // A temporary password must be replaced first (at /login) before the supplier portal can be used.
      if (must) return res.status(403).json(require('../../../db/mustChange.js').REQUIRED);
      next();
    });
  }).catch(next);
}
/** Trading actions (quotes, acknowledgements, dispatch notices) only for approved vendors. */
function requireApprovedVendor(req, res, next) {
  if (!req.vendor || req.vendor.status !== 'approved') return res.status(403).json({ error: 'Your business must be approved before you can trade', code: 'vendor_not_approved' });
  next();
}
function vendorRole(roles) {
  return function (req, res, next) {
    if (roles.indexOf(req.vendor.role) === -1) return res.status(403).json({ error: 'Your vendor role cannot do this' });
    next();
  };
}

async function me(vendor) {
  const vd = await db.queryOne('SELECT id, vendor_code, legal_name, trade_name, gstin, pan, fssai_licence, fssai_valid_to, website, categories_note, brands_note, capabilities_note, default_lead_days, status, onboarding, payment_terms_days, state_id, created_at FROM b2b_vendors WHERE id = ?', [vendor.vendorId]);
  const caps = await db.query('SELECT capability, status FROM b2b_vendor_capabilities WHERE vendor_id = ?', [vendor.vendorId]);
  const docs = await db.query('SELECT id, doc_type, original_name, review_status, review_note, valid_to, created_at FROM b2b_vendor_documents WHERE vendor_id = ? ORDER BY id', [vendor.vendorId]);
  const u = await db.queryOne('SELECT name, mobile FROM b2b_vendor_users WHERE id = ?', [vendor.userId]);
  const out = { user: { id: vendor.userId, name: u ? u.name : vendor.name, mobile: u ? u.mobile : null, email: vendor.email, role: vendor.role }, vendor: vd, capabilities: caps, documents: docs,
    addresses: await listAddresses(vendor.vendorId) };
  if (vendor.role === 'owner' || vendor.role === 'accounts') out.bankAccounts = await listBankAccounts(vendor.vendorId);
  if (vendor.role === 'owner') out.users = (await listUsers(vendor.vendorId)).map(function (x) { return { id: x.id, name: x.name, email: x.email, mobile: x.mobile, role: x.role, status: x.status, lastLoginAt: x.lastLoginAt }; });
  return out;
}

/** Checks before the file is stored (so a bad request stores nothing). */
function checkDocumentRequest(file, b) {
  if (!file) throw fail(400, 'Attach the document as "file"');
  const type = String((b || {}).docType || '');
  if (DOC_TYPES.indexOf(type) === -1) throw fail(400, 'docType must be one of ' + DOC_TYPES.join(', '));
  return type;
}
/** saved = the stored file (uploads.withDocument stores it before this transaction and removes it if this fails). */
async function uploadDocument(tx, vendor, saved, b, ip) {
  const type = checkDocumentRequest(saved, b);
  const validTo = b.validTo ? v.date(b.validTo) : null;
  const r = await tx.query('INSERT INTO b2b_vendor_documents (vendor_id, doc_type, original_name, stored_name, mime_type, size_bytes, sha256, valid_to, uploaded_by_vendor_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [vendor.vendorId, type, saved.originalName, saved.storedName, saved.mime, saved.size, saved.sha256, validTo, vendor.userId]);
  await audit.write(tx, vendorActor({ id: vendor.userId, role: vendor.role }, { ip: ip }), { module: 'vendors', action: 'vendor.document_uploaded', entity: 'vendor', entityId: vendor.vendorId,
    new: { documentId: Number(r.insertId), type: type, sha256: saved.sha256 } });
  return { documentId: Number(r.insertId), reviewStatus: 'pending' };
}

async function submitProduct(tx, vendor, b) {
  const name = v.text(b.name, 255);
  if (!name) throw fail(400, 'Product name is required');
  const hsn = b.hsnCode ? String(b.hsnCode).replace(/\D/g, '') : null;
  if (hsn && !/^\d{4,8}$/.test(hsn)) throw fail(400, 'HSN must be 4–8 digits');
  const num = function (x, max) { if (x == null || x === '') return null; const n = Number(x); if (!(n >= 0 && n <= max)) throw fail(400, 'Invalid number'); return n; };
  let r;
  try {
    r = await tx.query("INSERT INTO b2b_vendor_products (vendor_id, vendor_sku, sap_code, name, brand, hsn_code, gst_rate_claimed, mrp, pack_size, shelf_life_days, moq, lead_days, specs_json, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'submitted')",
      [vendor.vendorId, v.text(b.vendorSku, 60) || null, v.text(b.sapCode, 30) || null, name, v.text(b.brand, 100) || null, hsn, num(b.gstRate, 40), num(b.mrp, 1e7),
        v.text(b.packSize, 60) || null, num(b.shelfLifeDays, 3650), num(b.moq, 1e6), num(b.leadDays, 365), b.specs ? JSON.stringify(b.specs).slice(0, 5000) : null]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'You already submitted a product with this SKU'); throw e; }
  await audit.write(tx, vendorActor({ id: vendor.userId, role: vendor.role }), { module: 'vendors', action: 'vendor_product.submitted', entity: 'vendor_product', entityId: r.insertId, new: { vendorId: vendor.vendorId, name: name } });
  return { vendorProductId: Number(r.insertId), status: 'submitted' };
}

async function submitPrice(tx, vendor, b) {
  const vp = await tx.queryOne("SELECT id, status FROM b2b_vendor_products WHERE id = ? AND vendor_id = ?", [posId(b.vendorProductId), vendor.vendorId]);
  if (!vp) throw fail(404, 'Product not found');
  const price = Number(b.unitPrice), gst = Number(b.gstRate);
  if (!(price > 0 && price < 1e7)) throw fail(400, 'unitPrice must be positive');
  if ([0, 0.25, 3, 5, 12, 18, 28, 40].indexOf(gst) === -1) throw fail(400, 'gstRate is not a GST slab');
  const from = v.date(b.validFrom); if (!from) throw fail(400, 'validFrom is required (YYYY-MM-DD)');
  const to = b.validTo ? v.date(b.validTo) : null;
  if (to && to < from) throw fail(400, 'validTo is before validFrom');
  const disc = Number(b.discountPct || 0), freight = Number(b.freightPerUnit || 0);
  if (!(disc >= 0 && disc < 100) || !(freight >= 0)) throw fail(400, 'Invalid discount or freight');
  const r = await tx.query("INSERT INTO b2b_vendor_price_lists (vendor_id, vendor_product_id, unit_price, gst_rate, discount_pct, freight_per_unit, moq, lead_days, payment_terms_days, valid_from, valid_to, status) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'submitted')",
    [vendor.vendorId, vp.id, price.toFixed(4), gst.toFixed(2), disc.toFixed(4), freight.toFixed(4), posId(b.moq) || null, posId(b.leadDays) || null, posId(b.paymentTermsDays) || null, from, to]);
  await audit.write(tx, vendorActor({ id: vendor.userId, role: vendor.role }), { module: 'vendors', action: 'vendor_price.submitted', entity: 'vendor_product', entityId: vp.id, new: b });
  return { vendorPriceId: Number(r.insertId), status: 'submitted' };
}

// ── staff side ──
async function list(q) {
  const where = ['1=1'], params = [];
  if (q.status) { where.push('vd.status = ?'); params.push(String(q.status).slice(0, 30)); }
  if (q.capability) { where.push('EXISTS (SELECT 1 FROM b2b_vendor_capabilities c2 WHERE c2.vendor_id = vd.id AND c2.capability = ?)'); params.push(String(q.capability).slice(0, 40)); }
  if (q.q) { const t = '%' + String(q.q).replace(/[\\%_]/g, '\\$&').slice(0, 80) + '%'; where.push('(vd.legal_name LIKE ? OR vd.trade_name LIKE ? OR vd.gstin LIKE ? OR vd.vendor_code LIKE ? OR EXISTS (SELECT 1 FROM b2b_vendor_users u2 WHERE u2.vendor_id = vd.id AND (u2.email LIKE ? OR u2.mobile LIKE ? OR u2.name LIKE ?)))'); params.push(t, t, t, t, t, t, t); }
  const rows = await db.query('SELECT vd.id, vd.vendor_code, vd.legal_name, vd.trade_name, vd.gstin, vd.status, vd.onboarding, vd.created_at, vd.approved_at, ' +
    "(SELECT GROUP_CONCAT(CONCAT(c.capability, ':', c.status)) FROM b2b_vendor_capabilities c WHERE c.vendor_id = vd.id) AS capabilities, " +
    "(SELECT COUNT(*) FROM b2b_vendor_documents d WHERE d.vendor_id = vd.id AND d.review_status = 'pending') AS docs_pending, " +
    "(SELECT COUNT(*) FROM b2b_vendor_bank_accounts ba WHERE ba.vendor_id = vd.id AND ba.status = 'pending') AS banks_pending, " +
    "(SELECT COUNT(*) FROM b2b_vendor_products p WHERE p.vendor_id = vd.id AND p.status IN ('submitted','under_review')) AS products_pending, " +
    "(SELECT CONCAT(u.name, '|', u.email, '|', u.mobile, '|', u.status, '|', COALESCE(u.last_login_at, '')) FROM b2b_vendor_users u WHERE u.vendor_id = vd.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner, " +
    "(SELECT CONCAT(a.city, '|', COALESCE(s.name, '')) FROM b2b_vendor_addresses a LEFT JOIN b2b_states s ON s.id = a.state_id WHERE a.vendor_id = vd.id ORDER BY a.address_type = 'registered' DESC, a.id LIMIT 1) AS place " +
    'FROM b2b_vendors vd WHERE ' + where.join(' AND ') + ' ORDER BY vd.id DESC LIMIT ' + db.int(q.limit, 100, 1, 500), params);
  const counts = await db.query('SELECT status, COUNT(*) AS n FROM b2b_vendors GROUP BY status');
  const byStatus = {}; counts.forEach(function (c) { byStatus[c.status] = Number(c.n); });
  return { items: rows.map(function (r) {
    const o = r.owner ? String(r.owner).split('|') : null, pl = r.place ? String(r.place).split('|') : null;
    return Object.assign({}, r, { docs_pending: Number(r.docs_pending), banks_pending: Number(r.banks_pending), products_pending: Number(r.products_pending),
      owner: o ? { name: o[0], email: o[1], mobile: o[2], status: o[3], lastLoginAt: o[4] || null } : null, city: pl ? pl[0] : null, state: pl ? pl[1] || null : null });
  }), byStatus: byStatus };
}

async function detail(id) {
  const vd = await db.queryOne('SELECT * FROM b2b_vendors WHERE id = ?', [id]);
  if (!vd) throw fail(404, 'Vendor not found');
  return {
    vendor: vd,
    capabilities: await db.query('SELECT * FROM b2b_vendor_capabilities WHERE vendor_id = ?', [id]),
    users: await listUsers(id),
    addresses: await listAddresses(id),
    bankAccounts: await listBankAccounts(id),
    prices: await db.query('SELECT pl.id, pl.vendor_product_id, vp.name AS product, pl.unit_price, pl.gst_rate, pl.discount_pct, pl.freight_per_unit, pl.moq, pl.lead_days, pl.payment_terms_days, pl.valid_from, pl.valid_to, pl.status, pl.created_at ' +
      'FROM b2b_vendor_price_lists pl JOIN b2b_vendor_products vp ON vp.id = pl.vendor_product_id WHERE pl.vendor_id = ? ORDER BY pl.id DESC LIMIT 300', [id]),
    state: vd.state_id ? await db.queryOne('SELECT id, name, gst_code FROM b2b_states WHERE id = ?', [vd.state_id]) : null,
    trade: await tradeSummary(id),
    documents: await db.query('SELECT id, doc_type, original_name, mime_type, size_bytes, sha256, valid_to, review_status, review_note, created_at FROM b2b_vendor_documents WHERE vendor_id = ?', [id]),
    verifications: await db.query('SELECT stage, outcome, note, staff_id, created_at FROM b2b_vendor_verifications WHERE vendor_id = ? ORDER BY id', [id]),
    products: await db.query('SELECT vp.*, p.sku AS mapped_sku, p.name AS mapped_name FROM b2b_vendor_products vp LEFT JOIN b2b_products p ON p.id = vp.product_id WHERE vp.vendor_id = ? ORDER BY vp.id DESC LIMIT 500', [id]),
  };
}
/** Purchase orders, manufacturing orders, deliveries and bills with this vendor (each read only if its module's tables exist). */
async function tradeSummary(id) {
  const one = async function (sql) { try { return await db.queryOne(sql, [id]); } catch (e) { if (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146 || e.errno === 1054) return null; throw e; } };
  const po = await one("SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS v, SUM(status IN ('sent','accepted','partially_accepted','partially_received')) AS open_n FROM b2b_purchase_orders WHERE vendor_id = ?");
  const mo = await one("SELECT COUNT(*) AS n, SUM(status IN ('released','accepted','in_production')) AS open_n FROM b2b_mfg_orders WHERE vendor_id = ?");
  const asn = await one("SELECT COUNT(*) AS n, SUM(status IN ('dispatched','arrived')) AS open_n FROM b2b_asns WHERE vendor_id = ?");
  return {
    purchaseOrders: po ? { count: Number(po.n), open: Number(po.open_n || 0), value: Number(po.v) } : null,
    manufacturingOrders: mo ? { count: Number(mo.n), open: Number(mo.open_n || 0) } : null,
    deliveries: asn ? { count: Number(asn.n), inTransit: Number(asn.open_n || 0) } : null,
  };
}

async function reviewDocument(tx, actor, vendorId, docId, b) {
  const d = await tx.queryOne('SELECT id FROM b2b_vendor_documents WHERE id = ? AND vendor_id = ?', [docId, vendorId]);
  if (!d) throw fail(404, 'Document not found');
  if (['accepted', 'rejected'].indexOf(b.status) === -1) throw fail(400, 'status must be accepted or rejected');
  await tx.query('UPDATE b2b_vendor_documents SET review_status = ?, review_note = ?, reviewed_by = ? WHERE id = ?', [b.status, v.text(b.note, 255) || null, actor.id, docId]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.document_' + b.status, entity: 'vendor', entityId: vendorId, new: { documentId: docId, note: b.note } });
  return { documentId: docId, status: b.status };
}

/** Sends a vendor document; false = the stored file is missing. */
function sendDocument(res, doc, headers, before) { return uploads.sendDocument(res, doc.stored_name, headers, before); }

async function recordVerification(tx, actor, vendorId, b) {
  const vd = await tx.queryOne('SELECT id, status FROM b2b_vendors WHERE id = ? FOR UPDATE', [vendorId]);
  if (!vd) throw fail(404, 'Vendor not found');
  if (STAGES.indexOf(b.stage) === -1) throw fail(400, 'stage must be one of ' + STAGES.join(', '));
  if (['passed', 'failed', 'more_info_required'].indexOf(b.outcome) === -1) throw fail(400, 'outcome must be passed, failed or more_info_required');
  if (['approved', 'rejected', 'suspended'].indexOf(vd.status) !== -1) throw fail(409, 'Vendor is ' + vd.status);
  if (b.outcome !== 'passed' && (!b.note || String(b.note).trim().length < 5)) throw fail(400, 'Explain what is missing or wrong (note)');
  await tx.query('INSERT INTO b2b_vendor_verifications (vendor_id, stage, outcome, note, staff_id) VALUES (?, ?, ?, ?, ?)', [vendorId, b.stage, b.outcome, v.text(b.note, 500) || null, actor.id]);
  let status = vd.status === 'draft' ? 'draft' : 'under_verification', approval = null;
  if (b.outcome === 'more_info_required') status = 'more_info_required';
  if (b.outcome === 'failed') status = 'rejected';
  if (b.stage === 'admin' && b.outcome === 'passed') {
    const passed = await tx.query("SELECT DISTINCT stage FROM b2b_vendor_verifications v1 WHERE vendor_id = ? AND outcome = 'passed' AND NOT EXISTS " +
      "(SELECT 1 FROM b2b_vendor_verifications v2 WHERE v2.vendor_id = v1.vendor_id AND v2.stage = v1.stage AND v2.id > v1.id AND v2.outcome <> 'passed')", [vendorId]);
    const have = passed.map(function (p) { return p.stage; });
    const missing = STAGES.filter(function (s) { return have.indexOf(s) === -1; });
    if (missing.length) throw fail(409, 'These stages have not passed yet: ' + missing.join(', '), 'stages_incomplete');
    const pendingDocs = await tx.queryOne("SELECT COUNT(*) AS n FROM b2b_vendor_documents WHERE vendor_id = ? AND review_status = 'pending'", [vendorId]);
    if (Number(pendingDocs.n)) throw fail(409, 'Review every uploaded document first', 'documents_pending');
    approval = await approvals.request(tx, actor, { type: 'vendors.approve', entity: 'vendor', entityId: vendorId, reason: b.note || 'All verification stages passed', payload: { vendorId: vendorId } });
  }
  await tx.query('UPDATE b2b_vendors SET status = ? WHERE id = ?', [status, vendorId]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.verification', entity: 'vendor', entityId: vendorId, old: { status: vd.status }, new: { stage: b.stage, outcome: b.outcome, status: status }, reason: b.note });
  return { vendorId: vendorId, status: status, approval: approval };
}
approvals.register('vendors.approve', async function (tx, req, actor) {
  const vd = await tx.queryOne('SELECT id, status FROM b2b_vendors WHERE id = ? FOR UPDATE', [req.entityId]);
  if (!vd || ['rejected', 'suspended', 'approved'].indexOf(vd.status) !== -1) throw fail(409, 'Vendor can no longer be approved (' + (vd && vd.status) + ')');
  const code = 'V' + String(vd.id).padStart(5, '0');
  await tx.query("UPDATE b2b_vendors SET status = 'approved', vendor_code = COALESCE(vendor_code, ?), approved_at = UTC_TIMESTAMP(), approved_by = ? WHERE id = ?", [code, req.requestedBy, vd.id]);
  await tx.query("UPDATE b2b_vendor_capabilities SET status = 'approved', decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE vendor_id = ? AND status = 'requested'", [actor.id, vd.id]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.approved', entity: 'vendor', entityId: vd.id, approvalId: req.id });
  return { vendorId: Number(vd.id), status: 'approved', vendorCode: code };
});

async function setStatus(tx, actor, vendorId, status, reason) {
  if (['suspended'].indexOf(status) === -1) throw fail(400, 'Only suspension is immediate; re-approval goes through verification');
  if (!reason || String(reason).trim().length < 5) throw fail(400, 'A reason is required');
  const vd = await tx.queryOne('SELECT status FROM b2b_vendors WHERE id = ? FOR UPDATE', [vendorId]);
  if (!vd) throw fail(404, 'Vendor not found');
  await tx.query("UPDATE b2b_vendors SET status = 'suspended' WHERE id = ?", [vendorId]);
  await tx.query('UPDATE b2b_vendor_users SET token_version = token_version + 1 WHERE vendor_id = ?', [vendorId]);   // ends every portal session now
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.suspended', entity: 'vendor', entityId: vendorId, old: vd, reason: reason });
  return { vendorId: vendorId, status: 'suspended' };
}

async function decideProduct(tx, actor, vpId, b) {
  const vp = await tx.queryOne('SELECT vp.*, vd.status AS vendor_status FROM b2b_vendor_products vp JOIN b2b_vendors vd ON vd.id = vp.vendor_id WHERE vp.id = ? FOR UPDATE', [vpId]);
  if (!vp) throw fail(404, 'Vendor product not found');
  if (['submitted', 'under_review'].indexOf(vp.status) === -1) throw fail(409, 'Already ' + vp.status);
  if (b.decision === 'approved') {
    if (vp.vendor_status !== 'approved') throw fail(409, 'Approve the vendor first');
    const productId = posId(b.productId);
    if (!productId || !(await tx.queryOne('SELECT id FROM b2b_products WHERE id = ?', [productId]))) throw fail(400, 'Map it to an existing product (productId); new products are created through a price list import');
    await tx.query("UPDATE b2b_vendor_products SET status = 'approved', product_id = ?, reviewed_by = ?, review_note = ? WHERE id = ?", [productId, actor.id, v.text(b.note, 255) || null, vpId]);
  } else if (b.decision === 'rejected') {
    if (!b.note) throw fail(400, 'Say why (note)');
    await tx.query("UPDATE b2b_vendor_products SET status = 'rejected', reviewed_by = ?, review_note = ? WHERE id = ?", [actor.id, v.text(b.note, 255), vpId]);
  } else throw fail(400, 'decision must be approved or rejected');
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor_product.' + b.decision, entity: 'vendor_product', entityId: vpId, new: { productId: b.productId, note: b.note } });
  return { vendorProductId: vpId, status: b.decision };
}

async function decidePrice(tx, actor, priceId, b) {
  const p = await tx.queryOne("SELECT pl.*, vp.status AS vp_status FROM b2b_vendor_price_lists pl JOIN b2b_vendor_products vp ON vp.id = pl.vendor_product_id WHERE pl.id = ? FOR UPDATE", [priceId]);
  if (!p) throw fail(404, 'Not found');
  if (p.status !== 'submitted') throw fail(409, 'Already ' + p.status);
  if (b.decision === 'accepted' && p.vp_status !== 'approved') throw fail(409, 'Approve the product first');
  if (['accepted', 'rejected'].indexOf(b.decision) === -1) throw fail(400, 'decision must be accepted or rejected');
  await tx.query('UPDATE b2b_vendor_price_lists SET status = ?, reviewed_by = ? WHERE id = ?', [b.decision, actor.id, priceId]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor_price.' + b.decision, entity: 'vendor_price', entityId: priceId, reason: b.note });
  return { vendorPriceId: priceId, status: b.decision };
}

async function addBankAccount(tx, actor, vendorId, b) {
  const no = String(b.accountNo || '').replace(/\s/g, '');
  if (!/^\d{9,18}$/.test(no)) throw fail(400, 'Account number must be 9–18 digits');
  const ifsc = v.upper(b.ifsc, 11);
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw fail(400, 'IFSC is not valid');
  const name = v.text(b.accountName, 160); if (!name) throw fail(400, 'Account holder name is required');
  if (!(await tx.queryOne('SELECT id FROM b2b_vendors WHERE id = ?', [vendorId]))) throw fail(404, 'Vendor not found');
  const r = await tx.query("INSERT INTO b2b_vendor_bank_accounts (vendor_id, account_name, account_no_enc, account_last4, ifsc, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    [vendorId, name, security.encrypt(no), no.slice(-4), ifsc]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.bank_added', entity: 'vendor', entityId: vendorId, new: { bankAccountId: Number(r.insertId), last4: no.slice(-4), ifsc: ifsc } });
  return { bankAccountId: Number(r.insertId), status: 'pending' };
}
async function verifyBankAccount(tx, actor, vendorId, bankId, b) {
  const ba = await tx.queryOne('SELECT id, status FROM b2b_vendor_bank_accounts WHERE id = ? AND vendor_id = ? FOR UPDATE', [bankId, vendorId]);
  if (!ba) throw fail(404, 'Not found');
  if (ba.status !== 'pending') throw fail(409, 'Already ' + ba.status);
  // the staff member who added this account cannot verify it (an account the vendor added can be verified by any checker)
  const added = await tx.queryOne("SELECT actor_type, actor_id FROM b2b_audit_logs WHERE action = 'vendor.bank_added' AND entity = 'vendor' AND entity_id = ? AND new_value LIKE ? ORDER BY id DESC LIMIT 1",
    [String(vendorId), '{"bankAccountId":' + Number(bankId) + ',%']);
  if (added && added.actor_type === 'admin' && Number(added.actor_id) === Number(actor.id)) throw fail(403, 'The person who added the bank account cannot verify it', 'maker_cannot_check');
  const status = b.status === 'verified' ? 'verified' : (b.status === 'rejected' ? 'rejected' : null);
  if (!status) throw fail(400, 'status must be verified or rejected');
  await tx.query('UPDATE b2b_vendor_bank_accounts SET status = ?, verified_by = ? WHERE id = ?', [status, actor.id, bankId]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.bank_' + status, entity: 'vendor', entityId: vendorId, new: { bankAccountId: bankId }, reason: b.note });
  return { bankAccountId: bankId, status: status };
}

/** The vendor's own product submissions, each with its latest price submission and review status. */
async function myProducts(vendor) {
  const rows = await db.query('SELECT vp.id, vp.name, vp.vendor_sku, vp.hsn_code, vp.mrp, vp.pack_size, vp.shelf_life_days, vp.moq, vp.lead_days, vp.status, vp.review_note, vp.created_at, ' +
    '(SELECT CONCAT(pl.unit_price, \'|\', pl.gst_rate, \'|\', pl.status, \'|\', pl.valid_from) FROM b2b_vendor_price_lists pl WHERE pl.vendor_product_id = vp.id ORDER BY pl.id DESC LIMIT 1) AS last_price ' +
    'FROM b2b_vendor_products vp WHERE vp.vendor_id = ? ORDER BY vp.id DESC LIMIT 500', [vendor.vendorId]);
  return { items: rows.map(function (r) {
    const lp = r.last_price ? String(r.last_price).split('|') : null;
    return { id: Number(r.id), name: r.name, vendorSku: r.vendor_sku, hsn: r.hsn_code, mrp: r.mrp == null ? null : Number(r.mrp), packSize: r.pack_size, shelfLifeDays: r.shelf_life_days, moq: r.moq, leadDays: r.lead_days,
      status: r.status, reviewNote: r.review_note, lastPrice: lp ? { unitPrice: Number(lp[0]), gstRate: Number(lp[1]), status: lp[2], validFrom: lp[3] ? String(lp[3]).slice(0, 10) : null } : null };
  }) };
}

/**
 * Profile fields the vendor may change itself. Legal identity (legal name, GSTIN, PAN, CIN, FSSAI) is
 * NOT here: those change only through our verification (a renewed licence is uploaded as a document).
 */
async function updateProfile(tx, vendor, b) {
  const set = {}, user = {};
  if (b.tradeName !== undefined) set.trade_name = v.text(b.tradeName, 200) || null;
  if (b.website !== undefined) {
    const w = v.text(b.website, 200);
    if (w && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(w)) throw fail(400, 'Website must start with http:// or https://');
    set.website = w || null;
  }
  if (b.categories !== undefined) set.categories_note = v.text(b.categories, 500) || null;
  if (b.brands !== undefined) set.brands_note = v.text(b.brands, 500) || null;
  if (b.capabilitiesNote !== undefined) set.capabilities_note = v.text(b.capabilitiesNote, 1000) || null;
  if (b.defaultLeadDays !== undefined) {
    const n = b.defaultLeadDays === '' || b.defaultLeadDays == null ? null : Number(b.defaultLeadDays);
    if (n != null && !(Number.isInteger(n) && n >= 0 && n <= 365)) throw fail(400, 'Lead time must be 0–365 days');
    set.default_lead_days = n;
  }
  if (b.contactName !== undefined) { const n = v.text(b.contactName, 120); if (n.length < 2) throw fail(400, 'Give your name'); user.name = n; }
  if (b.contactMobile !== undefined) {
    const m = String(b.contactMobile || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (!v.isMobile(m)) throw fail(400, 'Mobile must be a 10-digit Indian number');
    user.mobile = m;
  }
  if (!Object.keys(set).length && !Object.keys(user).length) throw fail(400, 'Nothing to change');
  const old = await tx.queryOne('SELECT trade_name, website, categories_note, brands_note, capabilities_note, default_lead_days FROM b2b_vendors WHERE id = ? FOR UPDATE', [vendor.vendorId]);
  if (Object.keys(set).length) await tx.query('UPDATE b2b_vendors SET ' + Object.keys(set).map(function (k) { return k + ' = ?'; }).join(', ') + ' WHERE id = ?', Object.keys(set).map(function (k) { return set[k]; }).concat([vendor.vendorId]));
  if (Object.keys(user).length) await tx.query('UPDATE b2b_vendor_users SET ' + Object.keys(user).map(function (k) { return k + ' = ?'; }).join(', ') + ' WHERE id = ? AND vendor_id = ?', Object.keys(user).map(function (k) { return user[k]; }).concat([vendor.userId, vendor.vendorId]));
  await audit.write(tx, vendorActor({ id: vendor.userId, role: vendor.role }), { module: 'vendors', action: 'vendor.profile_updated', entity: 'vendor', entityId: vendor.vendorId, old: old, new: Object.assign({}, set, user) });
  return { ok: true, changed: Object.keys(set).concat(Object.keys(user)) };
}

module.exports = { createWithLogin, addAddress, removeAddress, listAddresses, listBankAccounts, addUser, resetUserPassword, setUserStatus, listUsers, staffUpdate,
  decideCapability, requestCapability, temporaryPassword, CAPS, ADDRESS_TYPES, myProducts, updateProfile, register, invite, acceptInvite, login, requireVendor, requireApprovedVendor, vendorRole, me, checkDocumentRequest, uploadDocument, submitProduct, submitPrice,
  list, detail, reviewDocument, sendDocument, recordVerification, setStatus, decideProduct, decidePrice, addBankAccount, verifyBankAccount, vendorActor, STAGES };
