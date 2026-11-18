/** /api/erp/notifications — the notification center inside the central /admin (N2, N3). */
'use strict';
const express = require('express');
const db = require('../../../db/connection.js');
const { h, posId } = require('../lib/http.js');
const identity = require('../core/identity.js');
const audit = require('../core/audit.js');
const svc = require('../notifications/service.js');
const directory = require('../notifications/directory.js');
const templates = require('../notifications/templates.js');
const consent = require('../notifications/consent.js');
const groups = require('../notifications/groups.js');

const r = express.Router();
const can = identity.can;
const id = function (v) { const n = posId(v); if (!n) throw Object.assign(new Error('Not found'), { status: 404, expose: true }); return n; };
const B = function (req) { return req.body || {}; };
const anySend = function (req, res, next) {
  const p = req.erp.permissions;
  if (['trade', 'salesmen', 'vendors', 'staff'].some(function (a) { return p.has('notifications.send.' + a); })) return next();
  res.status(403).json({ error: 'You may not send notifications', code: 'forbidden' });
};
r.use(identity.requireStaff);

// what the composer may offer this person
r.get('/meta', can('notifications.view'), h(async function (req, res) {
  const p = req.erp.permissions;
  res.json({
    limits: await svc.limits(),
    recipientTypes: directory.TYPES.filter(function (t) { return svc.canSendTo(req.erp, t); }),
    canSeeContacts: p.has('notifications.contacts.view'), canPromote: p.has('notifications.send.promotional'), canApprovePromo: p.has('notifications.promotional.approve'),
    canManageTemplates: p.has('notifications.templates.manage'), canManageConsent: p.has('notifications.optout.manage'),
    providers: { email: !!(process.env.SMTP_HOST && process.env.SMTP_USER), whatsapp: !!((process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) || (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)), sms: !!process.env.MSG91_AUTH_KEY },
    templates: await templates.list({ usable: true }),
  });
}));
r.get('/recipients', can('notifications.view'), h(async function (req, res) {
  const type = String(req.query.type || '');
  if (directory.TYPES.indexOf(type) === -1) return res.status(400).json({ error: 'Unknown recipient type' });
  if (!svc.canSendTo(req.erp, type)) return res.status(403).json({ error: 'You may not send messages to ' + type + 's', code: 'audience_forbidden' });
  const lim = await svc.limits();
  const items = await directory.search(type, req.query.q, req.erp.permissions.has('notifications.contacts.view'), req.query.all === '1' ? lim.max_recipients + 1 : 50);
  res.json({ items: items, truncated: req.query.all === '1' && items.length > lim.max_recipients });
}));
r.get('/messages', can('notifications.view'), h(async function (req, res) { res.json(await svc.list(req.erp, req.query)); }));
r.get('/messages/:id', can('notifications.view'), h(async function (req, res) { res.json(await svc.detail(req.erp, id(req.params.id))); }));
r.post('/messages', anySend, h(async function (req, res) { res.status(201).json(await svc.send(audit.actorFrom(req), req.erp, B(req))); }));
r.post('/messages/:id/resend', anySend, h(async function (req, res) { res.status(201).json(await svc.resend(audit.actorFrom(req), req.erp, id(req.params.id), B(req))); }));
r.post('/preview', anySend, h(async function (req, res) { res.json(await svc.preview(req.erp, B(req))); }));
r.get('/analytics', can('notifications.view'), h(async function (req, res) { res.json(await svc.analytics(req.query.days)); }));
// templates
r.get('/templates', can('notifications.view'), h(async function (req, res) { res.json({ items: await templates.list(req.query) }); }));
r.post('/templates', can('notifications.templates.manage'), h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return templates.create(t, audit.actorFrom(req), B(req)); })); }));
r.put('/templates/:id', can('notifications.templates.manage'), h(async function (req, res) { res.json(await db.transaction(function (t) { return templates.update(t, audit.actorFrom(req), id(req.params.id), B(req)); })); }));

// recipient groups
r.get('/groups', can('notifications.view'), h(async function (req, res) { res.json({ items: await groups.list(req.erp) }); }));
r.post('/groups', anySend, h(async function (req, res) { res.status(201).json(await db.transaction(function (t) { return groups.create(t, audit.actorFrom(req), req.erp, B(req)); })); }));
r.put('/groups/:id', anySend, h(async function (req, res) { res.json(await db.transaction(function (t) { return groups.update(t, audit.actorFrom(req), req.erp, id(req.params.id), B(req)); })); }));

// consent and opt-out (D4)
r.get('/consent', can('notifications.view'), h(async function (req, res) { res.json({ items: await consent.list(req.query), sources: consent.SOURCES }); }));
r.get('/consent/recipient', can('notifications.view'), h(async function (req, res) {
  const type = String(req.query.type || ''), ref = posId(req.query.ref);
  if (directory.TYPES.indexOf(type) === -1 || !ref) return res.status(400).json({ error: 'type and ref are required' });
  const p = (await directory.resolve([{ type: type, ref: ref }]))[0];
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json({ name: p.name, items: await consent.forRecipients([p], consent.CHANNELS) });
}));
r.post('/consent', can('notifications.optout.manage'), h(async function (req, res) {
  const b = B(req);
  const type = b.recipient && b.recipient.type, ref = b.recipient && posId(b.recipient.ref);
  if (directory.TYPES.indexOf(type) === -1 || !ref) return res.status(400).json({ error: 'Choose the person this preference belongs to' });
  // promotional consent is recorded only for business accounts (D4); opt-outs for anyone
  if (b.state === 'opted_in' && b.scope === 'promotional' && svc.PROMO_TYPES.indexOf(type) === -1) {
    return res.status(400).json({ error: 'Promotional consent is recorded only for retailers and distributors', code: 'promotional_business_only' });
  }
  const p = (await directory.resolve([{ type: type, ref: ref }]))[0];
  if (!p) return res.status(404).json({ error: 'Not found' });
  const address = b.channel === 'email' ? p.email : p.mobile;
  res.status(201).json(await db.transaction(function (t) {
    return consent.record(t, audit.actorFrom(req), { channel: b.channel, address: address, recipient: { type: type, ref: ref }, scope: b.scope, state: b.state, source: b.source, note: b.note });
  }));
}));

module.exports = r;
