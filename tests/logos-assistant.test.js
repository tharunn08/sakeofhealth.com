'use strict';
/**
 * Logo library (choose the logo printed on bills) and the AI assistant (built, switched off).
 * No database and no network: stand-ins replace both.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

const branding = require('../src/platform/branding.js');
const storage = require('../src/platform/storage.js');
const audit = require('../src/modules/erp/core/audit.js');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(40, 1)]);
const JPG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(40, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function settingsTx(settings, after) {
  return {
    async queryOne(sql, args) { if (/FROM b2b_settings/.test(sql)) { const v = settings[args[0]]; return v === undefined ? null : { setting_value: v }; } return null; },
    async query(sql, args) { if (/INSERT INTO b2b_settings/.test(sql)) settings[args[0]] = args[1]; return { affectedRows: 1 }; },
    afterCommit(fn) { after.push(fn); },
  };
}
function stubs(t) {
  const saved = { put: storage.put, remove: storage.remove, write: audit.write };
  const files = {}, audits = [];
  storage.put = async (kind, name, buf) => { files[kind + '/' + name] = buf; return {}; };
  storage.remove = async (kind, name) => { delete files[kind + '/' + name]; };
  audit.write = async (tx, a, e) => { audits.push(e); return 'h'; };
  t.after(() => { storage.put = saved.put; storage.remove = saved.remove; audit.write = saved.write; branding.reset(); });
  return { files, audits };
}

test('logo library: PNG/JPG/WEBP only (never SVG), 1 MB, a name; stored outside the site folder; audited', async (t) => {
  const s = stubs(t); const settings = {}, after = [];
  const tx = settingsTx(settings, after);
  const actor = { id: 1, label: 'owner@x.y' };
  await assert.rejects(branding.upload(tx, actor, { buffer: SVG }, 'Vector'), /PNG, JPG or WEBP/);
  await assert.rejects(branding.upload(tx, actor, { buffer: PNG }, ''), /Give the logo a name/);
  await assert.rejects(branding.upload(tx, actor, { buffer: Buffer.concat([PNG, Buffer.alloc(branding.MAX_BYTES)]) }, 'Big'), /1 MB/);
  await assert.rejects(branding.upload(tx, actor, null, 'x'), /Choose a picture/);
  const a = await branding.upload(tx, actor, { buffer: PNG }, 'Ayurveda range');
  const b = await branding.upload(tx, actor, { buffer: JPG }, 'Distributor bills');
  assert.match(a.id, /^[a-f0-9]{32}\.png$/); assert.match(b.id, /^[a-f0-9]{32}\.jpg$/);
  assert.equal(a.url, '/branding/logo/' + a.id);
  assert.ok(s.files['branding/' + a.id], 'saved through the persistent storage');
  assert.equal(JSON.parse(settings['branding.logos']).length, 2);
  assert.deepEqual(s.audits.map((e) => e.action), ['branding.logo_added', 'branding.logo_added']);
  const st = await branding.state(tx);
  assert.equal(st.billLogo, 'shop', 'nothing chosen yet → the shop logo prints');
  assert.equal(st.bill.url, '/assets/images/logo-mark.svg');
});

test('logo library: choose the bill logo, remove it → back to the shop logo; unknown ids refused', async (t) => {
  const s = stubs(t); const settings = {}, after = [];
  const tx = settingsTx(settings, after);
  const actor = { id: 1, label: 'owner@x.y' };
  const a = await branding.upload(tx, actor, { buffer: PNG }, 'Main');
  await assert.rejects(branding.chooseBillLogo(tx, actor, 'ffffffffffffffffffffffffffffffff.png'), /not in the library/);
  assert.deepEqual(await branding.chooseBillLogo(tx, actor, a.id, 'new look'), { billLogo: a.id });
  let st = await branding.state(tx);
  assert.deepEqual([st.billLogo, st.bill.label, st.bill.url], [a.id, 'Main', '/branding/logo/' + a.id]);
  assert.equal(s.audits.find((e) => e.action === 'branding.bill_logo_chosen').new.id, a.id);
  await branding.remove(tx, actor, a.id);
  assert.ok(s.files['branding/' + a.id], 'the file stays until the change is committed');
  after.forEach((fn) => fn());
  await new Promise((r) => setImmediate(r));
  assert.equal(s.files['branding/' + a.id], undefined, 'removed after commit');
  st = await branding.state(tx);
  assert.deepEqual([st.billLogo, st.logos.length], ['shop', 0]);
  assert.deepEqual(await branding.chooseBillLogo(tx, actor, 'shop'), { billLogo: 'shop' });
});

test('bill logo: shop logo when there is no database or the settings cannot be read', async (t) => {
  const db = require('../src/db/connection.js');
  const saved = { isConfigured: db.isConfigured, queryOne: db.queryOne };
  t.after(() => { db.isConfigured = saved.isConfigured; db.queryOne = saved.queryOne; branding.reset(); });
  db.isConfigured = () => false; branding.reset();
  assert.equal((await branding.billLogo()).id, 'shop');
  db.isConfigured = () => true; db.queryOne = async () => { throw new Error('down'); }; branding.reset();
  assert.equal((await branding.billLogo()).id, 'shop');
});

test('printed bills: the logo goes into each bill header as the print page builds it', async () => {
  const added = [];
  const head = { querySelector: () => null, insertBefore: (img) => added.push(img), firstChild: null };
  let observer;
  const ctx = {
    document: { createElement: (tag) => ({ tag, style: {} }), head: { appendChild() {} }, documentElement: {}, querySelectorAll: () => [head] },
    fetch: async () => ({ ok: true, json: async () => ({ id: 'x.png', label: 'Main', url: '/branding/logo/x.png' }) }),
    MutationObserver: function (fn) { observer = fn; this.observe = () => {}; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'platform-web/bill-logo.js'), 'utf8'), ctx);
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(added.length, 1); assert.equal(added[0].src, '/branding/logo/x.png'); assert.equal(added[0].className, 'bill-logo');
  assert.equal(typeof observer, 'function', 'watches for bills drawn later');
  for (const f of ['frontend/admin/print.html', 'b2b-web/portal/print.html']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /<script src="\/admin\/print\.js\?v=1"><\/script>\n<script src="\/platform\/bill-logo\.js"><\/script>/, f);
  }
  const m = require('../scripts/b2c-manifest.json');
  const change = m.repins.flatMap((r) => r.changes || []).find((c) => c.file === 'frontend/admin/print.html');
  assert.ok(change, 'the print page change is recorded'); assert.match(change.reason, /Display only/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'frontend/admin/print.js'), 'utf8'), /bill-logo/, 'the bill code itself is unchanged');
});

test('counter-sale invoice shows the chosen logo; its page allows pictures from this site only', () => {
  const inv = require('../src/modules/erp/events/invoice.js');
  const sale = { invoiceNo: 'EV/2627/00010', soldAt: '2026-11-25T10:00:00Z', event: { code: 'BLR', name: 'Expo' }, interstate: false,
    customer: { name: 'A', mobile: '9845011111' }, totals: { taxable: 100, cgst: 9, sgst: 9, igst: 0, discount: 0, roundOff: 0, grand: 118, paid: 118 },
    items: [{ name: 'Jaggery', sku: 'J1', hsn: '1701', batchNo: 'A1', expiry: '2027-01-31', qty: 1, unitPrice: 118, discount: 0, taxable: 100, gstRate: 18, cgst: 9, sgst: 9, igst: 0, total: 118 }], payments: [], returns: [] };
  const html = inv.render(sale, { name: 'Sake of Health' }, { url: '/branding/logo/x.png', label: 'Main "logo"' });
  assert.match(html, /<img class="logo" src="\/branding\/logo\/x\.png" alt="Main &quot;logo&quot;">/);
  assert.doesNotMatch(inv.render(sale, { name: 'Sake of Health' }), /<img class="logo"/, 'no logo given: none shown');
  for (const f of ['src/modules/erp/routes/public-invoice.js', 'src/modules/erp/routes/events.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /default-src 'none'; img-src 'self';/, f);
    assert.match(src, /branding\.js'\)\.billLogo\(\)/, f);
  }
});

test('logo routes: public picture and choice; changes need core.settings.edit; uploads limited', () => {
  const core = fs.readFileSync(path.join(ROOT, 'src/modules/erp/routes/core.js'), 'utf8');
  assert.match(core, /r\.post\('\/branding\/logos', can\('core\.settings\.edit'\), receiveLogo/);
  assert.match(core, /r\.put\('\/branding\/bill-logo', can\('core\.settings\.edit'\)/);
  assert.match(core, /r\.post\('\/branding\/logos\/:name\/remove', can\('core\.settings\.edit'\)/);
  assert.match(core, /limits: \{ fileSize: branding\.MAX_BYTES, files: 1/);
  const b = fs.readFileSync(path.join(ROOT, 'src/platform/branding.js'), 'utf8');
  assert.match(b, /app\.get\('\/branding\/logo\/:name'/);
  assert.match(b, /if \(!NAME_RX\.test\(name\)\) return res\.status\(404\)/, 'only library names, never a path');
  assert.equal(branding.sniff(SVG), null);
  const login = fs.readFileSync(path.join(ROOT, 'platform-web/login.html'), 'utf8');
  assert.match(login, /<img src="\/assets\/images\/logo-mark\.svg" alt="Sake of Health"/);
  assert.doesNotMatch(login, /<div class="login-logo">S<\/div>/);
});

/* ── AI assistant ── */
const svc = require('../src/modules/erp/assistant/service.js');
const P = (perms) => ({ id: 5, name: 'Owner', permissions: new Set(perms), scopes: { territory: 'all', warehouse: 'all', state: 'all' } });

