const db = require('../../db');
const { createCatalogAi } = require('../catalogAi');
const { prepareExternalImage } = require('../imports/externalImage');
const { assertStorageCapacity } = require('../../services/planLimits');
const { createObjectStorage } = require('../../services/objectStorage');
const {
  deleteObjectsBestEffort, enqueueCleanupObjects, syncMediaReferences, uploadPreparedAsset,
} = require('../../services/mediaAssets');

let running = false;
let scheduled = false;
let storageInstance = null;
function storage() { if (!storageInstance) storageInstance = createObjectStorage(); return storageInstance; }

function safeError(error) {
  const code = /^[A-Z0-9_]{3,100}$/.test(String(error?.code || '')) ? error.code : 'AI_ANALYSIS_FAILED';
  const message = Number(error?.status || 500) < 500 ? String(error.message || '').slice(0, 500) : 'AI katalog analizi tamamlanamadi';
  return { code, message, transient: Boolean(error?.transient) };
}

async function claimDraft() {
  const client = await db.getSystemPool().connect();
  try {
    await client.query('begin');
    await client.query(
      `update instagram_product_drafts set status='pending', analysis_locked_at=null, updated_at=now()
       where status='analyzing' and analysis_locked_at < now() - interval '10 minutes' and analysis_attempts < 5`
    );
    const result = await client.query(
      `select id, organization_id from instagram_product_drafts
       where status='pending' and analysis_available_at <= now() and analysis_attempts < 5
       order by analysis_available_at, created_at for update skip locked limit 1`
    );
    const draft = result.rows[0];
    if (draft) await client.query(
      `update instagram_product_drafts set status='analyzing', analysis_started_at=now(),
       analysis_locked_at=now(), analysis_attempts=analysis_attempts+1, updated_at=now() where id=$1`, [draft.id]
    );
    await client.query('commit');
    return draft || null;
  } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
  finally { client.release(); }
}

function sourceImages(media) {
  return (Array.isArray(media.source_metadata?.children) ? media.source_metadata.children : [])
    .map((item, position) => ({
      externalId: String(item.id || `${media.external_media_id}-${position}`).slice(0, 200),
      url: item.source_url || item.thumbnail_url || null,
      position,
    })).filter((item) => item.url).slice(0, 20);
}

