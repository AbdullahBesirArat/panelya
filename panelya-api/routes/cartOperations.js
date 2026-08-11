const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { resolveOrganization } = require('../services/tenant');
const { generateToken, hashToken } = require('../modules/cart/token');
const { cancelCart } = require('../modules/cart/service');

const router = express.Router();
const READ_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_LINK_TTL_HOURS = 72;

function cartId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!UUID.test(id)) throw Object.assign(new Error('Sepet id gecersiz'), { status: 400, code: 'INVALID_CART_ID' });
  return id;
}

function actorId(req) {
  return req.auth?.actorType === 'app' ? req.auth.sub : null;
}

router.get('/', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim().slice(0, 160);
    const params = [organization.id];
    const filters = [];
    if (['active', 'abandoned', 'converted', 'expired', 'merged', 'cancelled'].includes(status)) {
      params.push(status);
      filters.push(`c.status = $${params.length}`);
    }
    if (req.query.owner === 'guest') filters.push('c.customer_account_id is null');
    if (req.query.owner === 'customer') filters.push('c.customer_account_id is not null');
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      filters.push(`(lower(coalesce(c.contact_email, '')) like $${params.length} or lower(coalesce(ca.email, '')) like $${params.length})`);
    }
    if (req.query.from) { params.push(req.query.from); filters.push(`c.created_at >= $${params.length}`); }
    if (req.query.to) { params.push(req.query.to); filters.push(`c.created_at <= $${params.length}`); }

    const result = await db.query(
      `select c.id, c.status, c.version, c.item_count, c.subtotal, c.discount_total,
         c.grand_total, c.currency, c.coupon_code, c.customer_account_id is not null as is_customer,
         c.contact_email, c.recovery_consent, c.recovery_sent_count, c.last_activity_at,
         c.abandoned_at, c.recovered_at, c.converted_order_id, c.created_at,
         ca.email as customer_email, ca.name as customer_name
       from carts c
       left join customer_accounts ca
         on ca.organization_id = c.organization_id and ca.id = c.customer_account_id
       where c.organization_id = $1${filters.length ? ` and ${filters.join(' and ')}` : ''}
       order by c.last_activity_at desc limit 200`,
      params
    );
    res.json(result.rows);
  } catch (error) { next(error); }
});

router.get('/metrics', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const result = await db.query(
      `select
         count(*) filter (where status = 'active')::int as active,
         count(*) filter (where status = 'abandoned')::int as abandoned,
         count(*) filter (where status = 'converted')::int as converted,
         count(*) filter (where recovered_at is not null)::int as recovered,
         coalesce(sum(grand_total) filter (where status = 'abandoned'), 0)::numeric as abandoned_value
       from carts where organization_id = $1`,
      [organization.id]
    );
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

router.get('/:id', requireAuth, requireRole(READ_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const id = cartId(req.params.id);
    const cartResult = await db.query(
      `select c.*, ca.email as customer_email, ca.name as customer_name,
         c.customer_account_id is not null as is_customer
       from carts c
       left join customer_accounts ca
         on ca.organization_id = c.organization_id and ca.id = c.customer_account_id
       where c.organization_id = $1 and c.id = $2`,
      [organization.id, id]
    );
    const cart = cartResult.rows[0];
    if (!cart) return res.status(404).json({ error: 'Sepet bulunamadi' });
    delete cart.guest_token_hash; // never expose the hashed token to the panel

    const [items, events, outbox] = await Promise.all([
      db.query(
        `select product_id, variant_id, quantity, unit_price_snapshot, line_total_snapshot,
           product_name_snapshot, sku_snapshot, color_snapshot, size_snapshot
         from cart_items where organization_id = $1 and cart_id = $2 order by id`,
        [organization.id, id]
      ),
      db.query(
        `select event_type, metadata, occurred_at from cart_events
         where organization_id = $1 and cart_id = $2 order by occurred_at desc, id desc limit 100`,
        [organization.id, id]
      ),
      db.query(
        `select id, channel, status, attempts, sent_at, suppressed_reason, recovery_expires_at, created_at
         from cart_recovery_outbox where organization_id = $1 and cart_id = $2 order by id desc`,
        [organization.id, id]
      ),
    ]);
    res.json({ cart, items: items.rows, events: events.rows, recovery: outbox.rows });
  } catch (error) { next(error); }
});

router.post('/:id/cancel', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const cart = await cancelCart(db, {
      organizationId: organization.id, cartId: cartId(req.params.id),
      actorId: actorId(req), reason: String(req.body?.reason || '').slice(0, 200),
    });
    res.json({ id: cart.id, status: cart.status });
  } catch (error) { next(error); }
});

router.post('/:id/suppress', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const id = cartId(req.params.id);
    const result = await db.query(
      `update cart_recovery_outbox set status = 'suppressed', suppressed_reason = 'admin_suppressed', updated_at = now()
       where organization_id = $1 and cart_id = $2 and status in ('pending','processing','failed') returning id`,
      [organization.id, id]
    );
    await db.query(
      `insert into cart_events (organization_id, cart_id, event_type, metadata)
       values ($1,$2,'cancelled',$3::jsonb)`,
      [organization.id, id, JSON.stringify({ action: 'suppress_reminders', actor_id: actorId(req), suppressed: result.rowCount })]
    );
    res.json({ suppressed: result.rowCount });
  } catch (error) { next(error); }
});

// Generate a one-time recovery link the operator can deliver manually. Only the
// hash is stored; the raw token is returned exactly once.
router.post('/:id/recovery-link', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const id = cartId(req.params.id);
    const cartResult = await db.query(
      "select status, item_count from carts where organization_id = $1 and id = $2",
      [organization.id, id]
    );
    const cart = cartResult.rows[0];
    if (!cart) return res.status(404).json({ error: 'Sepet bulunamadi' });
    if (!['active', 'abandoned'].includes(cart.status) || cart.item_count <= 0) {
      return res.status(409).json({ error: 'Bu sepet icin kurtarma baglantisi olusturulamaz', code: 'RECOVERY_NOT_ALLOWED' });
    }
    const rawToken = generateToken();
    const event = await db.query(
      `insert into cart_events (organization_id, cart_id, event_type, metadata)
       values ($1,$2,'recovery_sent',$3::jsonb) returning id`,
      [organization.id, id, JSON.stringify({ manual: true, actor_id: actorId(req) })]
    );
    await db.query(
      `insert into cart_recovery_outbox
        (organization_id, cart_id, event_id, channel, status, recovery_token_hash, recovery_expires_at, sent_at, payload)
       values ($1,$2,$3,'email','sent',$4, now() + make_interval(hours => $5), now(), $6::jsonb)`,
      [organization.id, id, event.rows[0].id, hashToken(rawToken), RECOVERY_LINK_TTL_HOURS,
        JSON.stringify({ manual: true })]
    );
    res.status(201).json({ recovery_token: rawToken, expires_in_hours: RECOVERY_LINK_TTL_HOURS });
  } catch (error) { next(error); }
});

module.exports = router;
