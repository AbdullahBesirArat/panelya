const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');
const {
  amountInKurus, bankEvidenceTotals, formatKurus, ibanPaymentBlocker, presentEvidence, recordBankTransferEvidence,
} = require('../services/paymentEvidence');

const router = express.Router();
const resolutions = ['resolved_refunded', 'resolved_accepted', 'dismissed'];
const refundEvidenceTypes = ['provider_dashboard_reference', 'bank_transfer_reference', 'documented_evidence'];
const columns = `id, organization_id, order_id, callback_event_id, evidence_id, case_type, provider,
  provider_payment_id, provider_paid_amount, currency, order_total, order_status_at_detection,
  status, resolution_note, resolved_by, resolved_by_admin_id, resolved_at, detected_at, created_at, updated_at,
  external_refund_reference, refund_evidence_type, refund_verification as "refundVerification"`;

// Cases where a customer may have been charged, or money is unaccounted for, rank above bookkeeping gaps.
const highPriorityCases = new Set([
  'paid_on_cancelled_order', 'provider_amount_mismatch', 'provider_duplicate_payment',
  'bank_transfer_overpaid', 'bank_transfer_late',
]);
const criticalAfterMs = 72 * 3600 * 1000;
function casePriority(row) {
  if (row.status !== 'open') return 'none';
  if (Date.now() - new Date(row.detected_at).getTime() > criticalAfterMs) return 'critical';
  return highPriorityCases.has(row.case_type) ? 'high' : 'medium';
}
// Provider payment ids and refund references stay out of the operator list view.
const caseViewColumns = `id, order_id, case_type, status, detected_at, provider_paid_amount, currency, order_total,
  order_status_at_detection, resolution_note, resolved_at, refund_evidence_type,
  refund_verification as "refundVerification"`;
async function heldStockOrderIds(client, organizationId, orderIds) {
  if (!orderIds.length) return new Set();
  const { rows } = await client.query(
    `select o.id from orders o
      where o.organization_id = $1 and o.id = any($2::bigint[]) and o.status = 'payment_pending'
        and exists (select 1 from inventory_reservations r
                     where r.organization_id = o.organization_id and r.order_id = o.id and r.status = 'active')`,
    [organizationId, orderIds]
  );
  return new Set(rows.map(({ id }) => String(id)));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function isCaseId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}

