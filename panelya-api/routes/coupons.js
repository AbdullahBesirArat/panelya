const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { resolveOrganization } = require('../services/tenant');
const { priceCartItems, cartTotal } = require('../services/cartPricing');
const { normalizeCheckoutOptions } = require('../services/checkoutPayload');
const { evaluatePromotions } = require('../services/promotionEngine');
const {
  couponPayload,
  createCoupon,
  getCoupon,
  listCoupons,
  updateCoupon,
} = require('../services/coupons');
const { auditLog } = require('../services/audit');

const router = express.Router();
const managerOnly = [requireAuth, requireRole(['super_admin', 'owner', 'admin'])];
const evaluateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.COUPON_EVALUATE_RATE_LIMIT || 30),
  message: 'Cok fazla kupon denemesi. Lutfen biraz sonra tekrar deneyin.',
});

async function evaluateRequest(req, client, organization) {
  const items = await priceCartItems(client, req.body.items, { organizationId: organization.id });
  const subtotal = cartTotal(items);
  const checkout = normalizeCheckoutOptions({ ...req.body, paymentMethod: 'iban' }, organization.store_settings || {}, subtotal);
  const guestEmail = String(req.body.customer?.email || req.body.email || '').trim().toLowerCase();
  const customer = guestEmail ? await client.query(
    `select id from customers where organization_id = $1 and lower(email) = $2 limit 1`,
    [organization.id, guestEmail]
  ) : { rows: [] };
  return evaluatePromotions(client, items, {
    organizationId: organization.id,
    shippingFee: checkout.shippingFee,
    couponCode: req.body.couponCode || req.body.coupon_code || req.body.code || '',
    customerId: customer.rows[0]?.id || null,
    guestEmail,
    checkUsage: true,
  });
}

router.post('/evaluate', evaluateLimiter, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req, db, { allowPublic: true });
    const pricing = await evaluateRequest(req, db, organization);
    res.json({ pricing });
  } catch (error) {
    next(error);
  }
});

router.post('/preview', ...managerOnly, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const pricing = await evaluateRequest(req, db, organization);
    res.json({ pricing });
  } catch (error) {
    next(error);
  }
});

router.get('/admin/all', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    res.json(await listCoupons(db, organization.id));
  } catch (error) {
    next(error);
  }
});

router.post('/', ...managerOnly, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const payload = couponPayload(req.body);
    if (!payload.name) return res.status(400).json({ error: 'Kupon adi zorunlu' });
    await client.query('begin');
    const organization = await resolveOrganization(req, client);
    await db.setTenantContext(client, organization.id);
    const coupon = await createCoupon(client, organization.id, payload, req.auth?.userId || null);
    await client.query('commit');
    await auditLog(req, { action: 'CREATE', resourceType: 'coupon', resourceId: coupon.id, newValue: coupon });
    res.status(201).json(coupon);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'Bu kupon kodu zaten kullaniliyor' });
    next(error);
  } finally {
    client.release();
  }
});

router.get('/:id/redemptions', requireAuth, requireRole(['super_admin', 'owner', 'admin', 'member', 'viewer']), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const coupon = await getCoupon(db, organization.id, req.params.id);
    if (!coupon) return res.status(404).json({ error: 'Kupon bulunamadi' });
    const result = await db.query(
      `select redemption.*, orders.order_code, customers.name as customer_name, customers.email
         from coupon_redemptions redemption
         join orders on orders.organization_id = redemption.organization_id and orders.id = redemption.order_id
         left join customers on customers.organization_id = redemption.organization_id and customers.id = redemption.customer_id
        where redemption.organization_id = $1 and redemption.coupon_id = $2
        order by redemption.created_at desc limit 200`,
      [organization.id, req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', ...managerOnly, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const payload = couponPayload(req.body);
    if (!payload.name) return res.status(400).json({ error: 'Kupon adi zorunlu' });
    await client.query('begin');
    const organization = await resolveOrganization(req, client);
    await db.setTenantContext(client, organization.id);
    const previous = await getCoupon(client, organization.id, req.params.id);
    const coupon = await updateCoupon(client, organization.id, req.params.id, payload);
    if (!coupon) {
      await client.query('rollback');
      return res.status(404).json({ error: 'Kupon bulunamadi' });
    }
    await client.query('commit');
    await auditLog(req, { action: 'UPDATE', resourceType: 'coupon', resourceId: coupon.id, oldValue: previous, newValue: coupon });
    res.json(coupon);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    if (error.code === '23505') return res.status(409).json({ error: 'Bu kupon kodu zaten kullaniliyor' });
    next(error);
  } finally {
    client.release();
  }
});

router.delete('/:id', ...managerOnly, async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `update coupons set status = 'inactive', updated_at = now()
        where organization_id = $1 and id = $2 returning *`,
      [organization.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Kupon bulunamadi' });
    await auditLog(req, { action: 'DEACTIVATE', resourceType: 'coupon', resourceId: req.params.id, newValue: { status: 'inactive' } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
