'use strict';

// Recovery episodes and care-team assignment.
//
// Access model (control #5, default deny):
//   - clinical episode metadata is readable only by an ACTIVE care-team member
//     (or the patient who owns the record). An administrator can administer the
//     team roster but can NEVER use admin status to read clinical metadata;
//   - team administration (list candidates, assign, revoke, list roster) is open
//     to an active team member or an administrator, and returns NO clinical
//     fields;
//   - a non-member staff user of the same clinic gets a uniform 404 for clinical
//     reads, so episode existence is never inferred.
const crypto = require('node:crypto');
const { ROLES } = require('../config/constants');
const { errors } = require('./errors');
const audit = require('./auditService');
const { withTransaction } = require('./txService');
const patientService = require('./patientService');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const CareTeamAssignment = require('../models/CareTeamAssignment');
const EpisodeCorrection = require('../models/EpisodeCorrection');
const ClinicMembership = require('../models/ClinicMembership');
const PatientProfile = require('../models/PatientProfile');

const EPISODE_PREFIX = 'EP';
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous characters
const RESPONSIBILITIES = ['care_coordinator', 'clinical_reviewer'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function randomReference() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const byte of bytes) out += REF_ALPHABET[byte % REF_ALPHABET.length];
  return `${EPISODE_PREFIX}-${out}`;
}

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    // Throws for an unknown IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Strict calendar date -> a UTC-midnight Date. Rejecting datetimes keeps the
// stored value independent of the caller's clock and offset.
function parseDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    throw errors.badRequest('Discharge date must be a calendar date (YYYY-MM-DD).');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw errors.badRequest('Discharge date is not a real calendar date.');
  }
  return date;
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

// Today's calendar date AS SEEN IN the episode's timezone, so a discharge date
// is judged against the correct local day at the timezone boundary.
function todayInTimezone(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function assertNotFuture(dateOnlyString, tz) {
  if (dateOnlyString > todayInTimezone(tz)) {
    throw errors.badRequest('Discharge date cannot be in the future.');
  }
}

function publicEpisode(episode) {
  return {
    id: episode._id ? String(episode._id) : episode.id,
    reference: episode.reference,
    patient: String(episode.patient),
    status: episode.status,
    dischargeDate: dateOnly(episode.dischargeDate),
    dischargeTimezone: episode.dischargeTimezone,
    revision: episode.revision,
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
  };
}

function publicTeam(assignment) {
  const user = assignment.memberUser && assignment.memberUser.email ? assignment.memberUser : null;
  return {
    id: assignment._id ? String(assignment._id) : assignment.id,
    memberUserId: user ? String(user._id || user.id) : String(assignment.memberUser),
    memberName: user ? user.name : undefined,
    memberEmail: user ? user.email : undefined,
    responsibility: assignment.responsibility,
    status: assignment.status,
    assignedByRole: assignment.assignedByRole,
    assignedAt: assignment.assignedAt,
    revokedAt: assignment.revokedAt || null,
  };
}

function publicCorrection(row) {
  return {
    id: row._id ? String(row._id) : row.id,
    field: row.field,
    previousValue: row.previousValue || null,
    newValue: row.newValue || null,
    revisionBefore: row.revisionBefore,
    revisionAfter: row.revisionAfter,
    reason: row.reason || null,
    actorLabel: row.actorLabel || null,
    correctedAt: row.correctedAt,
  };
}

async function resolveReference(clinicId, requested) {
  if (requested) {
    const clash = await RecoveryEpisode.exists({ clinic: clinicId, reference: requested });
    if (clash) throw errors.conflict('That episode reference is already used in this clinic.');
    return requested;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = randomReference();
    // eslint-disable-next-line no-await-in-loop
    const clash = await RecoveryEpisode.exists({ clinic: clinicId, reference: candidate });
    if (!clash) return candidate;
  }
  throw errors.conflict('Could not allocate a unique episode reference. Try again.');
}

// Clinical read: an active team member, or the patient who owns the record.
// An administrator is explicitly denied (never falls through to a 404) because
// admin status must not be usable to read clinical metadata.
async function resolveClinicalAccess({ clinicId, user, episodeId, roleKey }) {
  const episode = await RecoveryEpisode.findOne({ _id: episodeId, clinic: clinicId });
  if (!episode) throw errors.notFound('Episode not found.');

  const assignment = await CareTeamAssignment.findOne({
    clinic: clinicId,
    episode: episode.id,
    memberUser: user.id,
    status: 'active',
  });
  if (assignment) return { episode, access: 'team', assignment };

  // Admin status is an EXPLICIT denial, never a fall-through to 404: the
  // boundary must be visible in the response.
  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot read episode clinical metadata.');
  }

  // Ownership by the linked patient account. Deliberately NOT a caregiver
  // grant: episode scopes stay inert until their own part lands.
  const owned = await PatientProfile.findOne({
    _id: episode.patient,
    clinic: clinicId,
    linkedUserId: user.id,
  }).lean();
  if (owned) return { episode, access: 'patient' };

  throw errors.notFound('Episode not found.');
}

