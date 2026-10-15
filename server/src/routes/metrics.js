'use strict';

// Operational workflow metrics (Part 9). Every response carries the definitions
// and the explicit "not a clinical outcome" note; queue age is scoped to the
// caller's own assignments.
const express = require('express');
const metricsController = require('../controllers/metricsController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const readLimit = mongoRateLimit({
  keyPrefix: 'metrics-read',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/',
  readLimit,
  requirePermission(PERMISSIONS.METRICS_READ),
  validate({ query: schemas.metricsQuery }),
  metricsController.overview
);

module.exports = router;
