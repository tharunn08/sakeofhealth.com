const { store } = require('../services/store.js');

function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next();

  store.getIdempotency(key).then(function (cached) {
    if (cached) return res.status(200).json(cached);
    const origJson = res.json.bind(res);
    res.json = function (body) {
      store.setIdempotency(key, body);
      return origJson(body);
    };
    next();
  }).catch(next);
}

module.exports = { idempotency };
