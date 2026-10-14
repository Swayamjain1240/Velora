'use strict';

const mongoose = require('mongoose');
const { THREAD_STATES, THREAD_KINDS } = require('../config/constants');

// One clarification thread: a question a patient, an authorized caregiver or a
// staff member asked about an episode (VEL-016).
//
// Two design commitments:
//
//   * KIND decides AUTHORITY. A `clinical` question can only be answered by an
//     eligible clinical reviewer who is ASSIGNED to the thread; an `operational`
//     question belongs to a care coordinator. The two answer permissions are
//     separate, so holding one never confers the other.
//   * EVERY transition appends actor/time/history. `history` is append-only: it
//     is the audit trail of the workflow, and closing then reopening a thread
//     leaves the earlier answer visible instead of erasing it.
const transitionSchema = new mongoose.Schema(
  {
    from: { type: String, enum: Object.values(THREAD_STATES), required: true },
    to: { type: String, enum: Object.values(THREAD_STATES), required: true },
    action: { type: String, required: true, trim: true, maxlength: 40 },
    actorUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorLabel: { type: String, trim: true, maxlength: 254 },
    actorRole: { type: String, enum: ['patient', 'caregiver', 'staff'], required: true },
    note: { type: String, trim: true, maxlength: 300 },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const clarificationThreadSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    episode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecoveryEpisode',
      required: true,
      immutable: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PatientProfile',
      required: true,
      immutable: true,
    },
    // Optional link to the check-in response the question came from. It is a
    // reference only: the thread never re-interprets the answers.
    response: { type: mongoose.Schema.Types.ObjectId, ref: 'CheckInResponse', default: null },
    kind: {
      type: String,
      enum: Object.values(THREAD_KINDS),
      default: THREAD_KINDS.OPERATIONAL,
      required: true,
    },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    state: {
      type: String,
      enum: Object.values(THREAD_STATES),
      default: THREAD_STATES.OPEN,
      required: true,
    },
    openedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    openedByLabel: { type: String, trim: true, maxlength: 254 },
    openedByRole: { type: String, enum: ['patient', 'caregiver', 'staff'], required: true },
    // The grant a caregiver used, so an auditor can see the authorization.
    openedByGrant: { type: mongoose.Schema.Types.ObjectId, ref: 'CaregiverGrant' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedToLabel: { type: String, trim: true, maxlength: 254 },
    assignedAt: { type: Date },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    answeredAt: { type: Date },
    answeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    answeredByLabel: { type: String, trim: true, maxlength: 254 },
    closedAt: { type: Date },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reopenedAt: { type: Date },
    reopenCount: { type: Number, default: 0, min: 0, required: true },
    messageCount: { type: Number, default: 0, min: 0, required: true },
    lastMessageAt: { type: Date },
    // The full, append-only transition log, in order.
    history: { type: [transitionSchema], default: [] },
  },
  { timestamps: true }
);

// Queue and dashboard reads. A thread is always scoped by clinic first.
clarificationThreadSchema.index({ clinic: 1, state: 1, lastMessageAt: -1 });
clarificationThreadSchema.index({ clinic: 1, assignedTo: 1, state: 1, lastMessageAt: -1 });
clarificationThreadSchema.index({ clinic: 1, patient: 1, lastMessageAt: -1 });
clarificationThreadSchema.index({ clinic: 1, episode: 1, lastMessageAt: -1 });

// The history is APPEND-ONLY. A thread's state legitimately changes, so the
// guard allows adding a transition and `$push`, and refuses anything that would
// rewrite or drop the transitions already recorded - that is the audit trail of
// who did what, when.
function historyFingerprint(entry) {
  return `${entry.from}>${entry.to}:${entry.action}:${entry.actorUser}@${new Date(entry.at).toISOString()}`;
}

clarificationThreadSchema.pre('save', async function preventHistoryRewrite() {
  if (this.isNew || !this.isModified('history')) return;
  const persisted = await this.constructor.findById(this._id).select('history').lean();
  const before = (persisted && persisted.history) || [];
  const now = this.history || [];
  if (now.length < before.length) {
    throw new Error('The clarification transition history is append-only.');
  }
  for (const [index, entry] of before.entries()) {
    const candidate = now[index];
    if (!candidate || historyFingerprint(candidate) !== historyFingerprint(entry)) {
      throw new Error('The clarification transition history is append-only.');
    }
  }
});

for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate']) {
  clarificationThreadSchema.pre(op, function preventHistoryOverwrite(next) {
    const update = this.getUpdate() || {};
    for (const operator of ['$set', '$unset', '$pull', '$pullAll', '$pop']) {
      const clause = update[operator];
      if (clause && Object.keys(clause).some((key) => key === 'history' || key.startsWith('history.'))) {
        return next(new Error('The clarification transition history is append-only.'));
      }
    }
    return next();
  });
}

module.exports = mongoose.model('ClarificationThread', clarificationThreadSchema);
