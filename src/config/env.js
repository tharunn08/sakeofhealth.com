/**
 * Environment validation — run at start-up (src/server.js) and by `npm run check:env`.
 *
 * validate(env, { appRoot }) → { mode, errors: [{ name, message }], warnings: [...], missing: [...] }
 * Values of secrets are never included in any message. In production an error stops the start-up
 * with a clear list of what to set; nothing falls back to an insecure default there.
 */
'use strict';
const path = require('path');
const { VARS, GROUPS } = require('./env-schema.js');

const PLACEHOLDER = /^(change-?me|changeme|your[-_ ]|xxx+|<.*>|example|test123|password|secret)$/i;

function isTrue(v) { return String(v || '').toLowerCase() === 'true'; }
function blank(v) { return v === undefined || v === null || String(v).trim() === ''; }

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function checkType(v, value, mode) {
  const s = String(value).trim();
  switch (v.type) {
    case 'int': {
      if (!/^-?\d+$/.test(s)) return 'must be a whole number';
      const n = Number(s);
      if (v.min != null && n < v.min) return 'must be at least ' + v.min;
      if (v.max != null && n > v.max) return 'must be at most ' + v.max;
      return null;
    }
    case 'bool': return /^(true|false)$/i.test(s) ? null : 'must be true or false';
    case 'enum': return v.values.indexOf(s) !== -1 ? null : 'must be one of ' + v.values.join(', ');
    case 'url': {
      let u; try { u = new URL(s); } catch (e) { return 'must be a full address starting with https://'; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'must start with https://';
      if (mode === 'production' && u.protocol !== 'https:' && !v.testOnly) return 'must use https:// in production';
      return null;
    }
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? null : 'must be an e-mail address';
    case 'csv': return s.split(',').every(function (x) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim()); }) ? null : 'must be comma-separated e-mail addresses';
    case 'path': return null;
    default:
      if (v.pattern instanceof RegExp && !v.pattern.test(s)) return 'has an unexpected format';
      return null;
  }
}

