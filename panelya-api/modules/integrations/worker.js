'use strict';

// A29 webhook delivery worker.
//
// Same shape as the A23 notification worker and the A26 lifecycle worker: a DB-backed queue
// claimed with FOR UPDATE SKIP LOCKED, no new broker, no new dependency. What is specific
// to A29 is the outcome policy — which HTTP results retry, which are fatal, and when a
// persistently failing endpoint stops consuming worker capacity.
//
// Clock and randomness are injected so backoff and jitter can be asserted exactly rather
// than slept on. A test that measures elapsed wall time to check a backoff is a flaky test.

const crypto = require('crypto');
const db = require('../../db');
const { HEADERS, signPayload } = require('./signature');
const { decryptSecret } = require('./secretCrypto');
const { sendWebhook } = require('./httpDelivery');
const { eventBody } = require('./outbox');

const BACKOFF_BASE_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 6 * 3600;
// How many consecutive failures before an endpoint is switched off. A receiver that has
// failed this many times in a row is not coming back on its own, and every further attempt
// is capacity taken from tenants whose endpoints work.
const FAILURE_DISABLE_THRESHOLD = Number(process.env.WEBHOOK_FAILURE_THRESHOLD || 15);
// A row claimed by a worker that then died must not be stuck forever.
const STALE_LOCK_SECONDS = Number(process.env.WEBHOOK_STALE_LOCK_SECONDS || 300);

/**
 * Exponential backoff with full jitter. The jitter matters: without it, a receiver that
 * fails during an incident gets every pending delivery retried at the same instant,
 * repeatedly, which is how a struggling endpoint is kept down.
 */
function backoffSeconds(attempt, random = Math.random) {
  const ceiling = Math.min(BACKOFF_BASE_SECONDS * (2 ** Math.max(0, attempt - 1)), MAX_BACKOFF_SECONDS);
  const jittered = Math.floor(ceiling * (0.5 + (random() * 0.5)));
  return Math.max(1, jittered);
}

/**
 * The single place that decides what an HTTP result means. Routes and the admin UI read
 * this rather than re-deriving it, so "was that a success" has exactly one answer.
 */
function classifyResponse(status) {
  if (status >= 200 && status < 300) return { outcome: 'delivered', code: null };
  // A redirect is NOT a success and is never followed: see httpDelivery.js. It is fatal
  // because the receiver is misconfigured, and retrying will produce the same 3xx.
  if (status >= 300 && status < 400) return { outcome: 'failed_permanent', code: 'REDIRECT_NOT_FOLLOWED' };
  if (status === 408 || status === 429) return { outcome: 'failed_retryable', code: `HTTP_${status}` };
  // Other 4xx mean the receiver understood and refused. Retrying a refusal is pointless,
  // so it counts against the endpoint immediately instead of eight times.
  if (status >= 400 && status < 500) return { outcome: 'failed_permanent', code: `HTTP_${status}` };
  return { outcome: 'failed_retryable', code: `HTTP_${status || 0}` };
}

async function loadDeliveryContext(client, row) {
  const result = await client.query(
    `select e.event_id, e.event_type, e.schema_version, e.aggregate_type, e.aggregate_id,
            e.aggregate_version, e.payload, e.occurred_at,
            w.url as endpoint_url, w.status as endpoint_status,
            s.id as secret_id, s.ciphertext, s.version as secret_version
       from webhook_deliveries d
       join integration_events e
         on e.organization_id = d.organization_id and e.id = d.event_id
       join webhook_endpoints w
         on w.organization_id = d.organization_id and w.id = d.endpoint_id
       left join webhook_endpoint_secrets s
         on s.organization_id = d.organization_id and s.id = d.secret_version_id
      where d.organization_id = $1 and d.id = $2`,
    [row.organization_id, row.id]
  );
  return result.rows[0] || null;
}

async function recordSuccess(client, row, context, response) {
  await client.query(
    `update webhook_deliveries
        set status = 'delivered', response_status = $3, duration_ms = $4, delivered_at = now(),
            error_code = null, error_detail = null, locked_at = null, locked_by = null, updated_at = now()
      where organization_id = $1 and id = $2`,
    [row.organization_id, row.id, response.status, response.durationMs]
  );
  // Any success clears the failure streak: the threshold measures "is this endpoint dead
  // right now", not "has it ever failed".
  await client.query(
    `update webhook_endpoints set consecutive_failures = 0, updated_at = now()
      where organization_id = $1 and id = $2 and consecutive_failures > 0`,
    [row.organization_id, row.endpoint_id]
  );
}

