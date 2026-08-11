require('dotenv').config();

const db = require('../db');
const { createObjectStorage } = require('../services/objectStorage');
const { queueAssetDeletion, processCleanupJobs } = require('../services/mediaAssets');

async function cleanupOrphanMedia({
  execute = false,
  graceDays = Number(process.env.MEDIA_ORPHAN_GRACE_DAYS || 7),
  limit = 100,
  storage = createObjectStorage(),
  pool = db.getSystemPool(),
  logger = console,
} = {}) {
  const safeGraceDays = Math.max(1, Math.min(365, Number(graceDays) || 7));
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const candidates = await pool.query(
    `select id, organization_id
     from upload_assets ua
     where ua.status = 'orphan_candidate'
       and ua.orphaned_at < now() - make_interval(days => $1)
       and not exists (select 1 from media_references mr where mr.asset_id = ua.id)
     order by ua.orphaned_at asc
     limit $2`,
    [safeGraceDays, safeLimit]
  );
  if (!execute) {
    logger.log(`Media cleanup dry-run: ${candidates.rows.length} aday`);
    return { candidates: candidates.rows.length, queued: 0, processed: 0 };
  }

  let queued = 0;
  for (const candidate of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const outcome = await queueAssetDeletion(client, {
        organizationId: candidate.organization_id,
        assetId: candidate.id,
      });
      await client.query('commit');
      if (outcome.outcome === 'queued') queued += 1;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  const processed = await processCleanupJobs({ storage, limit: safeLimit * 3, pool });
  logger.log(`Media cleanup: ${queued} asset kuyruga alindi, ${processed.completed} object silindi, ${processed.failed} hata`);
  return { candidates: candidates.rows.length, queued, processed: processed.completed, failed: processed.failed };
}

async function main() {
  const pool = db.getSystemPool();
  try {
    await cleanupOrphanMedia({
      execute: process.argv.includes('--execute'),
      limit: process.env.MEDIA_CLEANUP_LIMIT || 100,
      pool,
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { cleanupOrphanMedia, main };
