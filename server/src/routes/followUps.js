'use strict';

// Basic prescribed follow-ups for one episode (Part 8).
//
// A follow-up is a date, a location, a contact and an optional in-app reminder -
// nothing else. Prescribing one needs an ACTIVE care-team assignment; the
// administrator is refused like everywhere else in this part.
const express = require('express');
const followUpController = require('../controllers/followUpController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const readLimit = mongoRateLimit({
  keyPrefix: 'followup-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const writeLimit = mongoRateLimit({
  keyPrefix: 'followup-write',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/:episodeId/follow-ups',
  readLimit,
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  followUpController.list
);

router.post(
  '/:episodeId/follow-ups',
  writeLimit,
  requirePermission(PERMISSIONS.EPISODE_MANAGE),
  validate({ params: schemas.episodeIdParam, body: schemas.createFollowUpSchema }),
  followUpController.create
);

router.patch(
  '/:episodeId/follow-ups/:followUpId',
  writeLimit,
  requirePermission(PERMISSIONS.EPISODE_MANAGE),
  validate({ params: schemas.followUpParams, body: schemas.updateFollowUpSchema }),
  followUpController.update
);

router.post(
  '/:episodeId/follow-ups/:followUpId/cancel',
  writeLimit,
  requirePermission(PERMISSIONS.EPISODE_MANAGE),
  validate({ params: schemas.followUpParams, body: schemas.cancelFollowUpSchema }),
  followUpController.cancel
);

module.exports = router;
