/**
 * Logo library: upload several logos in the admin panel and choose which one prints on bills.
 *
 *   Files      persistent storage (src/platform/storage.js, folder "branding"), never the site folder,
 *              so a redeploy keeps them. PNG, JPG or WEBP only (decided by the file's first bytes),
 *              at most 1 MB each, at most 12 logos.
 *   Settings   b2b_settings: branding.logos (the list) and branding.bill_logo (the chosen id).
 *   Default    the shop's own logo (/assets/images/logo-mark.png) until another one is chosen,
 *              or when the chosen one is removed or the settings cannot be read.
 *
 * Changing the library needs core.settings.edit; every change is in the audit log. Logos are
 * public pictures (they print on customers' bills), so they are served without sign-in.
 */
'use strict';
const crypto = require('crypto');

const KIND = 'branding';
const LIST_KEY = 'branding.logos';
const BILL_KEY = 'branding.bill_logo';
const MAX_BYTES = 1024 * 1024;
const MAX_LOGOS = 12;
const SHOP = { id: 'shop', label: 'Shop logo', url: '/assets/images/logo-mark.png', builtIn: true };
const NAME_RX = /^[a-f0-9]{32}\.(png|jpg|webp)$/;
const TTL_MS = 15000;
let cache = null;

function fail(status, msg, code) { return Object.assign(new Error(msg), { status: status, expose: true, code: code }); }
function db() { return require('../db/connection.js'); }
function storage() { return require('./storage.js'); }

/** Image type from the first bytes; SVG and everything else refused (SVG can carry scripts). */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: 'png', mime: 'image/png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
function urlOf(id) { return '/branding/logo/' + id; }
function view(l) { return Object.assign({}, l, { url: urlOf(l.id) }); }

async function readSetting(q, key) {
  const r = await (q || db()).queryOne('SELECT setting_value, updated_by, updated_at FROM b2b_settings WHERE setting_key = ?', [key]);
  if (!r) return undefined;
  try { return JSON.parse(r.setting_value); } catch (e) { return undefined; }
}
async function writeSetting(tx, key, value, by) {
  await tx.query('INSERT INTO b2b_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)', [key, JSON.stringify(value), String(by || '').slice(0, 190)]);
}
function cleanList(v) { return Array.isArray(v) ? v.filter(function (l) { return l && NAME_RX.test(String(l.id)); }) : []; }

/** → { logos: [...], billLogo: id, bill: {id,label,url} } */
async function state(q) {
  const logos = cleanList(await readSetting(q, LIST_KEY));
  const chosen = await readSetting(q, BILL_KEY);
  const hit = logos.find(function (l) { return l.id === chosen; });
  return { logos: logos.map(view), shop: SHOP, billLogo: hit ? hit.id : 'shop', bill: hit ? { id: hit.id, label: hit.label, url: urlOf(hit.id) } : SHOP };
}

/** The logo to print on bills; the shop logo whenever anything is missing. Cached briefly. */
async function billLogo() {
  if (!db().isConfigured()) return SHOP;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.bill;
  let bill = SHOP;
  try { bill = (await state()).bill; } catch (e) { return SHOP; }
  cache = { bill: bill, at: Date.now() };
  return bill;
}

async function audit(tx, actor, action, e) {
  await require('../modules/erp/core/audit.js').write(tx, actor, Object.assign({ module: 'core', action: action, entity: 'setting', entityId: null }, e));
}
function after(tx) { const clear = function () { cache = null; }; if (typeof tx.afterCommit === 'function') tx.afterCommit(clear); else clear(); }

/** file: { buffer, size }; label: what the person calls it ("Ayurveda range", "Distributor bills"). */
async function upload(tx, actor, file, label) {
  if (!file || !file.buffer || !file.buffer.length) throw fail(400, 'Choose a picture file to upload');
  if (file.buffer.length > MAX_BYTES) throw fail(400, 'The logo must be 1 MB or smaller');
  const t = sniff(file.buffer);
  if (!t) throw fail(400, 'Use a PNG, JPG or WEBP picture (SVG is not accepted)');
  const name = String(label || '').trim().slice(0, 60);
  if (!name) throw fail(400, 'Give the logo a name, so you can tell them apart');
  const logos = cleanList(await readSetting(tx, LIST_KEY));
  if (logos.length >= MAX_LOGOS) throw fail(409, 'The library holds ' + MAX_LOGOS + ' logos. Remove one first.');
  const id = crypto.randomBytes(16).toString('hex') + '.' + t.ext;
  await storage().put(KIND, id, file.buffer, t.mime);
  const entry = { id: id, label: name, mime: t.mime, bytes: file.buffer.length, uploadedBy: actor.label || null, uploadedAt: new Date().toISOString() };
  await writeSetting(tx, LIST_KEY, logos.concat([entry]), actor.label);
  await audit(tx, actor, 'branding.logo_added', { new: { id: id, label: name, bytes: entry.bytes } });
  after(tx);
  return view(entry);
}

/** id: a logo id, or "shop" for the shop's own logo. */
async function chooseBillLogo(tx, actor, id, reason) {
  const logos = cleanList(await readSetting(tx, LIST_KEY));
  if (id !== 'shop' && !logos.some(function (l) { return l.id === id; })) throw fail(404, 'That logo is not in the library');
  const before = await readSetting(tx, BILL_KEY);
  await writeSetting(tx, BILL_KEY, id, actor.label);
  await audit(tx, actor, 'branding.bill_logo_chosen', { old: { id: before || 'shop' }, new: { id: id }, reason: reason || null });
  after(tx);
  return { billLogo: id };
}

async function remove(tx, actor, id) {
  const logos = cleanList(await readSetting(tx, LIST_KEY));
  const hit = logos.find(function (l) { return l.id === id; });
  if (!hit) throw fail(404, 'That logo is not in the library');
  await writeSetting(tx, LIST_KEY, logos.filter(function (l) { return l.id !== id; }), actor.label);
  if ((await readSetting(tx, BILL_KEY)) === id) await writeSetting(tx, BILL_KEY, 'shop', actor.label);
  await audit(tx, actor, 'branding.logo_removed', { old: { id: id, label: hit.label } });
  after(tx);
  // The file goes after the commit, so a rolled-back removal never loses the picture.
  const drop = function () { storage().remove(KIND, id).catch(function () { /* an orphan file is harmless */ }); };
  if (typeof tx.afterCommit === 'function') tx.afterCommit(drop); else await drop();
  return { removed: id };
}

/** Public routes: the chosen bill logo (JSON) and the pictures themselves. */
function mount(app) {
  app.get('/api/platform/branding/bill-logo', function (req, res) {
    billLogo().then(function (b) { res.setHeader('Cache-Control', 'no-cache'); res.json({ id: b.id, label: b.label, url: b.url }); },
      function () { res.json({ id: SHOP.id, label: SHOP.label, url: SHOP.url }); });
  });
  app.get('/branding/logo/:name', function (req, res, next) {
    const name = String(req.params.name || '');
    if (!NAME_RX.test(name)) return res.status(404).end();
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[name.split('.').pop()];
    storage().send(res, KIND, name, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' })
      .then(function (sent) { if (!sent) res.status(404).end(); }).catch(next);
  });
}

function reset() { cache = null; }

module.exports = { state, billLogo, upload, chooseBillLogo, remove, mount, sniff, SHOP, MAX_BYTES, MAX_LOGOS, reset };