function aiEnv(t, vars) {
  const keys = ['AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'AI_DAILY_LIMIT_PER_USER', 'AI_DAILY_LIMIT_TOTAL'];
  const saved = {}; keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, vars || {});
  t.after(() => keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));
}
function aiDb(t, o) {
  const db = require('../src/db/connection.js');
  const saved = { queryOne: db.queryOne, write: audit.write };
  const audits = [];
  db.queryOne = async (sql) => {
    if (/FROM b2b_settings/.test(sql)) return o.on ? { setting_value: 'true' } : null;
    if (/actor_id = \?/.test(sql)) return { n: o.mine || 0 };
    if (/COUNT\(\*\) AS n FROM b2b_audit_logs/.test(sql)) return { n: o.all || 0 };
    return null;
  };
  audit.write = async (tx, a, e) => { audits.push(e); return 'h'; };
  t.after(() => { db.queryOne = saved.queryOne; audit.write = saved.write; });
  return audits;
}

test('AI assistant: off without provider and key; off until switched on; nothing is sent while off', async (t) => {
  aiEnv(t, {});
  aiDb(t, { on: true });
  let st = await svc.status(P(['reports.export', 'sales.reports.view']));
  assert.deepEqual([st.available, st.reason], [false, 'not_configured']);
  let called = 0;
  await assert.rejects(svc.ask(P(['reports.export', 'sales.reports.view']), { id: 5 }, 'How are sales?', { fetch: async () => { called++; } }), (e) => e.code === 'not_configured');
  assert.equal(called, 0);
  process.env.AI_PROVIDER = 'anthropic'; process.env.AI_API_KEY = 'test-key-not-real';
  t.after(() => {});
  const db = require('../src/db/connection.js');
  const q = db.queryOne; db.queryOne = async (sql) => (/FROM b2b_settings/.test(sql) ? null : q(sql));
  st = await svc.status(P(['reports.export']));
  assert.deepEqual([st.available, st.reason, st.switchedOn], [false, 'switched_off', false]);
  assert.equal(JSON.stringify(st).includes('test-key-not-real'), false, 'the key is never returned');
});

