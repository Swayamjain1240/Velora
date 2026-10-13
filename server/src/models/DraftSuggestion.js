'use strict';

const mongoose = require('mongoose');
const { SUGGESTION_STATES } = require('../policies/extractionPolicy');

// One proposed clinical item produced by an extraction job. A suggestion is
// NEVER clinical content: it is a proposal that a coordinator must review and
// APPLY as a separate, actor-attributed draft edit. Applying is the only path
// from a suggestion into a plan, and it goes through the ordinary Part 5 draft
// service - so the suggestion itself can never approve, publish or prescribe.
//
// The verbatim original wording is preserved (`originalWording`, copied from the
// source text), and the per-field outcome lives in ExtractedField rows so a
// missing or conflicting field stays visible and unresolved.
const draftSuggestionSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      immutable: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientProfile',
      required: true,
      immutable: true,
    },
    episode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecoveryEpisode',
      required: true,
      immutable: true,
    },
    version: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarePlanVersion',
      required: true,
      immutable: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExtractionJob',
      required: true,
      immutable: true,
    },
    // Stable ordering inside the job.
    order: { type: Number, required: true, min: 1 },
    kind: { type: String, required: true, maxlength: 32 },
    // The exact source wording the model quoted, preserved and never rewritten.
    originalWording: { type: String, required: true, maxlength: 2000, immutable: true },
    // Fields the server judged unsupported, absent, unclear or conflicting. This
    // list - not the model's confidence - is what blocks a clean auto-approval.
    unresolvedFields: { type: [String], default: [] },
    // Fields the source did not state at all, INCLUDING optional ones. Reported
    // so a reviewer can see what the document is silent about; only the required
    // subset also appears in `unresolvedFields`.
    missingFields: { type: [String], default: [] },
    fieldStates: {
      type: [
        {
          field: { type: String, maxlength: 40 },
          state: { type: String, maxlength: 20 },
        },
      ],
      default: [],
    },
    confidence: { type: Number, min: 0, max: 1 },
    citationCount: { type: Number, default: 0, min: 0 },
    // Set when the supporting text carried a prompt-injection signal, so this
    // suggestion can never be presented as a clean, one-click accept.
    injectionSuspected: { type: Boolean, default: false },
    state: {
      type: String,
      enum: Object.values(SUGGESTION_STATES),
      default: SUGGESTION_STATES.PROPOSED,
      required: true,
    },
    needsReview: { type: Boolean, default: true },
    // The draft item this suggestion became, when a coordinator applied it.
    appliedItem: { type: mongoose.Schema.Types.ObjectId, ref: 'CarePlanItem' },
    appliedRevision: { type: Number },
    appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    appliedByLabel: { type: String, maxlength: 200 },
    appliedAt: { type: Date },
    dismissedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    dismissedByLabel: { type: String, maxlength: 200 },
    dismissedAt: { type: Date },
    dismissReason: { type: String, maxlength: 300 },
    reviewNote: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

// One order per job.
draftSuggestionSchema.index({ job: 1, order: 1 }, { unique: true });
draftSuggestionSchema.index({ clinic: 1, episode: 1, version: 1, state: 1 });
// A suggestion can never be applied twice.
draftSuggestionSchema.index(
  { appliedItem: 1 },
  { unique: true, partialFilterExpression: { appliedItem: { $exists: true } } }
);

module.exports = mongoose.model('DraftSuggestion', draftSuggestionSchema);
