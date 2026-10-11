'use strict';

const mongoose = require('mongoose');

// Explicit, granular caregiver access to ONE patient. Scopes are additive but
// never implicit: holding `view_profile` grants nothing else. A grant is
// inactive until the invitee accepts the invitation, and revocation takes
// effect immediately. A caregiver can never hold clinical approval rights.
const caregiverGrantSchema = new mongoose.Schema(
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
    caregiverUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    granteeEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
    scopes: { type: [{ type: String }], default: [] },
    status: {
      type: String,
      enum: ['pending', 'active', 'revoked', 'expired'],
      default: 'pending',
    },
    // Who authorised the grant: the patient owner, or clinic staff on their behalf.
    grantedByRole: { type: String, enum: ['patient', 'staff'], required: true },
    grantedByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    invitation: { type: mongoose.Schema.Types.ObjectId, ref: 'AccessInvitation' },
    acceptedAt: { type: Date },
    expiresAt: { type: Date },
    revokedByRole: { type: String, enum: ['patient', 'staff'] },
    revokedByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

// At most one ACTIVE grant per (clinic, patient, caregiver). Pending grants are
// separate rows so an invitee can be re-invited after revocation.
caregiverGrantSchema.index(
  { clinic: 1, patient: 1, caregiverUser: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);
caregiverGrantSchema.index({ clinic: 1, patient: 1, status: 1, createdAt: -1 });
caregiverGrantSchema.index({ caregiverUser: 1, status: 1 });

// A grant is only usable while active AND unexpired. Expiry is evaluated at
// read time so a stale row can never authorise a request.
caregiverGrantSchema.methods.isUsable = function isUsable(now = new Date()) {
  return this.status === 'active' && (!this.expiresAt || this.expiresAt > now);
};

module.exports = mongoose.model('CaregiverGrant', caregiverGrantSchema);
