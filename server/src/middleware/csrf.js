'use strict';

// Double-submit CSRF protection (control #4): the readable velora_csrf cookie
// must match the x-csrf-token header, and the value must equal the secret
// bound to the server-side session. Unauthenticated endpoints (login, reset,
// invite acceptance) carry no ambient authority and are exempt; they are
// still SameSite=Lax and rate-limited.
const crypto = require('node:crypto');
const { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } = require('../config/constants');
const { errors } = require('../services/errors');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function csrfProtection(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  if (!req.cookies || !req.cookies[SESSION_COOKIE]) return next();
  if (!req.session) return next();

  const headerToken = req.get(CSRF_HEADER);
  const cookieToken = req.cookies[CSRF_COOKIE];
  if (!headerToken || !cookieToken || !safeEqual(headerToken, cookieToken)) {
    return next(errors.forbidden('Invalid or missing CSRF token.'));
  }
  if (!safeEqual(headerToken, req.session.csrfSecret)) {
    return next(errors.forbidden('Invalid or missing CSRF token.'));
  }
  return next();
}

module.exports = { csrfProtection };
