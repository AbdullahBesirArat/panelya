'use strict';

// A26 subscription state machine. This is the ONLY place a subscription's status is
// written: routes call transitionSubscription() instead of running their own
// `update subscriptions set status = ...`, so every change is validated against the
// matrix, recorded, and auditable.
//
// An illegal transition is never a silent no-op — it throws a machine-readable error
// (code INVALID_SUBSCRIPTION_TRANSITION) carrying the from/to pair, so a caller cannot
// mistake "refused" for "applied".

const STATES = Object.freeze([
  'trialing', 'active', 'past_due', 'grace_period', 'suspended', 'cancelled', 'expired',
]);

// from -> allowed targets. Kept explicit rather than derived: the point of the matrix is
// that adding an edge is a deliberate, reviewable act.
const TRANSITIONS = Object.freeze({
  trialing: ['active', 'cancelled', 'expired'],
  active: ['past_due', 'cancelled', 'suspended'],
  past_due: ['active', 'grace_period', 'cancelled', 'suspended'],
  grace_period: ['active', 'suspended', 'cancelled'],
  // A suspended tenant can be restored (payment recovered or an admin resumes it) or
  // finally cancelled. Its data is never touched by either edge.
  suspended: ['active', 'cancelled'],
  // Terminal states with a controlled way back. Reactivation is deliberately NOT
  // reachable from an arbitrary caller: it requires an explicit reason, which
  // transitionSubscription enforces for these edges.
  cancelled: ['active'],
  expired: ['active'],
});

// Edges that may only be taken with an explicit reason, because they restore access to a
// tenant whose access was previously withdrawn.
const REASON_REQUIRED_EDGES = Object.freeze(new Set([
  'suspended->active', 'cancelled->active', 'expired->active',
]));

function lifecycleError(message, code, status = 400, meta = undefined) {
  return Object.assign(new Error(message), { code, status, meta });
}

function isKnownState(state) {
  return STATES.includes(state);
}

