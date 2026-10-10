'use strict';

const rateLimitService = require('../services/rateLimitService');
const { errors } = require('../services/errors');

// Atomic, MongoDB-backed fixed-window limiter (control #8). Because the
// counter lives in the database, the limit holds across restarts and multiple
// server processes - unlike in-memory token buckets.
function mongoRateLimit({ keyPrefix, limit, windowMs, keyFn } = {}) {
  return async (req, res, next) => {
    try {
      const discriminator = keyFn ? keyFn(req) : req.clientIp;
      const key = `${keyPrefix}:${discriminator || 'unknown'}`;
      const result = await rateLimitService.consume(key, { limit, windowMs });
      if (!result.allowed) {
        return next(
          errors.rateLimited('Too many attempts. Please wait before trying again.')
        );
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { mongoRateLimit };
