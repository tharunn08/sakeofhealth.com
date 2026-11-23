/**
 * POST /api/internal/cron/run — the HTTP way to start a background run, for a cron service that can
 * only call a URL (Hostinger can also run scripts/cron/run-jobs.js directly, which is preferred:
 * no 120-second request limit). Header X-Cron-Secret must equal CRON_SECRET (32+ characters,
 * compared in constant time). CRON_SECRET unset → 404, as if the URL did not exist.
 * The run's time budget is capped at 90 s. Answers the run summary (no secrets, no personal data).
 */
'use strict';
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const jobsConfig = require('./jobs-config.js');

const limit = rateLimit({ windowMs: 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });
const digest = function (s) { return crypto.createHash('sha256').update(String(s)).digest(); };

function mount(app) {
  app.post('/api/internal/cron/run', function (req, res, next) {
    const secret = jobsConfig.cronSecret();
    res.setHeader('Cache-Control', 'no-store');
    if (!secret) return res.status(404).json({ error: 'Endpoint not found' });
    next();
  }, limit, function (req, res, next) {
    const given = req.get('x-cron-secret');
    if (!given || !crypto.timingSafeEqual(digest(given), digest(jobsConfig.cronSecret()))) return res.status(403).json({ error: 'Forbidden' });
    require('./cron.js').runOnce({ trigger: 'http' }).then(function (out) { res.status(out.ok ? 200 : 500).json(out); }, next);
  });
}

module.exports = { mount };
