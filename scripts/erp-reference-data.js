#!/usr/bin/env node
/**
 * Loads the ERP reference data (permissions, the 13 system roles and their
 * permissions) from src/modules/erp/catalog/reference-data.json.
 *
 *   node scripts/erp-reference-data.js            report what is missing (read-only, default)
 *   node scripts/erp-reference-data.js --apply --confirm-reference-data
 *
 * Only INSERT IGNORE: it never updates, renames or removes anything, so roles a
 * person has edited stay as they are. It writes no business data. Running it on
 * production is decision D14 and needs your approval first.
 */
'use strict';
require('dotenv').config();
const path = require('path');
const db = require('../src/db/connection.js');
const ref = require(path.join(__dirname, '..', 'src', 'modules', 'erp', 'catalog', 'reference-data.json'));

const apply = process.argv.indexOf('--apply') !== -1;
const confirmed = process.argv.indexOf('--confirm-reference-data') !== -1;

(async function () {
  try {
    if (apply && !confirmed) throw new Error('Refused: --apply needs --confirm-reference-data');
    const loader = require('../src/modules/erp/catalog/load.js');
    const p = await loader.plan(db);
    console.log('Database: ' + db.config().database);
    console.log('Permissions missing: ' + p.missingPermissions.length + ' of ' + ref.permissions.length);
    console.log('System roles missing: ' + p.missingRoles.length + ' of ' + ref.roles.length);
    if (!apply) { console.log('\nRead-only report. Nothing was written.'); return; }
    const r = await db.transaction(function (tx) { return loader.apply(tx); });
    console.log('\nApplied: ' + r.permissionsAdded + ' permissions and ' + r.rolesAdded + ' roles added. Existing rows untouched.');
  } catch (e) {
    console.error(e.message); process.exitCode = 1;
  } finally { await db.close(); }
})();
