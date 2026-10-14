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
const schemas = require('../validators/schemas');

const router = express.Router();

router.use(requireAuth);

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
  validate({ params: schemas.patientIdParam, query: schemas.patientCheckInQuery }),
  checkInController.caregiverList
);
router.post(
  '/me/check-ins/:responseId/submit',
  validate({ params: schemas.checkInResponseIdParam, body: schemas.submitCheckInSchema }),
  checkInController.caregiverSubmit
);

// Part 8: clarification threads the caregiver may raise or follow up while their
// ACTIVE grant carries `ask_questions`. The clinic is derived from the grant.
router.get(
  '/me/patients/:patientId/questions',
  validate({ params: schemas.patientIdParam, query: schemas.paginationQuery }),
  clarificationController.caregiverList
);
router.post(
  '/me/episodes/:episodeId/questions',
  validate({ params: schemas.episodeIdParam, body: schemas.openThreadSchema }),
  clarificationController.caregiverOpen
);
router.get(
  '/me/questions/:threadId',
  validate({ params: schemas.clarificationThreadIdParam }),
  clarificationController.caregiverGet
);
router.post(
  '/me/questions/:threadId/messages',
  validate({ params: schemas.clarificationThreadIdParam, body: schemas.threadReplySchema }),
  clarificationController.caregiverReply
);

// Part 8: the caregiver's scoped view of prescribed follow-ups, which needs the
// `view_tasks` scope on an active grant.
router.get(
  '/me/patients/:patientId/follow-ups',
  validate({ params: schemas.patientIdParam, query: schemas.paginationQuery }),
  followUpController.caregiverList
);

// Part 8: the caregiver's own reminder inbox. The filter is by RECIPIENT, so a
// caregiver only ever sees reminders the care team addressed to them.
router.get('/me/reminders', validate({ query: schemas.paginationQuery }), reminderController.mine);
router.post(
  '/me/reminders/:notificationId/acknowledge',
  validate({ params: schemas.notificationIdParam }),
  reminderController.acknowledge
);

module.exports = router;
