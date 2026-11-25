'use strict';
/** Backup codes for two-step sign-in: one-time, hashed, struck off on use, cleared with the authenticator. No database. */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ERP_JWT_SECRET = process.env.ERP_JWT_SECRET || 'test-secret-for-reset-links-0123456789abcdef';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const rc = require('../src/modules/erp/core/recovery-codes.js');
const audit = require('../src/modules/erp/core/audit.js');
const db = require('../src/db/connection.js');
const ROOT = path.join(__dirname, '..');

function memory(t, mfa) {
  const rows = {}, audits = [];
  const savedW = audit.write, savedT = db.transaction;
  audit.write = async (tx, a, e) => { audits.push(e); return 'h'; };
  const tx = {
    async queryOne(sql, args) {
      if (/FROM b2b_staff WHERE id/.test(sql)) return { mfa_enabled: mfa };
      if (/FROM b2b_settings WHERE setting_key/.test(sql)) return rows[args[0]] === undefined ? null : { setting_value: rows[args[0]] };
      return null;
    },
    async query(sql, args) {
      if (/INSERT INTO b2b_settings/.test(sql)) rows[args[0]] = args[1];
      else if (/UPDATE b2b_settings SET setting_value = \? WHERE setting_key = \?/.test(sql)) rows[args[1]] = args[0];
      else if (/DELETE FROM b2b_settings WHERE setting_key = \?/.test(sql)) delete rows[args[0]];
      return { affectedRows: 1 };
    },
  };
  db.transaction = (fn) => fn(tx);
  t.after(() => { audit.write = savedW; db.transaction = savedT; });
  return { rows, audits, tx };
}

test('backup codes: shape, alphabet without look-alikes, never mistaken for a 6-digit code', () => {
  for (let i = 0; i < 200; i++) assert.match(rc.makeCode(), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  assert.equal(rc.looksLikeCode('7KQ2-M9XA'), true);
  assert.equal(rc.looksLikeCode('7kq2m9xa'), true, 'without the dash, lower case');
  assert.equal(rc.looksLikeCode('123456'), false);
  assert.equal(rc.looksLikeCode(''), false);
  assert.equal(rc.normalise(' 7kq2 m9xa '), '7KQ2-M9XA');
});

test('making a set: needs an authenticator; 10 codes shown once; only keyed hashes stored; audited', async (t) => {
  const m = memory(t, 0);
  await assert.rejects(rc.generate(m.tx, { id: 7, label: 'a@b.c' }, 7), (e) => e.code === 'no_authenticator');
  const m2 = memory(t, 1);
  const { codes } = await rc.generate(m2.tx, { id: 7, label: 'a@b.c' }, 7);
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  const stored = m2.rows['security.recovery.7'];
  codes.forEach((c) => assert.ok(!stored.includes(c) && !stored.includes(c.replace('-', '')), 'no code stored in the clear'));
  assert.equal(JSON.parse(stored).hashes.length, 10);
  assert.equal(m2.audits[0].action, 'security.recovery_codes_created');
});

test('using a code: works once, any spelling; wrong codes and other people\'s codes fail; audited', async (t) => {
  const m = memory(t, 1);
  const { codes } = await rc.generate(m.tx, { id: 7 }, 7);
  const other = memory(t, 1);
  const theirs = (await rc.generate(other.tx, { id: 8 }, 8)).codes;
  // back to person 7's store
  db.transaction = (fn) => fn(m.tx);
  assert.equal(await rc.consume(7, codes[3].toLowerCase().replace('-', '')), true);
  assert.equal(await rc.consume(7, codes[3]), false, 'a code works once');
  assert.equal(await rc.consume(7, 'AAAA-AAAA'), false);
  assert.equal(await rc.consume(7, theirs[0]), false, 'codes are bound to the person');
  assert.equal(await rc.consume(7, '123456'), false, 'a 6-digit code is never a backup code');
  assert.equal(JSON.parse(m.rows['security.recovery.7']).hashes.length, 9);
  assert.ok(m.audits.concat(other.audits).some((e) => e.action === 'security.recovery_code_used' && e.new.left === 9));
  await rc.clear(m.tx, 7);
  assert.equal(m.rows['security.recovery.7'], undefined, 'cleared with the authenticator');
});

test('sign-in, password change, routes, admin reset and the screens use the backup codes', () => {
  const id = fs.readFileSync(path.join(ROOT, 'src/modules/erp/core/identity.js'), 'utf8');
  assert.match(id, /if \(recovery\.looksLikeCode\(totp\)\) okTotp = await recovery\.consume\(s\.id, totp\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/platform/passwords.js'), 'utf8'), /recovery\.looksLikeCode\(input\.totp\) \? await recovery\.consume\(s\.id, input\.totp\)/);
  const core = fs.readFileSync(path.join(ROOT, 'src/modules/erp/routes/core.js'), 'utf8');
  assert.match(core, /r\.post\('\/me\/recovery-codes', can\('core\.self\.view', \{ mfa: true \}\)/);
  assert.match(core, /res\.setHeader\('Cache-Control', 'no-store'\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/modules/erp/core/staff.js'), 'utf8'), /require\('\.\/recovery-codes\.js'\)\.clear\(tx, staffId\)/);
  const login = fs.readFileSync(path.join(ROOT, 'platform-web/login.html'), 'utf8');
  assert.match(login, /id="totp" name="totp" autocomplete="one-time-code" maxlength="9" placeholder="6-digit code, or a backup code"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'erp-web/admin/app.js'), 'utf8'), /'\/me\/recovery-codes'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/modules/b2b/routes/admin.js'), 'utf8'), /NOT_TRADE = \/\^\(security\|branding\|ai\)\\\./, 'never listed on the trade settings page');
});