// Team administration: an active team member or an administrator. Never returns
// clinical fields to the administrator.
async function resolveTeamAdminAccess({ clinicId, user, episodeId, roleKey }) {
  const episode = await RecoveryEpisode.findOne({ _id: episodeId, clinic: clinicId });
  if (!episode) throw errors.notFound('Episode not found.');

  if (roleKey === ROLES.ADMIN) return { episode, access: 'admin' };

  const assignment = await CareTeamAssignment.findOne({
    clinic: clinicId,
    episode: episode.id,
    memberUser: user.id,
    status: 'active',
  });
  if (assignment) return { episode, access: 'team', assignment };

  throw errors.forbidden('You are not assigned to this episode.');
}

async function activeTeamCount(clinicId, episodeId) {
  return CareTeamAssignment.countDocuments({ clinic: clinicId, episode: episodeId, status: 'active' });
}

// Creation is reserved to assigned staff holding episode.manage, and records
// the creator as the episode's first care coordinator (there is never an
// episode with nobody accountable for it).
async function createEpisode({ clinicId, user, patientId, data, ip, userAgent }) {
  // An active intake assignment on the patient is required before an episode
  // can exist - a clinic role alone is not enough.
  await patientService.requireStaffAssignment({ clinicId, user, patientId });

  const tz = String(data.dischargeTimezone || '').trim();
  if (!isValidTimezone(tz)) throw errors.badRequest('Enter a valid IANA timezone.');
  const dischargeDate = parseDateOnly(data.dischargeDate);
  assertNotFuture(dateOnly(dischargeDate), tz);

  const reference = await resolveReference(clinicId, data.reference);

  const episode = await withTransaction(async (session) => {
    const [created] = await RecoveryEpisode.create(
      [
        {
          clinic: clinicId,
          patient: patientId,
          reference,
          status: 'draft',
          dischargeDate,
          dischargeTimezone: tz,
          revision: 1,
          createdBy: user.id,
        },
      ],
      { session }
    );

    const membership = await ClinicMembership.findOne({
      clinic: clinicId,
      user: user.id,
      status: 'active',
    }).session(session);
    await CareTeamAssignment.create(
      [
        {
          clinic: clinicId,
          patient: patientId,
          episode: created.id,
          membership: membership ? membership.id : undefined,
          memberUser: user.id,
          responsibility: 'care_coordinator',
          status: 'active',
          assignedBy: user.id,
          assignedByRole: 'staff',
          assignedAt: new Date(),
        },
      ],
      { session }
    );
    return created;
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'episode.created',
    targetType: 'recovery_episode',
    targetId: episode.id,
    outcome: 'success',
    ip,
    userAgent,
    // No clinical content: only the opaque reference.
    detail: { reference: episode.reference },
  });
  return publicEpisode(episode);
}

// Staff see only episodes they are actively on the team of (scoped totals).
async function listEpisodes({ clinicId, user, page, limit }) {
  const assignments = await CareTeamAssignment.find({
    clinic: clinicId,
    memberUser: user.id,
    status: 'active',
  })
    .select('episode')
    .lean();
  const episodeIds = assignments.map((a) => a.episode);

  const filter = { clinic: clinicId, _id: { $in: episodeIds } };
  const [items, total] = await Promise.all([
    RecoveryEpisode.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    RecoveryEpisode.countDocuments(filter),
  ]);
  return { items: items.map(publicEpisode), total, page, limit };
}

async function getEpisode({ clinicId, user, episodeId, roleKey }) {
  const { episode } = await resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  return publicEpisode(episode);
}

