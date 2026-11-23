/**
 * Protected products — the four shop products can never be deleted, deactivated, archived,
 * duplicated or re-identified, whoever asks: Admin, an import, a bulk script, a sync, the seed.
 *
 * Enforced where every write goes through: the shop's product store (src/services/db.js wraps its
 * `products` collection with `wrap()` below), so no route, script or future feature can bypass it.
 *
 * Rules for a record that matches the registry (src/catalogue/protected-products.json) by id,
 * slug, legacy id or confirmed SKU:
 *   • remove()                      → refused (409 protected_delete)
 *   • update() changing id, slug, name, category or a set SKU → refused (409 protected_identity)
 *   • update() setting active:false, upcoming:true, archived or deleted* → refused (409 protected_active)
 *   • update() changing anything else (price, MRP, stock, text, images…) needs a reason given through
 *     run({ actor, reason }, fn) — else refused (400 reason_required). System repairs pass system:true.
 *   • insert() of a registered product is always stored under its registry ID with its registry
 *     identity; a second copy is refused (409 protected_duplicate).
 * Every change to a protected product is appended to the change log (one JSON line per change:
 * when, who, reason, before/after of the changed fields) outside the site folder.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const REGISTRY = require('../catalogue/protected-products.json');
const PRODUCTS = Object.freeze(REGISTRY.products.map(function (p) { return Object.freeze(Object.assign({}, p)); }));
const IDENTITY = ['id', 'slug', 'name', 'category'];
const context = new AsyncLocalStorage();

class ProtectedProductError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status; this.code = code; this.expose = true; this.detail = detail || null;
  }
}

function norm(v) { return v === undefined || v === null || v === '' ? null : v; }
function same(a, b) { return JSON.stringify(norm(a)) === JSON.stringify(norm(b)); }

/** The registry entry for a record (or a would-be record), or null. */
function entryFor(doc) {
  if (!doc) return null;
  for (const e of PRODUCTS) {
    if (doc.id === e.id || (doc.slug && doc.slug === e.slug)) return e;
    if (doc.id && e.legacyIds.indexOf(doc.id) !== -1) return e;
    if (e.sku && doc.sku && doc.sku === e.sku) return e;
  }
  return null;
}
function isProtected(doc) { return !!entryFor(doc); }

function dataDir() { return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data'); }
/** The change log lives with the catalogue snapshots, outside the site folder (under the data folder only in tests). */
function logFile() {
  const dir = process.env.CATALOGUE_DIR ? path.resolve(process.env.CATALOGUE_DIR)
    : process.env.NODE_ENV === 'test' ? path.join(dataDir(), '.catalogue-test') : path.join(os.homedir(), 'sakeofhealth-catalogue');
  return path.join(dir, 'protected-products-changes.jsonl');
}
function record(entry) {
  const file = logFile();
  const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n';
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, line); }
  catch (e) { console.error('[PROTECTED] could not write the change log ' + file + ': ' + e.message); }
}
/** The newest changes, optionally for one product (newest first). */
function history(productId, limit) {
  let lines = [];
  try { lines = fs.readFileSync(logFile(), 'utf8').split('\n').filter(Boolean); } catch (e) { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < (limit || 100); i--) {
    try { const x = JSON.parse(lines[i]); if (!productId || x.productId === productId) out.push(x); } catch (e) { /* skip a damaged line */ }
  }
  return out;
}

/** Who is changing products, and why: run({ actor: 'admin:a@b.c', reason: '…' }, () => db.products.update(…)). */
function run(ctx, fn) { return context.run(Object.assign({}, ctx), fn); }
function current() { return context.getStore() || {}; }
function actorOf(c) { return c.actor || (c.system ? 'system' : 'unknown'); }

function inactive(after) {
  return after.active === false || after.upcoming === true || !!after.archived || !!after.deleted || !!after.deletedAt || !!after.archivedAt;
}

/** The registry identity a stored record must carry. */
function identityOf(e) { return { id: e.id, slug: e.slug, name: e.name, category: e.category }; }

