'use strict';

// The patient's own account. Access is by OWNERSHIP of the profile, not by a
// clinic-wide permission: every handler re-checks that the profile's linked
// account is the caller.
const express = require('express');
const caregiverController = require('../controllers/caregiverController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext, requirePermission(PERMISSIONS.PATIENT_SELF));

const inviteLimit = mongoRateLimit({
  keyPrefix: 'patient-self-invite',
  limit: 20,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get('/me/profile', caregiverController.ownProfile);

router.get(
  '/me/:patientId/caregivers',
  validate({ params: schemas.patientIdParam }),
  caregiverController.ownCaregivers
);

router.post(
  '/me/:patientId/caregivers',
  inviteLimit,
  validate({ params: schemas.patientIdParam, body: schemas.inviteCaregiverSchema }),
  caregiverController.ownInviteCaregiver
);

router.delete(
  '/me/:patientId/caregivers/:grantId',
  validate({ params: schemas.caregiverGrantParams }),
  caregiverController.ownRevokeCaregiver
);

module.exports = router;
