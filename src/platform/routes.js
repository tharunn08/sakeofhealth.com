/**
 * Central Admin Panel — shell routes and the single sign-in.
 *
 *   GET  /login                    one sign-in page for staff and shop customers
 *   POST /api/platform/auth/login  checks every account type the person may have
 *                                  and returns the workspaces they can open
 *   POST /api/platform/auth/forgot-password, /reset-password   e-mailed reset link (business staff)
 *   GET  /api/platform/nav         the signed-in staff member's sidebar (server-filtered)
 *   GET  /admin                    opens the user's home page in the panel
 *   GET  /admin/<group>/<page>     every admin page, built by the one shell from the registry
 *   GET  /admin/index.html         → /login (the old staff sign-in page)
 *
 * Old page addresses (/admin/orders.html, /admin/b2b/orders.html, …) keep
 * working and render the same shell and sidebar; redirects follow once the
 * new addresses are signed off (ADMIN-CONSOLIDATION-MAP §4).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const registry = require('./registry.js');
const { signIn, newPasswordProblem, GENERIC } = require('./auth.js');
const { login: staffLogin, verifyToken: verifyStaffToken, isConfigured: staffConfigured } = require('../middleware/adminAuth.js');
const { login: customerLogin } = require('../middleware/customerAuth.js');
const erpConfig = require('../modules/erp/config.js');

const WEB = path.join(__dirname, '..', '..', 'platform-web');
/** Roles whose whole job is in the field app (a person with only these never needs the admin panel). */
const FIELD_ROLES = ['salesman', 'delivery_staff', 'event_staff'];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function noStore(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/** The one page template: shared shell (admin.js) + the page's own script(s). */
function pageHtml(page) {
  const meta = { id: page.id, label: page.label, module: page.module, view: page.view || null };
  if (page.module === 'erp') {
    // ERP screens link to each other by screen id; give them the shell addresses.
    meta.erpPaths = {};
    registry.PAGES.filter(p => p.module === 'erp').forEach(p => { meta.erpPaths[p.view] = p.path; });
  }
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8"/>\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\n' +
    '<title>' + esc(page.label) + ' — Admin</title>\n<meta name="robots" content="noindex,nofollow"/>\n' +
    // Relative links inside the page scripts resolve exactly as they did at the old address.
    '<base href="' + page.base + '"/>\n' +
    '<link rel="icon" type="image/png" href="/assets/images/carousel/favicon.png"/>\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>\n' +
    '<link rel="stylesheet" href="/admin/admin.css"/>\n' +
    '<link rel="stylesheet" href="/platform/shell.css"/>\n' +
    page.css.map(h => '<link rel="stylesheet" href="' + h + '"/>\n').join('') +
    '</head>\n<body>\n<script>window.SOH_PAGE=' + JSON.stringify(meta).replace(/</g, '\\u003c') + ';</script>\n' +
    '<script src="/config.js"></script>\n<script src="/admin/admin.js"></script>\n' +
    page.scripts.map(src => '<script src="' + src + '"></script>\n').join('') +
    '<script src="/platform/session-check.js"></script>\n' +
    '</body>\n</html>\n';
}

function mount(app, opts) {
  const b2bEnabled = () => !!(opts && opts.b2bEnabled && opts.b2bEnabled());

  /* ── Background run for an outside cron service (404 unless CRON_SECRET is set) ── */
  require('./cron-route.js').mount(app);

  /* ── Logos: the one chosen for bills, and the pictures (public: they print on customers' bills) ── */
  require('./branding.js').mount(app);

  /* ── Single sign-in ── */
  app.get('/login', function (req, res) {
    noStore(res);
    res.sendFile(path.join(WEB, 'login.html'));
  });
  ['login.js', 'erp-host.js', 'erp-embed.css', 'bill-logo.js', 'shell.css', 'session-check.js'].forEach(function (f) {
    app.get('/platform/' + f, function (req, res) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(path.join(WEB, f));
    });
  });
  // The old staff sign-in page now points at the one sign-in.
  app.get(['/admin/index.html', '/admin/login', '/admin/login.html'], function (req, res) { res.redirect(302, '/login'); });

  /** The account stores that exist on this server, as sign-in sources. */
  function sources(req) {
    const ip = String(req.ip || '').slice(0, 45);
    const ctx = { ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) };
    const src = {
      staff: function (email, password) {
        const r = staffLogin(email, password);
        if (r.ok) {
          const st = require('../services/db.js').db.staff.findOne({ email: email });
          r.mustChangePassword = !!(st && st.mustChangePassword === true);
        }
        return r;
      },
      customer: customerLogin,
    };
    if (erpConfig.enabled()) {
      src.erp = async function (email, password, totp, opts) {
        const r = await require('../modules/erp/core/identity.js').login(email, password, totp, ctx, opts);
        try {   // salesmen also get the field-sales app (table from migration 010)
          r.isSalesman = !!(await require('../db/connection.js').queryOne('SELECT id FROM b2b_salesmen WHERE staff_id = ? AND is_active = 1', [r.staff.id]));
        } catch (e) { r.isSalesman = false; }
        try {   // so do delivery staff (their deliveries) and event staff (their counters)
          r.isFieldStaff = !!(await require('../db/connection.js').queryOne(
            'SELECT 1 AS ok FROM b2b_staff_roles sr JOIN b2b_roles ro ON ro.id = sr.role_id AND ro.is_active = 1 ' +
            'JOIN b2b_role_permissions rp ON rp.role_id = ro.id WHERE sr.staff_id = ? AND sr.revoked_at IS NULL ' +
            "AND rp.permission_code IN ('deliveries.update', 'events.sell') LIMIT 1", [r.staff.id]));
        } catch (e) { r.isFieldStaff = false; }
        try {   // only field roles (salesman, delivery, event staff): the field app alone, no admin panel to choose
          const roles = await require('../db/connection.js').query(
            'SELECT ro.code FROM b2b_staff_roles sr JOIN b2b_roles ro ON ro.id = sr.role_id AND ro.is_active = 1 WHERE sr.staff_id = ? AND sr.revoked_at IS NULL', [r.staff.id]);
          r.fieldOnly = roles.length > 0 && roles.every(function (x) { return FIELD_ROLES.indexOf(x.code) !== -1; });
        } catch (e) { r.fieldOnly = false; }
        return r;
      };
      src.supplier = function (email, password, opts) { return require('../modules/erp/vendors/service.js').login(email, password, ip, opts); };
      // Asked only after the shop password was accepted (auth.js erpNotice).
      src.erpHasAccount = async function (email) {
        return !!(await require('../db/connection.js').queryOne("SELECT id FROM b2b_staff WHERE email = ? AND status = 'active'", [email]));
      };
    }
    if (b2bEnabled()) {
      src.business = function (email, password, opts) {
        return require('../modules/b2b/accounts/service.js').login(email, password, null, ip, Object.assign({ anyRole: true }, opts));
      };
    }
    return src;
  }

  app.post('/api/platform/auth/login', function (req, res, next) {
    signIn(req.body || {}, sources(req)).then(function (r) {
      const admin = r.body.workspaces && r.body.workspaces.find(w => w.type === 'admin' && w.token);
      if (admin) {
        try { require('../services/db.js').db.events.insert({ type: 'admin_login', email: admin.user.email, ts: Date.now(), ip: req.ip, via: '/login' }); } catch (e) { /* best-effort, as /api/admin/login */ }
      }
      res.status(r.status).json(r.body);
    }).catch(next);
  });

  /**
   * Choose a new password (first sign-in with a temporary one, or any time):
   * changes it in every account store where the current password matches,
   * then signs in with the new one.
   */
  app.post('/api/platform/auth/change-password', function (req, res, next) {
    const b = req.body || {};
    const problem = newPasswordProblem(b.currentPassword, b.newPassword);
    if (!b.email || !b.currentPassword) return res.status(400).json({ error: 'Enter your e-mail and current password.' });
    if (problem) return res.status(400).json({ error: problem });
    require('./passwords.js').changeEverywhere(b, { mysql: b2bEnabled(), erp: erpConfig.enabled(), b2b: b2bEnabled(), ip: req.ip }).then(function (r) {
      if (!r.changed.length) {
        if (r.needCode) return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app.', code: 'mfa_required' });
        return res.status(401).json(GENERIC);
      }
      return signIn({ email: b.email, password: b.newPassword, totp: b.totp }, sources(req)).then(function (s) {
        res.status(s.status).json(Object.assign({ changed: r.changed }, s.body));
      });
    }).catch(next);
  });

  /**
   * Forgot password (business staff accounts). The answer is the same whether or not the account
   * exists, and is sent before the e-mail goes out, so neither the text nor the timing tells.
   */
  const { rateLimit } = require('express-rate-limit');
  const resetLimit = rateLimit({ windowMs: 15 * 60000, max: process.env.NODE_ENV === 'test' ? 1000 : 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait 15 minutes and try again.' } });
  const RESET_SENT = 'If a business staff account uses this e-mail, a link to choose a new password is on its way. It works once, for 30 minutes. Check spam if it does not arrive.';
  app.post('/api/platform/auth/forgot-password', resetLimit, function (req, res) {
    const email = String((req.body || {}).email || '').trim();
    res.json({ ok: true, message: RESET_SENT });
    if (!email || !erpConfig.enabled() || !require('../db/connection.js').isConfigured()) return;
    require('./password-reset.js').request(email, { ip: req.ip }).catch(function (e) { console.error('[password-reset] request failed:', e.message); });
  });
  app.post('/api/platform/auth/reset-password', resetLimit, function (req, res, next) {
    const b = req.body || {};
    const problem = newPasswordProblem('', b.newPassword);
    if (problem) return res.status(400).json({ error: problem });
    if (!erpConfig.enabled() || !require('../db/connection.js').isConfigured()) return res.status(400).json({ error: 'This reset link has expired or was already used. Ask for a new one.', code: 'bad_link' });
    require('./password-reset.js').complete(b.token, b.newPassword, { ip: req.ip }).then(function (r) {
      res.json({ ok: true, email: r.email });
    }).catch(function (e) {
      if (e.expose) return res.status(e.status || 400).json({ error: e.message, code: e.code });
      next(e);
    });
  });

  /* ── The one sidebar ── */
  /**
   * The sidebar. Staff session: Authorization: Bearer <token>. ERP session:
   * X-ERP-Token: <token> (its permissions are read live from MySQL, like every
   * ERP request). Either or both; at least one must be valid.
   */
  app.get('/api/platform/nav', async function (req, res, next) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const auth = req.headers['authorization'] || '';
      const staff = auth.startsWith('Bearer ') && staffConfigured() ? verifyStaffToken(auth.slice(7)) : null;
      const erpRaw = String(req.headers['x-erp-token'] || '');
      let erp = { enabled: erpConfig.enabled(), permissions: null }, erpStatus = 'none', erpUser = null;
      if (erpRaw && erp.enabled) {
        const payload = require('../modules/erp/core/security.js').verify(erpRaw);
        if (!payload) erpStatus = 'invalid';
        else {
          try {
            const p = await require('../modules/erp/core/identity.js').principal(payload);
            if (p) { erp.permissions = p.permissions; erpStatus = 'ok'; erpUser = { name: p.name, email: p.email, roles: p.roles, mfa: p.mfa }; }
            else erpStatus = 'ended';
          } catch (e) { erpStatus = 'unavailable'; }
        }
      } else if (erpRaw) erpStatus = 'invalid';

      if (!staff && erpStatus !== 'ok') {
        if (erpStatus === 'unavailable') return res.status(503).json({ error: 'The business platform database is not available right now.' });
        return res.status(401).json({ error: 'Unauthorized — please log in again' });
      }
      const nav = registry.navFor(staff ? staff.role : null, b2bEnabled(), erp);
      const user = staff ? { name: staff.name, email: staff.email, role: staff.role } : { name: erpUser.name, email: erpUser.email, role: null };
      // A shop session without the business part, for someone who HAS a business account (e.g. the
      // 6-digit code was skipped at sign-in): the shell tells them to sign in again to open it.
      let erpSignInNeeded = false;
      if (staff && erpStatus !== 'ok' && erp.enabled && staff.email) {
        try {
          erpSignInNeeded = !!(await require('../db/connection.js').queryOne("SELECT id FROM b2b_staff WHERE email = ? AND status = 'active'", [String(staff.email).toLowerCase()]));
        } catch (e) { erpSignInNeeded = false; }
      }
      res.json(Object.assign({ user, erp: erpStatus, erpUser, erpSignInNeeded }, nav));
    } catch (e) { next(e); }
  });

  /* ── Shell pages ── */
  app.get(['/admin', '/admin/'], function (req, res) {
    noStore(res);
    res.sendFile(path.join(WEB, 'home.html'));
  });
  app.get('/admin/:group/:page', function (req, res, next) {
    const page = registry.byPath.get('/admin/' + req.params.group + '/' + req.params.page);
    if (!page) return next();                                   // old .html files, b2b/*, erp, … are not shell pages
    if (page.module === 'b2b' && !b2bEnabled()) return res.status(404).type('text/plain').send('Not found');
    if (page.module === 'erp' && !erpConfig.enabled()) return res.status(404).type('text/plain').send('Not found');
    noStore(res);
    res.type('html').send(pageHtml(page));
  });
  // Unknown /admin/<group>/<page> addresses that are not real files answer 404.
  app.get('/admin/:group/:page', function (req, res, next) {
    if (/\.[a-z0-9]+$/i.test(req.params.page)) return next();
    const group = registry.GROUPS.some(g => g.id === req.params.group);
    if (group || !fs.existsSync(path.join(__dirname, '..', '..', 'frontend', 'admin', req.params.group))) {
      return res.status(404).type('text/plain').send('Not found');
    }
    next();
  });
}

module.exports = { mount, pageHtml };
