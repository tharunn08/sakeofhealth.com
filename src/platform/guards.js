/**
 * Shop/trade staff (staff.json) created with a temporary password carry
 * mustChangePassword: true. Until they choose a new one at /login, every admin
 * API (shop and trade) answers 403 password_change_required. The root admin
 * from the environment is never affected.
 */
'use strict';
const { verifyToken } = require('../middleware/adminAuth.js');

const REQUIRED = { error: 'Please choose a new password before continuing. Sign in at /login to set it.', code: 'password_change_required' };

function staffMustChangePassword(req, res, next) {
  if (req.path === '/login') return next();
  const auth = req.headers['authorization'] || '';
  const payload = auth.startsWith('Bearer ') ? verifyToken(auth.slice(7)) : null;
  if (!payload || payload.sub === 'root') return next();          // adminAuth answers missing/invalid tokens as before
  const staff = require('../services/db.js').db.staff.findById(payload.sub);
  if (staff && staff.mustChangePassword === true) return res.status(403).json(REQUIRED);
  next();
}

module.exports = { staffMustChangePassword, REQUIRED };
