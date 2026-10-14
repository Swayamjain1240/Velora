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

// Part 8: a clinic publishes its own response hours and emergency guidance.
// `monitoredContinuously` is explicit and defaults to false - the product must
// never imply continuous monitoring the clinic has not stated.
const responseHoursSchema = z
  .object({
    display: z.string().trim().min(5).max(200),
    timezone: z.string().trim().min(1).max(64),
    weekdays: z.string().trim().max(120).optional(),
    from: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
    to: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
    monitoredContinuously: z.boolean().optional(),
  })
  .strict();

const emergencyInstructionsSchema = z
  .object({
    display: z.string().trim().min(5).max(500),
    contactPhone: z
      .string()
      .trim()
      .max(40)
      .regex(/^[0-9+()\-\s]{3,40}$/, 'Use a plain phone number')
      .optional(),
  })
  .strict();

const updateClinicSchema = z
  .object({
    name: nameSchema.optional(),
    responseHours: responseHoursSchema.optional(),
    emergencyInstructions: emergencyInstructionsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide a setting to update.' });

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
    // A WRITE scope (`log_tasks`, `log_checkins`) is never implied by its read
    // counterpart, and Part 8 adds the check-in pair plus `ask_questions`.
    scopes: z
      .array(
        z.enum([
          'view_profile',
          'view_episodes',
          'view_documents',
          'view_plan',
          'view_tasks',
          'log_tasks',
          'view_checkins',
          'log_checkins',
          'ask_questions',
        ])
      )
      .max(9)
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

// ---- Part 8: clinic check-in templates -----------------------------------------

const templateKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'Template key must be a short slug');

const checkInQuestionSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Question id must be a short slug'),
    prompt: clinicalText(300).refine((v) => v.length >= 3, 'Enter the question'),
    kind: z.enum(['text', 'choice', 'scale', 'confirm']),
    required: z.boolean().optional(),
    options: z.array(clinicalText(120)).max(12).optional(),
    scaleMin: z.coerce.number().int().min(0).max(10).optional(),
    scaleMax: z.coerce.number().int().min(0).max(10).optional(),
  })
  .strict();

const checkInCadenceSchema = z
  .object({
    startOffsetDays: z.coerce.number().int().min(0).max(180),
    everyDays: z.coerce.number().int().min(1).max(90),
    horizonDays: z.coerce.number().int().min(1).max(90),
  })
  .strict();

// A rule may ONLY ask a person to look; the enum makes any other action
// impossible to express, and the wording guard in the service rejects a label
// that reads as a clinical conclusion.
const checkInRuleSchema = z
  .object({
    id: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Rule id must be a short slug'),
    label: clinicalText(160).refine((v) => v.length >= 3, 'Describe what the reviewer will read'),
    when: z
      .object({
        questionId: z.string().trim().min(1).max(40),
        operator: z.enum([
          'answered',
          'no_answer',
          'equals',
          'not_equals',
          'includes_any',
          'at_least',
          'at_most',
        ]),
        values: z.array(clinicalText(120)).max(12).optional(),
        value: z.coerce.number().min(0).max(10).optional(),
      })
      .strict(),
    action: z.literal('queue_review').optional(),
  })
  .strict();

const createCheckInTemplateSchema = z
  .object({
    key: templateKeySchema,
    title: clinicalText(160).refine((v) => v.length >= 3, 'Give the template a title'),
    description: clinicalText(500).optional(),
    questions: z.array(checkInQuestionSchema).min(1).max(30),
    cadence: checkInCadenceSchema,
    responseWindowHours: z.coerce.number().int().min(1).max(168).optional(),
    reviewRules: z.array(checkInRuleSchema).max(20).optional(),
  })
  .strict();

const updateCheckInTemplateSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    title: clinicalText(160).optional(),
    description: clinicalText(500).optional(),
    questions: z.array(checkInQuestionSchema).min(1).max(30).optional(),
    cadence: checkInCadenceSchema.optional(),
    responseWindowHours: z.coerce.number().int().min(1).max(168).optional(),
    reviewRules: z.array(checkInRuleSchema).max(20).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, { message: 'Provide a field to update.' });

const activateCheckInTemplateSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    note: clinicalText(500).optional(),
  })
  .strict();

