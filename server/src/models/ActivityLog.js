'use strict';

// Append-only record of what one ACTOR said happened to one occurrence
// (Part 7, VEL-012/VEL-013). This is the only place adherence-shaped facts live,
// and every row answers the five questions the requirements demand:
//
//   patient subject  -> `patient`
//   acting user      -> `actorUser`
//   actor role/grant -> `actorRole` and `actorGrant` (a caregiver's grant id)
//   occurrence time  -> `occurrenceTimeUtc` (the instant the entry is ABOUT)
//   recorded-at time -> `recordedAtUtc` (the instant it was RECORDED)
//
// A correction APPENDS a new row that names the row it corrects (`correctsLog`).
// The original row is never edited or deleted, so patient history cannot be
// silently rewritten. There is deliberately no update hook exemption: the model
// refuses every mutation path.
const mongoose = require('mongoose');
const { ENTRY_STATE_VALUES } = require('../policies/schedulePolicy');

const activityLogSchema = new mongoose.Schema(
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
    ownerType: { type: String, enum: ['medication', 'task'], required: true, immutable: true },
    owner: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    occurrence: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ScheduleOccurrence',
      required: true,
      immutable: true,
    },
    entryState: { type: String, enum: ENTRY_STATE_VALUES, required: true, immutable: true },
    note: { type: String, trim: true, maxlength: 500, immutable: true },
    // ---- attribution -------------------------------------------------------
    actorUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    actorLabel: { type: String, maxlength: 200, immutable: true },
    actorRole: { type: String, maxlength: 40, required: true, immutable: true },
    // The CaregiverGrant that authorised a caregiver entry. Null for a patient
    // or staff actor, so a caregiver's authority is provable after the fact.
    actorGrant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CaregiverGrant',
      default: null,
      immutable: true,
    },
    // ---- the two instants --------------------------------------------------
    occurrenceTimeUtc: { type: Date, required: true, immutable: true },
    recordedAtUtc: { type: Date, default: Date.now, required: true, immutable: true },
    // Server-visible client idempotency key: a retried submission returns the
    // original entry instead of appending a second one.
    clientRequestId: { type: String, required: true, maxlength: 100, immutable: true },
    // ---- correction chain --------------------------------------------------
    correctsLog: { type: mongoose.Schema.Types.ObjectId, ref: 'ActivityLog', default: null, immutable: true },
    correctionReason: { type: String, trim: true, maxlength: 300, immutable: true },
    sequence: { type: Number, required: true, min: 1, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One entry per (clinic, clientRequestId): a duplicate retry is idempotent.
activityLogSchema.index({ clinic: 1, clientRequestId: 1 }, { unique: true });
// History for one occurrence, oldest first (the correction chain).
activityLogSchema.index({ occurrence: 1, sequence: 1 });
// "Everything recorded for this patient, newest first".
activityLogSchema.index({ clinic: 1, patient: 1, recordedAtUtc: -1 });
activityLogSchema.index({ clinic: 1, episode: 1, recordedAtUtc: -1 });

activityLogSchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) return next(new Error('Activity log entries are append-only.'));
  return next();
});
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  activityLogSchema.pre(op, function preventMutation(next) {
    return next(new Error('Activity log entries are append-only.'));
  });
}

module.exports = mongoose.model('ActivityLog', activityLogSchema);
