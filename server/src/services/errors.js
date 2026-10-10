'use strict';

// Single safe error envelope: { error: { code, message } } (control #9).
// Messages are always safe to show; internals stay in the server log.
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const errors = {
  badRequest: (message = 'Invalid request.') =>
    new AppError(400, 'BAD_REQUEST', message),
  unauthorized: (message = 'Authentication required.') =>
    new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'You do not have permission to perform this action.') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message = 'The request conflicts with the current state.') =>
    new AppError(409, 'CONFLICT', message),
  payloadTooLarge: (message = 'The request payload is too large.') =>
    new AppError(413, 'PAYLOAD_TOO_LARGE', message),
  unsupportedMedia: (message = 'Unsupported content type.') =>
    new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message),
  rateLimited: (message = 'Too many attempts. Please wait and try again.') =>
    new AppError(429, 'RATE_LIMITED', message),
  internal: (message = 'Something went wrong. Please try again later.') =>
    new AppError(500, 'INTERNAL_ERROR', message),
};

module.exports = { AppError, errors };
