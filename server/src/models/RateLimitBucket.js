'use strict';

const mongoose = require('mongoose');

// Fixed-window counter persisted in MongoDB so limits survive restarts and
// are shared across processes. Callers use an atomic upsert+inc.
const rateLimitBucketSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    windowStart: { type: Date, required: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

rateLimitBucketSchema.index({ key: 1, windowStart: 1 }, { unique: true });
rateLimitBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimitBucket', rateLimitBucketSchema);
