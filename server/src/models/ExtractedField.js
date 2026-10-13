'use strict';

const mongoose = require('mongoose');
const { FIELD_STATES } = require('../policies/extractionPolicy');

// One field of one suggestion, as the SERVER judged it. The model's own claim is
// kept alongside (`claimedMissing`, `claimedConflict`) so a reviewer can see
// where the model disagreed with the source, but the authoritative `state` is
// computed server-side: `suggested`, `missing`, `conflicting` or `unresolved`.
//
// Rule 11: an ambiguous term is never normalized into an invented fact. A value
// that is vague, contradictory, or simply not present in its own cited source is
// recorded as `unresolved` and blocks a clean acceptance.
const extractedFieldSchema = new mongoose.Schema(
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
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExtractionJob',
      required: true,
      immutable: true,
    },
    suggestion: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DraftSuggestion',
      required: true,
      immutable: true,
    },
    field: { type: String, required: true, maxlength: 40, immutable: true },
    // The proposed value, or null when the model produced none. Never filled in
    // by the server from another field.
    value: { type: String, maxlength: 500 },
    state: {
      type: String,
      enum: Object.values(FIELD_STATES),
      required: true,
    },
    claimedMissing: { type: Boolean, default: false },
    claimedConflict: { type: Boolean, default: false },
    confidence: { type: Number, min: 0, max: 1 },
    // The supporting text this field was anchored to (bounded), so a reviewer
    // sees the evidence without re-opening the document.
    evidenceText: { type: String, maxlength: 2000 },
    citation: { type: mongoose.Schema.Types.ObjectId, ref: 'SourceCitation' },
    // Why a value was not trusted. A stable code, never free-form model prose.
    reasonCode: { type: String, maxlength: 40 },
  },
  { timestamps: true }
);

extractedFieldSchema.index({ suggestion: 1, field: 1 }, { unique: true });
extractedFieldSchema.index({ clinic: 1, episode: 1, version: 1, state: 1 });
extractedFieldSchema.index({ job: 1, field: 1, state: 1 });

module.exports = mongoose.model('ExtractedField', extractedFieldSchema);
