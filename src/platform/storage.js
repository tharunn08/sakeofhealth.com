/**
 * Persistent file storage for uploaded business files (KYC and supplier documents, proof-of-delivery
 * photos, manufacturing documents). Files never live in the deployed site folder.
 *
 *   STORAGE_PROVIDER=local (default)  files in B2B_PRIVATE_DIR (absolute, outside the site folder —
 *                                     the start-up check refuses anything else in production)
 *   STORAGE_PROVIDER=s3               any S3-compatible service (Cloudflare R2, Backblaze B2, AWS S3, MinIO):
 *                                     STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_REGION, STORAGE_ACCESS_KEY,
 *                                     STORAGE_SECRET_KEY. Requests are signed with AWS Signature V4
 *                                     (implemented here with Node's crypto — no SDK, no new dependency).
 *
 * API (async): put(kind, name, buffer, mime) · get(kind, name) → Buffer|null · exists(kind, name) · remove(kind, name)
 *              send(res, kind, name, headers, before) → true if sent, false if missing (nothing written) · info().
 * Names are random (hex + extension, chosen by src/modules/b2b/lib/uploads.js); kind is a folder.
 * With s3, a file not found in the bucket is still read from the local folder (files uploaded before
 * the switch) — copy them with: node scripts/storage-copy.js.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const NAME_RX = /^[a-f0-9]{32}\.(pdf|jpg|png|webp|xlsx|csv)$/;
const KIND_RX = /^[a-z][a-z0-9-]{1,30}$/;

function provider() { return (process.env.STORAGE_PROVIDER || 'local').toLowerCase() === 's3' ? 's3' : 'local'; }
function localRoot() {
  return process.env.B2B_PRIVATE_DIR ? path.resolve(process.env.B2B_PRIVATE_DIR) : path.join(os.homedir(), 'sakeofhealth-private');
}
function check(kind, name) {
  if (!KIND_RX.test(String(kind))) throw new Error('Invalid storage folder');
  if (!NAME_RX.test(String(name))) throw new Error('Invalid stored file name');
}
function localPath(kind, name) { check(kind, name); return path.join(localRoot(), kind, name); }

/* ── AWS Signature Version 4 ─────────────────────────────────────────────── */
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding as SigV4 requires (keep / in paths when asked). */
function uriEncode(str, keepSlash) {
  return encodeURIComponent(str).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); })
    .replace(keepSlash ? /%2F/g : /$^/, '/');
}
function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}
/**
 * Sign a request. opts: { method, host, path (already encoded), query: {k:v}, headers: {lower-case: value},
 * payloadHash, region, service, accessKey, secretKey, amzDate (YYYYMMDDTHHMMSSZ) }.
 * Returns { authorization, canonicalRequest, stringToSign, signature, signedHeaders }.
 */
function sign(o) {
  const date = o.amzDate.slice(0, 8);
  const headers = Object.assign({}, o.headers, { host: o.host });
  const names = Object.keys(headers).map(function (k) { return k.toLowerCase(); }).sort();
  const lower = {}; Object.keys(headers).forEach(function (k) { lower[k.toLowerCase()] = String(headers[k]).trim().replace(/\s+/g, ' '); });
  const canonicalHeaders = names.map(function (k) { return k + ':' + lower[k] + '\n'; }).join('');
  const signedHeaders = names.join(';');
  const query = Object.keys(o.query || {}).sort().map(function (k) { return uriEncode(k) + '=' + uriEncode(String(o.query[k])); }).join('&');
  const canonicalRequest = [o.method, o.path, query, canonicalHeaders, signedHeaders, o.payloadHash].join('\n');
  const scope = date + '/' + o.region + '/' + o.service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(o.secretKey, date, o.region, o.service)).update(stringToSign).digest('hex');
  return {
    canonicalRequest: canonicalRequest, stringToSign: stringToSign, signature: signature, signedHeaders: signedHeaders,
    authorization: 'AWS4-HMAC-SHA256 Credential=' + o.accessKey + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
  };
}

