/**
 * One sign-in for every account type (POST /api/platform/auth/login).
 *
 * Account stores (until they are merged by a later identity migration):
 *   staff     — shop/trade staff (staff.json; adminAuth)
 *   customer  — shop customers (customerAuth)
 *   erp       — ERP staff (MySQL b2b_staff; may need a 6-digit code); salesmen also get the field-sales app
 *   business  — retailers / distributors (MySQL b2b_users)
 *   supplier  — suppliers / manufacturers (MySQL b2b_vendor_users)
 * One e-mail + password is checked against each ON THE SERVER; the result is the
 * set of workspaces it opens. Staff + ERP sessions of one person form ONE admin
 * workspace (one panel, one sidebar).
 *
 * Lockout: every MySQL store is first checked WITHOUT counting a failure. Only
 * when no store at all accepted the password is it checked again WITH counting,
 * so a password that is right for one of the person's accounts never locks
 * another, while a wrong-everywhere attempt counts everywhere as before. A wrong
 * 6-digit code after a correct ERP password is always counted (identity.js).
 *
 * Temporary passwords: if any opened account must change its password, the
 * response says so (mustChangePassword) and the servers refuse everything else
 * until it is changed (POST /api/platform/auth/change-password).
 */
'use strict';

const GENERIC = { error: 'Incorrect e-mail or password.' };
const ASYNC = ['erp', 'business', 'supplier'];

/** Classify an error from a MySQL-backed login. */
function outcome(e) {
  if (e && e.code === 'mfa_required') return 'needCode';
  if (e && (e.code === 'locked' || e.status === 423 || e.status === 429)) return 'locked';
  if (!e || !e.status || e.status >= 500 || (e.expose === false)) return 'unavailable';
  if (e.status === 403) return 'disabled';
  return 'wrong';
}

/**
 * @param {{email:string, password:string, totp?:string}} input
 * @param {{staff:Function, customer:Function, erp?:Function, business?:Function, supplier?:Function}} sources
 *   staff/customer(email, password) → {ok, token, user, mustChangePassword?} | {ok:false, unavailable?}
 *   erp(email, password, totp, {countFailure}) → Promise<{token, staff, mustChangePassword, isSalesman, isFieldStaff, fieldOnly}>
 *   business(email, password, {countFailure}) → Promise<{token, user, accountStatus, mustChangePassword}>
 *   supplier(email, password, {countFailure}) → Promise<{token, user, vendorStatus, mustChangePassword}>
 *   (MySQL sources throw {status, code, expose} on failure)
 */
/**
 * The admin panel opened without the business (ERP) part: say why, so the business pages are never
 * missing without a reason. A wrong password is mentioned only when the shop password was accepted
 * and this e-mail really has a business account (a stranger learns nothing).
 */
async function erpNotice(email, staff, r, sources) {
  if (!r || r.ok || r.kind === 'needCode' || !staff.ok) return null;
  const lead = 'Signed in, but the business (ERP) pages were not opened: ';
  if (r.kind === 'locked') return lead + (r.message || 'the business account is locked after too many failed attempts.');
  if (r.kind === 'disabled') return lead + 'the business account is disabled.';
  if (r.kind === 'unavailable') return lead + 'the business database could not be reached. Try again in a few minutes.';
  if (r.kind === 'wrong' && typeof sources.erpHasAccount === 'function') {
    let has = false;
    try { has = await sources.erpHasAccount(email); } catch (e) { has = false; }
    if (has) return lead + 'your business account uses a different password. Sign in with that password to open the business pages.';
  }
  return null;
}

