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

// NQ-3: at most ONE ACTIVE invitation per clinic+email. Before this index a
// double-clicked "invite" button, a client retry or two parallel requests left
// several live tokens for the same person (measured: 8 parallel posts -> 8 active
// invitations). Accepting or revoking a record removes it from the partial
// index, so re-inviting after a revoke still works, and any surviving race is
// answered as a 409 by the duplicate-key mapping.
invitationSchema.index(
  { clinic: 1, email: 1 },
  {
    unique: true,
    // Equality-to-null matches an unset field AND a null one, so a record only
    // participates in the unique index while it is still live. ($exists:false is
    // rejected by MongoDB in a partial filter expression - it rewrites to $not.)
    partialFilterExpression: {
      acceptedAt: null,
      revokedAt: null,
    },
  }
);

module.exports = mongoose.model('Invitation', invitationSchema);
