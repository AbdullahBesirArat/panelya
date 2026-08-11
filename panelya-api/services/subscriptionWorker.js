'use strict';

// A26 subscription lifecycle sweep.
//
// Deliberately NOT a new queue: reminders go through the A23 notification outbox (its
// worker, retries, suppression and dead-lettering are reused), and this module only does
// the time-based state sweep the outbox cannot do for itself.
//
// Every step is idempotent and claims rows with FOR UPDATE SKIP LOCKED, so two workers
// running concurrently split the work instead of both processing the same subscription.
// All deadlines are compared in the database against now() — UTC, never a JS clock — so a
// worker in another timezone cannot expire a trial early or late.

const db = require('../db');
const lifecycle = require('./subscriptionLifecycle');
const notifications = require('../modules/notifications/service');

const GRACE_DAYS = Math.min(Math.max(Number(process.env.SUBSCRIPTION_GRACE_DAYS || 7), 1), 60);
const PAST_DUE_GRACE_AFTER_DAYS = Math.min(Math.max(Number(process.env.SUBSCRIPTION_PAST_DUE_DAYS || 3), 0), 60);
const TRIAL_REMINDER_DAYS = Math.min(Math.max(Number(process.env.SUBSCRIPTION_TRIAL_REMINDER_DAYS || 3), 1), 30);
const BATCH = Math.min(Math.max(Number(process.env.SUBSCRIPTION_WORKER_BATCH || 25), 1), 200);

// Claims one subscription matching `predicate` and runs `apply` inside its transaction.
// Returns null when there is nothing to claim.
async function claimOne(pool, { predicate, params, apply }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claimed = await client.query(
      `select * from subscriptions
        where ${predicate}
        order by updated_at nulls first, id
        for update skip locked
        limit 1`,
      params
    );
    const subscription = claimed.rows[0];
    if (!subscription) {
      await client.query('rollback');
      return null;
    }
    const result = await apply(client, subscription);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ownerEmail(client, organizationId) {
  const result = await client.query(
    `select u.email
       from memberships m
       join app_users u on u.id = m.user_id
      where m.organization_id = $1 and m.role = 'owner' and m.status = 'active'
      order by m.created_at asc
      limit 1`,
    [organizationId]
  );
  return result.rows[0]?.email || null;
}

// A trial whose end has passed becomes 'expired'. Data is untouched: expiry withdraws
// write access through the entitlement policy, it never deletes or deactivates anything.
async function expireDueTrials(pool = db.getSystemPool(), { limit = BATCH } = {}) {
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const done = await claimOne(pool, {
      predicate: "status = 'trialing' and trial_end is not null and trial_end <= now()",
      params: [],
      apply: async (client, subscription) => {
        await client.query("select set_config('app.current_organization_id', $1, true)", [subscription.organization_id]);
        await lifecycle.transitionSubscription(client, {
          organizationId: subscription.organization_id,
          subscriptionId: subscription.id,
          to: 'expired',
          reason: 'trial period ended',
          actorType: 'system',
        });
        await client.query(
          `update organization_trials set outcome = 'expired', resolved_at = now(), updated_at = now()
            where organization_id = $1 and outcome = 'running'`,
          [subscription.organization_id]
        );
        const email = await ownerEmail(client, subscription.organization_id);
        if (email) {
          await notifications.enqueue(client, {
            organizationId: subscription.organization_id,
            eventType: 'trial_expired',
            channel: 'email',
            recipient: email,
            payload: { plan: subscription.plan },
            // Idempotent per subscription: a re-run cannot enqueue a second notice.
            idempotencyKey: `trial_expired:${subscription.id}`,
          });
        }
        return true;
      },
    });
    if (!done) break;
    processed += 1;
  }
  return { processed };
}

// A payment that has been failing long enough moves into the explicit grace window, with
// a deadline recorded on the row so both the UI and the next sweep agree on it.
async function escalatePastDue(pool = db.getSystemPool(), { limit = BATCH } = {}) {
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const done = await claimOne(pool, {
      predicate: `status = 'past_due'
                  and last_transition_at is not null
                  and last_transition_at <= now() - ($1 || ' days')::interval`,
      params: [String(PAST_DUE_GRACE_AFTER_DAYS)],
      apply: async (client, subscription) => {
        await client.query("select set_config('app.current_organization_id', $1, true)", [subscription.organization_id]);
        const graceUntil = await client.query("select (now() + ($1 || ' days')::interval) as until", [String(GRACE_DAYS)]);
        await lifecycle.transitionSubscription(client, {
          organizationId: subscription.organization_id,
          subscriptionId: subscription.id,
          to: 'grace_period',
          reason: 'payment overdue, grace window opened',
          actorType: 'system',
          graceUntil: graceUntil.rows[0].until,
        });
        const email = await ownerEmail(client, subscription.organization_id);
        if (email) {
          await notifications.enqueue(client, {
            organizationId: subscription.organization_id,
            eventType: 'subscription_past_due',
            channel: 'email',
            recipient: email,
            payload: { grace_until: graceUntil.rows[0].until },
            idempotencyKey: `grace_opened:${subscription.id}:${graceUntil.rows[0].until}`,
          });
        }
        return true;
      },
    });
    if (!done) break;
    processed += 1;
  }
  return { processed };
}