function wrap(col) {
  const wrapped = Object.assign({}, col);

  wrapped.insert = function (doc) {
    const e = entryFor(doc);
    if (!e) return col.insert(doc);
    const existing = col.all().filter(function (p) { return entryFor(p) === e; });
    if (existing.length) {
      throw new ProtectedProductError(409, 'protected_duplicate', '"' + e.name + '" is a protected product and already exists (id ' + existing[0].id + '). It cannot be added a second time.');
    }
    const c = current();
    const normalised = Object.assign({}, doc, identityOf(e), e.sku ? { sku: e.sku } : {});
    if (inactive(normalised)) Object.assign(normalised, { active: true, upcoming: false, archived: false, archivedAt: null, deleted: false, deletedAt: null });
    const changed = Object.keys(identityOf(e)).filter(function (k) { return doc[k] !== undefined && doc[k] !== normalised[k]; });
    const rec = col.insert(normalised);
    record({ productId: e.id, slug: e.slug, op: 'insert', actor: actorOf(c), reason: c.reason || null, via: c.via || null,
      normalised: changed.length ? changed.reduce(function (o, k) { o[k] = { given: doc[k], stored: normalised[k] }; return o; }, {}) : undefined });
    return rec;
  };

  wrapped.update = function (id, patch) {
    const before = col.findById(id);
    const e = entryFor(before);
    if (!e) return col.update(id, patch);
    const c = current();
    const after = Object.assign({}, before, patch);
    const identity = IDENTITY.filter(function (k) { return k in patch && !same(patch[k], before[k]); });
    if ('sku' in patch && norm(before.sku) !== null && !same(patch.sku, before.sku)) identity.push('sku');
    if (e.sku && 'sku' in patch && !same(patch.sku, e.sku)) identity.push('sku');
    if (identity.length) {
      throw new ProtectedProductError(409, 'protected_identity', '"' + e.name + '" is a protected product: its ' + identity.filter(function (k, i, a) { return a.indexOf(k) === i; }).join(', ') +
        ' cannot be changed here. Identity changes are made only in the protected-products registry, in source control.', { fields: identity });
    }
    if (inactive(after) && !inactive(before)) {
      throw new ProtectedProductError(409, 'protected_active', '"' + e.name + '" is a protected product and must stay on sale: it cannot be hidden, archived, deleted or marked upcoming. Set its stock instead.');
    }
    const changes = Object.keys(patch).filter(function (k) { return k !== 'updatedAt' && !same(patch[k], before[k]); });
    if (!changes.length) return before;
    const reason = typeof c.reason === 'string' ? c.reason.trim() : '';
    if (!c.system && reason.length < 5) {
      throw new ProtectedProductError(400, 'reason_required', '"' + e.name + '" is a protected product: give a reason (at least 5 characters) for this change. It is kept in the change log.', { fields: changes });
    }
    const out = col.update(id, patch);
    const b = {}, a = {};
    changes.forEach(function (k) { b[k] = before[k] === undefined ? null : before[k]; a[k] = out[k] === undefined ? null : out[k]; });
    record({ productId: e.id, slug: e.slug, op: 'update', actor: actorOf(c), reason: reason || null, via: c.via || null, before: b, after: a });
    return out;
  };

  wrapped.remove = function (id) {
    const before = col.findById(id);
    const e = entryFor(before);
    if (!e) return col.remove(id);
    const c = current();
    record({ productId: e.id, slug: e.slug, op: 'delete_refused', actor: actorOf(c), reason: c.reason || null, via: c.via || null });
    throw new ProtectedProductError(409, 'protected_delete', '"' + e.name + '" is one of the four protected products and cannot be deleted. You can change its price, stock, text and images.');
  };

  wrapped.protectedProducts = true;
  Object.defineProperty(wrapped, 'raw', { value: col, enumerable: false });   // for repair() only
  return wrapped;
}

/**
 * Integrity of a product list against the registry: each protected product exactly once, under its
 * registry id, with its registry identity, on sale. Returns { ok, problems: [{ slug, problem }] }.
 */
function verify(products) {
  const problems = [];
  PRODUCTS.forEach(function (e) {
    const matches = products.filter(function (p) { return entryFor(p) === e; });
    if (!matches.length) { problems.push({ slug: e.slug, problem: 'missing' }); return; }
    if (matches.length > 1) problems.push({ slug: e.slug, problem: 'stored ' + matches.length + ' times (ids ' + matches.map(function (p) { return p.id; }).join(', ') + ')' });
    const p = matches.filter(function (x) { return x.id === e.id; })[0];
    if (!p) { problems.push({ slug: e.slug, problem: 'stored under id ' + matches[0].id + ' instead of ' + e.id }); return; }
    IDENTITY.forEach(function (k) { if (!same(p[k], e[k])) problems.push({ slug: e.slug, problem: k + ' is "' + p[k] + '", the registry says "' + e[k] + '"' }); });
    if (e.sku && !same(p.sku, e.sku)) problems.push({ slug: e.slug, problem: 'SKU is "' + p.sku + '", the registry says "' + e.sku + '"' });
    if (inactive(p)) problems.push({ slug: e.slug, problem: 'not on sale (hidden, archived, deleted or upcoming)' });
    if (!(Number(p.price) > 0)) problems.push({ slug: e.slug, problem: 'has no valid price' });
  });
  return { ok: problems.length === 0, problems: problems };
}

/**
 * Self-repair of what can be repaired without losing anything: identity drift (name, slug, category,
 * on-sale flags edited directly in the file) is set back to the registry and logged as a system change.
 * Duplicates and wrong ids are NOT repaired automatically (a person must decide) — verify() reports them.
 */
function repair(col, log) {
  const fixed = [];
  run({ system: true, actor: 'system:integrity-repair', reason: 'Protected product identity restored from the registry' }, function () {
    PRODUCTS.forEach(function (e) {
      const all = col.all();
      const mine = all.filter(function (p) { return entryFor(p) === e; });
      if (mine.length !== 1 || mine[0].id !== e.id) return;
      const p = mine[0], patch = {};
      IDENTITY.forEach(function (k) { if (k !== 'id' && !same(p[k], e[k])) patch[k] = e[k]; });
      if (e.sku && !same(p.sku, e.sku)) patch.sku = e.sku;
      if (inactive(p)) Object.assign(patch, { active: true, upcoming: false, archived: false, archivedAt: null, deleted: false, deletedAt: null });
      if (!Object.keys(patch).length) return;
      // the raw collection (identity changes are refused through the protected one, by design)
      const before = {}; Object.keys(patch).forEach(function (k) { before[k] = p[k] === undefined ? null : p[k]; });
      col.raw.update(p.id, patch);
      record({ productId: e.id, slug: e.slug, op: 'repair', actor: 'system:integrity-repair', reason: 'Identity restored from the registry', before: before, after: patch });
      fixed.push(e.slug);
    });
  });
  if (fixed.length && log) log.warn('[PROTECTED] Identity restored from the registry for: ' + fixed.join(', ') + ' (see the change log).');
  return fixed;
}

module.exports = { PRODUCTS, REGISTRY, ProtectedProductError, entryFor, isProtected, wrap, run, verify, repair, history, logFile, identityOf };
