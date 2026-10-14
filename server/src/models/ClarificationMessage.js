'use strict';

const mongoose = require('mongoose');
const { MESSAGE_KINDS } = require('../config/constants');

// One message inside a clarification thread (VEL-016).
//
// Messages are append-only plain text. `kind` records what the message IS:
// a `question` (the asker), an `answer` (an authorized reply), a `note` (a
// staff-internal remark the patient never sees) or a `system` line describing a
// state change. The body is rendered as text, never as HTML, and the policy
// refuses markup at write time.
const clarificationMessageSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    thread: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClarificationThread',
      required: true,
      immutable: true,
    },
    episode: { type: mongoose.Schema.Types.ObjectId, ref: 'RecoveryEpisode', immutable: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', immutable: true },
    kind: { type: String, enum: Object.values(MESSAGE_KINDS), required: true, immutable: true },
    body: { type: String, required: true, trim: true, maxlength: 2000, immutable: true },
    // Who wrote it, in which capacity, and under which grant.
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
    authorLabel: { type: String, trim: true, maxlength: 254, immutable: true },
    authorRole: { type: String, enum: ['patient', 'caregiver', 'staff', 'system'], immutable: true },
    authorGrant: { type: mongoose.Schema.Types.ObjectId, ref: 'CaregiverGrant' },
    // An internal note is team-only; it is never returned on a patient surface.
    patientVisible: { type: Boolean, default: true, required: true },
    // Which authority the reply was written under, for the audit trail.
    answeredAs: { type: String, enum: ['clinical', 'operational', null], default: null },
    createdAt: { type: Date, default: Date.now, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } }
);

clarificationMessageSchema.index({ thread: 1, createdAt: 1 });
clarificationMessageSchema.index({ clinic: 1, createdAt: -1 });

// Append-only: a message is never edited or deleted. A correction is a new
// message, so the conversation a patient read stays exactly as they read it.
clarificationMessageSchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) return next(new Error('Clarification messages are append-only.'));
  return next();
});
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]) {
  clarificationMessageSchema.pre(op, function preventMutation(next) {
    return next(new Error('Clarification messages are append-only.'));
  });
}

module.exports = mongoose.model('ClarificationMessage', clarificationMessageSchema);
