'use strict';

const mongoose = require('mongoose');

// Single-use hashed TOTP recovery codes. `usedAt` is set with an atomic
// conditional update so a replayed code always loses the race.
const mfaRecoveryCodeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    codeHash: { type: String, required: true },
    usedAt: { type: Date },
  },
  { timestamps: true }
);

mfaRecoveryCodeSchema.index({ user: 1, codeHash: 1 }, { unique: true });

module.exports = mongoose.model('MfaRecoveryCode', mfaRecoveryCodeSchema);
