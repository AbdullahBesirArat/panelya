const express = require('express');
const db = require('../db');
const { requireCustomerAccount } = require('./customerAuth');
const { rateLimit } = require('../middleware/security');
const rv = require('../modules/catalog/recentlyViewed');

const router = express.Router();

// Recording fires on every product view, so the limit is generous; the merge is rarer.
const recordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RECENTLY_VIEWED_RATE_LIMIT || 400),
  message: 'Cok fazla istek. Lutfen biraz sonra tekrar deneyin.',
});

// Recently-viewed history is server-canonical for signed-in customers only; guests keep
// theirs client-side. Every endpoint therefore requires a customer session.
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
  const data = await rv.listRecentlyViewed(client, {
    organizationId: organization.id, customerAccountId: account.id,
    excludeProductId: req.query.exclude ? Number(req.query.exclude) : null,
    limit: req.query.limit,
  });
  return res.json(data);
}));

router.post('/', recordLimiter, (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  await rv.recordView(client, {
    organizationId: organization.id, customerAccountId: account.id,
    productId: req.body.product_id ?? req.body.productId,
  });
  return res.json({ ok: true });
}));

router.delete('/', (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  await rv.clearHistory(client, { organizationId: organization.id, customerAccountId: account.id });
  return res.json({ ok: true });
}));

router.post('/merge', recordLimiter, (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const result = await rv.mergeGuestHistory(client, {
    organizationId: organization.id, customerAccountId: account.id, items: req.body.items,
  });
  return res.json({ ok: true, ...result });
}));

module.exports = router;
