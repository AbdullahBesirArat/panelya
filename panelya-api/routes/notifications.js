const express = require('express');
const db = require('../db');
const { resolveOrganization } = require('../services/tenant');
const { requireCustomerAccount } = require('./customerAuth');
const { rateLimit } = require('../middleware/security');
const service = require('../modules/notifications/service');
const consent = require('../modules/notifications/consent');
const preferences = require('../modules/notifications/preferences');

const router = express.Router();

const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.NOTIFICATION_SUBSCRIBE_RATE_LIMIT || 20),
  message: 'Cok fazla bildirim istegi. Lutfen biraz sonra tekrar deneyin.',
});
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.NOTIFICATION_TOKEN_RATE_LIMIT || 60),
  message: 'Cok fazla deneme. Lutfen biraz sonra tekrar deneyin.',
});

const clientIp = (req) => String(req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
const userAgent = (req) => String(req.get('user-agent') || '').slice(0, 400);

// Run `fn(client, { organization, account })` in a tenant transaction, resolving a
// signed-in customer when a bearer is present and otherwise a public guest actor.
async function withActor(req, res, next, fn, { requireAccount = false } = {}) {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    let organization;
    let account = null;
    try {
      const resolved = await requireCustomerAccount(req, client);
      organization = resolved.organization;
      account = resolved.account;
    } catch (error) {
      if (error.status && error.status !== 401) throw error;
      if (requireAccount) {
        await client.query('rollback');
        return res.status(401).json({ error: 'Musteri oturumu zorunlu', code: 'CUSTOMER_SESSION_REQUIRED' });
      }
      organization = await resolveOrganization(req, client, { allowPublic: true });
      await db.setTenantContext(client, organization.id);
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

// --- Subscriptions --------------------------------------------------------

// Create a back-in-stock / price-drop / favorite subscription. A signed-in customer is
// activated immediately (and consent granted); a guest gets a double opt-in email. The
// response is deliberately generic and never contains the raw confirm/unsubscribe token.
router.post('/subscriptions', subscribeLimiter, (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const created = await service.createSubscription(client, {
    organizationId: organization.id,
    customerAccountId: account ? account.id : null,
    productId: req.body.product_id ?? req.body.productId,
    variantId: req.body.variant_id ?? req.body.variantId ?? null,
    subscriptionType: req.body.subscription_type ?? req.body.type,
    channel: req.body.channel || 'email',
    email: account ? account.email : (req.body.email || ''),
    phone: account ? (account.phone || req.body.phone || '') : (req.body.phone || ''),
    consentGiven: req.body.consent === true || req.body.consent_given === true,
    source: 'storefront',
    policyVersion: String(req.body.policy_version || ''),
  });
  return res.status(201).json({
    ok: true,
    status: created.subscription.status,
    // pending => a confirmation email was sent; active => notifications are live.
    requires_confirmation: created.subscription.status === 'pending',
  });
}));

router.get('/subscriptions', (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const items = await preferences.listSubscriptions(client, {
    organizationId: organization.id,
    customerAccountId: account.id,
    targetHashes: preferences.accountTargetHashes(organization.id, { email: account.email, phone: account.phone }),
  });
  return res.json({ items });
}, { requireAccount: true }));

router.post('/subscriptions/:id/cancel', (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const subscription = await service.cancelSubscription(client, {
    organizationId: organization.id,
    subscriptionId: req.params.id,
    customerAccountId: account.id,
  });
  return res.json({ ok: true, status: subscription.status });
}, { requireAccount: true }));

// Guest confirms a double opt-in link. Token in body only (never a URL query the proxy
// could log). Generic response so a probe cannot enumerate valid tokens.
router.post('/confirm', tokenLimiter, (req, res, next) => withActor(req, res, next, async (client, { organization }) => {
  await service.confirmSubscription(client, { organizationId: organization.id, token: String(req.body.token || '') });
  return res.json({ ok: true });
}));

// Consume an unsubscribe link: unsubscribe + suppress that channel for the recipient.
router.post('/unsubscribe', tokenLimiter, (req, res, next) => withActor(req, res, next, async (client, { organization }) => {
  await service.consumeUnsubscribeToken(client, { organizationId: organization.id, token: String(req.body.token || '') });
  return res.json({ ok: true });
}));

// --- Consent / preference center (signed-in customers only) ---------------

router.get('/preferences', (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const data = await preferences.getPreferences(client, {
    organizationId: organization.id, email: account.email, phone: account.phone,
  });
  return res.json(data);
}, { requireAccount: true }));

router.put('/preferences', subscribeLimiter, (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const applied = await preferences.applyPreferences(client, {
    organizationId: organization.id,
    customerAccountId: account.id,
    email: account.email,
    phone: account.phone,
    changes: req.body.changes,
    ip: clientIp(req),
    userAgent: userAgent(req),
  });
  return res.json({ ok: true, applied });
}, { requireAccount: true }));

router.get('/consents', (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const items = await preferences.listConsents(client, {
    organizationId: organization.id,
    targetHashes: preferences.accountTargetHashes(organization.id, { email: account.email, phone: account.phone }),
  });
  return res.json({ items });
}, { requireAccount: true }));

router.post('/consents/grant', subscribeLimiter, (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const { changed } = await consent.grantConsent(client, {
    organizationId: organization.id,
    customerAccountId: account.id,
    email: account.email,
    phone: account.phone,
    channel: req.body.channel,
    purpose: req.body.purpose,
    source: 'preference_center',
    policyVersion: String(req.body.policy_version || ''),
    ip: clientIp(req),
    userAgent: userAgent(req),
  });
  return res.json({ ok: true, changed });
}, { requireAccount: true }));

router.post('/consents/revoke', subscribeLimiter, (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const { changed } = await consent.revokeConsent(client, {
    organizationId: organization.id,
    email: account.email,
    phone: account.phone,
    channel: req.body.channel,
    purpose: req.body.purpose,
    source: 'preference_center',
    ip: clientIp(req),
    userAgent: userAgent(req),
  });
  return res.json({ ok: true, changed });
}, { requireAccount: true }));

router.post('/marketing/opt-out', subscribeLimiter, (req, res, next) => withActor(req, res, next, async (client, { organization, account }) => {
  const suppressed = await preferences.optOutAllMarketing(client, {
    organizationId: organization.id, email: account.email, phone: account.phone,
  });
  return res.json({ ok: true, suppressed });
}, { requireAccount: true }));

module.exports = router;
