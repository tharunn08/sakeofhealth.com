// TEST-ONLY shim for running the suites on Dolt (MySQL-compatible) when no MySQL 8 is available.
// Rewrites the few MySQL functions Dolt lacks. Never used in the delivered application.
const C = require(require('path').join(__dirname, '..', '..', 'node_modules', 'mysql2', 'lib', 'base', 'connection.js'));
const RULES = [[/\bUTC_DATE\(\)/gi, 'DATE(UTC_TIMESTAMP())']];
function fix(s) { if (typeof s !== 'string') return s; for (const [a, b] of RULES) s = s.replace(a, b); return s; }
function wrap(name) {
  const orig = C.prototype[name];
  C.prototype[name] = function (sql, values, cb) {
    if (typeof sql === 'string') sql = fix(sql); else if (sql && typeof sql.sql === 'string') sql.sql = fix(sql.sql);
    return orig.call(this, sql, values, cb);
  };
}
['query', 'execute'].forEach(wrap);
module.exports = { RULES };
