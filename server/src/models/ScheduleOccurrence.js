'use strict';

// ONE due slot of one medication schedule or recovery task (Part 7).
//
// An occurrence is a generated FACT about timing, never about adherence. It has
// no `taken`/`missed` column: the recorded state lives in the append-only
// ActivityLog, and "nothing recorded" is the absence of a log rather than a
// value that could be mistaken for a missed dose.
//
// Instants are stored in UTC (requirement 4); the local calendar date/time and
// offset that produced them are kept alongside so a day view can be answered
// without re-deriving the zone, and so a DST boundary stays auditable.
const mongoose = require('mongoose');
const { OCCURRENCE_STATUS, OCCURRENCE_ORIGIN } = require('../policies/schedulePolicy');

const scheduleOccurrenceSchema = new mongoose.Schema(
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
    ownerType: {
      type: String,
      enum: ['medication', 'task'],
      required: true,
      immutable: true,
    },
    // The MedicationSchedule or RecoveryTask id (exactly one of the two, chosen
    // by `ownerType`). A single field keeps the uniqueness guarantee exact.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },
    origin: {
      type: String,
      enum: Object.values(OCCURRENCE_ORIGIN),
      default: OCCURRENCE_ORIGIN.SCHEDULED,
      required: true,
      immutable: true,
    },
    scheduledAtUtc: { type: Date, required: true, immutable: true },
    localDate: { type: String, required: true, maxlength: 10, immutable: true },
    localTime: { type: String, required: true, maxlength: 5, immutable: true },
    timezone: { type: String, trim: true, maxlength: 64, required: true, immutable: true },
    offset: { type: String, maxlength: 8, immutable: true },
    status: {
      type: String,
      enum: Object.values(OCCURRENCE_STATUS),
      default: OCCURRENCE_STATUS.SCHEDULED,
      required: true,
    },
    statusReason: { type: String, maxlength: 200 },
    supersededByVersion: { type: mongoose.Schema.Types.ObjectId, ref: 'CarePlanVersion' },
    endedAt: { type: Date },
  },
  { timestamps: true }
);

// A generated slot is unique per owner: re-running generation can never create a
// duplicate due time (the retry/idempotency guard, control #8).
scheduleOccurrenceSchema.index({ owner: 1, scheduledAtUtc: 1 }, { unique: true });
// The day view: "occurrences of this patient on this local date".
scheduleOccurrenceSchema.index({ clinic: 1, patient: 1, localDate: 1, scheduledAtUtc: 1 });
// Reconciliation: "future scheduled occurrences of this schedule".
scheduleOccurrenceSchema.index({ owner: 1, status: 1, scheduledAtUtc: 1 });
scheduleOccurrenceSchema.index({ clinic: 1, episode: 1, scheduledAtUtc: -1 });

module.exports = mongoose.model('ScheduleOccurrence', scheduleOccurrenceSchema);
