'use strict';

// The caregiver's own scoped view. A caregiver holds NO clinic-wide permission,
// so these routes rely entirely on an active, unexpired, correctly-scoped grant.
const express = require('express');
const caregiverController = require('../controllers/caregiverController');
const checkInController = require('../controllers/checkInController');
const clarificationController = require('../controllers/clarificationController');
const reminderController = require('../controllers/reminderController');
const followUpController = require('../controllers/followUpController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { mongoRateLimit } = require('../middleware/rateLimit');
const schemas = require('../validators/schemas');

const router = express.Router();

router.use(requireAuth);

// Part 8 durable buckets (control #8), identical to the staff and patient
// surfaces of the same operations: a grant decides what a caregiver may do,
// never how often. The bucket key is the caller, so it cannot be shared with
// anyone else's budget.
const checkinReadLimit = mongoRateLimit({
  keyPrefix: 'checkin-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const checkinWriteLimit = mongoRateLimit({
  keyPrefix: 'checkin-write',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const clarificationReadLimit = mongoRateLimit({
  keyPrefix: 'clarification-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const clarificationAskLimit = mongoRateLimit({
  keyPrefix: 'clarification-ask',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const reminderReadLimit = mongoRateLimit({
  keyPrefix: 'reminder-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const reminderAckLimit = mongoRateLimit({
  keyPrefix: 'reminder-ack',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const followupReadLimit = mongoRateLimit({
  keyPrefix: 'followup-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/me/patients',
  validate({ query: schemas.paginationQuery }),
  caregiverController.caregiverPatients
);

router.get(
  '/me/patients/:patientId',
  validate({ params: schemas.patientIdParam }),
  caregiverController.caregiverPatientDetail
);

// Part 8: the caregiver's scoped check-in queue. Reading needs view_checkins and
// answering needs log_checkins; the service re-derives both from the ACTIVE grant
// on every request, and the clinic comes from the grant rather than the client.
router.get(
  '/me/patients/:patientId/check-ins',
  checkinReadLimit,
  validate({ params: schemas.patientIdParam, query: schemas.patientCheckInQuery }),
  checkInController.caregiverList
);
router.post(
  '/me/check-ins/:responseId/submit',
  checkinWriteLimit,
  validate({ params: schemas.checkInResponseIdParam, body: schemas.submitCheckInSchema }),
  checkInController.caregiverSubmit
);

// Part 8: clarification threads the caregiver may raise or follow up while their
// ACTIVE grant carries `ask_questions`. The clinic is derived from the grant.
router.get(
  '/me/patients/:patientId/questions',
  clarificationReadLimit,
  validate({ params: schemas.patientIdParam, query: schemas.paginationQuery }),
  clarificationController.caregiverList
);
router.post(
  '/me/episodes/:episodeId/questions',
  clarificationAskLimit,
  validate({ params: schemas.episodeIdParam, body: schemas.openThreadSchema }),
  clarificationController.caregiverOpen
);
router.get(
  '/me/questions/:threadId',
  clarificationReadLimit,
  validate({ params: schemas.clarificationThreadIdParam }),
  clarificationController.caregiverGet
);
router.post(
  '/me/questions/:threadId/messages',
  clarificationAskLimit,
  validate({ params: schemas.clarificationThreadIdParam, body: schemas.threadReplySchema }),
  clarificationController.caregiverReply
);

// Part 8: the caregiver's scoped view of prescribed follow-ups, which needs the
// `view_tasks` scope on an active grant.
router.get(
  '/me/patients/:patientId/follow-ups',
  followupReadLimit,
  validate({ params: schemas.patientIdParam, query: schemas.paginationQuery }),
  followUpController.caregiverList
);

// Part 8: the caregiver's own reminder inbox. The filter is by RECIPIENT, so a
// caregiver only ever sees reminders the care team addressed to them.
router.get('/me/reminders', reminderReadLimit, validate({ query: schemas.paginationQuery }), reminderController.mine);
router.post(
  '/me/reminders/:notificationId/acknowledge',
  reminderAckLimit,
  validate({ params: schemas.notificationIdParam }),
  reminderController.acknowledge
);

module.exports = router;
