'use strict';

const mongoose = require('mongoose');
const { PASSWORD_RESET_TTL_MINUTES } = require('../config/constants');

// Password reset token record. Raw token shown once (dev: console link);
// the database keeps only the hash. Single-use via atomic usedAt flip.
const passwordResetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: {
      type: Date,
      required: true,
      default: () => Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000,
    },
    usedAt: { type: Date },
  },
  { timestamps: true }
);

passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PasswordReset', passwordResetSchema);
