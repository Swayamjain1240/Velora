'use strict';

// Public invitation acceptance. These endpoints carry no ambient authority - the
// single-use token in the body is the credential - so they are exempt from CSRF
// but remain SameSite=Lax and strictly rate limited (controls #4, #8).
const express = require('express');
const caregiverController = require('../controllers/caregiverController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const schemas = require('../validators/schemas');

const router = express.Router();

const acceptLimit = mongoRateLimit({
  keyPrefix: 'access-accept',
  limit: 10,
  windowMs: 60 * 60 * 1000,
});

router.post(
  '/caregiver-invitation',
  acceptLimit,
  validate({ body: schemas.acceptAccessInvitationSchema }),
  caregiverController.acceptCaregiverInvitation
);

router.post(
  '/patient-activation',
  acceptLimit,
  validate({ body: schemas.acceptAccessInvitationSchema }),
  caregiverController.acceptPatientActivation
);

module.exports = router;
