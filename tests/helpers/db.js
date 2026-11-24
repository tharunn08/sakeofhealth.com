/**
 * Test database helper. Only ever runs against a dedicated test database whose
 * name ends in _test — it wipes the project (b2b_*) tables. (_dev/_local are
 * accepted by the app's own dev scripts, but never by the test suites.)
 */
const db = require('../../src/db/connection.js');
const migrate = require('../../src/db/migrate.js');

const TEST_DB = {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3306',
  DB_USER: process.env.TEST_DB_USER || 'root',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || '',
  DB_NAME: process.env.TEST_DB_NAME || 'sakeofhealth_test',
};

// The MySQL suites were written with two-step sign-in switched on; keep it on for them (and for the
// servers they start) unless a suite sets it itself. The in-app switch is tested in erp-unit.test.js.
if (process.env.ERP_MFA_REQUIRED === undefined) process.env.ERP_MFA_REQUIRED = 'true';

function useTestDatabase() {
  Object.assign(process.env, TEST_DB, { NODE_ENV: 'test' });
}

async function resetDatabase() {
  // D5 guard: migrate.up() applies EVERY file in src/db/migrations. Migrations
  // 013/014 must not run anywhere until the D5 decision is approved, so refuse
  // before touching any database while they are present (run the MySQL suites
  // from a clean checkout instead).
  const dir = require('path').join(__dirname, '..', '..', 'src', 'db', 'migrations');
  const held = require('fs').readdirSync(dir).filter(function (f) { return /^01[34]_/.test(f); });
  if (held.length) {
    throw new Error('D5 pending: migrations ' + held.join(', ') + ' are present and would be applied. ' +
      'Run the MySQL test suites from a clean checkout without them until the D5 decision is approved.');
  }
  if (!/_test$/i.test(TEST_DB.DB_NAME)) {
    throw new Error('Refusing to reset "' + TEST_DB.DB_NAME + '": the MySQL test suites only use a dedicated database whose name ends in _test.');
  }
  useTestDatabase();
  db.assertDisposableDatabase('test database reset');
  await db.withConnection(async function (conn) {
    const [tables] = await conn.raw.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'b2b\\_%'");
    await conn.raw.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const row of tables) await conn.raw.query('DROP TABLE IF EXISTS `' + row.t + '`');
    await conn.raw.query('SET FOREIGN_KEY_CHECKS = 1');
  });
  await migrate.up();
}

/** A syntactically valid GSTIN (correct check digit) for a state code + PAN. */
function gstin(stateCode, pan, entity) {
  const { gstinCheckDigit } = require('../../src/modules/b2b/lib/validate.js');
  const first14 = stateCode + pan + (entity || '1') + 'Z';
  return first14 + gstinCheckDigit(first14);
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

module.exports = { TEST_DB, useTestDatabase, resetDatabase, gstin, PNG, PDF, db };
