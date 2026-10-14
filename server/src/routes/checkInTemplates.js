'use strict';

// Clinic-defined check-in templates (Part 8). Clinic configuration, so only
// staff with a drafting or reviewing role reach it - an administrator holds
// neither and is refused, exactly like the plan workspace.
const express = require('express');
const checkInTemplateController = require('../controllers/checkInTemplateController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { errors } = require('../services/errors');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const readLimit = mongoRateLimit({
  keyPrefix: 'checkin-template-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const writeLimit = mongoRateLimit({
  keyPrefix: 'checkin-template-write',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

// Reading the catalog is part of preparing or reviewing check-ins, so both
// clinical and operational staff may read it; writing is split below.
const canRead = (req, res, next) => {
  const allowed = [
    PERMISSIONS.CHECKIN_TEMPLATE_DRAFT,
    PERMISSIONS.CHECKIN_TEMPLATE_ACTIVATE,
    PERMISSIONS.CHECKIN_REVIEW,
  ];
  if (allowed.some((p) => req.permissions && req.permissions.has(p))) return next();
  return next(errors.forbidden());
};

router.get(
  '/',
  readLimit,
  canRead,
  validate({ query: schemas.checkInTemplateQuery }),
  checkInTemplateController.list
);

router.get(
  '/:templateId',
  readLimit,
  canRead,
  validate({ params: schemas.checkInTemplateParam }),
  checkInTemplateController.get
);

router.post(
  '/',
  writeLimit,
  requirePermission(PERMISSIONS.CHECKIN_TEMPLATE_DRAFT),
  validate({ body: schemas.createCheckInTemplateSchema }),
  checkInTemplateController.create
);

router.patch(
  '/:templateId',
  writeLimit,
  requirePermission(PERMISSIONS.CHECKIN_TEMPLATE_DRAFT),
  validate({ params: schemas.checkInTemplateParam, body: schemas.updateCheckInTemplateSchema }),
  checkInTemplateController.update
);

router.post(
  '/:templateId/activate',
  writeLimit,
  requirePermission(PERMISSIONS.CHECKIN_TEMPLATE_ACTIVATE),
  validate({ params: schemas.checkInTemplateParam, body: schemas.activateCheckInTemplateSchema }),
  checkInTemplateController.activate
);

module.exports = router;
