const express = require('express');
const db = require('../db');
const { resolveOrganization } = require('../services/tenant');
const { requireCustomerAccount } = require('./customerAuth');
const { rateLimit } = require('../middleware/security');
const reviews = require('../modules/reviews/service');

const router = express.Router();

const askLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.QUESTION_WRITE_RATE_LIMIT || 20),
  message: 'Cok fazla soru denemesi. Lutfen biraz sonra tekrar deneyin.',
});

async function actorContext(req, client) {
  try {
    const { organization, account } = await requireCustomerAccount(req, client);
    return { organization, account };
  } catch (error) {
    if (error.status && error.status !== 401) throw error;
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    return { organization, account: null };
  }
}

router.get('/product/:productId', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const result = await reviews.listQuestions(client, {
      organizationId: organization.id, productId: req.params.productId,
      page: req.query.page, pageSize: req.query.page_size,
    });
    await client.query('commit');
    res.setHeader('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

router.post('/product/:productId', askLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const { organization, account } = await actorContext(req, client);
    await db.setTenantContext(client, organization.id);
    const question = await reviews.askQuestion(client, {
      organizationId: organization.id, productId: req.params.productId,
      customerAccountId: account ? account.id : null,
      askerName: account ? account.name : (req.body.name || ''),
      contactEmail: account ? account.email : (req.body.email || ''),
      body: req.body.body || req.body.question,
    });
    await client.query('commit');
    return res.status(201).json({ question: { id: Number(question.id), status: question.status }, moderation: question.status });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
