/**
 * Test-only helpers for the B2C auth security tests: craft tokens in the
 * B2C token format with a chosen secret, and list every B2C admin route.
 */
const { createHmac } = require('crypto');
const fs = require('fs');
const path = require('path');

function craft(payload, secret, ttlMs) {
  const body = Object.assign({ exp: Date.now() + (ttlMs || 3600 * 1000) }, payload);
  const enc = Buffer.from(JSON.stringify(body)).toString('base64url');
  return enc + '.' + createHmac('sha256', secret).update(enc).digest('base64url');
}

/* Every route registered in src/routes/admin.js, mounted at /api/admin. */
function adminRoutes() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'admin.js'), 'utf8');
  const out = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[2] === '/login') continue;
    out.push({ method: m[1].toUpperCase(), path: '/api/admin' + m[2].replace(/:(\w+)/g, 'x-$1') });
  }
  return out;
}

// 48+ character secrets used by the test servers (never real secrets).
const SECRETS = {
  admin: 'test-admin-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  customer: 'test-customer-secret-0123456789-abcdefghijklmnopqrstuv',
};

module.exports = { craft, adminRoutes, SECRETS };
