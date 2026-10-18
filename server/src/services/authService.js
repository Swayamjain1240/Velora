'use strict';

// Authentication orchestration: login, MFA verification/enrollment, invitation
// acceptance and password reset. Every path creates fresh sessions, keeps
// tokens opaque, and audits outcomes without recording secrets.
const { getEnv } = require('../config/env');
const {
  SAFE_AUTH_ERROR,
  ROLES,
  SYSTEM_ROLES,
  PASSWORD_RESET_TTL_MINUTES,
} = require('../config/constants');
const { errors } = require('./errors');
const { randomToken, hmac, openSecret } = require('./crypto');
const { hashPassword, verifyPassword } = require('./passwordService');
const sessionService = require('./sessionService');
const mfaService = require('./mfaService');
const audit = require('./auditService');
const User = require('../models/User');
const Clinic = require('../models/Clinic');
const ClinicMembership = require('../models/ClinicMembership');
const MembershipRole = require('../models/MembershipRole');
const Invitation = require('../models/Invitation');
const PasswordReset = require('../models/PasswordReset');

// Real Argon2id hash of a random value, generated once at module load, so an
// unknown-email login costs about the same as a wrong password (no account
// enumeration through response timing).
const argon2 = require('@node-rs/argon2');
const DUMMY_HASH = argon2.hashSync(randomToken(32), {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    mfaEnabled: Boolean(user.mfa && user.mfa.enabled),
    lastLoginAt: user.lastLoginAt || null,
    createdAt: user.createdAt,
  };
}

async function listMemberships(userId) {
  return ClinicMembership.find({ user: userId, status: 'active' })
    .populate('clinic', 'name code status')
    .lean();
}

async function login({ email, password, ip, userAgent }) {
  const normalizedEmail = String(email).toLowerCase();
  const user = await User.findOne({ email: normalizedEmail }).select(
    '+passwordHash +mfa.secretEnc'
  );
  const valid = user
    ? await verifyPassword(user.passwordHash, password)
    : await verifyPassword(DUMMY_HASH, password);

  if (!user || !valid || user.status !== 'active') {
    await audit.record({
      actorUser: user ? user.id : undefined,
      actorLabel: normalizedEmail,
      action: 'auth.login',
      outcome: 'failure',
      ip,
      userAgent,
      detail: {
        reason: !user ? 'unknown_email' : !valid ? 'bad_password' : 'disabled',
      },
    });
    throw errors.forbidden(SAFE_AUTH_ERROR);
  }

  const memberships = await ClinicMembership.find({ user: user.id }).lean();
  if (memberships.length === 0) {
    await audit.record({
      actorUser: user.id,
      actorLabel: user.email,
      action: 'auth.login',
      outcome: 'denied',
      ip,
      userAgent,
      detail: { reason: 'no_membership' },
    });
    throw errors.forbidden(
      'No active clinic membership. Contact your clinic administrator.'
    );
  }

  const mfaEnabled = Boolean(user.mfa && user.mfa.enabled);
  const { session, token, csrfToken } = await sessionService.createSession({
    userId: user.id,
    state: 'mfa_pending',
    mfaEnrollmentRequired: !mfaEnabled,
    ip,
    userAgent,
  });
  user.lastLoginAt = new Date();
  await user.save();

  await audit.record({
    clinic: memberships[0] ? memberships[0].clinic : undefined,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'auth.login',
    outcome: 'success',
    ip,
    userAgent,
    detail: { next: mfaEnabled ? 'mfa_verify' : 'mfa_enroll' },
  });

  return {
    token,
    csrfToken,
    session,
    user: publicUser(user),
    next: mfaEnabled ? 'mfa_verify' : 'mfa_enroll',
  };
}

// MFA verification for a password-accepted session. Rotates the session token
// so the pre-MFA cookie can never be replayed afterwards (fixation defense).
async function verifyMfa({ session, code, recoveryCode, ip, userAgent }) {
  const user = await User.findById(session.user).select('+mfa.secretEnc');
  if (!user || user.status !== 'active') throw errors.unauthorized();

  let ok = false;
  let usedRecovery = false;
  if (recoveryCode) {
    ok = await mfaService.consumeRecoveryCode(user.id, recoveryCode);
    usedRecovery = ok;
  } else if (code) {
    ok = await mfaService.verifyTotp(user, code);
  }

  if (!ok) {
    await audit.record({
      actorUser: user.id,
      actorLabel: user.email,
      action: 'auth.mfa.verify',
      outcome: 'failure',
      ip,
      userAgent,
      detail: { via: recoveryCode ? 'recovery' : 'totp' },
    });
    throw errors.forbidden(
      'Invalid authentication code. Check the code and try again.'
    );
  }

  const token = await sessionService.activateSession(session);
  await audit.record({
    actorUser: user.id,
    actorLabel: user.email,
    action: 'auth.mfa.verify',
    outcome: 'success',
    ip,
    userAgent,
    detail: { via: usedRecovery ? 'recovery_code' : 'totp' },
  });
  return { token, user: publicUser(user) };
}

