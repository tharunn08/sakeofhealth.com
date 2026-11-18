/**
 * MSG91 SMS (Flow API, DLT-registered templates). India requires every SMS to use a
 * DLT-approved template, so only TEMPLATED messages are sent: a queue row must carry
 * template_name (e.g. "order_otp") and template_params_json; the template id comes from
 * MSG91_TEMPLATE_<NAME> (e.g. MSG91_TEMPLATE_ORDER_OTP).
 *
 * Env: MSG91_AUTH_KEY, MSG91_TEMPLATE_<NAME>, optional MSG91_BASE_URL (tests), MSG91_WEBHOOK_TOKEN (delivery reports).
 * Nothing is sent unless MSG91_AUTH_KEY and the template id are set.
 */
'use strict';
function templateId(name) {
  // 'dlt:<id>' carries the DLT template id itself (templates recorded in the notification center)
  if (/^dlt:[A-Za-z0-9_-]{4,60}$/.test(String(name || ''))) return String(name).slice(4);
  return process.env['MSG91_TEMPLATE_' + String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')] || '';
}
function configured(name) { return !!(process.env.MSG91_AUTH_KEY && (name ? templateId(name) : true)); }

async function sendTemplate(mobile, name, params) {
  const tid = templateId(name);
  if (!process.env.MSG91_AUTH_KEY || !tid) return { ok: false, noProvider: true, reason: 'no SMS gateway configured for template ' + name };
  const to = String(mobile).replace(/\D/g, '');
  const msisdn = to.length === 10 ? '91' + to : to;
  if (!/^91[6-9]\d{9}$/.test(msisdn)) return { ok: false, reason: 'invalid Indian mobile' };
  const base = (process.env.MSG91_BASE_URL || 'https://control.msg91.com').replace(/\/$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 10000);
  try {
    const res = await fetch(base + '/api/v5/flow/', {
      method: 'POST', signal: ctl.signal,
      headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ template_id: tid, short_url: '0', recipients: [Object.assign({ mobiles: msisdn }, params || {})] }),
    });
    const j = await res.json().catch(function () { return {}; });
    if (!res.ok || j.type !== 'success') return { ok: false, reason: 'msg91: ' + String(j.message || res.status).slice(0, 200) };
    return { ok: true, providerMessageId: String(j.message || j.request_id || '').slice(0, 120) || null };
  } catch (e) {
    return { ok: false, reason: 'msg91 unreachable: ' + (e.name === 'AbortError' ? 'timeout' : e.message) };
  } finally { clearTimeout(timer); }
}

/** Delivery report → 'delivered' | 'failed' | 'sent'. MSG91 sends text or numeric codes. */
function mapStatus(s) {
  const t = String(s == null ? '' : s).toLowerCase();
  if (t === '1' || /deliver/.test(t)) return 'delivered';
  if (/fail|reject|ndnc|block|invalid|expired|undeliv/.test(t) || ['2', '9', '16', '17', '25', '26'].indexOf(t) !== -1) return 'failed';
  return 'sent';
}
function reports(body) {
  const list = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : (body ? [body] : []));
  const out = [];
  list.forEach(function (r) {
    if (!r || typeof r !== 'object') return;
    const id = r.requestId || r.request_id || r.requestID;
    const st = r.status != null ? r.status : (r.desc || r.description);
    if (id && st != null) out.push({ id: String(id).slice(0, 120), status: mapStatus(st), raw: String(st).slice(0, 40) });
    (Array.isArray(r.report) ? r.report : []).forEach(function (x) { if (id && x && x.status != null) out.push({ id: String(id).slice(0, 120), status: mapStatus(x.status), raw: String(x.status).slice(0, 40) }); });
  });
  return out;
}

module.exports = { sendTemplate, configured, templateId, mapStatus, reports };
