/**
 * Business accounts: registration, KYC documents, approval workflow, login.
 */
const fs = require('fs');
const db = require('../../../db/connection.js');
const v = require('../lib/validate.js');
const security = require('../lib/security.js');
const uploads = require('../lib/uploads.js');
const audit = require('../lib/audit.js');
const notifications = require('../notifications/service.js');
const mappings = require('../mappings/service.js');
const { bad, notFound, conflict, forbidden, AppError, like } = require('../lib/http.js');

const STATUSES = ['pending', 'under_review', 'approved', 'rejected', 'suspended', 'blocked'];
const TRANSITIONS = {
  pending: ['under_review', 'approved', 'rejected'],
  under_review: ['approved', 'rejected', 'pending'],
  approved: ['suspended', 'blocked'],
  rejected: ['under_review'],
  suspended: ['approved', 'blocked'],
  blocked: ['approved'],
};
const REQUIRED_DOCS = {
  distributor: ['gst_certificate', 'business_proof', 'address_proof'],
  retailer: ['shop_proof'],
};
const DOC_LABEL = {
  gst_certificate: 'GST certificate', business_proof: 'Business proof', address_proof: 'Address proof',
  shop_proof: 'Shop / business proof', pan_card: 'PAN card', other: 'Other document',
};
const BUSINESS_TYPES = ['Proprietorship', 'Partnership', 'LLP', 'Private Limited', 'Public Limited', 'HUF', 'Trust / Society', 'Other'];

/* ─────────── Geography ─────────── */

async function listStates() {
  return db.query('SELECT id, name, gst_code, is_serviceable FROM b2b_states ORDER BY is_serviceable DESC, name');
}
async function listDistricts(stateId) {
  return db.query('SELECT id, name FROM b2b_districts WHERE state_id = ? ORDER BY name', [Number(stateId) || 0]);
}

/* ─────────── Registration ─────────── */

function readRegistration(type, b) {
  const errors = {};
  const data = {
    account_type: type,
    business_name: v.text(type === 'distributor' ? (b.distributor_name || b.business_name) : (b.retailer_name || b.business_name), 160),
    shop_name: type === 'retailer' ? v.text(b.shop_name, 160) : null,
    contact_person: v.text(b.contact_person, 120),
    mobile: v.mobile(b.mobile),
    email: v.email(b.email),
    gstin: v.upper(b.gstin, 15) || null,
    pan: v.upper(b.pan, 10) || null,
    business_type: v.text(b.business_type, 60) || null,
    address_line1: v.text(b.address || b.address_line1, 200),
    address_line2: v.text(b.address_line2, 200) || null,
    landmark: v.text(b.landmark, 160) || null,
    state_id: v.posInt(b.state_id),
    district_id: v.posInt(b.district_id),
    district_name: v.text(b.district || b.district_name, 80),
    city: v.text(b.city, 80),
    pincode: v.text(b.pincode, 6),
    latitude: v.lat(b.latitude),
    longitude: v.lng(b.longitude),
  };
  const nameLabel = type === 'distributor' ? 'Distributor name' : 'Retailer name';
  if (data.business_name.length < 2) errors.business_name = nameLabel + ' is required';
  if (type === 'retailer' && (!data.shop_name || data.shop_name.length < 2)) errors.shop_name = 'Shop name is required';
  if (data.contact_person.length < 2) errors.contact_person = 'Contact person is required';
  if (!v.isMobile(data.mobile)) errors.mobile = 'Enter a valid 10-digit mobile number';
  if (!v.isEmail(data.email)) errors.email = 'Enter a valid email address';
  if (type === 'distributor' && !data.gstin) errors.gstin = 'GSTIN is required for distributors';
  if (data.gstin && !v.isGstin(data.gstin)) errors.gstin = 'This GSTIN is not valid — please check each character';
  if (type === 'distributor' && !data.pan) errors.pan = 'PAN is required for distributors';
  if (data.pan && !v.isPan(data.pan)) errors.pan = 'Enter a valid PAN (e.g. ABCDE1234F)';
  if (type === 'distributor' && !data.business_type) errors.business_type = 'Business type is required';
  if (data.address_line1.length < 5) errors.address = 'Full address is required';
  if (!data.state_id) errors.state_id = 'State is required';
  if (!data.district_id && !data.district_name) errors.district = 'District is required';
  if (data.city.length < 2) errors.city = 'City is required';
  if (!v.isPincode(data.pincode)) errors.pincode = 'Enter a valid 6-digit pincode';
  if ((b.latitude || b.longitude) && (!data.latitude || !data.longitude)) errors.latitude = 'Location coordinates are not valid';
  const pwProblem = v.passwordProblem(b.password);
  if (pwProblem) errors.password = pwProblem;
  else if (String(b.password) !== String(b.confirm_password)) errors.confirm_password = 'Passwords do not match';
  return { data: data, errors: errors };
}

