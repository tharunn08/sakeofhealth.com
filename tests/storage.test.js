/**
 * Persistent file storage (src/platform/storage.js) and the document upload library that uses it.
 *  - AWS Signature V4: AWS's published example values (IAM ListUsers, 20150830; signing key 20120215).
 *  - S3 provider against a local fake S3 server: request shape, the signature covers what was sent, errors.
 *  - Local provider: atomic write, 0600 files, send with headers only when the file exists, traversal refused.
 *  - uploads.withDocument: the file is stored before the transaction and removed when it fails.
 * No network: the fake server listens on 127.0.0.1.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');

const PRIV = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-storage-priv-'));
process.env.B2B_PRIVATE_DIR = PRIV;
delete process.env.STORAGE_PROVIDER;
const storage = require('../src/platform/storage.js');
const uploads = require('../src/modules/b2b/lib/uploads.js');
const b2bConfig = require('../src/modules/b2b/config.js');

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const name = (ext) => crypto.randomBytes(16).toString('hex') + '.' + (ext || 'pdf');

function withEnv(vars, fn) {
  const old = {};
  Object.keys(vars).forEach(function (k) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; });
  return Promise.resolve().then(fn).finally(function () {
    Object.keys(old).forEach(function (k) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; });
  });
}

/* ── AWS Signature V4 ─────────────────────────────────────────────────── */

