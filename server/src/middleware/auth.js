'use strict';

// Session authentication middleware. The server is the authoritative
// authorization boundary (control #3, #5); React route guards are only UX.
const { errors } = require('../services/errors');
const sessionService = require('../services/sessionService');
const User = require('../models/User');
const ClinicMembership = require('../models/ClinicMembership');
const MembershipRole = require('../models/MembershipRole');
const { SESSION_COOKIE, PERMISSIONS, ROLES } = require('../config/constants');

// Loads the session + user when a valid cookie is present. Never throws:
// attaches req.session/req.user/req.memberships or leaves them null.
async function loadSession(req, res, next) {
  try {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    if (!token) return next();
    const session = await sessionService.findSessionByToken(token);
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return next();
    }
    const user = await User.findById(session.user);
    if (!user || user.status !== 'active') return next();

    req.session = session;
    req.user = user;
    req.memberships = await ClinicMembership.find({
      user: user.id,
      status: 'active',
    }).lean();
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user || !req.session) return next(errors.unauthorized());
  if (req.session.state !== 'active') {
    return next(errors.unauthorized('Complete multi-factor verification first.'));
  }
  return next();
}

// For MFA endpoints that must run on a password-accepted but not-yet-active
// session. The session must be mfa_pending and not revoked/expired.
function requireMfaPendingSession(req, res, next) {
  if (!req.user || !req.session) return next(errors.unauthorized());
  if (req.session.state !== 'mfa_pending') {
    return next(errors.unauthorized('No pending multi-factor step.'));
  }
  return next();
}

// Resolves the caller's active clinic scope plus role permissions. The clinic
// always comes from the caller's own membership - never from a client-supplied
// id - so cross-tenant access is structurally impossible (control #5).
async function loadClinicContext(req, res, next) {
  try {
    if (!req.memberships || req.memberships.length === 0) {
      return next(errors.forbidden('No active clinic membership.'));
    }
    const membership = req.memberships[0];
    const clinicId = String(membership.clinic._id || membership.clinic);
    const role = await MembershipRole.findOne({
      clinic: clinicId,
      key: membership.roleKey,
    }).lean();
    req.membership = membership;
    req.clinicId = clinicId;
    req.roleKey = membership.roleKey;
    req.permissions = new Set(role ? role.permissions : []);
    return next();
  } catch (err) {
    return next(err);
  }
}

// Permission check against the caller's clinic-scoped role (default deny).
function requirePermission(...needed) {
  return (req, res, next) => {
    if (!req.permissions) return next(errors.forbidden());
    const ok = needed.every((p) => req.permissions.has(p));
    if (!ok) return next(errors.forbidden());
    return next();
  };
}

// Admin status alone must never grant clinical browsing. Clinical review
// additionally requires the separate, verified eligibility flag.
function requireVerifiedReviewer(req, res, next) {
  const isReviewerRole = req.roleKey === ROLES.CLINICAL_REVIEWER;
  const eligible =
    req.membership &&
    req.membership.reviewerEligibility &&
    req.membership.reviewerEligibility.status === 'verified';
  const canReview = req.permissions && req.permissions.has(PERMISSIONS.CLINICAL_REVIEW);
  if (!isReviewerRole || !eligible || !canReview) {
    return next(errors.forbidden('Verified clinical reviewer eligibility required.'));
  }
  return next();
}

module.exports = {
  loadSession,
  requireAuth,
  requireMfaPendingSession,
  loadClinicContext,
  requirePermission,
  requireVerifiedReviewer,
};