const checkInTemplateParam = z.object({ templateId: objectIdSchema }).strict();

// Part 8: the patient's own queue addresses a slot directly (the slot is already
// scoped to their episode), so no episode id is accepted from the client.
const checkInResponseIdParam = z.object({ responseId: objectIdSchema }).strict();

const patientCheckInQuery = z
  .object({
    page: pageSchema,
    limit: limitSchema,
    view: z.enum(['due', 'open', 'no_response', 'submitted']).optional(),
  })
  .strict();

const checkInTemplateQuery = z
  .object({
    page: pageSchema,
    limit: limitSchema,
    state: z.enum(['draft', 'active', 'superseded']).optional(),
  })
  .strict();

// ---- Part 8: check-in response slots -------------------------------------------

const checkInResponseParams = z
  .object({ episodeId: objectIdSchema, responseId: objectIdSchema })
  .strict();

// One answer per question, expressed the same way the policy validates it: a
// scalar `value`, or `values` for a multi-select choice. Unknown fields are
// refused so a client cannot smuggle an extra question id past the validator.
const checkInAnswerSchema = z
  .object({
    questionId: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Question id must be a short slug'),
    value: z.union([z.string().trim().max(500), z.number(), z.boolean()]).optional(),
    values: z.array(z.string().trim().max(120)).max(12).optional(),
  })
  .strict()
  .refine((v) => v.value !== undefined || (v.values && v.values.length > 0), {
    message: 'Give an answer for each question.',
  });

const submitCheckInSchema = z
  .object({
    answers: z.array(checkInAnswerSchema).min(1).max(30),
  })
  .strict();

const reviewCheckInSchema = z
  .object({
    note: clinicalText(1000).optional(),
  })
  .strict();

const checkInListQuery = z
  .object({
    page: pageSchema,
    limit: limitSchema,
    // `due` counts an answerable slot as available; `no_response` is the derived
    // missing view and is never a stored state.
    view: z.enum(['due', 'open', 'no_response', 'submitted', 'needs_review']).optional(),
  })
  .strict();

// ---- Part 8: the clarification queue -------------------------------------------

const clarificationThreadParams = z
  .object({ episodeId: objectIdSchema, threadId: objectIdSchema })
  .strict();

const clarificationThreadIdParam = z.object({ threadId: objectIdSchema }).strict();

// Plain text only: the policy refuses markup, and the bound here keeps a huge
// body from ever reaching the service or the database.
const threadBody = z.string().trim().min(2).max(2000);

const openThreadSchema = z
  .object({
    // The KIND decides which authority may answer, so it is part of the request
    // rather than inferred from the wording.
    kind: z.enum(['clinical', 'operational']),
    subject: z.string().trim().min(3).max(160),
    body: threadBody,
    // Optional link to the check-in response the question came from.
    responseId: objectIdSchema.optional(),
  })
  .strict();

const assignThreadSchema = z
  .object({
    assigneeUserId: objectIdSchema,
    note: clinicalText(300).optional(),
  })
  .strict();

const answerThreadSchema = z
  .object({
    body: threadBody,
    note: clinicalText(300).optional(),
  })
  .strict();

const threadNoteSchema = z.object({ body: threadBody }).strict();
const threadReplySchema = z.object({ body: threadBody }).strict();