async function recordFailure(client, row, { code, detail, status, durationMs, permanent }, random) {
  const exhausted = row.attempt >= row.max_attempts;
  const dead = permanent || exhausted;
  if (dead) {
    await client.query(
      `update webhook_deliveries
          set status = 'dead_letter', response_status = $3, duration_ms = $4, error_code = $5,
              error_detail = $6, locked_at = null, locked_by = null, updated_at = now()
        where organization_id = $1 and id = $2`,
      [row.organization_id, row.id, status, durationMs, code, detail]
    );
  } else {
    const seconds = backoffSeconds(row.attempt, random);
    await client.query(
      `update webhook_deliveries
          set status = 'retry', response_status = $3, duration_ms = $4, error_code = $5,
              error_detail = $6, next_attempt_at = now() + make_interval(secs => $7),
              locked_at = null, locked_by = null, updated_at = now()
        where organization_id = $1 and id = $2`,
      [row.organization_id, row.id, status, durationMs, code, detail, seconds]
    );
  }

  const endpoint = await client.query(
    `update webhook_endpoints
        set consecutive_failures = consecutive_failures + 1, updated_at = now()
      where organization_id = $1 and id = $2
     returning consecutive_failures`,
    [row.organization_id, row.endpoint_id]
  );
  const failures = Number(endpoint.rows[0]?.consecutive_failures || 0);
  if (failures >= FAILURE_DISABLE_THRESHOLD) {
    // Disabling stops further deliveries; it never touches the endpoint's ownership,
    // subscriptions or secrets, so a receiver returning 500 cannot cost a tenant anything
    // beyond having to press "enable" once it is fixed.
    await client.query(
      `update webhook_endpoints
          set status = 'disabled', disabled_at = now(), disabled_reason = $3, updated_at = now()
        where organization_id = $1 and id = $2 and status = 'active'`,
      [row.organization_id, row.endpoint_id, `${failures} ardisik basarisiz teslimat`]
    );
  }
  return dead ? 'dead_letter' : 'retry';
}

async function processDelivery(client, row, { random, env }) {
  const context = await loadDeliveryContext(client, row);
  if (!context) {
    await client.query(
      `update webhook_deliveries set status = 'cancelled', error_code = 'CONTEXT_MISSING',
              locked_at = null, locked_by = null, updated_at = now()
        where organization_id = $1 and id = $2`,
      [row.organization_id, row.id]
    );
    return 'cancelled';
  }
  if (context.endpoint_status !== 'active') {
    await client.query(
      `update webhook_deliveries set status = 'cancelled', error_code = 'ENDPOINT_INACTIVE',
              locked_at = null, locked_by = null, updated_at = now()
        where organization_id = $1 and id = $2`,
      [row.organization_id, row.id]
    );
    return 'cancelled';
  }
  if (!context.ciphertext) {
    return recordFailure(client, row, {
      code: 'NO_SIGNING_SECRET', detail: null, status: null, durationMs: null, permanent: true,
    }, random);
  }

  let secret;
  try {
    secret = decryptSecret(context.ciphertext, { endpointId: row.endpoint_id }, env);
  } catch (_) {
    return recordFailure(client, row, {
      code: 'SECRET_UNREADABLE', detail: null, status: null, durationMs: null, permanent: true,
    }, random);
  }

  // Serialize ONCE. These exact bytes are what gets signed and what gets sent; re-encoding
  // the object for the request would produce a signature over something else.
  const body = Buffer.from(JSON.stringify(eventBody(context)), 'utf8');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload({ secret, timestamp, rawBody: body });
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

  let response;
  try {
    response = await sendWebhook({
      url: context.endpoint_url,
      // The SAME buffer that was signed above. Serializing again here — or forgetting to
      // pass it at all — means the receiver verifies a signature over bytes it never got.
      body,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Panelya-Webhooks/1.0',
        [HEADERS.eventId]: context.event_id,
        [HEADERS.eventType]: context.event_type,
        [HEADERS.timestamp]: String(timestamp),
        [HEADERS.signature]: signature,
        [HEADERS.secretVersion]: String(context.secret_version || 1),
        [HEADERS.delivery]: String(row.id),
      },
      env,
    });
  } catch (error) {
    await client.query(
      'update webhook_deliveries set payload_hash = $3 where organization_id = $1 and id = $2',
      [row.organization_id, row.id, payloadHash]
    );
    // An SSRF refusal is fatal for this delivery: the address will not become public on a
    // retry, and hammering it would turn the worker into the scanner.
    const permanent = error.code === 'SSRF_PRIVATE_ADDRESS';
    return recordFailure(client, row, {
      code: error.code || 'CONNECTION_ERROR', detail: null, status: null, durationMs: null, permanent,
    }, random);
  }

  await client.query(
    'update webhook_deliveries set payload_hash = $3 where organization_id = $1 and id = $2',
    [row.organization_id, row.id, payloadHash]
  );

  const verdict = classifyResponse(response.status);
  if (verdict.outcome === 'delivered') {
    await recordSuccess(client, row, context, response);
    return 'delivered';
  }
  return recordFailure(client, row, {
    code: verdict.code,
    // The receiver's body is untrusted and already truncated by the client; only a short,
    // bounded snippet is kept so an operator can see what came back.
    detail: response.bodyPreview ? response.bodyPreview.slice(0, 200) : null,
    status: response.status,
    durationMs: response.durationMs,
    permanent: verdict.outcome === 'failed_permanent',
  }, random);
}