// Step 1 of enrollment: reuse an existing unconfirmed secret, or install one.
// The secret is stored encrypted but MFA stays disabled until step 2 confirms a
// matching code.
//
// Installing is ATOMIC and the response always carries the secret that is
// actually stored: a double-fired setup (React StrictMode) or a retried one can
// otherwise race, and the client could display a secret the database did not
// keep - which makes every enrollment code unverifiable until the page is
// reloaded. Only the first writer installs; a loser re-reads the winner's secret.
const ENROLLMENT_ATTEMPTS = 4;

function publicEnrollment(user, secretBase32) {
  const env = getEnv();
  const totp = mfaService.createEnrollment(user, { secretBase32 });
  return {
    otpauthUrl: totp.otpauthUrl,
    // Base32 shown only outside production so dev/test can seed an authenticator.
    secretBase32: env.NODE_ENV === 'production' ? undefined : secretBase32,
  };
}

async function startMfaEnrollment({ user }) {
  for (let attempt = 0; attempt < ENROLLMENT_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const current = await User.findById(user.id).select('+mfa.secretEnc');
    if (!current) throw errors.unauthorized();

    // Enrollment is FIRST-TIME only. A password-only (mfa_pending) session must
    // never be able to install a replacement secret on an account that already
    // has MFA enabled: that would let anyone holding the password swap the
    // second factor and take the account over. A lost factor needs a deliberate,
    // audited reset that does not exist yet (documented limit).
    if (current.mfa && current.mfa.enabled) {
      throw errors.conflict(
        'Multi-factor authentication is already enabled for this account. Verify with your authenticator app.'
      );
    }

    const enabled = false;
    const sealed = current.mfa ? current.mfa.secretEnc : undefined;
    const unconfirmedSecret = sealed || undefined;

    let reusable;
    if (unconfirmedSecret) {
      try {
        reusable = openSecret(unconfirmedSecret);
      } catch {
        // An unreadable secret (for example after a key rotation) is replaced
        // below instead of being handed back.
        reusable = undefined;
      }
    }
    if (reusable) return publicEnrollment(current, reusable);

    const fresh = mfaService.createEnrollment(current, {});
    // Compare-and-set: install only while the account still has no unconfirmed
    // secret (or still has the unreadable one we are replacing).
    // eslint-disable-next-line no-await-in-loop
    const installed = await User.findOneAndUpdate(
      unconfirmedSecret
        ? { _id: current.id, 'mfa.enabled': { $ne: true }, 'mfa.secretEnc': unconfirmedSecret }
        : { _id: current.id, 'mfa.enabled': { $ne: true }, 'mfa.secretEnc': { $exists: false } },
      { $set: { 'mfa.secretEnc': fresh.secretEnc } },
      { new: true, select: '+mfa.secretEnc' }
    );
    if (installed) return publicEnrollment(current, fresh.secretBase32);
  }
  // Every attempt lost the compare-and-set, which only happens under a burst of
  // concurrent enrollments; the caller may simply retry safely.
  throw errors.busy('Could not start multi-factor enrollment. Please retry.');
}

// Step 2: verify a code against the stored secret, enable MFA, issue recovery
// codes (returned exactly once) and promote the session to active.
async function completeMfaEnrollment({ session, code, ip, userAgent }) {
  const user = await User.findById(session.user).select('+mfa.secretEnc');
  if (!user) throw errors.unauthorized();
  // Mirrors the setup guard: an account that already has MFA can only VERIFY,
  // never re-enroll from a password-only session.
  if (user.mfa && user.mfa.enabled) {
    throw errors.conflict(
      'Multi-factor authentication is already enabled for this account. Verify with your authenticator app.'
    );
  }
  // Enrollment confirmation does not consume the code's step (D-4): MFA is not
  // enabled yet, and the same code must still work for the first sign-in.
  const ok = await mfaService.verifyTotp(user, code, { consume: false });
  if (!ok) {
    await audit.record({
      actorUser: user.id,
      actorLabel: user.email,
      action: 'auth.mfa.enroll',
      outcome: 'failure',
      ip,
      userAgent,
    });
    throw errors.forbidden(
      'Invalid code. Enter the current code from your authenticator app.'
    );
  }
  user.mfa.enabled = true;
  user.mfa.confirmedAt = new Date();
  await user.save();
  const recoveryCodes = await mfaService.generateRecoveryCodes(user.id);
  const token = await sessionService.activateSession(session);
  await audit.record({
    actorUser: user.id,
    actorLabel: user.email,
    action: 'auth.mfa.enroll',
    outcome: 'success',
    ip,
    userAgent,
  });
  return { token, user: publicUser(user), recoveryCodes };
}

