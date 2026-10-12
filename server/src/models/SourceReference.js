'use strict';

const mongoose = require('mongoose');

// Where a clinical instruction came from: one READY document of the SAME episode,
// with the page, the quoted text and an optional human location hint. The
// document itself is validated by the service (ready status, same clinic and
// episode) before a row is written; a source can never point at an unready or
// foreign document.
const sourceReferenceSchema = new mongoose.Schema(
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
    // The ready episode document this wording came from.
    document: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EpisodeDocument',
      required: true,
      immutable: true,
    },
    // Denormalised display facts so a reader never needs the object store.
    documentFilename: { type: String, trim: true, maxlength: 255 },
    documentMediaType: { type: String, trim: true, maxlength: 64 },
    page: { type: Number, min: 1, max: 100000 },
    text: { type: String, trim: true, maxlength: 2000, required: true },
    location: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    createdByLabel: { type: String, maxlength: 200 },
  },
  { timestamps: true }
);

sourceReferenceSchema.index({ item: 1, createdAt: 1 });
sourceReferenceSchema.index({ version: 1, createdAt: 1 });
sourceReferenceSchema.index({ clinic: 1, episode: 1, version: 1 });

module.exports = mongoose.model('SourceReference', sourceReferenceSchema);
