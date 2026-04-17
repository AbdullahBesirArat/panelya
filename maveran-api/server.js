require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const {
  corsOptions,
  enforceHttps,
  ensureProductionReady,
  requestId,
  rateLimit,
  safeErrorMessage,
} = require('./middleware/security');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const categoryRoutes = require('./routes/categories');
const orderRoutes = require('./routes/orders');
const customerRoutes = require('./routes/customers');
const uploadRoutes = require('./routes/upload');
const sliderRoutes = require('./routes/slider');
const campaignRoutes = require('./routes/campaigns');
const paymentRoutes = require('./routes/payment');
const auditRoutes = require('./routes/audit');
const organizationRoutes = require('./routes/organizations');

const app = express();
const port = process.env.PORT || 3000;
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

ensureProductionReady();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(requestId);
app.use(enforceHttps);
app.use(helmet({
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors(corsOptions()));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT || 600),
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(uploadDir, {
  dotfiles: 'deny',
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
  },
}));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'maveran-api',
    env: process.env.NODE_ENV || 'development',
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/slider', sliderRoutes);
app.use('/api/campaigns', campaignRoutes);
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

app.listen(port, () => {
  console.log(`Maveran API ${port} portunda calisiyor`);
});
