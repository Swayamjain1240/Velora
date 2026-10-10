'use strict';

// Clinic-scoped role and permission catalog (Security-5, default deny).
// Clinical permissions never belong to the admin role: admin status alone
// grants no clinical-record browsing or approval (VEL-002 boundary).
//
// Permissions beyond Part 1 are declared here so later parts extend the
// catalog instead of inventing ad-hoc checks.

const PERMISSIONS = Object.freeze({
  CLINIC_UPDATE: 'clinic.update',
  STAFF_INVITE: 'staff.invite',
  STAFF_MANAGE: 'staff.manage',
  AUDIT_READ: 'audit.read',
  // Declared for later parts (not yet enforced by any route):
  PATIENT_MANAGE: 'patient.manage',
  EPISODE_MANAGE: 'episode.manage',
  PLAN_DRAFT: 'plan.draft',
  CLINICAL_REVIEW: 'clinical.review',
});

const ROLES = Object.freeze({
  ADMIN: 'admin',
  CARE_COORDINATOR: 'care_coordinator',
  CLINICAL_REVIEWER: 'clinical_reviewer',
});

// System role definitions seeded into every clinic. Note that `admin` holds
// only administrative permissions; `clinical.review` is reachable solely for
// clinical reviewers whose separate eligibility flag has been verified.
const SYSTEM_ROLES = Object.freeze([
  {
    key: ROLES.ADMIN,
    name: 'Clinic Admin',
    permissions: [
      PERMISSIONS.CLINIC_UPDATE,
      PERMISSIONS.STAFF_INVITE,
      PERMISSIONS.STAFF_MANAGE,
      PERMISSIONS.AUDIT_READ,
    ],
  },
  {
    key: ROLES.CARE_COORDINATOR,
    name: 'Care Coordinator',
    permissions: [
      PERMISSIONS.PATIENT_MANAGE,
      PERMISSIONS.EPISODE_MANAGE,
      PERMISSIONS.PLAN_DRAFT,
    ],
  },
  {
    key: ROLES.CLINICAL_REVIEWER,
    name: 'Clinical Reviewer',
    permissions: [PERMISSIONS.CLINICAL_REVIEW],
  },
]);

const INVITATION_TTL_DAYS = 7;
const PASSWORD_RESET_TTL_MINUTES = 30;
const SESSION_COOKIE = 'velora_session';
const CSRF_COOKIE = 'velora_csrf';
const CSRF_HEADER = 'x-csrf-token';
const MFA_RECOVERY_CODE_COUNT = 10;
const SAFE_AUTH_ERROR =
  'Invalid email or password. Check your credentials and try again.';

module.exports = {
  PERMISSIONS,
  ROLES,
  SYSTEM_ROLES,
  INVITATION_TTL_DAYS,
  PASSWORD_RESET_TTL_MINUTES,
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  MFA_RECOVERY_CODE_COUNT,
  SAFE_AUTH_ERROR,
};
