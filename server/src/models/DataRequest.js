'use strict';

// A privacy request (Part 9, VEL-020).
//
// This is a WORKFLOW record, never an endpoint that destroys data on demand.
// Every request carries who asked, how identity was verified, who owns it, its
// status and deadline, the decision and reason, the execution evidence and any
// retention hold that limits the outcome.
//
// Payloads stay non-sensitive: a request records WHAT is being asked for and
// metadata about the subject, never raw clinical text.
const mongoose = require('mongoose');
const { DATA_REQUEST_TYPES, DATA_REQUEST_STATES, IDENTITY_METHODS } = require('../config/constants');

const transitionSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, maxlength: 60 },
    from: { type: String, maxlength: 40 },
    to: { type: String, required: true, maxlength: 40 },
    actorUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorLabel: { type: String, maxlength: 200 },
    note: { type: String, trim: true, maxlength: 500 },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const dataRequestSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    // Clinic-scoped human reference (e.g. DR-3K2M).
    reference: { type: String, required: true, trim: true, maxlength: 40, immutable: true },
    kind: { type: String, enum: DATA_REQUEST_TYPES, required: true, immutable: true },
    // The subject whose data the request is about. A patient request always sets
    // this to their OWN profile (derived server-side), never a client value.
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true, immutable: true },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'RecoveryEpisode', default: null, immutable: true },
    // ---- requester --------------------------------------------------------
    requesterUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    requesterLabel: { type: String, maxlength: 200 },
    requesterRole: { type: String, maxlength: 40, required: true, immutable: true },
    // Free-text description of what is being asked for. Bounded and plain text.
    detail: { type: String, trim: true, maxlength: 2000 },
    // For a correction request: the closed-shape change being requested.
    correction: { type: Object, default: null },
    // ---- identity verification -------------------------------------------
    identity: {
      status: {
        type: String,
        enum: ['pending', 'verified', 'refused'],
        default: 'pending',
      },
      method: { type: String, enum: [...IDENTITY_METHODS, null], default: null },
      note: { type: String, trim: true, maxlength: 300 },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      verifiedAt: { type: Date, default: null },
    },
    // ---- ownership / workflow --------------------------------------------
    ownerUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ownerLabel: { type: String, maxlength: 200 },
    state: { type: String, enum: Object.values(DATA_REQUEST_STATES), default: DATA_REQUEST_STATES.IDENTITY_PENDING },
    // Response deadline the clinic commits to (soft operational target).
    dueAt: { type: Date },
    decision: {
      outcome: { type: String, enum: ['approved', 'denied', null], default: null },
      reason: { type: String, trim: true, maxlength: 500 },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      label: { type: String, maxlength: 200 },
      at: { type: Date, default: null },
    },
    // Execution evidence: what was produced or why nothing could be. Never
    // contains clinical content.
    execution: {
      attemptedAt: { type: Date, default: null },
      result: { type: String, maxlength: 600 },
      exportArtifact: { type: mongoose.Schema.Types.ObjectId, ref: 'DataExport', default: null },
      appliedCorrection: { type: Object, default: null },
      // Retention holds / policies that limited the outcome.
      holds: { type: [Object], default: [] },
      limited: { type: Boolean, default: false },
    },
    // A redacted, defensible audit trail of the request's own transitions.
    history: { type: [transitionSchema], default: [] },
  },
  { timestamps: true }
);

dataRequestSchema.index({ clinic: 1, reference: 1 }, { unique: true });
dataRequestSchema.index({ clinic: 1, state: 1, createdAt: -1 });
dataRequestSchema.index({ clinic: 1, patient: 1, createdAt: -1 });
dataRequestSchema.index({ clinic: 1, ownerUser: 1, state: 1 });

module.exports = mongoose.model('DataRequest', dataRequestSchema);
