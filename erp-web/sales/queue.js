/* Offline queue for the field and event app (3b.6).
   What could not reach the server waits here (IndexedDB on this device) with an id made when it
   was created; the same id is sent on every retry, so the server does it once. The server's
   record (MySQL, /api/erp/offline) is the truth; this is only a buffer until it gets there.
   Sync runs when the connection returns, every 30 seconds while anything waits, and on demand.
   Nothing is dropped silently: a conflict or refusal stays visible here (and in the office)
   until the person dismisses it. */
(function () {
  'use strict';
  var DB = 'soh-field', STORE = 'ops', VERSION = 1, BATCH = 25;
  var memory = null;   // used only if this browser has no IndexedDB (then nothing survives a reload; the app says so)
  var listeners = [], syncing = false, tokenFn = function () { return null; }, timer = null;

  function open() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { memory = memory || {}; resolve(null); return; }
      var r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'clientOpId' }); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { memory = memory || {}; resolve(null); };
    });
  }
  function tx(mode, fn) {
    return open().then(function (d) {
      if (!d) return fn(null);
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode), s = t.objectStore(STORE), out;
        Promise.resolve(fn(s)).then(function (v) { out = v; });
        t.oncomplete = function () { resolve(out); }; t.onerror = function () { reject(t.error); }; t.onabort = function () { reject(t.error); };
      });
    });
  }
  function req(r) { return new Promise(function (resolve, reject) { r.onsuccess = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); }; }); }
  function put(op) { return tx('readwrite', function (s) { if (!s) { memory[op.clientOpId] = op; return op; } return req(s.put(op)); }); }
  function del(id) { return tx('readwrite', function (s) { if (!s) { delete memory[id]; return; } return req(s.delete(id)); }); }
  function all() { return tx('readonly', function (s) { if (!s) return Object.keys(memory).map(function (k) { return memory[k]; }); return req(s.getAll()); }).then(function (a) { return (a || []).sort(function (x, y) { return String(x.createdAt).localeCompare(String(y.createdAt)); }); }); }
  function notify() { all().then(function (a) { listeners.forEach(function (f) { try { f(a); } catch (e) { /* */ } }); }); }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = crypto.getRandomValues(new Uint8Array(1))[0] % 16; return (c === 'x' ? r : (r & 3) | 8).toString(16); }); }
  function deviceId() {
    var k = 'soh.device'; try { var v = localStorage.getItem(k); if (!v) { v = uuid(); localStorage.setItem(k, v); } return v; } catch (e) { return null; }   // only an anonymous device label
  }

  /** Keep an operation for sending. Returns the stored op (status 'pending'). */
  function add(kind, payload, label, opId) {
    var op = { clientOpId: opId || uuid(), kind: kind, payload: payload, label: label || kind, createdAt: new Date().toISOString(), status: 'pending', attempts: 0 };
    return put(op).then(function () { notify(); schedule(1000); return op; });
  }

  /** Send what waits. Network errors leave everything pending; the server's answer decides the rest. */
  function sync() {
    if (syncing || !tokenFn()) return Promise.resolve({ skipped: true });
    if (navigator.onLine === false) return Promise.resolve({ offline: true });
    syncing = true;
    return all().then(function (ops) {
      var due = ops.filter(function (o) { return o.status === 'pending'; }).slice(0, BATCH);
      if (!due.length) return { sent: 0 };
      return fetch('/api/erp/offline/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenFn() },
        body: JSON.stringify({ ops: due.map(function (o) { return { clientOpId: o.clientOpId, kind: o.kind, payload: o.payload, createdAt: o.createdAt, deviceId: deviceId() }; }) }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || 'sync refused'); e.status = r.status; throw e; } return j; }); })
        .then(function (j) {
          var byId = {}; (j.results || []).forEach(function (x) { byId[x.clientOpId] = x; });
          return Promise.all(due.map(function (o) {
            var x = byId[o.clientOpId];
            if (!x) return null;
            if (x.status === 'applied' || x.status === 'duplicate') { done.unshift({ label: o.label, result: x.result, at: new Date().toISOString(), kind: o.kind }); done = done.slice(0, 20); return del(o.clientOpId); }
            if (x.status === 'retry') { o.attempts++; o.error = x.error; return put(o); }
            o.status = x.status; o.error = x.error; o.code = x.code; o.attempts++;   // conflict / failed: kept, shown, settled in the office
            return put(o);
          })).then(function () { return { sent: due.length }; });
        });
    }).catch(function (e) { return { error: e.message }; }).then(function (r) { syncing = false; notify(); return r; });
  }
  var done = [];   // recently synced (this session), for the person to see what went through
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(function () { sync().then(function () { all().then(function (a) { if (a.some(function (o) { return o.status === 'pending'; })) schedule(30000); }); }); }, ms); }
  window.addEventListener('online', function () { schedule(500); });

  window.SOH_QUEUE = {
    add: add, sync: sync, all: all, remove: function (id) { return del(id).then(notify); }, recent: function () { return done.slice(); },
    onChange: function (f) { listeners.push(f); notify(); },
    init: function (getToken) { tokenFn = getToken; schedule(500); },
    persistent: function () { return open().then(function (d) { return !!d; }); },
    isNetworkError: function (e) { return e && (e.name === 'TypeError' || e.network === true); },
    uuid: uuid,
  };
})();