// Grace exhausted: access is withdrawn. Still no data is touched.
async function suspendExpiredGrace(pool = db.getSystemPool(), { limit = BATCH } = {}) {
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const done = await claimOne(pool, {
      predicate: "status = 'grace_period' and grace_until is not null and grace_until <= now()",
      params: [],
      apply: async (client, subscription) => {
        await client.query("select set_config('app.current_organization_id', $1, true)", [subscription.organization_id]);
        await lifecycle.transitionSubscription(client, {
          organizationId: subscription.organization_id,
          subscriptionId: subscription.id,
          to: 'suspended',
          reason: 'grace period exhausted',
          actorType: 'system',
          suspensionReason: 'payment not received before grace deadline',
        });
        const email = await ownerEmail(client, subscription.organization_id);
        if (email) {
          await notifications.enqueue(client, {
            organizationId: subscription.organization_id,
            eventType: 'subscription_suspended',
            channel: 'email',
            recipient: email,
            payload: { plan: subscription.plan },
            idempotencyKey: `suspended:${subscription.id}`,
          });
        }
        return true;
      },
    });
    if (!done) break;
    processed += 1;
  }
  return { processed };
}

// Reminder for trials about to end. The idempotency key pins the reminder to the trial's
// own end timestamp, so re-running the sweep (or running two workers) cannot produce a
// duplicate, while a genuinely extended trial gets a fresh reminder.
async function enqueueTrialReminders(pool = db.getSystemPool(), { limit = BATCH } = {}) {
  const client = await pool.connect();
  let enqueued = 0;
  try {
    const due = await client.query(
      `select id, organization_id, plan, trial_end
         from subscriptions
        where status = 'trialing'
          and trial_end is not null
          and trial_end > now()
          and trial_end <= now() + ($1 || ' days')::interval
        order by trial_end
        limit $2`,
      [String(TRIAL_REMINDER_DAYS), limit]
    );
    for (const subscription of due.rows) {
      await client.query('begin');
      try {
        await client.query("select set_config('app.current_organization_id', $1, true)", [subscription.organization_id]);
        const email = await ownerEmail(client, subscription.organization_id);
        if (email) {
          const row = await notifications.enqueue(client, {
            organizationId: subscription.organization_id,
            eventType: 'trial_reminder',
            channel: 'email',
            recipient: email,
            payload: { plan: subscription.plan, trial_end: subscription.trial_end },
            idempotencyKey: `trial_reminder:${subscription.id}:${new Date(subscription.trial_end).toISOString()}`,
          });
          if (row) enqueued += 1;
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      }
    }
  } finally {
    client.release();
  }
  return { enqueued };
}

async function runSubscriptionLifecycleSweep(pool = db.getSystemPool(), options = {}) {
  const reminders = await enqueueTrialReminders(pool, options);
  const trials = await expireDueTrials(pool, options);
  const grace = await escalatePastDue(pool, options);
  const suspensions = await suspendExpiredGrace(pool, options);
  return {
    remindersEnqueued: reminders.enqueued,
    trialsExpired: trials.processed,
    graceOpened: grace.processed,
    suspended: suspensions.processed,
  };
}

function startSubscriptionLifecycleWorker() {
  if (String(process.env.SUBSCRIPTION_WORKER_ENABLED || 'true') === 'false') return null;
  const intervalMs = Math.min(Math.max(Number(process.env.SUBSCRIPTION_WORKER_INTERVAL_MS || 300000), 30000), 3600000);
  const timer = setInterval(() => {
    runSubscriptionLifecycleSweep().catch((error) => {
      console.error(`Subscription lifecycle sweep failed: ${error.message}`);
    });
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  GRACE_DAYS,
  PAST_DUE_GRACE_AFTER_DAYS,
  TRIAL_REMINDER_DAYS,
  claimOne,
  expireDueTrials,
  escalatePastDue,
  suspendExpiredGrace,
  enqueueTrialReminders,
  runSubscriptionLifecycleSweep,
  startSubscriptionLifecycleWorker,
};
