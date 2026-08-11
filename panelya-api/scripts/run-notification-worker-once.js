'use strict';

// One-shot notification outbox drain. Processes up to WORKER_MAX_ROWS pending rows
// and exits, printing the outcome counts as JSON. Used by E2E (the interval worker is
// disabled under NODE_ENV=test) and usable as a cron-style runner. Consent and
// suppression are re-checked at send time inside processNotificationOutbox.
const { processNotificationOutbox } = require('../modules/notifications/worker');
const db = require('../db');

(async () => {
  try {
    const counts = await processNotificationOutbox({
      maxRows: Math.max(1, Math.min(Number(process.env.WORKER_MAX_ROWS) || 50, 500)),
    });
    process.stdout.write(`${JSON.stringify(counts)}\n`);
  } catch (error) {
    process.stderr.write(`${(error && error.message) || error}\n`);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
    try { await db.getSystemPool().end(); } catch (_) { /* system pool may be unused */ }
  }
})();
