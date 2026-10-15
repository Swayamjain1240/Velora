'use strict';

// Configurable retention categories, per clinic (Part 9, VEL-021).
//
// A row customises one catalog category for one clinic. A missing row means the
// catalog default applies, so a clinic starts from the documented defaults rather
// than from an empty or silently-infinite window. `reportOnly` is mirrored from
// the catalog and can never be turned off from a request: only the catalog
// decides which categories an automated run may act on.
const mongoose = require('mongoose');
const { RETENTION_CATEGORIES } = require('../config/constants');

const CATEGORY_KEYS = RETENTION_CATEGORIES.map((c) => c.key);

const retentionPolicySchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    category: { type: String, enum: CATEGORY_KEYS, required: true, immutable: true },
    retainDays: { type: Number, required: true, min: 1, max: 36500 },
    enabled: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedLabel: { type: String, maxlength: 200 },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

retentionPolicySchema.index({ clinic: 1, category: 1 }, { unique: true });

module.exports = mongoose.model('RetentionPolicy', retentionPolicySchema);
module.exports.CATEGORY_KEYS = Object.freeze(CATEGORY_KEYS);
