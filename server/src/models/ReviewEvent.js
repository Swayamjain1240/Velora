'use strict';

const mongoose = require('mongoose');

// Append-only review timeline for one plan version. Rows are never updated or
// deleted; the hooks below refuse both, so a history cannot be rewritten by any
// code path.
//
// Auditing rule (controls #9, #19): a review event records WHO, WHEN, WHICH
// TRANSITION and a bounded human REASON - never the clinical text itself. Raw
// clinical wording belongs in the item, not in the audit trail.
const reviewEventSchema = new mongoose.Schema(
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
    action: {
      type: String,
      enum: [
        'created',
        'submitted',
        'clarification_requested',
        'resubmitted',
        'approved',
        'superseded',
        'item_accepted',
        'item_clarification_requested',
      ],
      required: true,
      immutable: true,
    },
    actorUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    actorLabel: { type: String, maxlength: 200, immutable: true },
    actorRole: { type: String, maxlength: 40, immutable: true },
    stateBefore: { type: String, maxlength: 40, immutable: true },
    stateAfter: { type: String, maxlength: 40, immutable: true },
    revisionBefore: { type: Number, immutable: true },
    revisionAfter: { type: Number, immutable: true },
    // Bounded, non-clinical reason/note (a clarification reason or item note).
    reason: { type: String, trim: true, maxlength: 500, immutable: true },
    at: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: true }
);

// Guard the append-only invariant inside the model so no code path can rewrite
// the history.
reviewEventSchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) return next(new Error('Review events are append-only.'));
  return next();
});
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  reviewEventSchema.pre(op, function preventMutation(next) {
    return next(new Error('Review events are append-only.'));
  });
}

reviewEventSchema.index({ clinic: 1, episode: 1, at: -1 });
reviewEventSchema.index({ version: 1, at: 1 });

module.exports = mongoose.model('ReviewEvent', reviewEventSchema);
