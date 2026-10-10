'use strict';

const mongoose = require('mongoose');

// Append-only security/audit trail. Payloads must never contain secrets,
// password hashes, tokens or raw clinical content (control #9, #19).
const auditEventSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' },
    actorUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorLabel: { type: String, maxlength: 200 },
    action: { type: String, required: true, maxlength: 120 },
    targetType: { type: String, maxlength: 80 },
    targetId: { type: String, maxlength: 120 },
    outcome: {
      type: String,
      enum: ['success', 'failure', 'denied'],
      required: true,
    },
    ip: { type: String },
    userAgent: { type: String, maxlength: 400 },
    // Sanitized, non-sensitive detail only.
    detail: { type: Object },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: true }
);

auditEventSchema.index({ clinic: 1, createdAt: -1 });
auditEventSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AuditEvent', auditEventSchema);
