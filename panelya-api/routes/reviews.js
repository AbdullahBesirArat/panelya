const express = require('express');
const db = require('../db');
const { resolveOrganization } = require('../services/tenant');
const { requireCustomerAccount } = require('./customerAuth');
const { rateLimit } = require('../middleware/security');
const reviews = require('../modules/reviews/service');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.REVIEW_WRITE_RATE_LIMIT || 20),
  message: 'Cok fazla yorum denemesi. Lutfen biraz sonra tekrar deneyin.',
});
const voteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.REVIEW_VOTE_RATE_LIMIT || 120),
  message: 'Cok fazla oy denemesi. Lutfen biraz sonra tekrar deneyin.',
});

function guestToken(req) {
  return String(req.get('x-guest-cart-token') || '').trim();
}

// Resolve the actor: a signed-in customer when a valid session is present,
// otherwise the public tenant with a guest actor.
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

function reviewView(row) {
  return {
    id: Number(row.id), rating: row.rating, title: row.title, body: row.body,
    status: row.status, verified_purchase: row.verified_purchase, created_at: row.created_at,
  };
}

router.get('/product/:productId', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const result = await reviews.listReviews(client, {
      organizationId: organization.id, productId: req.params.productId,
      page: req.query.page, pageSize: req.query.page_size, sort: req.query.sort,
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

router.post('/product/:productId', writeLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const { organization, account } = await actorContext(req, client);
    await db.setTenantContext(client, organization.id);
    if (!account) {
      await client.query('rollback');
      return res.status(401).json({ error: 'Yorum icin musteri oturumu zorunlu', code: 'CUSTOMER_SESSION_REQUIRED' });
    }
    const review = await reviews.createReview(client, {
      organizationId: organization.id, customerAccountId: account.id, productId: req.params.productId,
      rating: req.body.rating, title: req.body.title, body: req.body.body,
    });
    await client.query('commit');
    // Pending until a moderator publishes it; the author sees its own pending review.
    return res.status(201).json({ review: reviewView(review), moderation: review.status });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

router.post('/:reviewId/vote', voteLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const { organization, account } = await actorContext(req, client);
    await db.setTenantContext(client, organization.id);
    const hash = reviews.voterHash(organization.id, {
      customerAccountId: account ? account.id : null, guestToken: guestToken(req),
    });
    const counts = await reviews.voteReview(client, {
      organizationId: organization.id, reviewId: req.params.reviewId, voterHash: hash,
      customerAccountId: account ? account.id : null, voteType: req.body.vote_type || req.body.voteType,
    });
    await client.query('commit');
    return res.json(counts);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
