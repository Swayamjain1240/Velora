'use strict';

const mongoose = require('mongoose');
const { ALL_JOB_STATES, JOB_STATES } = require('../policies/extractionPolicy');

// One AI-assisted extraction ATTEMPT GROUP for one authorized ready document
// against one draft plan version. The job is a drafting aid: it never carries
// clinical authority, and completing it changes no clinical state, approves
// nothing, publishes nothing, prescribes nothing and activates no task.
//
// Privacy: the job stores METADATA, COUNTS and FINGERPRINTS only. The prompt
// text and the raw model response are never persisted (controls #1, #9, #15),
// so a database dump cannot reconstruct the document text or the model exchange.
const extractionJobSchema = new mongoose.Schema(
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
    // Rule 1: the job belongs to exactly one authorized ready document.
    document: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EpisodeDocument',
      required: true,
      immutable: true,
    },
    documentSha256: { type: String, required: true, maxlength: 64, immutable: true },
    // Rule 2: the job targets a draft (unapproved) plan version.
    version: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CarePlanVersion',
      required: true,
      immutable: true,
    },
    // The version revision this job was created against. It is re-checked before
    // the job starts and again before any suggestion may be applied, so a stale
    // job can never write into a version that moved on.
    targetRevision: { type: Number, required: true, min: 1 },
    state: { type: String, enum: ALL_JOB_STATES, default: JOB_STATES.QUEUED, required: true },
    // Provider identity, so a result is always attributable to a provider and
    // model. `provider: 'none'` is recorded when extraction is disabled.
    provider: { type: String, required: true, maxlength: 40 },
    model: { type: String, maxlength: 120 },
    // Deduplication/idempotency: identical request input (document + version +
    // revision + provider + model + extracted input fingerprint) maps to ONE job.
    dedupeKey: { type: String, required: true, maxlength: 128, immutable: true },
    // sha256 of the exact model input. The input itself is never stored.
    inputFingerprint: { type: String, maxlength: 64 },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 1, min: 1 },
    // A snapshot of the limits the job ran under, so a later config change cannot
    // rewrite history.
    limits: {
      maxInputChars: { type: Number },
      maxOutputBytes: { type: Number },
      timeoutMs: { type: Number },
      maxRetries: { type: Number },
      maxSuggestions: { type: Number },
    },
    inputChars: { type: Number, default: 0, min: 0 },
    inputTruncated: { type: Boolean, default: false },
    pages: { type: [Number], default: [] },
    suggestionCount: { type: Number, default: 0, min: 0 },
    // Suggestions the server REFUSED (for example a citation that does not exist
    // in the page it claims). Counted for visibility, never surfaced as content.
    rejectedCount: { type: Number, default: 0, min: 0 },
    unresolvedCount: { type: Number, default: 0, min: 0 },
    injectionSignalCount: { type: Number, default: 0, min: 0 },
    // Bounded, NON-FREE-TEXT facts about the injection signals: page/line/pattern
    // label only, never the matching document text.
    injectionSignals: {
      type: [
        {
          page: { type: Number },
          line: { type: Number },
          label: { type: String, maxlength: 80 },
        },
      ],
      default: [],
    },
    // A stable, SAFE code. Provider diagnostics, prompts and source text are
    // never stored here.
    errorCode: { type: String, maxlength: 64 },
    latencyMs: { type: Number, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    createdByLabel: { type: String, maxlength: 200, immutable: true },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    cancelledAt: { type: Date },
  },
  { timestamps: true }
);

// One job per identical request.
extractionJobSchema.index({ dedupeKey: 1 }, { unique: true });
extractionJobSchema.index({ clinic: 1, episode: 1, createdAt: -1 });
extractionJobSchema.index({ clinic: 1, version: 1, state: 1 });
extractionJobSchema.index({ state: 1, createdAt: 1 });

module.exports = mongoose.model('ExtractionJob', extractionJobSchema);
