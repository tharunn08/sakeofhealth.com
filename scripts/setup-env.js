#!/usr/bin/env node
/**
 * npm run setup — gets a computer ready to run Sake of Health locally (Windows, macOS, Linux).
 *   1. checks Node.js (20.6 or newer; 22 recommended — the version Hostinger runs it on)
 *   2. checks the environment files; creates .env from .env.development.example if there is none,
 *      filling every <generated> secret with a fresh random value (an existing .env is NEVER overwritten)
 *   3. validates the configuration (src/config/env.js) — names and problems only, never values
 *   4. if the business platform is on (B2B_ENABLED=true), checks that MySQL answers with those credentials
 *   5. lists the integrations that are not configured yet (e-mail, WhatsApp, payments…)
 * Refuses to create anything when NODE_ENV=production: production settings live in hPanel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { secret, password } = require('./generate-secrets.js');

const PROJECT = path.join(__dirname, '..');
// --root=<folder>: where the .env files are (default: this project). Used by the tests.
const rootArg = process.argv.filter(function (a) { return a.indexOf('--root=') === 0; })[0];
const ROOT = rootArg ? path.resolve(rootArg.slice(7)) : PROJECT;
const say = function (s) { console.log(s); };

async function main() {
  let problems = 0;
  // 1. Node
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 20 || (maj === 20 && min < 6)) { say('✗ Node.js ' + process.versions.node + ' is too old: install Node.js 22 LTS from https://nodejs.org'); return 1; }
  say('✓ Node.js ' + process.versions.node + (maj === 22 ? '' : ' (22 LTS recommended — the version to choose on Hostinger)'));
  if (!fs.existsSync(path.join(PROJECT, 'node_modules', 'express'))) { say('✗ Dependencies are missing: run  npm ci  first.'); return 1; }

  // 2. environment files
  const dotenv = path.join(ROOT, '.env');
  if (process.env.NODE_ENV === 'production') { say('✗ NODE_ENV=production: set production variables in hPanel, not with this script.'); return 1; }
  ['.env.example', '.env.development.example', '.env.production.example'].forEach(function (f) {
    if (!fs.existsSync(path.join(ROOT, f))) { say('✗ ' + f + ' is missing from the project (run: node scripts/env-templates.js)'); problems++; }
  });
  if (fs.existsSync(dotenv)) say('✓ .env exists — left exactly as it is');
  else {
    let text = fs.readFileSync(path.join(ROOT, '.env.development.example'), 'utf8');
    let adminPassword = null;
    text = text.replace(/^([A-Z0-9_]+)=<generated>$/gm, function (_, name) {
      if (name === 'ADMIN_PASSWORD') { adminPassword = password(); return name + '=' + adminPassword; }
      return name + '=' + secret(name);
    });
    fs.writeFileSync(dotenv, text, { mode: 0o600 });
    say('✓ Created .env from .env.development.example with fresh secrets.');
    if (adminPassword) say('  Local admin sign-in: ' + (/^ADMIN_EMAIL=(.*)$/m.exec(text) || [])[1] + ' / ' + adminPassword + '   (only in this .env; change it any time)');
  }

  // 3. validate
  require('dotenv').config({ path: dotenv });
  const { validate, format } = require('../src/config/env.js');
  const r = validate(process.env);
  if (r.errors.length || r.warnings.length) format(r).forEach(say);
  if (r.errors.length) { say('✗ The configuration has ' + r.errors.length + ' problem(s) — fix them in .env'); problems++; } else say('✓ Configuration is valid for ' + r.mode);

  // 4. MySQL
  if (String(process.env.B2B_ENABLED).toLowerCase() === 'true') {
    try {
      const mysql = require('mysql2/promise');
      const c = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME, connectTimeout: 5000 });
      const [rows] = await c.query('SELECT VERSION() AS v');
      await c.end();
      const v = String(rows[0].v);
      say('✓ MySQL answers (version ' + v + ') on ' + process.env.DB_HOST + ' / database ' + process.env.DB_NAME + (/^8\./.test(v) ? '' : ' — MySQL 8 is required'));
      if (!/^8\./.test(v)) problems++;
    } catch (e) {
      say('✗ MySQL did not answer with the DB_* settings in .env (' + (e.code || 'error') + '). Check that MySQL 8 is running and the database and user exist.');
      problems++;
    }
  } else say('· Business platform is off (B2B_ENABLED=false): MySQL not checked');

  // 5. integrations
  const missing = [];
  if (!process.env.SMTP_HOST) missing.push('e-mail (SMTP_HOST…)');
  if (!process.env.WHATSAPP_TOKEN && !process.env.TWILIO_ACCOUNT_SID) missing.push('WhatsApp (WHATSAPP_TOKEN…)');
  if (!process.env.MSG91_AUTH_KEY) missing.push('SMS (MSG91_AUTH_KEY)');
  if (!process.env.RAZORPAY_KEY_ID) missing.push('payments (RAZORPAY_KEY_ID — mock payments are used locally)');
  if ((process.env.STORAGE_PROVIDER || 'local') === 'local') missing.push('external file storage (STORAGE_PROVIDER=local: files stay on this machine)');
  if (missing.length) say('· Not configured (fine for local development): ' + missing.join('; '));
  say(problems ? '\nSetup finished with ' + problems + ' problem(s).' : '\nReady: npm run dev  →  http://localhost:' + (process.env.PORT || 3000));
  return problems ? 1 : 0;
}

main().then(function (code) { process.exitCode = code; }, function (e) { console.error('✗ ' + e.message); process.exitCode = 1; });
