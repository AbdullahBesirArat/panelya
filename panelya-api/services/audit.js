const db = require('../db');

function isNumericId(value) {
  return typeof value === 'number' || /^\d+$/.test(String(value || ''));
}

async function writeAdminAudit(req, entry) {
  await db.query(
    `insert into audit_logs
     (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, user_agent, success, error_message)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.adminId,
      entry.action,
      entry.resourceType,
      entry.resourceId == null ? null : String(entry.resourceId),
      entry.oldValue == null ? null : JSON.stringify(entry.oldValue),
      entry.newValue == null ? null : JSON.stringify(entry.newValue),
      req.ip || null,
      String(req.get('user-agent') || '').slice(0, 500),
      entry.success,
      entry.errorMessage ? String(entry.errorMessage).slice(0, 1000) : null,
    ]
  );
}

async function writeAppActivity(req, entry) {
  await db.query(
    `insert into activity_logs
     (organization_id, actor_user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.organizationId || null,
      entry.actorUserId || null,
      entry.action,
      entry.resourceType,
      entry.resourceId == null ? null : String(entry.resourceId),
      JSON.stringify({
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        success: entry.success,
        errorMessage: entry.errorMessage,
      }),
      req.ip || null,
      String(req.get('user-agent') || '').slice(0, 500),
    ]
  );
}

async function auditLog(req, {
  action,
  resourceType,
  resourceId = null,
  oldValue = null,
  newValue = null,
  success = true,
  errorMessage = null,
  actorType = null,
  actorUserId = null,
  organizationId = null,
}) {
  try {
    const effectiveActorType = actorType || req.auth?.actorType || req.admin?.actorType || null;
    const effectiveUserId = actorUserId || req.auth?.userId || null;
    const effectiveOrganizationId = organizationId || req.auth?.organizationId || null;
    const adminId = req.admin?.sub || null;

    if (effectiveActorType === 'app' || effectiveUserId) {
      await writeAppActivity(req, {
        action,
        resourceType,
        resourceId,
        oldValue,
        newValue,
        success,
        errorMessage,
        actorUserId: effectiveUserId,
        organizationId: effectiveOrganizationId,
      });
      return;
    }

    if (adminId != null && isNumericId(adminId)) {
      await writeAdminAudit(req, {
        action,
        resourceType,
        resourceId,
        oldValue,
        newValue,
        success,
        errorMessage,
        adminId: Number(adminId),
      });
    }
  } catch (err) {
    console.warn('Audit log yazilamadi', { message: err.message });
  }
}

module.exports = {
  auditLog,
};
