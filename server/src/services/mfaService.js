'use strict';

// TOTP enrollment and verification (control #4). The shared secret is
// generated server-side, stored encrypted, and only shown to the enrolling
// user over an authenticated channel. Recovery codes are hashed, single-use
// and consumed with an atomic conditional update.
const crypto = require('node:crypto');
const otpauth = require('otpauth');
const { hmac, sealSecret, openSecret } = require('./crypto');
const { MFA_RECOVERY_CODE_COUNT } = require('../config/constants');
const MfaRecoveryCode = require('../models/MfaRecoveryCode');
const { getEnv } = require('../config/env');

const ISSUER = 'Velora';

function buildTotp({ secretBase32, account }) {
  return new otpauth.TOTP({
    issuer: ISSUER,
    label: account,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: otpauth.Secret.fromBase32(secretBase32),
  });
}

function createEnrollment(user, { secretBase32 } = {}) {
  // Reusing an existing unconfirmed secret keeps enrollment idempotent: a
  // double-fired setup call (StrictMode) or a page refresh must always show
  // the SAME secret that is actually stored, never a divergent one.
  const secret = secretBase32
    ? otpauth.Secret.fromBase32(secretBase32)
    : new otpauth.Secret({ size: 20 });
  const totp = buildTotp({ secretBase32: secret.base32, account: user.email });
  return {
    secretEnc: sealSecret(secret.base32),
    otpauthUrl: totp.toString(),
    secretBase32: secret.base32,
  };
}

async function verifyTotp(user, code) {
  const sealed = user.mfa && user.mfa.secretEnc;
  if (!sealed) return false;
  let secretBase32;
  try {
    secretBase32 = openSecret(sealed);
  } catch {
    return false;
  }
  const totp = buildTotp({ secretBase32, account: user.email });
  return totp.validate({ token: String(code).trim(), window: 1 }) !== null;
}

async function generateRecoveryCodes(userId) {
  const codes = [];
  for (let i = 0; i < MFA_RECOVERY_CODE_COUNT; i += 1) {
    codes.push(crypto.randomBytes(5).toString('hex')); // 10 hex chars
  }
  await MfaRecoveryCode.deleteMany({ user: userId });
  await MfaRecoveryCode.insertMany(
    codes.map((code) => ({ user: userId, codeHash: hmac(code) }))
  );
  return codes;
}

// Atomic single-use consumption: a replayed code finds usedAt already set.
async function consumeRecoveryCode(userId, code) {
  const result = await MfaRecoveryCode.findOneAndUpdate(
    { user: userId, codeHash: hmac(String(code).trim()), usedAt: null },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
  return Boolean(result);
}

function enrollmentLabel(env, email) {
  return env.NODE_ENV === 'production' ? email : `${email} (${env.NODE_ENV})`;
}

module.exports = {
  createEnrollment,
  verifyTotp,
  generateRecoveryCodes,
  consumeRecoveryCode,
  enrollmentLabel,
};
