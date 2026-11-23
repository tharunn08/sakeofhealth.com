/**
 * Environment configuration: the schema covers every variable the code reads (and nothing unused),
 * templates and reference are generated and hold no secrets, start-up validation refuses unsafe
 * production settings with clear messages and never prints a secret, secrets are generated securely,
 * the setup script never overwrites an existing .env.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { VARS, TOOL_VARS } = require('../src/config/env-schema.js');
const { validate } = require('../src/config/env.js');

const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function codeFiles(dir) {
  const out = [];
  for (const n of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, n), full = path.join(ROOT, rel);
    if (fs.statSync(full).isDirectory()) out.push(...codeFiles(rel)); else if (/\.js$/.test(n)) out.push(rel);
  }
  return out;
}
const CODE = codeFiles('src').concat(codeFiles('scripts'), ['index.js']).filter(f => f !== path.join('src', 'config', 'env-schema.js'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** A complete, valid production configuration (test values). */
function prod(extra) {
  return Object.assign({
    NODE_ENV: 'production', SITE_URL: 'https://shop.example.test', ADMIN_EMAIL: 'owner@shop.example.test', ADMIN_PASSWORD: 'Long-Admin-Pass-123',
    ADMIN_JWT_SECRET: 'a'.repeat(30) + 'A'.repeat(30), CUSTOMER_JWT_SECRET: 'c'.repeat(30) + 'C'.repeat(30),
    DATA_DIR: '/home/u1/sakeofhealth-data', CATALOGUE_DIR: '/home/u1/sakeofhealth-catalogue', BACKUP_DIR: '/home/u1/sakeofhealth-backups',
    RAZORPAY_KEY_ID: 'rzp_live_Abc123', RAZORPAY_KEY_SECRET: 'live-secret-value',
  }, extra || {});
}
const names = (list) => list.map(x => x.name);

