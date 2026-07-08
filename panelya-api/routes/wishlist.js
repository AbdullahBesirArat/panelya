const express = require('express');
const db = require('../db');
const { rateLimit } = require('../middleware/security');
const customerAuth = require('./customerAuth');

const router = express.Router();
const wishlistLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.WISHLIST_RATE_LIMIT || 120),
  message: 'Cok fazla favori islemi. Lutfen biraz sonra tekrar deneyin.',
});

function normalizeProductId(value) {
  const productId = Number(value);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw Object.assign(new Error('Urun gecersiz'), { status: 400 });
  }
  return productId;
}

function sessionCustomerEmail(account) {
  const email = String(account?.email || '').trim().toLowerCase().slice(0, 254);
  if (!email || !email.includes('@')) {
    throw Object.assign(new Error('Musteri oturumu gecersiz'), { status: 401 });
  }
  return email;
}

async function wishlistContext(req, client = db) {
  const { organization, account } = await customerAuth.requireCustomerAccount(req, client);
  return {
    organizationId: organization.id,
    customerEmail: sessionCustomerEmail(account),
  };
}

async function listWishlistItems(client, { organizationId, customerEmail }) {
  const email = sessionCustomerEmail({ email: customerEmail });
  const result = await client.query(
    `select
      w.product_id as id,
      p.name,
      p.price,
      coalesce(p.images->>0, '') as image,
      c.name as category,
      w.created_at as added_at
     from customer_wishlist w
     join products p on p.id = w.product_id and p.organization_id = w.organization_id
     left join categories c on c.id = p.category_id and c.organization_id = p.organization_id
     where w.organization_id = $1
       and lower(w.customer_email) = $2
       and coalesce(p.status, 'active') <> 'deleted'
     order by w.created_at desc
     limit 100`,
    [organizationId, email]
  );
  return result.rows;
}

async function addWishlistItem(client, { organizationId, customerEmail, productId }) {
  const email = sessionCustomerEmail({ email: customerEmail });
  const normalizedProductId = normalizeProductId(productId);
  const product = await client.query(
    `select id
     from products
     where id = $1 and organization_id = $2 and coalesce(status, 'active') <> 'deleted'
     limit 1`,
    [normalizedProductId, organizationId]
  );

  if (!product.rows[0]) {
    throw Object.assign(new Error('Urun bulunamadi'), { status: 404 });
  }

  await client.query(
    `insert into customer_wishlist (organization_id, customer_email, product_id)
     values ($1, $2, $3)
     on conflict (organization_id, customer_email, product_id) do nothing`,
    [organizationId, email, normalizedProductId]
  );
}

async function removeWishlistItem(client, { organizationId, customerEmail, productId }) {
  const email = sessionCustomerEmail({ email: customerEmail });
  const normalizedProductId = normalizeProductId(productId);
  await client.query(
    `delete from customer_wishlist
     where organization_id = $1 and lower(customer_email) = $2 and product_id = $3`,
    [organizationId, email, normalizedProductId]
  );
}

router.get('/', wishlistLimiter, async (req, res, next) => {
  try {
    const context = await wishlistContext(req, db);
    const rows = await listWishlistItems(db, context);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', wishlistLimiter, async (req, res, next) => {
  try {
    const context = await wishlistContext(req, db);
    await addWishlistItem(db, {
      ...context,
      productId: req.body.productId || req.body.product_id,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.delete('/:productId', wishlistLimiter, async (req, res, next) => {
  try {
    const context = await wishlistContext(req, db);
    await removeWishlistItem(db, {
      ...context,
      productId: req.params.productId,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.sessionCustomerEmail = sessionCustomerEmail;
router.listWishlistItems = listWishlistItems;
router.addWishlistItem = addWishlistItem;
router.removeWishlistItem = removeWishlistItem;

module.exports = router;
