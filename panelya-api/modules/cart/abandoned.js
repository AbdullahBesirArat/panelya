const db = require('../../db');
const { generateToken, hashToken } = require('./token');
const { logCartEvent } = require('./service');

const RECOVERY_TOKEN_TTL_HOURS = 72;
const MIN_INACTIVITY_MINUTES = 15;

// A23 registers the real notification delivery here. Until then the outbox is
// populated but never auto-delivered — no silent mock fallback in production.
let deliveryAdapter = null;
let running = false;

function setCartRecoveryDelivery(adapter) {
  deliveryAdapter = typeof adapter === 'function' ? adapter : null;
}

function abandonSettings(storeSettings) {
  const cfg = (storeSettings && storeSettings.abandoned_cart) || {};
  return {
    enabled: cfg.enabled === true,
    inactivityMinutes: Math.max(MIN_INACTIVITY_MINUTES, Math.min(Number(cfg.inactivity_minutes) || 60, 10080)),
    maxReminders: Math.max(1, Math.min(Number(cfg.max_reminders) || 1, 5)),
    cooldownHours: Math.max(1, Math.min(Number(cfg.cooldown_hours) || 24, 720)),
  };
}

async function orgStoreSettings(client, organizationId) {
  const result = await client.query('select store_settings from organizations where id = $1', [organizationId]);
  return result.rows[0]?.store_settings || {};
}

function inactiveFor(cart, minutes) {
  return Date.now() - new Date(cart.last_activity_at).getTime() >= minutes * 60_000;
}

// Scan for consent-eligible inactive carts and schedule (at most one per cooldown)
// a pending recovery outbox row. Cross-tenant scan runs on the system pool; each
// cart is then locked and re-checked inside its own tenant context.
async function evaluateAbandonedCarts({ limit = 50 } = {}) {
  const candidates = await db.systemQuery(
    `select id, organization_id from carts
      where status in ('active','abandoned') and item_count > 0
        and recovery_consent = true and contact_email is not null
        and last_activity_at < now() - make_interval(mins => $1)
      order by last_activity_at limit $2`,
    [MIN_INACTIVITY_MINUTES, Math.max(1, Math.min(Number(limit) || 50, 200))]
  );

  let scheduled = 0;
  for (const candidate of candidates.rows) {
    const created = await db.withTenantContext(candidate.organization_id, async (client) => {
      const locked = await client.query(
        `select * from carts where organization_id = $1 and id = $2 for update skip locked`,
        [candidate.organization_id, candidate.id]
      );
      const cart = locked.rows[0];
      if (!cart || cart.item_count <= 0 || !cart.recovery_consent || !cart.contact_email) return false;
      if (!['active', 'abandoned'].includes(cart.status)) return false;

      const settings = abandonSettings(await orgStoreSettings(client, cart.organization_id));
      if (!settings.enabled || !inactiveFor(cart, settings.inactivityMinutes)) return false;

      if (cart.status === 'active') {
        await client.query(
          `update carts set status = 'abandoned', abandoned_at = now(), updated_at = now()
           where organization_id = $1 and id = $2`,
          [cart.organization_id, cart.id]
        );
      }

      if (cart.recovery_sent_count >= settings.maxReminders) return false;
      if (cart.last_recovery_at
          && Date.now() - new Date(cart.last_recovery_at).getTime() < settings.cooldownHours * 3_600_000) {
        return false;
      }
      const pending = await client.query(
        `select 1 from cart_recovery_outbox where organization_id = $1 and cart_id = $2
           and status in ('pending','processing') limit 1`,
        [cart.organization_id, cart.id]
      );
      if (pending.rows[0]) return false;

      const eventResult = await client.query(
        `insert into cart_events (organization_id, cart_id, customer_account_id, event_type, metadata)
         values ($1,$2,$3,'abandoned',$4::jsonb) returning id`,
        [cart.organization_id, cart.id, cart.customer_account_id,
          JSON.stringify({ reminder: cart.recovery_sent_count + 1 })]
      );
      await client.query(
        `insert into cart_recovery_outbox
          (organization_id, cart_id, event_id, channel, payload)
         values ($1,$2,$3,'email',$4::jsonb)`,
        [cart.organization_id, cart.id, eventResult.rows[0].id,
          JSON.stringify({ item_count: cart.item_count, grand_total: Number(cart.grand_total) })]
      );
      return true;
    });
    if (created) scheduled += 1;
  }
  return scheduled;
}

function backoffInterval(attempts) {
  return `${Math.min(60, 2 ** Math.min(attempts, 6))} minutes`;
}

