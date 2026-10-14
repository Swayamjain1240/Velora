'use strict';

// Actor-attributed activity logging (Part 7, VEL-012/VEL-013).
//
// Every entry answers WHO recorded WHAT, ABOUT WHICH instant, and WHEN it was
// recorded. Entries are append-only: a correction appends a new row that names
// the row it corrects, and the earlier row is never touched - so a patient's
// history cannot be silently rewritten.
//
// Authority is re-derived from the database on every write:
//   - a patient may record their OWN approved plan activity;
//   - a caregiver needs an ACTIVE, unexpired grant holding BOTH `view_tasks` and
//     `log_tasks` (a grant without `log_tasks` can read the day but never write);
//   - staff need an active membership AND a current care-team assignment.
// A revoked grant, another clinic, an unassigned reviewer or a closed episode is
// refused. Nothing here ever advises an extra or replacement dose.
const { errors } = require('./errors');
const audit = require('./auditService');
const policy = require('../policies/schedulePolicy');
const zonedTime = require('./zonedTime');
const { ROLES } = require('../config/constants');
const ActivityLog = require('../models/ActivityLog');
const ScheduleOccurrence = require('../models/ScheduleOccurrence');
const MedicationSchedule = require('../models/MedicationSchedule');
const RecoveryTask = require('../models/RecoveryTask');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const PatientProfile = require('../models/PatientProfile');
const CaregiverGrant = require('../models/CaregiverGrant');
const ClinicMembership = require('../models/ClinicMembership');
const CareTeamAssignment = require('../models/CareTeamAssignment');

const CLINIC_ROLES = Object.freeze([ROLES.CARE_COORDINATOR, ROLES.CLINICAL_REVIEWER]);
const STAFF_RECORD_ROLES = Object.freeze([ROLES.CARE_COORDINATOR, ROLES.CLINICAL_REVIEWER]);
const MAX_BACKDATE_HOURS = 24 * 7;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_CHAIN = 10;

function idOf(value) {
  return value && value._id ? String(value._id) : String(value);
}

function publicLog(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    occurrence: idOf(doc.occurrence),
    owner: idOf(doc.owner),
    ownerType: doc.ownerType,
    entryState: doc.entryState,
    note: doc.note || null,
    actorRole: doc.actorRole,
    actorLabel: doc.actorLabel || null,
    // The grant that authorised a caregiver entry (null for a patient or staff
    // actor), so the authority behind a write stays provable afterwards.
    actorGrant: doc.actorGrant ? idOf(doc.actorGrant) : null,
    // A patient/caregiver entry is a SELF-REPORT and is labelled as one
    // wherever it is shown; a clinician verification is a separate fact that
    // this part does not record at all.
    selfReport: policy.isSelfReport(doc.actorRole),
    occurrenceTimeUtc: doc.occurrenceTimeUtc,
    recordedAtUtc: doc.recordedAtUtc,
    sequence: doc.sequence,
    correctsLog: doc.correctsLog ? idOf(doc.correctsLog) : null,
    correctionReason: doc.correctionReason || null,
  };
}

// ---- authority --------------------------------------------------------------

// The caller's role is DERIVED from their own active membership in the record's
// clinic - never taken from a client-supplied or route-supplied value.
async function resolveActorAuthority({ user, patient, clinicId, episodeId, requireLog }) {
  const profile = await PatientProfile.findOne({ _id: patient, clinic: clinicId }).lean();
  if (!profile) throw errors.notFound('Nothing to show for that record.');

  // 1. The patient who owns the record.
  if (String(profile.linkedUserId || '') === String(user.id)) {
    return { actorRole: 'patient', grant: null, access: 'patient' };
  }

  // 2. A caregiver with an ACTIVE, unexpired grant carrying the scopes this
  //    action needs. Clinic is derived from the grant, never from the caller.
  const grant = await CaregiverGrant.findOne({
    clinic: clinicId,
    patient,
    caregiverUser: user.id,
    status: 'active',
  });
  if (grant && grant.isUsable()) {
    const needed = requireLog ? ['view_tasks', 'log_tasks'] : ['view_tasks'];
    if (needed.every((scope) => grant.scopes.includes(scope))) {
      return { actorRole: 'caregiver', grant, access: 'caregiver' };
    }
    // A grant without the needed scope is reported exactly like a missing one.
    throw errors.notFound('Nothing to show for that record.');
  }

  // 3. Assigned staff in the record's own clinic.
  const membership = await ClinicMembership.findOne({ clinic: clinicId, user: user.id, status: 'active' }).lean();
  if (!membership || !CLINIC_ROLES.includes(membership.roleKey)) {
    throw errors.notFound('Nothing to show for that record.');
  }
  if (requireLog && !STAFF_RECORD_ROLES.includes(membership.roleKey)) {
    throw errors.notFound('Nothing to show for that record.');
  }
  const assignment = await CareTeamAssignment.findOne({
    clinic: clinicId,
    episode: episodeId,
    memberUser: user.id,
    status: 'active',
  }).lean();
  if (!assignment) {
    throw errors.forbidden('You are not assigned to this episode.');
  }
  return { actorRole: membership.roleKey, grant: null, access: 'team' };
}

