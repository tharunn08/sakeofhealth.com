/**
 * AI assistant for managers: answers questions from the business's own data. Built, switched OFF.
 *
 * It runs only when ALL of these hold:
 *   1. AI_PROVIDER=anthropic and AI_API_KEY are set in the server environment (Hostinger), and
 *   2. a Super Admin switched it on in the admin panel (b2b_settings: ai.assistant_enabled = true).
 * Until then every call answers "switched off" and nothing leaves the server. There is no cost.
 *
 * How an answer is made:
 *   - The model only gets READ-ONLY tools. Each tool is an existing Smart Insights report and needs
 *     the same permission that report needs; the person must see the whole business, as for Smart
 *     Insights. The assistant can never see more than the person asking.
 *   - Tool results are trimmed, and phone numbers and e-mail addresses are removed before they are
 *     sent to the provider.
 *   - The model must keep facts (with the figures) apart from possible causes to check.
 *   - It can suggest actions only as drafts naming the screen where a person does them; nothing is
 *     changed by the assistant, and approvals still apply.
 *   - Every question, the tools used and the size of the answer go into the audit log; daily limits
 *     per person and for the whole business keep the cost bounded.
 */
'use strict';
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');

const SWITCH_KEY = 'ai.assistant_enabled';
const MAX_ROUNDS = 4;
const MAX_TOOL_CHARS = 12000;
const MAX_QUESTION = 1000;

function fail(status, msg, code) { return Object.assign(new Error(msg), { status: status, expose: true, code: code }); }
function intIn(v, dflt, lo, hi) { const n = Number(v); return String(v || '').trim() !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt; }

function config() {
  const provider = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  return {
    provider: provider === 'anthropic' ? 'anthropic' : null,
    hasKey: !!String(process.env.AI_API_KEY || '').trim(),
    model: String(process.env.AI_MODEL || 'claude-haiku-5-5').trim(),
    perPerson: intIn(process.env.AI_DAILY_LIMIT_PER_USER, 30, 1, 500),
    perBusiness: intIn(process.env.AI_DAILY_LIMIT_TOTAL, 300, 1, 5000),
  };
}

/** The read-only tools: name → { permission, description, run(principal) }. */
function insights() { return require('../insights/service.js'); }
const TOOLS = {
  business_summary: { permission: 'reports.export', description: 'Headline figures for the last 14 days: sales, orders, stock warnings, alerts.', run: function (p) { return insights().summary(p.permissions); } },
  sales_forecast: { permission: 'sales.reports.view', description: 'Per product: units sold in recent weeks and the forecast for the next 30 days.', run: function () { return insights().forecast(); } },
  stock_outlook: { permission: 'inventory.view', description: 'Per product: stock on hand, days of cover, out-of-stock and reorder advice with quantities.', run: function () { return insights().stock(); } },
  customer_segments: { permission: 'customers.view', description: 'Trade customers grouped by how recently, how often and how much they buy; customers at risk.', run: function () { return insights().customers(); } },
  sales_alerts: { permission: 'sales.reports.view', description: 'Unusual days and unusual orders in the last 90 days.', run: function () { return insights().alerts(); } },
  product_suggestions: { permission: 'sales.reports.view', description: 'Products often bought together, and which customers could be offered which product.', run: function () { return insights().recommendations(); } },
};
const SCREENS = ['purchasing', 'stock', 'pricing', 'salesdesk', 'customers', 'notifications', 'deliveries', 'finance', 'collections', 'returns'];

/** Pure: which tools this person may use. */
function toolsFor(principal) {
  return Object.keys(TOOLS).filter(function (k) { return principal.permissions.has(TOOLS[k].permission); });
}

/** Pure: removes phone numbers and e-mail addresses, then trims to the limit. */
function scrub(value) {
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-mail removed]')
    .replace(/(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g, '[phone removed]');
  return s.length > MAX_TOOL_CHARS ? s.slice(0, MAX_TOOL_CHARS) + '…[trimmed]' : s;
}

async function switchedOn() {
  const r = await db.queryOne('SELECT setting_value FROM b2b_settings WHERE setting_key = ?', [SWITCH_KEY]);
  return !!r && r.setting_value === 'true';
}

/** → { available, reason, provider, model, limits, usedToday? } — never the key. */
async function status(principal) {
  const c = config();
  const out = { available: false, provider: c.provider, model: c.provider ? c.model : null, limits: { perPerson: c.perPerson, perBusiness: c.perBusiness },
    tools: principal ? toolsFor(principal) : [], switchedOn: false };
  if (!c.provider || !c.hasKey) { out.reason = 'not_configured'; return out; }
  out.switchedOn = await switchedOn();
  if (!out.switchedOn) { out.reason = 'switched_off'; return out; }
  if (principal && !out.tools.length) { out.reason = 'no_data_permissions'; return out; }
  out.available = true;
  if (principal) out.usedToday = await usedToday(principal.id);
  return out;
}

