const events = [];
const idempotencyMap = new Map();
const dlq = [];

const store = {
  async appendEvents(batch) {
    events.push.apply(events, batch);
  },
  async getEvents() {
    return events.slice();
  },

  async appendDLQ(item) {
    dlq.push(Object.assign({}, item, { ts: Date.now() }));
  },
  async getDLQ() {
    return dlq.slice();
  },
  async removeDLQ(id) {
    const idx = dlq.findIndex(function (i) { return i.id === id; });
    if (idx !== -1) dlq.splice(idx, 1);
  },

  async setIdempotency(key, value) {
    idempotencyMap.set(key, { value: value, expires: Date.now() + 86_400_000 });
  },
  async getIdempotency(key) {
    const entry = idempotencyMap.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { idempotencyMap.delete(key); return null; }
    return entry.value;
  },
};

module.exports = { store };
