require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const helmet = require('helmet');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
const db = require('./db');
const { resolveUploadDir } = require('./services/uploads');
const {
  corsOptions,
  enforceHttps,
  ensureProductionReady,
  isProduction,
  requestId,
  rateLimit,
  safeErrorMessage,
  handleCorsPreflight,
} = require('./middleware/security');
const { attachAuthIfPresent } = require('./middleware/auth');
const { attachSession, requireMfaPolicy } = require('./middleware/authSession');
const {
  inventoryWorkerHealthSnapshot,
  inventoryWorkerPrometheus,
  metricsMiddleware,
  prometheusMetrics,
  resolveMetricsAccess,
} = require('./services/metrics');
const { deliverPendingOrderNotifications } = require('./services/orderOperations');
const { webVitalsPrometheus } = require('./services/webVitals');
const { REQUEST_TIMEOUT_MS, requestTimeout } = require('./middleware/requestTimeout');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const catalogRoutes = require('./routes/catalog');
const categoryRoutes = require('./routes/categories');
const orderRoutes = require('./routes/orders');
const customerRoutes = require('./routes/customers');
const customerAuthRoutes = require('./routes/customerAuth');
const uploadRoutes = require('./routes/upload');
const mediaRoutes = require('./routes/media');
const sliderRoutes = require('./routes/slider');
const campaignRoutes = require('./routes/campaigns');
const couponRoutes = require('./routes/coupons');
const collectionRoutes = require('./routes/collections');
const blogRoutes = require('./routes/blog');
const wishlistRoutes = require('./routes/wishlist');
const paymentRoutes = require('./routes/payment');
const auditRoutes = require('./routes/audit');
const organizationRoutes = require('./routes/organizations');
const platformRoutes = require('./routes/platform');
const returnRoutes = require('./routes/returns');
const shipmentRoutes = require('./routes/shipments');
const invoiceRoutes = require('./routes/invoices');
const importRoutes = require('./routes/imports');
const cartRoutes = require('./routes/cart');
const cartOperationsRoutes = require('./routes/cartOperations');
const reviewRoutes = require('./routes/reviews');
const questionRoutes = require('./routes/questions');
const reviewOperationsRoutes = require('./routes/reviewOperations');
const notificationRoutes = require('./routes/notifications');
const notificationOperationsRoutes = require('./routes/notificationOperations');
const relationOperationsRoutes = require('./routes/relationOperations');
const recentlyViewedRoutes = require('./routes/recentlyViewed');
const sizeGuideOperationsRoutes = require('./routes/sizeGuideOperations');
const comparisonRoutes = require('./routes/comparison');
const customerAddressRoutes = require('./routes/customerAddresses');
const orderClaimRoutes = require('./routes/orderClaims');
const giftWrapOperationsRoutes = require('./routes/giftWrapOperations');
const subscriptionRoutes = require('./routes/subscription');
const subscriptionOperationsRoutes = require('./routes/subscriptionOperations');
const domainRoutes = require('./routes/domains');
const domainOperationsRoutes = require('./routes/domainOperations');
const themeRoutes = require('./routes/themes');
const storefrontThemeRoutes = require('./routes/storefrontTheme');
const integrationRoutes = require('./routes/integrations');
const instagramImportRoutes = require('./routes/instagramImports');
const securityRoutes = require('./routes/security');
const webVitalsRoutes = require('./routes/webVitals');
const v1Routes = require('./routes/v1');
const { startWebhookWorker } = require('./modules/integrations/worker');
const { startImportWorker } = require('./modules/imports/worker');
const { startAbandonedCartWorker } = require('./modules/cart/abandoned');
const { startNotificationOutboxWorker } = require('./modules/notifications/worker');
const { startSubscriptionLifecycleWorker } = require('./services/subscriptionWorker');
const { startInstagramWorker } = require('./modules/instagram/worker');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '';
const uploadDir = resolveUploadDir();
let startupReadinessError = null;

try {
  ensureProductionReady();
} catch (err) {
  startupReadinessError = err;
  console.error(`Panelya API readiness failed: ${err.message}`);
}

try {
  fs.mkdirSync(uploadDir, { recursive: true });
  console.log(`Panelya uploads directory: ${uploadDir}`);
} catch (err) {
  console.error(`Uploads directory could not be created: ${err.message}`);
}
app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: API saglik kontrolu
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: Servis calisiyor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 service:
 *                   type: string
 *                   example: panelya-api
 *                 env:
 *                   type: string
 *                   example: staging
 */
async function reservationWorkerHealth() {
  try {
    const result = await db.systemQuery(
      `select last_started_at, last_succeeded_at, last_failed_at, processed_count
         from inventory_worker_health
        where job_name = 'inventory_reservation_expiry'
        limit 1`
    );
    return inventoryWorkerHealthSnapshot(result.rows[0]);
  } catch (_) {
    return { status: 'unavailable', healthy: false };
  }
}

