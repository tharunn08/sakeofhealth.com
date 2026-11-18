// Re-pin ONLY files changed for the central Admin Panel, each with its reason. Same hashing as b2c-guard.js.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const repo = process.argv[2], mp = path.join(repo, 'scripts', 'b2c-manifest.json');
const TEXT = /\.(html?|css|js|json|md|txt|svg|xml)$/i;
const sha = p => { let b = fs.readFileSync(p); if (TEXT.test(p)) b = Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'); return crypto.createHash('sha256').update(b).digest('hex'); };
const APPROVED = {
  'frontend/admin/admin.js': 'Central Admin Panel (2): ERP session next to the staff session (one sign-in), sidebar request carries it, ERP-only staff supported (owner instruction 2026-11-13: consolidate the ERP screens and identities into /admin)',
  'src/server.js': 'Shared identity (3): two lines only — staff with a temporary password are refused on /api/admin until they change it at /login, and the change-password endpoint gets the same rate limit as sign-in (owner instruction 2026-11-13: initial role accounts must change their password at first login)',
};
const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
const changed = [];
for (const f of Object.keys(APPROVED)) {
  if (!(f in m.files)) throw new Error('not in manifest: ' + f);
  const h = sha(path.join(repo, f));
  if (h !== m.files[f]) { changed.push({ file: f, from: m.files[f], to: h, reason: APPROVED[f] }); m.files[f] = h; }
}
m.repins = (m.repins || []).concat([{ date: new Date().toISOString().slice(0, 10), by: 'Phase 1 — ' + (process.argv[3] || 'central Admin Panel'), changes: changed }]);
fs.writeFileSync(mp, JSON.stringify(m, null, 1) + '\n');
console.log('re-pinned ' + changed.length + ' approved files');
changed.forEach(c => console.log('  ' + c.file));
