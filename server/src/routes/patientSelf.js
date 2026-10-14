'use strict';

// The patient's own account. Access is by OWNERSHIP of the profile, not by a
// clinic-wide permission: every handler re-checks that the profile's linked
// account is the caller.
const express = require('express');
const caregiverController = require('../controllers/caregiverController');
const episodeController = require('../controllers/episodeController');
const documentController = require('../controllers/documentController');
const carePlanController = require('../controllers/carePlanController');
const checkInController = require('../controllers/checkInController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { downloadLimit, readLimit } = require('../middleware/documentLimits');
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

// Part 3: the patient's own recovery episodes (ownership, not a clinic role).
router.get(
  '/me/episodes',
  validate({ query: schemas.paginationQuery }),
  episodeController.ownListEpisodes
);
router.get(
  '/me/episodes/:episodeId',
  validate({ params: schemas.episodeIdParam }),
  episodeController.ownGetEpisode
);

// Part 4: the patient's OWN episode documents. Read and download only - a
// patient can never upload, and every handler re-resolves ownership in the
// service (an unowned episode is a 404, never a 403 leak).
router.get(
  '/me/episodes/:episodeId/documents',
  readLimit,
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  documentController.listDocuments
);
router.get(
  '/me/episodes/:episodeId/documents/:documentId',
  readLimit,
  validate({ params: schemas.documentParams }),
  documentController.getDocument
);
router.get(
  '/me/episodes/:episodeId/documents/:documentId/download',
  downloadLimit,
  validate({ params: schemas.documentParams }),
  documentController.downloadDocument
);

// Part 5: the patient's CURRENT APPROVED care plan only. Drafts, the
// clarification history and the reviewer's working notes are never reachable
// through this route - and the staff version workspace is closed to this role.
router.get(
  '/me/episodes/:episodeId/plan',
  readLimit,
  validate({ params: schemas.episodeIdParam }),
  carePlanController.patientCurrentPlan
);

// Part 8: the patient's OWN check-in queue and the one-viewport answer form.
// Access is by ownership of the profile; there is no route that reads another
// patient's check-ins.
router.get(
  '/me/check-ins',
  validate({ query: schemas.patientCheckInQuery }),
  checkInController.ownList
);
router.post(
  '/me/check-ins/:responseId/submit',
  validate({ params: schemas.checkInResponseIdParam, body: schemas.submitCheckInSchema }),
  checkInController.ownSubmit
);

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
