/**
 * Local stand-ins for the message providers, so tests exercise the real sending code
 * without reaching the internet:
 *   - fakeSmtp(): a minimal SMTP server (EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA) that
 *     records every accepted message; `refuse: true` answers 550 to RCPT.
 *   - fakeMsg91(): an HTTP server answering the MSG91 Flow API (set MSG91_BASE_URL to it).
 *   - fakeMeta(): replaces global fetch for graph.facebook.com only and records requests.
 */
'use strict';
const net = require('net');
const http = require('http');

function fakeSmtp(opts) {
  opts = opts || {};
  const mails = [];
  const server = net.createServer(function (sock) {
    let mode = 'cmd', data = '', cur = { from: null, to: [] }, buf = '';
    const say = function (l) { sock.write(l + '\r\n'); };
    say('220 fake-smtp ready');
    sock.on('data', function (chunk) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (line === '.') { mode = 'cmd'; mails.push({ from: cur.from, to: cur.to.slice(), data: data }); say('250 2.0.0 Ok: queued as FAKE' + mails.length); cur = { from: null, to: [] }; data = ''; }
          else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        if (mode === 'auth-user') { mode = 'auth-pass'; say('334 UGFzc3dvcmQ6'); continue; }
        if (mode === 'auth-pass') { mode = 'cmd'; say('235 2.7.0 Authentication successful'); continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') { say('250-fake-smtp'); say('250-AUTH PLAIN LOGIN'); say('250 8BITMIME'); }
        else if (cmd === 'HELO') say('250 fake-smtp');
        else if (cmd === 'AUTH') { if (/LOGIN/i.test(line)) { mode = 'auth-user'; say('334 VXNlcm5hbWU6'); } else say('235 2.7.0 Authentication successful'); }
        else if (cmd === 'MAIL') { cur.from = line; say('250 2.1.0 Ok'); }
        else if (cmd === 'RCPT') { if (opts.refuse) say('550 5.1.1 Recipient address rejected'); else { cur.to.push(line); say('250 2.1.5 Ok'); } }
        else if (cmd === 'DATA') { mode = 'data'; say('354 End data with <CR><LF>.<CR><LF>'); }
        else if (cmd === 'RSET') { cur = { from: null, to: [] }; say('250 Ok'); }
        else if (cmd === 'QUIT') { say('221 Bye'); sock.end(); }
        else say('250 Ok');
      }
    });
    sock.on('error', function () { /* client went away */ });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ port: server.address().port, mails: mails, close: function () { return new Promise(function (r) { server.close(function () { r(); }); }); } });
    });
  });
}

function fakeMsg91(opts) {
  opts = opts || {};
  const calls = [];
  const server = http.createServer(function (req, res) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      let j = {}; try { j = JSON.parse(body); } catch (e) { j = {}; }
      calls.push({ path: req.url, authkey: req.headers.authkey, body: j });
      res.setHeader('Content-Type', 'application/json');
      if (opts.fail) { res.statusCode = 400; return res.end(JSON.stringify({ type: 'error', message: 'fake MSG91 refused' })); }
      res.end(JSON.stringify({ type: 'success', message: 'REQ' + calls.length }));
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ url: 'http://127.0.0.1:' + server.address().port, calls: calls, close: function () { return new Promise(function (r) { server.close(function () { r(); }); }); } });
    });
  });
}

/** Intercept fetch() to graph.facebook.com; everything else goes to the real fetch. */
function fakeMeta(opts) {
  opts = opts || {};
  const calls = [];
  const real = global.fetch;
  global.fetch = async function (url, init) {
    if (String(url).indexOf('https://graph.facebook.com/') !== 0) return real(url, init);
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), auth: init && init.headers && init.headers.Authorization, body: body });
    const answer = typeof opts.answer === 'function' ? opts.answer(body) : null;
    if (answer && answer.error) return new Response(JSON.stringify({ error: answer.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ wa_id: body && body.to }], messages: [{ id: 'wamid.FAKE' + calls.length }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls: calls, restore: function () { global.fetch = real; } };
}

module.exports = { fakeSmtp, fakeMsg91, fakeMeta };
