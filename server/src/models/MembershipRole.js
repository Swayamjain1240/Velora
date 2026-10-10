'use strict';

const mongoose = require('mongoose');

// Clinic-scoped role definition, seeded from the system catalog on clinic
// creation. Permissions are copied from SYSTEM_ROLES and never client-editable,
// so a client can never escalate its own permission set.
const membershipRoleSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
      enum: ['admin', 'care_coordinator', 'clinical_reviewer'],
    },
    name: { type: String, required: true, maxlength: 120 },
    permissions: { type: [String], required: true },
    isSystem: { type: Boolean, default: true },
  },
  { timestamps: true }
);

membershipRoleSchema.index({ clinic: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('MembershipRole', membershipRoleSchema);