async function processWebhookDeliveries({
  maxRows = 25,
  workerId = `webhook-${process.pid}`,
  random = Math.random,
  env = process.env,
} = {}) {
  const counts = { delivered: 0, retry: 0, dead_letter: 0, cancelled: 0 };
  for (let processed = 0; processed < maxRows; processed += 1) {
    const claimed = await db.systemQuery(
      `update webhook_deliveries
          set status = 'processing', attempt = attempt + 1, locked_at = now(),
              locked_by = $1, updated_at = now()
        where id = (
          select id from webhook_deliveries
           where (status in ('pending','retry') and next_attempt_at <= now())
              -- Stale lock recovery: a worker that died mid-flight leaves a 'processing'
              -- row, which would otherwise never be retried by anyone.
              or (status = 'processing' and locked_at < now() - make_interval(secs => $2))
           order by next_attempt_at, id for update skip locked limit 1
        )
        returning *`,
      [workerId, STALE_LOCK_SECONDS]
    );
    const row = claimed.rows[0];
    if (!row) break;

    try {
      const outcome = await db.withTenantContext(row.organization_id, async (client) =>
        processDelivery(client, row, { random, env }));
      counts[outcome] = (counts[outcome] || 0) + 1;
    } catch (error) {
      // An unexpected failure must not lose the row or leave it locked.
      await db.systemQuery(
        `update webhook_deliveries
            set status = 'retry', error_code = 'WORKER_ERROR',
                next_attempt_at = now() + make_interval(secs => $3),
                locked_at = null, locked_by = null, updated_at = now()
          where organization_id = $1 and id = $2`,
        [row.organization_id, row.id, backoffSeconds(row.attempt, random)]
      );
      counts.retry += 1;
    }
  }
  return counts;
}

let webhookWorkerRunning = false;

async function scheduleWebhookWorker() {
  if (webhookWorkerRunning) return;
  webhookWorkerRunning = true;
  try {
    await processWebhookDeliveries({
      maxRows: Math.max(1, Math.min(Number(process.env.WEBHOOK_WORKER_BATCH_SIZE) || 25, 200)),
    });
  } catch (error) {
    console.warn(`Webhook teslimatlari islenemedi: ${error.message}`);
  } finally {
    webhookWorkerRunning = false;
  }
}

function startWebhookWorker() {
  if (process.env.WEBHOOK_WORKER_ENABLED === 'false') return null;
  // Off by default under NODE_ENV=test so unit runs never open sockets, but the E2E suite
  // needs the real worker: a webhook pipeline that is only ever driven by hand in tests is
  // a pipeline nobody has proven end to end.
  if (process.env.NODE_ENV === 'test' && process.env.WEBHOOK_WORKER_ENABLED !== 'true') return null;
  const intervalMs = Math.max(2_000, Math.min(Number(process.env.WEBHOOK_WORKER_INTERVAL_MS) || 10_000, 300_000));
  const startup = setTimeout(scheduleWebhookWorker, 2_000);
  startup.unref();
  const interval = setInterval(scheduleWebhookWorker, intervalMs);
  interval.unref();
  return interval;
}

module.exports = {
  BACKOFF_BASE_SECONDS,
  startWebhookWorker,
  FAILURE_DISABLE_THRESHOLD,
  MAX_BACKOFF_SECONDS,
  STALE_LOCK_SECONDS,
  backoffSeconds,
  classifyResponse,
  processWebhookDeliveries,
  scheduleWebhookWorker,
};
