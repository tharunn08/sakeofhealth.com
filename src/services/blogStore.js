/**
 * Blog submissions and published posts (Phase 0.5.10, BUG-007).
 *
 * Stored under DATA_DIR/blog/ (outside the code folder, so a redeploy no
 * longer wipes them); generated article pages go to DATA_DIR/blog/articles/.
 * On first start, blog files found in the old repository folder data/ are
 * COPIED here — the originals are never moved, changed or deleted.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const BASE = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), 'sakeofhealth-data');
const BLOG_DIR = path.join(BASE, 'blog');
const ARTICLES_DIR = path.join(BLOG_DIR, 'articles');
const LEGACY_DIR = path.join(__dirname, '../../data');
const PENDING_FILE = path.join(BLOG_DIR, 'blog-pending.json');
const PUBLISHED_FILE = path.join(BLOG_DIR, 'blog-published.json');
const FILES = ['blog-pending.json', 'blog-published.json'];

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

/** Copy (never move) old blog data into DATA_DIR/blog when it is not there yet. */
function copyLegacy(fromDir) {
  const copied = [];
  for (const f of FILES) {
    const src = path.join(fromDir, f), dst = path.join(BLOG_DIR, f);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    ensureDir(BLOG_DIR);
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    copied.push(f);
  }
  if (copied.length) console.log('[BLOG] Copied ' + copied.join(', ') + ' from ' + fromDir + ' to ' + BLOG_DIR + ' (originals left in place)');
  return copied;
}
try { copyLegacy(LEGACY_DIR); } catch (e) { console.error('[BLOG] could not copy old blog data:', e.message); }

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return []; }
}
function write(file, data) {
  ensureDir(BLOG_DIR);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function getPending() { return read(PENDING_FILE); }
function getPublished() { return read(PUBLISHED_FILE); }

function addPending({ title, category, authorName, authorEmail, content, excerpt }) {
  const pending = read(PENDING_FILE);
  const id = randomUUID();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const post = {
    id: id,
    title: title.trim(),
    slug: slug + '-' + id.slice(0, 6),
    category: category.trim(),
    authorName: authorName.trim(),
    authorEmail: authorEmail.trim().toLowerCase(),
    content: content.trim(),
    excerpt: (excerpt && excerpt.trim()) || content.trim().slice(0, 180) + '...',
    readTime: Math.max(1, Math.ceil(content.trim().split(/\s+/).length / 200)) + ' min read',
    submittedAt: new Date().toISOString(),
  };
  pending.push(post);
  write(PENDING_FILE, pending);
  return post;
}

function approvePost(id) {
  const pending = read(PENDING_FILE);
  const idx = pending.findIndex(function (p) { return p.id === id; });
  if (idx === -1) return null;
  const post = pending.splice(idx, 1)[0];
  const published = read(PUBLISHED_FILE);
  const final = Object.assign({}, post, { publishedAt: new Date().toISOString(), status: 'published' });
  published.unshift(final);
  write(PUBLISHED_FILE, published);   // publish first, then remove from the queue
  write(PENDING_FILE, pending);
  return final;
}

function rejectPost(id) {
  const pending = read(PENDING_FILE);
  const idx = pending.findIndex(function (p) { return p.id === id; });
  if (idx === -1) return null;
  const post = pending.splice(idx, 1)[0];
  write(PENDING_FILE, pending);
  return post;
}

/** Path of a generated article page, or null for an unsafe name. */
function articlePath(slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(slug))) return null;
  return path.join(ARTICLES_DIR, slug + '.html');
}
function saveArticle(slug, html) {
  const p = articlePath(slug);
  if (!p) throw new Error('invalid article name');
  ensureDir(ARTICLES_DIR);
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, p);
  return p;
}

module.exports = { getPending, getPublished, addPending, approvePost, rejectPost, copyLegacy, articlePath, saveArticle, BLOG_DIR, ARTICLES_DIR };
