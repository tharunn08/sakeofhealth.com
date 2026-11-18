/**
 * Notifications — Email (SMTP via nodemailer) + WhatsApp (Meta Cloud API or Twilio).
 * All providers are optional. If credentials are absent the message is logged
 * to console and recorded, so the app never breaks in dev/testing.
 */
const { db } = require('./db.js');

const BRAND = process.env.BRAND_NAME || 'Sake of Health';
const SITE = process.env.SITE_URL || 'http://localhost:3000';

// Extra staff emails that should receive new-order alerts, managed from the
// admin panel and stored in settings under the key "notifyEmails".
function getStaffNotifyEmails() {
  try {
    const row = db.settings.findOne({ key: 'notifyEmails' });
    return row && Array.isArray(row.value) ? row.value : [];
  } catch (e) {
    return [];
  }
}

/* ─────────────────────────── EMAIL ─────────────────────────── */

let transporter = null;
function getTransporter() {
  if (transporter !== null) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) { transporter = false; return false; }
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return transporter;
  } catch (e) {
    console.warn('[NOTIFY] nodemailer unavailable:', e.message);
    transporter = false;
    return false;
  }
}

// Verify the SMTP connection and credentials. Returns a plain diagnostic object
// so the admin Settings page can show exactly why email isn't sending.
async function verifyEmail() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    return {
      ok: false,
      configured: false,
      reason: 'SMTP is not configured. Add SMTP_HOST, SMTP_USER and SMTP_PASS to your .env file. ' +
        'Until then, emails are logged to the server console instead of being sent.',
    };
  }
  const t = getTransporter();
  if (!t) return { ok: false, configured: true, reason: 'Email library could not be initialised.' };
  try {
    await t.verify();
    return { ok: true, configured: true, reason: 'SMTP connection verified. Email is ready to send.' };
  } catch (e) {
    return {
      ok: false,
      configured: true,
      reason: 'SMTP connection failed: ' + e.message +
        '. For Gmail, make sure you are using a 16-character App Password, not your normal password.',
    };
  }
}

