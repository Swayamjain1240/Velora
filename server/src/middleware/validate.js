'use strict';

const { z } = require('zod');
const { errors } = require('../services/errors');

// Validates and sanitizes request parts with zod schemas (control #6).
// Unknown keys are rejected where the schema is strict; failed validation
// returns 400 with field paths but never echoes sensitive values back.
function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    try {
      if (body) {
        const result = body.safeParse(req.body);
        if (!result.success) return next(mapZodError(result.error));
        req.body = result.data;
      }
      if (query) {
        const result = query.safeParse(req.query);
        if (!result.success) return next(mapZodError(result.error));
        req.query = result.data;
      }
      if (params) {
        const result = params.safeParse(req.params);
        if (!result.success) return next(mapZodError(result.error));
        req.params = result.data;
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function mapZodError(error) {
  const issues = error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
  const appError = errors.badRequest('Invalid request. Check the highlighted fields.');
  appError.issues = issues;
  return appError;
}

// Shared primitives reused across validators.
const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long');

const nameSchema = z.string().trim().min(1).max(120);

const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid identifier');

const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app');

const pageSchema = z.coerce.number().int().min(1).max(10000).default(1);
const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

module.exports = {
  validate,
  mapZodError,
  emailSchema,
  passwordSchema,
  nameSchema,
  objectIdSchema,
  totpCodeSchema,
  pageSchema,
  limitSchema,
  z,
};