test('SigV4 signing key matches the AWS documentation example (20120215, us-east-1, iam)', function () {
  const k = storage.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
  assert.equal(k.toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
});

test('SigV4 request signature matches the AWS example (IAM ListUsers, 20150830T123600Z)', function () {
  const s = storage.sign({
    method: 'GET', host: 'iam.amazonaws.com', path: '/', query: { Action: 'ListUsers', Version: '2010-05-08' },
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'x-amz-date': '20150830T123600Z' },
    payloadHash: sha(''), region: 'us-east-1', service: 'iam',
    accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z',
  });
  assert.equal(storage.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam').toString('hex'),
    'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  assert.equal(sha(s.canonicalRequest), 'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
  assert.equal(s.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.equal(s.signedHeaders, 'content-type;host;x-amz-date');
  assert.equal(s.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

test('SigV4 URI encoding follows RFC 3986 (keeps / in object keys only when asked)', function () {
  assert.equal(storage.uriEncode("a b!'()*~._-"), "a%20b%21%27%28%29%2A~._-");
  assert.equal(storage.uriEncode('documents/x.pdf', true), 'documents/x.pdf');
  assert.equal(storage.uriEncode('documents/x.pdf'), 'documents%2Fx.pdf');
});

/* ── S3 provider against a fake S3 server ─────────────────────────────── */

function fakeS3(opts) {
  opts = opts || {};
  const objects = new Map();
  const requests = [];
  const server = http.createServer(function (req, res) {
    const chunks = [];
    req.on('data', function (d) { chunks.push(d); });
    req.on('end', function () {
      const body = Buffer.concat(chunks);
      const auth = String(req.headers.authorization || '');
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body, auth: m });
      const reject = function (code) { res.writeHead(403, { 'Content-Type': 'application/xml' }); res.end('<Error><Code>' + code + '</Code></Error>'); };
      if (!m || m[1] !== 'TESTKEYID') return reject('InvalidAccessKeyId');
      if (req.headers['x-amz-content-sha256'] !== sha(body)) return reject('XAmzContentSHA256Mismatch');
      // Re-sign exactly what arrived, with the secret the server knows: proves the client signed what it sent.
      const signed = {};
      m[4].split(';').forEach(function (h) { if (h !== 'host') signed[h] = req.headers[h]; });
      const again = storage.sign({ method: req.method, host: req.headers.host, path: req.url, query: {}, headers: signed, payloadHash: req.headers['x-amz-content-sha256'],
        region: m[3], service: 's3', accessKey: m[1], secretKey: opts.secret || 'test-secret-key-for-fake-s3', amzDate: req.headers['x-amz-date'] });
      if (again.signature !== m[5]) return reject('SignatureDoesNotMatch');
      const key = decodeURIComponent(req.url);
      if (req.method === 'PUT') { objects.set(key, { body: body, type: req.headers['content-type'] }); res.writeHead(200, { ETag: '"' + sha(body).slice(0, 32) + '"' }); return res.end(); }
      const o = objects.get(key);
      if (!o) { res.writeHead(404, { 'Content-Type': 'application/xml' }); return res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>'); }
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': o.body.length, 'Content-Type': o.type }); return res.end(); }
      if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': o.type }); return res.end(o.body); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      res.writeHead(405); res.end();
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () { resolve({ server: server, objects: objects, requests: requests, url: 'http://127.0.0.1:' + server.address().port }); });
  });
}
function s3Env(url, extra) {
  return Object.assign({ STORAGE_PROVIDER: 's3', STORAGE_ENDPOINT: url, STORAGE_BUCKET: 'soh-files', STORAGE_REGION: 'auto',
    STORAGE_ACCESS_KEY: 'TESTKEYID', STORAGE_SECRET_KEY: 'test-secret-key-for-fake-s3' }, extra || {});
}

test('S3: put, exists, get and remove send correctly signed path-style requests', async function () {
  const f = await fakeS3();
  try {
    await withEnv(s3Env(f.url), async function () {
      const n = name();
      assert.deepEqual(await storage.put('documents', n, PDF, 'application/pdf'), { provider: 's3' });
      const put = f.requests[0];
      assert.equal(put.method, 'PUT');
      assert.equal(put.url, '/soh-files/documents/' + n);
      assert.equal(put.headers['content-type'], 'application/pdf');
      assert.equal(put.headers['x-amz-content-sha256'], sha(PDF));
      assert.equal(put.auth[3], 'auto');
      assert.match(put.auth[4], /(^|;)host(;|$)/);
      assert.match(put.auth[4], /x-amz-content-sha256/);
      assert.match(put.auth[4], /x-amz-date/);
      assert.equal(await storage.exists('documents', n), true);
      assert.ok((await storage.get('documents', n)).equals(PDF));
      await storage.remove('documents', n);
      assert.equal(f.objects.size, 0);
      assert.equal(await storage.exists('documents', n), false);
      assert.equal(await storage.get('documents', n), null);
      assert.ok(f.requests.every(function (r) { return r.auth && !JSON.stringify(r.headers).includes('test-secret-key-for-fake-s3'); }), 'the secret is never sent');
    });
  } finally { f.server.close(); }
});

test('S3: a rejected request fails with the provider code and never the secret', async function () {
  const f = await fakeS3({ secret: 'a-different-secret' });   // the server expects another secret → SignatureDoesNotMatch
  try {
    await withEnv(s3Env(f.url), async function () {
      await assert.rejects(storage.put('documents', name(), PDF, 'application/pdf'), function (e) {
        assert.match(e.message, /File storage upload failed \(403 SignatureDoesNotMatch\)/);
        assert.ok(!e.message.includes('test-secret-key-for-fake-s3'));
        return true;
      });
    });
  } finally { f.server.close(); }
});

test('S3: missing bucket settings fail clearly instead of sending a request', async function () {
  await withEnv({ STORAGE_PROVIDER: 's3', STORAGE_ENDPOINT: null, STORAGE_BUCKET: null, STORAGE_ACCESS_KEY: null, STORAGE_SECRET_KEY: null }, async function () {
    await assert.rejects(storage.put('documents', name(), PDF), /STORAGE_PROVIDER=s3 needs STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY/);
  });
});

test('S3: files uploaded before the switch are still read from the private folder; storage-copy moves them', async function () {
  const n = name();
  await storage.put('documents', n, PDF, 'application/pdf');            // local, before the switch
  const f = await fakeS3();
  try {
    await withEnv(s3Env(f.url), async function () {
      assert.ok((await storage.get('documents', n)).equals(PDF), 'local fallback');
      const copy = require('../scripts/storage-copy.js');
      const log = console.log; const lines = []; console.log = function (x) { lines.push(String(x)); };
      try {
        assert.equal(await copy.main([]), 0);                              // dry run
        assert.equal(f.objects.size, 0, 'a dry run copies nothing');
        assert.ok(lines.some(function (l) { return l.includes('would copy ' + n); }));
        assert.equal(await copy.main(['--yes']), 0);
        assert.ok(f.objects.get('/soh-files/documents/' + n).body.equals(PDF));
        assert.equal(f.objects.get('/soh-files/documents/' + n).type, 'application/pdf');
        lines.length = 0;
        assert.equal(await copy.main(['--yes']), 0);                       // again: nothing to do
        assert.ok(lines.some(function (l) { return /Copied 0 · already in the bucket: [1-9]/.test(l); }));
      } finally { console.log = log; }
      assert.ok(fs.existsSync(storage.localPath('documents', n)), 'local files are never deleted by the copy');
    });
  } finally { f.server.close(); }
});

/* ── Local provider ───────────────────────────────────────────────────── */

test('local: the folder is B2B_PRIVATE_DIR (same as the trade portal), files are written atomically with 0600', async function () {
  assert.equal(storage.provider(), 'local');
  assert.equal(storage.localRoot(), b2bConfig.privateDir());
  assert.equal(storage.localRoot(), path.resolve(PRIV));
  const n = name('png');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
  await storage.put('documents', n, png, 'image/png');
  const p = path.join(PRIV, 'documents', n);
  assert.ok(fs.readFileSync(p).equals(png));
  if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(PRIV, 'documents')).filter(function (x) { return x.endsWith('.tmp'); }), [], 'no temp file left');
  assert.deepEqual(storage.info(), { provider: 'local', folder: '…/' + path.basename(PRIV) });
});

test('names and folders that are not storage names are refused (no path traversal)', async function () {
  for (const bad of ['../../etc/passwd', 'x.pdf', 'ABCDEF0123456789abcdef0123456789.pdf', name('exe'), name() + '/../x']) {
    await assert.rejects(storage.put('documents', bad, PDF), /Invalid stored file name/, bad);
    await assert.rejects(storage.get('documents', bad), /Invalid stored file name/, bad);
  }
  await assert.rejects(storage.put('../etc', name(), PDF), /Invalid storage folder/);
  assert.equal(uploads.documentPath('../../../etc/passwd'), null);
  assert.equal(await uploads.sendDocument({}, '../../../etc/passwd'), false);
});

test('send: headers and the before() hook only when the file exists; private, no-store by default', async function () {
  const n = name();
  await storage.put('documents', n, PDF, 'application/pdf');
  const hooks = [];
  const app = express();
  app.get('/f/:n', async function (req, res) {
    try {
      const ok = await uploads.sendDocument(res, req.params.n, { 'Content-Type': 'application/pdf', 'X-Content-Type-Options': 'nosniff' }, function () { hooks.push(req.params.n); });
      if (!ok) res.status(404).json({ error: 'missing' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  const server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const r = await fetch(base + '/f/' + n);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(PDF));
    const missing = name();
    const r2 = await fetch(base + '/f/' + missing);
    assert.equal(r2.status, 404);
    assert.match(r2.headers.get('content-type'), /application\/json/);
    assert.equal(r2.headers.get('x-content-type-options'), null, 'no document headers on a 404');
    assert.deepEqual(hooks, [n], 'the audit hook ran only for the file that was sent');
  } finally { server.close(); }
});

/* ── uploads library ──────────────────────────────────────────────────── */

test('uploads: content decides the type; withDocument stores before the transaction and removes on failure', async function () {
  assert.throws(function () { uploads.checkDocument({ buffer: Buffer.from('MZ\x90\x00 an exe pretending to be a pdf'), originalname: 'gst.pdf' }); }, /not a supported file/);
  assert.throws(function () { uploads.checkDocument({ buffer: PDF, originalname: 'gst.jpg' }); }, /does not match its contents/);
  const file = { buffer: PDF, originalname: 'C:\\Users\\x\\gst<cert>.pdf' };
  const meta = await uploads.saveDocument(file);
  assert.equal(meta.originalName, 'gstcert.pdf');
  assert.equal(meta.mime, 'application/pdf');
  assert.equal(meta.sha256, sha(PDF));
  assert.match(meta.storedName, storage.NAME_RX);
  assert.ok(await storage.exists('documents', meta.storedName));

  let seen = null;
  await assert.rejects(uploads.withDocument(file, async function (saved) {
    seen = saved;
    assert.ok(await storage.exists('documents', saved.storedName), 'stored before fn runs');
    throw new Error('the database insert failed');
  }), /the database insert failed/);
  assert.equal(await storage.exists('documents', seen.storedName), false, 'removed after the failure');

  const ok = await uploads.withDocument(file, async function (saved) { return saved.storedName; });
  assert.ok(await storage.exists('documents', ok), 'kept after success');
  assert.equal(await uploads.withDocument(null, async function (saved) { return saved; }), null, 'no file → fn(null)');
  await uploads.removeDocument('not-a-name');                                       // never throws
  await uploads.removeDocument(name());                                             // missing file: never throws
});
