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
  // Part 6: running an AI-ASSISTED extraction job. This is a drafting aid, so it
  // sits with the drafting role and NEVER confers review, approval or any
  // clinical authority: an extraction job cannot approve, publish, prescribe,
  // change clinical state, activate a task or send a reminder.
  EXTRACTION_RUN: 'extraction.run',
  // Part 7: preparing/ending schedules and recovery tasks from the CURRENT
  // APPROVED plan version. This is operational preparation - it can only read an
  // approved version and can never edit, approve or supersede one.
  SCHEDULE_PREPARE: 'schedule.prepare',
  // Part 7: clinical activation of a prepared MEDICATION schedule. A task-type
  // schedule may be activated operationally, but a medication schedule becomes
  // patient-visible only through a verified clinical reviewer (enforced again in
  // the service, which requires the reviewer's current assignment).
  SCHEDULE_ACTIVATE: 'schedule.activate',
});

const ROLES = Object.freeze({
  ADMIN: 'admin',
  CARE_COORDINATOR: 'care_coordinator',
  CLINICAL_REVIEWER: 'clinical_reviewer',
  PATIENT: 'patient',
  CAREGIVER: 'caregiver',
});

// Granular caregiver scopes. The catalog is deliberately wider than what is
// enforced: a declared scope stays INERT until the part that enforces it lands,
// and granting one scope must NEVER silently confer another (control #5).
//
// Enforced today:
//   view_profile - the patient's basic profile (Part 2)
//   view_tasks   - the approved medication/task day view (Part 7)
//   log_tasks    - recording an entry against that day view (Part 7)
// Declared but still INERT (they grant nothing): view_episodes,
// view_documents, view_plan.
const CAREGIVER_SCOPES = Object.freeze([
  'view_profile',
  'view_episodes',
  'view_documents',
  'view_plan',
  'view_tasks',
  'log_tasks',
]);
// The single source of truth for "which scopes the code actually honours", so a
// future scope cannot be assumed live just because it is in the catalog.
const HONOURED_CAREGIVER_SCOPES = Object.freeze(['view_profile', 'view_tasks', 'log_tasks']);

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
      PERMISSIONS.EXTRACTION_RUN,
      // Part 7: operational schedule preparation. NOTE that holding
      // schedule.activate here does NOT let a coordinator activate a MEDICATION
      // schedule: the service re-derives the assigned, verified clinical
      // reviewer for that, exactly as plan approval requires one.
      PERMISSIONS.SCHEDULE_PREPARE,
      PERMISSIONS.SCHEDULE_ACTIVATE,
    ],
    // The coordinator can draft a manual plan but can never review, clarify or
    // approve one: that requires the separately verified reviewer role.
  },
  {
    key: ROLES.CLINICAL_REVIEWER,
    name: 'Clinical Reviewer',
    // Reads patient context for review; cannot create or administer patients.
    // Part 5 adds plan review, which is the only path to an approved plan.
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.CLINICAL_REVIEW,
      PERMISSIONS.PLAN_REVIEW,
      // Part 7: the reviewer is the only role that can activate a medication
      // schedule. No drafting/preparation permission: activation is not drafting.
      PERMISSIONS.SCHEDULE_ACTIVATE,
    ],
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
  HONOURED_CAREGIVER_SCOPES,
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
