'use strict';

// The caregiver's own scoped view. A caregiver holds NO clinic-wide permission,
// so these routes rely entirely on an active, unexpired, correctly-scoped grant.
const express = require('express');
const caregiverController = require('../controllers/caregiverController');
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

module.exports = router;
