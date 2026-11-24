const { createHash } = require('node:crypto');

const { reservationTtlMinutes, cardGraceMinutes } = require('./inventoryReservations');

const ranks = { ok: 0, warning: 1, critical: 2 };
const fingerprints = Symbol('finding fingerprints');
// Signature of a pre-reconciliation late success: the terminal guard kept the order cancelled
// although the provider-verified payment succeeded (see paymentCallbackEvents.js).
const cancelledNote = 'İncelenmeli, kesin tahsilat değil.';
const heldStockNote = 'Açık vaka nedeniyle stok rezervasyonu tutuluyor; operatör kararı gerekir.';
const checkNames = [
  'open_cases', 'open_cases_over_age', 'payment_id_order_mismatch', 'failing_callback_retry',
  'stale_processing', 'verified_payment_on_cancelled_without_case', 'payment_id_anomaly',
  'partial_or_duplicate_payment_suspected', 'unverified_transfer_evidence_over_age',
  'iban_paid_without_evidence', 'callback_missing_suspected', 'provider_local_state_mismatch',
  'reserved_stock_held_by_open_case',
];
const suspectedNames = [
  'partial_or_duplicate_payment_suspected', 'unverified_transfer_evidence_over_age',
  'iban_paid_without_evidence', 'callback_missing_suspected', 'provider_local_state_mismatch',
];

function bounded(value, fallback, maximum) {
  const number = value == null || String(value).trim() === '' ? NaN : Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.trunc(number), 1), maximum) : fallback;
}

function resolveThresholds(overrides = {}, env = process.env) {
  const warnHours = bounded(overrides.warnHours ?? env.PAYMENT_RECON_OPEN_CASE_WARN_HOURS, 24, 8760);
  const staleMinutes = overrides.staleMinutes ?? env.PAYMENT_RECON_STALE_PROCESSING_MINUTES;
  return {
    warnHours,
    criticalHours: Math.max(warnHours, bounded(overrides.criticalHours ?? env.PAYMENT_RECON_OPEN_CASE_CRITICAL_HOURS, 72, 8760)),
    failedAttempts: bounded(overrides.failedAttempts ?? env.PAYMENT_RECON_FAILED_ATTEMPTS, 5, 1000),
    staleMinutes: staleMinutes == null
      ? bounded(env.PAYMENT_CALLBACK_STALE_MINUTES, 15, 240)
      : bounded(staleMinutes, 15, 1440),
    lookbackHours: bounded(overrides.lookbackHours ?? env.PAYMENT_RECON_CANCELLED_LOOKBACK_HOURS, 720, 8760),
    cooldownMinutes: bounded(overrides.cooldownMinutes ?? env.PAYMENT_RECON_ALERT_COOLDOWN_MINUTES, 360, 10080),
  };
}

