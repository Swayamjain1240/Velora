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
  // Part 8 - check-ins. A clinic defines its own templates and review rules, so
  // drafting one is operational work and ACTIVATING it is a clinical decision:
  // the same split as plan drafting versus plan review.
  CHECKIN_TEMPLATE_DRAFT: 'checkin.template.draft',
  CHECKIN_TEMPLATE_ACTIVATE: 'checkin.template.activate',
  // Part 8: reviewing a check-in response whose clinic rule asked for
  // attention. This is workflow review - it never classifies recovery.
  CHECKIN_REVIEW: 'checkin.review',
  // Part 8 - clarification. Anyone in scope may ASK; only the assigned verified
  // reviewer may answer a CLINICAL question, and the coordinator may answer
  // OPERATIONAL questions. The two answer permissions are deliberately separate.
  QUESTION_ASK: 'question.ask',
  QUESTION_ASSIGN: 'question.assign',
  QUESTION_ANSWER_OPERATIONAL: 'question.answer.operational',
  QUESTION_ANSWER_CLINICAL: 'question.answer.clinical',
  // Part 8 - the assigned-team dashboard. Holding this is not enough on its own:
  // every queue is re-scoped to the caller's active assignments server-side.
  DASHBOARD_READ: 'dashboard.read',
  // Part 8: running the bounded in-app reminder delivery batch for an episode.
  REMINDER_RUN: 'reminder.run',
  // Part 9 - closure. Closing or reopening an episode is operational work done by
  // ASSIGNED staff; it never means medically recovered, and the service
  // re-derives the caller's live care-team assignment on every close.
  CLOSURE_MANAGE: 'closure.manage',
  // Part 9 - privacy requests. Any in-scope staff member may RAISE a request;
  // deciding, executing and confirming identity is a separate permission held by
  // administration so one person cannot both ask and approve. A patient may
  // raise a request about their OWN data (ownership is re-derived, never taken
  // from the request body).
  PRIVACY_REQUEST_CREATE: 'privacy.request.create',
  PRIVACY_REQUEST_MANAGE: 'privacy.request.manage',
  // Part 9 - retention. Reading the configuration is administrative; APPLYING a
  // retention run is a separate, explicitly operator-attributed permission, and
  // clinical records stay report-only regardless of it.
  RETENTION_MANAGE: 'retention.manage',
  RETENTION_APPLY: 'retention.apply',
  // Part 9 - operational workflow metrics. Counts and durations only; nothing
  // here may compute clinical success, adherence or readmission.
  METRICS_READ: 'metrics.read',
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
//   view_checkins - reading the patient's due check-ins (Part 8)
//   log_checkins  - answering a check-in on the patient's behalf (Part 8)
//   ask_questions - opening a clarification question in scope (Part 8)
// Declared but still INERT (they grant nothing): view_episodes,
// view_documents, view_plan.
const CAREGIVER_SCOPES = Object.freeze([
  'view_profile',
  'view_episodes',
  'view_documents',
  'view_plan',
  'view_tasks',
  'log_tasks',
  'view_checkins',
  'log_checkins',
  'ask_questions',
]);
// The single source of truth for "which scopes the code actually honours", so a
// future scope cannot be assumed live just because it is in the catalog.
const HONOURED_CAREGIVER_SCOPES = Object.freeze([
  'view_profile',
  'view_tasks',
  'log_tasks',
  'view_checkins',
  'log_checkins',
  'ask_questions',
]);

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
      // Part 9: administration owns privacy-request decisions/execution,
      // retention configuration and the retention apply step, plus the audit
      // trail and operational metrics. Holding these still grants NO clinical
      // read: every privacy request and audit search is re-scoped to records the
      // caller may touch, and closure stays with assigned clinical staff.
      PERMISSIONS.PRIVACY_REQUEST_MANAGE,
      PERMISSIONS.RETENTION_MANAGE,
      PERMISSIONS.RETENTION_APPLY,
      PERMISSIONS.METRICS_READ,
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
      // Part 8: the coordinator DRAFTS clinic check-in templates, asks and
      // assigns questions, answers OPERATIONAL questions only, reads the
      // assigned-team dashboard and runs the bounded reminder batch. Template
      // activation and clinical answers stay with the reviewer (below).
      PERMISSIONS.CHECKIN_TEMPLATE_DRAFT,
      PERMISSIONS.QUESTION_ASK,
      PERMISSIONS.QUESTION_ASSIGN,
      PERMISSIONS.QUESTION_ANSWER_OPERATIONAL,
      PERMISSIONS.DASHBOARD_READ,
      PERMISSIONS.REMINDER_RUN,
      // Part 9: an assigned coordinator may run the closure preflight, close or
      // reopen an episode and raise a privacy request. Deciding and executing a
      // privacy request stays with administration.
      PERMISSIONS.CLOSURE_MANAGE,
      PERMISSIONS.PRIVACY_REQUEST_CREATE,
      PERMISSIONS.METRICS_READ,
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
      // Part 8: the reviewer ACTIVATES a clinic check-in template, reviews a
      // response that a clinic rule flagged for attention, and is the only role
      // that may answer a CLINICAL clarification question.
      PERMISSIONS.CHECKIN_TEMPLATE_ACTIVATE,
      PERMISSIONS.CHECKIN_REVIEW,
      PERMISSIONS.QUESTION_ASK,
      PERMISSIONS.QUESTION_ANSWER_CLINICAL,
      PERMISSIONS.DASHBOARD_READ,
      // Part 9: the assigned, verified reviewer completes the clinic-policy
      // checks the closure preflight requires, so closure sits with them as well
      // as the coordinator.
      PERMISSIONS.CLOSURE_MANAGE,
      PERMISSIONS.PRIVACY_REQUEST_CREATE,
      PERMISSIONS.METRICS_READ,
    ],
  },
  {
    key: ROLES.PATIENT,
    name: 'Patient',
    // Own profile and own caregiver grants only - enforced by ownership, not by
    // a clinic-wide permission.
    permissions: [
      PERMISSIONS.PATIENT_SELF,
      // Part 9: a patient may raise a privacy request about their OWN record
      // (export, correction or deletion request). The service derives the
      // subject from the caller's own profile, so the flag alone grants nothing
      // beyond that record.
      PERMISSIONS.PRIVACY_REQUEST_CREATE,
    ],
  },
  {
    key: ROLES.CAREGIVER,
    name: 'Caregiver',
    // No clinic-wide permissions at all: every caregiver read is authorised by
    // an explicit, active, scoped grant on a specific patient.
    permissions: [],
  },
]);

