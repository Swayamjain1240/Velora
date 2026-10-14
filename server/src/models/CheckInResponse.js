'use strict';

const mongoose = require('mongoose');
const {
  CHECKIN_RESPONSE_STATES,
  CHECKIN_REVIEW_STATES,
} = require('../config/constants');

// A response SLOT for one patient, one episode and one versioned clinic template
// (VEL-015).
//
// Two facts matter and neither is a clinical judgement:
//
//   * The slot is materialised when it becomes DUE, in the episode's own IANA
//     timezone. `submittedAt` is the only place a response exists; a slot with no
//     submission is simply `open` until its window closes, and after that it is
//     reported as MISSING by the read path - never stored as "normal",
//     "abnormal" or any other classification (control #3/#4).
//   * `triggeredRules` records that a CLINIC-DEFINED rule asked a person to look.
//     That is workflow attention in an assigned queue, not a diagnosis (control
//     #5), and `reviewState` only ever moves to `reviewed` because a human said
//     so.
//
// Storage notes:
//   * `template` + `templateVersion` point at the frozen CheckInTemplateVersion,
//     so the wording a patient was asked can always be recovered, and a NEW
//     template version never rewrites an existing answer.
//   * Answers are APPEND-ONLY once submitted: the pre-save guard refuses any
//     later change, exactly like a Part 7 entry log. A correction is a review
//     note by a person, not an edit of what the patient said.
const answerSchema = new mongoose.Schema(
  {
    // Stable question id from the template version that was asked.
    questionId: { type: String, required: true, trim: true, maxlength: 40 },
    kind: { type: String, required: true, enum: ['text', 'choice', 'scale', 'confirm'] },
    // The value exactly as stored for comparison by the rule evaluator. It is
    // always a STRING so a mixed rule language cannot accidentally coerce.
    value: { type: String, trim: true, maxlength: 500, default: null },
    // Multi-select answers (a choice question answered with several options).
    values: { type: [{ type: String, trim: true, maxlength: 120 }], default: undefined },
  },
  { _id: false }
);

const triggeredRuleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true, maxlength: 160 },
    questionId: { type: String, required: true, trim: true },
    operator: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const checkInResponseSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    episode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecoveryEpisode',
      required: true,
      immutable: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientProfile',
      required: true,
      immutable: true,
    },
    template: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CheckInTemplateVersion',
      required: true,
      immutable: true,
    },
    templateKey: { type: String, required: true, trim: true, immutable: true },
    templateVersion: { type: Number, required: true, min: 1, immutable: true },
    // Deterministic slot identity: `<templateKey>@<YYYY-MM-DD>` in the episode's
    // zone. Unique per episode, which is what makes a duplicate submission
    // impossible rather than merely unlikely.
    slotKey: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    // The local calendar date the slot belongs to, and the UTC instant it became
    // due. Both are derived server-side from the episode's timezone.
    slotDate: { type: String, required: true, trim: true, immutable: true },
    dueAt: { type: Date, required: true, immutable: true },
    // The operational window, not a clinical deadline: after this instant the
    // read path reports the slot as missing instead of changing anything.
    windowEndsAt: { type: Date, required: true },
    timezone: { type: String, required: true, trim: true, maxlength: 64, immutable: true },
    state: {
      type: String,
      enum: Object.values(CHECKIN_RESPONSE_STATES),
      default: CHECKIN_RESPONSE_STATES.OPEN,
      required: true,
    },
    answers: {
      type: [answerSchema],
      default: [],
      validate: [(v) => v.length <= 30, 'A response may answer at most 30 questions'],
    },
    submittedAt: { type: Date },
    // Who answered, in which capacity. A caregiver answer names the grant it used
    // so an auditor can see the authorization that allowed it (control #5).
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedByLabel: { type: String, trim: true, maxlength: 254 },
    submittedByRole: { type: String, enum: ['patient', 'caregiver', 'staff'] },
    submittedByGrant: { type: mongoose.Schema.Types.ObjectId, ref: 'CaregiverGrant' },
    // Late is recorded as a delivery/timing fact. It never changes the answers
    // and it is never read as a clinical signal.
    isLate: { type: Boolean, default: false },
    triggeredRules: { type: [triggeredRuleSchema], default: [] },
    reviewState: {
      type: String,
      enum: Object.values(CHECKIN_REVIEW_STATES),
      default: CHECKIN_REVIEW_STATES.NONE,
      required: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByLabel: { type: String, trim: true, maxlength: 254 },
    reviewedAt: { type: Date },
    reviewNote: { type: String, trim: true, maxlength: 1000 },
    // Which assigned staff member owns this review, when the queue was claimed.
    reviewOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// A duplicate slot for the same episode cannot exist.
checkInResponseSchema.index({ episode: 1, slotKey: 1 }, { unique: true });
// Dashboard/queue reads: the clinic's slots by due date and review state.
checkInResponseSchema.index({ clinic: 1, dueAt: -1 });
checkInResponseSchema.index({ clinic: 1, reviewState: 1, dueAt: -1 });
checkInResponseSchema.index({ clinic: 1, patient: 1, dueAt: -1 });
checkInResponseSchema.index({ episode: 1, dueAt: 1 });

// Append-only answers: once a response is submitted, its content cannot change.
// Review attribution may still be added by an authorised reviewer.
checkInResponseSchema.pre('save', function preventAnswerEdit(next) {
  if (!this.isNew && this.isModified('answers')) {
    return next(
      new Error(
        'A submitted check-in response is append-only; answers cannot be edited after submission.'
      )
    );
  }
  return next();
});

module.exports = mongoose.model('CheckInResponse', checkInResponseSchema);
