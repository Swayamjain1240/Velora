'use strict';

const authService = require('../services/authService');
const sessionService = require('../services/sessionService');
const { SESSION_COOKIE, CSRF_COOKIE } = require('../config/constants');
const { errors } = require('../services/errors');

// Sets the opaque session cookie (httpOnly) plus the readable CSRF cookie.
function issueAuthCookies(res, { token, csrfToken, maxAgeMs }) {
  res.cookie(SESSION_COOKIE, token, sessionService.cookieOptions({ maxAgeMs }));
  res.cookie(
    CSRF_COOKIE,
    csrfToken,
    sessionService.cookieOptions({ httpOnly: false, maxAgeMs })
  );
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const result = await authService.login({
      email,
      password,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    issueAuthCookies(res, {
      token: result.token,
      csrfToken: result.csrfToken,
      maxAgeMs: 12 * 60 * 60 * 1000,
    });
    return res.json({ user: result.user, next: result.next });
  } catch (err) {
    return next(err);
  }
}

async function verifyMfa(req, res, next) {
  try {
    const { code, recoveryCode } = req.body;
    const result = await authService.verifyMfa({
      session: req.session,
      code,
      recoveryCode,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    // Rotate the session cookie on promotion (fixation defense).
    res.cookie(
      SESSION_COOKIE,
      result.token,
      sessionService.cookieOptions({ maxAgeMs: 12 * 60 * 60 * 1000 })
    );
    return res.json({ user: result.user, next: 'ready' });
  } catch (err) {
    return next(err);
  }
}

async function startEnrollment(req, res, next) {
  try {
    const result = await authService.startMfaEnrollment({ user: req.user });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function completeEnrollment(req, res, next) {
  try {
    const { code } = req.body;
    const result = await authService.completeMfaEnrollment({
      session: req.session,
      code,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    res.cookie(
      SESSION_COOKIE,
      result.token,
      sessionService.cookieOptions({ maxAgeMs: 12 * 60 * 60 * 1000 })
    );
    return res.json({
      user: result.user,
      recoveryCodes: result.recoveryCodes,
      next: 'ready',
    });
  } catch (err) {
    return next(err);
  }
}

async function me(req, res, next) {
  try {
    const memberships = await authService.listMemberships(req.user.id);
    return res.json({
      user: authService.publicUser(req.user),
      memberships: memberships.map((m) => ({
        clinic: m.clinic,
        roleKey: m.roleKey,
        reviewerEligibility: m.reviewerEligibility.status,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

// Reports authentication state without leaking anything: used by the client
// router on load to decide between login, MFA step and the app shell.
async function status(req, res) {
  if (!req.user || !req.session) {
    return res.json({ authenticated: false });
  }
  if (req.session.state === 'mfa_pending') {
    return res.json({
      authenticated: false,
      mfaPending: true,
      mfaEnrollmentRequired: Boolean(req.session.mfaEnrollmentRequired),
    });
  }
  const memberships = await authService.listMemberships(req.user.id);
  return res.json({
    authenticated: true,
    user: authService.publicUser(req.user),
    memberships: memberships.map((m) => ({
      clinic: m.clinic,
      roleKey: m.roleKey,
      reviewerEligibility: m.reviewerEligibility.status,
    })),
  });
}

async function logout(req, res, next) {
  try {
    if (req.session) {
      await sessionService.revokeSession(req.session);
    }
    sessionService.clearAuthCookies(res);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function revokeAllSessions(req, res, next) {
  try {
    await sessionService.revokeAllSessions(req.user.id);
    sessionService.clearAuthCookies(res);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function listSessions(req, res, next) {
  try {
    const Session = require('../models/Session');
    const sessions = await Session.find({
      user: req.user.id,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return res.json({
      items: sessions.map((s) => ({
        id: s.id,
        current: String(s._id) === String(req.session.id),
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        ip: s.ip,
        userAgent: s.userAgent,
      })),
    });
  } catch (err) {
    return next(err);
  }
}

async function forgotPassword(req, res, next) {
  try {
    await authService.requestPasswordReset({
      email: req.body.email,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    // Always the same answer: never reveal whether the address exists.
    return res.status(202).json({
      ok: true,
      message: 'If that address has an account, a reset link has been issued.',
    });
  } catch (err) {
    return next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    await authService.resetPassword({
      token: req.body.token,
      password: req.body.password,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    return res.json({ ok: true, message: 'Password updated. Please sign in again.' });
  } catch (err) {
    return next(err);
  }
}

async function acceptInvitation(req, res, next) {
  try {
    const { token, name, password } = req.body;
    const result = await authService.acceptInvitation({
      token,
      name,
      password,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    issueAuthCookies(res, {
      token: result.token,
      csrfToken: result.csrfToken,
      maxAgeMs: 12 * 60 * 60 * 1000,
    });
    return res.json({ user: result.user, next: result.next });
  } catch (err) {
    return next(err);
  }
}

async function createClinic(req, res, next) {
  try {
    const { clinic, membership } = await authService.createClinic({
      user: req.user,
      name: req.body.name,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    return res.status(201).json({
      clinic: { id: clinic.id, name: clinic.name, code: clinic.code },
      roleKey: membership.roleKey,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  login,
  verifyMfa,
  startEnrollment,
  completeEnrollment,
  me,
  status,
  logout,
  revokeAllSessions,
  listSessions,
  forgotPassword,
  resetPassword,
  acceptInvitation,
  createClinic,
  issueAuthCookies,
};
