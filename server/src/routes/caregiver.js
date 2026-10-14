'use strict';

// The caregiver's own scoped view. A caregiver holds NO clinic-wide permission,
// so these routes rely entirely on an active, unexpired, correctly-scoped grant.
const express = require('express');
const caregiverController = require('../controllers/caregiverController');
const checkInController = require('../controllers/checkInController');
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

module.exports = router;
