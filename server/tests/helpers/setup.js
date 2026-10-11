'use strict';

// Shared integration-test harness. Sets a deterministic test environment
// BEFORE any app module loads, connects to the test database, and exposes
// factories that mirror real signup/invite flows.
process.env.NODE_ENV = 'test';
process.env.PORT = '4199';
// Integration tests need a replica set so transactions are available (the
// Part 2+ invariants depend on them). Start one with:
//   npm run mongo:test-rs -w server
process.env.MONGODB_TEST_URI =
  process.env.MONGODB_TEST_URI ||
  'mongodb://127.0.0.1:27019/velora_test?replicaSet=rs0';
process.env.MONGODB_URI = process.env.MONGODB_TEST_URI;
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
process.env.SESSION_PEPPER = 'test_pepper_0123456789abcdef';
process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
process.env.SESSION_TTL_HOURS = '12';
// Part 4 document storage: a disposable root OUTSIDE the repository (the env
// validator rejects an in-repo root) plus a dedicated document key.
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DOCUMENT_STORAGE_ROOT =
  process.env.DOCUMENT_STORAGE_ROOT ||
  path.join(os.tmpdir(), 'velora-documents-test');
process.env.DOCUMENT_ENCRYPTION_KEY =
  process.env.DOCUMENT_ENCRYPTION_KEY || Buffer.alloc(32, 9).toString('base64');

const mongoose = require('mongoose');
const { loadEnv } = require('../../src/config/env');
const { connectDb, disconnectDb } = require('../../src/config/db');
const { buildApp } = require('../../src/app');
const { hashPassword } = require('../../src/services/passwordService');
const { SYSTEM_ROLES } = require('../../src/config/constants');
const { hmac } = require('../../src/services/crypto');

const User = require('../../src/models/User');
const Clinic = require('../../src/models/Clinic');
const ClinicMembership = require('../../src/models/ClinicMembership');
const MembershipRole = require('../../src/models/MembershipRole');
const Invitation = require('../../src/models/Invitation');
const PasswordReset = require('../../src/models/PasswordReset');
const Session = require('../../src/models/Session');
const AuditEvent = require('../../src/models/AuditEvent');
const MfaRecoveryCode = require('../../src/models/MfaRecoveryCode');
const RateLimitBucket = require('../../src/models/RateLimitBucket');
const PatientProfile = require('../../src/models/PatientProfile');
const PatientAssignment = require('../../src/models/PatientAssignment');
const PatientConsent = require('../../src/models/PatientConsent');
const CaregiverGrant = require('../../src/models/CaregiverGrant');
const AccessInvitation = require('../../src/models/AccessInvitation');
const RecoveryEpisode = require('../../src/models/RecoveryEpisode');
const EpisodeDocument = require('../../src/models/EpisodeDocument');
const CareTeamAssignment = require('../../src/models/CareTeamAssignment');
const EpisodeCorrection = require('../../src/models/EpisodeCorrection');

let counter = 0;
function uniq(prefix) {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

async function init() {
  loadEnv();
  await connectDb(process.env.MONGODB_TEST_URI);
  // Fail closed with an actionable message rather than a cryptic driver error
  // in whichever test first needs a transaction.
  try {
    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await mongoose.connection.db.collection('velora_tx_probe').insertOne({ ok: 1 }, { session });
    });
    await session.endSession();
  } catch (err) {
    throw new Error(
      `Integration tests require a replica-set MongoDB (transactions unavailable: ${err.message}). ` +
        'Start one with `npm run mongo:test-rs -w server` and set MONGODB_TEST_URI accordingly.'
    );
  }
  // Build every model's indexes BEFORE any test runs. Mongoose builds indexes
  // lazily, so a parallel-insert race could otherwise slip past a unique index
  // that has not been created yet.
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init())
  );
  return buildApp();
}

async function resetDb() {
  const collections = [
    User, Clinic, ClinicMembership, MembershipRole, Invitation,
    PasswordReset, Session, AuditEvent, MfaRecoveryCode, RateLimitBucket,
    PatientProfile, PatientAssignment, PatientConsent, CaregiverGrant, AccessInvitation,
    RecoveryEpisode, CareTeamAssignment, EpisodeCorrection, EpisodeDocument,
  ];
  // Remove every stored object so a test can never observe a prior test's bytes.
  const objectsDir = path.join(process.env.DOCUMENT_STORAGE_ROOT, 'objects');
  fs.rmSync(objectsDir, { recursive: true, force: true });
  // Delete through the raw driver so model-level invariants (for example the
  // append-only consent guard) do not block the harness's own reset.
  for (const model of collections) {
    await model.collection.deleteMany({});
  }
}

