/**
 * Lightweight persistent JSON database.
 * Zero external deps, atomic writes, in-memory index for speed.
 * Swap for MongoDB later by keeping the same method signatures.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

// IMPORTANT — read this if staff/orders/products keep disappearing after a
// redeploy: most deploy methods (Git push, zip upload, hPanel file manager)
// replace your ENTIRE site folder with a fresh copy of the repo. Anything
// written to disk INSIDE that folder — including a `data/` folder next to
// the app code — gets wiped along with it, since it isn't part of the repo.
// That is what deletes staff accounts created in the admin panel and brings
// back the old seed-data defaults (server.js re-seeds automatically
// whenever the products collection is found empty).
//
// Fix: store data OUTSIDE the deployed site folder. On shared hosting
// (Hostinger, etc.) the account's home directory itself is never replaced
// by a deploy — only the specific site folder inside it is — so by default
// we now store data at ~/sakeofhealth-data (your OS/hosting account home
// directory + a fixed folder name), which survives every redeploy
// automatically with zero configuration.
//
// You can still override this explicitly with an environment variable if
// you'd rather point at a specific mounted disk/volume:
//   DATA_DIR=/data          (e.g. a Render "Disk")
//   DATA_DIR=/app/data      (e.g. a Railway volume)
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(os.homedir(), 'sakeofhealth-data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('[DB] Using data directory: ' + DATA_DIR +
  (process.env.DATA_DIR ? '' : '  (default: your account home directory — safe from redeploys)'));

const COLLECTIONS = ['orders', 'products', 'coupons', 'customers', 'accounts', 'reviews', 'staff', 'deliveries', 'settings', 'events'];

function filePath(name) { return path.join(DATA_DIR, name + '.json'); }

function load(name) {
  // Always read fresh from disk. This is essential on hosting where the Node
  // process may restart between requests or run as multiple workers — a stale
  // in-memory cache would otherwise "lose" changes another process just wrote
  // (e.g. an approved review reverting to pending after a page refresh).
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(name, arr) {
  // Write immediately and synchronously (atomic temp-file + rename). No debounce:
  // on shared hosting the process can be killed at any moment, and a delayed
  // write would lose the change. Atomic rename prevents half-written files.
  const tmp = filePath(name) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, filePath(name));
  } catch (e) {
    console.error('[DB] persist failed for ' + name + ':', e.message);
  }
}

function flushSync() {
  // Writes are now synchronous, so there is nothing buffered to flush.
  // Kept for compatibility with existing callers.
}

function matches(doc, query) {
  return Object.keys(query).every(k => {
    const q = query[k];
    if (q && typeof q === 'object' && !Array.isArray(q)) {
      if ('$in' in q) return q.$in.includes(doc[k]);
      if ('$ne' in q) return doc[k] !== q.$ne;
      if ('$gte' in q) return doc[k] >= q.$gte;
      if ('$lte' in q) return doc[k] <= q.$lte;
      if ('$regex' in q) return new RegExp(q.$regex, q.$options || 'i').test(String(doc[k] || ''));
    }
    return doc[k] === q;
  });
}

function collection(name) {
  return {
    all() { return load(name).slice(); },

    find(query = {}) { return load(name).filter(d => matches(d, query)); },

    findOne(query = {}) { return load(name).find(d => matches(d, query)) || null; },

    findById(id) { return load(name).find(d => d.id === id) || null; },

    insert(doc) {
      const arr = load(name);
      const record = Object.assign({
        id: doc.id || randomUUID(),
        createdAt: doc.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, doc);
      arr.push(record);
      persist(name, arr);
      return record;
    },

    update(id, patch) {
      const arr = load(name);
      const idx = arr.findIndex(d => d.id === id);
      if (idx === -1) return null;
      arr[idx] = Object.assign({}, arr[idx], patch, { updatedAt: new Date().toISOString() });
      persist(name, arr);
      return arr[idx];
    },

    remove(id) {
      const arr = load(name);
      const idx = arr.findIndex(d => d.id === id);
      if (idx === -1) return false;
      arr.splice(idx, 1);
      persist(name, arr);
      return true;
    },

    count(query = {}) { return this.find(query).length; },
  };
}

const db = {};
COLLECTIONS.forEach(c => { db[c] = collection(c); });
// The four protected products: every write through this store is checked (src/services/productProtection.js).
db.products = require('./productProtection.js').wrap(db.products);
db.flushSync = flushSync;

process.on('SIGINT', () => { flushSync(); process.exit(0); });
process.on('SIGTERM', () => { flushSync(); process.exit(0); });

module.exports = { db };
