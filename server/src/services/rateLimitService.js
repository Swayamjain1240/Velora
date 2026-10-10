'use strict';

// Atomic fixed-window rate limiter backed by MongoDB (control #8), so the
// limit holds across restarts and multiple server processes.
const RateLimitBucket = require('../models/RateLimitBucket');

async function consume(key, { limit, windowMs }) {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const doc = await RateLimitBucket.findOneAndUpdate(
    { key, windowStart },
    { $inc: { count: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).catch((err) => {
    // Two parallel upserts can race the unique index; retry once atomically.
    if (err && err.code === 11000) {
      return RateLimitBucket.findOneAndUpdate(
        { key, windowStart },
        { $inc: { count: 1 } },
        { new: true }
      );
    }
    throw err;
  });
  return {
    allowed: doc.count <= limit,
    remaining: Math.max(0, limit - doc.count),
  };
}

module.exports = { consume };