// All predicates and limits operate on one snapshot. Provider identifiers only participate
// in SQL comparisons. The aggregates and samples project an explicit allowlist.
const reportSql = `
with settings as (
  select $1::uuid as org, $2::timestamptz as as_of, $3::int as warn_hours,
    $4::int as failed_attempts, $5::int as stale_minutes, $6::int as lookback_hours,
    $7::int as card_wait_minutes
), case_rows as (
  select c.id, c.organization_id, c.order_id, c.callback_event_id as event_id,
    c.status, c.detected_at as observed_at
  from payment_reconciliation_cases c cross join settings s
  where c.status = 'open' and (s.org is null or c.organization_id = s.org)
), callback_rows as (
  select e.id, e.organization_id, e.processed_order_id as order_id, e.id as event_id,
    e.processing_status as status, e.updated_at as observed_at, flags.check_name
  from payment_callback_events e cross join settings s
  cross join lateral (values
    ('payment_id_order_mismatch', e.processing_status = 'failed' and e.last_error = 'PAYMENT_ID_ORDER_MISMATCH'),
    ('failing_callback_retry', e.processing_status = 'failed' and e.attempts >= s.failed_attempts),
    ('stale_processing', e.processing_status = 'processing' and e.updated_at < s.as_of - make_interval(mins => s.stale_minutes))
  ) flags(check_name, present)
  where flags.present and (s.org is null or e.organization_id = s.org)
), anomaly_keys as (
  select provider, provider_payment_id, min(id) as group_id
  from payment_reconciliation_cases
  group by provider, provider_payment_id
  having count(distinct organization_id) > 1 or count(distinct order_id) > 1
), evidence_findings as (
  select flags.check_name, o.id, o.organization_id, o.id as order_id, null::bigint as event_id,
    o.status, flags.observed_at, o.id as group_id
  from orders o cross join settings s
  left join lateral (
    select min(e.received_at) filter (where e.channel = 'bank_transfer') as first_transfer,
      count(*) filter (where e.channel = 'card' and e.evidence_level = 'provider_verified') as card_entries
    from payment_evidence e
    where e.organization_id = o.organization_id and e.order_id = o.id
  ) evidence on true
  cross join lateral (values
    ('unverified_transfer_evidence_over_age', evidence.first_transfer,
      o.payment_method = 'iban' and o.payment_status = 'manual_pending'
        and evidence.first_transfer < s.as_of - make_interval(hours => s.warn_hours)),
    ('iban_paid_without_evidence', o.updated_at,
      o.payment_method = 'iban' and o.payment_status = 'paid' and evidence.first_transfer is null
        and o.updated_at between s.as_of - make_interval(hours => s.lookback_hours) and s.as_of),
    ('callback_missing_suspected', o.created_at,
      o.payment_method = 'card' and o.status = 'payment_pending' and nullif(o.payment_token, '') is not null
        and o.created_at < s.as_of - make_interval(mins => s.card_wait_minutes)
        and not exists (
          select 1 from payment_callback_events e where e.organization_id = o.organization_id
            and (e.payment_token = o.payment_token or e.processed_order_id = o.id or e.order_code = o.order_code)
        )),
    ('provider_local_state_mismatch', o.updated_at,
      o.payment_method = 'card' and o.status = 'paid' and o.payment_provider is distinct from 'mock'
        and evidence.card_entries = 0
        and o.updated_at between s.as_of - make_interval(hours => s.lookback_hours) and s.as_of)
  ) flags(check_name, observed_at, present)
  where flags.present and (s.org is null or o.organization_id = s.org)
), findings as (
  select 'open_cases' as check_name, c.*, c.id as group_id from case_rows c
  union all
  select 'open_cases_over_age', c.*, c.id
  from case_rows c cross join settings s
  where c.observed_at < s.as_of - make_interval(hours => s.warn_hours)
  union all
  select check_name, id, organization_id, order_id, event_id, status, observed_at, id from callback_rows
  union all
  select 'partial_or_duplicate_payment_suspected', c.id, c.organization_id, c.order_id, c.callback_event_id,
    c.status, c.detected_at, c.id
  from payment_reconciliation_cases c cross join settings s
  where c.status = 'open' and (s.org is null or c.organization_id = s.org)
    and c.case_type in ('bank_transfer_underpaid', 'bank_transfer_overpaid', 'bank_transfer_multiple', 'bank_transfer_conflict', 'provider_duplicate_payment')
  union all
  select * from evidence_findings
  union all
  select 'reserved_stock_held_by_open_case', c.id, c.organization_id, c.order_id, c.callback_event_id,
    c.status, c.detected_at, c.id
  from payment_reconciliation_cases c cross join settings s
  join orders o on o.organization_id = c.organization_id and o.id = c.order_id
  where c.status = 'open' and (s.org is null or c.organization_id = s.org)
    and c.detected_at < s.as_of - make_interval(hours => s.warn_hours)
    and o.status = 'payment_pending'
    and exists (
      select 1 from inventory_reservations r
      where r.organization_id = o.organization_id and r.order_id = o.id and r.status = 'active'
    )
  union all
  select 'verified_payment_on_cancelled_without_case', o.id, o.organization_id, o.id, e.id,
    o.status, e.last_processed_at, o.id
  from orders o cross join settings s
  join lateral (
    select e.id, e.last_processed_at, e.result_status, e.last_error
    from payment_callback_events e
    where e.organization_id = o.organization_id and e.processed_order_id = o.id
      and e.processing_status = 'processed' and e.last_processed_at <= s.as_of
    order by e.last_processed_at desc, e.id desc limit 1
  ) e on true
  where o.status = 'cancelled' and (s.org is null or o.organization_id = s.org)
    and nullif(btrim(o.payment_id), '') is not null and o.payment_id not like 'mock-%'
    and e.result_status = 'cancelled' and e.last_error like 'Final durum korunuyor: cancelled%'
    and e.last_processed_at >= s.as_of - make_interval(hours => s.lookback_hours)
    and not exists (
      select 1 from payment_reconciliation_cases c
      where c.organization_id = o.organization_id and c.order_id = o.id
    )
  union all
  select 'payment_id_anomaly', c.id, c.organization_id, c.order_id, c.callback_event_id,
    c.status, c.detected_at, a.group_id
  from payment_reconciliation_cases c join anomaly_keys a using (provider, provider_payment_id)
  cross join settings s
  where s.org is null or c.organization_id = s.org
), ranked as (
  select f.*, greatest(0, extract(epoch from (s.as_of - f.observed_at)) / 60)::double precision as age,
    row_number() over (partition by f.check_name order by f.observed_at, f.id) as sample_rank
  from findings f cross join settings s
), checks as (
  select check_name, count(distinct group_id)::int as count, max(age) as "oldestAgeMinutes",
    encode(sha256(convert_to(check_name || '|' || string_agg(id::text, ',' order by id), 'UTF8')), 'hex') as fingerprint,
    jsonb_agg(jsonb_build_object('id', id::text, 'organizationId', organization_id,
      'orderId', order_id::text, 'eventId', event_id::text, 'status', status,
      'ageMinutes', round(age::numeric, 2)) order by sample_rank) filter (where sample_rank <= 20) as samples
  from ranked group by check_name
), org_counts as (
  select organization_id, check_name, count(distinct group_id)::int as count
  from findings where organization_id is not null group by organization_id, check_name
), orgs as (
  select organization_id, jsonb_object_agg(check_name, count) as counts
  from org_counts group by organization_id order by
    coalesce(sum(count) filter (where check_name <> 'open_cases'), 0) desc,
    sum(count) desc, organization_id limit 50
)
select (select jsonb_agg(checks) from checks) as checks,
  (select jsonb_agg(orgs) from orgs) as orgs
`;

