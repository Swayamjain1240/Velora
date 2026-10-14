'use strict';

const mongoose = require('mongoose');
const { DELIVERY_OUTCOMES } = require('../config/constants');

// One delivery try for one notification (Part 8).
//
// Every try is recorded, including the ones that never reached a provider, and
// each record keeps the RECHECK that was performed immediately before delivery:
// the episode state, the approved version, the task's relevance and the
// recipient's authorization. That is what makes a failure VISIBLE and
// diagnosable instead of a silently dropped reminder (control #8).
//
// Attempts are append-only: history is never rewritten, so "we tried three times"
// is a fact rather than a claim.
const deliveryAttemptSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    notification: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notification',
      required: true,
      immutable: true,
    },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'RecoveryEpisode', immutable: true },
    attempt: { type: Number, required: true, min: 1, immutable: true },
    channel: { type: String, required: true, trim: true, maxlength: 40, immutable: true },
    // The provider that was asked to deliver it ('in_app', 'fake', ...).
    provider: { type: String, required: true, trim: true, maxlength: 60, immutable: true },
    outcome: { type: String, enum: Object.values(DELIVERY_OUTCOMES), required: true },
    // Safe, non-clinical reason. A failure is a delivery problem.
    reason: { type: String, trim: true, maxlength: 300 },
    errorCode: { type: String, trim: true, maxlength: 60 },
    durationMs: { type: Number, min: 0 },
    // What was checked immediately before this try. `false` refuses the try.
    checks: {
      episodeOpen: { type: Boolean, required: true },
      versionCurrent: { type: Boolean, required: true },
      taskRelevant: { type: Boolean, required: true },
      recipientAuthorized: { type: Boolean, required: true },
    },
    // The wording the recipient would see, kept with the attempt so a later
    // template change cannot rewrite what was sent.
    renderedBody: { type: String, trim: true, maxlength: 600 },
    at: { type: Date, default: Date.now, required: true, immutable: true },
  },
  { timestamps: true }
);

deliveryAttemptSchema.index({ notification: 1, attempt: 1 }, { unique: true });
deliveryAttemptSchema.index({ clinic: 1, at: -1 });
deliveryAttemptSchema.index({ clinic: 1, outcome: 1, at: -1 });

deliveryAttemptSchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) return next(new Error('Delivery attempts are append-only.'));
  return next();
});
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]) {
  deliveryAttemptSchema.pre(op, function preventMutation(next) {
    return next(new Error('Delivery attempts are append-only.'));
  });
}

module.exports = mongoose.model('DeliveryAttempt', deliveryAttemptSchema);
