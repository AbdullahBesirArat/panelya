const express = require('express');
const db = require('../db');
const { requireCustomerAccount } = require('./customerAuth');
const { rateLimit } = require('../middleware/security');
const {
  normalizeAddressInput,
  listAddresses,
  createAddress,
  updateAddress,
  softDeleteAddress,
  setDefaultAddress,
} = require('../services/customerAddresses');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.CUSTOMER_ADDRESS_RATE_LIMIT || 120),
  message: 'Cok fazla adres islemi. Lutfen biraz sonra tekrar deneyin.',
});

// The address book is server-canonical for signed-in customers only. Every endpoint
// requires a customer session; the session resolves tenant + account and sets the RLS
// context on the transaction client, and the service also scopes every query by
// organization_id + customer_account_id (defence in depth against IDOR).
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
    await fn(client, { organization, account });
    await client.query('commit');
    res.setHeader('Cache-Control', 'no-store');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
}

function parseAddressId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('Adres bulunamadi.'), { status: 404 });
  }
  return id;
}

router.get('/', (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const addresses = await listAddresses(client, { organizationId: organization.id, customerAccountId: account.id });
  res.json({ addresses });
}));

router.post('/', writeLimiter, (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const input = normalizeAddressInput(req.body || {});
  const address = await createAddress(client, { organizationId: organization.id, customerAccountId: account.id, input });
  res.status(201).json({ address });
}));

router.put('/:id', writeLimiter, (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const addressId = parseAddressId(req.params.id);
  const input = normalizeAddressInput(req.body || {});
  const address = await updateAddress(client, { organizationId: organization.id, customerAccountId: account.id, addressId, input });
  res.json({ address });
}));

router.delete('/:id', writeLimiter, (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const addressId = parseAddressId(req.params.id);
  const result = await softDeleteAddress(client, { organizationId: organization.id, customerAccountId: account.id, addressId });
  res.json({ ok: true, ...result });
}));

router.post('/:id/default', writeLimiter, (req, res, next) => withCustomer(req, res, next, async (client, { organization, account }) => {
  const addressId = parseAddressId(req.params.id);
  const kind = String(req.body && req.body.kind || 'shipping').trim().toLowerCase();
  if (!['shipping', 'billing'].includes(kind)) {
    throw Object.assign(new Error('Varsayilan turu gecersiz.'), { status: 400 });
  }
  const address = await setDefaultAddress(client, { organizationId: organization.id, customerAccountId: account.id, addressId, kind });
  res.json({ address });
}));

module.exports = router;
