'use strict';

const mongoose = require('mongoose');

// Care-team membership for one recovery episode. Assignments are intervals,
// never deleted: revoking ends the current interval, and re-assigning opens a
// new one, so the full history is preserved.
const careTeamAssignmentSchema = new mongoose.Schema(
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
    membership: { type: mongoose.Schema.Types.ObjectId, ref: 'ClinicMembership' },
    memberUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      immutable: true,
    },
    // The two care-team responsibilities. A clinical reviewer additionally had
    // to hold current VERIFIED eligibility at assignment time.
    responsibility: {
      type: String,
      enum: ['care_coordinator', 'clinical_reviewer'],
      required: true,
    },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedByRole: { type: String, enum: ['staff', 'admin'] },
    assignedAt: { type: Date, default: Date.now },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

// At most ONE active interval per (episode, member). A partial unique index
// makes duplicate parallel assignment impossible at the database level, not
// merely in application code.
careTeamAssignmentSchema.index(
  { clinic: 1, episode: 1, memberUser: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);
careTeamAssignmentSchema.index({ clinic: 1, episode: 1, status: 1 });
careTeamAssignmentSchema.index({ memberUser: 1, status: 1 });

module.exports = mongoose.model('CareTeamAssignment', careTeamAssignmentSchema);