async function sendEmail(to, subject, html, text) {
  if (!to) return { ok: false, reason: 'no recipient' };
  const t = getTransporter();
  if (!t) {
    console.log('\n[EMAIL:MOCK] To: ' + to + '\n  Subject: ' + subject + '\n');
    return { ok: true, mock: true };
  }
  try {
    const info = await t.sendMail({
      from: process.env.SMTP_FROM || (BRAND + ' <' + process.env.SMTP_USER + '>'),
      to, subject, html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
    return { ok: true, id: info.messageId };
  } catch (e) {
    console.error('[EMAIL] send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

/* ─────────────────────────── WHATSAPP ─────────────────────────── */

function normalisePhone(phone) {
  let p = String(phone || '').replace(/[^\d]/g, '');
  if (p.length === 10) p = (process.env.DEFAULT_COUNTRY_CODE || '91') + p;
  return p;
}

// Turn Meta's raw error JSON into a short, actionable sentence so the admin
// Settings page and the server logs explain *why* WhatsApp didn't send.
function explainMetaError(data) {
  const err = (data && data.error) || {};
  const code = err.code;
  const sub = err.error_subcode;
  const msg = err.message || 'Unknown WhatsApp error';

  if (code === 190) {
    return 'WhatsApp access token is invalid or expired. The token in WHATSAPP_TOKEN is a temporary one that ' +
      'expires ~24h after you generate it. Create a permanent System-User token in Meta Business Settings and ' +
      'put it in WHATSAPP_TOKEN. (Meta: ' + msg + ')';
  }
  if (code === 131047 || sub === 131047) {
    return 'Meta blocked a free-form message because more than 24h passed since the customer last messaged you ' +
      '(the "re-engagement" rule). Business-initiated order messages must use an APPROVED TEMPLATE. Set ' +
      'WHATSAPP_ORDER_TEMPLATE / WHATSAPP_STATUS_TEMPLATE to your approved template names. (Meta: ' + msg + ')';
  }
  if (code === 131030) {
    return 'This recipient number is not in your allowed list. While your WhatsApp number is in TEST mode, you ' +
      'can only message numbers you have added as recipients in the Meta dashboard. Add the number, or move the ' +
      'app to Live. (Meta: ' + msg + ')';
  }
  if (code === 132000 || code === 132001 || code === 132005 || code === 132007 || code === 132012 || code === 132015) {
    return 'WhatsApp template problem: the template name/language does not exist or is not approved. Check the ' +
      'template exists and is APPROVED in Meta, and that WHATSAPP_TEMPLATE_LANG matches its language. (Meta: ' + msg + ')';
  }
  if (code === 100) {
    return 'Meta rejected the request parameters (often a wrong WHATSAPP_PHONE_NUMBER_ID or malformed number). ' +
      '(Meta: ' + msg + ')';
  }
  return 'WhatsApp send failed. ' + msg + (code ? ' [code ' + code + ']' : '');
}

// Free-form text send. Only works inside the 24h customer-initiated window.
async function metaSendText(phone, message) {
  const url = 'https://graph.facebook.com/v20.0/' + process.env.WHATSAPP_PHONE_NUMBER_ID + '/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { preview_url: false, body: message },
    }),
  });
  const data = await res.json();
  if (!res.ok) { const e = new Error(explainMetaError(data)); e.meta = data; throw e; }
  return data;
}

// Template send — the correct path for business-initiated order messages.
// `params` fills the body {{1}}, {{2}}… in order. Pass an approved template name.
async function metaSendTemplate(phone, templateName, params) {
  const url = 'https://graph.facebook.com/v20.0/' + process.env.WHATSAPP_PHONE_NUMBER_ID + '/messages';
  const components = (params && params.length)
    ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
    : [];
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en_US' },
        components: components,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) { const e = new Error(explainMetaError(data)); e.meta = data; throw e; }
  return data;
}

