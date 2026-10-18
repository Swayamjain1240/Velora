'use strict';

// Double-submit CSRF protection (control #4): the readable velora_csrf cookie
// must match the x-csrf-token header, and the value must equal the secret
// bound to the server-side session. Unauthenticated endpoints (login, reset,
// invite acceptance) carry no ambient authority and are exempt; they are
// still SameSite=Lax and rate-limited.
const crypto = require('node:crypto');
const { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } = require('../config/constants');
const { errors } = require('../services/errors');
const { getEnv } = require('../config/env');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// D-8: a second, independent CSRF layer. The double-submit token above is the
// primary defence, but it is a value an attacker cannot read rather than a
// check of who is asking. This rejects a cookie-authenticated mutation whose
// Origin (or, when absent, Referer) is not the configured client origin, so a
// foreign page cannot ride a session even if a token were somehow replayed.
// Requests with neither header (non-browser clients, same-origin tools) are
// allowed: they carry no ambient browser authority, and the token check still
// applies to them.
function isAllowedOrigin(req) {
  const allowed = getEnv().CLIENT_ORIGIN;
  const origin = req.get('origin');
  if (origin) return origin === allowed;
  const referer = req.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === allowed;
    } catch {
      return false;
    }
  }
  return true;
}

function originProtection(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  // Login, reset and invitation acceptance carry no ambient authority.
  if (!req.cookies || !req.cookies[SESSION_COOKIE]) return next();
  if (!isAllowedOrigin(req)) {
    return next(errors.forbidden('Request origin is not allowed.'));
  }
  return next();
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

module.exports = { csrfProtection, originProtection };