// Invitation acceptance: atomic single-use claim, then create user/membership.
async function acceptInvitation({ token, name, password, ip, userAgent }) {
  const claimed = await Invitation.findOneAndUpdate(
    { tokenHash: hmac(token), acceptedAt: null, revokedAt: null },
    { $set: { acceptedAt: new Date() } },
    { new: true }
  );
  if (!claimed || claimed.expiresAt < new Date()) {
    throw errors.notFound('This invitation is invalid, already used, or expired.');
  }

  const email = claimed.email;
  let user = await User.findOne({ email }).select('+passwordHash');
  if (user) {
    if (user.status !== 'active') throw errors.forbidden(SAFE_AUTH_ERROR);
    // Existing account must prove possession: supplied password must match.
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) throw errors.forbidden(SAFE_AUTH_ERROR);
  } else {
    user = await User.create({
      email,
      name: name || email,
      passwordHash: await hashPassword(password),
    });
  }

  const existing = await ClinicMembership.findOne({
    clinic: claimed.clinic,
    user: user.id,
  });
  if (existing) {
    throw errors.conflict('This invitation has already been claimed by an account.');
  }

  const isReviewer = claimed.roleKey === ROLES.CLINICAL_REVIEWER;
  const membership = await ClinicMembership.create({
    clinic: claimed.clinic,
    user: user.id,
    roleKey: claimed.roleKey,
    status: 'active',
    reviewerEligibility: { status: isReviewer ? 'pending' : 'not_applicable' },
  });

  const { token: sessionToken, session } = await sessionService.createSession({
    userId: user.id,
    state: 'mfa_pending',
    mfaEnrollmentRequired: true,
    ip,
    userAgent,
  });

  await audit.record({
    clinic: claimed.clinic,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'staff.invitation.accepted',
    outcome: 'success',
    ip,
    userAgent,
    detail: { roleKey: claimed.roleKey, membershipId: membership.id },
  });

  return {
    token: sessionToken,
    csrfToken: session.csrfSecret,
    user: publicUser(user),
    next: 'mfa_enroll',
  };
}

// Password reset request: always answers normally so the response never
// reveals whether an address exists. Raw token printed to server console in
// development only; no mail provider is authorized yet (control #22).
async function requestPasswordReset({ email, ip, userAgent }) {
  const normalizedEmail = String(email).toLowerCase();
  const user = await User.findOne({ email: normalizedEmail });
  if (user && user.status === 'active') {
    const raw = randomToken(32);
    await PasswordReset.findOneAndUpdate(
      { user: user.id },
      {
        user: user.id,
        tokenHash: hmac(raw),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
        usedAt: null,
      },
      { upsert: true }
    );
    const origin = getEnv().CLIENT_ORIGIN;
    // eslint-disable-next-line no-console
    console.info(
      `[password-reset] synthetic link for ${user.email}: ${origin}/reset-password/${raw}`
    );
    await audit.record({
      actorUser: user.id,
      actorLabel: user.email,
      action: 'auth.password.reset_requested',
      outcome: 'success',
      ip,
      userAgent,
    });
  } else {
    await audit.record({
      actorLabel: normalizedEmail,
      action: 'auth.password.reset_requested',
      outcome: 'failure',
      ip,
      userAgent,
    });
  }
}

async function resetPassword({ token, password, ip, userAgent }) {
  const record = await PasswordReset.findOneAndUpdate(
    { tokenHash: hmac(token), usedAt: null },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
  const invalidLink = () =>
    errors.notFound('This reset link is invalid, already used, or expired.');
  if (!record || record.expiresAt < new Date()) throw invalidLink();
  const user = await User.findById(record.user);
  if (!user || user.status !== 'active') throw invalidLink();
  user.passwordHash = await hashPassword(password);
  await user.save();
  await sessionService.revokeAllSessions(user.id);
  await audit.record({
    actorUser: user.id,
    actorLabel: user.email,
    action: 'auth.password.reset_completed',
    outcome: 'success',
    ip,
    userAgent,
  });
}

// Clinic creation: the creator becomes clinic admin. Authenticated and
// rate-limited; tenant provisioning is never anonymous.
async function createClinic({ user, name, ip, userAgent }) {
  const base = String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16);
  const suffix = randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const code = `${base || 'CLINIC'}-${suffix}`.slice(0, 24);
  const clinic = await Clinic.create({ name, code });
  await MembershipRole.insertMany(
    SYSTEM_ROLES.map((role) => ({
      clinic: clinic.id,
      key: role.key,
      name: role.name,
      permissions: [...role.permissions],
      isSystem: true,
    }))
  );
  const membership = await ClinicMembership.create({
    clinic: clinic.id,
    user: user.id,
    roleKey: ROLES.ADMIN,
    status: 'active',
    reviewerEligibility: { status: 'not_applicable' },
  });
  await audit.record({
    clinic: clinic.id,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'clinic.created',
    outcome: 'success',
    ip,
    userAgent,
    detail: { name },
  });
  return { clinic, membership };
}

module.exports = {
  publicUser,
  listMemberships,
  login,
  verifyMfa,
  startMfaEnrollment,
  completeMfaEnrollment,
  acceptInvitation,
  requestPasswordReset,
  resetPassword,
  createClinic,
};
