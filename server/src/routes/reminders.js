'use strict';

// In-app reminders for one episode (Part 8, VEL-014).
//
// The staff surface. Queueing derives reminders from due work and de-duplicates
// them; the bounded batch rechecks every reminder immediately before delivery and
// records the outcome either way. An administrator cannot reach any of it.
const express = require('express');
const reminderController = require('../controllers/reminderController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const readLimit = mongoRateLimit({
  keyPrefix: 'reminder-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
// Delivery is a bounded batch, so the budget is per caller rather than unbounded
// (control #8).
const runLimit = mongoRateLimit({
  keyPrefix: 'reminder-run',
  limit: 30,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/:episodeId/reminders',
  readLimit,
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  reminderController.list
);

router.get(
  '/:episodeId/reminders/:notificationId',
  readLimit,
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.reminderParams }),
  reminderController.get
);

router.post(
  '/:episodeId/reminders/queue',
  runLimit,
  requirePermission(PERMISSIONS.REMINDER_RUN),
  validate({ params: schemas.episodeIdParam, body: schemas.queueRemindersSchema }),
  reminderController.queue
);

router.post(
  '/:episodeId/reminders/deliver',
  runLimit,
  requirePermission(PERMISSIONS.REMINDER_RUN),
  validate({ params: schemas.episodeIdParam, body: schemas.deliverRemindersSchema }),
  reminderController.deliver
);

router.post(
  '/:episodeId/reminders/:notificationId/retry',
  runLimit,
  requirePermission(PERMISSIONS.REMINDER_RUN),
  validate({ params: schemas.reminderParams }),
  reminderController.retry
);

module.exports = router;
