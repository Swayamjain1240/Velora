'use strict';

const express = require('express');
const authController = require('../controllers/authController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const {
  requireAuth,
  requireMfaPendingSession,
} = require('../middleware/auth');
const schemas = require('../validators/schemas');

const router = express.Router();

// Abuse-sensitive limits (control #8), keyed by identity where available.
const loginLimit = mongoRateLimit({
  keyPrefix: 'login',
  limit: 10,
  windowMs: 15 * 60 * 1000,
  keyFn: (req) => `${req.clientIp}|${(req.body && req.body.email) || ''}`,
});
const mfaLimit = mongoRateLimit({
  keyPrefix: 'mfa',
  limit: 10,
  windowMs: 15 * 60 * 1000,
  keyFn: (req) => (req.session ? String(req.session.id) : req.clientIp),
});
const forgotLimit = mongoRateLimit({
  keyPrefix: 'forgot',
  limit: 5,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => `${req.clientIp}|${(req.body && req.body.email) || ''}`,
});
const resetLimit = mongoRateLimit({
  keyPrefix: 'reset',
  limit: 10,
  windowMs: 60 * 60 * 1000,
});
const inviteAcceptLimit = mongoRateLimit({
  keyPrefix: 'invite-accept',
  limit: 10,
  windowMs: 60 * 60 * 1000,
});
const clinicCreateLimit = mongoRateLimit({
  keyPrefix: 'clinic-create',
  limit: 10,
  windowMs: 60 * 60 * 1000,
});

router.post(
  '/login',
  loginLimit,
  validate({ body: schemas.loginSchema }),
  authController.login
);

router.post(
  '/mfa/verify',
  mfaLimit,
  requireMfaPendingSession,
  validate({ body: schemas.mfaVerifySchema }),
  authController.verifyMfa
);

router.post(
  '/mfa/enroll/setup',
  requireMfaPendingSession,
  authController.startEnrollment
);

router.post(
  '/mfa/enroll/verify',
  mfaLimit,
  requireMfaPendingSession,
  validate({ body: schemas.mfaEnrollVerifySchema }),
  authController.completeEnrollment
);

router.get('/status', authController.status);
router.get('/me', requireAuth, authController.me);
router.get('/sessions', requireAuth, authController.listSessions);
router.post('/logout', authController.logout);
router.post('/sessions/revoke-all', requireAuth, authController.revokeAllSessions);

router.post(
  '/password/forgot',
  forgotLimit,
  validate({ body: schemas.forgotPasswordSchema }),
  authController.forgotPassword
);

router.post(
  '/password/reset',
  resetLimit,
  validate({ body: schemas.resetPasswordSchema }),
  authController.resetPassword
);

router.post(
  '/accept-invitation',
  inviteAcceptLimit,
  validate({ body: schemas.acceptInvitationSchema }),
  authController.acceptInvitation
);

router.post(
  '/clinics',
  requireAuth,
  clinicCreateLimit,
  validate({ body: schemas.createClinicSchema }),
  authController.createClinic
);

module.exports = router;