async function processDraft(claim) {
  const uploadedKeys = [];
  let objectStorage;
  try {
    objectStorage = storage();
    await db.withTenantContext(claim.organization_id, async (client) => {
      const result = await client.query(
        `select d.*, m.caption, m.external_media_id, m.source_metadata, m.visual_analysis_limited
         from instagram_product_drafts d join instagram_media_items m
           on m.organization_id=d.organization_id and m.id=d.media_item_id
         where d.organization_id=$1 and d.id=$2 and d.status='analyzing' for update of d, m`,
        [claim.organization_id, claim.id]
      );
      const draft = result.rows[0];
      if (!draft) return;
      const sources = sourceImages(draft);
      if (!sources.length) throw Object.assign(new Error('Analiz edilebilir Instagram gorseli bulunamadi'), { code: 'INSTAGRAM_MEDIA_IMAGE_MISSING', status: 409 });
      const categoriesResult = await client.query(
        'select id, name from categories where organization_id=$1 order by name limit 200', [claim.organization_id]
      );
      const preparedImages = [];
      const uploadedImages = [];
      for (const source of sources) {
        const prepared = await prepareExternalImage(source.url, claim.organization_id);
        const bytes = prepared.variants.reduce((sum, item) => sum + item.byteSize, 0);
        await assertStorageCapacity(client, claim.organization_id, bytes);
        const uploaded = await uploadPreparedAsset(client, {
          organizationId: claim.organization_id, prepared, storage: objectStorage, createdBy: null,
        });
        uploadedKeys.push(...prepared.variants.map((item) => item.objectKey));
        const card = prepared.variants.find((item) => item.name === 'card');
        preparedImages.push({ data: card.data, contentType: card.contentType, position: source.position });
        uploadedImages.push({ source, uploaded });
      }
      const ai = createCatalogAi();
      const started = Date.now();
      const response = await ai.analyze({ caption: draft.caption || '', categories: categoriesResult.rows, images: preparedImages });
      const analysis = response.analysis;
      const terminal = analysis.classification === 'non_product'
        ? 'discarded' : analysis.classification !== 'product' || !analysis.facts.name || !analysis.facts.priceExplicit ? 'needs_review' : 'ready';
      const oldImages = await client.query(
        'select detail_url from instagram_product_draft_images where organization_id=$1 and draft_id=$2', [claim.organization_id, claim.id]
      );
      await client.query('delete from instagram_product_draft_images where organization_id=$1 and draft_id=$2', [claim.organization_id, claim.id]);
      const bindingByPosition = new Map(analysis.imageBindings.map((item) => [item.position, item]));
      for (const item of uploadedImages) {
        const binding = bindingByPosition.get(item.source.position);
        await client.query(
          `insert into instagram_product_draft_images
           (organization_id,draft_id,external_media_id,position,asset_id,detail_url,card_url,thumbnail_url,
            binding_type,bound_color,confidence,analysis_metadata)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
          [claim.organization_id, claim.id, item.source.externalId, item.source.position, item.uploaded.id,
            item.uploaded.urls.detail, item.uploaded.urls.card, item.uploaded.urls.thumbnail,
            binding?.color ? 'color' : 'general', binding?.color || null, binding?.confidence ?? null,
            JSON.stringify({ ai_position: item.source.position })]
        );
      }
      await syncMediaReferences(client, {
        organizationId: claim.organization_id, resourceType: 'instagram_product_draft', resourceId: claim.id,
        fieldName: 'images', values: uploadedImages.map((item) => item.uploaded.urls.detail), altText: analysis.facts.name || 'Instagram urun taslagi',
      });
      await client.query(
        `update instagram_product_drafts set status=$1, ai_provider=$2, ai_model=$3, prompt_version=$4,
          analysis_completed_at=now(), analysis_locked_at=null, analysis_usage=$5::jsonb, analysis_duration_ms=$6,
          product_name=$7, price=$8, price_explicit=$9, sale_price=$10, category_id=$11,
          category_confidence=$12, colors=$13::jsonb, sizes=$14::jsonb, fabric_info=$15,
          measurements=$16::jsonb, short_description=$17, description=$18, product_story=$19,
          tags=$20::jsonb, warnings=$21::jsonb, confidence=$22::jsonb, evidence=$23::jsonb,
          error_code=null,error_message=null,updated_at=now() where organization_id=$24 and id=$25`,
        [terminal, ai.name, ai.model, ai.promptVersion, JSON.stringify(response.usage || {}), Date.now() - started,
          analysis.facts.name, analysis.facts.price, analysis.facts.priceExplicit, analysis.facts.salePrice,
          analysis.facts.categoryId, analysis.classificationConfidence, JSON.stringify(analysis.facts.colors),
          JSON.stringify(analysis.facts.sizes), analysis.facts.fabric, JSON.stringify(analysis.facts.measurements),
          analysis.generated.shortDescription, analysis.generated.description, analysis.generated.productStory,
          JSON.stringify(analysis.generated.tags), JSON.stringify(analysis.warnings),
          JSON.stringify({ classification: analysis.classificationConfidence }),
          JSON.stringify({ source: 'instagram_caption_and_images', provider_request_id: response.providerRequestId }),
          claim.organization_id, claim.id]
      );
      await client.query(
        `update instagram_media_items set status=$1, classification=$2, classification_confidence=$3, updated_at=now()
         where organization_id=$4 and id=$5`,
        [terminal === 'discarded' ? 'skipped' : terminal, analysis.classification, analysis.classificationConfidence,
          claim.organization_id, draft.media_item_id]
      );
      void oldImages;
    });
  } catch (error) {
    if (objectStorage && uploadedKeys.length) {
      const failed = await deleteObjectsBestEffort(objectStorage, uploadedKeys);
      if (failed.length) await enqueueCleanupObjects({ organizationId: claim.organization_id, storage: objectStorage, objects: failed }).catch(() => {});
    }
    const safe = safeError(error);
    await db.withTenantContext(claim.organization_id, async (client) => {
      const current = await client.query('select analysis_attempts from instagram_product_drafts where organization_id=$1 and id=$2 for update', [claim.organization_id, claim.id]);
      const retry = safe.transient && Number(current.rows[0]?.analysis_attempts || 5) < 5;
      await client.query(
        `update instagram_product_drafts set status=$1, analysis_locked_at=null,
          analysis_available_at=case when $1='pending' then now() + interval '30 seconds' else analysis_available_at end,
          error_code=$2,error_message=$3,updated_at=now() where organization_id=$4 and id=$5`,
        [retry ? 'pending' : 'error', safe.code, safe.message, claim.organization_id, claim.id]
      );
      await client.query(
        `update instagram_media_items set status=$1,updated_at=now() where organization_id=$2
         and id=(select media_item_id from instagram_product_drafts where organization_id=$2 and id=$3)`,
        [retry ? 'analyzing' : 'error', claim.organization_id, claim.id]
      );
    });
  }
}

async function processInstagramDrafts({ maxDrafts = 3 } = {}) {
  if (running) return 0;
  running = true;
  let count = 0;
  try {
    while (count < Math.max(1, Math.min(Number(maxDrafts) || 3, 10))) {
      const claim = await claimDraft();
      if (!claim) break;
      await processDraft(claim);
      count += 1;
    }
    return count;
  } finally { running = false; }
}

function scheduleInstagramWorker() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => { scheduled = false; processInstagramDrafts().catch((error) => console.warn('Instagram katalog worker hatasi', { message: error.message })); });
}

function startInstagramWorker() {
  if (process.env.NODE_ENV === 'test' || process.env.INSTAGRAM_WORKER_ENABLED === 'false') return null;
  const delay = Math.max(2_000, Math.min(Number(process.env.INSTAGRAM_WORKER_INTERVAL_MS) || 10_000, 300_000));
  const startup = setTimeout(scheduleInstagramWorker, 2_000); startup.unref();
  const interval = setInterval(scheduleInstagramWorker, delay); interval.unref();
  return interval;
}

module.exports = { claimDraft, processDraft, processInstagramDrafts, safeError, scheduleInstagramWorker, sourceImages, startInstagramWorker };
