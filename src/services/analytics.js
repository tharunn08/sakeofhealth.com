const { createHash, randomUUID } = require('crypto');
const { store } = require('./store.js');

const sha256 = function (str) {
  return createHash('sha256').update((str || '').trim().toLowerCase()).digest('hex');
};

const META_PIXEL_ID = process.env.META_PIXEL_ID || '';
const META_TOKEN = process.env.META_ACCESS_TOKEN || '';
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || '';
const GA4_API_SECRET = process.env.GA4_API_SECRET || '';

async function fetchWithRetry(url, opts, retries, delay) {
  retries = retries || 3;
  delay = delay || 500;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      if (res.status < 500) return res;
    } catch (_) {}
    if (i < retries - 1) await new Promise(function (r) { setTimeout(r, delay * Math.pow(2, i)); });
  }
  return null;
}

async function sendToMeta(event, user) {
  user = user || {};
  if (!META_PIXEL_ID || !META_TOKEN) return;
  const payload = {
    data: [{
      event_name: event.name,
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: event.url || '',
      user_data: {
        em: user.email ? [sha256(user.email)] : [],
        ph: user.phone ? [sha256(user.phone)] : [],
        fn: user.firstName ? [sha256(user.firstName)] : [],
        ln: user.lastName ? [sha256(user.lastName)] : [],
      },
      custom_data: event.data || {},
    }],
    test_event_code: process.env.META_TEST_CODE || undefined,
  };
  const res = await fetchWithRetry(
    'https://graph.facebook.com/v20.0/' + META_PIXEL_ID + '/events?access_token=' + META_TOKEN,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  if (!res) await store.appendDLQ({ id: randomUUID(), type: 'meta', event: event, user: user });
}

async function sendToGA4(event, user) {
  user = user || {};
  if (!GA4_MEASUREMENT_ID || !GA4_API_SECRET) return;
  const payload = {
    client_id: user.clientId || 'anon',
    events: [{ name: event.name, params: Object.assign({}, event.data || {}, { engagement_time_msec: '100' }) }],
  };
  const res = await fetchWithRetry(
    'https://www.google-analytics.com/mp/collect?measurement_id=' + GA4_MEASUREMENT_ID + '&api_secret=' + GA4_API_SECRET,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  if (!res) await store.appendDLQ({ id: randomUUID(), type: 'ga4', event: event, user: user });
}

async function fanOut(eventBatch, user) {
  user = user || {};
  await Promise.allSettled(eventBatch.map(function (ev) {
    return Promise.allSettled([sendToMeta(ev, user), sendToGA4(ev, user)]);
  }));
}

module.exports = { sendToMeta, sendToGA4, fanOut };
