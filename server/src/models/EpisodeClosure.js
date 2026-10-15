'use strict';

// One closure/reopen event for one recovery episode (Part 9, VEL-019).
//
// Closure is an OPERATIONAL archive state. It is never a clinical statement and
// never means medically recovered; the model deliberately has no field that
// could carry a diagnosis or outcome.
//
// Each row records WHO closed or reopened the episode, WHEN, WHY, which
// clinic-policy checks were confirmed, and the preflight snapshot that was
// visible at that moment. Rows are append-only: a reopen appends a NEW row (the
// earlier closure is never edited), so the closure history cannot be rewritten.
const mongoose = require('mongoose');
const { CLOSURE_POLICY_CHECKS, CLOSURE_STATES } = require('../config/constants');

const policyCheckSchema = new mongoose.Schema(
  {
    key: { type: String, enum: CLOSURE_POLICY_CHECKS, required: true },
    confirmed: { type: Boolean, required: true },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { _id: false }
);

const preflightItemSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, maxlength: 60 },
    label: { type: String, maxlength: 160 },
    count: { type: Number, min: 0, default: 0 },
    blocking: { type: Boolean, default: false },
  },
  { _id: false }
);

const episodeClosureSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'RecoveryEpisode', required: true, immutable: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', immutable: true },
    // What this row DID: closed the episode, or reopened it.
    action: { type: String, enum: ['close', 'reopen'], required: true, immutable: true },
    // The resulting operational state.
    state: { type: String, enum: Object.values(CLOSURE_STATES), required: true, immutable: true },
    reason: { type: String, trim: true, maxlength: 500, required: true, immutable: true },
    // The operational closure date the clinic records (a calendar date), distinct
    // from the createdAt instant.
    closureDate: { type: Date, immutable: true },
    actorUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    actorLabel: { type: String, maxlength: 200, immutable: true },
    actorRole: { type: String, maxlength: 40, immutable: true },
    // The assignment that authorised the transition, re-derived server-side.
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'CareTeamAssignment', default: null, immutable: true },
    policyChecks: { type: [policyCheckSchema], default: [] },
    preflight: { type: [preflightItemSchema], default: [] },
    // A blocking preflight item cleared with an explicit, recorded justification.
    overrides: { type: [Object], default: [] },
    // The episode revision the actor acted on, so a concurrent close is visible.
    episodeRevision: { type: Number, required: true, min: 1, immutable: true },
    // What the closure stopped (future schedules/reminders), recorded as evidence
    // rather than as an implied deletion.
    stopped: { type: Object, default: {} },
    ip: { type: String },
    userAgent: { type: String, maxlength: 400 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

episodeClosureSchema.index({ clinic: 1, episode: 1, createdAt: -1 });
episodeClosureSchema.index({ clinic: 1, actorUser: 1, createdAt: -1 });

episodeClosureSchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) return next(new Error('Closure events are append-only.'));
  return next();
});
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  episodeClosureSchema.pre(op, function preventMutation(next) {
    return next(new Error('Closure events are append-only.'));
  });
}

module.exports = mongoose.model('EpisodeClosure', episodeClosureSchema);
