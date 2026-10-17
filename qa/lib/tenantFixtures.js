'use strict';

// Tenant-isolation fixture: ensures a SECOND synthetic clinic exists in the
// disposable test database with its own staff account, so live cross-clinic
// IDOR probes have a genuinely foreign session. All identities are synthetic
// (`.invalid` domains) and only ever written to `velora_test`.
const path = require('node:path');
const mongoose = require('mongoose');
const { qaEnv, REPO } = require('./qaEnv');

async function withDb(fn) {
  const env = {
    ...process.env,
    ...qaEnv,
    DOCUMENT_PARSER_TIMEOUT_MS: qaEnv.DOCUMENT_PARSER_TIMEOUT_MS,
  };
  // Loader order: set env BEFORE server modules load.
  for (const [k, v] of Object.entries(qaEnv)) process.env[k] = v;
  const { loadEnv } = require('../../server/src/config/env');
  loadEnv();
  await mongoose.connect(qaEnv.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    return await fn();
  } finally {
    await mongoose.connection.close();
  }
}

const CLINIC_B_CODE = 'QNORBCLINIC';

// Idempotent: safe to run before every probe run.
async function ensureTenantB() {
  return withDb(async () => {
    const Clinic = require('../../server/src/models/Clinic');
    const MembershipRole = require('../../server/src/models/MembershipRole');
    const ClinicMembership = require('../../server/src/models/ClinicMembership');
    const User = require('../../server/src/models/User');
    const { SYSTEM_ROLES } = require('../../server/src/config/constants');
    const { hashPassword } = require('../../server/src/services/passwordService');

    let clinic = await Clinic.findOne({ code: CLINIC_B_CODE });
    if (!clinic) {
      clinic = await Clinic.create({ name: 'Synthetic Foreign Clinic B', code: CLINIC_B_CODE });
      await MembershipRole.insertMany(
        SYSTEM_ROLES.map((r) => ({
          clinic: clinic.id,
          key: r.key,
          name: r.name,
          permissions: [...r.permissions],
          isSystem: true,
        }))
      );
    }
    const email = 'foreign.coordinator@synthetic.invalid';
    let user = await User.findOne({ email });
    const password = 'SyntheticDevPass!24';
    if (!user) {
      user = await User.create({
        email,
        name: 'Synthetic Foreign Coordinator',
        passwordHash: await hashPassword(password),
      });
    }
    await ClinicMembership.updateOne(
      { clinic: clinic.id, user: user.id },
      {
        // A COORDINATOR (not an admin) so the cross-tenant probes exercise the
        // clinical-data permission path - an admin intentionally holds no
        // clinical permission in this product.
        $set: {
          roleKey: 'care_coordinator',
          status: 'active',
          reviewerEligibility: { status: 'not_applicable' },
        },
        $setOnInsert: { clinic: clinic.id, user: user.id },
      },
      { upsert: true }
    );
    return { email, password, clinicId: String(clinic._id) };
  });
}

// Re-runs the project's seed script against the disposable test DB (synthetic
// data only). Used by ensureSession when a cached session died (e.g. after a
// revoke-all probe) so re-login follows the real forced-enrolment path.
function reseed() {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync(process.execPath, [path.join(REPO, 'server', 'scripts', 'seed.js')], {
    cwd: REPO,
    env: { ...process.env, ...qaEnv },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (res.status !== 0) {
    throw new Error(`seed failed (${res.status}): ${(res.stderr || res.stdout || '').slice(0, 500)}`);
  }
  return res.stdout;
}

// Removes an unknown TOTP enrolment for ONE synthetic user so a probe session
// can follow the documented forced-enrolment path again (the secret from a
// previous run is unrecoverable by design - it is AES-sealed). Test-DB fixture
// only; it never runs against a real deployment and no secret value is read.
async function clearMfa(email) {
  return withDb(async () => {
    const users = mongoose.connection.db.collection('users');
    const u = await users.findOne({ email: email.toLowerCase() });
    if (!u) return false;
    await users.updateOne(
      { _id: u._id },
      { $set: { 'mfa.enabled': false }, $unset: { 'mfa.secretEnc': '', 'mfa.confirmedAt': '' } }
    );
    await mongoose.connection.db.collection('mfarecoverycodes').deleteMany({ user: u._id });
    return true;
  });
}

module.exports = { ensureTenantB, reseed, clearMfa, CLINIC_B_CODE };