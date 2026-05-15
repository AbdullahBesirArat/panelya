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
    paths: [
      'password',
      'passwordHash',
      'refreshToken',
      'token',
      'authorization',
      'headers.authorization',
      'req.headers.authorization',
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
