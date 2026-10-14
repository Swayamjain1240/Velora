'use strict';

// One recovery task derived from ONE approved, clinician-confirmed plan item
// (VEL-013). A task is the same lifecycle as a medication schedule but carries
// no dose: it is the "keep the dressing dry", "check temperature twice daily" or
// "walk for 10 minutes" instruction, copied verbatim from the approved item.
//
// A task whose approved wording states no timing stays `needs_details` and
// generates nothing - the wording is never embellished to make it schedulable.
const mongoose = require('mongoose');
const {
  SCHEDULE_TYPE,
  SCHEDULE_STATUS,
  ACTIVATION,
} = require('../policies/schedulePolicy');

const recoveryTaskSchema = new mongoose.Schema(
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
      enum: [SCHEDULE_TYPE.TASK],
      default: SCHEDULE_TYPE.TASK,
      required: true,
      immutable: true,
    },
    // The approved item kind this task came from (monitoring, home_care, ...).
    itemKind: { type: String, trim: true, maxlength: 40, required: true, immutable: true },
    title: { type: String, trim: true, maxlength: 200, required: true, immutable: true },
    // ---- verbatim clinical fields ------------------------------------------
    timing: { type: String, trim: true, maxlength: 200, immutable: true },
    frequency: { type: String, trim: true, maxlength: 120, immutable: true },
    condition: { type: String, trim: true, maxlength: 300, immutable: true },
    duration: { type: String, trim: true, maxlength: 120, immutable: true },
    originalWording: { type: String, trim: true, maxlength: 2000, required: true, immutable: true },
    // ---- generation inputs -------------------------------------------------
    scheduleKind: {
      type: String,
      enum: ['fixed', 'as_needed'],
      required: true,
      immutable: true,
    },
    conditional: { type: Boolean, default: false, required: true, immutable: true },
    conditionalReason: { type: String, maxlength: 120, immutable: true },
    timesOfDay: { type: [{ type: String }], default: [], immutable: true },
    timingDetail: { type: String, maxlength: 200, immutable: true },
    timezone: { type: String, trim: true, maxlength: 64, required: true, immutable: true },
    startDate: { type: Date, required: true, immutable: true },
    endDate: { type: Date, default: null },
    // How many local days ahead this task was generated for (bounded).
    horizonDays: { type: Number, required: true, default: 30, min: 1, max: 60, immutable: true },
    // ---- lifecycle ---------------------------------------------------------
    status: {
      type: String,
      enum: Object.values(SCHEDULE_STATUS),
      default: SCHEDULE_STATUS.NEEDS_DETAILS,
      required: true,
    },
    // A task is operational, not a clinical decision, so the coordinator who
    // prepared it may activate it. It is still an EXPLICIT, audited action.
    activationRequired: {
      type: String,
      enum: Object.values(ACTIVATION),
      default: ACTIVATION.OPERATIONAL,
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
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'RecoveryTask' },
    supersededAt: { type: Date },
  },
  { timestamps: true }
);

recoveryTaskSchema.index({ planVersion: 1, item: 1 }, { unique: true });
recoveryTaskSchema.index({ clinic: 1, patient: 1, status: 1, createdAt: -1 });
recoveryTaskSchema.index({ clinic: 1, episode: 1, status: 1 });

module.exports = mongoose.model('RecoveryTask', recoveryTaskSchema);