// Atomic draft discharge-date correction. The update is filtered on
// {_id, revision, status:'draft'}, so two parallel corrections against the same
// revision cannot both succeed; the loser gets a 409.
async function correctDischarge({
  clinicId,
  user,
  episodeId,
  roleKey,
  changes,
  expectedRevision,
  ip,
  userAgent,
}) {
  const { episode } = await resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  if (episode.status !== 'draft') {
    throw errors.conflict('Only a draft episode can be corrected.');
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw errors.badRequest('An expected revision is required.');
  }

  const next = {};
  const history = [];

  if (changes.dischargeTimezone !== undefined) {
    const tz = String(changes.dischargeTimezone).trim();
    if (!isValidTimezone(tz)) throw errors.badRequest('Enter a valid IANA timezone.');
    next.dischargeTimezone = tz;
  }
  if (changes.dischargeDate !== undefined) {
    const parsed = parseDateOnly(changes.dischargeDate);
    // Future check uses the effective timezone (new one if supplied).
    const effectiveTz = next.dischargeTimezone || episode.dischargeTimezone;
    assertNotFuture(dateOnly(parsed), effectiveTz);
    next.dischargeDate = parsed;
  }
  if (Object.keys(next).length === 0) {
    throw errors.badRequest('Provide a discharge date or timezone to correct.');
  }

  const noChange =
    (next.dischargeDate === undefined || dateOnly(next.dischargeDate) === dateOnly(episode.dischargeDate)) &&
    (next.dischargeTimezone === undefined || next.dischargeTimezone === episode.dischargeTimezone);

  if (noChange) {
    // Idempotent no-op: a repeat request must not create duplicate history.
    if (expectedRevision !== episode.revision) throw errors.conflict('This episode changed; reload and retry.');
    return publicEpisode(episode);
  }

  const revisionBefore = episode.revision;
  const updated = await RecoveryEpisode.findOneAndUpdate(
    { _id: episode.id, clinic: clinicId, revision: expectedRevision, status: 'draft' },
    { $set: next, $inc: { revision: 1 } },
    { new: true }
  );
  if (!updated) {
    // Either the revision moved under us or the episode left draft. Re-read to
    // report the accurate conflict without leaking other clinics' data.
    const current = await RecoveryEpisode.findOne({ _id: episode.id, clinic: clinicId }).lean();
    if (!current) throw errors.notFound('Episode not found.');
    throw errors.conflict('This episode changed; reload and retry.');
  }

  if (next.dischargeDate !== undefined) {
    history.push({ field: 'discharge_date', previousValue: dateOnly(episode.dischargeDate), newValue: dateOnly(updated.dischargeDate) });
  }
  if (next.dischargeTimezone !== undefined) {
    history.push({ field: 'discharge_timezone', previousValue: episode.dischargeTimezone, newValue: updated.dischargeTimezone });
  }

  await withTransaction(async (session) => {
    for (const row of history) {
      // eslint-disable-next-line no-await-in-loop
      await EpisodeCorrection.create(
        [
          {
            clinic: clinicId,
            patient: episode.patient,
            episode: episode.id,
            field: row.field,
            previousValue: row.previousValue,
            newValue: row.newValue,
            revisionBefore,
            revisionAfter: updated.revision,
            reason: changes.reason,
            actorUser: user.id,
            actorLabel: user.email,
            correctedAt: new Date(),
          },
        ],
        { session }
      );
    }
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'episode.discharge.corrected',
    targetType: 'recovery_episode',
    targetId: episode.id,
    outcome: 'success',
    ip,
    userAgent,
    // Field names and revision only - never the clinical values.
    detail: { fields: history.map((h) => h.field), revision: updated.revision },
  });
  return publicEpisode(updated);
}

