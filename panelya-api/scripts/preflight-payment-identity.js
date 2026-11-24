// Read-only preflight for migration 077 and for legacy card orders. It never prints payment ids,
// references or tenant ids: counts only. Exit codes: 0 no conflicts, 1 conflicts (migration 077
// would refuse to run), 2 usage or connectivity error.
const sources = `
  select 'evidence' as source, provider, provider_payment_id, organization_id, order_id
    from payment_evidence where channel = 'card' and nullif(btrim(provider_payment_id), '') is not null
  union all
  select 'case', provider, provider_payment_id, organization_id, order_id
    from payment_reconciliation_cases where provider <> 'manual' and nullif(btrim(provider_payment_id), '') is not null
  union all
  select 'order', payment_provider, payment_id, organization_id, id
    from orders where payment_provider = 'iyzico' and nullif(btrim(payment_id), '') is not null
      and payment_id not like 'mock-%'`;

const reportSql = `
with known as (${sources}),
conflicts as (
  select provider, provider_payment_id from known
   group by provider, provider_payment_id
  having count(distinct (organization_id, order_id)) > 1
)
select
  (select count(*) from conflicts)::int as "conflictingPaymentIds",
  (select count(distinct (k.organization_id, k.order_id)) from known k
     join conflicts c using (provider, provider_payment_id))::int as "ordersInConflict",
  (select count(*) from orders o
    where o.payment_method = 'card' and o.payment_provider = 'iyzico'
      and nullif(btrim(o.payment_id), '') is not null and o.payment_id not like 'mock-%'
      and not exists (select 1 from payment_evidence e where e.organization_id = o.organization_id
                       and e.order_id = o.id and e.channel = 'card')
      and not exists (select 1 from payment_reconciliation_cases c where c.organization_id = o.organization_id
                       and c.order_id = o.id))::int as "unbackedLegacyOrders",
  (select count(*) from orders o
    where o.payment_method = 'card' and nullif(btrim(o.payment_id), '') is not null
      and o.payment_id not like 'mock-%' and o.payment_provider is distinct from 'iyzico')::int as "unknownProviderOrders",
  (select count(*) from orders o
    where nullif(btrim(o.payment_id), '') is not null and o.payment_id like 'mock-%')::int as "mockOrdersIgnored"`;

async function collectPaymentIdentityPreflight({ pool = require('../db').getSystemPool() } = {}) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('begin isolation level repeatable read read only');
    const { rows: [access] } = await client.query('select app_rls_bypassed() as bypass');
    if (access?.bypass !== true) {
      throw Object.assign(new Error('Preflight sistem rolü gerektirir.'), { code: 'PAYMENT_IDENTITY_PREFLIGHT_RLS_REQUIRED' });
    }
    const { rows: [counts] } = await client.query(reportSql);
    await client.query('commit');
    return {
      readOnly: true,
      ...counts,
      // Legacy orders only prove that a provider payment id was once stored. They carry no
      // provider-verified evidence and are NEVER reported or backfilled as verified.
      note: 'Legacy orders.payment_id degerleri dogrulanmis kanit sayilmaz; yalnizca kimligi rezerve eder.',
    };
  } catch (error) {
    try { await client.query('rollback'); } catch (rollbackError) { releaseError = rollbackError; }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function main(args = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  if (args.some((arg) => arg !== '--json')) {
    stderr('Kullanim: node scripts/preflight-payment-identity.js [--json]');
    return 2;
  }
  try {
    const report = await collectPaymentIdentityPreflight();
    stdout(args.includes('--json') ? JSON.stringify(report, null, 2)
      : Object.entries(report).map(([key, value]) => key + '=' + value).join('\n'));
    return report.conflictingPaymentIds > 0 ? 1 : 0;
  } catch (error) {
    stderr('Preflight calistirilamadi: ' + (error.code || 'HATA'));
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).finally(() => require('../db').getSystemPool().end().catch(() => {}));
}

module.exports = { collectPaymentIdentityPreflight, main };
