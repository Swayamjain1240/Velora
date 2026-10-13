'use strict';

const mongoose = require('mongoose');

// One provider invocation, recorded for reliability and evaluation. A run is
// ATTRIBUTION AND HEALTH DATA ONLY: it stores fingerprints, sizes, timings and
// stable codes - never the prompt, never the model's raw response, never the
// document text (controls #1, #9, #15).
//
// `status` distinguishes a provider failure from a response we rejected:
//   succeeded -> the provider answered and the output passed server validation
//   invalid   -> the provider answered, the output was rejected (stable code)
//   failed    -> the provider errored
//   timeout   -> the provider exceeded its wall-clock budget
const modelRunSchema = new mongoose.Schema(
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
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExtractionJob',
      required: true,
      immutable: true,
    },
    version: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarePlanVersion',
      required: true,
      immutable: true,
    },
    attempt: { type: Number, required: true, min: 1 },
    provider: { type: String, required: true, maxlength: 40 },
    model: { type: String, maxlength: 120 },
    // `local` marks the deterministic fake provider, so evaluation evidence can
    // never be mistaken for a networked model's result.
    network: { type: Boolean, default: false, required: true },
    status: {
      type: String,
      enum: ['succeeded', 'invalid', 'failed', 'timeout'],
      required: true,
    },
    // A stable code only (`INVALID_JSON`, `GATEWAY_ERROR`, `TIMEOUT`, ...).
    code: { type: String, maxlength: 64 },
    // sha256 of the exact request body and of the raw response. Enough to prove
    // which input produced which output without storing either.
    requestFingerprint: { type: String, maxlength: 64 },
    responseFingerprint: { type: String, maxlength: 64 },
    latencyMs: { type: Number, min: 0 },
    inputChars: { type: Number, min: 0 },
    outputBytes: { type: Number, min: 0 },
    suggestionCount: { type: Number, min: 0 },
    usage: {
      promptTokens: { type: Number, min: 0 },
      completionTokens: { type: Number, min: 0 },
      totalTokens: { type: Number, min: 0 },
    },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true }
);

// One attempt number per job.
modelRunSchema.index({ job: 1, attempt: 1 }, { unique: true });
modelRunSchema.index({ clinic: 1, episode: 1, createdAt: -1 });
modelRunSchema.index({ provider: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ModelRun', modelRunSchema);
