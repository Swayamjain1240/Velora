'use strict';

// Retention configuration, dry run, apply and holds (Part 9). Reading/updating
// the configuration is administrative; APPLYING a run is a separate permission
// and requires an explicit operator and reason. A dry run changes nothing.
const express = require('express');
const retentionController = require('../controllers/retentionController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const readLimit = mongoRateLimit({
  keyPrefix: 'retention-read',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const writeLimit = mongoRateLimit({
  keyPrefix: 'retention-write',
  limit: 30,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/categories',
  readLimit,
  requirePermission(PERMISSIONS.RETENTION_MANAGE),
  retentionController.categories
);

router.patch(
  '/categories/:category',
  writeLimit,
  requirePermission(PERMISSIONS.RETENTION_MANAGE),
  validate({ params: schemas.retentionCategoryParam, body: schemas.updateRetentionPolicySchema }),
  retentionController.updateCategory
);

router.post(
  '/dry-run',
  readLimit,
  requirePermission(PERMISSIONS.RETENTION_MANAGE),
  retentionController.dryRun
);

router.post(
  '/apply',
  writeLimit,
  requirePermission(PERMISSIONS.RETENTION_APPLY),
  validate({ body: schemas.applyRetentionSchema }),
  retentionController.apply
);

router.get('/runs', readLimit, requirePermission(PERMISSIONS.RETENTION_MANAGE), validate({ query: schemas.retentionQuery }), retentionController.runs);

router.get('/holds', readLimit, requirePermission(PERMISSIONS.RETENTION_MANAGE), validate({ query: schemas.retentionQuery }), retentionController.holds);

router.post(
  '/holds',
  writeLimit,
  requirePermission(PERMISSIONS.RETENTION_MANAGE),
  validate({ body: schemas.createRetentionHoldSchema }),
  retentionController.createHold
);

router.post(
  '/holds/:holdId/release',
  writeLimit,
  requirePermission(PERMISSIONS.RETENTION_MANAGE),
  validate({ params: schemas.retentionHoldParam, body: schemas.releaseRetentionHoldSchema }),
  retentionController.releaseHold
);

module.exports = router;
