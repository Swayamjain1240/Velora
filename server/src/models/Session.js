'use strict';

const mongoose = require('mongoose');

// Opaque server-side session. The browser only ever holds a random token in an
// httpOnly cookie; the database stores a peppered SHA-256 of that token.
// Sessions are revocable individually (logout) or in bulk (revoke-all).
// MFA state lives on the session so a password-only session can never reach
// MFA-protected routes (control #4, #5).
const sessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, unique: true },
    csrfSecret: { type: String, required: true, select: false },
    // 'mfa_pending' cannot access protected routes; 'active' has passed MFA.
    state: {
      type: String,
      enum: ['mfa_pending', 'active'],
      default: 'mfa_pending',
    },
    // TOTP enrollment lock: staff must finish enrollment to become 'active'.
    mfaEnrollmentRequired: { type: Boolean, default: false },
    ip: { type: String },
    userAgent: { type: String, maxlength: 400 },
    lastSeenAt: { type: Date },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { timestamps: true }
);

// TTL sweep removes expired sessions from the collection.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ user: 1, revokedAt: 1 });

module.exports = mongoose.model('Session', sessionSchema);
