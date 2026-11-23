#!/usr/bin/env node
/**
 * Copy business documents from the private folder (B2B_PRIVATE_DIR/documents) to the S3-compatible bucket
 * configured with STORAGE_PROVIDER=s3. Use it once when switching from local storage to a bucket.
 *
 *   node --env-file=.env scripts/storage-copy.js          dry run: lists what would be copied
 *   node --env-file=.env scripts/storage-copy.js --yes    copies; each file is checked in the bucket afterwards
 *
 * Files already in the bucket are skipped, so it is safe to run again. Local files are never deleted:
 * remove the old folder yourself only after checking the documents open from the admin panel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const storage = require('../src/platform/storage.js');

const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };

async function main(argv) {
  const yes = argv.indexOf('--yes') !== -1;
  if (storage.provider() !== 's3') {
    console.error('STORAGE_PROVIDER is not s3 — set STORAGE_PROVIDER=s3 and the STORAGE_* bucket settings first.');
    return 2;
  }
  const dir = path.join(storage.localRoot(), 'documents');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(function (n) { return storage.NAME_RX.test(n); }).sort() : [];
  console.log('Local documents: ' + names.length + ' in ' + dir.replace(/^.*[\\/](?=[^\\/]+[\\/]documents$)/, '…/'));
  let copied = 0, skipped = 0, failed = 0, pending = 0;
  for (const name of names) {
    try {
      if (await storage.exists('documents', name)) { skipped++; continue; }
      if (!yes) { pending++; console.log('  would copy ' + name); continue; }
      await storage.put('documents', name, fs.readFileSync(path.join(dir, name)), MIME[name.split('.').pop()]);
      if (!(await storage.exists('documents', name))) throw new Error('not found in the bucket after upload');
      copied++; console.log('  copied ' + name);
    } catch (e) { failed++; console.error('  FAILED ' + name + ': ' + e.message); }
  }
  console.log((yes ? 'Copied ' + copied : 'To copy: ' + pending) + ' · already in the bucket: ' + skipped + ' · failed: ' + failed + (yes ? '' : '  (dry run — add --yes to copy)'));
  return failed ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then(function (code) { process.exitCode = code; }, function (e) { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
