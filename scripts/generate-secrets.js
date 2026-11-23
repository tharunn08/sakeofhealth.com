#!/usr/bin/env node
/**
 * npm run secrets — prints a fresh, cryptographically random value for every secret the application
 * signs or encrypts with, ready to paste into hPanel (or .env). Each value is different. Nothing is
 * written to disk and nothing is sent anywhere.
 *
 *   npm run secrets               all secrets (64 characters, base64url, from crypto.randomBytes(48))
 *   npm run secrets -- ERP_JWT_SECRET CRON_SECRET    only these
 *
 * Changing a signing secret signs everyone out of that area. ENCRYPTION_KEY is different: never change
 * it once data was saved with it — generate it once and keep it in your password manager.
 */
'use strict';
const crypto = require('crypto');

const GENERATED = ['ADMIN_JWT_SECRET', 'CUSTOMER_JWT_SECRET', 'B2B_JWT_SECRET', 'ERP_JWT_SECRET', 'ENCRYPTION_KEY', 'CRON_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'MSG91_WEBHOOK_TOKEN'];

function secret(name) {
  if (name === 'ENCRYPTION_KEY') return crypto.randomBytes(32).toString('hex');   // exactly 32 bytes of key
  return crypto.randomBytes(48).toString('base64url');                               // 64 characters
}
/** A readable password for the first admin sign-in (to be changed after signing in). */
function password() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += abc[b[i] % abc.length];
  // letters, digits and hyphens only: a '#' would start a comment in .env and cut the password short
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12) + '-' + out.slice(12) + '-9';
}

if (require.main === module) {
  const want = process.argv.slice(2).filter(function (a) { return /^[A-Z0-9_]+$/.test(a); });
  const names = want.length ? want : GENERATED;
  const unknown = names.filter(function (n) { return GENERATED.indexOf(n) === -1 && n !== 'ADMIN_PASSWORD'; });
  if (unknown.length) { console.error('Not a generated secret: ' + unknown.join(', ') + '. Known: ' + GENERATED.concat('ADMIN_PASSWORD').join(', ')); process.exit(2); }
  console.log('# Fresh secrets — paste into hPanel → Environment variables. Do not commit, e-mail or share them.');
  names.forEach(function (n) { console.log(n + '=' + (n === 'ADMIN_PASSWORD' ? password() : secret(n))); });
  if (names.indexOf('ENCRYPTION_KEY') !== -1) console.log('# ENCRYPTION_KEY: set once, keep a copy in your password manager, never change it.');
}

module.exports = { secret, password, GENERATED };
