'use strict';

const express = require('express');
const staffController = require('../controllers/staffController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const {
  requireAuth,
  loadClinicContext,
  requirePermission,
} = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');
const { errors } = require('../services/errors');

const router = express.Router();

// Every route below runs only for an MFA-verified session with an active
// clinic membership; permissions are clinic-scoped and default-deny.
router.use(requireAuth, loadClinicContext);

const inviteLimit = mongoRateLimit({
  keyPrefix: 'staff-invite',
  limit: 30,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const mutationLimit = mongoRateLimit({
  keyPrefix: 'staff-mutate',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/members',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  validate({ query: schemas.paginationQuery }),
  staffController.listMembers
);

router.patch(
  '/members/:membershipId',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  mutationLimit,
  validate({ params: schemas.memberIdParam, body: schemas.updateMemberSchema }),
  staffController.updateMember
);

// Either a clinic admin or a clinical reviewer may reach this route; the
// service makes the authoritative decision (only an already verified
// eligible reviewer, never self, never admin-alone).
function allowAdminOrReviewer(req, res, next) {
  const canAdmin = req.permissions && req.permissions.has(PERMISSIONS.CLINIC_UPDATE);
  const canReview = req.permissions && req.permissions.has(PERMISSIONS.CLINICAL_REVIEW);
  return canAdmin || canReview ? next() : next(errors.forbidden());
}

router.post(
  '/members/:membershipId/reviewer-eligibility',
  allowAdminOrReviewer,
  mutationLimit,
  validate({ params: schemas.memberIdParam, body: schemas.reviewerEligibilitySchema }),
  staffController.setReviewerEligibility
);

router.post(
  '/invitations',
  requirePermission(PERMISSIONS.STAFF_INVITE),
  inviteLimit,
  validate({ body: schemas.inviteStaffSchema }),
  staffController.createInvitation
);

router.get(
  '/invitations',
  requirePermission(PERMISSIONS.STAFF_INVITE),
  validate({ query: schemas.paginationQuery }),
  staffController.listInvitations
);

router.delete(
  '/invitations/:invitationId',
  requirePermission(PERMISSIONS.STAFF_INVITE),
  mutationLimit,
  validate({ params: schemas.invitationIdParam }),
  staffController.revokeInvitation
);

module.exports = router;
