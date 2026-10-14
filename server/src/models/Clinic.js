'use strict';

const mongoose = require('mongoose');

// Response hours are CLINIC-DEFINED and shown next to every question/check-in.
// `monitoredContinuously` defaults to FALSE and must be set explicitly by the
// clinic: the product must never imply that an unstaffed queue is watched, so
// "no" is the safe default and the UI wording derives from it (control #5).
const responseHoursSchema = new mongoose.Schema(
  {
    // Human-readable summary, e.g. "Mon-Fri 09:00-17:00 (clinic time)".
    display: { type: String, trim: true, maxlength: 200 },
    // The zone the hours are stated in; validated with Intl on write.
    timezone: { type: String, trim: true, maxlength: 64 },
    weekdays: { type: String, trim: true, maxlength: 120 },
    from: { type: String, trim: true, match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'] },
    to: { type: String, trim: true, match: [/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'] },
    monitoredContinuously: { type: Boolean, default: false, required: true },
  },
  { _id: false }
);

const emergencyInstructionsSchema = new mongoose.Schema(
  {
    display: { type: String, trim: true, maxlength: 500 },
    contactPhone: { type: String, trim: true, maxlength: 40 },
  },
  { _id: false }
);

// Clinic is the tenant root. Every clinical record in later parts carries an
// immutable clinic reference derived server-side, never client-supplied.
const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    // Public, clinic-scoped reference used in URLs instead of raw ids.
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z0-9-]{6,24}$/, 'Invalid clinic code'],
    },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    // Part 8: published response hours and emergency guidance for the
    // clarification/check-in surfaces.
    responseHours: { type: responseHoursSchema, default: undefined },
    emergencyInstructions: { type: emergencyInstructionsSchema, default: undefined },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Clinic', clinicSchema);
