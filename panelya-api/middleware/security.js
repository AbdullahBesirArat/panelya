const crypto = require('crypto');
const db = require('../db');

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

const SECRET_TYPES = {
  admin: { envName: 'JWT_SECRET_ADMIN', fallbackEnvName: 'JWT_SECRET' },
  app: { envName: 'JWT_SECRET_APP', fallbackEnvName: 'JWT_SECRET' },
};

const ephemeralJwtSecrets = {
  admin: null,
  app: null,
};

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureJwtSecret(type = 'app') {
  const secretType = SECRET_TYPES[type] || SECRET_TYPES.app;
  const configuredSecret = process.env[secretType.envName] || '';
  const fallbackSecret = process.env[secretType.fallbackEnvName] || '';
  const secret = configuredSecret || fallbackSecret || ephemeralJwtSecrets[type] || '';
  const weakMarker = hasWeakMarker(secret);

  if (!secret) {
    if (isProduction()) {
      throw new Error(`${secretType.envName} zorunlu`);
    }

    ephemeralJwtSecrets[type] = randomToken(64);
    console.warn(`${secretType.envName} tanimli degil; development/staging icin gecici secret uretildi. Restart sonrasi oturumlar gecersiz olur.`);
    return ephemeralJwtSecrets[type];
  }

  if (isProduction() && (secret.length < 64 || weakMarker)) {
    throw new Error(`Production icin en az 64 karakterlik guvenli ${secretType.envName} zorunlu`);
  }

  if (!isProduction() && (secret.length < 32 || weakMarker)) {
    console.warn(`${secretType.envName} development icin zayif gorunuyor; production oncesi 64+ karakter random secret kullanin.`);
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
  const appJwtSecret = ensureJwtSecret('app');
  const adminJwtSecret = ensureJwtSecret('admin');

  if (!isProduction()) return;

  if (appJwtSecret === adminJwtSecret) {
    throw new Error('JWT_SECRET_APP ve JWT_SECRET_ADMIN farkli olmali');
  }

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
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (!isProduction() && /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(String(origin || ''))) {
        return callback(null, true);
      }
      return callback(new Error('CORS origin reddedildi'), false);
    },
  };
}

function isCorsOriginAllowed(origin) {
  if (!origin) return true;
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

function maybeCleanupRateLimits() {
  if (Math.random() > 0.01) return;

  db.query(
    `delete from api_rate_limits
     where reset_at < now() - interval '1 hour'`
  ).catch((error) => {
    console.error('Rate limit cleanup hatasi:', error.message);
  });
}

function rateLimit({ windowMs, max, message }) {
  return async (req, res, next) => {
    try {
      const key = `${req.ip}:${req.baseUrl || ''}:${req.path}`;
      const resetAt = new Date(Date.now() + windowMs);
      const result = await db.query(
        `insert into api_rate_limits (key, hit_count, reset_at)
         values ($1, 1, $2)
         on conflict (key)
         do update set
           hit_count = case
             when api_rate_limits.reset_at <= now() then 1
             else api_rate_limits.hit_count + 1
           end,
           reset_at = case
             when api_rate_limits.reset_at <= now() then excluded.reset_at
             else api_rate_limits.reset_at
           end,
           updated_at = now()
         returning hit_count, extract(epoch from reset_at)::bigint as reset_at_epoch`,
        [key, resetAt.toISOString()]
      );

      const current = result.rows[0];
      const count = Number(current.hit_count || 0);
      const resetAtEpoch = Number(current.reset_at_epoch || 0);

      res.set('RateLimit-Limit', String(max));
      res.set('RateLimit-Remaining', String(Math.max(0, max - count)));
      res.set('RateLimit-Reset', String(resetAtEpoch));

      maybeCleanupRateLimits();

      if (count > max) {
        return res.status(429).json({ error: message || 'Cok fazla istek. Lutfen biraz sonra tekrar deneyin.' });
      }

      return next();
    } catch (error) {
      console.error('Rate limit middleware pas gecildi:', error.message);
      // Fail-open: transient DB issues should not take down API availability.
      return next();
    }
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
