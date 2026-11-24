const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../services/audit');
const { resolveOrganization } = require('../services/tenant');

const router = express.Router();
const resolutions = ['resolved_refunded', 'resolved_accepted', 'dismissed'];
const columns = `id, organization_id, order_id, callback_event_id, case_type, provider,
  provider_payment_id, provider_paid_amount, currency, order_total, order_status_at_detection,
  status, resolution_note, resolved_by, resolved_at, detected_at, created_at, updated_at`;

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
  const { resolution, note } = req.body || {};
  if (!isCaseId(id) || !resolutions.includes(resolution)
    || (note != null && (typeof note !== 'string' || note.length > 2000))) {
    throw httpError(400, 'Gecersiz mutabakat cozumu');
  }
  const { rows: [existing] } = await client.query(
    'select status from payment_reconciliation_cases where organization_id = $1 and id = $2 for update',
    [organizationId, id]
  );
  if (!existing) throw httpError(404, 'Mutabakat vakasi bulunamadi');
  if (existing.status !== 'open') throw httpError(409, 'Mutabakat vakasi zaten cozulmus');

  const { rows: [resolved] } = await client.query(
    `update payment_reconciliation_cases
        set status = $3, resolution_note = $4, resolved_by = $5, resolved_at = now(), updated_at = now()
      where organization_id = $1 and id = $2
      returning ${columns}`,
    [organizationId, id, resolution, note?.trim() || null, req.auth.userId || null]
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
      adminId: req.auth.impersonatorAdminId ?? (req.auth.actorType === 'admin' ? req.auth.sub : null),
    },
    store: client,
    throwOnError: true,
  });
  return { case: resolved };
}));

module.exports = router;
