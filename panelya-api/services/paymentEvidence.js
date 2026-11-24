const { createHash } = require('node:crypto');
const { auditLog } = require('./audit');

const bankLevels = ['customer_claim', 'operator_recorded', 'operator_asserted_verified'];

function amountInKurus(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  return match ? BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')) : null;
}

function decimalAmount(kurus) {
  return `${kurus / 100n}.${String(kurus % 100n).padStart(2, '0')}`;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function formatKurus(kurus) {
  const negative = kurus < 0n;
  const abs = negative ? -kurus : kurus;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

// Operators never need the full bank reference or provider payment id back: only its last four
// characters (and length) identify a record. Full values stay in the database for audit.
function maskedTail(value) {
  const characters = [...String(value ?? '')];
  return { last4: characters.length > 4 ? characters.slice(-4).join('') : null, length: characters.length || null };
}

function presentEvidence(row) {
  if (!row) return null;
  const { reference, reference_key: _key, provider_payment_id: providerPaymentId, ...rest } = row;
  const verification = {
    customer_claim: 'customer_claim',
    operator_recorded: 'operator_asserted_unverified',
    operator_asserted_verified: 'operator_asserted_unverified',
    provider_verified: 'provider_verified',
  }[row.evidence_level];
  return {
    ...rest,
    verification,
    referenceLast4: maskedTail(reference).last4,
    referenceLength: maskedTail(reference).length,
    ...(providerPaymentId ? { providerPaymentIdLast4: maskedTail(providerPaymentId).last4 } : {}),
  };
}

// The single decision both the transition gate and the operator screen use for IBAN payment approval.
function ibanPaymentBlocker(totals, order) {
  if (Number(totals.counted) === 0) return 'PAYMENT_EVIDENCE_REQUIRED';
  if (Number(totals.currency_mismatch) > 0) return 'PAYMENT_EVIDENCE_CURRENCY_MISMATCH';
  const counted = amountInKurus(totals.amount);
  if (counted === null || counted !== amountInKurus(order.total)) return 'PAYMENT_EVIDENCE_AMOUNT_MISMATCH';
  if (!totals.justified) return 'PAYMENT_EVIDENCE_JUSTIFICATION_REQUIRED';
  return null;
}

async function bankEvidenceTotals(client, organizationId, orderId, currency = null) {
  const { rows: [totals] } = await client.query(
    `select count(*) as entries,
       count(*) filter (where evidence_level <> 'customer_claim') as counted,
       coalesce(sum(amount) filter (where evidence_level <> 'customer_claim'), 0) as amount,
       count(*) filter (where evidence_level <> 'customer_claim' and currency is distinct from $3::text) as currency_mismatch,
       coalesce(bool_or(char_length(btrim(coalesce(note, ''))) >= 10) filter (where evidence_level <> 'customer_claim'), false) as justified,
       coalesce(array_agg(id order by id) filter (where evidence_level <> 'customer_claim'), '{}') as counted_ids
     from payment_evidence
     where organization_id = $1 and order_id = $2 and channel = 'bank_transfer'`,
    [organizationId, orderId, currency]
  );
  return totals;
}

async function recordBankTransferEvidence(client, {
  organizationId, orderId, amount, currency, reference, receivedAt, level, note, actor, req,
}) {
  const kurus = amountInKurus(amount);
  const cleanReference = typeof reference === 'string' ? reference.trim() : '';
  const referenceKey = cleanReference.toUpperCase().replace(/[\s_-]/gu, '');
  const cleanNote = typeof note === 'string' ? note.trim() : '';
  const noteLength = [...cleanNote].length;
  const date = receivedAt === undefined ? new Date() : new Date(receivedAt);
  if (kurus === null || kurus <= 0n || kurus >= 100000000000000n
    || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)
    || !referenceKey || cleanReference.length > 200 || cleanReference.includes('\0')
    || !bankLevels.includes(level) || noteLength > 2000 || cleanNote.includes('\0')
    || (level !== 'customer_claim' && noteLength < 10)
    || receivedAt === null || !Number.isFinite(date.getTime())) {
    throw httpError(400, 'Gecersiz havale kaniti');
  }

  const { rows: [order] } = await client.query(
    'select * from orders where organization_id = $1 and id = $2 for update', [organizationId, orderId]
  );
  if (!order) throw httpError(404, 'Siparis bulunamadi');
  if (order.payment_method !== 'iban' || order.currency !== currency) {
    throw httpError(409, 'Havale kaniti siparisle uyusmuyor');
  }
  const adminId = actor?.adminId ?? req?.auth?.impersonatorAdminId
    ?? (req?.auth?.actorType === 'admin' ? req.auth.sub : null);
  const userId = adminId == null ? actor?.id ?? req?.auth?.userId ?? null : null;
  const { rows: [inserted] } = await client.query(
    `insert into payment_evidence
       (organization_id, order_id, channel, evidence_level, amount, currency, reference, reference_key,
        received_at, note, recorded_by, recorded_by_admin_id)
     values ($1,$2,'bank_transfer',$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (organization_id, channel, reference_key) where channel = 'bank_transfer'
     do nothing returning *`,
    [organizationId, orderId, level, decimalAmount(kurus), currency, cleanReference,
      referenceKey, date, cleanNote || null, userId, adminId]
  );

  let status;
  let caseId = null;
  let replay = !inserted;
  if (!inserted) {
    const { rows: [prior] } = await client.query(
      `select * from payment_evidence
       where organization_id = $1 and channel = 'bank_transfer' and reference_key = $2`,
      [organizationId, referenceKey]
    );
    if (String(prior.order_id) === String(orderId)) {
      const { rows: [existingCase] } = await client.query(
        `select id, case_type from payment_reconciliation_cases
         where organization_id = $1 and order_id = $2 and evidence_id = $3 order by id limit 1`,
        [organizationId, orderId, prior.id]
      );
      return {
        evidence: presentEvidence(prior), replay: true,
        evaluation: {
          status: existingCase?.case_type.slice('bank_transfer_'.length)
            ?? (prior.evidence_level === 'customer_claim' ? 'claim_only' : 'matches'),
          caseId: existingCase?.id ?? null,
        },
      };
    }
    status = 'conflict';
  } else if (order.status === 'cancelled') {
    status = 'late';
  } else if (level === 'customer_claim') {
    status = 'claim_only';
  } else {
    const totals = await bankEvidenceTotals(client, organizationId, orderId);
    const total = amountInKurus(totals.amount);
    const expected = amountInKurus(order.total);
    status = BigInt(totals.counted) > 1n ? 'multiple'
      : total === expected ? 'matches' : total < expected ? 'underpaid' : 'overpaid';
  }

  if (status !== 'matches' && status !== 'claim_only') {
    const caseKey = inserted?.id ?? createHash('sha256').update(`${orderId}:${referenceKey}`).digest('hex');
    const caseType = `bank_transfer_${status}`;
    const { rows: [created] } = await client.query(
      `insert into payment_reconciliation_cases
         (organization_id, order_id, provider, provider_payment_id, case_type, evidence_id,
          provider_paid_amount, currency, order_total, order_status_at_detection)
       values ($1,$2,'manual',$3,$4,$5,$6,$7,$8,$9)
       on conflict (organization_id, provider, provider_payment_id, case_type) do nothing returning id`,
      [organizationId, orderId, caseKey, caseType, inserted?.id ?? null,
        decimalAmount(kurus), currency, order.total, order.status]
    );
    if (created) {
      caseId = created.id;
      replay = false;
    } else {
      const { rows: [existing] } = await client.query(
        `select id from payment_reconciliation_cases
         where organization_id = $1 and order_id = $2 and provider = 'manual'
           and provider_payment_id = $3 and case_type = $4`,
        [organizationId, orderId, caseKey, caseType]
      );
      caseId = existing.id;
    }
  }

  if (!replay) {
    await auditLog({ auth: req?.auth, get() { return ''; } }, {
      action: 'PAYMENT_EVIDENCE_RECORDED', actorType: 'app', actorUserId: userId,
      organizationId, resourceType: 'order', resourceId: orderId,
      newValue: { evidenceId: inserted?.id ?? null, caseId, level, status },
      store: client, throwOnError: true,
    });
  }

  return { evidence: presentEvidence(inserted), replay, evaluation: { status, caseId } };
}

function paymentIdentityMismatch() {
  return Object.assign(new Error('Odeme kaydi beklenen siparisle eslesmiyor'), { code: 'PAYMENT_ID_ORDER_MISMATCH' });
}

async function recordCardEvidence(client, { order, event, provider, paymentId, amount, currency }) {
  const { rows: [inserted] } = await client.query(
    `insert into payment_evidence
       (organization_id, order_id, channel, evidence_level, amount, currency,
        provider, provider_payment_id, callback_event_id, received_at)
     values ($1,$2,'card','provider_verified',$3,$4,$5,$6,$7,now())
     on conflict (provider, provider_payment_id) where channel = 'card'
     do nothing returning id`,
    [order.organization_id, order.id, amount, currency, provider, paymentId, event.id]
  );
  if (inserted) return { id: inserted.id, replay: false };
  // The global unique index detects foreign ownership without reading foreign rows.
  const { rows: [existing] } = await client.query(
    `select id from payment_evidence
     where organization_id = $1 and order_id = $2 and channel = 'card'
       and provider = $3 and provider_payment_id = $4`,
    [order.organization_id, order.id, provider, paymentId]
  );
  if (!existing) throw paymentIdentityMismatch();
  return { id: existing.id, replay: true };
}

// Binds a provider payment id to exactly one (tenant, order). First binder wins; every other
// binder fails closed with an error that carries no information about the existing owner.
async function bindPaymentIdentity(client, { order, provider, paymentId }) {
  const owner = [order.organization_id, order.id];
  // Legacy rows created before the claim table existed. Visible across tenants only to the
  // RLS-bypassing system role the callback worker uses; the claim insert below is the tenant-proof guard.
  const { rows: [foreign] } = await client.query(
    `select 1 from (
       select organization_id, order_id from payment_reconciliation_cases
        where provider = $1 and provider_payment_id = $2
       union all
       select organization_id, order_id from payment_evidence
        where channel = 'card' and provider = $1 and provider_payment_id = $2
       union all
       select organization_id, id from orders
        where payment_provider = $1 and payment_id = $2
     ) known
     where not (organization_id = $3 and order_id = $4) limit 1`,
    [provider, paymentId, ...owner]
  );
  if (foreign) throw paymentIdentityMismatch();
  const { rows: [inserted] } = await client.query(
    `insert into payment_identity_claims (provider, provider_payment_id, organization_id, order_id)
     values ($1,$2,$3,$4)
     on conflict (provider, provider_payment_id) do nothing returning provider_payment_id`,
    [provider, paymentId, ...owner]
  );
  if (inserted) return { replay: false };
  const { rows: [own] } = await client.query(
    `select 1 from payment_identity_claims
      where provider = $1 and provider_payment_id = $2 and organization_id = $3 and order_id = $4`,
    [provider, paymentId, ...owner]
  );
  if (!own) throw paymentIdentityMismatch();
  return { replay: true };
}

module.exports = {
  amountInKurus, bankEvidenceTotals, formatKurus, ibanPaymentBlocker, maskedTail, bindPaymentIdentity, decimalAmount, paymentIdentityMismatch,
  presentEvidence, recordBankTransferEvidence, recordCardEvidence,
};
