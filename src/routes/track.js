const { Router } = require('express');
const { store } = require('../services/store.js');
const { fanOut } = require('../services/analytics.js');

const router = Router();

router.post('/', async function (req, res) {
  res.status(202).end();

  const events = req.body.events || [];
  const user = req.body.user || {};
  if (!Array.isArray(events) || events.length === 0) return;

  setImmediate(async function () {
    await store.appendEvents(events);
    const purchaseEvents = events.filter(function (e) { return e.name === 'purchase'; });
    if (purchaseEvents.length) await fanOut(purchaseEvents, user);
    else await fanOut(events.slice(0, 5), user);
  });
});

module.exports = router;