// ---- Part 8: check-ins, clarification, dashboard and in-app reminders --------

// A check-in template is clinic-defined and versioned. Only ONE version may be
// active per (clinic, key): activating a new version supersedes the previous.
const CHECKIN_TEMPLATE_STATES = Object.freeze({
  DRAFT: 'draft',
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
});

// A response slot is materialised as `open` when it becomes due. `no_response`
// is the absence of an answer and is NEVER interpreted as recovery status.
const CHECKIN_RESPONSE_STATES = Object.freeze({
  OPEN: 'open',
  SUBMITTED: 'submitted',
});
const CHECKIN_NO_RESPONSE = 'no_response';

// Workflow attention only: a clinic rule asked a human to look. Not a clinical
// classification and never surfaced as normal/abnormal.
const CHECKIN_REVIEW_STATES = Object.freeze({
  NONE: 'none',
  NEEDS_REVIEW: 'needs_review',
  REVIEWED: 'reviewed',
});

const CHECKIN_QUESTION_KINDS = Object.freeze(['text', 'choice', 'scale', 'confirm']);

// Clarification thread lifecycle (VEL-016). Reopening is an EXPLICIT, audited
// transition with its own state, so a thread that came back is never mistaken for
// one that was never answered. Every transition appends actor/time/history.
const THREAD_STATES = Object.freeze({
  OPEN: 'open',
  ASSIGNED: 'assigned',
  ANSWERED: 'answered',
  CLOSED: 'closed',
  REOPENED: 'reopened',
});
const THREAD_ACTIONS = Object.freeze({
  OPEN: 'open',
  ASSIGN: 'assign',
  ANSWER: 'answer',
  CLOSE: 'close',
  REOPEN: 'reopen',
  RECLASSIFY: 'reclassify',
  NOTE: 'note',
});
const THREAD_KINDS = Object.freeze({ CLINICAL: 'clinical', OPERATIONAL: 'operational' });
const MESSAGE_KINDS = Object.freeze({
  QUESTION: 'question',
  ANSWER: 'answer',
  NOTE: 'note',
  SYSTEM: 'system',
});

// The five assigned queues of the Part 8 dashboard.
const QUEUE_KEYS = Object.freeze({
  PENDING_APPROVALS: 'pending_approvals',
  OPEN_QUESTIONS: 'open_questions',
  CHECKIN_REVIEWS: 'check_in_reviews',
  FAILED_REMINDERS: 'failed_reminders',
  MISSING_OWNERS: 'missing_owners',
});
const QUEUE_TARGETS = Object.freeze({
  PLAN_VERSION: 'care_plan_version',
  THREAD: 'clarification_thread',
  CHECKIN_RESPONSE: 'check_in_response',
  NOTIFICATION: 'notification',
  EPISODE: 'recovery_episode',
});