function s3Config() {
  const missing = ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'].filter(function (k) { return !process.env[k]; });
  if (missing.length) throw new Error('STORAGE_PROVIDER=s3 needs ' + missing.join(', '));
  const endpoint = new URL(process.env.STORAGE_ENDPOINT);
  return { endpoint: endpoint, bucket: process.env.STORAGE_BUCKET, region: process.env.STORAGE_REGION || 'auto',
    accessKey: process.env.STORAGE_ACCESS_KEY, secretKey: process.env.STORAGE_SECRET_KEY };
}
/** One signed S3 request (path-style URL: endpoint/bucket/key). Resolves { status, body: Buffer, headers }. */
function s3(method, key, body, mime) {
  const c = s3Config();
  const payload = body || Buffer.alloc(0);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const p = (c.endpoint.pathname.replace(/\/$/, '')) + '/' + uriEncode(c.bucket) + '/' + uriEncode(key, true);
  const headers = { 'x-amz-content-sha256': sha256hex(payload), 'x-amz-date': amzDate };
  if (method === 'PUT') { headers['content-type'] = mime || 'application/octet-stream'; headers['content-length'] = String(payload.length); }
  const s = sign({ method: method, host: c.endpoint.host, path: p, query: {}, headers: headers, payloadHash: headers['x-amz-content-sha256'],
    region: c.region, service: 's3', accessKey: c.accessKey, secretKey: c.secretKey, amzDate: amzDate });
  const lib = c.endpoint.protocol === 'http:' ? http : https;
  return new Promise(function (resolve, reject) {
    const req = lib.request({ method: method, host: c.endpoint.hostname, port: c.endpoint.port || undefined, path: p,
      headers: Object.assign({}, headers, { Authorization: s.authorization }), timeout: 20000 }, function (res) {
      const chunks = [];
      res.on('data', function (d) { chunks.push(d); });
      res.on('end', function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }); });
    });
    req.on('timeout', function () { req.destroy(new Error('Storage request timed out')); });
    req.on('error', reject);
    if (method === 'PUT') req.end(payload); else req.end();
  });
}
function s3Error(r, what) {
  const code = /<Code>([^<]+)<\/Code>/.exec(r.body.toString('utf8'));
  return new Error('File storage ' + what + ' failed (' + r.status + (code ? ' ' + code[1] : '') + ')');
}

/* ── public API ──────────────────────────────────────────────────────────── */
async function put(kind, name, buffer, mime) {
  check(kind, name);
  if (provider() === 's3') {
    const r = await s3('PUT', kind + '/' + name, buffer, mime);
    if (r.status !== 200) throw s3Error(r, 'upload');
    return { provider: 's3' };
  }
  const dir = path.join(localRoot(), kind);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, '.' + name + '.tmp');
  fs.writeFileSync(tmp, buffer, { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
  return { provider: 'local' };
}
async function get(kind, name) {
  check(kind, name);
  if (provider() === 's3') {
    const r = await s3('GET', kind + '/' + name);
    if (r.status === 200) return r.body;
    if (r.status !== 404) throw s3Error(r, 'download');
  }
  const p = localPath(kind, name);   // local provider, or a file from before the switch to s3
  try { return fs.readFileSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
/** true if the file is stored (s3: a HEAD request; local: the folder). */
async function exists(kind, name) {
  check(kind, name);
  if (provider() === 's3') {
    const r = await s3('HEAD', kind + '/' + name);
    if (r.status === 200) return true;
    if (r.status !== 404) throw s3Error(r, 'check');
    return false;
  }
  return fs.existsSync(localPath(kind, name));
}
async function remove(kind, name) {
  check(kind, name);
  if (provider() === 's3') {
    const r = await s3('DELETE', kind + '/' + name);
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw s3Error(r, 'delete');
  }
  try { fs.unlinkSync(localPath(kind, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
/**
 * Send a stored file in an HTTP response. Only once the file is known to exist: `before()` runs (e.g. an
 * audit entry — if it throws, nothing is sent) and the headers are set. Resolves false when the file is
 * missing, with nothing written to the response, so the caller answers 404 as usual.
 */
async function send(res, kind, name, headers, before) {
  check(kind, name);
  const set = async function () {
    if (before) await before();
    Object.keys(headers || {}).forEach(function (k) { res.setHeader(k, headers[k]); });
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'private, no-store');   // business files are never cached
  };
  if (provider() === 'local') {
    const p = localPath(kind, name);
    if (!fs.existsSync(p)) return false;
    await set();
    await new Promise(function (resolve, reject) { res.sendFile(p, { dotfiles: 'allow' }, function (e) { if (e) reject(e); else resolve(); }); });
    return true;
  }
  const buf = await get(kind, name);
  if (!buf) return false;
  await set();
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
  return true;
}
function info() {
  return provider() === 's3'
    ? { provider: 's3', endpoint: (function () { try { return new URL(process.env.STORAGE_ENDPOINT).host; } catch (e) { return null; } })(), bucket: process.env.STORAGE_BUCKET || null }
    : { provider: 'local', folder: localRoot().replace(/^.*[\\/]/, '…/') };
}

module.exports = { put, get, exists, remove, send, info, provider, localRoot, localPath, sign, signingKey, uriEncode, NAME_RX, KIND_RX };