function severityFor(name, count, oldest, thresholds) {
  if (!count || name === 'open_cases') return 'ok';
  if (name === 'payment_id_anomaly'
    || (['open_cases_over_age', 'reserved_stock_held_by_open_case'].includes(name) && oldest > thresholds.criticalHours * 60)) {
    return 'critical';
  }
  return 'warning';
}

async function collectPaymentReconciliationReport({
  pool = require('../db').getSystemPool(), now = new Date(), thresholds, organizationId = null,
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const limits = resolveThresholds(thresholds);
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('begin isolation level repeatable read read only');
    const { rows: [access] } = await client.query('select app_rls_bypassed() as bypass');
    if (access?.bypass !== true) {
      throw Object.assign(new Error('Mutabakat izleme sistem rolü gerektirir.'), { code: 'PAYMENT_RECON_RLS_REQUIRED' });
    }
    const { rows: [data] } = await client.query(reportSql, [
      organizationId, generatedAt, limits.warnHours, limits.failedAttempts, limits.staleMinutes,
      limits.lookbackHours, reservationTtlMinutes() + cardGraceMinutes(),
    ]);
    const byName = new Map((data.checks || []).map((row) => [row.check_name, row]));
    const checks = {};
    let overall = 'ok';
    for (const name of checkNames) {
      const { count = 0, oldestAgeMinutes = null, samples = [], fingerprint } = byName.get(name) || {};
      const severity = severityFor(name, count, oldestAgeMinutes, limits);
      checks[name] = { count, oldestAgeMinutes, severity, samples };
      Object.defineProperty(checks[name], fingerprints, { value: fingerprint });
      if (ranks[severity] > ranks[overall]) overall = severity;
    }
    checks.verified_payment_on_cancelled_without_case.note = cancelledNote;
    for (const name of suspectedNames) checks[name].note = cancelledNote;
    // Expiry skips orders with an open case, so their stock stays reserved until an operator decides.
    checks.reserved_stock_held_by_open_case.note = heldStockNote;
    const perOrganization = (data.orgs || []).map(({ organization_id, counts }) => ({
      organizationId: organization_id,
      ...Object.fromEntries(checkNames.map((name) => [
        name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), counts[name] || 0,
      ])),
    }));
    await client.query('commit');
    return { generatedAt, scope: organizationId ? { organizationId } : 'global', thresholds: limits, checks, overall, perOrganization };
  } catch (error) {
    try { await client.query('rollback'); } catch (rollbackError) { releaseError = rollbackError; }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

function computeAlerts(report, previousState = {}, now = new Date(), cooldown = 360) {
  const time = new Date(now).getTime();
  const alerts = [];
  const state = {};
  for (const [check, finding] of Object.entries(report.checks)) {
    if (!finding.count || ranks[finding.severity] < ranks.warning) continue;
    const ids = [...new Set(finding.samples.map(({ id }) => id))].sort();
    const fingerprint = finding[fingerprints] || createHash('sha256').update(check + '|' + ids.join(',')).digest('hex');
    const prior = previousState?.[fingerprint];
    const validPrior = prior && Number.isFinite(prior.time) && prior.time <= time && ranks[prior.severity] >= ranks.warning;
    const emit = !validPrior || ranks[finding.severity] > ranks[prior.severity] || time - prior.time >= cooldown * 60000;
    if (emit) {
      const organizationIds = [...new Set(finding.samples.map(({ organizationId }) => organizationId).filter(Boolean))];
      const { count, severity, oldestAgeMinutes } = finding;
      alerts.push({ check, count, severity, oldestAgeMinutes, organizationIds, ids });
    }
    state[fingerprint] = { time: emit ? time : prior.time, severity: finding.severity };
  }
  return { alerts, state };
}

module.exports = { collectPaymentReconciliationReport, computeAlerts, resolveThresholds };
