const express = require('express');
const db = require('../db');
const { resolveOrganization } = require('../services/tenant');
const { requireCustomerAccount } = require('./customerAuth');
const { rateLimit } = require('../middleware/security');
const cart = require('../modules/cart/service');
const giftWrap = require('../modules/cart/giftWrap');

const router = express.Router();

// Tighter than the global limiter: throttle recovery-link redemption so a leaked
// link cannot be probed at high volume (the token itself is 256-bit).
const recoverLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.CART_RECOVERY_RATE_LIMIT || 30),
  message: 'Cok fazla kurtarma denemesi. Lutfen biraz sonra tekrar deneyin.',
});

const EMPTY_CART = Object.freeze({
  id: null, status: 'active', version: 0, currency: 'TRY', item_count: 0,
  subtotal: 0, discount_total: 0, shipping_total: 0, tax_total: 0, grand_total: 0,
  coupon_code: '', coupon_applied: false, items: [], adjustments: [],
  gift_wrap_fee: 0,
  gift_wrap: {
    option_id: null, title: '', description: '', fee: 0, currency: 'TRY',
    note: '', max_note_length: giftWrap.MAX_GIFT_NOTE,
  },
});

// Storefront requests are public with an organization slug; a Bearer session
// (when present) identifies the customer, otherwise the actor is a guest.
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

function guestToken(req) {
  return String(req.get('x-guest-cart-token') || '').trim();
}

function expectedVersion(req) {
  const raw = req.get('if-match') != null ? req.get('if-match') : req.body?.version;
  if (raw == null || raw === '') return null;
  const value = Number(String(raw).replace(/^W\//, '').replace(/"/g, '').trim());
  return Number.isFinite(value) ? value : null;
}

function sendCart(res, view, rawToken, status) {
  const body = { cart: view };
  if (rawToken != null) body.guest_cart_token = rawToken; // proxy moves this into an HttpOnly cookie
  if (view && view.version != null) res.setHeader('ETag', `"${view.version}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

// Tenant-scoped transactional wrapper. `create` decides whether a missing cart is
// created (mutations) or treated as empty (reads). `run` receives req + context.
function cartRoute({ create, run, successStatus = 200 }) {
  return async (req, res, next) => {
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      const { organization, account } = await actorContext(req, client);
      await db.setTenantContext(client, organization.id);
      const resolved = await cart.resolveCart(client, {
        organizationId: organization.id,
        customerAccountId: account ? account.id : null,
        guestToken: guestToken(req),
        create,
      });
      if (!resolved.cart) {
        await client.query('commit');
        return sendCart(res, EMPTY_CART, null, 200);
      }
      const result = await run({ req, client, organizationId: organization.id, account, cart: resolved.cart });
      await client.query('commit');
      return sendCart(res, result.view, resolved.rawToken || null, result.status || successStatus);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      return next(error);
    } finally {
      client.release();
    }
  };
}

router.get('/', cartRoute({
  create: false,
  run: ({ client, organizationId, cart: current }) => cart.viewCart(client, { organizationId, cart: current }),
}));

router.post('/items', cartRoute({
  create: true, successStatus: 201,
  run: ({ req, client, organizationId, cart: current }) => cart.addItem(client, {
    organizationId, cart: current, expectedVersion: expectedVersion(req),
    productId: req.body.product_id, variantId: req.body.variant_id, quantity: req.body.quantity || 1,
  }),
}));

router.patch('/items/:variantId', cartRoute({
  create: false,
  run: ({ req, client, organizationId, cart: current }) => cart.setItemQuantity(client, {
    organizationId, cart: current, expectedVersion: expectedVersion(req),
    variantId: req.params.variantId, quantity: req.body.quantity,
  }),
}));

router.delete('/items/:variantId', cartRoute({
  create: false,
  run: ({ req, client, organizationId, cart: current }) => cart.removeItem(client, {
    organizationId, cart: current, expectedVersion: expectedVersion(req),
    variantId: req.params.variantId,
  }),
}));

router.post('/clear', cartRoute({
  create: false,
  run: ({ req, client, organizationId, cart: current }) => cart.clearCart(client, {
    organizationId, cart: current, expectedVersion: expectedVersion(req),
  }),
}));

router.post('/coupon', cartRoute({
  create: false,
  run: ({ req, client, organizationId, cart: current }) => cart.applyCoupon(client, {
    organizationId, cart: current, expectedVersion: expectedVersion(req),
    couponCode: req.body.coupon_code || req.body.couponCode,
  }),
}));

router.delete('/coupon', cartRoute({
  create: false,
  run: ({ req, client, organizationId, cart: current }) => cart.removeCoupon(client, {
    organizationId, cart: current, expectedVersion: expectedVersion(req),
  }),
}));

// A24.5: the tenant's selectable gift-wrap options. Public (checkout is reachable as a
// guest) and read-only; the fee shown here is the same server value the cart applies.
router.get('/gift-options', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    // setTenantContext is transaction-local, so the read must run inside one or RLS
    // sees no organization at all and every row is filtered out.
    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const options = await giftWrap.listActiveOptions(client, { organizationId: organization.id });
    await client.query('commit');
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ options, max_note_length: giftWrap.MAX_GIFT_NOTE });
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

// Set/change the gift-wrap option and/or the gift note. Absent fields stay as they are,
// so "change the wrap", "write a note", "clear the note" are all this one call.
router.put('/gift-wrap', cartRoute({
  create: false,
  run: ({ req, client, organizationId, cart: current }) => cart.setGiftWrap(client, {
    organizationId, cart: current, expectedVersion: expectedVersion(req),
    optionId: req.body.gift_wrap_option_id !== undefined ? req.body.gift_wrap_option_id : req.body.option_id,
    note: req.body.gift_note !== undefined ? req.body.gift_note : req.body.note,
    hasOption: req.body.gift_wrap_option_id !== undefined || req.body.option_id !== undefined,
    hasNote: req.body.gift_note !== undefined || req.body.note !== undefined,
  }),
}));

router.delete('/gift-wrap', cartRoute({
  create: false,
  run: ({ req, client, organizationId, cart: current }) => cart.clearGiftWrap(client, {
    organizationId, cart: current, expectedVersion: expectedVersion(req),
  }),
}));

// Merge the guest cart into the authenticated customer cart. Requires a customer
// session; the guest token comes from the proxy-managed header and is revoked.
router.post('/merge', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const { organization, account } = await actorContext(req, client);
    if (!account) {
      await client.query('rollback');
      return res.status(401).json({ error: 'Musteri oturumu zorunlu', code: 'CUSTOMER_SESSION_REQUIRED' });
    }
    await db.setTenantContext(client, organization.id);
    const result = await cart.mergeGuestIntoCustomer(client, {
      organizationId: organization.id, customerAccountId: account.id, guestToken: guestToken(req),
    });
    await client.query('commit');
    return sendCart(res, result.view, '', 200); // empty token clears the revoked guest cookie
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

// Redeem an abandoned-cart recovery link: validate the opaque token, reactivate the
// cart with a freshly rotated guest token, and hand the raw token to the proxy so it
// lands in the HttpOnly guest-cart cookie (never in the response the browser reads).
router.post('/recover', recoverLimiter, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const organization = await resolveOrganization(req, client, { allowPublic: true });
    await db.setTenantContext(client, organization.id);
    const token = String(req.body?.token || req.body?.recovery_token || '').trim();
    const result = await cart.recoverCartByToken(client, { organizationId: organization.id, recoveryToken: token });
    await client.query('commit');
    return sendCart(res, result.view, result.rawToken, 200);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
