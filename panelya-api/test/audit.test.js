const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { auditLog } = require('../services/audit');

const orgA = 'a0000000-0000-4000-8000-000000000001';
const orgB = 'b0000000-0000-4000-8000-000000000002';
const request = { auth: { actorType: 'app' }, ip: '127.0.0.1', get: () => 'audit-test' };
const entry = { action: 'TEST', resourceType: 'fixture', resourceId: 42, newValue: { updated: true } };

test('audit routes standalone and global activity and preserves the insert payload', async (t) => {
  const runtime = { query: t.mock.fn(async () => {}) };
  const system = { query: t.mock.fn(async () => {}) };
  const standalone = t.mock.method(db, 'withStandaloneTenantTransaction', async (_, fn) => fn(runtime));
  t.mock.method(db, 'getSystemPool', () => system);

  await auditLog(request, { ...entry, organizationId: orgA });
  assert.equal(standalone.mock.calls[0].arguments[0], orgA);
  assert.deepEqual(runtime.query.mock.calls[0].arguments[1], [
    orgA, null, 'TEST', 'fixture', '42',
    JSON.stringify({ oldValue: null, newValue: { updated: true }, success: true, errorMessage: null }),
    request.ip, 'audit-test',
  ]);
  await auditLog(request, entry);
  assert.equal(standalone.mock.callCount(), 1);
  assert.equal(system.query.mock.calls[0].arguments[1][0], null);
});

test('audit rejects a request organization mismatch before selecting any SQL executor', async (t) => {
  t.mock.method(db, 'currentTenantOrganizationId', () => orgA);
  const executors = ['withTenantContext', 'withStandaloneTenantTransaction', 'getSystemPool', 'query']
    .map((method) => t.mock.method(db, method, () => {}));
  const warn = t.mock.method(console, 'warn', () => {});

  await auditLog(request, { ...entry, organizationId: orgB });
  for (const executor of executors) assert.equal(executor.mock.callCount(), 0);
  assert.deepEqual(warn.mock.calls[0].arguments[1], {
    activeOrganizationId: orgA, entryOrganizationId: orgB,
  });
});

test('audit rolls back and releases an explicit transaction savepoint after a failed insert', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const statements = [];
  const client = {
    release() {},
    async query(sql) {
      if (sql.startsWith('insert into activity_logs')) {
        statements.push('insert');
        throw Object.assign(new Error('missing actor'), { code: '23503' });
      }
      statements.push(sql);
    },
  };

  await auditLog(request, { ...entry, store: client, organizationId: orgA });
  assert.deepEqual(statements, [
    'savepoint app_activity_audit', 'insert',
    'rollback to savepoint app_activity_audit', 'release savepoint app_activity_audit',
  ]);
});
