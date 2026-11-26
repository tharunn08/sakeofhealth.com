/**
 * One sign-in page for everyone (/login): shop customers, retailers, distributors, manufacturers and suppliers,
 * the office team, salesmen, delivery and event staff. The other apps no longer have sign-in forms of their own;
 * they send people to /login?to=<their workspace>, which opens that workspace when the person has it.
 * Salesmen, delivery and event staff with no other role go straight to the field app.
 * DB-free: the sign-in decision runs on stand-in account stores; the pages are checked as the server sends them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { signIn } = require('../src/platform/auth.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NO = () => ({ ok: false });
const input = { email: 's@x.y', password: 'pw-1234567890' };
const erp = (extra) => async () => Object.assign({ token: 'e', staff: { id: 3, name: 'S', email: 's@x.y' } }, extra);

test('salesmen, delivery and event staff with only field roles go straight to the field app', async () => {
  let r = await signIn(input, { staff: NO, customer: NO, erp: erp({ isSalesman: true, fieldOnly: true }) });
  assert.deepEqual(r.body.workspaces.map((w) => [w.type, w.home]), [['sales', '/sales-app/']]);
  r = await signIn(input, { staff: NO, customer: NO, erp: erp({ isFieldStaff: true, fieldOnly: true }) });
  assert.deepEqual(r.body.workspaces.map((w) => [w.type, w.label]), [['sales', 'Delivery & event app']]);
  // also an office role (e.g. accountant): both, to choose
  r = await signIn(input, { staff: NO, customer: NO, erp: erp({ isSalesman: true, fieldOnly: false }) });
  assert.deepEqual(r.body.workspaces.map((w) => w.type), ['admin', 'sales']);
  // a field role but no field work set up (no salesman profile): the panel, so the person is not left with nothing
  r = await signIn(input, { staff: NO, customer: NO, erp: erp({ fieldOnly: true }) });
  assert.deepEqual(r.body.workspaces.map((w) => w.type), ['admin']);
  // a temporary password still has to be changed first
  r = await signIn(input, { staff: NO, customer: NO, erp: erp({ isSalesman: true, fieldOnly: true, mustChangePassword: true }) });
  assert.equal(r.body.mustChangePassword, true);
  const routes = read('src/platform/routes.js');
  assert.match(routes, /const FIELD_ROLES = \['salesman', 'delivery_staff', 'event_staff'\];/);
  assert.match(routes, /r\.fieldOnly = roles\.length > 0 && roles\.every\(function \(x\) \{ return FIELD_ROLES\.indexOf\(x\.code\) !== -1; \}\);/);
});

test('the sign-in page: everyone in one form, email or a business mobile number, and Business register below', () => {
  const html = read('platform-web/login.html');
  assert.match(html, /One sign-in for everyone: shop customers, retailers, distributors, manufacturers and suppliers, our team, salesmen and delivery staff\./);
  assert.match(html, /<input class="input" type="text" inputmode="email" id="email"/, 'a mobile number is accepted (retailers and distributors)');
  assert.match(html, /Business register/);
  for (const href of ['/b2b/register?type=retailer', '/b2b/register?type=distributor', '/vendor-portal/?register', '/account.html#signup']) assert.ok(html.includes('href="' + href + '"'), href);
});

test('?to= opens the app that sent the person; ?back= returns a customer to a page of this site only', () => {
  const js = read('platform-web/login.js');
  assert.match(js, /var wanted = \/\^\(customer\|business\|supplier\|sales\|admin\)\$\/\.test\(q\.get\('to'\) \|\| ''\) \? q\.get\('to'\) : null;/);
  assert.match(js, /var hit = wanted \? ws\.filter\(function \(w\) \{ return w\.type === wanted; \}\)\[0\] : null;/);
  assert.match(js, /location\.href = w\.type === 'customer' && back \? back : w\.home;/);
  assert.match(js, /\(!wanted \|\| wanted === 'admin'\)/, 'an admin session does not hijack a field-app or customer sign-in');
  const rx = js.match(/var back = (\/\^.*\/)\.test\(/)[1];
  const ok = vm.runInNewContext(rx);
  for (const good of ['/account.html', '/account.html#orders', '/checkout/?step=2']) assert.ok(ok.test(good), good);
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', '/a b']) assert.ok(!ok.test(bad), bad);
});

test('the field app, business portal, supplier portal and the shop\'s My Account send people to the one page', () => {
  const sales = read('erp-web/sales/app.js');
  assert.match(sales, /location\.replace\('\/login\?to=sales'/);
  assert.doesNotMatch(sales, /'\/api\/erp\/core\/login'/);

  const b2b = read('src/modules/b2b/index.js');
  assert.match(b2b, /app\.get\(\['\/b2b', '\/b2b\/', '\/b2b\/login', '\/b2b\/login\.html'\], function \(req, res\) \{\n\s+res\.redirect\(302, '\/login\?to=business'/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'b2b-web/portal/login.html')), 'no second business sign-in page');
  assert.match(read('b2b-web/portal/app.js'), /location\.replace\('\/login\?to=business' \+ \(expired \? '&expired=1' : ''\)\)/);
  assert.ok(read('b2b-web/portal/register.html').includes('href="/login?to=business"'));

  const vendor = read('erp-web/vendor/app.js');
  assert.match(vendor, /function toSignIn\(expired\) \{ location\.replace\('\/login\?to=supplier'/);
  assert.doesNotMatch(vendor, /api\('POST', '\/auth\/login'/, 'no password is typed into the supplier portal except to accept an invitation');
  assert.match(vendor, /api\('POST', '\/invite\/accept'/, 'an invited supplier still sets the first password there');

  const acc = read('frontend/account.html');
  assert.match(acc, /if \(location\.hash === '#signup'\) \{ showTab\('signup'\); return; \}\n\s+location\.replace\('\/login\?to=customer&back=\/account\.html'\);/);
  assert.ok(acc.includes('onclick="location.href=\'/login?to=customer&amp;back=/account.html\'">Log In</button>'));
  // the shop's protected copy was re-pinned on purpose, with the owner's reason
  const m = JSON.parse(read('scripts/b2c-manifest.json'));
  assert.equal(m.files['frontend/account.html'], crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'frontend/account.html'))).digest('hex'));
  const pin = m.repins[m.repins.length - 1];
  assert.match(pin.by, /one sign-in page/); assert.equal(pin.changes[0].file, 'frontend/account.html');
});
