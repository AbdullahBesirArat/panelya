const express = require('express');
const db = require('../db');
const { rateLimit } = require('../middleware/security');
const { resolveOrganization } = require('../services/tenant');

const router = express.Router();
const wishlistLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.WISHLIST_RATE_LIMIT || 120),
  message: 'Cok fazla favori islemi. Lutfen biraz sonra tekrar deneyin.',
});

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase().slice(0, 254);
  if (!email || !email.includes('@')) {
    throw Object.assign(new Error('Email zorunlu'), { status: 400 });
  }
  return email;
}

function normalizeProductId(value) {
  const productId = Number(value);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw Object.assign(new Error('Urun gecersiz'), { status: 400 });
  }
  return productId;
}

router.get('/', wishlistLimiter, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: true });
    const email = normalizeEmail(req.query.email);
    const result = await db.query(
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
      [organization.id, email]
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', wishlistLimiter, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: true });
    const email = normalizeEmail(req.body.email);
    const productId = normalizeProductId(req.body.productId || req.body.product_id);
    const product = await db.query(
      `select id
       from products
       where id = $1 and organization_id = $2 and coalesce(status, 'active') <> 'deleted'
       limit 1`,
      [productId, organization.id]
    );

    if (!product.rows[0]) {
      return res.status(404).json({ error: 'Urun bulunamadi' });
    }

    await db.query(
      `insert into customer_wishlist (organization_id, customer_email, product_id)
       values ($1, $2, $3)
       on conflict (organization_id, customer_email, product_id) do nothing`,
      [organization.id, email, productId]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:productId', wishlistLimiter, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: true });
    const email = normalizeEmail(req.query.email || req.body?.email);
    const productId = normalizeProductId(req.params.productId);
    await db.query(
      `delete from customer_wishlist
       where organization_id = $1 and lower(customer_email) = $2 and product_id = $3`,
      [organization.id, email, productId]
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
