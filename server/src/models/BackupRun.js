'use strict';

// Evidence that a backup SET was written, and how it ended (Phase A gate 4).
//
// The runbook can only promise a recovery point if something records when the
// last complete set was taken. This collection is that record: the newest
// `complete` row is the recovery point an operator quotes, and a `failed` row is
// a schedule that did not produce a backup - which must never look like a quiet
// success.
//
// No clinical content and no key material belongs here: the row carries counts,
// sizes, durations and a KEY FINGERPRINT (never the key).
const mongoose = require('mongoose');

const backupRunSchema = new mongoose.Schema(
  {
    setId: { type: String, required: true, immutable: true, maxlength: 40 },
    status: { type: String, enum: ['complete', 'failed'], required: true },
    trigger: { type: String, enum: ['manual', 'schedule'], default: 'manual' },
    // Directory name only: a backup destination may be a mount path, and the
    // full path is operational detail rather than audit content.
    destination: { type: String, maxlength: 400 },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, min: 0, default: 0 },
    collections: { type: Number, min: 0, default: 0 },
    documents: { type: Number, min: 0, default: 0 },
    objectCount: { type: Number, min: 0, default: 0 },
    objectBytes: { type: Number, min: 0, default: 0 },
    setBytes: { type: Number, min: 0, default: 0 },
    keyFingerprint: { type: String, maxlength: 64 },
    // A short, safe reason. Never a stack trace, a connection string or a value.
    error: { type: String, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

backupRunSchema.index({ startedAt: -1 });
backupRunSchema.index({ setId: 1 }, { unique: true });
backupRunSchema.index({ status: 1, startedAt: -1 });

module.exports = mongoose.model('BackupRun', backupRunSchema);
