#!/usr/bin/env node
/**
 * npm run check:env — checks the current configuration without starting the app.
 *   npm run check:env                      reads .env (if present) + the process environment
 *   npm run check:env -- --production      checks as if NODE_ENV=production (before a deploy)
 *   npm run check:env -- --env-file=<file> checks that file only (e.g. a copy of what you will paste in hPanel)
 * Prints variable names and problems only — never values. Exit code 1 when anything is wrong.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { validate, format } = require('../src/config/env.js');

function parseEnvFile(file) {
  const out = {};
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) return;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  });
  return out;
}

function main(argv) {
  const fileArg = argv.filter(function (a) { return a.indexOf('--env-file=') === 0; })[0];
  let env;
  if (fileArg) env = parseEnvFile(path.resolve(fileArg.slice('--env-file='.length)));
  else {
    env = Object.assign({}, process.env);
    const dot = path.join(__dirname, '..', '.env');
    if (fs.existsSync(dot)) env = Object.assign(parseEnvFile(dot), process.env);
  }
  if (argv.indexOf('--production') !== -1) env.NODE_ENV = 'production';
  const r = validate(env);
  console.log('Environment check (' + r.mode + '): ' + r.errors.length + ' problem(s), ' + r.warnings.length + ' warning(s).');
  format(r).forEach(function (l) { console.log(l); });
  if (!r.errors.length) console.log(r.mode === 'production' ? 'OK — the server will start with this configuration.' : 'OK.');
  return r.errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parseEnvFile, main };
