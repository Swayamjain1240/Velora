'use strict';

const mongoose = require('mongoose');

// Single-use, expiring invitation token stored ONLY as a peppered hash. Two
// kinds share the mechanism: 'caregiver' grants scoped access on acceptance,
// 'patient_activation' links and activates a patient's own account.
const accessInvitationSchema = new mongoose.Schema(
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
    kind: {
      type: String,
      enum: ['caregiver', 'patient_activation'],
      required: true,
      immutable: true,
    },
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    scopes: { type: [{ type: String }], default: [] },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date },
    acceptedByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
    // Explicit flag rather than testing null dates: a partial unique index on a
    // boolean is unambiguous, including for documents created before any accept.
    outstanding: { type: Boolean, default: true },
    invitedByRole: { type: String, enum: ['patient', 'staff'], required: true },
    invitedByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

accessInvitationSchema.index({ tokenHash: 1 }, { unique: true });
// At most one OUTSTANDING invitation per (clinic, patient, email, kind).
accessInvitationSchema.index(
  { clinic: 1, patient: 1, email: 1, kind: 1 },
  { unique: true, partialFilterExpression: { outstanding: true } }
);
accessInvitationSchema.index({ clinic: 1, patient: 1, createdAt: -1 });

module.exports = mongoose.model('AccessInvitation', accessInvitationSchema);