// Notification delivery (VEL-014). `delivered` and `acknowledged` are separate
// facts: an in-app reminder appearing in a list is NOT an acknowledgement.
const NOTIFICATION_STATES = Object.freeze({
  QUEUED: 'queued',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});
const DELIVERY_OUTCOMES = Object.freeze({
  DELIVERED: 'delivered',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});
// The only channel this part ships. Email/SMS/WhatsApp/push require their own
// disclosure and are refused by the provider registry until authorized.
const NOTIFICATION_CHANNELS = Object.freeze(['in_app']);
const REMINDER_MAX_ATTEMPTS = 3;
const REMINDER_BATCH_LIMIT = 100;
// Safe, non-clinical wording: a failed reminder is a delivery fact, not a
// statement about the patient.
const REMINDER_FAILURE_NOTE =
  'A reminder that could not be delivered is a delivery problem, not a missed dose or a clinical finding.';
const DELIVERY_NOT_ACKNOWLEDGED_NOTE =
  'A delivered reminder has not been read or acknowledged by the recipient.';

const INVITATION_TTL_DAYS = 7;
const CAREGIVER_INVITATION_TTL_DAYS = 7;
const PATIENT_ACTIVATION_TTL_DAYS = 14;
const PASSWORD_RESET_TTL_MINUTES = 30;
const SESSION_COOKIE = 'velora_session';
const CSRF_COOKIE = 'velora_csrf';
const CSRF_HEADER = 'x-csrf-token';
// ---- Part 9: closure, audit, privacy requests, retention and metrics ---------

// An episode moves draft/active -> closed, and may be REOPENED explicitly. None
// of these states describes a person's health: `closed` is an operational
// archive state, never "recovered".
const CLOSURE_STATES = Object.freeze({
  OPEN: 'open',
  CLOSED: 'closed',
  REOPENED: 'reopened',
});

// The clinic-policy checks a closure must record explicitly. The catalog is
// closed so a client cannot invent a check name, and every check carries the
// reviewer's own confirmation plus an optional note.
const CLOSURE_POLICY_CHECKS = Object.freeze([
  'plan_reviewed',
  'medications_reconciled',
  'follow_up_arranged',
  'patient_informed',
  'documents_archived',
]);

// What the preflight enumerates before a close is allowed. Each entry names the
// queue it counts and whether it BLOCKS closure. A blocking item must be cleared
// or explicitly overridden with a recorded reason.
const CLOSURE_PREFLIGHT_ITEMS = Object.freeze([
  { key: 'unresolved_approvals', label: 'Plan versions waiting for approval', blocking: true },
  { key: 'open_clarifications', label: 'Clarifications still open', blocking: true },
  { key: 'failed_deliveries', label: 'Reminders that could not be delivered', blocking: false },
  { key: 'open_tasks', label: 'Recovery tasks still open', blocking: true },
  { key: 'pending_checkins', label: 'Check-ins still awaiting an answer', blocking: false },
  { key: 'missing_owners', label: 'Items with no accountable owner', blocking: true },
]);

// Privacy-request types (VEL-020). `deletion_request` is deliberately a REQUEST
// rather than a destructive endpoint: it is policy-evaluated and may be denied or
// limited while retention applies.
const DATA_REQUEST_TYPES = Object.freeze(['export', 'correction', 'deletion_request']);

