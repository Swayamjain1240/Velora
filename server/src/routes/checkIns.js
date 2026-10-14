'use strict';

// Check-in slots for one episode (Part 8, VEL-015).
//
// The staff surface. Every handler re-resolves authority in the service: an
// ASSIGNED care-team member may materialise slots and record what a patient told
// them, and only the episode's assigned, clinic-verified clinical reviewer may
// close a rule-triggered review. An administrator is refused outright - admin
// status holds no clinical permission.
//
// The patient's own queue and a caregiver's scoped queue live on their own
// namespaces (/api/patient and /api/caregiver), because neither role holds a
// clinic-wide permission.
const express = require('express');
const checkInController = require('../controllers/checkInController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const {
  requireAuth,
  loadClinicContext,
  requirePermission,
  requireVerifiedReviewer,
} = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { errors } = require('../services/errors');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

// Separate durable buckets (control #8): a staff member browsing the review queue
// can never consume the budget for answering a check-in or for a review.
const readLimit = mongoRateLimit({
  keyPrefix: 'checkin-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const writeLimit = mongoRateLimit({
  keyPrefix: 'checkin-write',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const reviewLimit = mongoRateLimit({
  keyPrefix: 'checkin-review',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

// Recording an answer on a patient's behalf is operational work, but a reviewer
// may also do it while reviewing, so either permission opens the route and the
// service still requires an active assignment on the episode.
function anyPermission(...needed) {
  return (req, res, next) => {
    const allowed =
      req.permissions && needed.some((permission) => req.permissions.has(permission));
    if (!allowed) return next(errors.forbidden());
    return next();
  };
}

router.get(
  '/:episodeId/check-ins',
  readLimit,
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.episodeIdParam, query: schemas.checkInListQuery }),
  checkInController.list
);

router.get(
  '/:episodeId/check-ins/:responseId',
  readLimit,
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.checkInResponseParams }),
  checkInController.get
);

// Materialisation is idempotent and bounded; it creates the DUE slots the clinic
// activated templates ask for. It never sends anything and never interprets an
// answer.
router.post(
  '/:episodeId/check-ins/materialise',
  writeLimit,
  requirePermission(PERMISSIONS.EPISODE_MANAGE),
  validate({ params: schemas.episodeIdParam }),
  checkInController.materialise
);

router.post(
  '/:episodeId/check-ins/:responseId/submit',
  writeLimit,
  anyPermission(PERMISSIONS.EPISODE_MANAGE, PERMISSIONS.CHECKIN_REVIEW),
  validate({ params: schemas.checkInResponseParams, body: schemas.submitCheckInSchema }),
  checkInController.submit
);

router.post(
  '/:episodeId/check-ins/:responseId/review',
  reviewLimit,
  requirePermission(PERMISSIONS.CHECKIN_REVIEW),
  requireVerifiedReviewer,
  validate({ params: schemas.checkInResponseParams, body: schemas.reviewCheckInSchema }),
  checkInController.review
);

module.exports = router;
