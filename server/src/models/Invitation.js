'use strict';

const mongoose = require('mongoose');
const { INVITATION_TTL_DAYS } = require('../config/constants');

// Staff invitation. The raw token is shown once (dev: console link) and only
// its SHA-256 hash is stored. Tokens are random, single-use and expiring;
// acceptance flips `acceptedAt` atomically so a race has exactly one winner.
const invitationSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
    },
    email: { type: String, required: true, lowercase: true, trim: true },
    roleKey: {
      type: String,
      required: true,
      enum: ['admin', 'care_coordinator', 'clinical_reviewer'],
    },
    tokenHash: { type: String, required: true, unique: true },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: {
      type: Date,
      required: true,
      default: () =>
        new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
    acceptedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

invitationSchema.index({ clinic: 1, email: 1, acceptedAt: 1 });
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Invitation', invitationSchema);
