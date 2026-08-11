'use strict';

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), minimum), maximum);
}

const REQUEST_TIMEOUT_MS = boundedInteger(process.env.API_REQUEST_TIMEOUT_MS, 30000, 1000, 120000);

function requestTimeout(req, res, next) {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({ error: 'Istek zaman asimina ugradi', code: 'REQUEST_TIMEOUT', requestId: req.id });
    } else {
      res.end();
    }
  });
  next();
}

module.exports = { REQUEST_TIMEOUT_MS, boundedInteger, requestTimeout };
