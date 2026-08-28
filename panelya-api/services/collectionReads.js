'use strict';

const themes = require('../modules/themes/service');

function previewCollectionIds(config) {
  const ids = new Set();
  for (const section of config?.sections || []) {
    if (!section?.enabled || section.type !== 'collection-showcase') continue;
    for (const id of section.settings?.collectionIds || []) {
      const value = Number(id);
      if (Number.isInteger(value) && value > 0) ids.add(value);
    }
  }
  return [...ids];
}

async function listPublicCollections(client, { organizationId }) {
  const result = await client.query(
    `select *
       from collections
      where organization_id = $1 and active = true
      order by sort_order asc, id asc`,
    [organizationId]
  );
  return result.rows;
}

async function listPreviewCollections(client, {
  organizationId,
  token,
  resolvePreviewToken = themes.resolvePreviewToken,
}) {
  const preview = await resolvePreviewToken(client, { organizationId, token });
  const selectedIds = previewCollectionIds(preview.config);
  const result = await client.query(
    `select *
       from collections
      where organization_id = $1
        and (active = true or id = any($2::bigint[]))
      order by sort_order asc, id asc`,
    [organizationId, selectedIds]
  );
  return result.rows;
}

module.exports = {
  previewCollectionIds,
  listPublicCollections,
  listPreviewCollections,
};
