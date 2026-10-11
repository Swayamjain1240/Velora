'use strict';

// Clinic-scoped patient administration. Every route additionally requires an
// ACTIVE intake assignment on the specific patient (enforced in the service),
// so holding a clinic role is never sufficient on its own.
const express = require('express');
const patientController = require('../controllers/patientController');
const caregiverController = require('../controllers/caregiverController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const createLimit = mongoRateLimit({
  keyPrefix: 'patient-create',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const searchLimit = mongoRateLimit({
  keyPrefix: 'patient-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const mutateLimit = mongoRateLimit({
  keyPrefix: 'patient-mutate',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const inviteLimit = mongoRateLimit({
  keyPrefix: 'caregiver-invite',
  limit: 30,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.post(
  '/',
  requirePermission(PERMISSIONS.PATIENT_CREATE),
  createLimit,
  validate({ body: schemas.createPatientSchema }),
  patientController.createPatient
);

router.get(
  '/',
  requirePermission(PERMISSIONS.PATIENT_READ),
  searchLimit,
  validate({ query: schemas.paginationQuery }),
  patientController.listPatients
);

// Declared before '/:patientId' so it is not captured as an identifier.
router.get(
  '/assignees',
  requirePermission(PERMISSIONS.PATIENT_READ),
  patientController.listEligibleAssignees
);

router.get(
  '/:patientId',
  requirePermission(PERMISSIONS.PATIENT_READ),
  searchLimit,
  validate({ params: schemas.patientIdParam }),
  patientController.getPatient
);

router.patch(
  '/:patientId',
  requirePermission(PERMISSIONS.PATIENT_MANAGE),
  mutateLimit,
  validate({ params: schemas.patientIdParam, body: schemas.updatePatientSchema }),
  patientController.updatePatient
);

router.post(
  '/:patientId/activate',
  requirePermission(PERMISSIONS.PATIENT_MANAGE),
  mutateLimit,
  validate({ params: schemas.patientIdParam }),
  patientController.activatePatient
);

router.get(
  '/:patientId/assignments',
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.patientIdParam }),
  patientController.listAssignments
);

router.post(
  '/:patientId/assignments',
  requirePermission(PERMISSIONS.PATIENT_MANAGE),
  mutateLimit,
  validate({ params: schemas.patientIdParam, body: schemas.createAssignmentSchema }),
  patientController.createAssignment
);

router.delete(
  '/:patientId/assignments/:assignmentId',
  requirePermission(PERMISSIONS.PATIENT_MANAGE),
  mutateLimit,
  validate({ params: schemas.assignmentParams }),
  patientController.revokeAssignment
);

router.get(
  '/:patientId/consent',
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.patientIdParam, query: schemas.paginationQuery }),
  patientController.listConsent
);

router.post(
  '/:patientId/consent',
  requirePermission(PERMISSIONS.CONSENT_MANAGE),
  mutateLimit,
  validate({ params: schemas.patientIdParam, body: schemas.consentSchema }),
  patientController.appendConsent
);

router.get(
  '/:patientId/caregivers',
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.patientIdParam }),
  caregiverController.listCaregivers
);

router.post(
  '/:patientId/caregivers',
  requirePermission(PERMISSIONS.CAREGIVER_MANAGE),
  inviteLimit,
  validate({ params: schemas.patientIdParam, body: schemas.inviteCaregiverSchema }),
  caregiverController.inviteCaregiver
);

router.delete(
  '/:patientId/caregivers/:grantId',
  requirePermission(PERMISSIONS.CAREGIVER_MANAGE),
  mutateLimit,
  validate({ params: schemas.caregiverGrantParams }),
  caregiverController.revokeCaregiverGrant
);

router.post(
  '/:patientId/activation-invitation',
  requirePermission(PERMISSIONS.PATIENT_MANAGE),
  inviteLimit,
  validate({ params: schemas.patientIdParam, body: schemas.patientActivationSchema }),
  caregiverController.invitePatientActivation
);

module.exports = router;
