'use strict';

// A26 central entitlement policy.
//
// The point of this module is that `if (subscription.status === ...)` appears in exactly
// ONE place. Routes ask "may this tenant write?" instead of re-deriving the rule, so a
// new state (or a change to what suspension means) cannot drift between call sites.
//
// Suspension deliberately withdraws WRITE access only. Reads stay open, nothing is
// deleted, nothing is deactivated, and the tenant's data remains fully intact and
// exportable — losing access to a service must never mean losing the data you put in it.

const CAPABILITIES = Object.freeze(['read', 'write', 'billing', 'admin']);

// status -> capabilities granted. Anything not listed is denied.
const POLICY = Object.freeze({
  // Full access while trialing: a trial that cannot be used is not a trial.
  trialing: Object.freeze(['read', 'write', 'billing', 'admin']),
  active: Object.freeze(['read', 'write', 'billing', 'admin']),
  // Billing is broken but access is not withdrawn yet — this is the window in which the
  // tenant is expected to fix payment, so they must still be able to reach billing.
  past_due: Object.freeze(['read', 'write', 'billing', 'admin']),
  // Final warning window. Same as past_due by design: grace is about time, not about
  // taking capability away early.
  grace_period: Object.freeze(['read', 'write', 'billing', 'admin']),
  // Access withdrawn: read-only. Billing stays reachable precisely so the tenant can pay
  // and recover; admin stays reachable so they can export/inspect their own data.
  suspended: Object.freeze(['read', 'billing', 'admin']),
  cancelled: Object.freeze(['read', 'billing', 'admin']),
  expired: Object.freeze(['read', 'billing', 'admin']),
});

const DENIAL_REASON = Object.freeze({
  suspended: 'Aboneliginiz askiya alindi. Verileriniz duruyor; odemeyi tamamlayarak devam edebilirsiniz.',
  cancelled: 'Aboneliginiz iptal edildi. Verileriniz duruyor; yeniden baslatarak devam edebilirsiniz.',
  expired: 'Deneme sureniz doldu. Verileriniz duruyor; bir plan secerek devam edebilirsiniz.',
});

function accessError(status, capability) {
  const error = new Error(DENIAL_REASON[status] || 'Bu islem icin aktif bir abonelik gerekli');
  error.status = 402;
  error.code = 'SUBSCRIPTION_ACCESS_DENIED';
  error.meta = { subscriptionStatus: status, capability, allowed: capabilitiesFor(status) };
  return error;
}

function capabilitiesFor(status) {
  return POLICY[status] ? [...POLICY[status]] : ['read'];
}

// A tenant with no subscription row at all keeps working exactly as it did before A26:
// the platform has always allowed that (self-signup writes one, but seeded/legacy orgs
// may not have one), and A26 must not retroactively lock those tenants out.
function resolveAccess(subscription) {
  if (!subscription || !subscription.status) {
    return { status: null, capabilities: [...CAPABILITIES], unrestricted: true };
  }
  return {
    status: subscription.status,
    capabilities: capabilitiesFor(subscription.status),
    unrestricted: false,
  };
}

function can(subscription, capability) {
  if (!CAPABILITIES.includes(capability)) {
    throw Object.assign(new Error(`Bilinmeyen yetki: ${capability}`), { status: 500 });
  }
  return resolveAccess(subscription).capabilities.includes(capability);
}

function assertCan(subscription, capability) {
  if (can(subscription, capability)) return;
  throw accessError(resolveAccess(subscription).status, capability);
}

// Loads the tenant's current subscription and answers the entitlement question in one
// call, for routes that do not already have the row in hand.
async function loadAccess(client, organizationId) {
  const result = await client.query(
    `select id, status, plan, plan_version_id, trial_end, grace_until,
            current_period_end, cancel_at_period_end
       from subscriptions
      where organization_id = $1
      order by updated_at desc nulls last, created_at desc
      limit 1`,
    [organizationId]
  );
  const subscription = result.rows[0] || null;
  return { subscription, access: resolveAccess(subscription) };
}

// Express guard. Kept thin: the decision lives in the policy above, not here.
function requireSubscriptionCapability(capability, { resolveOrganizationId } = {}) {
  const db = require('../db');
  return async (req, res, next) => {
    try {
      const organizationId = resolveOrganizationId
        ? await resolveOrganizationId(req)
        : req.organization?.id || req.auth?.organizationId;
      if (!organizationId) {
        throw Object.assign(new Error('Abonelik kontrolu icin organization gerekli'), { status: 500 });
      }
      const { subscription } = await loadAccess(db, organizationId);
      assertCan(subscription, capability);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  CAPABILITIES,
  POLICY,
  capabilitiesFor,
  resolveAccess,
  can,
  assertCan,
  loadAccess,
  requireSubscriptionCapability,
  accessError,
};