test('every environment variable the code reads is documented in the schema, and the schema lists nothing unused', () => {
  const used = new Set();
  for (const f of CODE) {
    const t = read(f);
    for (const m of t.matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
    for (const m of t.matchAll(/process\.env\[\s*'([A-Z][A-Z0-9_]+)'\s*\]/g)) used.add(m[1]);
  }
  const listed = new Set(VARS.map(v => v.name).concat(TOOL_VARS.map(v => v.name)));
  const families = VARS.filter(v => v.pattern === true).map(v => v.name.replace('<NAME>', ''));
  const missing = [...used].filter(n => !listed.has(n) && !families.some(f => n.startsWith(f)));
  assert.deepEqual(missing, [], 'read by the code but not in src/config/env-schema.js');
  const unused = VARS.filter(v => v.pattern !== true && !used.has(v.name)).map(v => v.name);
  assert.deepEqual(unused, [], 'in the schema but never read by the code');
  // the two name families are read dynamically
  assert.match(read('src/modules/b2b/notifications/service.js'), /process\.env\['WHATSAPP_TEMPLATE_' \+/);
  assert.match(read('src/modules/b2b/lib/sms-msg91.js'), /process\.env\['MSG91_TEMPLATE_' \+/);
});

test('templates and the reference are generated from the schema and up to date; they hold no secret values', () => {
  const r = spawnSync(process.execPath, ['scripts/env-templates.js', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['.env.example', '.env.development.example', '.env.production.example']) {
    const lines = read(f).split('\n').filter(l => /^#? ?[A-Z][A-Z0-9_]*=/.test(l));
    for (const v of VARS.filter(x => x.secret)) {
      const line = lines.find(l => l.replace(/^# /, '').startsWith(v.name + '='));
      if (!line) continue;
      const value = line.replace(/^# /, '').slice(v.name.length + 1);
      assert.ok(value === '' || value === '<generated>', f + ': ' + v.name + ' must be empty or <generated>, found a value');
    }
  }
  const ignore = read('.gitignore');
  assert.match(ignore, /^\.env$/m); assert.match(ignore, /^\.env\.\*$/m);
  assert.match(ignore, /^!\.env\.production\.example$/m);
  const ref = read('docs/unified/ENVIRONMENT.md');
  for (const v of VARS) assert.ok(ref.includes('`' + v.name + '`'), v.name + ' in the reference');
});

test('production: a complete configuration passes; an empty one lists every required variable', () => {
  assert.deepEqual(validate(prod()).errors, []);
  const r = validate({ NODE_ENV: 'production' });
  assert.deepEqual(names(r.errors).sort(), ['ADMIN_EMAIL', 'ADMIN_JWT_SECRET', 'ADMIN_PASSWORD', 'BACKUP_DIR', 'CATALOGUE_DIR', 'CUSTOMER_JWT_SECRET', 'DATA_DIR', 'RAZORPAY_KEY_ID', 'SITE_URL']);
  assert.ok(r.errors.every(e => /is not set \(required/.test(e.message)));
});

test('conditional requirements: business platform, ERP, SMTP, WhatsApp, S3 storage, Razorpay secret', () => {
  const b2b = names(validate(prod({ B2B_ENABLED: 'true' })).errors).sort();
  assert.deepEqual(b2b, ['B2B_JWT_SECRET', 'B2B_PRIVATE_DIR', 'DB_HOST', 'DB_NAME', 'DB_PASSWORD', 'DB_USER', 'PUBLIC_SITE_URL']);
  assert.ok(names(validate(prod({ B2B_ENABLED: 'true', ERP_ENABLED: 'true' })).errors).includes('ERP_JWT_SECRET'));
  assert.deepEqual(names(validate(prod({ SMTP_HOST: 'smtp.hostinger.com' })).errors).sort(), ['SMTP_FROM', 'SMTP_PASS', 'SMTP_USER']);
  assert.deepEqual(names(validate(prod({ WHATSAPP_TOKEN: 'EAAGm0PX4ZCpsBAKZB7' })).errors), ['WHATSAPP_PHONE_NUMBER_ID']);
  assert.deepEqual(names(validate(prod({ STORAGE_PROVIDER: 's3' })).errors).sort(), ['STORAGE_ACCESS_KEY', 'STORAGE_BUCKET', 'STORAGE_ENDPOINT', 'STORAGE_SECRET_KEY']);
  assert.deepEqual(names(validate(prod({ RAZORPAY_KEY_SECRET: '' })).errors), ['RAZORPAY_KEY_SECRET']);
});

test('types and unsafe values are refused in production — with messages that never contain a secret value', () => {
  const secretValue = 'my-short-secret-123';
  const r = validate(prod({ PORT: 'eighty', B2B_ENABLED: 'yes', ADMIN_JWT_SECRET: secretValue, PAYMENT_MOCK: 'true', RAZORPAY_API_BASE: 'http://localhost:9', SITE_URL: 'http://shop.example.test' }));
  const byName = Object.fromEntries(r.errors.map(e => [e.name, e.message]));
  assert.match(byName.PORT, /whole number/); assert.match(byName.B2B_ENABLED, /true or false/);
  assert.match(byName.ADMIN_JWT_SECRET, /at least 48/); assert.match(byName.PAYMENT_MOCK, /must be false/);
  assert.match(byName.RAZORPAY_API_BASE, /tests only/); assert.match(byName.SITE_URL, /https/);
  assert.ok(!JSON.stringify(r).includes(secretValue), 'no secret value in any message');
  const same = validate(prod({ CUSTOMER_JWT_SECRET: prod().ADMIN_JWT_SECRET }));
  assert.ok(same.errors.some(e => /must differ/.test(e.message)));
  assert.ok(validate({ NODE_ENV: 'development', RAZORPAY_KEY_ID: 'rzp_live_Abc' }).errors.some(e => e.name === 'RAZORPAY_KEY_ID'), 'no live keys outside production');
});

test('data folders: relative, inside the app, inside Hostinger hbuilds/public_html, or with a placeholder are refused in production', () => {
  const at = (p) => validate(prod({ DATA_DIR: p })).errors.filter(e => e.name === 'DATA_DIR').map(e => e.message)[0] || null;
  assert.match(at('data'), /absolute path/);
  assert.match(at(path.join(ROOT, 'data')), /inside the application folder/);
  assert.match(at('/home/u1/domains/sakeofhealth.com/hbuilds/data'), /hbuilds/);
  assert.match(at('/home/u1/domains/sakeofhealth.com/public_html/data'), /public_html/);
  assert.match(at('/home/<hostinger-user>/sakeofhealth-data'), /placeholder/);
  assert.equal(at('/home/u1/sakeofhealth-data'), null);
  assert.match(validate({ NODE_ENV: 'development', DATA_DIR: path.join(ROOT, 'data2') }).warnings.map(w => w.message).join(), /inside the application folder/, 'a warning in development');
});

test('the production template, filled in only with its placeholders, is refused (nothing deploys half-configured)', () => {
  const r = spawnSync(process.execPath, ['scripts/check-env.js', '--env-file=.env.production.example'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ADMIN_JWT_SECRET/); assert.match(r.stdout, /DATA_DIR still contains a placeholder/);
  const dir = tmp('envchk-'), f = path.join(dir, 'prod.env');
  fs.writeFileSync(f, Object.entries(prod()).map(([k, v]) => k + '=' + v).join('\n'));
  const ok = spawnSync(process.execPath, ['scripts/check-env.js', '--env-file=' + f], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout); assert.match(ok.stdout, /the server will start/);
  assert.ok(!ok.stdout.includes(prod().ADMIN_JWT_SECRET) && !ok.stdout.includes('live-secret-value'), 'values are never printed');
});

test('the server refuses to start in production when required variables are missing, and says which (no values printed)', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = Object.assign({}, process.env, { NODE_ENV: 'production', PORT: String(port), DATA_DIR: tmp('envsrv-'), ADMIN_JWT_SECRET: 'tiny-secret-zzz', CUSTOMER_JWT_SECRET: '', SITE_URL: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', RAZORPAY_KEY_ID: '', CATALOGUE_DIR: '', BACKUP_DIR: '' });
  const child = spawn(process.execPath, ['index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const code = await new Promise(resolve => { child.on('exit', resolve); setTimeout(() => { child.kill(); resolve('still running'); }, 15000); });
  assert.equal(code, 1, log);
  for (const n of ['SITE_URL', 'ADMIN_EMAIL', 'CUSTOMER_JWT_SECRET', 'RAZORPAY_KEY_ID', 'CATALOGUE_DIR']) assert.match(log, new RegExp('✗ ' + n + ' '));
  assert.match(log, /Not starting/);
  assert.ok(!log.includes('tiny-secret-zzz'), 'the secret value is not in the log');
});

test('secrets: generated with crypto, 64 characters (ENCRYPTION_KEY: 32 bytes hex), all different; nothing written to disk', () => {
  const g = require('../scripts/generate-secrets.js');
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    for (const n of g.GENERATED) {
      const s = g.secret(n);
      if (n === 'ENCRYPTION_KEY') assert.match(s, /^[0-9a-f]{64}$/); else assert.match(s, /^[A-Za-z0-9_-]{64}$/);
      assert.ok(!seen.has(s)); seen.add(s);
    }
  }
  const pw = g.password(); assert.ok(pw.length >= 12);
  const r = spawnSync(process.execPath, ['scripts/generate-secrets.js', 'ERP_JWT_SECRET', 'ENCRYPTION_KEY'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const lines = r.stdout.split('\n').filter(l => /^[A-Z_]+=/.test(l));
  assert.deepEqual(lines.map(l => l.split('=')[0]), ['ERP_JWT_SECRET', 'ENCRYPTION_KEY']);
  assert.ok(validate(prod({ ADMIN_JWT_SECRET: g.secret('ADMIN_JWT_SECRET'), CUSTOMER_JWT_SECRET: g.secret('CUSTOMER_JWT_SECRET') })).errors.length === 0, 'generated secrets pass production rules');
});

test('setup: creates .env from the development template with fresh secrets, then never overwrites it', () => {
  const dir = tmp('setup-');
  for (const f of ['.env.example', '.env.development.example', '.env.production.example']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const env = Object.assign({}, process.env, { NODE_ENV: 'development' });
  delete env.DATA_DIR;
  const first = spawnSync(process.execPath, ['scripts/setup-env.js', '--root=' + dir], { cwd: ROOT, env, encoding: 'utf8' });
  assert.match(first.stdout, /Created \.env from \.env\.development\.example/, first.stdout + first.stderr);
  const text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.ok(!/^[A-Z0-9_]+=<generated>$/m.test(text), 'every placeholder filled');
  const secrets = ['ADMIN_JWT_SECRET', 'CUSTOMER_JWT_SECRET', 'B2B_JWT_SECRET', 'ERP_JWT_SECRET', 'ENCRYPTION_KEY', 'CRON_SECRET'].map(n => (new RegExp('^' + n + '=(.+)$', 'm').exec(text) || [])[1]);
  assert.ok(secrets.every(s => s && s.length >= 32), 'secrets generated'); assert.equal(new Set(secrets).size, secrets.length, 'all different');
  // what the app reads back (dotenv) is exactly what was written and shown — nothing cut off by a '#'
  const parsed = require('dotenv').parse(text);
  for (const m of text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) assert.equal(parsed[m[1]], m[2].trim(), m[1] + ' reads back unchanged');
  const shown = /Local admin sign-in: \S+ \/ (\S+)/.exec(first.stdout);
  assert.ok(shown, first.stdout); assert.equal(parsed.ADMIN_PASSWORD, shown[1], 'the password shown is the one the app uses');
  fs.appendFileSync(path.join(dir, '.env'), '\n# my own line\n');
  const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  const second = spawnSync(process.execPath, ['scripts/setup-env.js', '--root=' + dir], { cwd: ROOT, env, encoding: 'utf8' });
  assert.match(second.stdout, /\.env exists — left exactly as it is/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
  const prodRun = spawnSync(process.execPath, ['scripts/setup-env.js', '--root=' + tmp('setup-prod-')], { cwd: ROOT, env: Object.assign({}, env, { NODE_ENV: 'production' }), encoding: 'utf8' });
  assert.equal(prodRun.status, 1); assert.match(prodRun.stdout, /hPanel/);
});

test('encryption key: data saved with ENCRYPTION_KEY survives a change of ERP_JWT_SECRET; older data stays readable', () => {
  const code = `
    process.env.ERP_JWT_SECRET = 'e'.repeat(40);
    const s = require('./src/modules/erp/core/security.js');
    const old = s.encrypt('1234567890');
    process.env.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');
    const current = s.encrypt('1234567890');
    const before = [s.decrypt(old), s.decrypt(current)];
    process.env.ERP_JWT_SECRET = 'f'.repeat(40);
    process.stdout.write(JSON.stringify({ old: old.slice(0, 3), current: current.slice(0, 3), before, after: s.decrypt(current) }));`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: Object.assign({}, process.env, { NODE_ENV: 'test' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(o, { old: 'v1:', current: 'v2:', before: ['1234567890', '1234567890'], after: '1234567890' });
});