function validate(env, opts) {
  env = env || process.env;
  opts = opts || {};
  const appRoot = path.resolve(opts.appRoot || path.join(__dirname, '..', '..'));
  const mode = env.NODE_ENV === 'production' ? 'production' : (env.NODE_ENV === 'test' ? 'test' : 'development');
  const errors = [], warnings = [], missing = [];
  const err = function (name, message) { errors.push({ name: name, message: message }); };
  const warn = function (name, message) { warnings.push({ name: name, message: message }); };

  VARS.forEach(function (v) {
    if (v.pattern === true || v.scriptOnly) return;          // name families and one-off script inputs
    const value = env[v.name];
    const required = v.need === 'always' || (v.need === 'production' && mode === 'production') || (v.need === 'when' && v.when(env));
    if (blank(value)) {
      if (required) {
        missing.push(v.name);
        const why = v.need === 'when' ? ' (required when ' + v.whenText + ')' : (v.need === 'production' ? ' (required in production)' : '');
        (mode === 'production' ? err : warn)(v.name, 'is not set' + why + ' — ' + v.doc);
      }
      return;
    }
    if (/<[a-z][a-z0-9-]*>/i.test(String(value))) { (mode === 'production' ? err : warn)(v.name, 'still contains a placeholder such as <hostinger-user> or <generated> — replace it'); return; }
    const problem = checkType(v, value, mode);
    if (problem) { err(v.name, problem); return; }
    if (v.deprecated) warn(v.name, 'is deprecated: ' + v.deprecated);
    if (v.testOnly && mode === 'production') err(v.name, 'is for tests only and must not be set in production');
    if (v.prodMustBe != null && mode === 'production' && String(value).toLowerCase() !== v.prodMustBe) {
      err(v.name, 'must be ' + v.prodMustBe + ' in production');
    }
    if (v.type === 'secret') {
      const s = String(value);
      const min = mode === 'production' && v.prodMinLength ? v.prodMinLength : v.minLength;
      if (min && s.length < min) (mode === 'production' ? err : warn)(v.name, 'is too short: at least ' + min + ' characters (run: npm run secrets)');
      if (PLACEHOLDER.test(s.trim())) (mode === 'production' ? err : warn)(v.name, 'still holds a placeholder value');
    }
    if (v.type === 'path') {
      const p = String(value).trim();
      if (mode === 'production' && !path.isAbsolute(p)) err(v.name, 'must be an absolute path in production (e.g. /home/<user>/' + path.basename(p) + ')');
      else if (v.outsideApp && inside(path.resolve(p), appRoot)) {
        (mode === 'production' ? err : warn)(v.name, 'points inside the application folder — every deploy replaces that folder, so the data would be lost. Use a folder outside it.');
      } else if (v.outsideApp && mode === 'production' && /[\\/](hbuilds|public_html)([\\/]|$)/.test(p)) {
        err(v.name, 'points into hbuilds/ or public_html/, which Hostinger overwrites on every deploy. Use /home/<user>/<folder> instead.');
      }
    }
  });

  // secrets that must differ from each other
  const distinct = VARS.filter(function (v) { return v.distinct && !blank(env[v.name]); });
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      if (env[distinct[i].name] === env[distinct[j].name]) (mode === 'production' ? err : warn)(distinct[i].name, 'must differ from ' + distinct[j].name);
    }
  }
  // cross-variable rules
  if (isTrue(env.ERP_ENABLED) && !isTrue(env.B2B_ENABLED)) warn('ERP_ENABLED', 'has no effect unless B2B_ENABLED=true');
  if (mode === 'production' && /^rzp_test_/.test(String(env.RAZORPAY_KEY_ID || ''))) warn('RAZORPAY_KEY_ID', 'is a TEST key on a production site: customers cannot really pay');
  if (mode !== 'production' && /^rzp_live_/.test(String(env.RAZORPAY_KEY_ID || ''))) err('RAZORPAY_KEY_ID', 'is a LIVE key outside production — use rzp_test_ keys for development and tests');
  if (mode === 'production' && (env.JOBS_MODE || 'cron') === 'inprocess') warn('JOBS_MODE', 'inprocess timers stop when Hostinger idles or redeploys the app; use JOBS_MODE=cron with Hostinger Cron Jobs');
  if (mode === 'production' && isTrue(env.B2B_ENABLED) && isTrue(env.ERP_ENABLED) && blank(env.ENCRYPTION_KEY)) {
    warn('ENCRYPTION_KEY', 'not set: bank account numbers and 2FA secrets are encrypted with a key derived from ERP_JWT_SECRET, so ERP_JWT_SECRET must never change. Set ENCRYPTION_KEY (npm run secrets) before saving any.');
  }
  if (mode === 'production' && isTrue(env.DB_AUTO_MIGRATE)) warn('DB_AUTO_MIGRATE', 'runs migrations at start without a backup step — prefer npm run migrate after npm run backup');
  if (mode === 'production' && blank(env.SMTP_HOST)) warn('SMTP_HOST', 'not set: no e-mail will be sent (order confirmations, OTPs, invoices are recorded as "not sent")');
  if (mode === 'production' && blank(env.WHATSAPP_TOKEN) && blank(env.TWILIO_ACCOUNT_SID)) warn('WHATSAPP_TOKEN', 'not set: no WhatsApp messages will be sent');
  return { mode: mode, errors: errors, warnings: warnings, missing: missing };
}

/** Lines for the console — names and reasons only, never values. */
function format(result) {
  const lines = [];
  result.errors.forEach(function (e) { lines.push('  ✗ ' + e.name + ' ' + e.message); });
  result.warnings.forEach(function (w) { lines.push('  ! ' + w.name + ' ' + w.message); });
  return lines;
}

/** Start-up check: production with errors → exit(1) after printing what to fix. Elsewhere warnings only. */
function startupCheck(env, log) {
  log = log || console;
  env = env || process.env;
  const r = validate(env);
  if (r.errors.length || r.warnings.length) {
    (r.errors.length ? log.error : log.warn)('[CONFIG] Environment check (' + r.mode + '): ' + r.errors.length + ' problem(s), ' + r.warnings.length + ' warning(s)');
    format(r).forEach(function (l) { (l.indexOf('  ✗') === 0 ? log.error : log.warn)(l); });
  }
  if (r.errors.length && r.mode === 'production') {
    if (String(env.CONFIG_STRICT || 'true').toLowerCase() === 'false') {
      log.error('[CONFIG] CONFIG_STRICT=false: starting DESPITE the problems above. Fix them and remove CONFIG_STRICT.');
      return true;
    }
    log.error('[CONFIG] Not starting. Set the variables above in hPanel → your Node.js app → Environment variables (see docs/unified/ENVIRONMENT.md), then redeploy.');
    return false;
  }
  return true;
}

module.exports = { validate, format, startupCheck, VARS, GROUPS };
