'use strict';

// Part 7 synthetic journey seed (development only; fabricated identities).
//
// The browser journey needs a day view with REAL rows, so this seeds the whole
// chain the product demands: a READY source document, a hand-authored plan,
// clinical review and approval, then an explicit prepare and activation of the
// resulting schedules. Nothing is written directly into a schedule model except
// by the same services the API uses - so the invariant "only an approved,
// clinician-confirmed item generates a schedule" holds for the seed too.
//
// Re-runnable: the journey's own schedules, occurrences, entries and plan data
// are cleared first (through the raw collections where a model is append-only).
const crypto = require('node:crypto');
const documentStorage = require('../src/services/documentStorage');
const carePlanService = require('../src/services/carePlanService');
const scheduleService = require('../src/services/scheduleService');
const zonedTime = require('../src/services/zonedTime');
const User = require('../src/models/User');
const ClinicMembership = require('../src/models/ClinicMembership');
const PatientProfile = require('../src/models/PatientProfile');
const RecoveryEpisode = require('../src/models/RecoveryEpisode');
const CareTeamAssignment = require('../src/models/CareTeamAssignment');
const PatientAssignment = require('../src/models/PatientAssignment');
const CaregiverGrant = require('../src/models/CaregiverGrant');
const EpisodeDocument = require('../src/models/EpisodeDocument');
const CarePlanVersion = require('../src/models/CarePlanVersion');
const CarePlanItem = require('../src/models/CarePlanItem');
const SourceReference = require('../src/models/SourceReference');
const ReviewEvent = require('../src/models/ReviewEvent');
const MedicationSchedule = require('../src/models/MedicationSchedule');
const RecoveryTask = require('../src/models/RecoveryTask');
const ScheduleOccurrence = require('../src/models/ScheduleOccurrence');
const ActivityLog = require('../src/models/ActivityLog');
const { pdfWithTextPages } = require('./syntheticPdf');

const ZONE = 'Europe/London';
const PATIENT_REFERENCE = 'PT-SCHEDJRNY';
const EPISODE_REFERENCE = 'EP-SCHEDJRNY';

const ACCOUNTS = {
  coordinator: 'schedule.coordinator@synthetic.invalid',
  reviewer: 'schedule.reviewer@synthetic.invalid',
  patient: 'schedule.patient@synthetic.invalid',
  caregiver: 'schedule.caregiver@synthetic.invalid',
};

// Two medicines (one fixed course, one PRN) and one recovery task.
const ITEMS = [
  {
    kind: 'medication',
    originalWording: 'Amoxicillin 500 mg orally three times daily for 5 days',
    medication: 'Amoxicillin',
    dose: '500 mg',
    route: 'oral',
    frequency: 'three times daily',
    duration: '5 days',
  },
  {
    kind: 'medication',
    originalWording: 'Paracetamol 500 mg orally every 6 hours as needed for pain',
    medication: 'Paracetamol',
    dose: '500 mg',
    route: 'oral',
    frequency: 'every 6 hours',
    timing: 'as needed for pain',
    condition: 'for pain only',
    duration: '3 days',
  },
  {
    kind: 'home_care',
    originalWording: 'Change the dressing in the morning and at night',
    homeCare: 'Keep the dressing dry; change it if it becomes loose.',
    frequency: 'twice daily',
    timing: 'morning and night',
  },
];

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
      $set: {
        status,
        dischargeDate: new Date('2026-09-18T00:00:00.000Z'),
        dischargeTimezone: ZONE,
        revision: 1,
      },
      $setOnInsert: { clinic: clinic.id, reference, patient: profile.id, createdBy: creator.id },
    },
    { upsert: true }
  );
  return RecoveryEpisode.findOne({ clinic: clinic.id, reference });
}

