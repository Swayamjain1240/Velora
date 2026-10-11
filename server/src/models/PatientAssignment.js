'use strict';

const mongoose = require('mongoose');

// Intake assignment: which staff member is responsible for a patient's intake
// within a clinic. This is the ONLY thing that lets staff read or write a
// patient record - clinic membership alone is not enough (control #5).
// Assignments are never deleted: revoking ends the interval, preserving history.
const patientAssignmentSchema = new mongoose.Schema(
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
    membership: { type: mongoose.Schema.Types.ObjectId, ref: 'ClinicMembership' },
    memberUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['intake'], default: 'intake' },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedAt: { type: Date, default: Date.now },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

// At most ONE active intake assignment per (clinic, patient, member). A partial
// unique index makes duplicate parallel assignment impossible at the database
// level, not merely in application code.
patientAssignmentSchema.index(
  { clinic: 1, patient: 1, memberUser: 1, kind: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);
// Fast "can this user read this patient" lookup.
patientAssignmentSchema.index({ clinic: 1, patient: 1, status: 1 });
patientAssignmentSchema.index({ memberUser: 1, status: 1 });

module.exports = mongoose.model('PatientAssignment', patientAssignmentSchema);
