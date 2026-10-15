'use strict';

// Evidence for one retention DRY RUN or APPLY (Part 9, VEL-021).
//
// Every run answers: which window each category used, how many items were
// eligible, which were held back, and - for an apply - the operator and reason
// that authorised it. A run carries an idempotency key so re-sending the same
// apply returns the ORIGINAL run rather than acting twice.
//
// `result` is `dry_run` for a report, `applied` when work was performed, and
// `report_only` when a category is deliberately never auto-deleted.
const mongoose = require('mongoose');

const categoryResultSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, maxlength: 60 },
    label: { type: String, maxlength: 160 },
    retainDays: { type: Number, min: 1 },
    cutoff: { type: Date },
    eligible: { type: Number, min: 0, default: 0 },
    held: { type: Number, min: 0, default: 0 },
    affected: { type: Number, min: 0, default: 0 },
    reportOnly: { type: Boolean, default: false },
    outcome: { type: String, maxlength: 40 },
    note: { type: String, maxlength: 400 },
  },
  { _id: false }
);

const retentionRunSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    mode: { type: String, enum: ['dry_run', 'apply'], required: true, immutable: true },
    result: { type: String, enum: ['dry_run', 'applied', 'partial', 'report_only'], required: true },
    // The operator who requested an apply, and their stated reason. A dry run
    // needs neither.
    operator: { type: String, maxlength: 200 },
    operatorUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, trim: true, maxlength: 500 },
    idempotencyKey: { type: String, maxlength: 120, immutable: true },
    categories: { type: [categoryResultSchema], default: [] },
    holds: { type: [Object], default: [] },
    totals: { type: Object, default: {} },
    limits: { type: Object, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

retentionRunSchema.index({ clinic: 1, createdAt: -1 });
retentionRunSchema.index({ clinic: 1, idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('RetentionRun', retentionRunSchema);
