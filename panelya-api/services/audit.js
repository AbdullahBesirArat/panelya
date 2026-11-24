const db = require('../db');
const { Client } = require('pg');

const pendingActivityByClient = new WeakMap();

function isNumericId(value) {
  return typeof value === 'number' || /^\d+$/.test(String(value || ''));
}

async function writeAdminAudit(req, entry, store = db) {
  await store.query(
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

async function insertAppActivity(req, entry, store) {
  await store.query(
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

async function insertAppActivityWithSavepoint(req, entry, client) {
  // Overlapping savepoints on one client could roll back a sibling audit write.
  const previous = pendingActivityByClient.get(client) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => insertWithinSavepoint(req, entry, client));
  pendingActivityByClient.set(client, pending);
  try {
    await pending;
  } finally {
    if (pendingActivityByClient.get(client) === pending) pendingActivityByClient.delete(client);
  }
}

async function insertWithinSavepoint(req, entry, client) {
  try {
    await client.query('savepoint app_activity_audit');
  } catch (error) {
    // A checked-out client can also be used in autocommit mode.
    if (error.code !== '25P01') throw error;
    return insertAppActivity(req, entry, client);
  }

  try {
    await insertAppActivity(req, entry, client);
  } catch (error) {
    try {
      await client.query('rollback to savepoint app_activity_audit');
      await client.query('release savepoint app_activity_audit');
    } catch (_) { /* preserve the original insert error */ }
    throw error;
  }
  await client.query('release savepoint app_activity_audit');
}

async function writeAppActivity(req, entry, store = db) {
  if (store !== db) {
    if (store instanceof Client || typeof store.release === 'function') {
      return insertAppActivityWithSavepoint(req, entry, store);
    }
    return insertAppActivity(req, entry, store);
  }

  const activeOrganizationId = db.currentTenantOrganizationId();
  if (activeOrganizationId) {
    if (entry.organizationId != null && String(entry.organizationId) !== activeOrganizationId) {
      console.warn('Activity log organization mismatch', {
        activeOrganizationId,
        entryOrganizationId: entry.organizationId,
      });
      throw new Error('Activity log organization mismatch');
    }
    return db.withTenantContext(activeOrganizationId, (client) => insertAppActivityWithSavepoint(
      req, { ...entry, organizationId: activeOrganizationId }, client
    ));
  }

  if (entry.organizationId != null && entry.organizationId !== '') {
    return db.withStandaloneTenantTransaction(entry.organizationId, (client) => insertAppActivity(req, entry, client));
  }
  return insertAppActivity(req, entry, db.getSystemPool());
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
  store = db,
  throwOnError = false,
}) {
  try {
    const effectiveActorType = actorType || req.auth?.actorType || req.admin?.actorType || null;
    const effectiveUserId = actorUserId || req.auth?.userId || null;
    const effectiveOrganizationId = organizationId || req.auth?.organizationId || null;
    const adminId = req.admin?.sub || null;

    if (effectiveActorType === 'app' || effectiveUserId) {
      const actorOrganizationId = req.auth?.organizationId;
      if (throwOnError && actorOrganizationId != null
        && String(effectiveOrganizationId) !== String(actorOrganizationId)) {
        throw new Error('Activity log organization mismatch');
      }
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
      }, store);
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
      }, store);
      return;
    }
    if (throwOnError) throw new Error('Audit actor is unavailable');
  } catch (err) {
    console.warn('Audit log yazilamadi', { message: err.message });
    if (throwOnError) throw err;
  }
}

module.exports = {
  auditLog,
};
