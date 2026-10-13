'use strict';

const mongoose = require('mongoose');

// A reviewed Hindi or English rendering of ONE plan item's instruction. The
// variant is always LINKED to the original wording it renders (`sourceWording`,
// captured verbatim from the item at creation), it is VERSIONED, and it is
// reviewable: it stays invisible until an assigned, verified clinical reviewer
// approves it.
//
// Guarantees (Part 6 language rules):
//   - never becomes patient-visible automatically: no patient route reads this
//     collection, and the patient projection in Part 5 is unchanged;
//   - meaning must be preserved, and the reviewer states that explicitly in
//     `fidelityNote` before approval;
//   - approving a variant changes the PLAN's language presentation only - it
//     never changes an item's clinical fields, state or approval.
//
// `producedBy` records whether a model or a human drafted the wording, so a
// reviewer is never misled about its origin.
const reviewedLanguageVariantSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      immutable: true,
    },
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
    version: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarePlanVersion',
      required: true,
      immutable: true,
    },
    item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarePlanItem',
      required: true,
      immutable: true,
    },
    language: { type: String, enum: ['hi', 'en'], required: true, immutable: true },
    kind: {
      type: String,
      enum: ['translation', 'simplification'],
      required: true,
      immutable: true,
    },
    // Monotonic per (item, language, kind): a revision is a NEW variant, so an
    // approved rendering can never be edited in place.
    variant: { type: Number, required: true, min: 1, immutable: true },
    // The instruction as written at creation time, preserved for fidelity checks.
    sourceWording: { type: String, required: true, maxlength: 2000, immutable: true },
    // A hash of every clinical value of the source instruction at creation time.
    // Approval recomputes it: if the item was edited in the meantime the
    // rendering no longer matches its source and must be drafted again.
    sourceFingerprint: { type: String, required: true, maxlength: 64, immutable: true },
    text: { type: String, required: true, maxlength: 2000 },
    // `model` wording is a suggestion until a reviewer approves it; `human`
    // wording is still reviewer-approved before it is used.
    producedBy: { type: String, enum: ['model', 'human'], default: 'human', required: true },
    modelRun: { type: mongoose.Schema.Types.ObjectId, ref: 'ModelRun' },
    provider: { type: String, maxlength: 40 },
    model: { type: String, maxlength: 120 },
    reviewState: {
      type: String,
      enum: ['draft', 'in_review', 'approved', 'superseded'],
      default: 'draft',
      required: true,
    },
    // A machine check that the rendering did not silently drop a number: every
    // numeric token of the source instruction must still appear. It is a GUARD,
    // not a fidelity proof - the reviewer's own statement (`fidelityNote`) is
    // what approves the wording for use.
    fidelity: {
      checked: { type: Boolean, default: false },
      passed: { type: Boolean, default: false },
      warnings: { type: [String], default: [] },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    createdByLabel: { type: String, maxlength: 200, immutable: true },
    submittedAt: { type: Date },
    // The reviewer's explicit statement that the rendering preserves meaning.
    fidelityNote: { type: String, maxlength: 500 },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedByLabel: { type: String, maxlength: 200 },
    approvedAt: { type: Date },
    // Set when a reviewer rejects the wording outright.
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejectedByLabel: { type: String, maxlength: 200 },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, maxlength: 300 },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'ReviewedLanguageVariant' },
    supersededAt: { type: Date },
  },
  { timestamps: true }
);

// One variant number per (item, language, kind).
reviewedLanguageVariantSchema.index(
  { item: 1, language: 1, kind: 1, variant: 1 },
  { unique: true }
);
// At most ONE approved rendering per (item, language, kind).
reviewedLanguageVariantSchema.index(
  { item: 1, language: 1, kind: 1 },
  { unique: true, partialFilterExpression: { reviewState: 'approved' } }
);
reviewedLanguageVariantSchema.index({ clinic: 1, episode: 1, version: 1, reviewState: 1 });

module.exports = mongoose.model('ReviewedLanguageVariant', reviewedLanguageVariantSchema);
