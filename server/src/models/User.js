'use strict';

const mongoose = require('mongoose');

// User is the global login identity. Clinical authority never lives here:
// clinic roles and eligibility belong to ClinicMembership (Part 1 boundary).
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email'],
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },
    status: {
      type: String,
      enum: ['active', 'disabled'],
      default: 'active',
    },
    mfa: {
      // Encrypted TOTP secret (AES-256-GCM), never plaintext at rest.
      secretEnc: { type: String, select: false },
      enabled: { type: Boolean, default: false },
      confirmedAt: { type: Date },
    },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

userSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model('User', userSchema);
