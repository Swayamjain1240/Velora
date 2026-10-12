'use strict';

// Synthetic development seed. Creates one clinic and one user per role so the
// app can be exercised end to end. Uses ONLY fabricated identities (control:
// synthetic data only; no real-patient data ever). Re-runnable.

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const crypto = require('node:crypto');
const { loadEnv, getEnv } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const { hashPassword } = require('../src/services/passwordService');
const documentStorage = require('../src/services/documentStorage');
const { SYSTEM_ROLES } = require('../src/config/constants');
const User = require('../src/models/User');
const Clinic = require('../src/models/Clinic');
const ClinicMembership = require('../src/models/ClinicMembership');
const MembershipRole = require('../src/models/MembershipRole');
const PatientProfile = require('../src/models/PatientProfile');
const RecoveryEpisode = require('../src/models/RecoveryEpisode');
const CareTeamAssignment = require('../src/models/CareTeamAssignment');
const PatientAssignment = require('../src/models/PatientAssignment');
const CaregiverGrant = require('../src/models/CaregiverGrant');
const RateLimitBucket = require('../src/models/RateLimitBucket');
const EpisodeDocument = require('../src/models/EpisodeDocument');
const CarePlanVersion = require('../src/models/CarePlanVersion');
const CarePlanItem = require('../src/models/CarePlanItem');
const SourceReference = require('../src/models/SourceReference');
const ReviewEvent = require('../src/models/ReviewEvent');

const SEED_PASSWORD = 'SyntheticDevPass!24';

const STAFF = [
  { email: 'admin@synthetic.invalid', name: 'Synthetic Admin', roleKey: 'admin' },
  { email: 'coordinator@synthetic.invalid', name: 'Synthetic Coordinator', roleKey: 'care_coordinator' },
  { email: 'reviewer@synthetic.invalid', name: 'Synthetic Reviewer', roleKey: 'clinical_reviewer' },
  // Dedicated Part 2 journey account: the browser test enrols THIS one through
  // the UI so it never collides with the one-time enrollment in auth.spec.
  { email: 'flow@synthetic.invalid', name: 'Synthetic Flow Coordinator', roleKey: 'care_coordinator' },
  // Part 4 documents journey: the assigned coordinator whose browser session is
  // enrolled through the API by e2e/global-setup, plus the synthetic patient
  // account that owns a linked profile (read-and-download only).
  { email: 'docsview@synthetic.invalid', name: 'Synthetic Document Coordinator', roleKey: 'care_coordinator' },
  { email: 'patient.docs@synthetic.invalid', name: 'Synthetic Document Patient', roleKey: 'patient' },
  // Scoped caregiver holder: the one-viewport gate needs a session that can
  // reach the caregiver screen, which requires an ACTIVE, explicit grant.
  { email: 'caregiver.docs@synthetic.invalid', name: 'Synthetic Document Caregiver', roleKey: 'caregiver' },
  // Part 5 care-plan journey: a coordinator who drafts, a VERIFIED reviewer who
  // is assigned to the same episode, and the patient account that owns it.
  { email: 'plan.coordinator@synthetic.invalid', name: 'Synthetic Plan Coordinator', roleKey: 'care_coordinator' },
  { email: 'plan.reviewer@synthetic.invalid', name: 'Synthetic Plan Reviewer', roleKey: 'clinical_reviewer' },
  { email: 'plan.patient@synthetic.invalid', name: 'Synthetic Plan Patient', roleKey: 'patient' },
];

// A technically valid one-page synthetic PDF: the only document the Part 5
// journey may cite as a source.
function planPdfBytes() {
  return Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n' +
      'synthetic discharge summary - fabricated content only\n' +
      'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1'
  );
}

