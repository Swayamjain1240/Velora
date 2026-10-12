'use strict';

const mongoose = require('mongoose');
const { ITEM_KINDS, ITEM_REVIEW_STATES } = require('../policies/carePlanPolicy');

// One clinical instruction inside a plan version. The ORIGINAL clinical wording
// is preserved verbatim (`originalWording`) and never rewritten; the structured
// fields exist so a reviewer can see exactly what was stated. Nothing is
// derived: an absent or ambiguous field stays absent and is reported as
// unresolved by the policy module.
const carePlanItemSchema = new mongoose.Schema(
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
    // Display order inside the version (1-based, contiguous with small gaps).
    order: { type: Number, required: true, min: 1 },
    kind: { type: String, enum: ITEM_KINDS, default: 'instruction', required: true },
    // The clinical text as written at the source, preserved exactly.
    originalWording: { type: String, trim: true, maxlength: 2000, required: true },
    medication: { type: String, trim: true, maxlength: 200 },
    dose: { type: String, trim: true, maxlength: 120 },
    route: { type: String, trim: true, maxlength: 120 },
    frequency: { type: String, trim: true, maxlength: 120 },
    timing: { type: String, trim: true, maxlength: 200 },
    duration: { type: String, trim: true, maxlength: 120 },
    condition: { type: String, trim: true, maxlength: 300 },
    homeCare: { type: String, trim: true, maxlength: 500 },
    dietActivity: { type: String, trim: true, maxlength: 500 },
    followUp: { type: String, trim: true, maxlength: 500 },
    warning: { type: String, trim: true, maxlength: 500 },
    // Server-computed by carePlanPolicy.computeUnresolvedFields on every write.
    unresolvedFields: { type: [String], default: [] },
    clinicalReviewState: {
      type: String,
      enum: Object.values(ITEM_REVIEW_STATES),
      default: ITEM_REVIEW_STATES.PENDING,
      required: true,
    },
    reviewNote: { type: String, trim: true, maxlength: 500 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByLabel: { type: String, maxlength: 200 },
    reviewedAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

carePlanItemSchema.index({ version: 1, order: 1 });
carePlanItemSchema.index({ clinic: 1, episode: 1, version: 1 });

module.exports = mongoose.model('CarePlanItem', carePlanItemSchema);
