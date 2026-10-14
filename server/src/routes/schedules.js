'use strict';

// Medication schedules and recovery tasks for one episode (Part 7).
//
// Authority is resolved in the service on every request: preparation needs an
// ACTIVE coordinator assignment on a non-closed episode whose plan version is
// CURRENT and APPROVED, and a medication schedule can only be activated by the
// assigned, clinic-verified clinical reviewer.
const express = require('express');
const scheduleController = require('../controllers/scheduleController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

// Generation, activation and reads each get their own durable bucket, so a noisy
// reader can never consume a reviewer's activation budget (control #8).
const readLimit = mongoRateLimit({
  keyPrefix: 'schedule-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const prepareLimit = mongoRateLimit({
  keyPrefix: 'schedule-prepare',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const activateLimit = mongoRateLimit({
  keyPrefix: 'schedule-activate',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/:episodeId/schedules',
  readLimit,
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  scheduleController.list
);

router.post(
  '/:episodeId/schedules/prepare',
  prepareLimit,
  requirePermission(PERMISSIONS.SCHEDULE_PREPARE),
  validate({ params: schemas.episodeIdParam, body: schemas.prepareSchedulesSchema }),
  scheduleController.prepare
);

router.get(
  '/:episodeId/schedules/:scheduleId',
  readLimit,
  validate({ params: schemas.scheduleParams }),
  scheduleController.get
);

router.get(
  '/:episodeId/schedules/:scheduleId/occurrences',
  readLimit,
  validate({ params: schemas.scheduleParams, query: schemas.paginationQuery }),
  scheduleController.listOccurrences
);

router.post(
  '/:episodeId/schedules/:scheduleId/activate',
  activateLimit,
  requirePermission(PERMISSIONS.SCHEDULE_ACTIVATE),
  validate({ params: schemas.scheduleParams, body: schemas.activateScheduleSchema }),
  scheduleController.activate
);

router.post(
  '/:episodeId/schedules/:scheduleId/end',
  prepareLimit,
  requirePermission(PERMISSIONS.SCHEDULE_PREPARE),
  validate({ params: schemas.scheduleParams, body: schemas.endScheduleSchema }),
  scheduleController.end
);

// Read-only history of recorded entries for the team. There is deliberately no
// route that edits or deletes an entry: corrections append.
router.get(
  '/:episodeId/activity-logs',
  readLimit,
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  scheduleController.listActivity
);

module.exports = router;
