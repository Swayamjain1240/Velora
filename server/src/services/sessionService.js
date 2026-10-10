'use strict';

// Session lifecycle: opaque random token -> httpOnly cookie; the database
// keeps only a peppered hash. Login always creates a fresh session (fixation
// defense), MFA verification promotes it by ROTATING the token, logout and
// revoke-all set revokedAt (control #4).
const mongoose = require('mongoose');
const { getEnv } = require('../config/env');
const { hmac, randomToken } = require('./crypto');
const Session = require('../models/Session');

function cookieOptions({ httpOnly = true, maxAgeMs } = {}) {
  const env = getEnv();
  return {
    httpOnly,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

async function createSession({ userId, state, mfaEnrollmentRequired, ip, userAgent }) {
  const token = randomToken(32);
  const csrfSecret = randomToken(32);
  const ttlHours = getEnv().SESSION_TTL_HOURS;
  const session = await Session.create({
    user: userId,
    tokenHash: hmac(token),
    csrfSecret,
    state,
    mfaEnrollmentRequired: Boolean(mfaEnrollmentRequired),
    ip,
    userAgent,
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
  });
  return { session, token, csrfToken: csrfSecret };
}

async function findSessionByToken(token) {
  if (!token) return null;
  return Session.findOne({ tokenHash: hmac(token) }).select('+csrfSecret');
}

// Promotes an MFA-pending session to active with a NEW token value so the
// pre-MFA cookie value can never be replayed afterwards.
async function activateSession(session) {
  const token = randomToken(32);
  session.tokenHash = hmac(token);
  session.state = 'active';
  session.mfaEnrollmentRequired = false;
  session.lastSeenAt = new Date();
  await session.save();
  return token;
}

async function revokeSession(session) {
  session.revokedAt = new Date();
  await session.save();
}

async function revokeAllSessions(userId) {
  await Session.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

function clearAuthCookies(res) {
  res.clearCookie('velora_session', cookieOptions());
  res.clearCookie('velora_csrf', cookieOptions({ httpOnly: false }));
}

module.exports = {
  cookieOptions,
  createSession,
  findSessionByToken,
  activateSession,
  revokeSession,
  revokeAllSessions,
  clearAuthCookies,
};
