'use strict';

const mongoose = require('mongoose');

// Append-only history of draft discharge-date corrections. Rows are never
// updated or deleted. A no-op correction (same value) is NOT recorded, so a
// repeated request never produces duplicate history.
const episodeCorrectionSchema = new mongoose.Schema(
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
    field: {
      type: String,
      enum: ['discharge_date', 'discharge_timezone'],
      required: true,
      immutable: true,
    },
    previousValue: { type: String, maxlength: 64, immutable: true },
    newValue: { type: String, maxlength: 64, immutable: true },
    revisionBefore: { type: Number, required: true, immutable: true },
    revisionAfter: { type: Number, required: true, immutable: true },
    reason: { type: String, maxlength: 300 },
    actorUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
    actorLabel: { type: String, maxlength: 200, immutable: true },
    correctedAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

episodeCorrectionSchema.index({ clinic: 1, episode: 1, correctedAt: -1 });

// Guard the append-only invariant in the model itself.
episodeCorrectionSchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) return next(new Error('Episode corrections are append-only.'));
  return next();
});
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  episodeCorrectionSchema.pre(op, function preventMutation(next) {
    return next(new Error('Episode corrections are append-only.'));
  });
}

module.exports = mongoose.model('EpisodeCorrection', episodeCorrectionSchema);
