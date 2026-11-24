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

function presentEvidence(row) {
  if (!row) return null;
  const verification = {
    customer_claim: 'customer_claim',
    operator_recorded: 'operator_asserted_unverified',
    operator_asserted_verified: 'operator_asserted_unverified',
    provider_verified: 'provider_verified',
  }[row.evidence_level];
  return { ...row, verification };
}

async function bankEvidenceTotals(client, organizationId, orderId) {
  const { rows: [totals] } = await client.query(
    `select count(*) as entries,
       count(*) filter (where evidence_level <> 'customer_claim') as counted,
       coalesce(sum(amount) filter (where evidence_level <> 'customer_claim'), 0) as amount
     from payment_evidence
     where organization_id = $1 and order_id = $2 and channel = 'bank_transfer'`,
    [organizationId, orderId]
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
    || (level === 'operator_asserted_verified' && noteLength < 10)
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

module.exports = {
  amountInKurus, bankEvidenceTotals, decimalAmount, paymentIdentityMismatch,
  presentEvidence, recordBankTransferEvidence, recordCardEvidence,
};