app.get('/api/health', async (req, res) => {
  const inventoryReservationExpiry = await reservationWorkerHealth();
  res.json({
    ok: true,
    ready: !startupReadinessError,
    service: 'panelya-api',
    env: process.env.NODE_ENV || 'development',
    workers: { inventoryReservationExpiry },
  });
});

if (process.env.NODE_ENV === 'test' && process.env.E2E_TEST_MODE === 'true') {
  // A27 test harness: seeds the deterministic in-process DNS resolver so E2E never depends
  // on real internet DNS. Gated by the same NODE_ENV=test + E2E_TEST_MODE condition as the
  // delay endpoint above, and it only touches the static resolver — which getResolver()
  // already refuses to hand out outside a test environment.
  app.post('/api/__e2e__/dns', express.json(), (req, res) => {
    const { getResolver, staticResolver, setResolver } = require('./services/dnsResolver');
    let resolver;
    try {
      resolver = getResolver();
    } catch (_) {
      resolver = null;
    }
    if (!resolver || resolver.name !== 'static') {
      resolver = staticResolver();
      setResolver(resolver);
    }
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name zorunlu' });
    resolver.set(name, [].concat(req.body?.values || []));
    return res.json({ ok: true, name });
  });

  app.get('/api/__e2e__/delay', async (req, res) => {
    // The cap must stay above the BFF's own budget, or the timeout spec cannot make the
    // BFF give up. Reachable only under NODE_ENV=test + E2E_TEST_MODE, as above.
    const delayMs = Math.min(Math.max(Number(req.query.ms) || 0, 0), 10000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.json({ ok: true, delayMs });
  });
}

app.use(requestId);
app.use(metricsMiddleware);
app.use(enforceHttps);
app.use(requestTimeout);

app.get('/api/metrics', async (req, res) => {
  const access = resolveMetricsAccess({
    env: process.env.NODE_ENV,
    configuredToken: process.env.METRICS_TOKEN,
    authorizationHeader: req.get('authorization'),
  });
  if (access === 'not_found') {
    // Production without METRICS_TOKEN must not expose metrics publicly.
    return res.status(404).json({ error: 'Not found', requestId: req.id });
  }
  if (access === 'unauthorized') {
    return res.status(401).json({ error: 'Metrics token gerekli', requestId: req.id });
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  const inventoryReservationExpiry = await reservationWorkerHealth();
  res.send(`${prometheusMetrics()}${webVitalsPrometheus()}${inventoryWorkerPrometheus(inventoryReservationExpiry)}\n`);
});

// Public uploads should be readable from storefronts without CORS allowlist coupling.
// CORS middleware can reject unknown origins and would otherwise block images with 500.
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});
app.use('/uploads', express.static(uploadDir, {
  dotfiles: 'deny',
  index: false,
  fallthrough: true,
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
  },
}));

app.get('/uploads/:filename', async (req, res, next) => {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || filename !== req.params.filename || !/^[a-z0-9._-]+$/i.test(filename)) {
    return res.status(404).json({ error: 'Dosya bulunamadi', requestId: req.id });
  }

  try {
    const result = await db.systemQuery(
      `select data, mime_type, byte_size
       from upload_assets
       where filename = $1
         and data is not null
         and status <> 'deleted'
       order by created_at desc
       limit 1`,
      [filename]
    );
    const asset = result.rows[0];
    if (!asset) {
      return res.status(404).json({ error: 'Dosya bulunamadi', requestId: req.id });
    }

    res.setHeader('Content-Type', asset.mime_type || 'image/webp');
    res.setHeader('Content-Length', String(asset.byte_size || asset.data.length));
    res.setHeader('Cache-Control', process.env.NODE_ENV === 'production' ? 'public, max-age=604800, immutable' : 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    if (req.method === 'HEAD') return res.end();
    return res.send(asset.data);
  } catch (err) {
    return next(err);
  }
});
app.use('/uploads', (err, req, res, next) => {
  if (!err) return next();
  if (err.code === 'ENOENT' || err.status === 404) {
    return res.status(404).json({ error: 'Dosya bulunamadi', requestId: req.id });
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return res.status(503).json({ error: 'Uploads klasorune erisim yok', requestId: req.id });
  }
  return next(err);
});

app.use(handleCorsPreflight);
app.use((req, res, next) => {
  if (!startupReadinessError) return next();

  return res.status(503).json({
    error: 'API konfigurasyonu tamamlanmadi',
    requestId: req.id,
  });
});
if (!isProduction()) {
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Panelya API Docs',
    swaggerOptions: { persistAuthorization: true },
  }));
  app.get('/api/docs-json', (req, res) => res.json(swaggerSpec));
}
app.use(helmet({
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors(startupReadinessError
  ? { credentials: true, origin: true }
  : corsOptions()));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT || 1200),
}));
// The public beacon gets a much smaller parser budget and its own rate limit. Mount it
// before the general API JSON parser so a telemetry request can never claim 2 MB.
app.use('/api/web-vitals', webVitalsRoutes);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(attachAuthIfPresent);
// A30: resolve the session an access token names, once, for every route. A revoked session
// has to stop working immediately rather than when its token expires, and no route should
// have to remember to check that itself.
app.use(attachSession);
app.use(db.requestContextMiddleware);

