'use strict';

// One medication schedule derived from ONE approved, clinician-confirmed plan
// item (VEL-012). The schedule is a COPY of the approved clinical wording, taken
// verbatim at preparation time: the approved version stays the immutable source
// of truth and the schedule can never drift away from it unnoticed.
//
// Two shapes exist and they are not interchangeable:
//   - `fixed`: repeating daily wall times with generated occurrences;
//   - `as_needed`: a conditional/PRN medicine. NO occurrence is ever generated
//     for it, so it can never become an unconditional repeating dose.
const mongoose = require('mongoose');
const {
  SCHEDULE_TYPE,
  SCHEDULE_STATUS,
  ACTIVATION,
  OCCURRENCE_ORIGIN,
} = require('../policies/schedulePolicy');

const medicationScheduleSchema = new mongoose.Schema(
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
    // The EXACT approved version this schedule was prepared from. Immutable: a
    // new version produces a NEW schedule, never an edit of this one.
    planVersion: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarePlanVersion',
      required: true,
      immutable: true,
    },
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarePlanItem',
      required: true,
      immutable: true,
    },
    type: {
      type: String,
      enum: [SCHEDULE_TYPE.MEDICATION],
      default: SCHEDULE_TYPE.MEDICATION,
      required: true,
      immutable: true,
    },
    // ---- verbatim clinical fields (requirement 2) ---------------------------
    medicationName: { type: String, trim: true, maxlength: 200, immutable: true },
    dose: { type: String, trim: true, maxlength: 120, immutable: true },
    route: { type: String, trim: true, maxlength: 120, immutable: true },
    frequency: { type: String, trim: true, maxlength: 120, immutable: true },
    timing: { type: String, trim: true, maxlength: 200, immutable: true },
    condition: { type: String, trim: true, maxlength: 300, immutable: true },
    duration: { type: String, trim: true, maxlength: 120, immutable: true },
    originalWording: { type: String, trim: true, maxlength: 2000, required: true, immutable: true },
    // ---- generation inputs -------------------------------------------------
    scheduleKind: {
      type: String,
      enum: ['fixed', OCCURRENCE_ORIGIN.AS_NEEDED],
      required: true,
      immutable: true,
    },
    conditional: { type: Boolean, default: false, required: true, immutable: true },
    conditionalReason: { type: String, maxlength: 120, immutable: true },
    // Local wall times (HH:MM) in `timezone`. Empty for an as-needed medicine.
    timesOfDay: { type: [{ type: String }], default: [], immutable: true },
    timingDetail: { type: String, maxlength: 200, immutable: true },
    // Explicit IANA scheduling timezone (requirement 5). Every occurrence
    // instant is computed in this zone and stored as UTC.
    timezone: { type: String, trim: true, maxlength: 64, required: true, immutable: true },
    startDate: { type: Date, required: true, immutable: true },
    endDate: { type: Date, default: null },
    // How many local days ahead this schedule was generated for (bounded).
    horizonDays: { type: Number, required: true, default: 30, min: 1, max: 60, immutable: true },
    // ---- lifecycle ---------------------------------------------------------
    status: {
      type: String,
      enum: Object.values(SCHEDULE_STATUS),
      default: SCHEDULE_STATUS.NEEDS_DETAILS,
      required: true,
    },
    // A medication schedule is patient-visible only after a verified clinical
    // reviewer activates it (requirement 8).
    activationRequired: {
      type: String,
      enum: Object.values(ACTIVATION),
      default: ACTIVATION.CLINICAL_REVIEWER,
      required: true,
      immutable: true,
    },
    needsDetailsReason: { type: String, maxlength: 200 },
    revision: { type: Number, required: true, default: 1, min: 1 },
    generatedCount: { type: Number, default: 0, min: 0 },
    generatedThrough: { type: Date, default: null },
    preparedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    preparedByLabel: { type: String, maxlength: 200 },
    preparedAt: { type: Date, default: Date.now, required: true },
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    activatedByLabel: { type: String, maxlength: 200 },
    activatedAt: { type: Date },
    endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    endedAt: { type: Date },
    endedReason: { type: String, trim: true, maxlength: 300 },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicationSchedule' },
    supersededAt: { type: Date },
  },
  { timestamps: true }
);

// One schedule per (approved version, item): preparing twice is idempotent
// rather than duplicating medication rows.
medicationScheduleSchema.index({ planVersion: 1, item: 1 }, { unique: true });
medicationScheduleSchema.index({ clinic: 1, patient: 1, status: 1, createdAt: -1 });
medicationScheduleSchema.index({ clinic: 1, episode: 1, status: 1 });

module.exports = mongoose.model('MedicationSchedule', medicationScheduleSchema);
