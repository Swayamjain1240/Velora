'use strict';

// A retention HOLD (Part 9, VEL-021).
//
// A hold freezes a retention category - or one subject within it - so an apply
// run cannot touch held material. Holds are created deliberately, with a reason
// and an owner, and releasing one is an explicit, audited action. A hold is the
// mechanism that lets a clinic answer "not yet" without changing the retention
// window for everything else.
const mongoose = require('mongoose');
const { RETENTION_HOLD_SCOPES, RETENTION_CATEGORIES } = require('../config/constants');

const CATEGORY_KEYS = RETENTION_CATEGORIES.map((c) => c.key);

const retentionHoldSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    scope: { type: String, enum: RETENTION_HOLD_SCOPES, required: true, immutable: true },
    // Always set: a hold always names a category. A `subject` hold narrows that
    // category to one record.
    category: { type: String, enum: CATEGORY_KEYS, required: true },
    subjectType: { type: String, maxlength: 60 },
    subjectId: { type: String, maxlength: 120 },
    reason: { type: String, trim: true, maxlength: 500, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdLabel: { type: String, maxlength: 200 },
    releasedAt: { type: Date, default: null },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    releasedLabel: { type: String, maxlength: 200 },
    releasedReason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

retentionHoldSchema.index({ clinic: 1, category: 1, releasedAt: 1 });
retentionHoldSchema.index({ clinic: 1, subjectType: 1, subjectId: 1, releasedAt: 1 });

module.exports = mongoose.model('RetentionHold', retentionHoldSchema);
