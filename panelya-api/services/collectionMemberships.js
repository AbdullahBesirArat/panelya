function normalizeMemberIds(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    ),
  ];
}

async function listCollectionProducts(client, { organizationId, collectionId }) {
  return client.query(
    `select
       p.id,
       p.name,
       p.status,
       p.tags,
       (pc.product_id is not null) as is_member
     from products p
     left join product_collections pc
       on pc.organization_id = p.organization_id
      and pc.collection_id = $2
      and pc.product_id = p.id
     where p.organization_id = $1
     order by p.name asc, p.id asc`,
    [organizationId, collectionId]
  );
}

async function replaceCollectionProducts(client, { organizationId, collectionId, memberIds }) {
  const ids = normalizeMemberIds(memberIds);
  await client.query(
    'delete from product_collections where organization_id = $1 and collection_id = $2',
    [organizationId, collectionId]
  );

  if (!ids.length) {
    return { memberCount: 0 };
  }

  const inserted = await client.query(
    `insert into product_collections (organization_id, collection_id, product_id)
     select $1, $2, p.id
     from products p
     where p.organization_id = $1
       and p.id = any($3::bigint[])
     on conflict (organization_id, collection_id, product_id) do nothing
     returning product_id`,
    [organizationId, collectionId, ids]
  );

  return { memberCount: inserted.rows.length };
}

module.exports = {
  listCollectionProducts,
  normalizeMemberIds,
  replaceCollectionProducts,
};
