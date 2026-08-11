const pino = require('pino');

let sentry = null;

function logLevel() {
  return process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
}

function sentryDsn() {
  return String(process.env.SENTRY_DSN || '').trim();
}

function initSentry() {
  if (sentry || !sentryDsn()) return sentry;

  try {
    sentry = require('@sentry/node');
    sentry.init({
      dsn: sentryDsn(),
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    });
  } catch (error) {
    sentry = null;
    logger.warn({ err: error }, 'Sentry baslatilamadi');
  }

  return sentry;
}

const logger = pino({
  level: logLevel(),
  base: {
    service: 'panelya-api',
    env: process.env.NODE_ENV || 'development',
  },
  redact: {
    // A25: phone/address are PII and must never reach logs. Our code does not log them,
    // but these paths defend against accidental object logging (top level + one level
    // deep, e.g. a serialized address/customer payload).
    paths: [
      'password',
      'passwordHash',
      'refreshToken',
      'token',
      'authorization',
      'headers.authorization',
      'req.headers.authorization',
      'phone',
      'recipient',
      'address',
      'address_line1',
      'address_line2',
      'neighborhood',
      'postal_code',
      'tckn',
      '*.phone',
      '*.recipient',
      '*.address',
      '*.address_line1',
      '*.address_line2',
      '*.neighborhood',
      '*.postal_code',
      '*.tckn',
      // A29 integration secrets. None of these are logged by our code, but an accidental
      // object log — a request body, a service result, an error with a `meta` — must not be
      // the way an API key or a webhook signing secret reaches disk. The signature and the
      // idempotency key are here too: the first is a credential-equivalent proof, the
      // second is caller-chosen and may carry meaning we have no business retaining.
      'secret',
      'apiKey',
      'api_key',
      'signingSecret',
      'signing_secret',
      'ciphertext',
      'signature',
      'idempotencyKey',
      'headers["x-panelya-signature"]',
      'req.headers["x-panelya-signature"]',
      'req.headers["idempotency-key"]',
      '*.secret',
      '*.apiKey',
      '*.api_key',
      '*.signingSecret',
      '*.signing_secret',
      '*.ciphertext',
      '*.signature',
      '*.idempotencyKey',
    ],
    censor: '[Redacted]',
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

function requestLogger(req) {
  if (req?.log) return req.log;
  if (!req) return logger;

  req.log = logger.child({
    requestId: req.id,
    method: req.method,
    path: req.originalUrl || req.path,
  });
  return req.log;
}

function attachRequestLogger(req, res, next) {
  const startedAt = Date.now();
  const reqLogger = requestLogger(req);

  reqLogger.info({
    ip: req.ip,
    actorType: req.auth?.actorType || null,
  }, 'request started');

  res.on('finish', () => {
    reqLogger.info({
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    }, 'request completed');
  });

  next();
}

function captureException(error, context = {}) {
  initSentry();
  if (sentry) {
    sentry.withScope((scope) => {
      Object.entries(context).forEach(([key, value]) => scope.setExtra(key, value));
      sentry.captureException(error);
    });
  }
}

module.exports = {
  attachRequestLogger,
  captureException,
  initSentry,
  logger,
  requestLogger,
};
