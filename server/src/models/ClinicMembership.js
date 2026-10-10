'use strict';

const mongoose = require('mongoose');

// Membership ties a User to one Clinic with a role. Reviewer eligibility is a
// SEPARATE verified attribute: holding the clinical_reviewer role without a
// verified eligibility flag grants no review/approval authority, and an admin
// cannot verify eligibility alone (VEL-002 boundary: not self-grantable).
const clinicMembershipSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
    },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    roleKey: {
      type: String,
      required: true,
      enum: ['admin', 'care_coordinator', 'clinical_reviewer'],
    },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    reviewerEligibility: {
      status: {
        type: String,
        enum: ['not_applicable', 'pending', 'verified'],
        default: 'not_applicable',
      },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      verifiedAt: { type: Date },
    },
  },
  { timestamps: true }
);

clinicMembershipSchema.index({ clinic: 1, user: 1 }, { unique: true });
clinicMembershipSchema.index({ clinic: 1, status: 1 });

module.exports = mongoose.model('ClinicMembership', clinicMembershipSchema);
