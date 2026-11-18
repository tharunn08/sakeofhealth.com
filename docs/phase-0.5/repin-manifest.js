// Re-pin ONLY the files approved in PHASE-0.5-CHANGE-SPECIFICATION (rows 1–21) plus the
// regression test file (spec §7: changed tests listed with reasons). Same hashing as b2c-guard.js.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const repo = process.argv[2], mp = path.join(repo, 'scripts', 'b2c-manifest.json');
const TEXT = /\.(html?|css|js|json|md|txt|svg|xml)$/i;
const sha = p => { let b = fs.readFileSync(p); if (TEXT.test(p)) b = Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'); return crypto.createHash('sha256').update(b).digest('hex'); };
const APPROVED = {
  'src/middleware/customerAuth.js': '0.5.1 BUG-001 separate customer secret, typ claim',
  'src/routes/auth.js': '0.5.1 BUG-001 503 when customer auth not configured',
  'src/middleware/adminAuth.js': '0.5.1 BUG-001/015 admin secret only, typ claim, debug log removed; 0.5.9 BUG-016 no ?token=',
  'src/routes/admin.js': '0.5.2 BUG-005 permission middleware, delivery filter; 0.5.7 D10 cancel instead of delete; 0.5.8 passwordChangedAt',
  'src/routes/shop.js': '0.5.3–0.5.5 BUG-002/004/006/028 quote, server pricing, payment binding',
  'src/routes/checkout.js': '0.5.4 BUG-002 gateway order from server-priced cart',
  'src/services/payments.js': '0.5.4–0.5.5 BUG-002/003/021 fail-closed Razorpay, Cashfree removed, B2B contract kept',
  'src/server.js': '0.5.5 B2C webhook mount; 0.5.8 BUG-008/018 no production seed, status-only /health; 0.5.10 blog article route',
  'src/services/orders.js': '0.5.6–0.5.7 BUG-012/013 D10 payment status, numbering, cancelOrder',
  'src/seed.js': '0.5.8 BUG-008 refuses production, staff only with --with-staff',
  'src/services/blogTemplate.js': '0.5.10 BUG-007 escaped article body',
  'src/services/blogStore.js': '0.5.10 BUG-007 data under DATA_DIR/blog, legacy copied',
  'src/routes/blog.js': '0.5.10 BUG-007 moderator roles, articles served from DATA_DIR',
  'frontend/admin/blog.html': '0.5.10 BUG-007 admin session instead of typed password',
  'frontend/checkout/index.html': '0.5.4 BUG-002/028/032 server quote, no client amount, express hidden (D14); 0.5.11 empty cart shows ₹0 total',
  'frontend/admin/page-orders.js': '0.5.7 D10 cancel with reason',
  'frontend/admin/page-deliveries.js': '0.5.2 BUG-005 agent view; 0.5.7 D10 cancel with reason',
  'frontend/admin/page-customers.js': '0.5.9 BUG-016 authorised CSV download',
  'frontend/admin/page-reports.js': '0.5.9 BUG-016 authorised CSV download',
  'tests/b2c-regression.test.js': 'tests #7, #17, /health changed for approved fixes (docs/phase-0.5/CHANGED-TESTS.md)',
  'frontend/admin/admin.js': '0.5.2 BUG-005 menu by role, delivery to own board — not in the original 21-file list; approved by the owner on 2026-11-12 during 0.5.11',
};
const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
const changed = [];
for (const f of Object.keys(APPROVED)) {
  if (!(f in m.files)) throw new Error('not in manifest: ' + f);
  const h = sha(path.join(repo, f));
  if (h !== m.files[f]) { changed.push({ file: f, from: m.files[f], to: h, reason: APPROVED[f] }); m.files[f] = h; }
}
m.repins = (m.repins || []).concat([{ date: new Date().toISOString().slice(0, 10), by: 'Phase 0.5 (approved PHASE-0.5-CHANGE-SPECIFICATION)', changes: changed }]);
fs.writeFileSync(mp, JSON.stringify(m, null, 1) + '\n');
console.log('re-pinned ' + changed.length + ' approved files');
changed.forEach(c => console.log('  ' + c.file));
