const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  listCollectionProducts,
  normalizeMemberIds,
  replaceCollectionProducts,
} = require('../services/collectionMemberships');

function fakeClient() {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      if (/returning product_id/.test(text)) return { rows: [{ product_id: 1 }, { product_id: 3 }] };
      return { rows: [] };
    },
    find(re) {
      return queries.find((query) => re.test(query.text));
    },
  };
}

test('normalizeMemberIds sadece pozitif benzersiz id listesi dondurur', () => {
  assert.deepEqual(normalizeMemberIds(['1', 1, 'x', -5, 2.2, 3]), [1, 3]);
});

test('listCollectionProducts explicit relation tablosunu kullanir, tag slug eslesmesine guvenmez', async () => {
  const client = fakeClient();

  await listCollectionProducts(client, { organizationId: 'org-1', collectionId: 10 });

  const query = client.find(/from products p/);
  assert.match(query.text, /left join product_collections pc/);
  assert.match(query.text, /pc\.collection_id = \$2/);
  assert.match(query.text, /pc\.product_id = p\.id/);
  assert.match(query.text, /p\.organization_id = \$1/);
  assert.doesNotMatch(query.text, /lower\(.*tags/);
  assert.deepEqual(query.params, ['org-1', 10]);
});

test('replaceCollectionProducts eski uyelikleri silip yalniz tenant urunlerinden ekler', async () => {
  const client = fakeClient();

  const result = await replaceCollectionProducts(client, {
    organizationId: 'org-1',
    collectionId: 10,
    memberIds: [1, '3', 3, 'bad'],
  });

  assert.deepEqual(result, { memberCount: 2 });
  const deletion = client.find(/delete from product_collections/);
  assert.match(deletion.text, /organization_id = \$1 and collection_id = \$2/);
  assert.deepEqual(deletion.params, ['org-1', 10]);
  const insert = client.find(/insert into product_collections/);
  assert.match(insert.text, /from products p/);
  assert.match(insert.text, /p\.organization_id = \$1/);
  assert.match(insert.text, /p\.id = any\(\$3::bigint\[\]\)/);
  assert.deepEqual(insert.params, ['org-1', 10, [1, 3]]);
});

test('037 migration product_collections tablosu, unique index ve tag backfill icerir', () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const up = fs.readFileSync(path.join(dir, '037_product_collections.sql'), 'utf8');
  const down = fs.readFileSync(path.join(dir, '037_product_collections.down.sql'), 'utf8');

  assert.match(up, /create table if not exists product_collections/);
  assert.match(up, /collection_id bigint not null references collections\(id\) on delete cascade/);
  assert.match(up, /product_id bigint not null references products\(id\) on delete cascade/);
  assert.match(up, /idx_product_collections_unique/);
  assert.match(up, /regexp_split_to_table\(coalesce\(p\.tags, ''\), ','\)/);
  assert.match(down, /drop table if exists product_collections/);
});