async function usedToday(staffId) {
  const r = await db.queryOne("SELECT COUNT(*) AS n FROM b2b_audit_logs WHERE action = 'assistant.asked' AND actor_id = ? AND created_at >= UTC_DATE()", [String(staffId)]);
  return Number(r && r.n) || 0;
}
async function usedTodayAll() {
  const r = await db.queryOne("SELECT COUNT(*) AS n FROM b2b_audit_logs WHERE action = 'assistant.asked' AND created_at >= UTC_DATE()");
  return Number(r && r.n) || 0;
}

/** On / off (core.settings.edit). Turning it on needs the provider and key in the environment. */
async function setSwitch(tx, actor, on, reason) {
  if (typeof on !== 'boolean') throw fail(400, 'Choose on or off');
  const c = config();
  if (on && (!c.provider || !c.hasKey)) throw fail(409, 'Add AI_PROVIDER and AI_API_KEY in Hostinger first, then switch it on.', 'not_configured');
  await tx.query('INSERT INTO b2b_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
    [SWITCH_KEY, JSON.stringify(on), String(actor.label || '').slice(0, 190)]);
  await audit.write(tx, actor, { module: 'core', action: on ? 'assistant.switched_on' : 'assistant.switched_off', entity: 'setting', entityId: null, reason: reason || null });
  return { switchedOn: on };
}

function systemPrompt(principal, tools) {
  return [
    'You are the management assistant of Sake of Health, an Indian health-products company. You answer questions from',
    principal.name + ' using ONLY the tools given. Never invent figures. Amounts are Indian rupees.',
    'Answer in plain, short sentences. Structure every answer as:',
    'FACTS: what the data shows, with the figures and which tool they came from.',
    'POSSIBLE CAUSES: hypotheses, clearly marked as not proven, and what to check to confirm each.',
    'SUGGESTED ACTIONS: optional; each as a draft naming one screen from this list where a person would do it: ' + SCREENS.join(', ') + '.',
    'If the tools do not hold the answer, say so plainly. You cannot change anything.',
    'Tools available to this person: ' + tools.join(', ') + '.',
  ].join(' ');
}

/** The provider call (Anthropic Messages API). deps.fetch is replaced in tests. */
async function callModel(c, body, deps) {
  const f = (deps && deps.fetch) || fetch;
  const r = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': String(process.env.AI_API_KEY || '').trim(), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(Object.assign({ model: c.model, max_tokens: 1200 }, body)),
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) throw fail(502, 'The AI provider did not answer (' + r.status + '). Nothing was changed.', 'provider_error');
  return j;
}

/**
 * Asks one question. → { answer, toolsUsed, rounds }. Refused unless status().available.
 * deps (tests): { fetch, runTool(name, principal) }
 */
async function ask(principal, actor, question, deps) {
  const q = String(question || '').trim();
  if (q.length < 3) throw fail(400, 'Type a question');
  if (q.length > MAX_QUESTION) throw fail(400, 'Keep the question under ' + MAX_QUESTION + ' characters');
  const st = await status(principal);
  if (!st.available) throw fail(409, st.reason === 'no_data_permissions' ? 'Your role cannot open any of the reports the assistant uses.' : 'The AI assistant is switched off.', st.reason);
  require('../insights/service.js').assertWholeBusiness(principal);
  const c = config();
  if (st.usedToday >= c.perPerson) throw fail(429, 'You have used today\'s ' + c.perPerson + ' questions. Try again tomorrow.', 'limit_person');
  if (await usedTodayAll() >= c.perBusiness) throw fail(429, 'The business has used today\'s ' + c.perBusiness + ' questions. Try again tomorrow.', 'limit_business');

  const allowed = st.tools;
  const tools = allowed.map(function (k) { return { name: k, description: TOOLS[k].description, input_schema: { type: 'object', properties: {}, additionalProperties: false } }; });
  const messages = [{ role: 'user', content: q }];
  const used = [];
  let answer = '', rounds = 0, usage = { input: 0, output: 0 };
  while (rounds < MAX_ROUNDS) {
    rounds += 1;
    const res = await callModel(c, { system: systemPrompt(principal, allowed), tools: tools, messages: messages }, deps);
    if (res.usage) { usage.input += Number(res.usage.input_tokens) || 0; usage.output += Number(res.usage.output_tokens) || 0; }
    const blocks = Array.isArray(res.content) ? res.content : [];
    answer = blocks.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
    const calls = blocks.filter(function (b) { return b.type === 'tool_use'; });
    if (res.stop_reason !== 'tool_use' || !calls.length) break;
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const call of calls) {
      let content;
      if (allowed.indexOf(call.name) === -1) content = 'Not allowed for this person.';
      else {
        try { content = scrub(await (deps && deps.runTool ? deps.runTool(call.name, principal) : TOOLS[call.name].run(principal))); used.push(call.name); }
        catch (e) { content = 'The report could not be read.'; }
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: content });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!answer) answer = 'No answer was produced. Try asking in a different way.';
  await audit.write(null, actor, { module: 'core', action: 'assistant.asked', entity: 'assistant', entityId: null,
    new: { question: q.slice(0, 300), tools: Array.from(new Set(used)), rounds: rounds, tokens: usage, answerChars: answer.length } });
  return { answer: answer, toolsUsed: Array.from(new Set(used)), rounds: rounds };
}

module.exports = { status, ask, setSwitch, toolsFor, scrub, config, TOOLS, SWITCH_KEY };
