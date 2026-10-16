'use strict';

const { AppError } = require('../services/errors');
const { getEnv } = require('../config/env');
const { getLogger } = require('../services/logger');

// Single safe error envelope (control #9, #12): stack traces, secrets and
// provider details are logged server-side, never returned to the client.
// In production the client gets only the generic message for 5xx errors.
// eslint-disable-next-line no-unused-vars
function notFoundHandler(req, res, next) {
  return res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
  });
}

// A dependency that cannot be reached is not a defect in the request. The readiness
// probe already answers 503 for exactly this condition, so a REQUEST must not
// disagree with the probe: a retryable 503 tells a client, a load balancer and an
// operator the same thing, while a 500 ("the code is broken") would be misleading
// and unactionable during an outage (controls #9, #12). Storage tampering and
// other 500-class failures are deliberately NOT matched here.
const DEPENDENCY_ERROR_NAMES = new Set([
  'MongoServerSelectionError',
  'MongoServerClosedError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError',
  'MongoTopologyClosedError',
  'MongoPoolClosedError',
  'MongooseServerSelectionError',
]);
const DEPENDENCY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function isDependencyError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  if (DEPENDENCY_ERROR_NAMES.has(name)) return true;
  if (DEPENDENCY_ERROR_CODES.has(String(err.code || ''))) return true;
  // Mongoose reports a connection that is closed or still buffering with its own
  // generic error name, so the stable wordings are matched rather than a status.
  if (name.startsWith('Mongoose')) {
    return /force closed|buffering timed out|not connected|connection .*closed/i.test(
      String(err.message || '')
    );
  }
  return false;
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

  // Structured, correlated and redacted (control #9): the request id ties the
  // line to the response header, and only the route plus the error are recorded
  // - never a body, a token or a document. The stack is kept out of a production
  // line (control #12).
  if (isDependencyError(err)) {
    // Alert-worthy: this line is the operational signal that a dependency went
    // away, and the response body stays generic in every environment.
    getLogger().error('dependency.unavailable', {
      requestId: req.id,
      method: req.method,
      route: req.path,
      status: 503,
      err,
    });
    return res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is temporarily unavailable. Please retry shortly.',
      },
    });
  }

  getLogger().error('request.unhandled_error', {
    requestId: req.id,
    method: req.method,
    route: req.path,
    status: err && err.status,
    err,
  });

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

module.exports = { notFoundHandler, errorHandler, isDependencyError };
