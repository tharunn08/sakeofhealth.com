#!/usr/bin/env node
/**
 * The four protected shop products — check, inspect, reconcile.
 *
 *   node scripts/protected-products.js verify          exit 0 = all four present and intact; 1 = not (prints why)
 *   node scripts/protected-products.js show            the registry and the stored records side by side
 *   node scripts/protected-products.js history [slug]  the change log (who, when, why, before → after)
 *   node scripts/protected-products.js adopt <file>    compare an old products.json (or a backup) with the
 *                                                      registry: matches, original IDs, conflicts. Read-only.
 *
 * Reads the shop data folder (DATA_DIR) directly; never writes to it. Use before and after every deploy
 * (npm run verify:products); the deploy is not finished until it says OK.
 */
'use strict';
try { require('dotenv').config(); } catch (e) { /* optional */ }
const fs = require('fs');
const path = require('path');
const os = require('os');
const protection = require('../src/services/productProtection.js');

function dataDir() { return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data'); }
function readProducts(file) {
  const text = fs.readFileSync(file, 'utf8');
  const v = JSON.parse(text);
  if (!Array.isArray(v)) throw new Error(file + ' is not a list of products');
  return v;
}

function verify(json) {
  const file = path.join(dataDir(), 'products.json');
  let products;
  try { products = readProducts(file); }
  catch (e) {
    const out = { ok: false, file: file, problems: [{ slug: '*', problem: e.code === 'ENOENT' ? 'no products file' : 'products file unreadable: ' + e.message }] };
    if (json) console.log(JSON.stringify(out)); else console.error('FAIL ' + file + ': ' + out.problems[0].problem);
    return 1;
  }
  const r = protection.verify(products);
  if (json) { console.log(JSON.stringify(Object.assign({ file: file }, r))); return r.ok ? 0 : 1; }
  if (r.ok) {
    console.log('OK — the four protected products are present and intact in ' + file + ':');
    protection.PRODUCTS.forEach(function (e) {
      const p = products.filter(function (x) { return x.id === e.id; })[0];
      console.log('  ' + e.id.padEnd(24) + e.name.padEnd(32) + '₹' + p.price + (p.stock == null ? '' : '  stock ' + p.stock) + (e.toConfirm.length ? '  (to confirm: ' + e.toConfirm.join(', ') + ')' : ''));
    });
    return 0;
  }
  console.error('FAIL — protected-product integrity check on ' + file + ':');
  r.problems.forEach(function (p) { console.error('  ' + p.slug + ': ' + p.problem); });
  console.error('Fix: see docs/unified/PROTECTED-PRODUCTS.md (restore a backup or a snapshot; never edit the IDs).');
  return 1;
}

function show() {
  let products = [];
  try { products = readProducts(path.join(dataDir(), 'products.json')); } catch (e) { /* shown as missing */ }
  protection.PRODUCTS.forEach(function (e) {
    const p = products.filter(function (x) { return protection.entryFor(x) === e; });
    console.log(e.id + '  (' + e.slug + ')');
    console.log('  registry: ' + e.name + ' · ' + e.category + ' · SKU ' + (e.sku || 'to confirm (candidate ' + e.skuCandidate + ')') + ' · HSN ' + (e.hsnCode || 'to confirm') + ' · GST ' + (e.gstRate == null ? 'to confirm' : e.gstRate + '%'));
    if (!p.length) console.log('  stored:   MISSING');
    p.forEach(function (x) { console.log('  stored:   id ' + x.id + ' · ' + x.name + ' · ₹' + x.price + ' (MRP ' + x.mrp + ') · stock ' + (x.stock == null ? 'not tracked' : x.stock) + ' · ' + (x.active === false ? 'HIDDEN' : 'on sale')); });
  });
  return 0;
}

function history(slug) {
  const e = slug ? protection.PRODUCTS.filter(function (x) { return x.slug === slug || x.id === slug; })[0] : null;
  if (slug && !e) { console.error('Unknown protected product: ' + slug); return 1; }
  const rows = protection.history(e ? e.id : null, 500);
  if (!rows.length) { console.log('No changes logged yet (' + protection.logFile() + ').'); return 0; }
  rows.forEach(function (r) {
    console.log(r.at + '  ' + r.slug + '  ' + r.op + '  by ' + r.actor + (r.reason ? '  — ' + r.reason : ''));
    if (r.before) Object.keys(r.before).forEach(function (k) { console.log('      ' + k + ': ' + JSON.stringify(r.before[k]) + ' → ' + JSON.stringify(r.after[k])); });
  });
  return 0;
}

/** Compare an old products.json (or a backup folder) with the registry; read-only. */
function adopt(file) {
  if (!file) { console.error('Usage: node scripts/protected-products.js adopt <products.json | backup folder>'); return 1; }
  let f = file;
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = fs.existsSync(path.join(f, 'b2c-data', 'products.json')) ? path.join(f, 'b2c-data', 'products.json') : path.join(f, 'products.json');
  const old = readProducts(f);
  console.log('Comparing ' + f + ' (' + old.length + ' products) with the protected-products registry. Nothing is changed.\n');
  let conflicts = 0;
  protection.PRODUCTS.forEach(function (e) {
    const bySlug = old.filter(function (p) { return p.slug === e.slug; });
    const byName = old.filter(function (p) { return p.name === e.name || e.formerNames.indexOf(p.name) !== -1; });
    const bySku = old.filter(function (p) { return p.sku && (p.sku === e.sku || p.sku === e.skuCandidate); });
    const all = bySlug.concat(byName, bySku).filter(function (p, i, a) { return a.indexOf(p) === i; });
    console.log(e.slug + ' — registry id ' + e.id);
    if (!all.length) { console.log('  not in this file'); return; }
    all.forEach(function (p) {
      const notes = [];
      if (p.id !== e.id) notes.push('ORIGINAL ID ' + p.id + ' → add to legacyIds so old orders still resolve');
      if (p.name !== e.name) notes.push('name "' + p.name + '"' + (e.formerNames.indexOf(p.name) !== -1 ? ' (a known former name)' : ' — CONFLICT with "' + e.name + '"'));
      if (p.category !== e.category) notes.push('category "' + p.category + '" — CONFLICT with "' + e.category + '"');
      if (p.sku && p.sku !== (e.sku || e.skuCandidate)) notes.push('SKU "' + p.sku + '" — CONFLICT with "' + (e.sku || e.skuCandidate) + '"');
      if (p.sku && !e.sku && p.sku === e.skuCandidate) notes.push('SKU "' + p.sku + '" matches the candidate: can be confirmed');
      if (p.price !== e.restore.price) notes.push('price ₹' + p.price + ' (product page ₹' + e.restore.price + ')');
      conflicts += notes.filter(function (n) { return /CONFLICT/.test(n); }).length;
      console.log('  found: id ' + p.id + (notes.length ? '\n    ' + notes.join('\n    ') : ' — identical identity'));
    });
    if (all.length > 1) { conflicts++; console.log('  DUPLICATE: ' + all.length + ' records match this product'); }
  });
  console.log('\n' + (conflicts ? conflicts + ' conflict(s) to decide. ' : 'No conflicts. ') +
    'To keep original IDs, add them to "legacyIds" in src/catalogue/protected-products.json and commit; to confirm a SKU, set "sku" and remove it from "toConfirm".');
  return 0;
}

const cmd = process.argv[2];
const code = cmd === 'verify' ? verify(process.argv.includes('--json'))
  : cmd === 'show' ? show()
  : cmd === 'history' ? history(process.argv[3])
  : cmd === 'adopt' ? adopt(process.argv[3])
  : (console.error('Usage: node scripts/protected-products.js verify [--json] | show | history [slug] | adopt <file>'), 2);
process.exitCode = code;
