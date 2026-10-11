'use strict';

const mongoose = require('mongoose');

// A clinic-scoped patient identity. The clinic scope is immutable: a profile
// can never be moved between clinics. A profile MAY link to a verified account
// (linkedUserId) but people are never auto-merged by name, phone or email.
const patientProfileSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      immutable: true,
    },
    // Human-facing, clinic-scoped reference (e.g. PT-4F2K9). Unique per clinic.
    reference: { type: String, required: true, trim: true, maxlength: 40 },
    fullName: { type: String, required: true, trim: true, maxlength: 200 },
    dateOfBirth: { type: Date },
    contactEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
    contactPhone: { type: String, trim: true, maxlength: 40 },
    status: {
      type: String,
      enum: ['draft', 'active', 'inactive'],
      default: 'draft',
    },
    // Explicit, verified account link. Never inferred from name/phone/email.
    linkedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    activatedAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Clinic-scoped identifier invariant (compound unique).
patientProfileSchema.index({ clinic: 1, reference: 1 }, { unique: true });
// One account links to at most ONE profile per clinic (no silent merging).
patientProfileSchema.index(
  { clinic: 1, linkedUserId: 1 },
  {
    unique: true,
    partialFilterExpression: { linkedUserId: { $type: 'objectId' } },
  }
);
patientProfileSchema.index({ clinic: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('PatientProfile', patientProfileSchema);
