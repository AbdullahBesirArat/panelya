const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');

const router = express.Router();
const resolutions = ['resolved_refunded', 'resolved_accepted', 'dismissed'];
const refundEvidenceTypes = ['provider_dashboard_reference', 'bank_transfer_reference', 'documented_evidence'];
const columns = `id, organization_id, order_id, callback_event_id, case_type, provider,
  provider_payment_id, provider_paid_amount, currency, order_total, order_status_at_detection,
  status, resolution_note, resolved_by, resolved_by_admin_id, resolved_at, detected_at, created_at, updated_at,
  external_refund_reference, refund_evidence_type, refund_verification as "refundVerification"`;

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

router.get('/', ...operatorRoute(async (req, client, organizationId) => {
  const { status = 'open', before } = req.query;
  const limit = Number(req.query.limit ?? 25);
  if (!['open', ...resolutions].includes(status) || !Number.isInteger(limit) || limit < 1
    || limit > 100 || (before !== undefined && !isCaseId(before))) {
    throw httpError(400, 'Gecersiz liste parametresi');
  }
  const { rows } = await client.query(
    `select ${columns} from payment_reconciliation_cases
      where organization_id = $1 and status = $2 and ($3::bigint is null or id < $3)
      order by id desc limit $4`,
    [organizationId, status, before ?? null, limit + 1]
  );
  const cases = rows.slice(0, limit);
  return { cases, nextCursor: rows.length > limit ? cases.at(-1).id : null };
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
