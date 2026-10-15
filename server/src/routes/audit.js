'use strict';

// Scoped, paginated audit search (Part 9). Reading the trail is a distinct
// permission, the caller's clinic is derived from their own membership, and the
// service applies record/category scoping so a search cannot become a back door
// into administrative or foreign-clinic events.
const express = require('express');
const auditController = require('../controllers/auditController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

// Audit reads are heavier than a single record and are deliberately budgeted.
const readLimit = mongoRateLimit({
  keyPrefix: 'audit-read',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/',
  readLimit,
  requirePermission(PERMISSIONS.AUDIT_READ),
  validate({ query: schemas.auditSearchQuery }),
  auditController.search
);

module.exports = router;