function allowedTransitions(from) {
  return TRANSITIONS[from] ? [...TRANSITIONS[from]] : [];
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

// Pure guard, exported so unit tests can assert the matrix without a database.
function assertTransition(from, to, { reason = '' } = {}) {
  if (!isKnownState(from)) {
    throw lifecycleError(`Bilinmeyen abonelik durumu: ${from}`, 'UNKNOWN_SUBSCRIPTION_STATE', 500, { from });
  }
  if (!isKnownState(to)) {
    throw lifecycleError(`Bilinmeyen hedef abonelik durumu: ${to}`, 'UNKNOWN_SUBSCRIPTION_STATE', 400, { to });
  }
  if (from === to) {
    throw lifecycleError(
      'Abonelik zaten bu durumda',
      'SUBSCRIPTION_TRANSITION_NOOP', 409,
      { from, to }
    );
  }
  if (!canTransition(from, to)) {
    throw lifecycleError(
      `Abonelik ${from} durumundan ${to} durumuna gecemez`,
      'INVALID_SUBSCRIPTION_TRANSITION', 409,
      { from, to, allowed: allowedTransitions(from) }
    );
  }
  if (REASON_REQUIRED_EDGES.has(`${from}->${to}`) && String(reason || '').trim().length < 5) {
    throw lifecycleError(
      'Bu gecis icin gerekce zorunlu',
      'SUBSCRIPTION_TRANSITION_REASON_REQUIRED', 400,
      { from, to }
    );
  }
}

// Column effects of entering a state. Returned as a plain object so the DB write stays a
// single parameterised UPDATE and the rules are unit-testable.
function transitionEffects(to, { graceUntil = null, suspensionReason = null } = {}) {
  switch (to) {
    case 'active':
      // Recovering clears every "access is being withdrawn" marker, but never touches
      // trial history or period boundaries.
      return { grace_until: null, suspended_at: null, suspension_reason: null, cancelled_at: null };
    case 'past_due':
      return { grace_until: null, suspended_at: null, suspension_reason: null };
    case 'grace_period':
      return { grace_until: graceUntil, suspended_at: null, suspension_reason: null };
    case 'suspended':
      return { suspended_at: 'now()', suspension_reason: suspensionReason };
    case 'cancelled':
      return { cancelled_at: 'now()', grace_until: null };
    case 'expired':
      return { grace_until: null };
    default:
      return {};
  }
}

const NOW_SENTINEL = 'now()';

// Applies the transition inside the caller's transaction. The row is locked first so two
// concurrent transitions cannot both read the same `from` state and both succeed.
async function transitionSubscription(client, {
  organizationId,
  subscriptionId = null,
  to,
  reason = '',
  actorType = 'system',
  actorId = null,
  graceUntil = null,
  suspensionReason = null,
  billingEventId = null,
}) {
  const locked = await client.query(
    `select * from subscriptions
      where organization_id = $1 ${subscriptionId ? 'and id = $2' : ''}
      order by updated_at desc nulls last, created_at desc
      limit 1
      for update`,
    subscriptionId ? [organizationId, subscriptionId] : [organizationId]
  );
  const current = locked.rows[0];
  if (!current) {
    throw lifecycleError('Abonelik bulunamadi', 'SUBSCRIPTION_NOT_FOUND', 404);
  }

  assertTransition(current.status, to, { reason });

  const effects = transitionEffects(to, { graceUntil, suspensionReason: suspensionReason || reason || null });
  const assignments = ['status = $3', 'last_transition_at = now()', 'last_transition_reason = $4', 'updated_at = now()'];
  const params = [organizationId, current.id, to, String(reason || '').slice(0, 300) || null];

  for (const [column, value] of Object.entries(effects)) {
    if (value === NOW_SENTINEL) {
      assignments.push(`${column} = now()`);
      continue;
    }
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  }

  const updated = await client.query(
    `update subscriptions set ${assignments.join(', ')}
      where organization_id = $1 and id = $2 returning *`,
    params
  );

  await recordTransition(client, {
    organizationId,
    subscriptionId: current.id,
    from: current.status,
    to,
    reason,
    actorType,
    actorId,
    billingEventId,
  });

  return { subscription: updated.rows[0], previous: current };
}

// Transition history lives in the existing activity_logs table rather than a new
// audit store, so A26 does not fork the audit trail.
async function recordTransition(client, {
  organizationId, subscriptionId, from, to, reason, actorType, actorId, billingEventId,
}) {
  await client.query(
    `insert into activity_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1, $2, 'SUBSCRIPTION_TRANSITION', 'subscription', $3, $4::jsonb)`,
    [
      organizationId,
      actorType === 'user' ? actorId : null,
      String(subscriptionId),
      JSON.stringify({
        from, to,
        reason: String(reason || '').slice(0, 300),
        actor_type: actorType,
        billing_event_id: billingEventId,
      }),
    ]
  );
}

// Records a refused transition too: a rejected attempt is security-relevant (someone or
// something tried to move a tenant's billing state illegally) and must not vanish.
async function recordRefusedTransition(client, {
  organizationId, subscriptionId, from, to, code, actorType = 'system', actorId = null,
}) {
  await client.query(
    `insert into activity_logs (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     values ($1, $2, 'SUBSCRIPTION_TRANSITION_REFUSED', 'subscription', $3, $4::jsonb)`,
    [
      organizationId,
      actorType === 'user' ? actorId : null,
      subscriptionId ? String(subscriptionId) : null,
      JSON.stringify({ from, to, code, actor_type: actorType }),
    ]
  );
}

module.exports = {
  STATES,
  TRANSITIONS,
  REASON_REQUIRED_EDGES,
  allowedTransitions,
  canTransition,
  assertTransition,
  transitionEffects,
  transitionSubscription,
  recordTransition,
  recordRefusedTransition,
  lifecycleError,
};
