'use strict';

// Request/response validation schemas (control #6). Every schema that maps to
// a request body is strict: unknown fields are rejected rather than silently
// stripped, so typos and smuggled parameters fail loudly.
const {
  z,
  emailSchema,
  passwordSchema,
  nameSchema,
  objectIdSchema,
  totpCodeSchema,
  pageSchema,
  limitSchema,
} = require('../middleware/validate');

const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(200),
  })
  .strict();

const mfaVerifySchema = z
  .object({
    code: totpCodeSchema.optional(),
    recoveryCode: z.string().trim().regex(/^[a-f0-9]{10}$/, 'Invalid recovery code').optional(),
  })
  .strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'Provide either a 6-digit code or a recovery code.',
  });

const mfaEnrollVerifySchema = z.object({ code: totpCodeSchema }).strict();

const acceptInvitationSchema = z
  .object({
    token: z.string().trim().min(16).max(200),
    name: nameSchema.optional(),
    password: passwordSchema,
  })
  .strict();

const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(16).max(200),
    password: passwordSchema,
  })
  .strict();

const createClinicSchema = z.object({ name: nameSchema }).strict();

const paginationQuery = z
  .object({
    page: pageSchema,
    limit: limitSchema,
    query: z.string().trim().max(120).optional(),
  })
  .passthrough();

const inviteStaffSchema = z
  .object({
    email: emailSchema,
    roleKey: z.enum(['admin', 'care_coordinator', 'clinical_reviewer']),
  })
  .strict();

const updateMemberSchema = z
  .object({
    roleKey: z.enum(['admin', 'care_coordinator', 'clinical_reviewer']).optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.roleKey) || Boolean(v.status), {
    message: 'Provide at least one field to update.',
  });

const memberIdParam = z.object({ membershipId: objectIdSchema }).strict();
const invitationIdParam = z.object({ invitationId: objectIdSchema }).strict();

const reviewerEligibilitySchema = z
  .object({ action: z.enum(['verify', 'revoke']) })
  .strict();

const updateClinicSchema = z
  .object({ name: nameSchema })
  .strict();

// ---------- Part 2: patients, consent and caregiver access ----------

const isoDateSchema = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Enter a valid date');

const createPatientSchema = z
  .object({
    fullName: nameSchema,
    dateOfBirth: isoDateSchema.optional(),
    contactEmail: emailSchema.optional(),
    contactPhone: z.string().trim().max(40).optional(),
    reference: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9-]+$/, 'Reference may contain letters, digits and hyphens')
      .optional(),
  })
  .strict();

const updatePatientSchema = z
  .object({
    fullName: nameSchema.optional(),
    dateOfBirth: isoDateSchema.optional(),
    contactEmail: emailSchema.optional(),
    contactPhone: z.string().trim().max(40).optional(),
    status: z.enum(['inactive']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update.' });

const patientIdParam = z.object({ patientId: objectIdSchema }).strict();

const assignmentParams = z
  .object({ patientId: objectIdSchema, assignmentId: objectIdSchema })
  .strict();

const createAssignmentSchema = z.object({ memberUserId: objectIdSchema }).strict();

const consentSchema = z
  .object({
    action: z.enum(['granted', 'updated', 'withdrawn']),
    purpose: z.string().trim().min(3).max(200),
    categories: z
      .array(z.enum(['care_coordination', 'caregiver_access', 'future_ai_assistance']))
      .max(8)
      .optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const inviteCaregiverSchema = z
  .object({
    email: emailSchema,
    // Omitted scopes default to view_profile ONLY - never a silent widening.
    // `log_tasks` is a WRITE scope and is never implied by `view_tasks`.
    scopes: z
      .array(
        z.enum([
          'view_profile',
          'view_episodes',
          'view_documents',
          'view_plan',
          'view_tasks',
          'log_tasks',
        ])
      )
      .max(6)
      .optional(),
  })
  .strict();

const caregiverGrantParams = z
  .object({ patientId: objectIdSchema, grantId: objectIdSchema })
  .strict();

const acceptAccessInvitationSchema = z
  .object({
    token: z.string().trim().min(16).max(200),
    password: passwordSchema,
    name: nameSchema.optional(),
  })
  .strict();

const patientActivationSchema = z.object({ email: emailSchema }).strict();

// ---------- Part 3: recovery episodes and care-team assignment ----------

// A strict calendar date, so a discharge date never depends on the caller's
// clock or offset. The IANA timezone is validated in the service.
const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a calendar date (YYYY-MM-DD)')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Enter a real calendar date');

const createEpisodeSchema = z
  .object({
    patientId: objectIdSchema,
    dischargeDate: dateOnlySchema,
    dischargeTimezone: z.string().trim().min(1).max(64),
    reference: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9-]+$/, 'Reference may contain letters, digits and hyphens')
      .optional(),
  })
  .strict();

const correctDischargeSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    dischargeDate: dateOnlySchema.optional(),
    dischargeTimezone: z.string().trim().min(1).max(64).optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => v.dischargeDate !== undefined || v.dischargeTimezone !== undefined, {
    message: 'Provide a discharge date or timezone to correct.',
  });

const episodeIdParam = z.object({ episodeId: objectIdSchema }).strict();
const documentParams = z
  .object({ episodeId: objectIdSchema, documentId: objectIdSchema })
  .strict();
const episodeTeamParams = z
  .object({ episodeId: objectIdSchema, assignmentId: objectIdSchema })
  .strict();

const assignTeamSchema = z
  .object({
    memberUserId: objectIdSchema,
    responsibility: z.enum(['care_coordinator', 'clinical_reviewer']),
  })
  .strict();

// ---- Part 5: manual care plans -------------------------------------------------

const planIdParam = z.object({ episodeId: objectIdSchema, planId: objectIdSchema }).strict();
const planItemParams = z
  .object({ episodeId: objectIdSchema, planId: objectIdSchema, itemId: objectIdSchema })
  .strict();
const planSourceParams = z
  .object({ episodeId: objectIdSchema, planId: objectIdSchema, sourceId: objectIdSchema })
  .strict();

const revisionOnlySchema = z.object({ expectedRevision: z.coerce.number().int().min(1) }).strict();

// Clinical text is stored and returned as TEXT only (control #7): length-bounded,
// never interpreted as markup, and every HTML-looking string is treated as
// literal content.
const clinicalText = (max) => z.string().trim().max(max);

const createPlanSchema = z
  .object({
    title: clinicalText(200).optional(),
    summary: clinicalText(2000).optional(),
    fromVersionId: objectIdSchema.optional(),
  })
  .strict();

const updatePlanSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    title: clinicalText(200).optional(),
    summary: clinicalText(2000).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.summary !== undefined, {
    message: 'Provide a title or summary to update.',
  });