test('AI assistant: tools follow the person\'s permissions; phone numbers and e-mails are removed', () => {
  assert.deepEqual(svc.toolsFor(P(['reports.export'])), ['business_summary']);
  assert.deepEqual(svc.toolsFor(P(['reports.export', 'inventory.view', 'customers.view'])).sort(), ['business_summary', 'customer_segments', 'stock_outlook']);
  assert.deepEqual(svc.toolsFor(P([])), []);
  const out = svc.scrub({ name: 'Ravi Stores', phone: '9876543210', alt: '+91 9123456789', mail: 'ravi@shop.in', sales: 12500 });
  assert.doesNotMatch(out, /9876543210|9123456789|ravi@shop\.in/);
  assert.match(out, /Ravi Stores/); assert.match(out, /12500/);
  assert.ok(svc.scrub('x'.repeat(20000)).length < 12100, 'trimmed');
});

test('AI assistant (fake provider): read-only tool loop, only allowed tools, audited, daily limits', async (t) => {
  aiEnv(t, { AI_PROVIDER: 'anthropic', AI_API_KEY: 'test-key-not-real', AI_DAILY_LIMIT_PER_USER: '2' });
  const audits = aiDb(t, { on: true, mine: 0, all: 0 });
  const sent = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'stock_outlook', input: {} }, { type: 'tool_use', id: 't2', name: 'customer_segments', input: {} }], usage: { input_tokens: 900, output_tokens: 40 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'FACTS: 2 products out of stock.\nPOSSIBLE CAUSES: …\nSUGGESTED ACTIONS: purchasing.' }], usage: { input_tokens: 1500, output_tokens: 120 } },
  ];
  const deps = {
    fetch: async (url, o) => { sent.push({ url, o, body: JSON.parse(o.body) }); return { ok: true, json: async () => replies[sent.length - 1] }; },
    runTool: async (name) => ({ tool: name, contact: 'call 9876543210' }),
  };
  const me = P(['reports.export', 'inventory.view']);
  const r = await svc.ask(me, { id: 5, label: 'owner' }, 'What will run out?', deps);
  assert.match(r.answer, /^FACTS/); assert.deepEqual(r.toolsUsed, ['stock_outlook']); assert.equal(r.rounds, 2);
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0].o.headers['x-api-key'], 'test-key-not-real');
  assert.deepEqual(sent[0].body.tools.map((x) => x.name).sort(), ['business_summary', 'stock_outlook'], 'only tools this role may use are offered');
  const results = sent[1].body.messages[2].content;
  assert.equal(results.find((x) => x.tool_use_id === 't2').content, 'Not allowed for this person.', 'a tool outside the role is refused');
  assert.doesNotMatch(results.find((x) => x.tool_use_id === 't1').content, /9876543210/);
  assert.match(sent[0].body.system, /FACTS[\s\S]*POSSIBLE CAUSES[\s\S]*SUGGESTED ACTIONS/);
  const a = audits.find((e) => e.action === 'assistant.asked');
  assert.deepEqual([a.new.question, a.new.tools, a.new.tokens], ['What will run out?', ['stock_outlook'], { input: 2400, output: 160 }]);
  // limits
  aiDb(t, { on: true, mine: 2 });
  await assert.rejects(svc.ask(me, { id: 5 }, 'Again?', deps), (e) => e.code === 'limit_person');
  aiDb(t, { on: true, mine: 0, all: 300 });
  await assert.rejects(svc.ask(me, { id: 5 }, 'Again?', deps), (e) => e.code === 'limit_business');
  // territory-limited staff: refused, as for Smart Insights
  aiDb(t, { on: true });
  await assert.rejects(svc.ask(Object.assign(P(['reports.export']), { scopes: { territory: [3] } }), { id: 5 }, 'Sales?', deps));
});

test('AI assistant: switching on needs the key; routes and screens are wired', async (t) => {
  aiEnv(t, {});
  const tx = { async query() { return { affectedRows: 1 }; } };
  await assert.rejects(svc.setSwitch(tx, { id: 1 }, true), (e) => e.code === 'not_configured');
  const r = fs.readFileSync(path.join(ROOT, 'src/modules/erp/routes/assistant.js'), 'utf8');
  assert.match(r, /r\.post\('\/ask', can\('reports\.export'\), askLimit/);
  assert.match(r, /r\.put\('\/switch', can\('core\.settings\.edit'\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/modules/erp/index.js'), 'utf8'), /api\.use\('\/assistant', require\('\.\/routes\/assistant\.js'\)\)/);
  const reg = require('../src/platform/registry.js');
  for (const v of ['assistant', 'branding']) assert.ok(reg.PAGES.find((p) => p.view === v), v);
  const schema = require('../src/config/env-schema.js');
  assert.equal(schema.VARS.find((v) => v.name === 'AI_API_KEY').secret, true);
});
