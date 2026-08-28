'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  previewCollectionIds,
  listPublicCollections,
  listPreviewCollections,
} = require('../services/collectionReads');

function themeWithCollectionIds(ids) {
  return {
    sections: [
      { id: 'hidden', type: 'collection-showcase', enabled: false, settings: { collectionIds: [999] } },
      { id: 'collections', type: 'collection-showcase', enabled: true, settings: { collectionIds: ids } },
    ],
  };
}

test('public collections remain tenant-scoped and active-only even when a query flag exists', async () => {
  let call;
  const client = {
    async query(sql, params) {
      call = { sql, params };
      return { rows: [{ id: 1, active: true }] };
    },
  };
  const rows = await listPublicCollections(client, { organizationId: 'tenant-a', includeInactive: true });
  assert.deepEqual(rows, [{ id: 1, active: true }]);
  assert.match(call.sql, /organization_id = \$1 and active = true/);
  assert.deepEqual(call.params, ['tenant-a']);
  assert.doesNotMatch(call.sql, /includeInactive/i);
});

test('preview selection accepts only enabled collection-showcase ids', () => {
  assert.deepEqual(previewCollectionIds(themeWithCollectionIds([7, 7, 8, -1, 'bad'])), [7, 8]);
});

test('a valid preview reads same-tenant active rows plus explicitly selected inactive rows', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 7, active: false }, { id: 9, active: true }] };
    },
  };
  let validated;
  const rows = await listPreviewCollections(client, {
    organizationId: 'tenant-a',
    token: 'valid-token',
    resolvePreviewToken: async (_client, input) => {
      validated = input;
      return { config: themeWithCollectionIds([7]) };
    },
  });
  assert.deepEqual(validated, { organizationId: 'tenant-a', token: 'valid-token' });
  assert.deepEqual(rows.map((row) => row.id), [7, 9]);
  assert.match(calls[0].sql, /organization_id = \$1/);
  assert.match(calls[0].sql, /active = true or id = any\(\$2::bigint\[\]\)/);
  assert.deepEqual(calls[0].params, ['tenant-a', [7]]);
});

test('invalid, expired, and cross-tenant preview credentials fail before collection data is read', async () => {
  for (const code of ['invalid', 'expired', 'cross-tenant']) {
    let queried = false;
    const client = { async query() { queried = true; return { rows: [] }; } };
    await assert.rejects(
      listPreviewCollections(client, {
        organizationId: 'tenant-b',
        token: code,
        resolvePreviewToken: async () => {
          const error = new Error('generic preview failure');
          error.code = 'THEME_PREVIEW_INVALID';
          throw error;
        },
      }),
      (error) => error.code === 'THEME_PREVIEW_INVALID'
    );
    assert.equal(queried, false, `${code} must not reach the collections query`);
  }
});

test('the preview endpoint is GET-only, uses the canonical validator, and cannot publish or write collections', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'collections.js'), 'utf8');
  const previewRoute = route.slice(route.indexOf("router.get('/preview'"), route.indexOf("router.get('/admin/all'"));
  assert.match(previewRoute, /listPreviewCollections/);
  assert.match(previewRoute, /x-theme-preview-token/);
  assert.doesNotMatch(previewRoute, /publishDraft|insert into|update collections|delete from/);
  assert.equal(route.includes("router.post('/preview'"), false);
});