async function listCorrections({ clinicId, user, episodeId, roleKey, page, limit }) {
  await resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  const filter = { clinic: clinicId, episode: episodeId };
  const [items, total] = await Promise.all([
    EpisodeCorrection.find(filter).sort({ correctedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    EpisodeCorrection.countDocuments(filter),
  ]);
  return { items: items.map(publicCorrection), total, page, limit };
}

// Eligible candidates: active coordinators and reviewers of the clinic. A
// reviewer candidate must currently hold VERIFIED eligibility. Members already
// actively assigned to this episode are excluded.
async function listCandidates({ clinicId, user, episodeId, roleKey }) {
  await resolveTeamAdminAccess({ clinicId, user, episodeId, roleKey });

  const memberships = await ClinicMembership.find({
    clinic: clinicId,
    status: 'active',
    roleKey: { $in: RESPONSIBILITIES },
  })
    .populate('user', 'email name')
    .sort({ createdAt: 1 })
    .lean();

  const active = await CareTeamAssignment.find({ clinic: clinicId, episode: episodeId, status: 'active' })
    .select('memberUser')
    .lean();
  const assigned = new Set(active.map((a) => String(a.memberUser)));

  const items = memberships
    .filter((m) => m.user && !assigned.has(String(m.user._id)))
    .filter((m) => m.roleKey !== ROLES.CLINICAL_REVIEWER || m.reviewerEligibility.status === 'verified')
    .map((m) => ({
      membershipId: String(m._id),
      userId: String(m.user._id || m.user.id),
      name: m.user.name,
      email: m.user.email,
      roleKey: m.roleKey,
      reviewerEligibility: m.reviewerEligibility.status,
    }));
  return { items };
}

async function listTeam({ clinicId, user, episodeId, roleKey }) {
  await resolveTeamAdminAccess({ clinicId, user, episodeId, roleKey });
  const items = await CareTeamAssignment.find({ clinic: clinicId, episode: episodeId })
    .populate('memberUser', 'email name')
    .sort({ status: 1, assignedAt: 1 })
    .lean();
  return { items: items.map(publicTeam) };
}

// Re-assignment opens a new interval; an identical repeat request is a no-op and
// returns the existing active interval (no duplicate history).
async function assignTeam({
  clinicId,
  user,
  episodeId,
  roleKey,
  memberUserId,
  responsibility,
  ip,
  userAgent,
}) {
  const resolved = await resolveTeamAdminAccess({ clinicId, user, episodeId, roleKey });
  const actorRole = resolved.access === 'admin' ? 'admin' : 'staff';

  const target = await ClinicMembership.findOne({
    clinic: clinicId,
    user: memberUserId,
    status: 'active',
  }).populate('user', 'email name');
  if (!target) throw errors.notFound('Staff member not found.');

  if (responsibility === ROLES.CLINICAL_REVIEWER) {
    if (target.roleKey !== ROLES.CLINICAL_REVIEWER) {
      throw errors.badRequest('That member is not a clinical reviewer.');
    }
    if (target.reviewerEligibility.status !== 'verified') {
      throw errors.forbidden('Clinical reviewer eligibility is not currently verified.');
    }
  } else if (responsibility === ROLES.CARE_COORDINATOR) {
    if (target.roleKey !== ROLES.CARE_COORDINATOR) {
      throw errors.badRequest('That member is not a care coordinator.');
    }
  } else {
    throw errors.badRequest('Unknown responsibility.');
  }

  let assignment;
  try {
    assignment = await CareTeamAssignment.create({
      clinic: clinicId,
      patient: resolved.episode.patient,
      episode: episodeId,
      membership: target.id,
      memberUser: target.user._id,
      responsibility,
      status: 'active',
      assignedBy: user.id,
      assignedByRole: actorRole,
      assignedAt: new Date(),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await CareTeamAssignment.findOne({
        clinic: clinicId,
        episode: episodeId,
        memberUser: target.user._id,
        status: 'active',
      }).populate('memberUser', 'email name');
      return publicTeam(existing);
    }
    throw err;
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'episode.team.assigned',
    targetType: 'care_team_assignment',
    targetId: assignment.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { responsibility, memberUser: String(target.user._id), actorRole },
  });
  const populated = await CareTeamAssignment.findById(assignment.id).populate('memberUser', 'email name');
  return publicTeam(populated);
}

// Revocation ends an interval; it never deletes. The last active assignment can
// never be removed, so an episode always keeps an accountable team member.
async function revokeTeam({ clinicId, user, episodeId, roleKey, assignmentId, ip, userAgent }) {
  await resolveTeamAdminAccess({ clinicId, user, episodeId, roleKey });

  const assignment = await CareTeamAssignment.findOne({
    _id: assignmentId,
    clinic: clinicId,
    episode: episodeId,
  });
  if (!assignment) throw errors.notFound('Assignment not found.');
  if (assignment.status === 'revoked') return publicTeam(assignment);

  if ((await activeTeamCount(clinicId, episodeId)) <= 1) {
    throw errors.conflict('An episode must keep at least one active care-team assignment.');
  }

  assignment.status = 'revoked';
  assignment.revokedAt = new Date();
  assignment.revokedBy = user.id;
  await assignment.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'episode.team.revoked',
    targetType: 'care_team_assignment',
    targetId: assignment.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { responsibility: assignment.responsibility },
  });
  return publicTeam(assignment);
}

// The patient's own view: episodes linked to the account they own.
async function listOwnEpisodes({ clinicId, user, page, limit }) {
  const profile = await patientService.resolveOwnProfileId({ clinicId, user });
  const filter = { clinic: clinicId, patient: profile };
  const [items, total] = await Promise.all([
    RecoveryEpisode.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    RecoveryEpisode.countDocuments(filter),
  ]);
  return { items: items.map(publicEpisode), total, page, limit };
}

async function getOwnEpisode({ clinicId, user, episodeId }) {
  const profile = await patientService.resolveOwnProfileId({ clinicId, user });
  const episode = await RecoveryEpisode.findOne({ _id: episodeId, clinic: clinicId, patient: profile });
  if (!episode) throw errors.notFound('Episode not found.');
  return publicEpisode(episode);
}

module.exports = {
  RESPONSIBILITIES,
  publicEpisode,
  publicTeam,
  publicCorrection,
  resolveClinicalAccess,
  resolveTeamAdminAccess,
  createEpisode,
  listEpisodes,
  getEpisode,
  correctDischarge,
  listCorrections,
  listCandidates,
  listTeam,
  assignTeam,
  revokeTeam,
  listOwnEpisodes,
  getOwnEpisode,
};
