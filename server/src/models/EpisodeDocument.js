'use strict';

const mongoose = require('mongoose');

// Metadata for one private discharge document. The BYTES live in encrypted
// private storage addressed by `storageKey`; MongoDB never stores a public URL,
// a path or the file contents. A `ready` status means the file was TECHNICALLY
// accepted for later clinical review - it never means clinically approved.
const episodeDocumentSchema = new mongoose.Schema(
  {
    // Derived from the episode; immutable so a document can never be moved.
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
    // Opaque UUID object key. Never a filename, never user-supplied.
    storageKey: { type: String, required: true, immutable: true, maxlength: 64 },
    originalFilename: { type: String, required: true, maxlength: 255 },
    // Allowlisted media type only (application/pdf, image/jpeg, image/png).
    mediaType: { type: String, required: true, maxlength: 64 },
    byteSize: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true, maxlength: 64 },
    status: {
      type: String,
      enum: ['uploading', 'ready', 'rejected', 'quarantined', 'failed'],
      default: 'uploading',
    },
    // A stable, SAFE reason code (never parser diagnostics or a stack).
    rejectionCode: { type: String, maxlength: 64 },
    // Non-clinical structural facts only (page count / pixel dimensions).
    technical: {
      pages: { type: Number },
      width: { type: Number },
      height: { type: Number },
    },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedByRole: { type: String, enum: ['staff', 'admin', 'patient'], maxlength: 16 },
  },
  { timestamps: true }
);

// Opaque key invariant.
episodeDocumentSchema.index({ storageKey: 1 }, { unique: true });
// One document per (episode, checksum): a byte-identical duplicate can never be
// stored twice. A previously rejected/failed row is REUSED rather than
// duplicated, so re-uploading a corrected file always works.
episodeDocumentSchema.index({ episode: 1, sha256: 1 }, { unique: true });
episodeDocumentSchema.index({ clinic: 1, episode: 1, createdAt: -1 });
episodeDocumentSchema.index({ status: 1 });

module.exports = mongoose.model('EpisodeDocument', episodeDocumentSchema);
