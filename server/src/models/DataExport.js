'use strict';

// A generated privacy-request export (Part 9, VEL-020).
//
// The artifact is produced ASYNCHRONOUSLY after the request is approved, is
// stored ENCRYPTED with its own key, and is time-limited. Downloading requires a
// FRESH authorization: a short-lived, single-use token is minted at download
// time and hashed at rest (the plaintext token is never stored or logged).
// Revoking a request's export invalidates every outstanding token immediately.
const mongoose = require('mongoose');

const dataExportSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    request: { type: mongoose.Schema.Types.ObjectId, ref: 'DataRequest', required: true, immutable: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'PatientProfile', required: true, immutable: true },
    // Opaque storage key (never a filename) for the encrypted object.
    storageKey: { type: String, required: true, maxlength: 200, immutable: true },
    mediaType: { type: String, default: 'application/json', maxlength: 120, immutable: true },
    byteLength: { type: Number, min: 0, default: 0, immutable: true },
    // SHA-256 of the PLAINTEXT artifact, so a download can be integrity-checked
    // without decrypting twice.
    contentHash: { type: String, maxlength: 80, immutable: true },
    // Non-sensitive manifest: which sections the export contains and their sizes.
    manifest: { type: [Object], default: [] },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', immutable: true },
    generatedAt: { type: Date, default: Date.now, immutable: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, trim: true, maxlength: 300 },
    downloadCount: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

dataExportSchema.index({ clinic: 1, request: 1 });
dataExportSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('DataExport', dataExportSchema);
