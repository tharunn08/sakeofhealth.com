/**
 * Secure file uploads.
 *
 *  - Files are received into memory with hard size/count limits (multer).
 *  - The type is decided by the file's magic bytes, never by the client's
 *    filename or Content-Type header.
 *  - Stored under a random name in a private directory outside the web root;
 *    the only way to read one back is through an authorised API route.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config.js');
const { bad } = require('./http.js');

const DOC_FIELDS = ['gst_certificate', 'business_proof', 'address_proof', 'shop_proof', 'pan_card'];

function dir(kind) {
  const d = path.join(config.privateDir(), kind);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Identify a file from its first bytes. Returns { ext, mime } or null. */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: 'png', mime: 'image/png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

function isXlsx(buf) {
  return !!buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
}

/** Display-only copy of the client's filename: no paths, no control characters. */
function safeDisplayName(name) {
  // eslint-disable-next-line no-control-regex
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001F\u007F<>:"|?*]/g, '').trim();
  return (base || 'file').slice(0, 180);
}

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes(), files: DOC_FIELDS.length, fields: 60, fieldSize: 20 * 1024, parts: 80 },
}).fields(DOC_FIELDS.map(function (name) { return { name: name, maxCount: 1 }; }));

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxImportBytes(), files: 1, fields: 10 },
}).single('file');

/** Validate + persist one uploaded KYC document. Returns metadata for the database row. */
function saveDocument(file) {
  const kind = sniff(file.buffer);
  if (!kind) throw bad('"' + safeDisplayName(file.originalname) + '" is not a supported file. Upload a PDF, JPG, PNG or WEBP.');
  const ext = path.extname(String(file.originalname || '')).toLowerCase().replace('.', '');
  const allowedExt = { pdf: ['pdf'], jpg: ['jpg', 'jpeg'], png: ['png'], webp: ['webp'] }[kind.ext];
  if (ext && allowedExt.indexOf(ext) === -1) {
    throw bad('"' + safeDisplayName(file.originalname) + '" has a file extension that does not match its contents.');
  }
  const storedName = crypto.randomBytes(16).toString('hex') + '.' + kind.ext;
  fs.writeFileSync(path.join(dir('documents'), storedName), file.buffer, { mode: 0o600 });
  return {
    storedName: storedName,
    originalName: safeDisplayName(file.originalname),
    mime: kind.mime,
    size: file.buffer.length,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
  };
}

const STORED_RX = /^[a-f0-9]{32}\.(pdf|jpg|png|webp|xlsx|csv)$/;

function documentPath(storedName) {
  if (!STORED_RX.test(String(storedName))) return null;
  const p = path.join(dir('documents'), storedName);
  return fs.existsSync(p) ? p : null;
}

function removeDocument(storedName) {
  const p = documentPath(storedName);
  if (p) { try { fs.unlinkSync(p); } catch (e) { /* best effort */ } }
}

function saveImportFile(file) {
  const xlsx = isXlsx(file.buffer);
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  if (!xlsx && ext !== '.csv') throw bad('Upload an Excel (.xlsx) or CSV file.');
  if (xlsx && ext && ext !== '.xlsx') throw bad('The file contents are Excel but the extension is not .xlsx.');
  const storedName = crypto.randomBytes(16).toString('hex') + (xlsx ? '.xlsx' : '.csv');
  fs.writeFileSync(path.join(dir('imports'), storedName), file.buffer, { mode: 0o600 });
  return { storedName: storedName, originalName: safeDisplayName(file.originalname), isXlsx: xlsx };
}

function importPath(storedName) {
  if (!STORED_RX.test(String(storedName))) return null;
  const p = path.join(dir('imports'), storedName);
  return fs.existsSync(p) ? p : null;
}

module.exports = {
  DOC_FIELDS, documentUpload, importUpload, sniff, isXlsx, saveDocument, documentPath, removeDocument,
  saveImportFile, importPath, safeDisplayName, dir,
};
