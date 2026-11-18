/**
 * ERP integration-test helper: a fresh TEST database (all migrations), the reference
 * roles, two Super Admins with MFA (maker and checker), people with other roles, and a
 * running server. Only for databases ending in _test/_dev/_local (wiped).
 */
const { startServer, bearer } = require('./server.js');
const { TEST_DB, resetDatabase, db } = require('./db.js');

const ERP_SECRET = 'test-erp-secret-not-for-production-0123456789';
process.env.ERP_JWT_SECRET = ERP_SECRET;
const security = require('../../src/modules/erp/core/security.js');
const loader = require('../../src/modules/erp/catalog/load.js');

const ENV = { B2B_ENABLED: 'true', ERP_ENABLED: 'true', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123', ERP_JWT_SECRET: ERP_SECRET,
  WHATSAPP_APP_SECRET: 'whatsapp-app-secret-1234567890', WHATSAPP_VERIFY_TOKEN: 'verify-me', ERP_WORKER_INTERVAL_MS: '3600000' };

function code(secret) { return security.totpAt(secret, Math.floor(Date.now() / 30000)); }

async function addStaff(name, email, roles, opts) {
  opts = opts || {};
  const pw = 'Pw-' + email.replace(/[^a-z]/g, '') + '-123456';
  const secret = opts.mfa === false ? null : security.newTotpSecret();
  const r = await db.query('INSERT INTO b2b_staff (name, email, password_hash, mfa_secret_enc, mfa_enabled) VALUES (?, ?, ?, ?, ?)',
    [name, email, security.hashPassword(pw), secret ? security.encrypt(secret) : null, secret ? 1 : 0]);
  for (const role of roles || []) {
    const ro = await db.queryOne('SELECT id FROM b2b_roles WHERE code = ?', [typeof role === 'string' ? role : role.code]);
    const scopeType = role.scopeType || 'all', scopeId = role.scopeId || null;
    await db.query('INSERT INTO b2b_staff_roles (staff_id, role_id, scope_type, scope_id) VALUES (?, ?, ?, ?)', [r.insertId, ro.id, scopeType, scopeId]);
  }
  return { id: Number(r.insertId), email: email, pw: pw, secret: secret };
}

async function setup(extraEnv) {
  await resetDatabase();
  await db.transaction(function (tx) { return loader.apply(tx); });
  const s = await startServer(Object.assign({}, TEST_DB, ENV, extraEnv || {}));
  const ctx = { s: s, db: db, people: {} };
  ctx.person = async function (key, roles, opts) {
    const p = await addStaff(key, key + '@test.local', roles, opts);
    const r = await s.post('/api/erp/core/login', { email: p.email, password: p.pw, totp: p.secret ? code(p.secret) : undefined });
    if (r.status !== 200) throw new Error('login failed for ' + key + ': ' + JSON.stringify(r.data));
    p.h = bearer(r.data.token);
    ctx.people[key] = p;
    return p;
  };
  ctx.maker = await ctx.person('maker', ['super_admin']);
  ctx.checker = await ctx.person('checker', ['super_admin']);
  /** Approve a pending request as the checker; asserts success. */
  ctx.approve = async function (approvalId, who) {
    const r = await s.post('/api/erp/core/approvals/' + approvalId + '/decide', { decision: 'approved', comment: 'ok' }, (who || ctx.checker).h);
    if (r.status !== 200) throw new Error('approve ' + approvalId + ' failed: ' + r.status + ' ' + JSON.stringify(r.data));
    return r.data;
  };
  ctx.setting = async function (key, value) {
    const r = await s.put('/api/erp/core/settings/' + key, { value: value, reason: 'Test decision' }, ctx.maker.h);
    if (r.status !== 202) throw new Error('setting ' + key + ': ' + JSON.stringify(r.data));
    return ctx.approve(r.data.approvalId);
  };
  ctx.stop = async function () {
    if (process.env.ERP_TEST_SERVER_LOG) require('fs').writeFileSync(process.env.ERP_TEST_SERVER_LOG, s.log());
    await s.stop(); await db.close();
  };
  return ctx;
}

/** Multipart upload helper (Node 18+ fetch/FormData). */
async function upload(s, url, fields, file, headers) {
  const f = new FormData();
  Object.keys(fields || {}).forEach(function (k) { f.append(k, String(fields[k])); });
  if (file) f.append('file', new Blob([file.data]), file.name);
  const res = await fetch(s.base + url, { method: 'POST', body: f, headers: headers || {} });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data: data };
}

module.exports = { setup, upload, code, addStaff, db, bearer };
