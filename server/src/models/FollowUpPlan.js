'use strict';

const mongoose = require('mongoose');

// A BASIC prescribed follow-up (Part 8).
//
// Scope is deliberately tiny: a follow-up is a DATE, a LOCATION, a CONTACT and an
// optional in-app REMINDER. That is the whole model, and the absence of any other
// field is the point - there is no test result, no report matching, no referral
// workflow and no place to record a clinical outcome, because none of those is
// implemented in this part.
//
// The wording the clinic writes is stored as authored and never interpreted: a
// follow-up says where to go and who to ask for, not what will be found there.
const followUpSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
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
    // The prescribed date, as a calendar date plus the zone it belongs to, so a
    // calendar date is never ambiguous across offsets. It stays MUTABLE: a clinic
    // legitimately reschedules an appointment, which is why `revision` bumps and
    // the audit log keeps every change.
    date: { type: String, required: true, trim: true, maxlength: 10 },
    timezone: { type: String, required: true, trim: true, maxlength: 64 },
    time: { type: String, trim: true, maxlength: 5 },
    // Rescheduling is a NEW revision of the same appointment, so the audit trail
    // shows what it was before rather than losing it.
    // Where to go, exactly as the clinic wrote it.
    location: { type: String, required: true, trim: true, maxlength: 200 },
    // Who to contact. A single contact line keeps this a scheduling record rather
    // than a directory.
    contactName: { type: String, trim: true, maxlength: 120 },
    contactPhone: { type: String, trim: true, maxlength: 40 },
    // Free-text instructions from the clinic, shown verbatim.
    note: { type: String, trim: true, maxlength: 500 },
    reminder: {
      enabled: { type: Boolean, default: true, required: true },
      localTime: { type: String, trim: true, maxlength: 5 },
      // How many local days before the appointment the in-app reminder appears.
      daysBefore: { type: Number, min: 0, max: 30, default: 1 },
    },
    status: {
      type: String,
      enum: ['scheduled', 'cancelled'],
      default: 'scheduled',
      required: true,
    },
    revision: { type: Number, default: 1, required: true, min: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdByLabel: { type: String, trim: true, maxlength: 254 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByLabel: { type: String, trim: true, maxlength: 254 },
    cancelledAt: { type: Date },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

followUpSchema.index({ clinic: 1, episode: 1, date: 1 });
followUpSchema.index({ clinic: 1, patient: 1, date: 1 });
followUpSchema.index({ clinic: 1, status: 1, date: 1 });

module.exports = mongoose.model('FollowUpPlan', followUpSchema);
