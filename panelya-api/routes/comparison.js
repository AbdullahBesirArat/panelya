const express = require('express');
const db = require('../db');
const { requireCustomerAccount } = require('./customerAuth');
const { rateLimit } = require('../middleware/security');
const comparison = require('../modules/catalog/comparison');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.COMPARISON_RATE_LIMIT || 200),
  message: 'Cok fazla istek. Lutfen biraz sonra tekrar deneyin.',
});

// The server-canonical comparison list is per signed-in customer; guests keep theirs
// client-side. Every endpoint requires a customer session.
async function withCustomer(req, res, next, fn) {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    let organization;
    let account;
    try {
      const resolved = await requireCustomerAccount(req, client);
      organization = resolved.organization;
      account = resolved.account;
    } catch (error) {
      await client.query('rollback');
      if (error.status && error.status !== 401) return next(error);
      return res.status(401).json({ error: 'Musteri oturumu zorunlu', code: 'CUSTOMER_SESSION_REQUIRED' });
    }
    const result = await fn(client, { organization, account });
    await client.query('commit');
    res.setHeader('Cache-Control', 'no-store');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
}

router.get('/', (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  return res.json(await comparison.listComparison(client, { organizationId: organization.id, customerAccountId: account.id }));
}));

router.post('/', writeLimiter, (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const data = await comparison.addToComparison(client, {
    organizationId: organization.id, customerAccountId: account.id, productId: req.body.product_id ?? req.body.productId,
  });
  return res.json(data);
}));

router.post('/merge', writeLimiter, (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const ids = Array.isArray(req.body.items) ? req.body.items.map((item) => (typeof item === 'object' ? item.product_id : item)) : [];
  const data = await comparison.mergeGuestComparison(client, { organizationId: organization.id, customerAccountId: account.id, productIds: ids });
  return res.json(data);
}));

router.delete('/', (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  return res.json(await comparison.clearComparison(client, { organizationId: organization.id, customerAccountId: account.id }));
}));

router.delete('/:productId', (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const data = await comparison.removeFromComparison(client, {
    organizationId: organization.id, customerAccountId: account.id, productId: req.params.productId,
  });
  return res.json(data);
}));

module.exports = router;
