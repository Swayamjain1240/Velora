'use strict';

const mongoose = require('mongoose');

// A recovery episode is one hospitalization for one patient. Every episode gets
// a distinct immutable identity (`clinic` + `patient` + clinic-scoped
// `reference`); none of the three can ever change, so an episode can never be
// moved between clinics or patients. `revision` is the optimistic-concurrency
// counter for draft discharge-date corrections (Part 3).
const recoveryEpisodeSchema = new mongoose.Schema(
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
    // Human-facing, clinic-scoped reference (e.g. EP-4F2K9Q). Unique per clinic.
    reference: { type: String, required: true, trim: true, maxlength: 40, immutable: true },
    // Episodes start conservatively. Activation of downstream workflow is tied
    // to clinically approved plans (Part 5), so only `draft` is reachable today.
    status: { type: String, enum: ['draft', 'active', 'closed'], default: 'draft' },
    dischargeDate: { type: Date, required: true },
    // Explicit IANA timezone for the discharge date, so a calendar date is never
    // ambiguous across offsets.
    dischargeTimezone: { type: String, required: true, trim: true, maxlength: 64 },
    // Monotonic revision for optimistic concurrency on draft corrections.
    revision: { type: Number, required: true, default: 1, min: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
  },
  { timestamps: true }
);

// Clinic-scoped identifier invariant.
recoveryEpisodeSchema.index({ clinic: 1, reference: 1 }, { unique: true });
// "Episodes for this patient, newest first" and scoped listings.
recoveryEpisodeSchema.index({ clinic: 1, patient: 1, createdAt: -1 });
recoveryEpisodeSchema.index({ clinic: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('RecoveryEpisode', recoveryEpisodeSchema);
