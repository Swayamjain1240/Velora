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

const SEED_PASSWORD = 'SyntheticDevPass!24';

const STAFF = [
  { email: 'admin@synthetic.invalid', name: 'Synthetic Admin', roleKey: 'admin' },
  { email: 'coordinator@synthetic.invalid', name: 'Synthetic Coordinator', roleKey: 'care_coordinator' },
  { email: 'reviewer@synthetic.invalid', name: 'Synthetic Reviewer', roleKey: 'clinical_reviewer' },
];

async function run() {
  loadEnv();
  await connectDb(getEnv().MONGODB_URI);

  let clinic = await Clinic.findOne({ code: 'SYNTHCLINIC' });
  if (!clinic) {
    clinic = await Clinic.create({ name: 'Synthetic Recovery Clinic', code: 'SYNTHCLINIC' });
    await MembershipRole.insertMany(
      SYSTEM_ROLES.map((r) => ({
        clinic: clinic.id,
        key: r.key,
        name: r.name,
        permissions: [...r.permissions],
        isSystem: true,
      }))
    );
    // eslint-disable-next-line no-console
    console.log('Created synthetic clinic:', clinic.code);
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
    const existing = await ClinicMembership.findOne({ clinic: clinic.id, user: user.id });
    if (!existing) {
      await ClinicMembership.create({
        clinic: clinic.id,
        user: user.id,
        roleKey: member.roleKey,
        status: 'active',
        reviewerEligibility:
          member.roleKey === 'clinical_reviewer'
            ? { status: 'verified', verifiedAt: new Date() }
            : { status: 'not_applicable' },
      });
      // eslint-disable-next-line no-console
      console.log(`Seeded ${member.roleKey}: ${member.email}`);
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