async function signIn(input, sources) {
  const email = String((input && input.email) || '').trim().toLowerCase();
  const password = String((input && input.password) || '');
  const totp = input && input.totp ? String(input.totp).trim() : undefined;
  if (!email || !password) return { status: 400, body: { error: 'Enter your e-mail and password.' } };

  const staff = sources.staff(email, password) || {};
  const customer = sources.customer(email, password) || {};
  const call = (k, count) => k === 'erp' ? sources.erp(email, password, totp, { countFailure: count }) : sources[k](email, password, { countFailure: count });

  const res = {};                                          // k → {ok, value} | {ok:false, kind, message}
  const present = ASYNC.filter(k => typeof sources[k] === 'function');
  for (const k of present) {
    try { res[k] = { ok: true, value: await call(k, false) }; }
    catch (e) { res[k] = { ok: false, kind: outcome(e), message: e && e.message }; }
  }
  const anyOk = staff.ok || customer.ok || present.some(k => res[k].ok || res[k].kind === 'needCode');
  if (!anyOk) {                                            // wrong everywhere: count it where it applies
    for (const k of present) {
      if (res[k].kind !== 'wrong') continue;
      try { await call(k, true); } catch (e) { const o = outcome(e); if (o === 'locked') res[k] = { ok: false, kind: o, message: e.message }; }
    }
  }

  const erp = res.erp && res.erp.ok ? res.erp.value : null;
  const workspaces = [];
  // Salesmen, delivery and event staff with nothing else: straight to the field app, no admin panel to choose
  const fieldOnly = !!(erp && erp.fieldOnly && (erp.isSalesman || erp.isFieldStaff) && !staff.ok);
  if (staff.ok || (erp && !fieldOnly)) {
    workspaces.push({
      type: 'admin', label: 'Admin panel', home: '/admin',
      token: staff.ok ? staff.token : null, erpToken: erp ? erp.token : null,
      user: staff.ok ? staff.user : { name: erp.staff.name, email: erp.staff.email, role: null },
      mustChangePassword: !!((staff.ok && staff.mustChangePassword) || (erp && erp.mustChangePassword)),
    });
  }
  // The field app on the phone: salesmen, delivery staff and event staff.
  if (erp && (erp.isSalesman || erp.isFieldStaff)) {
    workspaces.push({ type: 'sales', label: erp.isSalesman ? 'Field sales app' : 'Delivery & event app', home: '/sales-app/', token: erp.token, mustChangePassword: !!erp.mustChangePassword });
  }
  if (res.business && res.business.ok) {
    const b = res.business.value;
    workspaces.push({ type: 'business', label: 'Business portal (' + (b.user && b.user.role) + ')', home: '/b2b/dashboard', token: b.token, user: b.user, mustChangePassword: !!b.mustChangePassword });
  }
  if (res.supplier && res.supplier.ok) {
    const v = res.supplier.value;
    workspaces.push({ type: 'supplier', label: 'Supplier portal', home: '/vendor-portal/', token: v.token, user: v.user, mustChangePassword: !!v.mustChangePassword });
  }
  if (customer.ok) workspaces.push({ type: 'customer', label: 'My account (shop)', home: '/account.html', token: customer.token, user: customer.user });

  const kinds = k => present.filter(x => !res[x].ok && res[x].kind === k);
  if (workspaces.length) {
    const body = { workspaces };
    if (workspaces.some(w => w.mustChangePassword)) body.mustChangePassword = true;
    if (kinds('needCode').includes('erp') && !erp) body.erpNeedsCode = true;
    if (kinds('unavailable').length) body.erpUnavailable = true;
    const notice = await erpNotice(email, staff, res.erp, sources);
    if (notice && !body.erpNeedsCode) body.erpNotice = notice;
    return { status: 200, body };
  }
  if (kinds('needCode').length) return { status: 401, body: { error: 'Enter the 6-digit code from your authenticator app.', code: 'mfa_required' } };
  const locked = kinds('locked');
  if (locked.length) return { status: 423, body: { error: res[locked[0]].message || 'Too many failed attempts. Please try again later.', code: 'locked' } };
  const disabled = kinds('disabled');
  if (disabled.length) return { status: 403, body: { error: res[disabled[0]].message || 'This login has been disabled. Please contact support.' } };
  const unavailable = (staff.unavailable ? 1 : 0) + (customer.unavailable ? 1 : 0) + kinds('unavailable').length;
  if (unavailable === 2 + present.length) return { status: 503, body: { error: 'Sign-in is temporarily unavailable. Please try again later.' } };
  return { status: 401, body: GENERIC };
}

/** New-password rule shared by every store (the strictest existing one: ERP's 12 characters). */
function newPasswordProblem(current, next) {
  const n = String(next || '');
  if (n.length < 12) return 'Choose a password of at least 12 characters.';
  if (n === String(current || '')) return 'Choose a new password, different from the temporary one.';
  if (!/[A-Za-z]/.test(n) || !/[0-9]/.test(n)) return 'Use letters and at least one number.';
  return null;
}

module.exports = { signIn, outcome, newPasswordProblem, GENERIC };
