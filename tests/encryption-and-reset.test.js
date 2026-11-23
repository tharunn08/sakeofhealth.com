/**
 * Two safety fixes of 19 Nov 2026, database-free:
 *  - stored secrets (two-factor keys, bank details) are encrypted with ENCRYPTION_KEY (format v2), no longer
 *    with a key derived from the session secret ERP_JWT_SECRET; older v1 values stay readable;
 *  - `npm run reset` (scripts/reset-dev.js) refuses production and any folder that is not a development one.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

test('encryption: v2 uses ENCRYPTION_KEY and survives a new session secret; v1 values stay readable; tampering is refused', () => {
  const saved = { j: process.env.ERP_JWT_SECRET, k: process.env.ENCRYPTION_KEY };
  try {
    process.env.ERP_JWT_SECRET = 'session-secret-A-0123456789-abcdefghijklmnopqrstuvwxyz';
    delete process.env.ENCRYPTION_KEY;
    const sec = require('../src/modules/erp/core/security.js');
    const v1 = sec.encrypt('JBSWY3DPEHPK3PXP');
    assert.match(v1, /^v1:/, 'without ENCRYPTION_KEY the old format is still written (nothing breaks before the key is set)');

    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    assert.equal(sec.decrypt(v1), 'JBSWY3DPEHPK3PXP', 'existing v1 values remain readable after the key is added');
    const v2 = sec.encrypt('IFSC0001234 / 0123456789');
    assert.match(v2, /^v2:/);
    assert.equal(sec.decrypt(v2), 'IFSC0001234 / 0123456789');

    process.env.ERP_JWT_SECRET = 'session-secret-B-rotated-9876543210-zyxwvutsrqponmlkjihg';
    assert.equal(sec.decrypt(v2), 'IFSC0001234 / 0123456789', 'rotating the session secret no longer loses encrypted data');
    assert.equal(sec.decrypt(v1), null, 'v1 was tied to the old session secret — re-encrypt v1 values before rotating it');

    const parts = v2.split(':'); const body = Buffer.from(parts[3], 'base64'); body[0] ^= 1; parts[3] = body.toString('base64');
    assert.equal(sec.decrypt(parts.join(':')), null, 'a changed byte fails authentication (AES-256-GCM)');
    assert.equal(sec.decrypt('v3:x:y:z'), null);
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    assert.equal(sec.decrypt(v2), null, 'another key cannot read it');
    // a 32-byte base64 key and a long passphrase are both accepted
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    assert.equal(sec.decrypt(sec.encrypt('x')), 'x');
    process.env.ENCRYPTION_KEY = 'a long random passphrase that is not hex or base64 !!';
    assert.equal(sec.decrypt(sec.encrypt('y')), 'y');
  } finally {
    if (saved.j == null) delete process.env.ERP_JWT_SECRET; else process.env.ERP_JWT_SECRET = saved.j;
    if (saved.k == null) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = saved.k;
  }
});

test('npm run reset: refuses production and a non-development folder; a development folder is reseeded with the protected products', () => {
  const run = (env) => spawnSync(process.execPath, ['scripts/reset-dev.js'], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, env) });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'x-')) + '/sakeofhealth-data';
  fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'orders.json'), '[{"id":"real-order"}]');
  let r = run({ NODE_ENV: 'production', DATA_DIR: real });
  assert.equal(r.status, 1); assert.match(r.stderr, /NODE_ENV=production/);
  r = run({ NODE_ENV: 'development', DATA_DIR: real });
  assert.equal(r.status, 1); assert.match(r.stderr, /Refusing to reset/);
  assert.equal(fs.readFileSync(path.join(real, 'orders.json'), 'utf8'), '[{"id":"real-order"}]', 'a real-looking data folder is never touched');

  const dev = fs.mkdtempSync(path.join(os.tmpdir(), 'x-')) + '/sakeofhealth-dev';
  fs.mkdirSync(dev); fs.writeFileSync(path.join(dev, 'orders.json'), '[{"id":"old"}]');
  r = run({ NODE_ENV: 'development', DATA_DIR: dev });
  assert.equal(r.status, 0, r.stderr);
  const products = JSON.parse(fs.readFileSync(path.join(dev, 'products.json'), 'utf8'));
  const ids = products.map(p => p.id);
  for (const id of ['soh-core-multivitamin', 'soh-core-iron', 'soh-core-curcumin', 'soh-core-probiotic']) assert.ok(ids.includes(id), id);
  assert.ok(!fs.existsSync(path.join(dev, 'orders.json')) || !fs.readFileSync(path.join(dev, 'orders.json'), 'utf8').includes('"old"'));
});
