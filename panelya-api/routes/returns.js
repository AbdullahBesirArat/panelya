const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requireStepUp } = require('../middleware/authSession');
const { resolveOrganization } = require('../services/tenant');
const customerAuth = require('./customerAuth');
const {
  normalizeDecision,
  normalizeReceipt,
  normalizeRefundInput,
  normalizeReturnRequest,
} = require('../modules/returns/validation');
const {
  createRefund,
  createReturnRequest,
  decideReturnRequest,
  loadReturnDetail,
  receiveReturnRequest,
} = require('../modules/returns/service');

const router = express.Router();
const ADMIN_ROLES = ['super_admin', 'owner', 'admin', 'member', 'viewer'];
const WRITE_ROLES = ['super_admin', 'owner', 'admin'];

function actor(req) {
  return { id: req.auth?.userId || null, name: req.auth?.name || req.auth?.email || '' };
}

function publicReturn(detail) {
  const { internal_note: _internalNote, ...request } = detail;
  return {
    ...request,
    events: (request.events || []).map(({ internal_metadata: _metadata, ...event }) => event),
  };
}

router.get('/customer', async (req, res, next) => {
  try {
    const rows = await db.withTransaction(async (client) => {
      const { organization, account } = await customerAuth.requireCustomerAccount(req, client);
      const result = await client.query(
        `select rr.id, rr.order_id, o.order_code, rr.request_type, rr.status, rr.reason_code,
                rr.customer_note, rr.requested_at, rr.return_deadline, rr.resolution, rr.resolved_at
           from return_requests rr
           join orders o on o.id = rr.order_id and o.organization_id = rr.organization_id
          where rr.organization_id = $1 and rr.customer_account_id = $2
          order by rr.requested_at desc limit 100`,
        [organization.id, account.id]
      );
      return result.rows;
    });
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/customer', async (req, res, next) => {
  try {
    const input = normalizeReturnRequest(req.body);
    const result = await db.withTransaction(async (client) => {
      const session = await customerAuth.requireCustomerAccount(req, client);
      return createReturnRequest(client, { ...session, input });
    });
    res.status(201).json(publicReturn(result));
  } catch (error) { next(error); }
});

router.get('/customer/:id', async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (client) => {
      const { organization, account } = await customerAuth.requireCustomerAccount(req, client);
      return loadReturnDetail(client, organization.id, req.params.id, { customerAccountId: account.id });
    });
    res.json(publicReturn(result));
  } catch (error) { next(error); }
});

router.get('/', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const status = String(req.query.status || '').trim();
    const type = String(req.query.type || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const params = [organization.id];
    const filters = [];
    if (status) filters.push(`rr.status = $${params.push(status)}`);
    if (type) filters.push(`rr.request_type = $${params.push(type)}`);
    params.push(limit);
    const result = await db.query(
      `select rr.*, o.order_code, o.total as order_total,
              coalesce(c.name, rr.customer_note) as customer_name, c.email as customer_email,
              count(ri.id)::int as item_count
         from return_requests rr
         join orders o on o.id = rr.order_id and o.organization_id = rr.organization_id
         left join customers c on c.id = o.customer_id and c.organization_id = o.organization_id
         left join return_items ri on ri.return_request_id = rr.id and ri.organization_id = rr.organization_id
        where rr.organization_id = $1 ${filters.length ? `and ${filters.join(' and ')}` : ''}
        group by rr.id, o.order_code, o.total, c.name, c.email
        order by rr.requested_at desc limit $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (error) { next(error); }
});

router.get('/:id', requireAuth, requireRole(ADMIN_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    res.json(await loadReturnDetail(db, organization.id, req.params.id));
  } catch (error) { next(error); }
});

router.post('/:id/decision', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const decision = normalizeDecision(req.body);
    const result = await db.withTenantContext(organization.id, (client) => decideReturnRequest(client, {
      organizationId: organization.id, requestId: req.params.id, decision, actor: actor(req),
    }));
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/:id/receive', requireAuth, requireRole(WRITE_ROLES), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const receipt = normalizeReceipt(req.body);
    const result = await db.withTenantContext(organization.id, (client) => receiveReturnRequest(client, {
      organizationId: organization.id, requestId: req.params.id, receipt, actor: actor(req),
    }));
    res.json(result);
  } catch (error) { next(error); }
});

// A30: a refund moves money out. Step-up gated; the A17 refund service still owns every
// rule about whether the refund itself is legal.
router.post('/:id/refunds', requireAuth, requireRole(WRITE_ROLES), requireStepUp('refund'), async (req, res, next) => {
  try {
    const organization = await resolveOrganization(req);
    const input = normalizeRefundInput(req.body);
    const result = await db.withTenantContext(organization.id, (client) => createRefund(client, {
      organizationId: organization.id, requestId: req.params.id, input, actor: actor(req),
    }));
    res.status(result.replay ? 200 : 201).json(result);
  } catch (error) { next(error); }
});

module.exports = router;
