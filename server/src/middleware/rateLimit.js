'use strict';

const rateLimitService = require('../services/rateLimitService');
const { errors } = require('../services/errors');
const { getEnv } = require('../config/env');

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

// The same durable bucket, with the LIMIT resolved from the validated
// environment on each request. Used where the limit is a deployment BUDGET (AI
// jobs per hour, provider runs per day) rather than a fixed product constant, so
// a stricter budget can be set without touching code.
function mongoRateLimitFromEnv({ keyPrefix, envKey, windowMs, keyFn } = {}) {
  return async (req, res, next) => {
    try {
      const parsed = Number(getEnv()[envKey]);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return next(errors.internal('Extraction budget is not configured.'));
      }
      const discriminator = keyFn ? keyFn(req) : req.clientIp;
      const key = `${keyPrefix}:${discriminator || 'unknown'}`;
      const result = await rateLimitService.consume(key, { limit: parsed, windowMs });
      if (!result.allowed) {
        return next(
          errors.rateLimited('The AI-assisted extraction budget is exhausted. Draft by hand or try again later.')
        );
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { mongoRateLimit, mongoRateLimitFromEnv };
