#!/usr/bin/env node
/**
 * One finite background run for Hostinger Cron Jobs (Business hosting has no always-running worker).
 * It schedules, runs and records the background work, then exits — see src/platform/cron.js.
 *
 * hPanel → Advanced → Cron Jobs → Custom, every 5 minutes (*\/5 * * * *), command (one line, ≤ 255 characters):
 *   /opt/alt/alt-nodejs22/root/bin/node --env-file=/home/uXXX/domains/DOMAIN/hbuilds/config/.env /home/uXXX/domains/DOMAIN/hbuilds/current/nodejs/scripts/cron/run-jobs.js
 * Locally:  node scripts/cron/run-jobs.js [--json]     (reads .env in the project folder)
 *
 * Exit codes: 0 = ran (or nothing to do), 1 = a step had a problem (details printed and recorded),
 * 78 = the configuration is unsafe in production (same check as the web app's start).
 * Safe to run twice at once: the second run finds the lock taken and exits.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
// --env-file (Node ≥ 20.6) already loaded the variables; otherwise read the project's .env like the web app.
if (fs.existsSync(path.join(ROOT, '.env'))) require('dotenv').config({ path: path.join(ROOT, '.env') });

async function main(argv) {
  const json = argv.indexOf('--json') !== -1;
  const env = require('../../src/config/env.js');
  const lines = [];
  if (!env.startupCheck(process.env, { log: function (m) { lines.push(m); }, warn: function (m) { lines.push(m); }, error: function (m) { lines.push(m); } })) {
    console.error(lines.join('\n'));
    console.error('Cron run refused: fix the configuration first (node scripts/check-env.js --production).');
    return 78;
  }
  if (lines.length) console.warn(lines.join('\n'));   // configuration warnings, as at the web app's start
  require('../../src/modules/b2b/notifications/service.js').disableImmediateSend();   // this run sends in its own step
  const out = await require('../../src/platform/cron.js').runOnce({ trigger: 'cron' });
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    const b = out.business || {};
    console.log('[cron] ' + out.finishedAt + ' ' + (out.ok ? 'ok' : 'PROBLEM') + ' in ' + out.seconds + ' s · catalogue: ' + (out.catalogue ? out.catalogue.snapshot + ', backup ' + out.catalogue.backup + ', protected products ' + out.catalogue.protectedProducts : 'not checked') +
      ' · business: ' + (b.ran ? 'jobs ' + JSON.stringify(b.jobs || b.schedule) + ', messages ' + JSON.stringify(b.notifications) : b.reason));
    out.errors.forEach(function (e) { console.error('[cron] ' + e); });
  }
  return out.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(async function (code) {
    try { await require('../../src/db/connection.js').close(); } catch (e) { /* not opened */ }
    process.exit(code);
  }, function (e) { console.error('[cron] ' + (e && e.stack || e)); process.exit(1); });
}
module.exports = { main };
