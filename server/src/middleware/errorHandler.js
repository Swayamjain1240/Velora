'use strict';

const { AppError } = require('../services/errors');
const { getEnv } = require('../config/env');

// Single safe error envelope (control #9, #12): stack traces, secrets and
// provider details are logged server-side, never returned to the client.
// In production the client gets only the generic message for 5xx errors.
// eslint-disable-next-line no-unused-vars
function notFoundHandler(req, res, next) {
  return res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const env = getEnv();

  if (err instanceof AppError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.issues) body.error.issues = err.issues;
    return res.status(err.status).json(body);
  }

  // Mongoose duplicate key: treat as a conflict without leaking which field.
  if (err && err.code === 11000) {
    return res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'That record already exists.',
      },
    });
  }

  // Mongoose validation / cast errors -> 400 without echoing raw input.
  if (err && err.name && String(err.name).startsWith('Mongoose')) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Invalid request data.' },
    });
  }

  // eslint-disable-next-line no-console
  console.error(`[${new Date().toISOString()}] unhandled error:`, err);

  const isProd = env.NODE_ENV === 'production';
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      // Verbose diagnostics stay off outside production (control #12).
      message: isProd
        ? 'Something went wrong. Please try again later.'
        : err && err.message
          ? `Something went wrong: ${err.message}`
          : 'Something went wrong. Please try again later.',
    },
  });
}

module.exports = { notFoundHandler, errorHandler };