const threadStateSchema = z
  .object({
    page: pageSchema,
    limit: limitSchema,
    state: z.enum(['open', 'assigned', 'answered', 'closed', 'reopened']).optional(),
    // A query string is text, and `z.coerce.boolean()` would read "false" as
    // true; the enum keeps the filter honest.
    assignedToMe: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

const threadTransitionSchema = z.object({ note: clinicalText(300).optional() }).strict();

// ---- Part 8: in-app reminders --------------------------------------------------

const reminderParams = z
  .object({ episodeId: objectIdSchema, notificationId: objectIdSchema })
  .strict();

const queueRemindersSchema = z
  .object({
    // Which reminder sources to consider. The list is closed: a reminder is an
    // OPERATIONAL event, and there is no "clinical alert" to ask for.
    kinds: z
      .array(z.enum(['check_in_due', 'task_due', 'medication_due', 'follow_up']))
      .min(1)
      .max(4)
      .optional(),
  })
  .strict();

const deliverRemindersSchema = z
  .object({
    // The batch size is bounded server-side as well, so this can only narrow it.
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const acknowledgeReminderSchema = z.object({}).strict();
const notificationIdParam = z.object({ notificationId: objectIdSchema }).strict();

// ---- Part 8: the assigned-team dashboard ---------------------------------------

// The queue catalog comes from the constants module, so a renamed queue cannot
// leave the validator accepting a key the service no longer has.
const { QUEUE_KEYS } = require('../config/constants');
const QUEUE_KEY_VALUES = Object.values(QUEUE_KEYS);

const dashboardQuery = z
  .object({
    page: pageSchema,
    limit: limitSchema,
    // A caller may narrow to the items THEY are accountable for; they can never
    // widen beyond their own assignment scope, which the service always applies.
    mine: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();

const queueKeyParam = z.object({ queueKey: z.enum(QUEUE_KEY_VALUES) }).strict();

const queueTargetParams = z
  .object({ queueKey: z.enum(QUEUE_KEY_VALUES), targetId: z.string().trim().min(1).max(120) })
  .strict();

const assignmentIdParam = z.object({ assignmentId: objectIdSchema }).strict();

const releaseAssignmentSchema = z.object({ reason: clinicalText(300).optional() }).strict();

// ---- Part 8: basic prescribed follow-ups ---------------------------------------
//
// The field list is CLOSED and strict. A test result, a report reference or a
// referral destination has no field to arrive in, so the request is refused
// rather than quietly stored.
// A follow-up reuses the shared calendar-date schema and the same HH:MM rule the
// clinic response hours use, so the bounds cannot drift apart.
const timeOnlySchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const followUpReminderSchema = z
  .object({
    enabled: z.boolean().optional(),
    localTime: timeOnlySchema.optional(),
    daysBefore: z.coerce.number().int().min(0).max(30).optional(),
  })
  .strict();

const createFollowUpSchema = z
  .object({
    date: dateOnlySchema,
    time: timeOnlySchema.optional(),
    timezone: z.string().trim().min(1).max(64),
    location: clinicalText(200).refine((v) => v.length >= 3, 'State where the follow-up is'),
    contactName: clinicalText(120).optional(),
    contactPhone: z.string().trim().regex(/^[0-9+()\-\s]{3,40}$/, 'Use a reachable number').optional(),
    note: clinicalText(500).optional(),
    reminder: followUpReminderSchema.optional(),
  })
  .strict();

const updateFollowUpSchema = z
  .object({
    date: dateOnlySchema.optional(),
    time: timeOnlySchema.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    location: clinicalText(200).optional(),
    contactName: clinicalText(120).optional(),
    contactPhone: z.string().trim().regex(/^[0-9+()\-\s]{3,40}$/, 'Use a reachable number').optional(),
    note: clinicalText(500).optional(),
    reminder: followUpReminderSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide a field to update.' });

const followUpParams = z
  .object({ episodeId: objectIdSchema, followUpId: objectIdSchema })
  .strict();

const cancelFollowUpSchema = z.object({ reason: clinicalText(300).optional() }).strict();

module.exports = {
  loginSchema,
  createFollowUpSchema,
  updateFollowUpSchema,
  cancelFollowUpSchema,
  followUpParams,
  reminderParams,
  notificationIdParam,
  dashboardQuery,
  queueKeyParam,
  queueTargetParams,
  assignmentIdParam,
  releaseAssignmentSchema,
  queueRemindersSchema,
  deliverRemindersSchema,
  acknowledgeReminderSchema,
  clarificationThreadParams,
  clarificationThreadIdParam,
  openThreadSchema,
  assignThreadSchema,
  answerThreadSchema,
  threadNoteSchema,
  threadReplySchema,
  threadStateSchema,
  threadTransitionSchema,
  checkInResponseParams,
  checkInResponseIdParam,
  submitCheckInSchema,
  reviewCheckInSchema,
  checkInListQuery,
  patientCheckInQuery,
  checkInQuestionSchema,
  checkInCadenceSchema,
  checkInRuleSchema,
  createCheckInTemplateSchema,
  updateCheckInTemplateSchema,
  activateCheckInTemplateSchema,
  checkInTemplateParam,
  checkInTemplateQuery,
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
  responseHoursSchema,
  emergencyInstructionsSchema,
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
