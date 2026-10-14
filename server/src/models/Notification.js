'use strict';

const mongoose = require('mongoose');
const {
  NOTIFICATION_STATES,
  NOTIFICATION_CHANNELS,
} = require('../config/constants');

// One queued reminder (VEL-014, Part 8).
//
// Reminders are IN-APP first: the shipped provider records that the reminder is
// available in the patient's own queue and needs no key, no external service and
// no disclosure. Email/SMS/WhatsApp/push require their own provider disclosure
// before they may deliver anything, and the provider registry is what refuses
// them until that happens (control #22).
//
// Two facts are deliberately separate:
//
//   * `state: delivered` means the provider accepted the reminder - it does not
//     mean a person read it. `acknowledgedAt` is only ever set by an explicit
//     human acknowledgement, and the wording the UI shows says so.
//   * `dedupeKey` makes a duplicate reminder for the same recipient, event and
//     channel impossible at the database level, so a retry cannot spam.
//
// Nothing here states or implies a dose, a result or a clinical finding. A failed
// reminder is a DELIVERY problem and the record says exactly that.
const notificationSchema = new mongoose.Schema(
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
    kind: {
      type: String,
      // Deliberately a closed list of OPERATIONAL events. There is no
      // "clinical alert" kind and no way to express one.
      enum: ['check_in_due', 'task_due', 'medication_due', 'follow_up', 'question_reply', 'system'],
      required: true,
      immutable: true,
    },
    channel: {
      type: String,
      enum: NOTIFICATION_CHANNELS,
      default: 'in_app',
      required: true,
      immutable: true,
    },
    // Recipient + event/version + channel, hashed by the policy. Unique per
    // clinic, which is what makes de-duplication structural.
    dedupeKey: { type: String, required: true, immutable: true, maxlength: 300 },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, required: true, trim: true, maxlength: 600 },
    // The recipient. A caregiver recipient always names the grant that authorized
    // the reminder, so an auditor can see why it was allowed.
    recipientUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipientLabel: { type: String, trim: true, maxlength: 254 },
    recipientRole: {
      type: String,
      enum: ['patient', 'caregiver', 'staff'],
      required: true,
    },
    recipientGrant: { type: mongoose.Schema.Types.ObjectId, ref: 'CaregiverGrant' },
    // ---- what the reminder is ABOUT ---------------------------------------
    // A reference to the thing that made it relevant, plus the versions that must
    // still be true at delivery time.
    sourceType: {
      type: String,
      enum: ['occurrence', 'follow_up', 'check_in', 'thread', 'episode', 'none'],
      default: 'none',
      required: true,
    },
    source: { type: mongoose.Schema.Types.ObjectId },
    planVersion: { type: mongoose.Schema.Types.ObjectId, ref: 'CarePlanVersion' },
    templateVersion: { type: mongoose.Schema.Types.ObjectId, ref: 'CheckInTemplateVersion' },
    // The local date/time the reminder is FOR, in the episode's own zone.
    localDate: { type: String, trim: true, maxlength: 20 },
    localTime: { type: String, trim: true, maxlength: 10 },
    timezone: { type: String, trim: true, maxlength: 64 },
    // ---- delivery ---------------------------------------------------------
    state: {
      type: String,
      enum: Object.values(NOTIFICATION_STATES),
      default: NOTIFICATION_STATES.QUEUED,
      required: true,
    },
    attempts: { type: Number, default: 0, min: 0, required: true },
    maxAttempts: { type: Number, default: 3, min: 1, max: 5, required: true },
    // Bounded retry scheduling. A retry never runs before this instant.
    nextAttemptAt: { type: Date },
    deliveredAt: { type: Date },
    deliveredVia: { type: String, trim: true, maxlength: 40 },
    failedAt: { type: Date },
    lastErrorCode: { type: String, trim: true, maxlength: 60 },
    lastError: { type: String, trim: true, maxlength: 300 },
    cancelledAt: { type: Date },
    cancelledReason: { type: String, trim: true, maxlength: 200 },
    // Set ONLY by an explicit human action; never by a delivery.
    acknowledgedAt: { type: Date },
    acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Delivery is not acknowledgement; the record says so in its own words.
    acknowledgementNote: {
      type: String,
      trim: true,
      maxlength: 300,
      default: 'A delivered reminder has not been read or acknowledged by the recipient.',
    },
  },
  { timestamps: true }
);

// De-duplication by recipient + event/version + channel, enforced by the database.
notificationSchema.index({ clinic: 1, dedupeKey: 1 }, { unique: true });
// The in-app inbox for one person, newest first.
notificationSchema.index({ clinic: 1, recipientUser: 1, state: 1, createdAt: -1 });
// The delivery worker's queue.
notificationSchema.index({ clinic: 1, state: 1, nextAttemptAt: 1 });
// The dashboard's failed-reminder queue.
notificationSchema.index({ clinic: 1, state: 1, episode: 1 });
notificationSchema.index({ clinic: 1, episode: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