async function seedScheduleJourney(clinic) {
  const coordinator = await User.findOne({ email: ACCOUNTS.coordinator });
  const reviewer = await User.findOne({ email: ACCOUNTS.reviewer });
  const patientUser = await User.findOne({ email: ACCOUNTS.patient });
  const caregiverUser = await User.findOne({ email: ACCOUNTS.caregiver });
  if (!coordinator || !reviewer || !patientUser || !caregiverUser) {
    throw new Error('schedule journey accounts were not seeded');
  }

  const membership = await ClinicMembership.findOne({ clinic: clinic.id, user: coordinator.id });
  const reviewerMembership = await ClinicMembership.findOne({ clinic: clinic.id, user: reviewer.id });

  const profile = await upsertProfile(clinic, coordinator, {
    reference: PATIENT_REFERENCE,
    fullName: 'Synthetic Schedule Journey Patient',
    linkedUserId: patientUser.id,
  });
  const episode = await upsertEpisode(clinic, coordinator, profile, {
    reference: EPISODE_REFERENCE,
    status: 'draft',
  });

  // ---- clean slate ---------------------------------------------------------
  const owners = [
    ...(await MedicationSchedule.find({ clinic: clinic.id, episode: episode.id }).select('_id').lean()),
    ...(await RecoveryTask.find({ clinic: clinic.id, episode: episode.id }).select('_id').lean()),
  ].map((row) => row._id);
  if (owners.length) {
    await ScheduleOccurrence.deleteMany({ owner: { $in: owners } });
  }
  // Entries are append-only by design, so the reset uses the raw collection.
  await ActivityLog.collection.deleteMany({ episode: episode.id });
  await ScheduleOccurrence.deleteMany({ clinic: clinic.id, episode: episode.id });
  await MedicationSchedule.deleteMany({ clinic: clinic.id, episode: episode.id });
  await RecoveryTask.deleteMany({ clinic: clinic.id, episode: episode.id });

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

  // ---- team ---------------------------------------------------------------
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

  // ---- ready source document ---------------------------------------------
  const bytes = pdfWithTextPages([
    [
      'Synthetic discharge summary (Part 7 schedule journey)',
      'Amoxicillin 500 mg orally three times daily for 5 days',
      'Paracetamol 500 mg orally every 6 hours as needed for pain',
      'Change the dressing in the morning and at night',
    ],
  ]);
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
      originalFilename: 'synthetic-schedule-summary.pdf',
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

  // ---- author, review and approve the plan through the REAL services -------
  const clinicId = clinic.id;
  const coordinatorActor = { id: coordinator.id, email: coordinator.email };
  const reviewerActor = { id: reviewer.id, email: reviewer.email };
  const episodeId = episode.id;

  async function revisionOf(planId) {
    const version = await carePlanService.getVersion({
      clinicId,
      user: coordinatorActor,
      episodeId,
      roleKey: 'care_coordinator',
      planId,
    });
    return version.plan.revision;
  }

  const created = await carePlanService.createDraftVersion({
    clinicId,
    user: coordinatorActor,
    episodeId,
    roleKey: 'care_coordinator',
    data: { title: 'Post-discharge recovery', summary: 'Approved synthetic plan for the day view.' },
  });
  const planId = created.id || created.plan.id;

  const itemIds = [];
  for (const item of ITEMS) {
    // eslint-disable-next-line no-await-in-loop
    const saved = await carePlanService.addItem({
      clinicId,
      user: coordinatorActor,
      episodeId,
      roleKey: 'care_coordinator',
      planId,
      expectedRevision: await revisionOf(planId),
      data: item,
    });
    itemIds.push(saved.id);
    // eslint-disable-next-line no-await-in-loop
    await carePlanService.linkSource({
      clinicId,
      user: coordinatorActor,
      episodeId,
      roleKey: 'care_coordinator',
      planId,
      itemId: saved.id,
      expectedRevision: await revisionOf(planId),
      data: {
        documentId: document.id,
        text: item.originalWording,
        page: 1,
        location: 'Synthetic discharge summary, page 1',
      },
    });
  }

  await carePlanService.submitForReview({
    clinicId,
    user: coordinatorActor,
    episodeId,
    roleKey: 'care_coordinator',
    planId,
    expectedRevision: await revisionOf(planId),
  });

  for (const itemId of itemIds) {
    // eslint-disable-next-line no-await-in-loop
    await carePlanService.reviewItem({
      clinicId,
      user: reviewerActor,
      episodeId,
      roleKey: 'clinical_reviewer',
      planId,
      itemId,
      expectedRevision: await revisionOf(planId),
      decision: 'accepted',
      note: 'Verified against the synthetic source.',
    });
  }

  await carePlanService.approve({
    clinicId,
    user: reviewerActor,
    episodeId,
    roleKey: 'clinical_reviewer',
    planId,
    expectedRevision: await revisionOf(planId),
  });

  // ---- prepare and activate through the same services the API uses ---------
  const startDate = zonedTime.addDays(zonedTime.todayInTimezone(ZONE), -2);
  const summary = await scheduleService.prepareFromApprovedVersion({
    clinicId,
    user: coordinatorActor,
    episodeId,
    roleKey: 'care_coordinator',
    data: { timezone: ZONE, startDate, horizonDays: 30 },
  });

  for (const owner of summary.created) {
    // A medicine is activated by the verified reviewer; a task by the
    // coordinator who prepared it - exactly as the API requires.
    // eslint-disable-next-line no-await-in-loop
    await scheduleService.activateSchedule({
      clinicId,
      user: owner.type === 'medication' ? reviewerActor : coordinatorActor,
      episodeId,
      roleKey: owner.type === 'medication' ? 'clinical_reviewer' : 'care_coordinator',
      scheduleId: owner.id,
      expectedRevision: owner.revision,
      note: 'Activated by the seeded synthetic journey.',
    });
  }

  // ---- an ACTIVE, scoped caregiver ------------------------------
  await CaregiverGrant.updateMany(
    { clinic: clinic.id, patient: profile.id, caregiverUser: caregiverUser.id },
    { $set: { status: 'revoked', revokedAt: new Date(), revokedByRole: 'staff' } }
  );
  await CaregiverGrant.create({
    clinic: clinic.id,
    patient: profile.id,
    caregiverUser: caregiverUser.id,
    granteeEmail: caregiverUser.email,
    scopes: ['view_profile', 'view_tasks', 'log_tasks'],
    status: 'active',
    grantedByRole: 'staff',
    grantedByUser: coordinator.id,
    acceptedAt: new Date(),
  });

  // eslint-disable-next-line no-console
  console.log(
    `Seeded the Part 7 journey: plan approved, ${summary.created.length} schedule(s) prepared and activated (${startDate} onward, ${ZONE}).`
  );
}

module.exports = { seedScheduleJourney, SCHEDULE_JOURNEY_ACCOUNTS: ACCOUNTS };
