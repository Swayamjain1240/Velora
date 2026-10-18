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
const User = require('../models/User');
const { getEnv } = require('../config/env');

const ISSUER = 'Velora';
const TOTP_PERIOD_SECONDS = 30;

function currentTotpStep(now = Date.now()) {
  return Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
}

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

// D-4: a TOTP code is a time-window token, so without a claim the same six
// digits can authenticate two separate pending sessions. Verification therefore
// claims the accepted counter STEP atomically on the user: only a step strictly
// newer than the last accepted one succeeds, so a replay (including a replay of
// the neighbouring window `window: 1` tolerates) is refused. Enrollment
// confirmation passes `consume: false`: MFA is not yet enabled on that account,
// so a code replayed there authenticates nobody, and a true first login right
// after enrollment must still accept the code the user just typed.
async function verifyTotp(user, code, { consume = true } = {}) {
  const sealed = user.mfa && user.mfa.secretEnc;
  if (!sealed) return false;
  let secretBase32;
  try {
    secretBase32 = openSecret(sealed);
  } catch {
    return false;
  }
  const totp = buildTotp({ secretBase32, account: user.email });
  const delta = totp.validate({ token: String(code).trim(), window: 1 });
  if (delta === null) return false;
  if (!consume) return true;

  const step = currentTotpStep() + delta;
  const claimed = await User.findOneAndUpdate(
    {
      _id: user.id,
      $or: [
        { 'mfa.lastTotpStep': { $exists: false } },
        { 'mfa.lastTotpStep': { $lt: step } },
      ],
    },
    { $set: { 'mfa.lastTotpStep': step } },
    { new: true, projection: { _id: 1 } }
  );
  return Boolean(claimed);
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