function operatorRoute(handler) {
  return [requireAuth, requireRole(['super_admin', 'owner', 'admin']), async (req, res, next) => {
    try {
      const platformOperator = req.auth.actorType === 'admin' && req.auth.role === 'super_admin';
      if (!req.auth.organizationId && !platformOperator) {
        throw httpError(403, 'Organizasyon erisimi reddedildi');
      }
      const { id: organizationId } = await resolveOrganization(req, { query: db.query });
      if (!platformOperator && req.auth.organizationId !== organizationId) {
        throw httpError(403, 'Organizasyon erisimi reddedildi');
      }
      const result = await db.withStandaloneTenantTransaction(
        organizationId, (client) => handler(req, client, organizationId)
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  }];
}

router.post('/orders/:orderId/bank-transfers', ...operatorRoute(async (req, client, organizationId) => {
  const { orderId } = req.params;
  if (!isCaseId(orderId)) throw httpError(400, 'Gecersiz siparis kimligi');
  const { amount, currency, reference, receivedAt, level, note } = req.body || {};
  return recordBankTransferEvidence(client, {
    organizationId, orderId, amount, currency, reference, receivedAt, level, note, req,
  });
}));

router.get('/orders/:orderId/evidence', ...operatorRoute(async (req, client, organizationId) => {
  const { orderId } = req.params;
  if (!isCaseId(orderId)) throw httpError(400, 'Gecersiz siparis kimligi');
  const { rows: [order] } = await client.query(
    `select id, total, currency, payment_method, payment_status, status, order_status
       from orders where organization_id = $1 and id = $2`, [organizationId, orderId]
  );
  if (!order) throw httpError(404, 'Siparis bulunamadi');
  const { rows } = await client.query(
    'select * from payment_evidence where organization_id = $1 and order_id = $2 order by id desc',
    [organizationId, orderId]
  );
  const totals = await bankEvidenceTotals(client, organizationId, orderId, order.currency);
  const orderTotal = amountInKurus(order.total);
  const counted = amountInKurus(totals.amount);
  const claimed = rows
    .filter(({ evidence_level: level, channel }) => channel === 'bank_transfer' && level === 'customer_claim')
    .reduce((sum, { amount }) => sum + amountInKurus(amount), 0n);
  const { rows: caseRows } = await client.query(
    `select ${caseViewColumns} from payment_reconciliation_cases
      where organization_id = $1 and order_id = $2 order by id desc limit 50`, [organizationId, orderId]
  );
  const cases = caseRows.map((row) => ({ ...row, priority: casePriority(row) }));
  const held = await heldStockOrderIds(client, organizationId, [orderId]);
  const offlineOpen = order.payment_method === 'iban' && ['pending', 'manual_pending'].includes(order.payment_status);
  let blocker = null;
  if (order.payment_method === 'card') blocker = 'CARD_PAYMENT_PROVIDER_CONFIRMATION_ONLY';
  else if (!offlineOpen) blocker = 'PAYMENT_NOT_AWAITING_CONFIRMATION';
  else blocker = ibanPaymentBlocker(totals, order);
  return {
    order: {
      id: String(order.id), paymentMethod: order.payment_method, paymentStatus: order.payment_status,
      status: order.status,
    },
    evidence: rows.map(presentEvidence),
    totals: {
      currency: order.currency, orderTotal: formatKurus(orderTotal), counted: formatKurus(counted ?? 0n),
      claimed: formatKurus(claimed), difference: formatKurus(orderTotal - (counted ?? 0n)),
    },
    paymentApproval: { allowed: blocker === null, blocker },
    cases,
    stockHeld: cases.some(({ status }) => status === 'open') && held.has(String(order.id)),
  };
}));

router.get('/', ...operatorRoute(async (req, client, organizationId) => {
  const { status = 'open', before, orderId } = req.query;
  const limit = Number(req.query.limit ?? 25);
  if (!['open', ...resolutions].includes(status) || !Number.isInteger(limit) || limit < 1
    || limit > 100 || (before !== undefined && !isCaseId(before))
    || (orderId !== undefined && !isCaseId(orderId))) {
    throw httpError(400, 'Gecersiz liste parametresi');
  }
  const { rows } = await client.query(
    `select ${caseViewColumns} from payment_reconciliation_cases
      where organization_id = $1 and status = $2 and ($3::bigint is null or id < $3)
        and ($5::bigint is null or order_id = $5)
      order by id desc limit $4`,
    [organizationId, status, before ?? null, limit + 1, orderId ?? null]
  );
  const page = rows.slice(0, limit);
  const held = await heldStockOrderIds(client, organizationId, [...new Set(page.map((row) => String(row.order_id)))]);
  const cases = page.map((row) => ({
    ...row, priority: casePriority(row), stockHeld: row.status === 'open' && held.has(String(row.order_id)),
  }));
  return { cases, nextCursor: rows.length > limit ? page.at(-1).id : null };
}));

router.post('/:id/resolve', ...operatorRoute(async (req, client, organizationId) => {
  const { id } = req.params;
  const { resolution, note, externalReference, evidenceType } = req.body || {};
  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  const noteLength = [...trimmedNote].length;
  if (!isCaseId(id) || !resolutions.includes(resolution) || noteLength < 10 || noteLength > 2000
    || trimmedNote.includes('\0')) {
    throw httpError(400, 'Mutabakat cozumu icin 10-2000 karakterlik not zorunludur');
  }
  const refunded = resolution === 'resolved_refunded';
  const reference = typeof externalReference === 'string' ? externalReference.trim() : '';
  const referenceCharacters = [...reference];
  if (refunded && (!reference || referenceCharacters.length > 200
    || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(externalReference) || !refundEvidenceTypes.includes(evidenceType))) {
    throw httpError(400, 'Iade referansi ve gecerli kanit turu zorunludur');
  }
  if (!refunded && (externalReference !== undefined || evidenceType !== undefined)) {
    throw httpError(400, 'Iade kaniti yalnizca iade cozumu icin gonderilebilir');
  }
  const adminId = req.auth.impersonatorAdminId ?? (req.auth.actorType === 'admin' ? req.auth.sub : null);
  const userId = adminId == null ? req.auth.userId : null;
  const refundVerification = refunded ? 'operator_asserted_unverified' : 'not_applicable';
  const { rows: [existing] } = await client.query(
    'select status from payment_reconciliation_cases where organization_id = $1 and id = $2 for update',
    [organizationId, id]
  );
  if (!existing) throw httpError(404, 'Mutabakat vakasi bulunamadi');
  if (existing.status !== 'open') throw httpError(409, 'Mutabakat vakasi zaten cozulmus');

  const { rows: [resolved] } = await client.query(
    `update payment_reconciliation_cases
        set status = $3, resolution_note = $4, resolved_by = $5, resolved_by_admin_id = $6,
            external_refund_reference = $7, refund_evidence_type = $8, refund_verification = $9,
            resolved_at = now(), updated_at = now()
      where organization_id = $1 and id = $2
      returning ${columns}`,
    [organizationId, id, resolution, trimmedNote, userId ?? null, adminId,
      refunded ? reference : null, refunded ? evidenceType : null, refundVerification]
  );
  await auditLog(req, {
    action: 'PAYMENT_RECONCILIATION_RESOLVED',
    actorType: 'app',
    organizationId,
    resourceType: 'payment_reconciliation_case',
    resourceId: id,
    oldValue: { status: existing.status },
    newValue: {
      status: resolution,
      note: resolved.resolution_note,
      adminId,
      ...(refunded && {
        evidenceType,
        refundVerification,
        externalReferenceLast4: referenceCharacters.length > 4 ? referenceCharacters.slice(-4).join('') : null,
        externalReferenceLength: referenceCharacters.length,
      }),
    },
    store: client,
    throwOnError: true,
  });
  return { case: resolved };
}));

module.exports = router;
