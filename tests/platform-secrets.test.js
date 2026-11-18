/**
 * Phase 1 step 1.1 — production secret minimums (correction 1: "a consistent
 * minimum of 48 random characters for all production JWT secrets"; no silent
 * derivation or fallback to another secret). DB-free. Written BEFORE the fix.
 */
const test = require('node:test');
const assert = require('node:assert');
const b2b = require('../src/modules/b2b/config.js');
const erp = require('../src/modules/erp/config.js');

const KEYS = ['NODE_ENV', 'B2B_JWT_SECRET', 'JWT_SECRET', 'ADMIN_JWT_SECRET', 'CUSTOMER_JWT_SECRET', 'ERP_JWT_SECRET'];
function withEnv(env, fn) {
  const saved = {};
  KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, env);
  try { return fn(); } finally { KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
}
const S = n => 'x'.repeat(n);                       // a secret of n characters
const A48 = 'a'.repeat(48), C48 = 'c'.repeat(48), B48 = 'b'.repeat(48), E48 = 'e'.repeat(48);

test('B2B production: 47 characters is refused, 48 is accepted', () => {
  withEnv({ NODE_ENV: 'production', B2B_JWT_SECRET: S(47) }, () => {
    assert.strictEqual(b2b.hasStrongSecret(), false);
    assert.throws(() => b2b.tokenSecret(), /48/);
  });
  withEnv({ NODE_ENV: 'production', B2B_JWT_SECRET: B48 }, () => {
    assert.strictEqual(b2b.hasStrongSecret(), true);
    assert.strictEqual(b2b.tokenSecret(), B48);
  });
});

test('B2B production: never derived from, or equal to, the admin or customer secret', () => {
  withEnv({ NODE_ENV: 'production', ADMIN_JWT_SECRET: A48 }, () => {
    assert.strictEqual(b2b.hasStrongSecret(), false, 'admin secret alone does not count');
    assert.throws(() => b2b.tokenSecret());
  });
  withEnv({ NODE_ENV: 'production', ADMIN_JWT_SECRET: A48, B2B_JWT_SECRET: A48 }, () => {
    assert.strictEqual(b2b.hasStrongSecret(), false, 'reusing the admin secret is refused');
  });
  withEnv({ NODE_ENV: 'production', CUSTOMER_JWT_SECRET: C48, B2B_JWT_SECRET: C48 }, () => {
    assert.strictEqual(b2b.hasStrongSecret(), false, 'reusing the customer secret is refused');
  });
});

test('B2B development keeps working as before (derived dev secret allowed outside production)', () => {
  withEnv({ NODE_ENV: 'development', B2B_JWT_SECRET: 'test-b2b-secret-not-for-production-123' }, () => {
    assert.strictEqual(b2b.tokenSecret(), 'test-b2b-secret-not-for-production-123');
  });
  withEnv({ NODE_ENV: 'test', ADMIN_JWT_SECRET: A48 }, () => {
    assert.ok(b2b.tokenSecret(), 'still signs in local development');
  });
});

test('ERP production: 47 characters is refused, 48 is accepted', () => {
  withEnv({ NODE_ENV: 'production', ERP_JWT_SECRET: S(47) }, () => {
    assert.strictEqual(erp.hasStrongSecret(), false);
    assert.throws(() => erp.tokenSecret(), /48/);
  });
  withEnv({ NODE_ENV: 'production', ERP_JWT_SECRET: E48 }, () => {
    assert.strictEqual(erp.hasStrongSecret(), true);
    assert.strictEqual(erp.tokenSecret(), E48);
  });
});

test('ERP production: must differ from the admin, customer and B2B secrets', () => {
  for (const other of ['ADMIN_JWT_SECRET', 'CUSTOMER_JWT_SECRET', 'B2B_JWT_SECRET']) {
    withEnv({ NODE_ENV: 'production', ERP_JWT_SECRET: E48, [other]: E48 }, () => {
      assert.strictEqual(erp.hasStrongSecret(), false, 'same as ' + other);
      assert.throws(() => erp.tokenSecret());
    });
  }
});

test('ERP development keeps the existing 32-character test secrets working', () => {
  withEnv({ NODE_ENV: 'test', ERP_JWT_SECRET: 'unit-test-erp-secret-0123456789abcdef' }, () => {
    assert.strictEqual(erp.tokenSecret(), 'unit-test-erp-secret-0123456789abcdef');
  });
});
