'use strict';

// A freshly minted download authorization for one generated export (Part 9).
//
// The plaintext token is returned to the caller ONCE; only a peppered hash is
// stored, exactly like session tokens. A grant is single-use by default and
// expires quickly, so a shared or stale link cannot become a standing copy of
// someone's record.
const mongoose = require('mongoose');

const exportDownloadGrantSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, immutable: true },
    export: { type: mongoose.Schema.Types.ObjectId, ref: 'DataExport', required: true, immutable: true },
    request: { type: mongoose.Schema.Types.ObjectId, ref: 'DataRequest', required: true, immutable: true },
    tokenHash: { type: String, required: true, immutable: true },
    issuedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    ip: { type: String, maxlength: 80 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

exportDownloadGrantSchema.index({ tokenHash: 1 }, { unique: true });
exportDownloadGrantSchema.index({ expiresAt: 1 });

module.exports = mongoose.model('ExportDownloadGrant', exportDownloadGrantSchema);
