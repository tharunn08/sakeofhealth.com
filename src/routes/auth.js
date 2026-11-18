/**
 * Customer auth API — optional accounts for shoppers.
 * Mounted at /api/auth. Guest checkout is untouched: nothing here is
 * required to place an order.
 */
const express = require('express');
const router = express.Router();
const { db } = require('../services/db.js');
const { signup, login, requireCustomerAuth } = require('../middleware/customerAuth.js');

router.post('/signup', function (req, res) {
  const b = req.body || {};
  const result = signup(b.email, b.password, b.name);
  if (!result.ok) return res.status(result.unavailable ? 503 : 400).json({ error: result.error });
  res.status(201).json(result);
});

router.post('/login', function (req, res) {
  const b = req.body || {};
  const result = login(b.email, b.password);
  if (!result.ok) return res.status(result.unavailable ? 503 : 401).json({ error: result.error });
  res.json(result);
});

router.get('/me', requireCustomerAuth, function (req, res) {
  const account = db.accounts.findById(req.customer.sub);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json({ user: { id: account.id, email: account.email, name: account.name } });
});

// Orders placed by this account's email — lets a logged-in customer see
// their order history without needing the order/tracking ID.
router.get('/orders', requireCustomerAuth, function (req, res) {
  const account = db.accounts.findById(req.customer.sub);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const orders = db.orders
    .all()
    .filter(function (o) { return o.customer && o.customer.email === account.email; })
    .sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  res.json({ orders: orders });
});

module.exports = router;
