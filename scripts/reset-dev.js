#!/usr/bin/env node
/**
 * npm run reset — empty the DEVELOPMENT shop data folder and fill it with the demo catalogue again.
 * Refuses in production, and refuses any data folder that does not look like a development one
 * (it must be ./data inside this project, or a folder whose name contains "dev", "test" or "local").
 * The four protected products come back with their registry IDs (the store enforces it).
 */
'use strict';
try { require('dotenv').config(); } catch (e) { /* optional */ }
const fs = require('fs');
const path = require('path');
const os = require('os');

if (process.env.NODE_ENV === 'production') { console.error('Refusing to reset: NODE_ENV=production.'); process.exit(1); }
const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data');
const inProject = path.resolve(dir) === path.resolve(__dirname, '..', 'data');
if (!inProject && !/(dev|test|local)/i.test(path.basename(dir))) {
  console.error('Refusing to reset ' + dir + ': set DATA_DIR to ./data or to a folder named like "sakeofhealth-dev".');
  process.exit(1);
}
let n = 0;
if (fs.existsSync(dir)) fs.readdirSync(dir).filter(function (f) { return /\.json$/.test(f); }).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); n++; });
console.log('Removed ' + n + ' file(s) from ' + dir + '.');
const { seed } = require('../src/seed.js');
seed({});
console.log('Demo data loaded.');
