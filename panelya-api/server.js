require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
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

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const categoryRoutes = require('./routes/categories');
const orderRoutes = require('./routes/orders');
const customerRoutes = require('./routes/customers');
const uploadRoutes = require('./routes/upload');
const sliderRoutes = require('./routes/slider');
const campaignRoutes = require('./routes/campaigns');
const collectionRoutes = require('./routes/collections');
const paymentRoutes = require('./routes/payment');
const auditRoutes = require('./routes/audit');
const organizationRoutes = require('./routes/organizations');

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '';
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
let startupReadinessError = null;

try {
  ensureProductionReady();
} catch (err) {
  startupReadinessError = err;
  console.error(`Panelya API readiness failed: ${err.message}`);
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
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    ready: !startupReadinessError,
    service: 'panelya-api',
    env: process.env.NODE_ENV || 'development',
  });
});

app.use(requestId);
app.use(enforceHttps);
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
  max: Number(process.env.API_RATE_LIMIT || 600),
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(attachAuthIfPresent);
app.use('/uploads', express.static(uploadDir, {
  dotfiles: 'deny',
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
  },
}));

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/slider', sliderRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/organizations', organizationRoutes);

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
}

listen(port);
if (port !== 3000) {
  listen(3000);
}