async function sendWhatsAppTwilio(phone, message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';
  const body = new URLSearchParams({
    From: 'whatsapp:' + process.env.TWILIO_WHATSAPP_FROM,
    To: 'whatsapp:+' + phone,
    Body: message,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'twilio failed');
  return data;
}

/**
 * Send a WhatsApp message.
 * @param {string} phone
 * @param {string} message  Plain text (used for Twilio + the 24h free-form window).
 * @param {object} [opts]
 *   opts.templateName  Approved Meta template to use (business-initiated messages).
 *   opts.templateParams Array filling the template body {{1}}, {{2}}…
 * When a template is given, Meta uses it. If no template is configured, Meta
 * falls back to free-form text (which only reaches users inside the 24h window).
 */
async function sendWhatsApp(phone, message, opts) {
  opts = opts || {};
  const to = normalisePhone(phone);
  if (!to) return { ok: false, reason: 'no phone number on this order' };
  try {
    if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
      if (opts.templateName) {
        await metaSendTemplate(to, opts.templateName, opts.templateParams || []);
        return { ok: true, provider: 'meta', mode: 'template' };
      }
      await metaSendText(to, message);
      return { ok: true, provider: 'meta', mode: 'text' };
    }
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      await sendWhatsAppTwilio(to, message);
      return { ok: true, provider: 'twilio' };
    }
    console.log('\n[WHATSAPP:MOCK] To: +' + to + '\n  ' + message.split('\n')[0] +
      '\n  (No WhatsApp provider configured — set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID, or Twilio keys.)\n');
    return { ok: true, mock: true, reason: 'No WhatsApp provider configured — message logged only.' };
  } catch (e) {
    console.error('[WHATSAPP] send failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

/* ─────────────────────────── TEMPLATES ─────────────────────────── */

const money = n => '₹' + Number(n || 0).toLocaleString('en-IN');

const STATUS_COPY = {
  pending:    { label: 'Order Received',   msg: 'We have received your order and are awaiting confirmation.' },
  accepted:   { label: 'Order Accepted',   msg: 'Good news! Your order has been accepted and will be prepared shortly.' },
  prepared:   { label: 'Order Prepared',   msg: 'Your order has been packed and is ready to leave our facility.' },
  out_for_delivery: { label: 'Out for Delivery', msg: 'Your order is on its way! Our delivery partner will reach you soon.' },
  delivered:  { label: 'Order Delivered',  msg: 'Your order has been delivered. Thank you for choosing us!' },
  cancelled:  { label: 'Order Cancelled',  msg: 'Your order has been cancelled. Any payment made will be refunded within 5–7 business days.' },
};

function orderEmailHTML(order, heading, body) {
  const items = order.items.map(i =>
    '<tr><td style="padding:10px 0;border-bottom:1px solid #eee;">' + i.name +
    ' <span style="color:#888;">× ' + (i.qty || 1) + '</span></td>' +
    '<td align="right" style="padding:10px 0;border-bottom:1px solid #eee;">' + money(i.price * (i.qty || 1)) + '</td></tr>'
  ).join('');

  const addr = order.address || {};
  const addrLines = [addr.doorNo, addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8f4ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f4ee;padding:32px 12px;">
<tr><td align="center">
<table width="100%" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.06);">
  <tr><td style="background:#2f5d1f;padding:28px 32px;">
    <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:.3px;">${BRAND}</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <h1 style="margin:0 0 8px;font-size:22px;color:#1f3d14;">${heading}</h1>
    <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">${body}</p>

    <div style="background:#f4f8ef;border-radius:12px;padding:16px 18px;margin-bottom:24px;">
      <div style="font-size:12px;color:#6b7f5a;text-transform:uppercase;letter-spacing:.6px;">Order ID</div>
      <div style="font-size:18px;font-weight:700;color:#2f5d1f;font-family:monospace;">${order.orderId}</div>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#333;">
      ${items}
      <tr><td style="padding:10px 0;color:#666;">Subtotal</td><td align="right" style="padding:10px 0;">${money(order.subtotal)}</td></tr>
      ${order.discount ? '<tr><td style="padding:4px 0;color:#2f5d1f;">Discount' + (order.couponCode ? ' (' + order.couponCode + ')' : '') + '</td><td align="right" style="padding:4px 0;color:#2f5d1f;">− ' + money(order.discount) + '</td></tr>' : ''}
      <tr><td style="padding:4px 0;color:#666;">Delivery</td><td align="right" style="padding:4px 0;">${order.shipping ? money(order.shipping) : 'Free'}</td></tr>
      <tr><td style="padding:14px 0 0;font-size:16px;font-weight:700;border-top:2px solid #2f5d1f;">Total</td>
          <td align="right" style="padding:14px 0 0;font-size:16px;font-weight:700;border-top:2px solid #2f5d1f;">${money(order.total)}</td></tr>
    </table>

    <div style="margin-top:28px;padding-top:24px;border-top:1px solid #eee;">
      <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px;">Delivering to</div>
      <div style="font-size:14px;color:#333;line-height:1.6;">
        <strong>${order.customer.name}</strong><br/>${addrLines}<br/>${order.customer.phone}
      </div>
    </div>

    <div style="text-align:center;margin-top:32px;">
      <a href="${SITE}/track.html?orderId=${encodeURIComponent(order.orderId)}"
         style="display:inline-block;background:#2f5d1f;color:#fff;text-decoration:none;padding:14px 32px;border-radius:999px;font-weight:600;font-size:15px;">
         Track Your Order
      </a>
    </div>
  </td></tr>
  <tr><td style="background:#f4f8ef;padding:20px 32px;text-align:center;color:#7a8b6c;font-size:12px;">
    Questions? Reply to this email — we're here to help.<br/>© ${new Date().getFullYear()} ${BRAND}
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

function orderWhatsAppText(order, heading, body) {
  const lines = [
    '*' + BRAND + '*',
    '',
    '*' + heading + '*',
    body,
    '',
    'Order ID: *' + order.orderId + '*',
    'Items: ' + order.items.reduce((s, i) => s + (i.qty || 1), 0),
    'Total: ' + money(order.total),
    '',
    'Track your order:',
    SITE + '/track.html?orderId=' + encodeURIComponent(order.orderId),
  ];
  return lines.join('\n');
}

/* ─────────────────────────── PUBLIC API ─────────────────────────── */

async function notifyOrderPlaced(order) {
  const heading = 'Thank you for your order!';
  const body = 'We\'ve received your order and will begin preparing it right away. You\'ll get an update at every step.';
  const results = await Promise.allSettled([
    sendEmail(order.customer.email, 'Order Confirmed — ' + order.orderId + ' | ' + BRAND,
      orderEmailHTML(order, heading, body)),
    sendWhatsApp(order.customer.phone, orderWhatsAppText(order, heading, body), {
      // Business-initiated message → uses an approved template if one is set.
      // Suggested template body (4 vars):
      //   "Hi {{1}}, thanks for your order! Your order {{2}} totalling {{3}} has been received. Track it here: {{4}}"
      templateName: process.env.WHATSAPP_ORDER_TEMPLATE,
      templateParams: [
        order.customer.name,
        order.orderId,
        money(order.total),
        SITE + '/track.html?orderId=' + encodeURIComponent(order.orderId),
      ],
    }),
  ]);
  logNotification(order.orderId, 'order_placed', results);

  // Notify the team: ADMIN_EMAIL (from .env) plus any staff emails added in
  // the admin panel (Settings → Staff Order Notifications). De-duplicated.
  const staffEmails = getStaffNotifyEmails();
  const teamRecipients = [];
  const seen = {};
  [process.env.ADMIN_EMAIL].concat(staffEmails).forEach(function (e) {
    const addr = String(e || '').trim().toLowerCase();
    if (addr && !seen[addr]) { seen[addr] = true; teamRecipients.push(addr); }
  });

  if (teamRecipients.length) {
    const subject = '🔔 New Order ' + order.orderId + ' — ' + money(order.total);
    const html = orderEmailHTML(order, 'New order received', 'A new order was placed on your store.');
    await Promise.allSettled(teamRecipients.map(function (addr) {
      return sendEmail(addr, subject, html);
    }));
  }
  return results;
}

async function notifyStatusChange(order, status) {
  const copy = STATUS_COPY[status] || { label: 'Order Update', msg: 'Your order status has been updated.' };
  const results = await Promise.allSettled([
    sendEmail(order.customer.email, copy.label + ' — ' + order.orderId + ' | ' + BRAND,
      orderEmailHTML(order, copy.label, copy.msg)),
    sendWhatsApp(order.customer.phone, orderWhatsAppText(order, copy.label, copy.msg), {
      // Suggested template body (4 vars):
      //   "Hi {{1}}, update on your order {{2}}: {{3}}. Track it here: {{4}}"
      templateName: process.env.WHATSAPP_STATUS_TEMPLATE,
      templateParams: [
        order.customer.name,
        order.orderId,
        copy.label,
        SITE + '/track.html?orderId=' + encodeURIComponent(order.orderId),
      ],
    }),
  ]);
  logNotification(order.orderId, 'status_' + status, results);
  return results;
}

function logNotification(orderId, type, results) {
  const summary = results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, reason: String(r.reason) });
  db.events.insert({
    type: 'notification',
    orderId,
    kind: type,
    email: summary[0],
    whatsapp: summary[1],
    ts: Date.now(),
  });
}

module.exports = { sendEmail, sendWhatsApp, verifyEmail, notifyOrderPlaced, notifyStatusChange, STATUS_COPY };
