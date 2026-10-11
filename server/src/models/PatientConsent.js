'use strict';

const mongoose = require('mongoose');

// Append-only consent history. Rows are never updated or deleted; a change of
// consent appends a new row that supersedes the previous one. Every row records
// the actor, the time and the purpose (VEL invariant: consent is auditable).
const patientConsentSchema = new mongoose.Schema(
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
    // 'granted' begins consent; 'updated' changes categories; 'withdrawn' ends it.
    action: {
      type: String,
      enum: ['granted', 'updated', 'withdrawn'],
      required: true,
      immutable: true,
    },
    purpose: { type: String, required: true, trim: true, maxlength: 200 },
    categories: {
      type: [{ type: String, enum: ['care_coordination', 'caregiver_access', 'future_ai_assistance'] }],
      default: [],
    },
    actorUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
    actorLabel: { type: String, maxlength: 200, immutable: true },
    note: { type: String, maxlength: 500 },
    recordedAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

patientConsentSchema.index({ clinic: 1, patient: 1, recordedAt: -1 });

// Guard the append-only invariant in the model itself so no code path can
// silently mutate or remove a consent record.
patientConsentSchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) return next(new Error('Consent records are append-only.'));
  return next();
});
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  patientConsentSchema.pre(op, function preventMutation(next) {
    return next(new Error('Consent records are append-only.'));
  });
}

module.exports = mongoose.model('PatientConsent', patientConsentSchema);
