const test = require('node:test');
const assert = require('node:assert/strict');

test('checksum media lookup is validated, bounded and tenant scoped', async () => {
  const db = require('../db');
  const route = require('../routes/media').stack.find(layer => layer.route?.path === '/').route;
  const handler = route.stack.at(-1).handle;
  const original = db.query;
  const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const checksum = 'a'.repeat(64);
  const queries = [];
  db.query = async (sql, params) => {
    queries.push({ sql, params });
    return { rows: /from organizations/.test(sql) ? [{ id: organizationId, slug: 'suvera' }] : [{ checksum }] };
  };
  const req = { query: { checksums: checksum }, auth: { actorType: 'app', role: 'owner', organizationId, organizationSlug: 'suvera' }, get: () => '' };
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    await handler(req, res, error => { throw error; });
    const lookup = queries.find(query => /from upload_assets/.test(query.sql));
    assert.deepEqual(lookup.params, [organizationId, [checksum]]);
    assert.match(lookup.sql, /ua.organization_id = \$1/);
    assert.match(lookup.sql, /ua.checksum = any\(\$2::text\[\]\)/);
    assert.match(lookup.sql, /limit 200/);
    assert.deepEqual(res.body, [{ checksum }]);
    for (const value of ['', 'not-a-hash', Array(73).fill(checksum).join(',')]) {
      queries.length = 0;
      req.query.checksums = value;
      await handler(req, res, error => { throw error; });
      assert.equal(res.statusCode, 400);
      assert.equal(queries.length, 0);
    }
    route.stack[1].handle({ auth: { role: 'viewer' } }, res, () => assert.fail('viewer must be rejected'));
    assert.equal(res.statusCode, 403);
  } finally { db.query = original; }
});
