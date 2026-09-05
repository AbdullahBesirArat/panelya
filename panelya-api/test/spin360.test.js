const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeSpin360 } = require('../modules/catalog/spin360');
const { productParams } = require('../modules/catalog/validation');
const { productSelect } = require('../modules/catalog/repository');
const frames = [1, 2].map((n) => `/api/media/11111111-1111-4111-8111-${String(n).padStart(12, '0')}/detail`);
test('spin manifests preserve ordered managed frames and reject unsafe or ambiguous sets', () => {
  const valid = { frameCount: 2, poster: frames[0], frames };
  assert.deepEqual(normalizeSpin360(valid), valid);
  assert.equal(normalizeSpin360(null), null);
  for (const invalid of [ {}, { ...valid, frameCount: 12 }, { ...valid, poster: frames[1] },
    { ...valid, frames: [frames[0], frames[0]] },
    { frameCount: 2, poster: 'https://other.test/a.webp', frames: ['https://other.test/a.webp', 'https://other.test/b.webp'] } ]) {
    assert.throws(() => normalizeSpin360(invalid), { status: 400 });
  }
});
test('ordinary product writer cannot bypass spin ownership checks', () => {
  const details = { fabric_info: 'Pamuk', spin360: { frames } };
  const params = productParams({ name: 'Test', price: 100, details });
  assert.deepEqual(JSON.parse(params[9]), { fabric_info: 'Pamuk' });
  assert.ok(details.spin360);
});

test('card queries expose only lightweight canonical spin availability', () => {
  const cardSql = productSelect('p.organization_id = $1', { includeSpinManifest: false });
  assert.match(cardSql, /as has_spin360/);
  assert.match(cardSql, /jsonb_array_length\(p\.details->'spin360'->'frames'\) between 2 and 72/);
  assert.match(cardSql, /count\(distinct spin_frame\)/);
  assert.match(cardSql, /p\.details->'spin360'->>'poster' = p\.details->'spin360'->'frames'->>0/);
  assert.match(cardSql, /coalesce\(p\.details, '\{\}'::jsonb\) - 'spin360' as details/);
  assert.doesNotMatch(cardSql, /p\.details as details/);

  const detailSql = productSelect('p.id = $1');
  assert.match(detailSql, /p\.details as details/);
  assert.match(detailSql, /as has_spin360/);
});

test('every public product-card repository requests the lightweight spin contract', () => {
  const catalogRoot = path.join(__dirname, '..', 'modules', 'catalog');
  for (const file of ['publicRepository.js', 'cards.js', 'relations.js']) {
    const source = fs.readFileSync(path.join(catalogRoot, file), 'utf8');
    assert.match(source, /includeSpinManifest:\s*false/, `${file} must not return frame manifests`);
  }
  const controller = fs.readFileSync(path.join(catalogRoot, 'controller.js'), 'utf8');
  assert.match(controller, /includeSpinManifest:\s*isAdminManagementRequest\(req\)/);
});

test('association endpoint scopes writes, rolls back foreign assets, and never enters stock writes', async () => {
  const db = require('../db');
  const router = require('../routes/products');
  const route = router.stack.find(layer => layer.route?.path === '/:id/spin360').route;
  const handler = route.stack.at(-1).handle;
  const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const originalConnect = db.pool.connect;
  let foreign = false;
  const queries = [];
  const client = { release() {}, async query(sql, params) {
    queries.push({ sql, params });
    if (/from organizations/.test(sql)) return { rows: [{ id: organizationId, slug: 'suvera' }] };
    if (/select details from products/.test(sql)) return { rows: [{ details: {} }] };
    if (/select id\s+from upload_assets/.test(sql)) return { rows: foreign ? [] : frames.map(url => ({ id: url.split('/')[3] })) };
    return { rows: [] };
  } };
  db.pool.connect = async () => client;
  try {
    const req = { params: { id: '77' }, query: {}, body: { spin360: { frameCount: 2, poster: frames[0], frames } },
      auth: { actorType: 'app', role: 'owner', organizationId, organizationSlug: 'suvera' }, get: () => '' };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let error;
    await handler(req, res, value => { error = value; });
    assert.equal(error, undefined);
    assert.deepEqual(res.body.spin360.frames, frames);
    const update = queries.find(q => /update products/.test(q.sql));
    assert.deepEqual(update.params.slice(0, 2), ['77', organizationId]);
    assert.match(update.sql, /where id=\$1 and organization_id=\$2/);
    assert.ok(!queries.some(q => /inventory|product_variants|set stock|set price/i.test(q.sql)));
    assert.equal(queries.at(-1).sql, 'commit');
    foreign = true;
    queries.length = 0;
    await handler(req, res, value => { error = value; });
    assert.equal(error.status, 400);
    assert.equal(queries.at(-1).sql, 'rollback');
    assert.ok(!queries.some(q => /update products/.test(q.sql)));
    req.auth.organizationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await handler(req, res, value => { error = value; });
    assert.equal(res.statusCode, 403);
    route.stack[1].handle({ auth: { role: 'viewer' } }, res, () => assert.fail('viewer must be rejected'));
    assert.equal(res.statusCode, 403);
  } finally { db.pool.connect = originalConnect; }
});
