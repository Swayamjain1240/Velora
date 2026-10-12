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
  // Part 2 - patient onboarding, consent and caregiver access.
  PATIENT_CREATE: 'patient.create',
  PATIENT_READ: 'patient.read',
  PATIENT_MANAGE: 'patient.manage',
  CONSENT_MANAGE: 'consent.manage',
  CAREGIVER_MANAGE: 'caregiver.manage',
  // Patient role: access to their OWN profile and grants only (never staff data).
  PATIENT_SELF: 'patient.self',
  // Declared for later parts (not yet enforced by any route):
  EPISODE_MANAGE: 'episode.manage',
  // Part 5: drafting a manual plan, and the clinical review that can request
  // clarification or approve it. `plan.review` is held ONLY by the clinical
  // reviewer role: an administrator never receives it.
  PLAN_DRAFT: 'plan.draft',
  PLAN_REVIEW: 'plan.review',
  CLINICAL_REVIEW: 'clinical.review',
});

const ROLES = Object.freeze({
  ADMIN: 'admin',
  CARE_COORDINATOR: 'care_coordinator',
  CLINICAL_REVIEWER: 'clinical_reviewer',
  PATIENT: 'patient',
  CAREGIVER: 'caregiver',
});

// Granular caregiver scopes. Only `view_profile` is honoured in Part 2; the
// rest are declared so later parts extend the catalog rather than inventing
// ad-hoc checks. Granting a caregiver view_profile must NEVER silently confer
// episode, document, plan or task access (control #5).
const CAREGIVER_SCOPES = Object.freeze([
  'view_profile',
  'view_episodes',
  'view_documents',
  'view_plan',
  'view_tasks',
]);
const PART2_HONOURED_SCOPES = Object.freeze(['view_profile']);

// Consent categories recorded in the append-only consent history.
const CONSENT_CATEGORIES = Object.freeze([
  'care_coordination',
  'caregiver_access',
  'future_ai_assistance',
]);

// System role definitions seeded into every clinic. Note that `admin` holds
// only administrative permissions; `clinical.review` is reachable solely for
// clinical reviewers whose separate eligibility flag has been verified.
const SYSTEM_ROLES = Object.freeze([
  {
    key: ROLES.ADMIN,
    name: 'Clinic Admin',
    // Administrative ONLY. An admin holds no patient/clinical read permission:
    // admin status can never be used to browse patient or clinical metadata.
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
      PERMISSIONS.PATIENT_CREATE,
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_MANAGE,
      PERMISSIONS.CONSENT_MANAGE,
      PERMISSIONS.CAREGIVER_MANAGE,
      PERMISSIONS.EPISODE_MANAGE,
      PERMISSIONS.PLAN_DRAFT,
    ],
    // The coordinator can draft a manual plan but can never review, clarify or
    // approve one: that requires the separately verified reviewer role.
  },
  {
    key: ROLES.CLINICAL_REVIEWER,
    name: 'Clinical Reviewer',
    // Reads patient context for review; cannot create or administer patients.
    // Part 5 adds plan review, which is the only path to an approved plan.
    permissions: [PERMISSIONS.PATIENT_READ, PERMISSIONS.CLINICAL_REVIEW, PERMISSIONS.PLAN_REVIEW],
  },
  {
    key: ROLES.PATIENT,
    name: 'Patient',
    // Own profile and own caregiver grants only - enforced by ownership, not by
    // a clinic-wide permission.
    permissions: [PERMISSIONS.PATIENT_SELF],
  },
  {
    key: ROLES.CAREGIVER,
    name: 'Caregiver',
    // No clinic-wide permissions at all: every caregiver read is authorised by
    // an explicit, active, scoped grant on a specific patient.
    permissions: [],
  },
]);

const INVITATION_TTL_DAYS = 7;
const CAREGIVER_INVITATION_TTL_DAYS = 7;
const PATIENT_ACTIVATION_TTL_DAYS = 14;
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
  CAREGIVER_SCOPES,
  PART2_HONOURED_SCOPES,
  CONSENT_CATEGORIES,
  CAREGIVER_INVITATION_TTL_DAYS,
  PATIENT_ACTIVATION_TTL_DAYS,
  INVITATION_TTL_DAYS,
  PASSWORD_RESET_TTL_MINUTES,
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  MFA_RECOVERY_CODE_COUNT,
  SAFE_AUTH_ERROR,
};