// Deliver pending recovery rows. The raw recovery token is minted here (only its
// hash is persisted) and handed to the delivery adapter, so tokens never rest in
// the database. Without an adapter the rows stay pending for A23 to drain.
async function processCartRecoveryOutbox({ maxRows = 25, deliver = deliveryAdapter } = {}) {
  if (!deliver) return { delivered: 0, failed: 0, skipped: true };
  let delivered = 0;
  let failed = 0;

  for (let processedRows = 0; processedRows < maxRows; processedRows += 1) {
    const claimed = await db.systemQuery(
      `update cart_recovery_outbox
         set status = 'processing', claimed_at = now(), updated_at = now()
       where id = (
         select id from cart_recovery_outbox
          where status in ('pending','failed') and next_attempt_at <= now()
          order by next_attempt_at, id for update skip locked limit 1
       )
       returning *`,
      []
    );
    const row = claimed.rows[0];
    if (!row) break;

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    try {
      await db.withTenantContext(row.organization_id, async (client) => {
        const cartResult = await client.query(
          'select id, status, contact_email, item_count from carts where organization_id = $1 and id = $2',
          [row.organization_id, row.cart_id]
        );
        const cart = cartResult.rows[0];
        if (!cart || cart.status !== 'abandoned' || cart.item_count <= 0 || !cart.contact_email) {
          await client.query(
            `update cart_recovery_outbox set status = 'suppressed', suppressed_reason = 'cart_not_recoverable', updated_at = now()
             where organization_id = $1 and id = $2`,
            [row.organization_id, row.id]
          );
          return;
        }
        await client.query(
          `update cart_recovery_outbox set recovery_token_hash = $3,
             recovery_expires_at = now() + make_interval(hours => $4), updated_at = now()
           where organization_id = $1 and id = $2`,
          [row.organization_id, row.id, tokenHash, RECOVERY_TOKEN_TTL_HOURS]
        );
        await deliver({
          organizationId: row.organization_id,
          cartId: row.cart_id,
          channel: row.channel,
          recoveryToken: rawToken,
          contactEmail: cart.contact_email,
          payload: row.payload || {},
        });
        await client.query(
          `update cart_recovery_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, updated_at = now()
           where organization_id = $1 and id = $2`,
          [row.organization_id, row.id]
        );
        await client.query(
          `update carts set recovery_sent_count = recovery_sent_count + 1, last_recovery_at = now(), updated_at = now()
           where organization_id = $1 and id = $2`,
          [row.organization_id, row.cart_id]
        );
        await logCartEvent(client, {
          organizationId: row.organization_id, cartId: row.cart_id,
          eventType: 'recovery_sent', metadata: { channel: row.channel, outbox_id: row.id },
        });
      });
      delivered += 1;
    } catch (error) {
      failed += 1;
      await db.systemQuery(
        `update cart_recovery_outbox
           set status = case when attempts + 1 >= 10 then 'failed' else 'failed' end,
               attempts = attempts + 1, last_error = $3,
               next_attempt_at = now() + ($4)::interval, updated_at = now()
         where id = $1 and organization_id = $2`,
        [row.id, row.organization_id, String(error.message || 'delivery failed').slice(0, 500), backoffInterval(row.attempts + 1)]
      );
    }
  }
  return { delivered, failed, skipped: false };
}

// Sweep carts past their expiry into a terminal 'expired' state.
async function expireStaleCarts({ limit = 200 } = {}) {
  const result = await db.systemQuery(
    `update carts set status = 'expired', updated_at = now()
      where id in (
        select id from carts where status in ('active','abandoned') and expires_at < now()
        order by expires_at limit $1 for update skip locked
      )
      returning id`,
    [Math.max(1, Math.min(Number(limit) || 200, 1000))]
  );
  return result.rowCount;
}

async function runAbandonedCartCycle() {
  if (running) return;
  running = true;
  try {
    await evaluateAbandonedCarts();
    await expireStaleCarts();
    if (deliveryAdapter) await processCartRecoveryOutbox({ deliver: deliveryAdapter });
  } catch (error) {
    console.warn(`Abandoned cart worker hatasi: ${error.message}`);
  } finally {
    running = false;
  }
}

function startAbandonedCartWorker() {
  if (process.env.NODE_ENV === 'test' || process.env.CART_WORKER_ENABLED === 'false') return null;
  const intervalMs = Math.max(30_000, Math.min(Number(process.env.CART_WORKER_INTERVAL_MS) || 300_000, 3_600_000));
  const interval = setInterval(runAbandonedCartCycle, intervalMs);
  interval.unref();
  return interval;
}

module.exports = {
  setCartRecoveryDelivery,
  abandonSettings,
  evaluateAbandonedCarts,
  processCartRecoveryOutbox,
  expireStaleCarts,
  runAbandonedCartCycle,
  startAbandonedCartWorker,
};