// ---- target resolution ------------------------------------------------------

async function loadOwnerById(scheduleId) {
  const medication = await MedicationSchedule.findById(scheduleId);
  if (medication) return { owner: medication, ownerType: 'medication' };
  const task = await RecoveryTask.findById(scheduleId);
  if (task) return { owner: task, ownerType: 'task' };
  throw errors.notFound('Nothing to show for that record.');
}

async function loadOwnerInClinic({ scheduleId, clinicId }) {
  const medication = await MedicationSchedule.findOne({ _id: scheduleId, clinic: clinicId });
  if (medication) return { owner: medication, ownerType: 'medication' };
  const task = await RecoveryTask.findOne({ _id: scheduleId, clinic: clinicId });
  if (task) return { owner: task, ownerType: 'task' };
  throw errors.notFound('Nothing to show for that record.');
}

async function loadTarget({ occurrenceId, scheduleId }) {
  if (occurrenceId) {
    const occurrence = await ScheduleOccurrence.findById(occurrenceId);
    if (!occurrence) throw errors.notFound('Nothing to show for that record.');
    const { owner, ownerType } = await loadOwnerById(occurrence.owner);
    return { occurrence, owner, ownerType };
  }
  const { owner, ownerType } = await loadOwnerById(scheduleId);
  return { occurrence: null, owner, ownerType };
}

function assertOccurrenceLoggable({ occurrence, owner, now }) {
  if (owner.status !== policy.SCHEDULE_STATUS.ACTIVE) {
    throw errors.conflict('This schedule is not active, so nothing can be recorded against it yet.');
  }
  if (occurrence.status !== policy.OCCURRENCE_STATUS.SCHEDULED) {
    throw errors.conflict('That occurrence is no longer active for this plan version.');
  }
  if (new Date(occurrence.scheduledAtUtc).getTime() > now.getTime() + FUTURE_SKEW_MS) {
    throw errors.conflict('That entry is not due yet.');
  }
}

// ---- writes -----------------------------------------------------------------