async function findDuplicates(data, q) {
  const run = q ? q.query.bind(q) : db.query;
  const errors = {};
  const byMobile = await run(
    'SELECT 1 FROM b2b_accounts WHERE mobile = ? UNION SELECT 1 FROM b2b_users WHERE mobile = ? LIMIT 1', [data.mobile, data.mobile]);
  if (byMobile.length) errors.mobile = 'A business account with this mobile number already exists';
  const byEmail = await run(
    'SELECT 1 FROM b2b_accounts WHERE email = ? UNION SELECT 1 FROM b2b_users WHERE email = ? LIMIT 1', [data.email, data.email]);
  if (byEmail.length) errors.email = 'A business account with this email already exists';
  if (data.gstin) {
    const byGst = await run('SELECT 1 FROM b2b_accounts WHERE gstin = ? LIMIT 1', [data.gstin]);
    if (byGst.length) errors.gstin = 'A business account with this GSTIN already exists';
  }
  return errors;
}

async function riskFlags(data, state, q) {
  const flags = [];
  if (data.gstin && data.gstin.slice(0, 2) !== state.gst_code) flags.push('gstin_state_mismatch');
  if (data.gstin && data.pan && data.gstin.slice(2, 12) !== data.pan) flags.push('gstin_pan_mismatch');
  if (!data.gstin) flags.push('no_gstin');
  if (!data.latitude || !data.longitude) flags.push('no_location');
  if (!state.is_serviceable) flags.push('state_not_serviceable');
  const same = await q.query(
    'SELECT COUNT(*) AS n FROM b2b_accounts WHERE pincode = ? AND account_type = ? AND (business_name = ? OR address_line1 = ?)',
    [data.pincode, data.account_type, data.business_name, data.address_line1]);
  if (Number(same[0].n) > 0) flags.push('possible_duplicate_business');
  return flags;
}

