'use strict';

const mongoose = require('mongoose');
const { CHECKIN_TEMPLATE_STATES, CHECKIN_QUESTION_KINDS } = require('../config/constants');

// One version of a CLINIC-DEFINED check-in template (VEL-015).
//
// The clinic owns the questions and the review rules, and both are versioned:
// editing an active template is impossible - a change creates a NEW draft
// version, and activating it supersedes the previous one, exactly like a care
// plan version. Patients keep the wording they were actually asked.
//
// Nothing here classifies recovery. A rule can only ask a HUMAN to look
// (`action: 'queue_review'`); the vocabulary guard in checkInPolicy refuses
// diagnostic wording at write time.
const questionSchema = new mongoose.Schema(
  {
    // Stable id used by rules and answers (never the array position).
    id: {
      type: String,
      required: true,
      trim: true,
      match: [/^[a-z][a-z0-9_]{0,39}$/, 'Question id must be a short slug'],
    },
    prompt: { type: String, required: true, trim: true, maxlength: 300 },
    kind: { type: String, enum: Object.values(CHECKIN_QUESTION_KINDS), required: true },
    required: { type: Boolean, default: true },
    // `choice` only: bounded option list. The submitted answer must be one of
    // these values, so a response can never smuggle free text into a rule.
    options: { type: [{ type: String, trim: true, maxlength: 120 }], default: undefined },
    // `scale` only.
    scaleMin: { type: Number, min: 0, max: 10 },
    scaleMax: { type: Number, min: 0, max: 10 },
  },
  { _id: false }
);

// A rule asks for WORKFLOW ATTENTION. `action` has exactly one legal value so a
// future contributor cannot turn a rule into an escalation or a diagnosis.
const reviewRuleSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      trim: true,
      match: [/^[a-z][a-z0-9_]{0,39}$/, 'Rule id must be a short slug'],
    },
    label: { type: String, required: true, trim: true, maxlength: 160 },
    when: {
      questionId: { type: String, required: true, trim: true },
      operator: {
        type: String,
        enum: ['answered', 'no_answer', 'equals', 'not_equals', 'includes_any', 'at_least', 'at_most'],
        required: true,
      },
      values: { type: [{ type: String, trim: true, maxlength: 120 }], default: [] },
      value: { type: Number },
    },
    action: { type: String, enum: ['queue_review'], required: true, default: 'queue_review' },
  },
  { _id: false }
);

const cadenceSchema = new mongoose.Schema(
  {
    // Days after the discharge date of the first check-in.
    startOffsetDays: { type: Number, required: true, min: 0, max: 180 },
    // Repeat interval in days (1 = daily).
    everyDays: { type: Number, required: true, min: 1, max: 90 },
    // How many days ahead slots are materialised (bounded).
    horizonDays: { type: Number, required: true, min: 1, max: 90 },
  },
  { _id: false }
);

const checkInTemplateVersionSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    key: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
      match: [/^[a-z][a-z0-9-]{1,39}$/, 'Template key must be a short slug'],
    },
    // Monotonic per (clinic, key).
    version: { type: Number, required: true, min: 1, immutable: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 500 },
    questions: {
      type: [questionSchema],
      required: true,
      validate: [(v) => v.length >= 1 && v.length <= 30, 'A template needs 1-30 questions'],
    },
    cadence: { type: cadenceSchema, required: true },
    // How long a due slot stays answerable before it is a missing response.
    // This is an operational window, never a clinical deadline.
    responseWindowHours: { type: Number, required: true, min: 1, max: 168, default: 24 },
    reviewRules: {
      type: [reviewRuleSchema],
      default: [],
      validate: [(v) => v.length <= 20, 'A template may carry at most 20 review rules'],
    },
    state: {
      type: String,
      enum: Object.values(CHECKIN_TEMPLATE_STATES),
      default: CHECKIN_TEMPLATE_STATES.DRAFT,
      required: true,
    },
    revision: { type: Number, default: 1, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdByLabel: { type: String, trim: true, maxlength: 254 },
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    activatedByLabel: { type: String, trim: true, maxlength: 254 },
    activatedAt: { type: Date },
    // The reviewer's explicit statement that the clinic's rules ask for
    // workflow attention and are not clinical interpretation.
    activationNote: { type: String, trim: true, maxlength: 500 },
    supersededAt: { type: Date },
    supersededByVersion: { type: Number },
  },
  { timestamps: true }
);

// One version number per clinic key, and exactly ONE active version per key.
checkInTemplateVersionSchema.index({ clinic: 1, key: 1, version: 1 }, { unique: true });
checkInTemplateVersionSchema.index(
  { clinic: 1, key: 1 },
  { unique: true, partialFilterExpression: { state: CHECKIN_TEMPLATE_STATES.ACTIVE } }
);
checkInTemplateVersionSchema.index({ clinic: 1, state: 1, key: 1 });

// Immutability: a definition may only change while the version is a DRAFT. The
// guard lives in the model, not only in the service, so a stray update path
// cannot rewrite wording a patient has already been asked.
const DEFINITION_PATHS = [
  'title',
  'description',
  'questions',
  'cadence',
  'responseWindowHours',
  'reviewRules',
];

checkInTemplateVersionSchema.pre('save', function preventFrozenEdit(next) {
  if (!this.isNew && this.state !== CHECKIN_TEMPLATE_STATES.DRAFT) {
    const touched = DEFINITION_PATHS.filter((path) => this.isModified(path));
    if (touched.length) {
      return next(
        new Error(
          `A ${this.state} check-in template version is frozen; create a new draft version instead (${touched.join(', ')}).`
        )
      );
    }
  }
  return next();
});

module.exports = mongoose.model('CheckInTemplateVersion', checkInTemplateVersionSchema);