app.use('/api/auth', authRoutes);
// Enrollment, factor verification and logout must remain reachable before the policy
// gate; otherwise a required user could never satisfy the policy that blocks them.
app.use('/api/security', securityRoutes);
// No-auth public/customer/v1 requests pass through unchanged. Authenticated admin/app
// business routes are checked centrally so a newly-added route cannot silently forget the
// tenant/super-admin MFA policy.
app.use(requireMfaPolicy);
app.use('/api/products', productRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/customer-auth', customerAuthRoutes);
app.use('/api/customer-addresses', customerAddressRoutes);
app.use('/api/customer-orders', orderClaimRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/slider', sliderRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/platform', platformRoutes);
  app.use('/api/returns', returnRoutes);
  app.use('/api/shipments', shipmentRoutes);
  app.use('/api/invoices', invoiceRoutes);
  app.use('/api/imports', importRoutes);
  app.use('/api/cart', cartRoutes);
  app.use('/api/operations/carts', cartOperationsRoutes);
  app.use('/api/reviews', reviewRoutes);
  app.use('/api/questions', questionRoutes);
  app.use('/api/operations/reviews', reviewOperationsRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/operations/notifications', notificationOperationsRoutes);
  app.use('/api/operations/relations', relationOperationsRoutes);
  app.use('/api/recently-viewed', recentlyViewedRoutes);
  app.use('/api/operations/size-guides', sizeGuideOperationsRoutes);
  app.use('/api/comparison', comparisonRoutes);
  app.use('/api/operations/gift-wrap', giftWrapOperationsRoutes);
  app.use('/api/subscription', subscriptionRoutes);
  app.use('/api/operations/subscriptions', subscriptionOperationsRoutes);
  app.use('/api/domains', domainRoutes);
  app.use('/api/operations/domains', domainOperationsRoutes);
  app.use('/api/themes', themeRoutes);
  app.use('/api/storefront-theme', storefrontThemeRoutes);
  app.use('/api/integrations', integrationRoutes);
  app.use('/api/instagram-imports', instagramImportRoutes);
  // A29: the public, versioned external API. Mounted at its own prefix, with its own
  // authentication (API key, not session) and its own stable error contract, so an
  // integration written against it is not coupled to the dashboard's internal routes.
  app.use('/v1', v1Routes);

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadi', requestId: req.id });
});

app.use((err, req, res, next) => {
  console.error({
    requestId: req.id,
    method: req.method,
    path: req.path,
    status: err.status || 500,
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
  const status = err.status || 500;
  res.status(status).json({
    error: safeErrorMessage(err),
    ...(typeof err.code === 'string' && /^[A-Z0-9_]+$/.test(err.code) ? { code: err.code } : {}),
    ...(err.details && status < 500 ? { details: err.details } : {}),
    requestId: req.id,
  });
});

function listen(portToBind) {
  const server = host
    ? app.listen(portToBind, host, () => {
      console.log(`Panelya API ${host}:${portToBind} uzerinde calisiyor`);
    })
    : app.listen(portToBind, () => {
      console.log(`Panelya API ${portToBind} portunda calisiyor`);
  });

  server.on('error', (err) => {
    console.error(`Panelya API ${portToBind} portunda baslatilamadi: ${err.message}`);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
}

function startOrderNotificationOutboxWorker() {
  if (
    process.env.NODE_ENV === 'test'
    || process.env.ORDER_NOTIFICATION_OUTBOX_WORKER_ENABLED === 'false'
  ) return null;

  const intervalMs = Math.min(
    Math.max(Number(process.env.ORDER_NOTIFICATION_OUTBOX_INTERVAL_MS) || 15_000, 1_000),
    300_000
  );
  const run = () => deliverPendingOrderNotifications({
    limit: process.env.ORDER_NOTIFICATION_OUTBOX_BATCH_SIZE,
    staleAfterMinutes: process.env.ORDER_NOTIFICATION_OUTBOX_STALE_MINUTES,
  }).catch((error) => {
    console.warn(`Siparis bildirim outbox islenemedi: ${error.message}`);
  });
  const startupTimer = setTimeout(run, 1_000);
  startupTimer.unref();
  const interval = setInterval(run, intervalMs);
  interval.unref();
  return interval;
}

listen(port);
startOrderNotificationOutboxWorker();
startImportWorker();
startAbandonedCartWorker();
startNotificationOutboxWorker();
startSubscriptionLifecycleWorker();
startWebhookWorker();
startInstagramWorker();
