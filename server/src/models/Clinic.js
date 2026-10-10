'use strict';

const mongoose = require('mongoose');

// Clinic is the tenant root. Every clinical record in later parts carries an
// immutable clinic reference derived server-side, never client-supplied.
const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    // Public, clinic-scoped reference used in URLs instead of raw ids.
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z0-9-]{6,24}$/, 'Invalid clinic code'],
    },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Clinic', clinicSchema);
