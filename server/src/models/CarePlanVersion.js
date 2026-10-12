'use strict';

const mongoose = require('mongoose');
const { ALL_STATES, STATES } = require('../policies/carePlanPolicy');

// One version of a manual care plan for one recovery episode. Versions are
// append-only in spirit: a new draft is a NEW version, and an approved version
// is never edited again - it is superseded by the next approval.
//
// `isCurrent` marks the one approved version a patient may see. The partial
// unique index below makes "two current approved versions" impossible at the
// database level, not merely in application code.
const carePlanVersionSchema = new mongoose.Schema(
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
    // Monotonic per episode, starting at 1. Immutable once written.
    version: { type: Number, required: true, min: 1, immutable: true },
    state: { type: String, enum: ALL_STATES, default: STATES.DRAFT, required: true },
    // Optimistic-concurrency counter for every draft edit and transition.
    revision: { type: Number, required: true, default: 1, min: 1 },
    // Coordinator-authored, non-clinical framing (optional).
    title: { type: String, trim: true, maxlength: 200 },
    summary: { type: String, trim: true, maxlength: 2000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    createdByLabel: { type: String, maxlength: 200 },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    // The reviewer who actually worked THIS version. Set by the first reviewer
    // decision (an item review or a clarification request) and refreshed on each
    // one, so the version itself answers "who reviewed it" without a join. The
    // approving actor is stored separately in `approvedBy`.
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewerLabel: { type: String, maxlength: 200 },
    reviewerAt: { type: Date },
    clarificationReason: { type: String, trim: true, maxlength: 500 },
    clarificationBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    clarificationByLabel: { type: String, maxlength: 200 },
    clarificationAt: { type: Date },
    // Set only by an approval transaction.
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedByLabel: { type: String, maxlength: 200 },
    approvedAt: { type: Date },
    isCurrent: { type: Boolean, default: false, required: true },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'CarePlanVersion' },
    supersededAt: { type: Date },
  },
  { timestamps: true }
);

// One version number per episode.
carePlanVersionSchema.index({ episode: 1, version: 1 }, { unique: true });
// At most ONE current approved version per episode (the approval invariant).
carePlanVersionSchema.index(
  { episode: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true, state: STATES.APPROVED } }
);
// Version history, newest first.
carePlanVersionSchema.index({ clinic: 1, episode: 1, version: -1 });
carePlanVersionSchema.index({ clinic: 1, patient: 1, state: 1 });

module.exports = mongoose.model('CarePlanVersion', carePlanVersionSchema);
