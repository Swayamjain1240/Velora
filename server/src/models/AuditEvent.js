'use strict';

const mongoose = require('mongoose');
const { AUDIT_CATEGORIES } = require('../config/constants');

// Append-only security/audit trail (Part 9, VEL-020). Payloads must never contain
// secrets, password hashes, tokens, raw clinical text or unnecessary PII
// (controls #9, #18, #19).
//
// Beyond WHO/WHAT/WHEN, a row is SCOPED so a scoped search can honour record
// access: `clinic` plus an optional `subjectType`/`subjectId` say which record the
// event is about, and `category` drives the search filters. The model refuses
// every mutation path, so an audit row cannot be edited or deleted through the
// application.
const auditEventSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' },
    actorUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorLabel: { type: String, maxlength: 200 },
    actorRole: { type: String, maxlength: 40 },
    action: { type: String, required: true, maxlength: 120 },
    category: { type: String, enum: AUDIT_CATEGORIES, default: 'admin' },
    // The record the event is about (e.g. `recovery_episode` + id). Used to
    // re-scope a search to records the caller may actually touch.
    subjectType: { type: String, maxlength: 80 },
    subjectId: { type: String, maxlength: 120 },
    targetType: { type: String, maxlength: 80 },
    targetId: { type: String, maxlength: 120 },
    // Why the action was taken, when the caller supplied a purpose.
    purpose: { type: String, maxlength: 200 },
    // Ties related rows together (one request, one job, one closure).
    correlationId: { type: String, maxlength: 120 },
    outcome: {
      type: String,
      enum: ['success', 'failure', 'denied'],
      required: true,
    },
    ip: { type: String },
    userAgent: { type: String, maxlength: 400 },
    // Sanitized, non-sensitive detail only (redaction happens before the write).
    detail: { type: Object },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: true }
);

auditEventSchema.index({ clinic: 1, createdAt: -1 });
auditEventSchema.index({ clinic: 1, category: 1, createdAt: -1 });
auditEventSchema.index({ action: 1, createdAt: -1 });
auditEventSchema.index({ clinic: 1, subjectType: 1, subjectId: 1, createdAt: -1 });
auditEventSchema.index({ clinic: 1, actorUser: 1, createdAt: -1 });

auditEventSchema.pre('save', function preventUpdate(next) {
  if (!this.isNew) return next(new Error('Audit events are append-only.'));
  return next();
});
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditEventSchema.pre(op, function preventMutation(next) {
    return next(new Error('Audit events are append-only.'));
  });
}

module.exports = mongoose.model('AuditEvent', auditEventSchema);
