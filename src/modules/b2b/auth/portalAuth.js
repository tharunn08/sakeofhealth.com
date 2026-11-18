/**
 * Authentication + authorisation middleware for business (retailer /
 * distributor) users. The token only identifies the user — role, account and
 * status are re-read from the database on EVERY request, so a suspended
 * account or changed password takes effect immediately and nothing the
 * browser sends can raise its own privileges.
 */
const db = require('../../../db/connection.js');
const security = require('../lib/security.js');

function tokenFrom(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

async function loadIdentity(payload) {
  if (!payload || !payload.uid) return null;
  const row = await db.queryOne(
    'SELECT u.id AS user_id, u.name AS user_name, u.email AS user_email, u.mobile AS user_mobile, u.status AS user_status, ' +
    '       u.token_version, a.*, s.name AS state_name, s.gst_code AS state_gst_code ' +
    'FROM b2b_users u JOIN b2b_accounts a ON a.id = u.account_id JOIN b2b_states s ON s.id = a.state_id WHERE u.id = ?',
    [payload.uid]);
  if (!row) return null;
  if (Number(row.token_version) !== Number(payload.tv)) return null;       // password changed / sessions revoked
  if (row.user_status !== 'active' || row.status === 'blocked') return null;
  const account = Object.assign({}, row);
  ['user_id', 'user_name', 'user_email', 'user_mobile', 'user_status', 'token_version'].forEach(function (k) { delete account[k]; });
  account.id = Number(account.id);
  return {
    user: { id: Number(row.user_id), name: row.user_name, email: row.user_email, mobile: row.user_mobile },
    account: account,
  };
}

/** Any signed-in business user (including accounts still awaiting approval). */
function requireBusiness(req, res, next) {
  const payload = security.verifyToken(tokenFrom(req));
  if (!payload) return res.status(401).json({ error: 'Please log in to continue' });
  loadIdentity(payload).then(function (identity) {
    if (!identity) return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
    return require('../../../db/mustChange.js').get('business', identity.user.id).then(function (must) {
      // A temporary password must be replaced first: only "who am I" and "change my password" work.
      if (must && !/\/me(\/password)?$/.test(req.path)) return res.status(403).json(require('../../../db/mustChange.js').REQUIRED);
      req.b2b = identity;
      next();
    });
  }).catch(next);
}

/** The catalogue, cart, orders and everything commercial need an APPROVED account. */
function requireApproved(req, res, next) {
  const status = req.b2b && req.b2b.account.status;
  if (status === 'approved') return next();
  const msg = {
    pending: 'Your account is awaiting approval. You will be able to order as soon as it is approved.',
    under_review: 'Your account is under review. You will be able to order as soon as it is approved.',
    rejected: 'Your registration was not approved. Please contact support.',
    suspended: 'Your account is suspended. Please contact support.',
  }[status] || 'Your account is not active.';
  res.status(403).json({ error: msg, accountStatus: status });
}

function requireType(type) {
  return function (req, res, next) {
    if (req.b2b && req.b2b.account.account_type === type) return next();
    res.status(403).json({ error: 'This area is only available to ' + type + 's' });
  };
}

module.exports = { requireBusiness, requireApproved, requireType };