async function register(type, body, files, ctx) {
  if (type !== 'retailer' && type !== 'distributor') throw bad('Choose Retailer or Distributor');
  const parsed = readRegistration(type, body || {});
  const errors = parsed.errors, data = parsed.data;
  files = files || {};
  REQUIRED_DOCS[type].forEach(function (f) {
    if (!files[f] || !files[f][0]) errors[f] = DOC_LABEL[f] + ' is required';
  });
  if (Object.keys(errors).length) throw new AppError(400, 'Please correct the highlighted fields', { fields: errors });

  const state = await db.queryOne('SELECT id, name, gst_code, is_serviceable FROM b2b_states WHERE id = ?', [data.state_id]);
  if (!state) throw new AppError(400, 'Please correct the highlighted fields', { fields: { state_id: 'Unknown state' } });
  if (data.district_id) {
    const d = await db.queryOne('SELECT id, name FROM b2b_districts WHERE id = ? AND state_id = ?', [data.district_id, state.id]);
    if (!d) throw new AppError(400, 'Please correct the highlighted fields', { fields: { district: 'Choose a district in the selected state' } });
    data.district_name = d.name;
  }
  const dupes = await findDuplicates(data);
  if (Object.keys(dupes).length) throw new AppError(409, 'This business is already registered', { fields: dupes });

  // Validate + write files first; if the database insert fails they are removed again.
  const saved = [];
  try {
    for (const field of uploads.DOC_FIELDS) {
      if (files[field] && files[field][0]) saved.push(Object.assign({ docType: field }, uploads.saveDocument(files[field][0])));
    }
    const passwordHash = security.hashPassword(body.password);
    const result = await db.transaction(async function (tx) {
      const raced = await findDuplicates(data, tx);
      if (Object.keys(raced).length) throw new AppError(409, 'This business is already registered', { fields: raced });
      const flags = await riskFlags(data, state, tx);
      const acc = await tx.query(
        'INSERT INTO b2b_accounts (account_type, status, business_name, shop_name, contact_person, mobile, email, gstin, pan, business_type, ' +
        ' address_line1, address_line2, landmark, state_id, district_id, district_name, city, pincode, latitude, longitude, risk_flags) ' +
        "VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [type, data.business_name, data.shop_name, data.contact_person, data.mobile, data.email, data.gstin, data.pan, data.business_type,
          data.address_line1, data.address_line2, data.landmark, data.state_id, data.district_id, data.district_name, data.city, data.pincode,
          data.latitude, data.longitude, JSON.stringify(flags)]);
      const accountId = acc.insertId;
      const user = await tx.query(
        'INSERT INTO b2b_users (account_id, name, email, mobile, password_hash, role, is_primary) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [accountId, data.contact_person, data.email, data.mobile, passwordHash, type]);
      for (const d of saved) {
        await tx.query(
          'INSERT INTO b2b_documents (account_id, doc_type, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [accountId, d.docType, d.originalName, d.storedName, d.mime, d.size, d.sha256, data.email]);
      }
      await tx.query(
        "INSERT INTO b2b_account_status_history (account_id, from_status, to_status, reason, actor_type, actor_label) VALUES (?, NULL, 'pending', 'Registration submitted', 'business', ?)",
        [accountId, data.email]);
      await audit.log(tx, { type: 'business', id: user.insertId, label: data.email, role: type, ip: ctx && ctx.ip },
        type + '.registered', type, accountId, null,
        { business_name: data.business_name, mobile: data.mobile, gstin: data.gstin, pincode: data.pincode, risk_flags: flags });
      await notifications.notifyAdmins(tx, {
        title: 'New ' + type + ' registration: ' + data.business_name,
        lines: [data.contact_person + ' · ' + data.mobile + ' · ' + data.city + ' ' + data.pincode,
          'Review the documents and approve or reject the application in the admin panel.'],
        link: '/admin/b2b/accounts.html?open=' + accountId, refType: 'account', refId: accountId,
      });
      await notifications.notifyAccount(tx, accountId, {
        title: 'Registration received',
        lines: ['Thank you for registering ' + data.business_name + ' with ' + (process.env.BRAND_NAME || 'Sake of Health') + '.',
          'Our team will verify your details and documents. You will be notified as soon as your account is approved.'],
        link: '/b2b/dashboard', refType: 'account', refId: accountId,
      });
      return { accountId: accountId, userId: user.insertId };
    });
    return result;
  } catch (e) {
    saved.forEach(function (d) { uploads.removeDocument(d.storedName); });
    if (e.code === 'ER_DUP_ENTRY') throw conflict('This business is already registered (mobile, email or GSTIN is already in use)');
    throw e;
  }
}

/* ─────────── Login ─────────── */

const MAX_FAILED = 8, LOCK_MINUTES = 15;

/**
 * opts (only from the central sign-in, /login):
 *   anyRole      — do not require the person to state retailer/distributor; use the account's own type
 *   countFailure — false when another of the person's accounts accepted this password (no lockout count)
 */
async function login(identifier, password, role, ip, opts) {
  opts = opts || {};
  const id = String(identifier || '').trim().toLowerCase();
  password = String(password || '');
  if (!id || !password) throw new AppError(400, 'Enter your email or mobile number and password');
  if (!opts.anyRole && role !== 'retailer' && role !== 'distributor') throw new AppError(400, 'Choose whether you are logging in as a Retailer or Distributor');
  const mobile = v.mobile(id);
  const user = await db.queryOne(
    'SELECT u.*, a.status AS account_status, a.account_type FROM b2b_users u JOIN b2b_accounts a ON a.id = u.account_id ' +
    'WHERE u.email = ? OR u.mobile = ? LIMIT 1', [id, v.isMobile(mobile) ? mobile : '']);
  const invalid = new AppError(401, 'Incorrect login details. Check your email / mobile, password and account type.');
  if (!user) { security.verifyPassword(password, 'scrypt:00:00'); throw invalid; }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw new AppError(429, 'Too many failed attempts. Please try again in ' + LOCK_MINUTES + ' minutes.');
  }
  if (!security.verifyPassword(password, user.password_hash)) {
    if (opts.countFailure === false) throw invalid;
    const failed = Number(user.failed_logins) + 1;
    await db.query(
      'UPDATE b2b_users SET failed_logins = ?, locked_until = ' +
      (failed >= MAX_FAILED ? '(UTC_TIMESTAMP() + INTERVAL ' + LOCK_MINUTES + ' MINUTE)' : 'NULL') + ' WHERE id = ?',
      [failed >= MAX_FAILED ? 0 : failed, user.id]);
    throw invalid;
  }
  if (opts.anyRole) role = user.account_type;
  if (user.account_type !== role) throw invalid;
  if (user.status !== 'active') throw new AppError(403, 'This login has been disabled. Please contact support.');
  if (user.account_status === 'blocked') throw new AppError(403, 'This business account has been blocked. Please contact support.');
  await db.query('UPDATE b2b_users SET failed_logins = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
  audit.logSoft({ type: 'business', id: user.id, label: user.email, role: role, ip: ip }, 'auth.login', role, user.account_id, null, null);
  return {
    token: security.signToken({ uid: Number(user.id), aid: Number(user.account_id), role: role, tv: Number(user.token_version) }),
    user: { id: Number(user.id), name: user.name, email: user.email, role: role },
    accountStatus: user.account_status,
    mustChangePassword: Number(user.must_change_password) === 1,
  };
}

async function changePassword(userId, currentPassword, newPassword) {
  const user = await db.queryOne('SELECT id, account_id, role, password_hash, token_version FROM b2b_users WHERE id = ?', [userId]);
  if (!user || !security.verifyPassword(currentPassword, user.password_hash)) throw bad('Your current password is incorrect');
  const problem = v.passwordProblem(newPassword);
  if (problem) throw bad(problem);
  await db.query('UPDATE b2b_users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
    [security.hashPassword(newPassword), userId]);
  await require('../../../db/mustChange.js').clear('business', userId);
  // Every older token is now invalid; hand back a fresh one for this session.
  return security.signToken({ uid: Number(user.id), aid: Number(user.account_id), role: user.role, tv: Number(user.token_version) + 1 });
}

/* ─────────── Read ─────────── */

const ACCOUNT_COLUMNS =
  'a.id, a.account_type, a.tier, a.parent_account_id, a.status, a.business_name, a.shop_name, a.contact_person, a.mobile, a.email, ' +
  'a.gstin, a.pan, a.business_type, a.address_line1, a.address_line2, a.landmark, a.state_id, a.district_id, a.district_name, a.city, ' +
  'a.pincode, a.latitude, a.longitude, a.first_order_done, a.risk_flags, a.max_retailers, a.daily_order_capacity, a.invoice_prefix, ' +
  'a.admin_notes, a.approved_at, a.approved_by, a.created_at, a.updated_at';

function shape(a) {
  if (!a) return null;
  let flags = [];
  try { flags = JSON.parse(a.risk_flags || '[]'); } catch (e) { flags = []; }
  return Object.assign({}, a, { risk_flags: flags, first_order_done: !!a.first_order_done });
}

async function getAccount(id, q) {
  const run = q ? q.queryOne.bind(q) : db.queryOne;
  const a = await run('SELECT ' + ACCOUNT_COLUMNS + ', s.name AS state_name, s.gst_code AS state_gst_code ' +
    'FROM b2b_accounts a JOIN b2b_states s ON s.id = a.state_id WHERE a.id = ?', [id]);
  return shape(a);
}

/** Public profile fields a counterpart (mapped retailer/distributor) may see. */
function contactCard(a) {
  if (!a) return null;
  return {
    id: Number(a.id), business_name: a.business_name, shop_name: a.shop_name, contact_person: a.contact_person,
    mobile: a.mobile, email: a.email, address: [a.address_line1, a.address_line2, a.landmark].filter(Boolean).join(', '),
    city: a.city, district: a.district_name, state: a.state_name, pincode: a.pincode,
    latitude: a.latitude, longitude: a.longitude,
  };
}

async function listAccounts(f, pg) {
  const where = [], params = [];
  if (f.type) { where.push('a.account_type = ?'); params.push(f.type); }
  if (f.status) {
    const list = String(f.status).split(',').filter(function (s) { return STATUSES.indexOf(s) !== -1; });
    if (list.length) { where.push('a.status IN (' + db.placeholders(list) + ')'); params.push.apply(params, list); }
  }
  if (f.state_id) { where.push('a.state_id = ?'); params.push(Number(f.state_id)); }
  if (f.district_id) { where.push('a.district_id = ?'); params.push(Number(f.district_id)); }
  if (f.pincode) { where.push('a.pincode = ?'); params.push(String(f.pincode)); }
  if (f.distributor_id) {
    where.push("a.id IN (SELECT retailer_id FROM b2b_retailer_distributor_map WHERE distributor_id = ? AND current_retailer_id IS NOT NULL)");
    params.push(Number(f.distributor_id));
  }
  if (f.unmapped) {
    where.push("a.account_type = 'retailer' AND a.status = 'approved' AND NOT EXISTS (SELECT 1 FROM b2b_retailer_distributor_map m WHERE m.current_retailer_id = a.id)");
  }
  if (f.q) {
    const term = v.text(f.q, 80);
    if (/^\d{6}$/.test(term)) { where.push('a.pincode = ?'); params.push(term); }
    else if (/^\d{7,10}$/.test(term)) { where.push('a.mobile LIKE ?'); params.push(like(term, 'prefix')); }
    else if (/^[0-9]{2}[A-Za-z0-9]{3,13}$/.test(term) && /\d/.test(term.slice(2))) { where.push('a.gstin LIKE ?'); params.push(like(term.toUpperCase(), 'prefix')); }
    else if (term.indexOf('@') !== -1) { where.push('a.email LIKE ?'); params.push(like(term.toLowerCase(), 'prefix')); }
    else {
      where.push('(a.business_name LIKE ? OR a.shop_name LIKE ? OR a.contact_person LIKE ? OR a.city LIKE ? OR a.district_name LIKE ?)');
      const p = like(term); params.push(p, p, p, like(term, 'prefix'), like(term, 'prefix'));
    }
  }
  const sql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const sort = { name: 'a.business_name', created: 'a.created_at', status: 'a.status', city: 'a.city' };
  const order = sort[f.sort] ? sort[f.sort] + (f.dir === 'asc' ? ' ASC' : ' DESC') : 'a.created_at DESC';
  const total = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_accounts a' + sql, params);
  const rows = await db.query(
    'SELECT a.id, a.account_type, a.status, a.business_name, a.shop_name, a.contact_person, a.mobile, a.email, a.gstin, a.city, a.state_id, ' +
    '       a.district_name, a.pincode, a.risk_flags, a.created_at, a.approved_at, s.name AS state_name, ' +
    '       d.id AS distributor_id, d.business_name AS distributor_name, m.status AS mapping_status ' +
    'FROM b2b_accounts a JOIN b2b_states s ON s.id = a.state_id ' +
    'LEFT JOIN b2b_retailer_distributor_map m ON m.current_retailer_id = a.id ' +
    'LEFT JOIN b2b_accounts d ON d.id = m.distributor_id' + sql +
    ' ORDER BY ' + order + ', a.id DESC LIMIT ' + pg.limit + ' OFFSET ' + pg.offset, params);
  return { rows: rows.map(shape), total: Number(total.n) };
}

async function documentsFor(accountId) {
  return db.query('SELECT id, doc_type, original_name, mime_type, size_bytes, uploaded_by, created_at FROM b2b_documents WHERE account_id = ? ORDER BY id', [accountId]);
}

async function statusHistory(accountId) {
  return db.query('SELECT from_status, to_status, reason, actor_type, actor_label, created_at FROM b2b_account_status_history WHERE account_id = ? ORDER BY id DESC LIMIT 100', [accountId]);
}

/** Everything the admin needs to review one account. */
async function adminDetail(id) {
  const account = await getAccount(id);
  if (!account) throw notFound('Business account not found');
  const [documents, history, users, stats, credit] = await Promise.all([
    documentsFor(id), statusHistory(id),
    db.query('SELECT id, name, email, mobile, role, status, last_login_at FROM b2b_users WHERE account_id = ?', [id]),
    db.queryOne(
      "SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','rejected') THEN grand_total ELSE 0 END), 0) AS total_value, " +
      "       COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','rejected','refunded') THEN grand_total - amount_paid ELSE 0 END), 0) AS outstanding, " +
      '       MAX(created_at) AS last_order_at FROM b2b_orders WHERE buyer_account_id = ?', [id]),
    db.query('SELECT c.*, a.business_name AS creditor_name FROM b2b_credit_accounts c LEFT JOIN b2b_accounts a ON a.id = c.creditor_account_id WHERE c.debtor_account_id = ?', [id]),
  ]);
  const out = { account: account, documents: documents, history: history, users: users, stats: stats, credit: credit };
  if (account.account_type === 'retailer') {
    out.mapping = await mappings.currentMapping(id);
    out.mappingHistory = await mappings.history(id);
    if (account.status !== 'rejected' && account.status !== 'blocked') out.candidates = (await mappings.rankDistributors(account)).slice(0, 8);
  } else {
    out.serviceAreas = await mappings.listServiceAreas(id);
    const r = await db.queryOne("SELECT COUNT(*) AS n FROM b2b_retailer_distributor_map WHERE distributor_id = ? AND status = 'active'", [id]);
    out.retailerCount = Number(r.n);
  }
  return out;
}

/* ─────────── Approval workflow ─────────── */

async function changeStatus(accountId, toStatus, reason, actor) {
  if (STATUSES.indexOf(toStatus) === -1) throw bad('Unknown status');
  reason = v.text(reason, 500);
  if (['rejected', 'suspended', 'blocked'].indexOf(toStatus) !== -1 && reason.length < 3) throw bad('Please give a reason');
  return db.transaction(async function (tx) {
    const acc = await tx.queryOne('SELECT * FROM b2b_accounts WHERE id = ? FOR UPDATE', [accountId]);
    if (!acc) throw notFound('Business account not found');
    if (acc.status === toStatus) throw bad('The account is already ' + toStatus.replace('_', ' '));
    if ((TRANSITIONS[acc.status] || []).indexOf(toStatus) === -1) {
      throw bad('An account that is ' + acc.status.replace('_', ' ') + ' cannot be moved to ' + toStatus.replace('_', ' '));
    }
    const approving = toStatus === 'approved';
    await tx.query(
      'UPDATE b2b_accounts SET status = ?' + (approving ? ', approved_at = COALESCE(approved_at, UTC_TIMESTAMP()), approved_by = ?' : '') + ' WHERE id = ?',
      approving ? [toStatus, actor.label, accountId] : [toStatus, accountId]);
    await tx.query(
      'INSERT INTO b2b_account_status_history (account_id, from_status, to_status, reason, actor_type, actor_label) VALUES (?, ?, ?, ?, ?, ?)',
      [accountId, acc.status, toStatus, reason || null, actor.type, actor.label]);
    await audit.log(tx, actor, acc.account_type + '.' + toStatus, acc.account_type, accountId, { status: acc.status }, { status: toStatus, reason: reason || null });

    let mapping = null;
    if (approving) {
      // A company credit account (limit 0 until finance sets one).
      await tx.query('INSERT IGNORE INTO b2b_credit_accounts (debtor_account_id, creditor_account_id, credit_limit) VALUES (?, 0, 0)', [accountId]);
      if (acc.account_type === 'distributor') {
        // Their own stock point + a starting service area (their own pincode) — admins widen it afterwards.
        await tx.query(
          'INSERT IGNORE INTO b2b_warehouses (code, name, owner_account_id, state_id, district_id, city, pincode) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['DIST-' + accountId, (acc.business_name + ' — stock').slice(0, 120), accountId, acc.state_id, acc.district_id, acc.city, acc.pincode]);
        const areas = await tx.queryOne('SELECT COUNT(*) AS n FROM b2b_service_areas WHERE distributor_id = ?', [accountId]);
        if (Number(areas.n) === 0) {
          await tx.query(
            "INSERT INTO b2b_service_areas (distributor_id, area_type, state_id, pincode_from, pincode_to) VALUES (?, 'pincode', ?, ?, ?)",
            [accountId, acc.state_id, acc.pincode, acc.pincode]);
        }
      } else {
        const existing = await tx.queryOne('SELECT id FROM b2b_retailer_distributor_map WHERE current_retailer_id = ?', [accountId]);
        if (!existing) mapping = await mappings.autoAssign(tx, accountId, audit.SYSTEM);
      }
    }
    const brand = process.env.BRAND_NAME || 'Sake of Health';
    const copy = {
      approved: ['Your business account is approved', ['Welcome to ' + brand + '. You can now browse the trade catalogue and place orders.']],
      rejected: ['Your registration was not approved', ['Reason: ' + reason, 'You can reply to this message or contact support if you believe this is a mistake.']],
      suspended: ['Your business account is suspended', ['Reason: ' + reason, 'Ordering is paused until the account is reinstated.']],
      blocked: ['Your business account has been blocked', ['Reason: ' + reason]],
      under_review: ['Your registration is under review', ['Our team is verifying your details and documents.']],
      pending: ['Your registration is pending', ['Our team will review your application shortly.']],
    }[toStatus];
    await notifications.notifyAccount(tx, accountId, { title: copy[0], lines: copy[1], link: '/b2b/dashboard', refType: 'account', refId: accountId });
    return { status: toStatus, mapping: mapping ? mapping.assigned : null };
  });
}

const ADMIN_EDITABLE = {
  business_name: x => v.text(x, 160), shop_name: x => v.text(x, 160) || null, contact_person: x => v.text(x, 120),
  business_type: x => v.text(x, 60) || null, address_line1: x => v.text(x, 200), address_line2: x => v.text(x, 200) || null,
  landmark: x => v.text(x, 160) || null, city: x => v.text(x, 80), latitude: v.lat, longitude: v.lng,
  max_retailers: v.posInt, daily_order_capacity: v.posInt,
  invoice_prefix: x => { const s = v.upper(x, 12).replace(/[^A-Z0-9]/g, '').slice(0, 6); return s || null; },
  admin_notes: x => v.text(x, 2000) || null,
};

async function adminUpdate(accountId, body, actor) {
  const before = await db.queryOne('SELECT * FROM b2b_accounts WHERE id = ?', [accountId]);
  if (!before) throw notFound('Business account not found');
  const sets = [], params = [], oldV = {}, newV = {};
  Object.keys(ADMIN_EDITABLE).forEach(function (k) {
    if (body[k] === undefined) return;
    const val = ADMIN_EDITABLE[k](body[k]);
    if (['business_name', 'contact_person', 'address_line1', 'city'].indexOf(k) !== -1 && !val) throw bad(k.replace('_', ' ') + ' cannot be empty');
    if (String(before[k] == null ? '' : before[k]) === String(val == null ? '' : val)) return;
    sets.push(k + ' = ?'); params.push(val); oldV[k] = before[k]; newV[k] = val;
  });
  if (body.pincode !== undefined && String(body.pincode) !== before.pincode) {
    if (!v.isPincode(body.pincode)) throw bad('Enter a valid 6-digit pincode');
    sets.push('pincode = ?'); params.push(String(body.pincode)); oldV.pincode = before.pincode; newV.pincode = String(body.pincode);
  }
  if (body.gstin !== undefined) {
    const g = v.upper(body.gstin, 15) || null;
    if (g && !v.isGstin(g)) throw bad('This GSTIN is not valid');
    if (g !== before.gstin) { sets.push('gstin = ?'); params.push(g); oldV.gstin = before.gstin; newV.gstin = g; }
  }
  if (!sets.length) return { changed: false };
  params.push(accountId);
  try {
    await db.query('UPDATE b2b_accounts SET ' + sets.join(', ') + ' WHERE id = ?', params);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('Another business already uses that GSTIN');
    throw e;
  }
  await audit.log(null, actor, before.account_type + '.edited', before.account_type, accountId, oldV, newV);
  return { changed: true };
}

/** Fields a business may change itself; legal identity (name, GSTIN, PAN) stays with the admin. */
async function selfUpdate(account, body, actor) {
  const allowed = { contact_person: x => v.text(x, 120), address_line2: x => v.text(x, 200) || null,
    landmark: x => v.text(x, 160) || null, latitude: v.lat, longitude: v.lng };
  const sets = [], params = [], newV = {};
  Object.keys(allowed).forEach(function (k) {
    if (body[k] === undefined) return;
    const val = allowed[k](body[k]);
    if (k === 'contact_person' && !val) throw bad('Contact person cannot be empty');
    sets.push(k + ' = ?'); params.push(val); newV[k] = val;
  });
  if (!sets.length) return { changed: false };
  params.push(account.id);
  await db.query('UPDATE b2b_accounts SET ' + sets.join(', ') + ' WHERE id = ?', params);
  audit.logSoft(actor, account.account_type + '.profile_updated', account.account_type, account.id, null, newV);
  return { changed: true };
}

async function adminResetPassword(accountId, newPassword, actor) {
  const problem = v.passwordProblem(newPassword);
  if (problem) throw bad(problem);
  const user = await db.queryOne('SELECT id FROM b2b_users WHERE account_id = ? AND is_primary = 1 LIMIT 1', [accountId]);
  if (!user) throw notFound('No login exists for this account');
  await db.query('UPDATE b2b_users SET password_hash = ?, token_version = token_version + 1, failed_logins = 0, locked_until = NULL WHERE id = ?',
    [security.hashPassword(newPassword), user.id]);
  await audit.log(null, actor, 'auth.password_reset_by_admin', 'account', accountId, null, null);
  // N5 security event: the owner hears about it by email (never the new password)
  await notifications.notifyAccount(null, accountId, { event: 'security.password_reset', channels: ['email'], title: 'Your password was reset by our team',
    lines: ['An administrator set a new password for your business portal login. You have been signed out everywhere.', 'If you did not ask for this, contact us straight away.'],
    link: '/b2b/login', refType: 'account', refId: accountId }).catch(function (e) { console.error('[B2B] password notice not queued:', e.code || e.message); });
  return { ok: true };
}

/** Resolve a document for download after checking it belongs to the account the caller is allowed to see. */
async function documentFile(documentId, accountIdScope) {
  const doc = await db.queryOne('SELECT * FROM b2b_documents WHERE id = ?', [documentId]);
  if (!doc) throw notFound('Document not found');
  if (accountIdScope != null && Number(doc.account_id) !== Number(accountIdScope)) throw forbidden();
  const p = uploads.documentPath(doc.stored_name);
  if (!p) throw notFound('The stored file is missing');
  return { doc: doc, path: p, stream: function () { return fs.createReadStream(p); } };
}

async function addDocument(accountId, docType, file, uploadedBy) {
  if (!DOC_LABEL[docType]) throw bad('Unknown document type');
  if (!file) throw bad('Choose a file to upload');
  const count = await db.queryOne('SELECT COUNT(*) AS n FROM b2b_documents WHERE account_id = ?', [accountId]);
  if (Number(count.n) >= 20) throw bad('This account already has the maximum number of documents');
  const saved = uploads.saveDocument(file);
  try {
    const res = await db.query(
      'INSERT INTO b2b_documents (account_id, doc_type, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [accountId, docType, saved.originalName, saved.storedName, saved.mime, saved.size, saved.sha256, uploadedBy]);
    return { id: res.insertId };
  } catch (e) { uploads.removeDocument(saved.storedName); throw e; }
}

module.exports = {
  STATUSES, TRANSITIONS, REQUIRED_DOCS, DOC_LABEL, BUSINESS_TYPES,
  listStates, listDistricts, register, login, changePassword,
  getAccount, contactCard, listAccounts, documentsFor, statusHistory, adminDetail,
  changeStatus, adminUpdate, selfUpdate, adminResetPassword, documentFile, addDocument,
};
