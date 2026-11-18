/**
 * Test-only stand-in for the Razorpay REST API (no network, no money).
 * Implements the three calls the shop uses:
 *   POST /v1/orders            create a gateway order
 *   GET  /v1/orders/:id        fetch it
 *   GET  /v1/payments/:id      fetch a payment the test registered
 * Requests must carry HTTP basic auth with the test key id/secret.
 */
const http = require('http');

function startRazorpayStub(keyId, keySecret) {
  const orders = {}, payments = {}, calls = [];
  let n = 0;
  const expectAuth = 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64');

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== expectAuth) return send(401, { error: { description: 'Authentication failed' } });
      let m;
      if (req.method === 'POST' && req.url === '/v1/orders') {
        const b = JSON.parse(body || '{}');
        const id = 'order_STUB' + (++n);
        orders[id] = { id, entity: 'order', amount: b.amount, currency: b.currency, receipt: b.receipt, status: 'created', notes: b.notes || {} };
        return send(200, orders[id]);
      }
      if (req.method === 'GET' && (m = /^\/v1\/orders\/([^/]+)$/.exec(req.url))) {
        return orders[m[1]] ? send(200, orders[m[1]]) : send(400, { error: { description: 'not found' } });
      }
      if (req.method === 'GET' && (m = /^\/v1\/payments\/([^/]+)$/.exec(req.url))) {
        return payments[m[1]] ? send(200, payments[m[1]]) : send(400, { error: { description: 'not found' } });
      }
      send(404, { error: { description: 'no such endpoint' } });
    });
  });

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port + '/v1';
    resolve({
      base, orders, payments, calls,
      /** Register a payment as Razorpay would report it. */
      pay(orderId, paymentId, overrides) {
        const o = orders[orderId];
        payments[paymentId] = Object.assign({ id: paymentId, entity: 'payment', order_id: orderId, amount: o ? o.amount : 0, currency: o ? o.currency : 'INR', status: 'captured' }, overrides || {});
        return payments[paymentId];
      },
      stop: () => new Promise(r => server.close(() => r())),
    });
  }));
}

module.exports = { startRazorpayStub };