// Creates clinic + role catalog + one active member per requested role.
async function makeClinic({ codePrefix = 'CLINIC', adminEmail } = {}) {
  const code = uniq(codePrefix).toUpperCase().replace(/[^A-Z0-9]/g, '-').slice(0, 24);
  const clinic = await Clinic.create({ name: `Test Clinic ${code}`, code });
  await MembershipRole.insertMany(
    SYSTEM_ROLES.map((r) => ({
      clinic: clinic.id,
      key: r.key,
      name: r.name,
      permissions: [...r.permissions],
      isSystem: true,
    }))
  );
  const admin = await makeMember(clinic, {
    email: adminEmail || uniq('admin') + '@synthetic.invalid',
    roleKey: 'admin',
  });
  return { clinic, admin };
}

async function makeMember(clinic, { email, roleKey, eligibility } = {}) {
  const user = await User.create({
    email: email || uniq(roleKey) + '@synthetic.invalid',
    name: `Test ${roleKey}`,
    passwordHash: await hashPassword('SyntheticTestPass!24'),
  });
  const membership = await ClinicMembership.create({
    clinic: clinic.id,
    user: user.id,
    roleKey,
    status: 'active',
    reviewerEligibility: {
      status:
        eligibility ||
        (roleKey === 'clinical_reviewer' ? 'pending' : 'not_applicable'),
    },
  });
  return { user, membership };
}

// Logs a user in through the real HTTP stack and returns a cookie-holding
// agent. `withMfa` completes a real TOTP enrollment first.
function agent(app) {
  const request = require('supertest');
  return request.agent(app);
}

async function login(app, email, password) {
  const a = agent(app);
  const res = await a
    .post('/api/auth/login')
    .send({ email, password: password || 'SyntheticTestPass!24' });
  return { a, login: res, csrf: csrfFrom(res) };
}

// Extracts the velora_csrf value from a response's Set-Cookie headers. The
// CSRF cookie does not rotate across MFA promotion, so the value issued at
// login stays valid for the whole session.
function csrfFrom(res) {
  const headers = res.headers && res.headers['set-cookie'];
  if (!headers) return undefined;
  for (const raw of headers) {
    const match = /^velora_csrf=([^;]+)/.exec(raw);
    if (match) return match[1];
  }
  return undefined;
}

// Convenience: TOTP code from a base32 secret (dev/test only exposure).
function totpCode(base32, label) {
  const otpauth = require('otpauth');
  const totp = new otpauth.TOTP({
    issuer: 'Velora',
    label: label || 'test@synthetic.invalid',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: otpauth.Secret.fromBase32(base32),
  });
  return totp.generate();
}

// Drives the full enrollment: setup -> verify -> returns recovery codes.
async function enrollMfa(a, csrf, email) {
  const setup = await a.post('/api/auth/mfa/enroll/setup').set('X-CSRF-Token', csrf);
  const code = totpCode(setup.body.secretBase32, email);
  const verify = await a
    .post('/api/auth/mfa/enroll/verify')
    .set('X-CSRF-Token', csrf)
    .send({ code });
  return { setup, verify, recoveryCodes: verify.body.recoveryCodes || [] };
}

// Full sign-in that stops at the MFA prompt: returns the agent plus the CSRF
// token needed for the pending-verification calls that follow.
async function loginPendingMfa(app, email) {
  const a = agent(app);
  const login = await a
    .post('/api/auth/login')
    .send({ email, password: 'SyntheticTestPass!24' });
  return { a, login, csrf: csrfFrom(login) };
}

// Full staff sign-in through the real HTTP stack, including forced MFA
// enrollment for a freshly created member. Returns an authenticated agent.
async function signInStaff(app, email, password) {
  const a = agent(app);
  const login = await a
    .post('/api/auth/login')
    .send({ email, password: password || 'SyntheticTestPass!24' });
  const csrf = csrfFrom(login);
  if (login.body.next === 'mfa_enroll') {
    await enrollMfa(a, csrf, email);
  }
  return { a, csrf, login };
}

// Convenience factory: create a patient as an authenticated staff agent.
async function createPatient(a, csrf, body) {
  return a.post('/api/patients').set('X-CSRF-Token', csrf).send(body);
}

async function shutdown() {
  await disconnectDb();
  await mongoose.connection.close().catch(() => {});
}

module.exports = {
  init,
  resetDb,
  makeClinic,
  makeMember,
  agent,
  login,
  csrfFrom,
  totpCode,
  enrollMfa,
  loginPendingMfa,
  signInStaff,
  createPatient,
  shutdown,
  uniq,
  hmac,
  models: {
    User, Clinic, ClinicMembership, MembershipRole, Invitation,
    PasswordReset, Session, AuditEvent, MfaRecoveryCode, RateLimitBucket,
    PatientProfile, PatientAssignment, PatientConsent, CaregiverGrant, AccessInvitation,
    RecoveryEpisode, CareTeamAssignment, EpisodeCorrection, EpisodeDocument,
  },
};
