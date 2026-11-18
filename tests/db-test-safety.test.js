/**
 * Safety: the MySQL test helper must never apply migrations 013/014 while the
 * D5 decision is pending. It runs every migration file in the folder, so with
 * the owner's untracked 013/014 present it must refuse BEFORE touching any database.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');
const pending = fs.readdirSync(DIR).filter(f => /^01[34]_/.test(f));

test('with migrations 013/014 present, the MySQL test helper refuses before connecting', { skip: pending.length ? false : 'no 013/014 files in this checkout' }, async () => {
  const { resetDatabase } = require('./helpers/db.js');
  const started = Date.now();
  await assert.rejects(resetDatabase(), /D5/);
  assert.ok(Date.now() - started < 2000, 'refused immediately, no connection attempt');
});