async function recordEntry({ user, input, ip, userAgent }) {
  const entryState = input.entryState;
  if (!policy.ENTRY_STATE_VALUES.includes(entryState)) {
    throw errors.badRequest('Unknown entry state.');
  }

  const { occurrence, owner, ownerType } = await loadTarget({
    occurrenceId: input.occurrenceId,
    scheduleId: input.scheduleId,
  });
  const clinicId = owner.clinic;
  const episodeId = owner.episode;

  // Idempotency first: a retried submission returns the ORIGINAL entry instead
  // of appending a second fact. A request id reused for a different target is a
  // conflict, never a silent overwrite.
  const replay = await ActivityLog.findOne({ clinic: clinicId, clientRequestId: input.clientRequestId });
  if (replay) {
    const sameTarget = occurrence
      ? idOf(replay.occurrence) === idOf(occurrence)
      : idOf(replay.owner) === idOf(owner);
    const sameActor = idOf(replay.actorUser) === idOf(user);
    if (!sameTarget || !sameActor) {
      throw errors.conflict('That request id was already used for a different entry.');
    }
    if (replay.entryState !== entryState) {
      throw errors.conflict('That request id was already used with a different entry state.');
    }
    return { log: publicLog(replay), idempotent: true, occurrence: replay.occurrence, occurrenceCreated: false };
  }

  const episode = await RecoveryEpisode.findOne({ _id: episodeId, clinic: clinicId }).lean();
  if (!episode) throw errors.notFound('Nothing to show for that record.');
  // Read-only state: a closed episode accepts no new activity. History stays
  // readable - this only stops NEW entries.
  if (episode.status === 'closed') {
    throw errors.conflict('This episode is closed and read-only. New entries cannot be recorded.');
  }

  const authority = await resolveActorAuthority({
    user,
    patient: owner.patient,
    clinicId,
    episodeId,
    requireLog: true,
  });

  const now = new Date();
  let targetOccurrence = occurrence;
  let occurrenceCreated = false;
  let occurrenceTimeUtc;

  if (targetOccurrence) {
    assertOccurrenceLoggable({ occurrence: targetOccurrence, owner, now });
    occurrenceTimeUtc = targetOccurrence.scheduledAtUtc;
  } else {
    // As-needed entry: the act of recording IS the event, so the occurrence is
    // created now, marked `as_needed`, and never scheduled or repeated.
    if (owner.scheduleKind !== policy.OCCURRENCE_ORIGIN.AS_NEEDED) {
      throw errors.badRequest('A time is required for a scheduled instruction. Record it from the day view.');
    }
    if (owner.status !== policy.SCHEDULE_STATUS.ACTIVE) {
      throw errors.conflict('This schedule is not active, so nothing can be recorded against it yet.');
    }
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : now;
    if (Number.isNaN(occurredAt.getTime())) {
      throw errors.badRequest('The time of the entry is not a valid instant.');
    }
    if (occurredAt.getTime() > now.getTime() + FUTURE_SKEW_MS) {
      throw errors.conflict('That entry is not due yet.');
    }
    if (now.getTime() - occurredAt.getTime() > MAX_BACKDATE_HOURS * 3600 * 1000) {
      throw errors.badRequest('An entry can be recorded up to seven days after it happened.');
    }
    occurrenceTimeUtc = occurredAt;
    const parts = zonedTime.localParts(occurredAt, owner.timezone);
    targetOccurrence = await ScheduleOccurrence.create({
      clinic: clinicId,
      patient: owner.patient,
      episode: episodeId,
      planVersion: owner.planVersion,
      item: owner.item,
      ownerType,
      owner: owner._id,
      origin: policy.OCCURRENCE_ORIGIN.AS_NEEDED,
      scheduledAtUtc: occurredAt,
      localDate: parts.dateOnly,
      localTime: parts.timeOnly,
      timezone: owner.timezone,
      offset: zonedTime.offsetLabel(occurredAt, owner.timezone),
      status: policy.OCCURRENCE_STATUS.SCHEDULED,
    });
    occurrenceCreated = true;
  }

  // ---- correction chain ----------------------------------------------------
  let sequence = 1;
  let correctsLog = null;
  if (input.correctsLogId) {
    const target = await ActivityLog.findById(input.correctsLogId);
    if (!target || idOf(target.occurrence) !== idOf(targetOccurrence)) {
      throw errors.notFound('Nothing to show for that record.');
    }
    const alreadyCorrected = await ActivityLog.exists({ correctsLog: target._id });
    if (alreadyCorrected) {
      // Only the newest entry in the chain may be corrected, so the history
      // stays a single ordered line rather than a fork.
      throw errors.conflict('That entry has already been corrected. Correct the newest entry instead.');
    }
    correctsLog = target._id;
    sequence = target.sequence + 1;
  } else {
    const previous = await ActivityLog.findOne({ occurrence: targetOccurrence._id })
      .sort({ sequence: -1 })
      .select('sequence')
      .lean();
    sequence = previous ? previous.sequence + 1 : 1;
  }

  const created = await ActivityLog.create({
    clinic: clinicId,
    patient: owner.patient,
    episode: episodeId,
    planVersion: owner.planVersion,
    item: owner.item,
    ownerType,
    owner: owner._id,
    occurrence: targetOccurrence._id,
    entryState,
    note: input.note || undefined,
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: authority.actorRole,
    actorGrant: authority.grant ? authority.grant._id : null,
    occurrenceTimeUtc,
    recordedAtUtc: now,
    clientRequestId: input.clientRequestId,
    correctsLog,
    correctionReason: input.correctionReason || undefined,
    sequence,
  }).catch(async (err) => {
    // A concurrent retry with the same request id lost the unique-index race:
    // return the winner's row instead of failing the caller.
    if (err && err.code === 11000) {
      const winner = await ActivityLog.findOne({ clinic: clinicId, clientRequestId: input.clientRequestId });
      if (winner) return winner;
    }
    throw err;
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: correctsLog ? 'activity.corrected' : 'activity.recorded',
    targetType: 'schedule_occurrence',
    targetId: idOf(targetOccurrence),
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      episode: episodeId,
      ownerType,
      entryState,
      actorRole: authority.actorRole,
      occurrenceCreated,
      correction: Boolean(correctsLog),
    },
  });

  return {
    log: publicLog(created),
    idempotent: false,
    occurrence: created.occurrence,
    occurrenceCreated,
  };
}

// Staff history for one episode, newest first. This is an audit-shaped read of
// recorded facts - it never computes an adherence score.
async function listEpisodeLogs({ clinicId, episodeId, page, limit }) {
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    ActivityLog.find({ clinic: clinicId, episode: episodeId })
      .sort({ recordedAtUtc: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ActivityLog.countDocuments({ clinic: clinicId, episode: episodeId }),
  ]);
  return { items: items.map(publicLog), total, page, limit };
}

// The full, ordered chain for one occurrence (bounded), oldest first.
async function chainFor(occurrenceIds) {
  if (!occurrenceIds.length) return new Map();
  const rows = await ActivityLog.find({ occurrence: { $in: occurrenceIds } })
    .sort({ occurrence: 1, sequence: 1 })
    .lean();
  const byOccurrence = new Map();
  for (const row of rows) {
    const key = idOf(row.occurrence);
    if (!byOccurrence.has(key)) byOccurrence.set(key, []);
    const chain = byOccurrence.get(key);
    // Keep only the newest few rows: the current state plus enough history to
    // show that a correction happened.
    chain.push(row);
    if (chain.length > MAX_CHAIN) chain.shift();
  }
  return byOccurrence;
}

module.exports = {
  publicLog,
  resolveActorAuthority,
  loadOwnerById,
  recordEntry,
  listEpisodeLogs,
  chainFor,
  MAX_CHAIN,
};
