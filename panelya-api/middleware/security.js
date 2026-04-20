const crypto = require('crypto');

const WEAK_SECRET_MARKERS = [
  'change_to',
  'change_strong',
  'change_before_production',
  'change_this',
  'change_me',
  'generate_',
  'placeholder',
  'local_dev',
  'secret',
  'password',
];

let ephemeralJwtSecret = null;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureJwtSecret() {
  const configuredSecret = process.env.JWT_SECRET || '';
  const secret = configuredSecret || ephemeralJwtSecret || '';
  const weakMarker = hasWeakMarker(secret);

  if (!secret) {
    if (isProduction()) {
      throw new Error('JWT_SECRET zorunlu');
    }

    ephemeralJwtSecret = randomToken(64);
    console.warn('JWT_SECRET tanimli degil; development/staging icin gecici secret uretildi. Restart sonrasi oturumlar gecersiz olur.');
    return ephemeralJwtSecret;
  }

  if (isProduction() && (secret.length < 64 || weakMarker)) {
    throw new Error('Production icin en az 64 karakterlik guvenli JWT_SECRET zorunlu');
  }

  if (!isProduction() && (secret.length < 32 || weakMarker)) {
    console.warn('JWT_SECRET development icin zayif gorunuyor; production oncesi 64+ karakter random secret kullanin.');
  }

  return secret;
}

function hasWeakMarker(value) {
  const normalized = String(value || '').toLowerCase();
  return WEAK_SECRET_MARKERS.some((marker) => normalized.includes(marker));
}

function envValue(name) {
  return String(process.env[name] || '').trim();
}

function requireConfiguredEnv(name, { minLength = 1 } = {}) {
  const value = envValue(name);

  if (!value || value.length < minLength || hasWeakMarker(value)) {
    throw new Error(`Production icin ${name} gercek ve guvenli bir deger olmali`);
  }

  return value;
}

function ensureProductionReady() {
  ensureJwtSecret();

  if (!isProduction()) return;

  requireConfiguredEnv('DATABASE_URL', { minLength: 20 });
  requireConfiguredEnv('CORS_ORIGIN', { minLength: 8 });
  requireConfiguredEnv('PUBLIC_SITE_URL', { minLength: 8 });
  requireConfiguredEnv('PUBLIC_API_URL', { minLength: 8 });

  const paymentProvider = envValue('PAYMENT_PROVIDER').toLowerCase();
  if (!paymentProvider) {
    throw new Error('Production icin PAYMENT_PROVIDER zorunlu');
  }

  if (paymentProvider === 'mock') {
    throw new Error('Production ortaminda PAYMENT_PROVIDER=mock kullanilamaz');
  }

  if (paymentProvider === 'iyzico') {
    requireConfiguredEnv('IYZICO_API_KEY', { minLength: 8 });
    requireConfiguredEnv('IYZICO_SECRET_KEY', { minLength: 8 });

    const iyzicoBaseUrl = envValue('IYZICO_BASE_URL') || 'https://sandbox-api.iyzipay.com';
    if (iyzicoBaseUrl.includes('sandbox')) {
      throw new Error('Production icin IYZICO_BASE_URL sandbox olamaz');
    }
  }

  const callbackSecretRequired = envValue('PAYMENT_CALLBACK_SECRET_REQUIRED') === 'true';
  const callbackSecret = callbackSecretRequired
    ? requireConfiguredEnv('PAYMENT_CALLBACK_SECRET', { minLength: 32 })
    : envValue('PAYMENT_CALLBACK_SECRET');

  if (callbackSecret && (callbackSecret.length < 32 || hasWeakMarker(callbackSecret))) {
    throw new Error('PAYMENT_CALLBACK_SECRET en az 32 karakterlik random deger olmali');
  }
}

function corsOptions() {
  const allowedOrigins = parseCsv(process.env.CORS_ORIGIN);

  if (isProduction() && !allowedOrigins.length) {
    throw new Error('Production icin CORS_ORIGIN allow-list zorunlu');
  }

  return {
    credentials: true,
    origin(origin, callback) {
      if (!origin && !isProduction()) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (!isProduction() && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(String(origin || ''))) {
        return callback(null, true);
      }
      return callback(new Error('CORS origin reddedildi'), false);
    },
  };
}

function isCorsOriginAllowed(origin) {
  if (!origin && !isProduction()) return true;
  if (parseCsv(process.env.CORS_ORIGIN).includes(origin)) return true;
  return !isProduction() && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(String(origin || ''));
}

function handleCorsPreflight(req, res, next) {
  const origin = req.get('origin');
  if (req.method !== 'OPTIONS' || !isCorsOriginAllowed(origin)) return next();

  res.set('Access-Control-Allow-Origin', origin || '*');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'Content-Type,Authorization');
  res.set('Vary', 'Origin');
  return res.sendStatus(204);
}

function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.baseUrl || ''}:${req.path}`;
    const current = hits.get(key) || { count: 0, resetAt: now + windowMs };

    if (current.resetAt <= now) {
      current.count = 0;
      current.resetAt = now + windowMs;
    }

    current.count += 1;
    hits.set(key, current);

    if (hits.size > 10000) {
      for (const [hitKey, value] of hits) {
        if (value.resetAt <= now) hits.delete(hitKey);
      }
    }

    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - current.count)));
    res.set('RateLimit-Reset', String(Math.ceil(current.resetAt / 1000)));

    if (current.count > max) {
      return res.status(429).json({ error: message || 'Cok fazla istek. Lutfen biraz sonra tekrar deneyin.' });
    }

    return next();
  };
}

function requestId(req, res, next) {
  req.id = req.get('x-request-id') || randomToken(12);
  res.set('X-Request-Id', req.id);
  next();
}

function enforceHttps(req, res, next) {
  if (!isProduction()) return next();
  if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
  return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
}

function safeErrorMessage(err) {
  const status = err.status || 500;
  if (status >= 500) return 'Bir hata olustu, lutfen daha sonra tekrar deneyin';

  const message = String(err.message || '').toLowerCase();
  if (message.includes('duplicate key')) return 'Bu deger zaten kullaniliyor';
  if (message.includes('foreign key')) return 'Iliskili kayit bulunamadi';
  if (message.includes('invalid input syntax')) return 'Gecersiz veri formati';
  if (message.includes('cors')) return 'Origin reddedildi';

  return err.message || 'Gecersiz istek';
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = {
  corsOptions,
  enforceHttps,
  handleCorsPreflight,
  ensureProductionReady,
  ensureJwtSecret,
  isProduction,
  requestId,
  rateLimit,
  randomToken,
  safeErrorMessage,
};
