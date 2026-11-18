/**
 * Message templates (N3, needed by N2 for WhatsApp and SMS). Business-initiated WhatsApp messages
 * must use a template Meta approved; Indian SMS must use a DLT-registered template. An admin records
 * each template and confirms it is approved at the provider; only active, approved templates can be
 * chosen when sending.
 *   provider_template: WhatsApp → Meta template name; SMS → DLT template id (or blank to use MSG91_TEMPLATE_<NAME>)
 */
'use strict';
const db = require('../../../db/connection.js');
const audit = require('../core/audit.js');
const { fail, posId } = require('../lib/http.js');

function need(c, m, code) { if (!c) throw fail(400, m, code); }
const CATS = ['transactional', 'service', 'promotional', 'authentication'];

function clean(b, old) {
  const t = {
    channel: old ? old.channel : String(b.channel || ''),
    name: old ? old.name : String(b.name || '').trim().toLowerCase(),
    category: b.category != null ? String(b.category) : (old ? old.category : 'transactional'),
    provider_template: b.providerTemplate != null ? String(b.providerTemplate).trim().slice(0, 120) || null : (old ? old.provider_template : null),
    language: b.language != null ? String(b.language).trim().slice(0, 12) || null : (old ? old.language : null),
    param_names: b.paramNames != null ? (Array.isArray(b.paramNames) ? b.paramNames : String(b.paramNames).split(',')).map(function (s) { return String(s).trim(); }).filter(Boolean).join(',').slice(0, 400) || null : (old ? old.param_names : null),
    sample_text: b.sampleText != null ? String(b.sampleText).slice(0, 2000) : (old ? old.sample_text : null),
    approved_at_provider: b.approvedAtProvider != null ? (b.approvedAtProvider === true ? 1 : 0) : (old ? Number(old.approved_at_provider) : 0),
    active: b.active != null ? (b.active === false ? 0 : 1) : (old ? Number(old.active) : 1),
  };
  need(['email', 'whatsapp', 'sms'].indexOf(t.channel) !== -1, 'channel must be email, whatsapp or sms');
  need(/^[a-z][a-z0-9_]{2,59}$/.test(t.name), 'name: 3–60 lowercase letters, digits or _ (e.g. order_update)');
  need(CATS.indexOf(t.category) !== -1, 'category must be one of ' + CATS.join(', '));
  if (t.channel === 'whatsapp') need(t.language, 'A WhatsApp template needs its language code (e.g. en_US)');
  return t;
}

async function list(q) {
  const where = [], params = [];
  if (q && q.channel) { where.push('channel = ?'); params.push(String(q.channel)); }
  if (q && q.usable) where.push('active = 1 AND approved_at_provider = 1');
  return db.query('SELECT id, channel, name, category, provider_template, language, param_names, sample_text, approved_at_provider, active, created_by_label, updated_at FROM b2b_message_templates' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY channel, name', params);
}

async function create(tx, actor, b) {
  const t = clean(b);
  let r;
  try {
    r = await tx.query('INSERT INTO b2b_message_templates (channel, name, category, provider_template, language, param_names, sample_text, approved_at_provider, active, created_by_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t.channel, t.name, t.category, t.provider_template, t.language, t.param_names, t.sample_text, t.approved_at_provider, t.active, actor.label]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A ' + t.channel + ' template named ' + t.name + ' already exists', 'template_exists'); throw e; }
  await audit.write(tx, actor, { module: 'notifications', action: 'template.created', entity: 'message_template', entityId: r.insertId, new: t });
  return Object.assign({ id: Number(r.insertId) }, t);
}

async function update(tx, actor, id, b) {
  const old = await tx.queryOne('SELECT * FROM b2b_message_templates WHERE id = ? FOR UPDATE', [posId(id)]);
  if (!old) throw fail(404, 'Template not found');
  const t = clean(b, old);
  await tx.query('UPDATE b2b_message_templates SET category = ?, provider_template = ?, language = ?, param_names = ?, sample_text = ?, approved_at_provider = ?, active = ? WHERE id = ?',
    [t.category, t.provider_template, t.language, t.param_names, t.sample_text, t.approved_at_provider, t.active, old.id]);
  await audit.write(tx, actor, { module: 'notifications', action: 'template.changed', entity: 'message_template', entityId: old.id,
    old: { category: old.category, provider_template: old.provider_template, approved_at_provider: Number(old.approved_at_provider), active: Number(old.active) }, new: t });
  return Object.assign({ id: Number(old.id) }, t);
}

/** The name the outbox sends: Meta template name for WhatsApp; 'dlt:<id>' (or the name) for SMS. */
function outboxName(t) {
  if (t.channel === 'whatsapp') return t.provider_template || t.name;
  if (t.channel === 'sms') return t.provider_template ? 'dlt:' + t.provider_template : t.name;
  return t.name;
}

module.exports = { list, create, update, outboxName, CATS };
