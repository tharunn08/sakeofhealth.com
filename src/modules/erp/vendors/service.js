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

const CAPS = ['manufacturer', 'authorised_distributor', 'supplier_wholesaler'];
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
  const caps = Array.isArray(b.capabilities) ? b.capabilities.filter(function (c) { return CAPS.indexOf(c) !== -1; }) : [];
  if (!caps.length) throw fail(400, 'Choose at least one capability: ' + CAPS.join(', '));
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
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    await tx.query("INSERT INTO b2b_vendor_users (vendor_id, name, email, mobile, role, status, invite_token_hash, invite_expires_at) VALUES (?, ?, ?, ?, 'owner', 'invited', ?, UTC_TIMESTAMP() + INTERVAL 7 DAY)",
      [r.insertId, name, email, mobile, sha(token)]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A vendor user with this e-mail already exists'); throw e; }
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.invited', entity: 'vendor', entityId: r.insertId, new: { legal: vendor.legal_name, email: email } });
  return { vendorId: Number(r.insertId), inviteToken: token, expiresInDays: 7, note: 'Share this one-time link privately: /vendor/?invite=<token>. It is not stored and cannot be shown again.' };
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
  const vd = await db.queryOne('SELECT id, vendor_code, legal_name, trade_name, gstin, pan, status, onboarding, payment_terms_days, state_id, created_at FROM b2b_vendors WHERE id = ?', [vendor.vendorId]);
  const caps = await db.query('SELECT capability, status FROM b2b_vendor_capabilities WHERE vendor_id = ?', [vendor.vendorId]);
  const docs = await db.query('SELECT id, doc_type, original_name, review_status, review_note, valid_to, created_at FROM b2b_vendor_documents WHERE vendor_id = ? ORDER BY id', [vendor.vendorId]);
  return { user: { id: vendor.userId, name: vendor.name, email: vendor.email, role: vendor.role }, vendor: vd, capabilities: caps, documents: docs };
}

async function uploadDocument(tx, vendor, file, b, ip) {
  if (!file) throw fail(400, 'Attach the document as "file"');
  const type = String(b.docType || '');
  if (DOC_TYPES.indexOf(type) === -1) throw fail(400, 'docType must be one of ' + DOC_TYPES.join(', '));
  const saved = uploads.saveDocument(file);   // magic-byte check, random name, private folder
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
  if (q.q) { const t = '%' + String(q.q).replace(/[\\%_]/g, '\\$&').slice(0, 80) + '%'; where.push('(vd.legal_name LIKE ? OR vd.trade_name LIKE ? OR vd.gstin LIKE ?)'); params.push(t, t, t); }
  const rows = await db.query('SELECT vd.id, vd.vendor_code, vd.legal_name, vd.trade_name, vd.gstin, vd.status, vd.onboarding, vd.created_at, vd.approved_at, ' +
    "(SELECT GROUP_CONCAT(CONCAT(c.capability, ':', c.status)) FROM b2b_vendor_capabilities c WHERE c.vendor_id = vd.id) AS capabilities, " +
    "(SELECT COUNT(*) FROM b2b_vendor_documents d WHERE d.vendor_id = vd.id AND d.review_status = 'pending') AS docs_pending " +
    'FROM b2b_vendors vd WHERE ' + where.join(' AND ') + ' ORDER BY vd.id DESC LIMIT ' + db.int(q.limit, 50, 1, 200), params);
  return { items: rows };
}

async function detail(id) {
  const vd = await db.queryOne('SELECT * FROM b2b_vendors WHERE id = ?', [id]);
  if (!vd) throw fail(404, 'Vendor not found');
  return {
    vendor: vd,
    capabilities: await db.query('SELECT * FROM b2b_vendor_capabilities WHERE vendor_id = ?', [id]),
    users: await db.query('SELECT id, name, email, mobile, role, status, last_login_at FROM b2b_vendor_users WHERE vendor_id = ?', [id]),
    documents: await db.query('SELECT id, doc_type, original_name, mime_type, size_bytes, sha256, valid_to, review_status, review_note, created_at FROM b2b_vendor_documents WHERE vendor_id = ?', [id]),
    verifications: await db.query('SELECT stage, outcome, note, staff_id, created_at FROM b2b_vendor_verifications WHERE vendor_id = ? ORDER BY id', [id]),
    products: await db.query('SELECT * FROM b2b_vendor_products WHERE vendor_id = ? ORDER BY id DESC LIMIT 500', [id]),
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

function documentFile(doc) { return uploads.documentPath(doc.stored_name); }

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
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.bank_added', entity: 'vendor', entityId: vendorId, new: { last4: no.slice(-4), ifsc: ifsc } });
  return { bankAccountId: Number(r.insertId), status: 'pending' };
}
async function verifyBankAccount(tx, actor, vendorId, bankId, b) {
  const ba = await tx.queryOne('SELECT id, status FROM b2b_vendor_bank_accounts WHERE id = ? AND vendor_id = ? FOR UPDATE', [bankId, vendorId]);
  if (!ba) throw fail(404, 'Not found');
  const status = b.status === 'verified' ? 'verified' : (b.status === 'rejected' ? 'rejected' : null);
  if (!status) throw fail(400, 'status must be verified or rejected');
  await tx.query('UPDATE b2b_vendor_bank_accounts SET status = ?, verified_by = ? WHERE id = ?', [status, actor.id, bankId]);
  await audit.write(tx, actor, { module: 'vendors', action: 'vendor.bank_' + status, entity: 'vendor', entityId: vendorId, new: { bankAccountId: bankId }, reason: b.note });
  return { bankAccountId: bankId, status: status };
}

module.exports = { register, invite, acceptInvite, login, requireVendor, requireApprovedVendor, vendorRole, me, uploadDocument, submitProduct, submitPrice,
  list, detail, reviewDocument, documentFile, recordVerification, setStatus, decideProduct, decidePrice, addBankAccount, verifyBankAccount, vendorActor, STAGES };