// Part 4: one synthetic care team with a DRAFT episode (documents accepted) and
// a CLOSED episode (documents refused), plus a patient-linked episode so the
// read-only patient view has something real to render. Fabricated identities
// only; re-runnable.
async function seedDocumentJourney(clinic, passwordHash) {
  const coordinator = await User.findOne({ email: 'docsview@synthetic.invalid' });
  const patientUser = await User.findOne({ email: 'patient.docs@synthetic.invalid' });
  const caregiverUser = await User.findOne({ email: 'caregiver.docs@synthetic.invalid' });
  if (!coordinator || !patientUser || !caregiverUser) {
    throw new Error('document journey accounts were not seeded');
  }

  const membership = await ClinicMembership.findOne({ clinic: clinic.id, user: coordinator.id });

  // Two synthetic patients: one unlinked (staff-only chart) and one linked to
  // the synthetic patient account.
  const profiles = await Promise.all([
    upsertProfile(clinic, coordinator, { reference: 'PT-DOCS', fullName: 'Synthetic Document Patient' }),
    upsertProfile(clinic, coordinator, {
      reference: 'PT-DOCSPAT',
      fullName: 'Synthetic Linked Document Patient',
      linkedUserId: patientUser.id,
    }),
  ]);

  const episodes = [
    await upsertEpisode(clinic, coordinator, profiles[0], {
      reference: 'EP-DOCSDRAFT',
      status: 'draft',
    }),
    await upsertEpisode(clinic, coordinator, profiles[0], {
      reference: 'EP-DOCCLOSED',
      status: 'closed',
    }),
    await upsertEpisode(clinic, coordinator, profiles[1], {
      reference: 'EP-DOCSPAT',
      status: 'draft',
    }),
  ];

  // The coordinator holds an ACTIVE intake assignment on both profiles, so the
  // staff patient list/detail (also part of the one-viewport gate) is reachable.
  for (const profile of profiles) {
    await PatientAssignment.updateOne(
      { clinic: clinic.id, patient: profile.id, memberUser: coordinator.id, status: 'active' },
      {
        $setOnInsert: {
          clinic: clinic.id,
          patient: profile.id,
          membership: membership ? membership.id : undefined,
          memberUser: coordinator.id,
          status: 'active',
          assignedBy: coordinator.id,
          assignedByRole: 'staff',
          assignedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  // The caregiver holds ONLY view_profile on the linked patient: every other
  // scope stays inert, so the caregiver screen shows a scoped, read-only view.
  await CaregiverGrant.updateOne(
    { clinic: clinic.id, patient: profiles[1].id, granteeEmail: caregiverUser.email },
    {
      $set: { status: 'active', scopes: ['view_profile'] },
      $setOnInsert: {
        clinic: clinic.id,
        patient: profiles[1].id,
        granteeEmail: caregiverUser.email,
        caregiverUser: caregiverUser.id,
        grantedByUser: coordinator.id,
        grantedByRole: 'staff',
        grantedAt: new Date(),
      },
    },
    { upsert: true }
  );

  // The coordinator is an ACTIVE team member on every seeded episode: document
  // write access requires that assignment, never a clinic role alone.
  for (const episode of episodes) {
    await CareTeamAssignment.updateOne(
      { clinic: clinic.id, episode: episode.id, memberUser: coordinator.id, status: 'active' },
      {
        $setOnInsert: {
          clinic: clinic.id,
          patient: episode.patient,
          episode: episode.id,
          membership: membership ? membership.id : undefined,
          memberUser: coordinator.id,
          responsibility: 'care_coordinator',
          status: 'active',
          assignedBy: coordinator.id,
          assignedByRole: 'staff',
          assignedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded ${episodes.length} synthetic document-journey episodes (draft, closed, patient-linked).`);
}

// Part 5: one draft episode with an assigned coordinator, an assigned VERIFIED
// reviewer and one READY source document. Any plan data from a previous run is
// removed so the browser journey always starts from an empty plan slot.
async function seedPlanJourney(clinic) {
  const coordinator = await User.findOne({ email: 'plan.coordinator@synthetic.invalid' });
  const reviewer = await User.findOne({ email: 'plan.reviewer@synthetic.invalid' });
  const patientUser = await User.findOne({ email: 'plan.patient@synthetic.invalid' });
  if (!coordinator || !reviewer || !patientUser) {
    throw new Error('care-plan journey accounts were not seeded');
  }

  const membership = await ClinicMembership.findOne({ clinic: clinic.id, user: coordinator.id });
  const reviewerMembership = await ClinicMembership.findOne({ clinic: clinic.id, user: reviewer.id });

  const profile = await upsertProfile(clinic, coordinator, {
    reference: 'PT-PLANJRNY',
    fullName: 'Synthetic Plan Journey Patient',
    linkedUserId: patientUser.id,
  });
  const episode = await upsertEpisode(clinic, coordinator, profile, {
    reference: 'EP-PLANJRNY',
    status: 'draft',
  });

  // Start clean: remove every version of this episode together with its items,
  // citations and review timeline. Review events are append-only, so they are
  // removed through the raw collection.
  const versions = await CarePlanVersion.find({ clinic: clinic.id, episode: episode.id })
    .select('_id')
    .lean();
  const versionIds = versions.map((v) => v._id);
  if (versionIds.length) {
    await SourceReference.deleteMany({ version: { $in: versionIds } });
    await CarePlanItem.deleteMany({ version: { $in: versionIds } });
    await ReviewEvent.collection.deleteMany({ version: { $in: versionIds } });
  }
  await CarePlanVersion.deleteMany({ clinic: clinic.id, episode: episode.id });
  await RecoveryEpisode.updateOne(
    { _id: episode.id },
    { $set: { planState: 'none', approvedPlanVersion: null } }
  );

  await PatientAssignment.updateOne(
    { clinic: clinic.id, patient: profile.id, memberUser: coordinator.id, status: 'active' },
    {
      $setOnInsert: {
        clinic: clinic.id,
        patient: profile.id,
        membership: membership ? membership.id : undefined,
        memberUser: coordinator.id,
        status: 'active',
        assignedBy: coordinator.id,
        assignedByRole: 'staff',
        assignedAt: new Date(),
      },
    },
    { upsert: true }
  );

  for (const [member, memberMembership, responsibility] of [
    [coordinator, membership, 'care_coordinator'],
    [reviewer, reviewerMembership, 'clinical_reviewer'],
  ]) {
    await CareTeamAssignment.updateOne(
      { clinic: clinic.id, episode: episode.id, memberUser: member.id, status: 'active' },
      {
        $setOnInsert: {
          clinic: clinic.id,
          patient: episode.patient,
          episode: episode.id,
          membership: memberMembership ? memberMembership.id : undefined,
          memberUser: member.id,
          responsibility,
          status: 'active',
          assignedBy: coordinator.id,
          assignedByRole: 'staff',
          assignedAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  // One READY source document, stored through the same encrypted provider the
  // API uses (no plaintext ever reaches the filesystem).
  const bytes = planPdfBytes();
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  let document = await EpisodeDocument.findOne({
    clinic: clinic.id,
    episode: episode.id,
    sha256: digest,
  });
  if (!document) {
    const storageKey = documentStorage.newStorageKey();
    await documentStorage.put(storageKey, bytes);
    document = await EpisodeDocument.create({
      clinic: clinic.id,
      patient: episode.patient,
      episode: episode.id,
      storageKey,
      originalFilename: 'synthetic-discharge-summary.pdf',
      mediaType: 'application/pdf',
      byteSize: bytes.length,
      sha256: digest,
      status: 'ready',
      technical: { pages: 1 },
      uploadedBy: coordinator.id,
      uploadedByRole: 'staff',
    });
  } else {
    document.status = 'ready';
    document.rejectionCode = undefined;
    await document.save();
  }

  // eslint-disable-next-line no-console
  console.log('Seeded the Part 5 care-plan journey episode (draft, ready source, assigned reviewer).');
}

async function upsertProfile(clinic, creator, { reference, fullName, linkedUserId = null }) {
  await PatientProfile.updateOne(
    { clinic: clinic.id, reference },
    {
      $set: { fullName, status: 'active', linkedUserId, activatedAt: new Date() },
      $setOnInsert: { clinic: clinic.id, reference, createdBy: creator.id },
    },
    { upsert: true }
  );
  return PatientProfile.findOne({ clinic: clinic.id, reference });
}

async function upsertEpisode(clinic, creator, profile, { reference, status }) {
  await RecoveryEpisode.updateOne(
    { clinic: clinic.id, reference },
    {
      $set: { status, dischargeDate: new Date('2026-09-18T00:00:00.000Z'), dischargeTimezone: 'Europe/London', revision: 1 },
      $setOnInsert: { clinic: clinic.id, reference, patient: profile.id, createdBy: creator.id },
    },
    { upsert: true }
  );
  return RecoveryEpisode.findOne({ clinic: clinic.id, reference });
}

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

  await seedDocumentJourney(clinic, passwordHash);
  await seedPlanJourney(clinic);

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