const planItemFields = {
  kind: z
    .enum(['medication', 'instruction', 'monitoring', 'follow_up', 'warning', 'diet_activity', 'home_care'])
    .optional(),
  originalWording: clinicalText(2000),
  medication: clinicalText(200).optional(),
  dose: clinicalText(120).optional(),
  route: clinicalText(120).optional(),
  frequency: clinicalText(120).optional(),
  timing: clinicalText(200).optional(),
  duration: clinicalText(120).optional(),
  condition: clinicalText(300).optional(),
  homeCare: clinicalText(500).optional(),
  dietActivity: clinicalText(500).optional(),
  followUp: clinicalText(500).optional(),
  warning: clinicalText(500).optional(),
};

const createPlanItemSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    order: z.coerce.number().int().min(1).max(10000).optional(),
    ...planItemFields,
  })
  .strict();

const updatePlanItemSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    ...planItemFields,
    originalWording: clinicalText(2000).optional(),
  })
  .strict();

const reorderPlanItemSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    direction: z.enum(['up', 'down']),
  })
  .strict();

const linkSourceSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    documentId: objectIdSchema,
    text: z.string().trim().min(1).max(2000),
    page: z.coerce.number().int().min(1).max(100000).optional(),
    location: z.string().trim().max(300).optional(),
  })
  .strict();

const reviewPlanItemSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    decision: z.enum(['accepted', 'clarify']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const clarificationSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    reason: z.string().trim().min(5, 'Explain what needs clarifying').max(500),
  })
  .strict();

const approvePlanSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    // An explicit acknowledgement that approval publishes this version to the
    // patient as the current plan.
    confirm: z.literal(true, { errorMap: () => ({ message: 'Approval must be confirmed.' }) }),
  })
  .strict();

// ---- Part 6: AI-assisted extraction and reviewed language ----------------------

const extractionJobParams = z
  .object({ episodeId: objectIdSchema, jobId: objectIdSchema })
  .strict();
const extractionSuggestionParams = z
  .object({ episodeId: objectIdSchema, jobId: objectIdSchema, suggestionId: objectIdSchema })
  .strict();
const variantParams = z
  .object({ episodeId: objectIdSchema, planId: objectIdSchema, variantId: objectIdSchema })
  .strict();
const planItemVariantParams = z
  .object({ episodeId: objectIdSchema, planId: objectIdSchema, itemId: objectIdSchema })
  .strict();

// A job is created for ONE ready document and ONE draft version.
const createExtractionJobSchema = z
  .object({
    documentId: objectIdSchema,
    versionId: objectIdSchema,
  })
  .strict();

// The values a coordinator ACCEPTS. Any subset of the schema fields: a field the
// coordinator does not supply falls back to the suggestion, and nothing is
// invented. Bounded exactly like a hand-typed item.
const acceptedFieldValues = z
  .object({
    kind: z
      .enum(['medication', 'instruction', 'monitoring', 'follow_up', 'warning', 'diet_activity', 'home_care'])
      .optional(),
    originalWording: clinicalText(2000).optional(),
    medication: clinicalText(200).optional(),
    dose: clinicalText(120).optional(),
    route: clinicalText(120).optional(),
    frequency: clinicalText(120).optional(),
    timing: clinicalText(200).optional(),
    duration: clinicalText(120).optional(),
    condition: clinicalText(300).optional(),
    homeCare: clinicalText(500).optional(),
    dietActivity: clinicalText(500).optional(),
    followUp: clinicalText(500).optional(),
    warning: clinicalText(500).optional(),
  })
  .strict();

const applySuggestionSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    fields: acceptedFieldValues.optional(),
  })
  .strict();

const dismissSuggestionSchema = z
  .object({ reason: z.string().trim().max(300).optional() })
  .strict();

const createVariantSchema = z
  .object({
    language: z.enum(['hi', 'en']),
    kind: z.enum(['translation', 'simplification']),
    text: z.string().trim().min(1).max(2000),
    producedBy: z.enum(['model', 'human']).optional(),
  })
  .strict();

const approveVariantSchema = z
  .object({
    // The reviewer must state that the rendering preserves the instruction's
    // meaning. Approval without that statement is refused.
    fidelityNote: z.string().trim().min(5, 'State that the meaning is preserved').max(500),
  })
  .strict();

const rejectVariantSchema = z
  .object({ reason: z.string().trim().min(5, 'Explain what is wrong').max(500) })
  .strict();

// ---- Part 7: schedules, recovery tasks, day view and activity logs ------------

const scheduleParams = z
  .object({ episodeId: objectIdSchema, scheduleId: objectIdSchema })
  .strict();

// An explicit IANA zone is validated for real in the service (Intl); this only
// bounds the string so a huge value never reaches it.
const timezoneField = z.string().trim().min(1).max(64);

const prepareSchedulesSchema = z
  .object({
    timezone: timezoneField.optional(),
    startDate: dateOnlySchema.optional(),
    horizonDays: z.coerce.number().int().min(1).max(60).optional(),
  })
  .strict();

const activateScheduleSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

const endScheduleSchema = z
  .object({ reason: z.string().trim().min(3, 'Give a short reason').max(300) })
  .strict();

// The day view takes ONE tab at a time so a panel stays a single bounded list.
const todayQuery = z
  .object({
    patientId: objectIdSchema.optional(),
    episodeId: objectIdSchema.optional(),
    date: dateOnlySchema.optional(),
    timezone: timezoneField.optional(),
    tab: z.enum(['medication', 'task']).default('medication'),
    page: pageSchema,
    limit: z.coerce.number().int().min(1).max(25).default(10),
  })
  .strict();

const instantSchema = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid instant');

// Recording an entry. `clientRequestId` makes a retry idempotent, so the client
// is REQUIRED to send one rather than the server inventing one per attempt.
const recordEntrySchema = z
  .object({
    entryState: z.enum(['taken', 'skipped', 'reported_done', 'needs_help']),
    occurrenceId: objectIdSchema.optional(),
    scheduleId: objectIdSchema.optional(),
    occurredAt: instantSchema.optional(),
    note: z.string().trim().max(500).optional(),
    clientRequestId: z.string().trim().min(8).max(100),
    correctsLogId: objectIdSchema.optional(),
    correctionReason: z.string().trim().min(5, 'Explain the correction').max(300).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.occurrenceId) !== Boolean(v.scheduleId), {
    message: 'Provide either an occurrence or an as-needed schedule.',
  })
  .refine((v) => !v.correctsLogId || Boolean(v.correctionReason), {
    message: 'Explain why the entry is being corrected.',
  });

module.exports = {
  loginSchema,
  scheduleParams,
  prepareSchedulesSchema,
  activateScheduleSchema,
  endScheduleSchema,
  todayQuery,
  recordEntrySchema,
  mfaVerifySchema,
  mfaEnrollVerifySchema,
  acceptInvitationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  createClinicSchema,
  paginationQuery,
  inviteStaffSchema,
  updateMemberSchema,
  memberIdParam,
  invitationIdParam,
  reviewerEligibilitySchema,
  updateClinicSchema,
  createPatientSchema,
  updatePatientSchema,
  patientIdParam,
  assignmentParams,
  createAssignmentSchema,
  consentSchema,
  inviteCaregiverSchema,
  caregiverGrantParams,
  acceptAccessInvitationSchema,
  patientActivationSchema,
  createEpisodeSchema,
  correctDischargeSchema,
  episodeIdParam,
  documentParams,
  episodeTeamParams,
  planIdParam,
  planItemParams,
  planSourceParams,
  revisionOnlySchema,
  createPlanSchema,
  updatePlanSchema,
  createPlanItemSchema,
  updatePlanItemSchema,
  reorderPlanItemSchema,
  linkSourceSchema,
  reviewPlanItemSchema,
  clarificationSchema,
  approvePlanSchema,
  assignTeamSchema,
  extractionJobParams,
  extractionSuggestionParams,
  variantParams,
  planItemVariantParams,
  createExtractionJobSchema,
  applySuggestionSchema,
  dismissSuggestionSchema,
  createVariantSchema,
  approveVariantSchema,
  rejectVariantSchema,
};
