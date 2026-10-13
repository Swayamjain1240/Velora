'use strict';

const mongoose = require('mongoose');

// Where a suggestion says it came from: one page of the job's document plus the
// quoted supporting text. Every citation is SERVER-VERIFIED before it is stored
// (`verified: true` only when the quoted text really occurs on the page we sent
// the provider, and the page was actually supplied). A citation to a page that
// was never sent, or to text that does not exist, is a hard rejection: the model
// cannot invent provenance (rules 8, 10).
//
// The citation is the same object a reviewer sees next to the suggestion, and -
// when a suggestion is applied - the same evidence that becomes a Part 5
// SourceReference on the created item, so AI-proposed content carries the same
// traceable origin as hand-typed content.
const sourceCitationSchema = new mongoose.Schema(
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
    // The ready episode document this citation points at.
    document: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EpisodeDocument',
      required: true,
      immutable: true,
    },
    documentFilename: { type: String, maxlength: 255, immutable: true },
    documentMediaType: { type: String, maxlength: 64, immutable: true },
    documentSha256: { type: String, maxlength: 64, immutable: true },
    page: { type: Number, min: 1, max: 100000 },
    location: { type: String, maxlength: 300 },
    text: { type: String, required: true, maxlength: 2000, immutable: true },
    verified: { type: Boolean, default: false, required: true },
    verifiedAt: { type: Date },
  },
  { timestamps: true }
);

sourceCitationSchema.index({ suggestion: 1, page: 1, createdAt: 1 });
sourceCitationSchema.index({ clinic: 1, episode: 1, version: 1 });
sourceCitationSchema.index({ job: 1 });
sourceCitationSchema.index({ document: 1 });

module.exports = mongoose.model('SourceCitation', sourceCitationSchema);
