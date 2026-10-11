'use strict';

// Synthetic development seed. Creates one clinic and one user per role so the
// app can be exercised end to end. Uses ONLY fabricated identities (control:
// synthetic data only; no real-patient data ever). Re-runnable.

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { loadEnv, getEnv } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const { hashPassword } = require('../src/services/passwordService');
const { SYSTEM_ROLES } = require('../src/config/constants');
const User = require('../src/models/User');
const Clinic = require('../src/models/Clinic');
const ClinicMembership = require('../src/models/ClinicMembership');
const MembershipRole = require('../src/models/MembershipRole');
const RateLimitBucket = require('../src/models/RateLimitBucket');

const SEED_PASSWORD = 'SyntheticDevPass!24';

const STAFF = [
  { email: 'admin@synthetic.invalid', name: 'Synthetic Admin', roleKey: 'admin' },
  { email: 'coordinator@synthetic.invalid', name: 'Synthetic Coordinator', roleKey: 'care_coordinator' },
  { email: 'reviewer@synthetic.invalid', name: 'Synthetic Reviewer', roleKey: 'clinical_reviewer' },
  // Dedicated Part 2 journey account: the browser test enrols THIS one through
  // the UI so it never collides with the one-time enrollment in auth.spec.
  { email: 'flow@synthetic.invalid', name: 'Synthetic Flow Coordinator', roleKey: 'care_coordinator' },
];

async function run() {
  loadEnv();
  await connectDb(getEnv().MONGODB_URI);

  // Clear throttling so a fresh development/e2e session starts unblocked.
  await RateLimitBucket.deleteMany({});

  let clinic = await Clinic.findOne({ code: 'SYNTHCLINIC' });
  if (!clinic) {
    clinic = await Clinic.create({ name: 'Synthetic Recovery Clinic', code: 'SYNTHCLINIC' });
    // eslint-disable-next-line no-console
    console.log('Created synthetic clinic:', clinic.code);
  }

  // Refresh the role catalog on EVERY run. Role definitions evolve between
  // parts (for example Part 2 adds consent/caregiver permissions), so a
  // pre-existing clinic must be upgraded rather than left on a stale catalog -
  // otherwise the seeded accounts hold the wrong permissions.
  for (const r of SYSTEM_ROLES) {
    await MembershipRole.updateOne(
      { clinic: clinic.id, key: r.key },
      {
        $set: { name: r.name, permissions: [...r.permissions], isSystem: true },
        $setOnInsert: { clinic: clinic.id, key: r.key },
      },
      { upsert: true }
    );
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);
  for (const member of STAFF) {
    let user = await User.findOne({ email: member.email });
    if (!user) {
      user = await User.create({
        email: member.email,
        name: member.name,
        passwordHash,
      });
    }
    // Reset each synthetic account to a known state so the documented journey
    // (sign in -> forced MFA enrollment) is always reproducible. This seed is
    // development-only and resets MFA deliberately.
    user.name = member.name;
    user.passwordHash = passwordHash;
    user.status = 'active';
    user.mfa = { enabled: false };
    await user.save();

    const eligibility =
      member.roleKey === 'clinical_reviewer'
        ? { status: 'verified', verifiedAt: new Date() }
        : { status: 'not_applicable' };
    const existing = await ClinicMembership.findOne({ clinic: clinic.id, user: user.id });
    if (!existing) {
      await ClinicMembership.create({
        clinic: clinic.id,
        user: user.id,
        roleKey: member.roleKey,
        status: 'active',
        reviewerEligibility: eligibility,
      });
      // eslint-disable-next-line no-console
      console.log(`Seeded ${member.roleKey}: ${member.email}`);
    } else {
      existing.roleKey = member.roleKey;
      existing.status = 'active';
      existing.reviewerEligibility = eligibility;
      await existing.save();
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\nAll synthetic accounts share password: ${SEED_PASSWORD}`);
  // eslint-disable-next-line no-console
  console.log('These are fabricated identities for development only.\n');

  await disconnectDb();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err.message);
  process.exit(1);
});
