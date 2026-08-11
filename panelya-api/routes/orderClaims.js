const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireCustomerAccount } = require('./customerAuth');
const { rateLimit } = require('../middleware/security');
const { auditLog } = require('../services/audit');
const { logger } = require('../services/logger');
const { sendGuestOrderClaimEmail } = require('../services/email');
const { requestOrderClaim, confirmOrderClaim } = require('../services/orderClaims');

const router = express.Router();

const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ORDER_CLAIM_RATE_LIMIT || 30),
  message: 'Cok fazla siparis baglama denemesi. Lutfen biraz sonra tekrar deneyin.',
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

// One generic response for every request outcome: a caller cannot tell whether the
// order exists, is already linked, or belongs to another account (order enumeration
// defence). The email — only actually sent when a token was issued — goes out after
// commit as fire-and-forget, so it does not change response timing.
const GENERIC_REQUEST_RESPONSE = {
  ok: true,
  message: 'Eger bu siparis kodu gecerliyse, siparisin e-posta adresine bir dogrulama baglantisi gonderildi.',
};

router.post('/claim/request', claimLimiter, async (req, res, next) => {
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

    const result = await requestOrderClaim(client, {
      organizationId: organization.id,
      account,
      orderCodeRaw: req.body && req.body.order_code,
    });
    await client.query('commit');

    // Email only on a real token issue; every branch returns the same body/status.
    if (result.outcome === 'issued') {
      sendGuestOrderClaimEmail({
        to: result.targetEmail,
        token: result.rawToken,
        orderCode: result.order.orderCode,
        organization,
      }).catch((error) => {
        logger.warn({ err: error.message }, 'Siparis baglama e-postasi gonderilemedi');
      });
    }

    res.status(202).json(GENERIC_REQUEST_RESPONSE);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post('/claim/confirm', claimLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const token = String(req.body && req.body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Dogrulama token zorunlu' });

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

    const result = await confirmOrderClaim(client, {
      organizationId: organization.id,
      account,
      tokenHash: sha256(token),
    });

    if (result.outcome === 'conflict') {
      // The user proved control via the emailed token, so a conflict may be surfaced,
      // but never which account holds the order.
      await client.query('commit');
      return res.status(409).json({ error: 'Bu siparis baska bir hesaba bagli.', code: 'ORDER_ALREADY_LINKED' });
    }
    if (result.outcome === 'invalid') {
      await client.query('rollback');
      return res.status(400).json({ error: 'Dogrulama baglantisi gecersiz veya suresi doldu.' });
    }

    await client.query('commit');

    if (result.outcome === 'claimed') {
      await auditLog(req, {
        action: 'CUSTOMER_ORDER_CLAIMED',
        resourceType: 'order',
        resourceId: result.orderId,
        actorType: 'app',
        organizationId: organization.id,
        newValue: { order_code: result.orderCode, customer_account_id: account.id },
      });
    }

    res.json({ ok: true, outcome: result.outcome, order_code: result.orderCode });
  } catch (err) {
    await client.query('rollback').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
