'use strict';

const mongoose = require('mongoose');
const { QUEUE_KEYS, QUEUE_TARGETS } = require('../config/constants');

// An explicit assignment of ONE queue item to ONE accountable staff member
// (Part 8).
//
// The dashboard exists so nothing sits in an unowned queue, so ownership is a
// record rather than a convention:
//
//   * at most ONE active owner per item (a partial unique index, not a check in
//     application code), and
//   * releasing an item closes the interval instead of deleting it, so "who had
//     this, and when" survives - exactly like a care-team assignment.
//
// An item with no active assignment is what the "missing owners" queue lists, and
// that is a WORKFLOW fact about the team, never a clinical statement.
const queueAssignmentSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    queueKey: { type: String, enum: Object.values(QUEUE_KEYS), required: true, immutable: true },
    targetType: {
      type: String,
      enum: Object.values(QUEUE_TARGETS),
      required: true,
      immutable: true,
    },
    target: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', immutable: true },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'RecoveryEpisode', immutable: true },
    assigneeUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assigneeLabel: { type: String, trim: true, maxlength: 254 },
    status: { type: String, enum: ['active', 'released'], default: 'active', required: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedByLabel: { type: String, trim: true, maxlength: 254 },
    // Whether the owner took it themselves or someone put it on them - an
    // auditable difference in a care-team workflow.
    claimedBySelf: { type: Boolean, default: false, required: true },
    assignedAt: { type: Date, default: Date.now, required: true },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    releasedAt: { type: Date },
    releaseReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// One ACTIVE owner per queue item, enforced by the database.
queueAssignmentSchema.index(
  { clinic: 1, queueKey: 1, target: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);
queueAssignmentSchema.index({ clinic: 1, assigneeUser: 1, status: 1, assignedAt: -1 });
queueAssignmentSchema.index({ clinic: 1, queueKey: 1, status: 1 });
queueAssignmentSchema.index({ clinic: 1, patient: 1, status: 1 });

module.exports = mongoose.model('QueueAssignment', queueAssignmentSchema);
