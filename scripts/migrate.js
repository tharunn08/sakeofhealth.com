#!/usr/bin/env node
/**
 * Database migration command.
 *
 *   npm run migrate            apply pending migrations
 *   npm run migrate:status     show what has / has not been applied
 *   npm run migrate:verify     check every expected table exists (exit 1 if not)
 *
 * Safe to run repeatedly. Never drops or truncates anything.
 */
require('dotenv').config();
const db = require('../src/db/connection.js');
const migrate = require('../src/db/migrate.js');

async function main() {
  const cmd = process.argv[2] || 'up';
  if (!db.isConfigured()) {
    console.error('✗ Database is not configured. Set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME.');
    process.exit(1);
  }
  const c = db.config();
  console.log('Database: ' + c.user + '@' + c.host + ':' + c.port + '/' + c.database);

  if (cmd === 'status') {
    const st = await migrate.status();
    st.migrations.forEach(function (m) {
      console.log((m.applied ? '  ✓ ' : '  · ') + m.file + (m.applied ? '' : '   (pending)') +
        (m.changedSinceApplied ? '   ⚠ file changed after it was applied' : ''));
    });
    console.log(st.upToDate ? 'Up to date.' : st.pending + ' migration(s) pending.');
  } else if (cmd === 'verify') {
    const r = await migrate.verify();
    if (r.missing.length) console.log('Missing tables: ' + r.missing.join(', '));
    if (r.notInnoDb.length) console.log('Not InnoDB: ' + r.notInnoDb.join(', '));
    if (r.pending) console.log(r.pending + ' migration(s) pending.');
    console.log(r.ok ? '✓ Schema verified.' : '✗ Schema is NOT complete.');
    if (!r.ok) process.exitCode = 1;
  } else if (cmd === 'up') {
    const r = await migrate.up(console.log);
    console.log(r.applied.length ? '✓ Applied ' + r.applied.length + ' migration(s).' : '✓ Nothing to do — already up to date.');
    const check = await migrate.verify();
    console.log(check.ok ? '✓ Schema verified.' : '✗ Schema verification failed: missing ' + check.missing.join(', '));
    if (!check.ok) process.exitCode = 1;
  } else {
    console.error('Unknown command "' + cmd + '". Use: up | status | verify');
    process.exitCode = 1;
  }
}

main()
  .catch(function (e) { console.error('✗ Migration failed: ' + (e.sqlMessage || e.message)); process.exitCode = 1; })
  .finally(function () { return db.close(); });
