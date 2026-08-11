'use strict';

const express = require('express');
const { rateLimit } = require('../middleware/security');
const { recordWebVital, validateWebVitalPayload } = require('../services/webVitals');

const router = express.Router();
const beaconLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  message: 'Metric limiti asildi',
});

router.post('/', beaconLimiter, express.json({ limit: '4kb', strict: true }), (req, res, next) => {
  try {
    const metric = validateWebVitalPayload(req.body);
    recordWebVital(metric);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(202).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
