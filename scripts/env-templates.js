#!/usr/bin/env node
/**
 * Writes the environment templates and the reference from src/config/env-schema.js:
 *   .env.example               every variable, with comments (development values)
 *   .env.development.example   a working local setup (secrets filled by: npm run setup)
 *   .env.production.example    what to enter in hPanel → Node.js app → Environment variables
 *   docs/unified/ENVIRONMENT.md   the reference table
 * node scripts/env-templates.js           write them
 * node scripts/env-templates.js --check   exit 1 if any is out of date (used by the tests)
 * The templates hold no real secret: secret lines are empty or "<generated>" placeholders.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { GROUPS, VARS, TOOL_VARS } = require('../src/config/env-schema.js');

const ROOT = path.join(__dirname, '..');
const needText = function (v) {
  return v.need === 'always' ? 'required' : v.need === 'production' ? 'required in production' : v.need === 'when' ? 'required when ' + v.whenText : 'optional';
};
function wrap(text, width, prefix) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  words.forEach(function (w) { if ((line + ' ' + w).trim().length > width) { lines.push(line); line = w; } else line = (line + ' ' + w).trim(); });
  if (line) lines.push(line);
  return lines.map(function (l) { return prefix + l; }).join('\n');
}

function template(kind) {
  const head = {
    example: ['Sake of Health — every environment variable (generated from src/config/env-schema.js; do not edit by hand).',
      'Copy to .env for local development, or run: npm run setup  (creates .env with fresh secrets).',
      'NEVER commit .env. Real secrets go only in .env on your computer or in hPanel on the server.'],
    development: ['Sake of Health — local development (generated; do not edit by hand).',
      'npm run setup copies this to .env and fills every <generated> secret with a fresh random value.',
      'Payments run in mock mode; the business platform stays off until you set up a local MySQL test database.'],
    production: ['Sake of Health — PRODUCTION on Hostinger Business (generated; do not edit by hand).',
      'Enter these in hPanel → your Node.js app → Deployments → Settings → Environment variables. Never upload a .env file with real values.',
      'Secrets: generate each with  npm run secrets  on your computer and paste them in hPanel. Replace <hostinger-user> with your user (e.g. u123456789).',
      'The server refuses to start in production while a required value is missing or unsafe (see docs/unified/ENVIRONMENT.md).'],
  }[kind];
  const out = ['# ' + '═'.repeat(70)].concat(head.map(function (l) { return '#  ' + l; }), ['# ' + '═'.repeat(70), '']);
  GROUPS.forEach(function (g) {
    const vars = VARS.filter(function (v) { return v.group === g[0] && !v.scriptOnly && !(kind !== 'example' && v.testOnly); });
    if (!vars.length) return;
    out.push('# ─── ' + g[1] + ' ' + '─'.repeat(Math.max(3, 62 - g[1].length)));
    vars.forEach(function (v) {
      out.push(wrap(v.doc + ' [' + needText(v) + (v.default ? '; default ' + v.default : '') + ']', 96, '# '));
      if (v.pattern === true) { out.push('# ' + v.name.replace('<NAME>', 'EXAMPLE') + '='); return; }
      const value = kind === 'production' ? v.prod : v.dev;
      const line = v.name + '=' + (value == null ? '' : value);
      const commentOut = kind === 'production' && v.need === 'optional' && !value;
      out.push((commentOut ? '# ' : '') + line);
    });
    out.push('');
  });
  return out.join('\n');
}

function reference() {
  const out = ['# Environment variables', '',
    'Generated from `src/config/env-schema.js` by `node scripts/env-templates.js` — do not edit by hand. ' +
    'The server checks all of them at start-up (`src/config/env.js`); in production a missing or unsafe value stops the start with a list of what to fix. ' +
    'Check a configuration without starting: `npm run check:env`.', '',
    'Templates: `.env.example` (all), `.env.development.example` (local), `.env.production.example` (Hostinger). Secrets are never printed or logged.', ''];
  GROUPS.forEach(function (g) {
    const vars = VARS.filter(function (v) { return v.group === g[0]; });
    if (!vars.length) return;
    out.push('## ' + g[1], '', '| Variable | Needed | Type | Default | What it does |', '| --- | --- | --- | --- | --- |');
    vars.forEach(function (v) {
      const type = v.type + (v.secret ? ' (secret)' : '') + (v.minLength ? ', ' + (v.prodMinLength ? v.minLength + '+ chars (' + v.prodMinLength + '+ in production)' : v.minLength + '+ chars') : '');
      out.push('| `' + v.name + '` | ' + needText(v) + (v.scriptOnly ? ' (only for ' + v.scriptOnly + ')' : '') + (v.testOnly ? ' (tests only)' : '') + ' | ' + type + ' | ' +
        (v.default ? '`' + v.default + '`' : '—') + ' | ' + v.doc.replace(/\|/g, '\\|') + (v.deprecated ? ' **Deprecated:** ' + v.deprecated : '') + ' |');
    });
    out.push('');
  });
  out.push('## Used only by developer tools', '', '| Variable | Used by |', '| --- | --- |');
  TOOL_VARS.forEach(function (v) { out.push('| `' + v.name + '` | ' + v.doc + ' |'); });
  out.push('', '## Not used by this application', '',
    'These appear in generic checklists but nothing in the code reads them, so they are deliberately not configured: ' +
    '`APP_URL`/`API_BASE_URL`/`FRONTEND_URL` (one app serves shop, API and portals at `SITE_URL`), `APP_TIMEZONE` (business days are computed in India time in code), ' +
    '`SESSION_SECRET`/`CSRF_SECRET`/`COOKIE_*` (sessions are signed bearer tokens per audience, not cookies), `ENCRYPTION_KEY` (bank account numbers are encrypted with a key derived from `ERP_JWT_SECRET` — see the security report), ' +
    '`PAYMENT_PROVIDER` (Razorpay only), `AI_*` (no AI integration), `ERROR_TRACKING_DSN`/`LOG_LEVEL` (logs go to the Hostinger app log), `CASHFREE_*`/`COD_ENABLED` (removed from the old template: never read by the code).', '');
  return out.join('\n');
}

const files = {
  '.env.example': template('example') + '\n',
  '.env.development.example': template('development') + '\n',
  '.env.production.example': template('production') + '\n',
  'docs/unified/ENVIRONMENT.md': reference(),
};

if (process.argv.includes('--check')) {
  const stale = Object.keys(files).filter(function (f) {
    try { return fs.readFileSync(path.join(ROOT, f), 'utf8') !== files[f]; } catch (e) { return true; }
  });
  if (stale.length) { console.error('Out of date (run node scripts/env-templates.js): ' + stale.join(', ')); process.exit(1); }
  console.log('Environment templates and reference are up to date.');
} else {
  Object.keys(files).forEach(function (f) { fs.writeFileSync(path.join(ROOT, f), files[f]); console.log('wrote ' + f); });
}
module.exports = { files };