// The privacy-request state machine. Identity verification precedes assignment,
// a decision precedes execution, and execution has its own terminal outcomes so a
// partial result is never reported as a full one.
const DATA_REQUEST_STATES = Object.freeze({
  RECEIVED: 'received',
  IDENTITY_PENDING: 'identity_pending',
  IDENTITY_VERIFIED: 'identity_verified',
  IN_REVIEW: 'in_review',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXECUTING: 'executing',
  COMPLETED: 'completed',
  PARTIALLY_COMPLETED: 'partially_completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

// How identity was verified. `none` is the initial state and is never treated as
// verified.
const IDENTITY_METHODS = Object.freeze(['in_person', 'video_call', 'signed_form', 'existing_session']);

// Categories the retention engine understands. `report_only` categories are
// NEVER deleted by an automated run: they are enumerated so an operator can see
// what would be eligible, and real destruction requires a separate, explicit
// authorization plus a tested backup/restore process that Part 9 does not claim.
const RETENTION_CATEGORIES = Object.freeze([
  {
    key: 'sessions_tokens',
    label: 'Sessions and tokens',
    description: 'Expired or revoked sessions past their retention window.',
    defaultRetainDays: 30,
    enabled: true,
    reportOnly: false,
  },
  {
    key: 'generated_exports',
    label: 'Generated exports',
    description: 'Encrypted privacy-request export artifacts past their retention window.',
    defaultRetainDays: 7,
    enabled: true,
    reportOnly: false,
  },
  {
    key: 'rate_limit_buckets',
    label: 'Operational rate-limit counters',
    description: 'Fixed-window counters that only exist to enforce request budgets.',
    defaultRetainDays: 2,
    enabled: true,
    reportOnly: false,
  },
  {
    key: 'operational_logs',
    label: 'Operational logs',
    description: 'Delivery attempts and other operational traces.',
    defaultRetainDays: 90,
    enabled: true,
    reportOnly: false,
  },
  {
    key: 'documents',
    label: 'Discharge documents',
    description: 'Clinical source documents. Report-only: automated destruction is not implemented.',
    defaultRetainDays: 2555,
    enabled: true,
    reportOnly: true,
  },
  {
    key: 'historical_records',
    label: 'Eligible historical records',
    description:
      'Closed episodes, superseded plan versions and recorded activity. Report-only: automated destruction is not implemented.',
    defaultRetainDays: 2555,
    enabled: true,
    reportOnly: true,
  },
]);

// A hold freezes a category (or one subject within it) against a retention run
// until it is explicitly released.
const RETENTION_HOLD_SCOPES = Object.freeze(['category', 'subject']);

// What the audit trail must cover (VEL-020). Search filters use this catalog, so
// a client cannot ask for a category the code never writes.
const AUDIT_CATEGORIES = Object.freeze([
  'auth',
  'read',
  'download',
  'membership',
  'caregiver_grant',
  'approval',
  'ai_application',
  'log_write',
  'checkin_response',
  'clarification_response',
  'privacy_request',
  'retention',
  'closure',
  'export',
  'admin',
]);

// Operational metric catalog. Every definition states what it measures and what
// it deliberately does NOT measure, so a reader cannot mistake a duration for a
// clinical outcome.
const METRIC_DEFINITIONS = Object.freeze({
  approval_time: {
    label: 'Plan approval time',
    unit: 'hours',
    definition:
      'Elapsed time from a plan version entering review to a decision (approval or clarification).',
    notAMeasureOf: 'Correctness of the plan or the patient’s recovery.',
  },
  clarification_response_time: {
    label: 'Clarification response time',
    unit: 'hours',
    definition: 'Elapsed time from a thread being opened to its first answer.',
    notAMeasureOf: 'Quality or clinical accuracy of the answer.',
  },
  queue_age: {
    label: 'Queue age',
    unit: 'hours',
    definition: 'Age of the oldest still-open item in each assigned queue.',
    notAMeasureOf: 'Anything about a person’s health or adherence.',
  },
  coordination_workload: {
    label: 'Coordination workload',
    unit: 'items',
    definition: 'Items claimed, released and currently held per assigned team member.',
    notAMeasureOf: 'Care quality or staff performance.',
  },
});

// Public note attached to every metric response.
const METRICS_NO_CLINICAL_INFERENCE =
  'These are operational workflow durations and counts. They are not clinical outcomes and must not be read as recovery, adherence or readmission evidence.';

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
  CHECKIN_TEMPLATE_STATES,
  CHECKIN_RESPONSE_STATES,
  CHECKIN_NO_RESPONSE,
  CHECKIN_REVIEW_STATES,
  CHECKIN_QUESTION_KINDS,
  THREAD_STATES,
  THREAD_ACTIONS,
  THREAD_KINDS,
  MESSAGE_KINDS,
  QUEUE_KEYS,
  QUEUE_TARGETS,
  NOTIFICATION_STATES,
  DELIVERY_OUTCOMES,
  NOTIFICATION_CHANNELS,
  REMINDER_MAX_ATTEMPTS,
  REMINDER_BATCH_LIMIT,
  REMINDER_FAILURE_NOTE,
  DELIVERY_NOT_ACKNOWLEDGED_NOTE,
  CLOSURE_STATES,
  CLOSURE_POLICY_CHECKS,
  CLOSURE_PREFLIGHT_ITEMS,
  DATA_REQUEST_TYPES,
  DATA_REQUEST_STATES,
  IDENTITY_METHODS,
  RETENTION_CATEGORIES,
  RETENTION_HOLD_SCOPES,
  AUDIT_CATEGORIES,
  METRIC_DEFINITIONS,
  METRICS_NO_CLINICAL_INFERENCE,
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
