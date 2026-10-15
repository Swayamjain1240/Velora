'use strict';

// Episode closure and reopening (Part 9, VEL-019).
//
// Closure is an OPERATIONAL archive state. The service never writes a diagnosis,
// an outcome or the word "recovered"; the policy module owns that wording rule,
// and the audit and closure records carry only operational facts.
//
// The close itself is one transaction that:
//   1. re-derives the caller's live care-team assignment (authorization is never
//      taken from the request),
//   2. re-reads the episode and refuses a stale revision (a concurrent close is a
//      409, never a silent second close),
//   3. flips the episode state atomically under the revision guard,
//   4. stops permitted FUTURE work (queued reminders and future scheduled slots)
//      while leaving every recorded fact untouched, and
//   5. appends the closure event.
//
// Reopening is separate, explicit, authorized and justified. It restores active
// coordination; it does NOT revive the work the closure stopped, so a reopened
// episode builds new future work deliberately.
const { errors } = require('./errors');
const audit = require('./auditService');
const policy = require('../policies/closurePolicy');
const checkInService = require('./checkInService');
const { withTransaction } = require('./txService');
const { ROLES, CHECKIN_RESPONSE_STATES, THREAD_STATES } = require('../config/constants');
const { STATES } = require('../policies/carePlanPolicy');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const EpisodeClosure = require('../models/EpisodeClosure');
const CareTeamAssignment = require('../models/CareTeamAssignment');
const CarePlanVersion = require('../models/CarePlanVersion');
const ClarificationThread = require('../models/ClarificationThread');
const CheckInResponse = require('../models/CheckInResponse');
const Notification = require('../models/Notification');
const RecoveryTask = require('../models/RecoveryTask');
const MedicationSchedule = require('../models/MedicationSchedule');
const ScheduleOccurrence = require('../models/ScheduleOccurrence');
const RetentionHold = require('../models/RetentionHold');

function idOf(value) {
  return value && value._id ? String(value._id) : value === null || value === undefined ? null : String(value);
}

function parseClosureDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw errors.badRequest('Enter a real closure date.');
  // A closure date may be today or in the past; a future date is refused so the
  // recorded date cannot describe work that has not happened yet.
  if (date.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw errors.badRequest('A closure date cannot be in the future.');
  }
  return date;
}

// ---- scope -------------------------------------------------------------------

async function assertTeamScope({ clinicId, user, roleKey, episodeId }) {
  const scope = await checkInService.resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity !== 'team') {
    throw errors.forbidden('Only the assigned care team may close or reopen this episode.');
  }
  if (!scope.assignment) throw errors.forbidden('Only the assigned care team may close or reopen this episode.');
  return scope;
}

// ---- preflight ---------------------------------------------------------------

async function collectPreflight({ clinicId, episode, now = new Date() }) {
  const episodeId = episode._id;
  const [approvals, clarifications, failedDeliveries, openTasks, pendingCheckins, assignments] =
    await Promise.all([
      CarePlanVersion.countDocuments({
        clinic: clinicId,
        episode: episodeId,
        state: { $in: [STATES.IN_REVIEW, STATES.NEEDS_CLARIFICATION] },
      }),
      ClarificationThread.countDocuments({
        clinic: clinicId,
        episode: episodeId,
        state: { $in: [THREAD_STATES.OPEN, THREAD_STATES.ASSIGNED, THREAD_STATES.ANSWERED, THREAD_STATES.REOPENED] },
      }),
      Notification.countDocuments({ clinic: clinicId, episode: episodeId, state: 'failed' }),
      RecoveryTask.countDocuments({ clinic: clinicId, episode: episodeId, status: 'active' }),
      CheckInResponse.countDocuments({
        clinic: clinicId,
        episode: episodeId,
        state: CHECKIN_RESPONSE_STATES.OPEN,
        windowEndsAt: { $gt: now },
      }),
      CareTeamAssignment.find({ clinic: clinicId, episode: episodeId, status: 'active' })
        .select('responsibility')
        .lean(),
    ]);

  const roles = new Set(assignments.map((a) => a.responsibility));
  const missingRoles = ['care_coordinator', 'clinical_reviewer'].filter((role) => !roles.has(role));

  const counts = {
    unresolved_approvals: approvals,
    open_clarifications: clarifications,
    failed_deliveries: failedDeliveries,
    open_tasks: openTasks,
    pending_checkins: pendingCheckins,
    missing_owners: missingRoles.length,
  };

  const items = policy.preflightCatalog().map((item) => ({
    ...item,
    count: counts[item.key] || 0,
  }));

  return { items, missingRoles };
}

// The preflight surface. It never changes state: it lists what is outstanding so
// a person can decide, and it says plainly what closing does and does not mean.
async function preflight({ clinicId, user, roleKey, episodeId, now = new Date() }) {
  const scope = await assertTeamScope({ clinicId, user, roleKey, episodeId });
  const episode = scope.episode;
  const { items, missingRoles } = await collectPreflight({
    clinicId,
    episode,
    now,
  });
  const evaluation = policy.evaluatePreflight(items, []);

  return {
    episode: {
      id: idOf(episode),
      reference: episode.reference,
      status: episode.status,
      closureState: episode.closureState || 'open',
      revision: episode.revision,
      patient: idOf(episode.patient),
    },
    items,
    missingRoles,
    blocking: evaluation.blocking,
    unresolved: evaluation.unresolved,
    canClose: evaluation.canClose && episode.closureState !== 'closed',
    policyChecks: policy.CLOSURE_POLICY_CHECKS.map((key) => ({ key })),
    meaning: policy.CLOSURE_MEANING,
    reopenMeaning: policy.REOPEN_MEANING,
  };
}

// ---- stop future work --------------------------------------------------------

// Everything here touches only FUTURE or queued work. A recorded occurrence, an
// answered check-in or a logged entry is a historical fact and is never changed.
async function stopFutureWork({ clinicId, episodeId, now, user, session }) {
  const occurrenceResult = await ScheduleOccurrence.updateMany(
    { clinic: clinicId, episode: episodeId, status: 'scheduled', scheduledAtUtc: { $gt: now } },
    {
      $set: {
        status: 'ended',
        statusReason: 'Episode closed: future slots stopped.',
        endedAt: now,
      },
    },
    { session }
  );

  const notificationResult = await Notification.updateMany(
    { clinic: clinicId, episode: episodeId, state: 'queued' },
    {
      $set: {
        state: 'cancelled',
        cancelledAt: now,
        cancelledReason: 'Episode closed before delivery.',
        nextAttemptAt: null,
      },
    },
    { session }
  );

  const scheduleResult = await MedicationSchedule.updateMany(
    { clinic: clinicId, episode: episodeId, status: 'active' },
    { $set: { status: 'ended', endedAt: now, endedReason: 'Episode closed.', endedBy: user.id } },
    { session }
  );

  const taskResult = await RecoveryTask.updateMany(
    { clinic: clinicId, episode: episodeId, status: 'active' },
    { $set: { status: 'ended', endedAt: now, endedReason: 'Episode closed.', endedBy: user.id } },
    { session }
  );

  return {
    futureOccurrencesStopped: occurrenceResult.modifiedCount,
    queuedRemindersCancelled: notificationResult.modifiedCount,
    schedulesEnded: scheduleResult.modifiedCount,
    tasksEnded: taskResult.modifiedCount,
  };
}

// ---- close -------------------------------------------------------------------

async function closeEpisode({
  clinicId,
  user,
  roleKey,
  episodeId,
  input,
  ip,
  userAgent,
  now = new Date(),
}) {
  const scope = await assertTeamScope({ clinicId, user, roleKey, episodeId });
  const episode = await RecoveryEpisode.findOne({ _id: episodeId, clinic: clinicId }).lean();
  if (!episode) throw errors.notFound('Episode not found.');
  if (episode.closureState === 'closed' || episode.status === 'closed') {
    throw errors.conflict('This episode is already closed.');
  }
  if (episode.revision !== input.expectedRevision) {
    throw errors.conflict(
      'This episode changed since the closure page was opened. Reopen the preflight and try again.'
    );
  }

  // A closure reason must exist and must not read as a clinical outcome.
  const reason = String(input.reason || '').trim();
  if (reason.length < 5) throw errors.badRequest('Give a short reason for closing this episode.');
  if (policy.describesClinicalRecovery(reason)) {
    throw errors.badRequest(
      'A closure reason must describe the operational step, not a clinical outcome such as recovery.'
    );
  }

  const { normalised, problems } = policy.validatePolicyChecks(input.policyChecks);
  if (problems.length) throw errors.badRequest(problems.join(' '));

  const { items } = await collectPreflight({ clinicId, episode, now });
  const evaluation = policy.evaluatePreflight(items, input.overrides || []);
  if (evaluation.unknownOverrides.length) {
    throw errors.badRequest(`Unknown preflight item in an override: ${evaluation.unknownOverrides.join(', ')}.`);
  }
  if (!evaluation.canClose) {
    throw errors.conflict(
      `Closure is blocked by outstanding work: ${evaluation.blocking.join(', ')}. Clear it or record an override with a reason.`
    );
  }

  const closureDate = parseClosureDate(input.closureDate) || now;

  const result = await withTransaction(async (session) => {
    // The revision + state guard makes a concurrent close impossible: only one
    // request can move `open -> closed` for this revision.
    const updated = await RecoveryEpisode.findOneAndUpdate(
      {
        _id: episodeId,
        clinic: clinicId,
        revision: input.expectedRevision,
        closureState: { $ne: 'closed' },
      },
      {
        $set: {
          status: 'closed',
          closureState: 'closed',
          closedAt: now,
          closedBy: user.id,
          revision: input.expectedRevision + 1,
        },
      },
      { new: true, session }
    ).lean();
    if (!updated) {
      throw errors.conflict('This episode was changed or closed by someone else. Reopen the preflight and try again.');
    }

    const stopped = await stopFutureWork({ clinicId, episodeId, now, user, session });

    const closure = await EpisodeClosure.create(
      [
        {
          clinic: clinicId,
          episode: episodeId,
          patient: episode.patient,
          action: 'close',
          state: 'closed',
          reason,
          closureDate,
          actorUser: user.id,
          actorLabel: user.email,
          actorRole: roleKey,
          assignment: scope.assignment._id,
          policyChecks: normalised,
          preflight: items.map((item) => ({
            key: item.key,
            label: item.label,
            count: item.count,
            blocking: item.blocking,
          })),
          overrides: evaluation.clearedByOverride,
          episodeRevision: input.expectedRevision,
          stopped,
          ip,
          userAgent: userAgent ? String(userAgent).slice(0, 400) : undefined,
        },
      ],
      { session }
    );

    return { episode: updated, closure: closure[0], stopped };
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: roleKey,
    action: 'episode.closed',
    category: 'closure',
    subjectType: 'recovery_episode',
    subjectId: idOf(episodeId),
    targetType: 'episode_closure',
    targetId: idOf(result.closure),
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      reason,
      checks: normalised.filter((c) => c.confirmed).map((c) => c.key),
      overrides: evaluation.clearedByOverride.map((o) => o.key),
      stopped: result.stopped,
    },
  });

  return { episode: publicEpisode(result.episode), closure: publicClosure(result.closure) };
}

// ---- reopen ------------------------------------------------------------------

async function reopenEpisode({
  clinicId,
  user,
  roleKey,
  episodeId,
  input,
  ip,
  userAgent,
  now = new Date(),
}) {
  const scope = await assertTeamScope({ clinicId, user, roleKey, episodeId });
  const episode = await RecoveryEpisode.findOne({ _id: episodeId, clinic: clinicId }).lean();
  if (!episode) throw errors.notFound('Episode not found.');
  if (episode.closureState !== 'closed' && episode.status !== 'closed') {
    throw errors.conflict('This episode is not closed, so there is nothing to reopen.');
  }
  if (episode.revision !== input.expectedRevision) {
    throw errors.conflict('This episode changed since the history page was opened. Reload and try again.');
  }

  const reason = String(input.reason || '').trim();
  if (reason.length < 5) throw errors.badRequest('Give a short reason for reopening this episode.');

  const result = await withTransaction(async (session) => {
    const updated = await RecoveryEpisode.findOneAndUpdate(
      {
        _id: episodeId,
        clinic: clinicId,
        revision: input.expectedRevision,
        closureState: 'closed',
      },
      {
        $set: {
          status: 'active',
          closureState: 'open',
          reopenedAt: now,
          reopenedBy: user.id,
          revision: input.expectedRevision + 1,
        },
      },
      { new: true, session }
    ).lean();
    if (!updated) {
      throw errors.conflict('This episode was changed by someone else. Reload and try again.');
    }

    const closure = await EpisodeClosure.create(
      [
        {
          clinic: clinicId,
          episode: episodeId,
          patient: episode.patient,
          action: 'reopen',
          state: 'reopened',
          reason,
          closureDate: now,
          actorUser: user.id,
          actorLabel: user.email,
          actorRole: roleKey,
          assignment: scope.assignment._id,
          episodeRevision: input.expectedRevision,
          // Reopening does not revive stopped work; it only re-permits new work.
          stopped: { revived: 0, note: 'Stopped work is not revived; new schedules and reminders are created deliberately.' },
          ip,
          userAgent: userAgent ? String(userAgent).slice(0, 400) : undefined,
        },
      ],
      { session }
    );

    return { episode: updated, closure: closure[0] };
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: roleKey,
    action: 'episode.reopened',
    category: 'closure',
    subjectType: 'recovery_episode',
    subjectId: idOf(episodeId),
    targetType: 'episode_closure',
    targetId: idOf(result.closure),
    outcome: 'success',
    ip,
    userAgent,
    detail: { reason },
  });

  return { episode: publicEpisode(result.episode), closure: publicClosure(result.closure) };
}

// ---- reads -------------------------------------------------------------------

function publicClosure(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    action: doc.action,
    state: doc.state,
    reason: doc.reason,
    closureDate: doc.closureDate || null,
    actorLabel: doc.actorLabel || null,
    actorRole: doc.actorRole || null,
    policyChecks: (doc.policyChecks || []).map((c) => ({ key: c.key, confirmed: c.confirmed, note: c.note || null })),
    preflight: doc.preflight || [],
    overrides: doc.overrides || [],
    episodeRevision: doc.episodeRevision,
    stopped: doc.stopped || {},
    at: doc.createdAt,
  };
}

function publicEpisode(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    reference: doc.reference,
    status: doc.status,
    closureState: doc.closureState || 'open',
    closedAt: doc.closedAt || null,
    reopenedAt: doc.reopenedAt || null,
    revision: doc.revision,
  };
}

// The append-only closure history for one episode, newest first.
async function listClosures({ clinicId, user, roleKey, episodeId, page, limit }) {
  await assertTeamScope({ clinicId, user, roleKey, episodeId });
  const filter = { clinic: clinicId, episode: episodeId };
  const [rows, total] = await Promise.all([
    EpisodeClosure.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    EpisodeClosure.countDocuments(filter),
  ]);
  const holds = await RetentionHold.find({ clinic: clinicId, releasedAt: null })
    .select('category scope reason')
    .lean();
  return {
    items: rows.map(publicClosure),
    total,
    page,
    limit,
    retentionHolds: holds.map((h) => ({ category: h.category, scope: h.scope, reason: h.reason })),
    meaning: policy.CLOSURE_MEANING,
    note: 'Closure events are append-only. A reopen adds a new event; the earlier closure stays visible.',
  };
}

module.exports = {
  assertTeamScope,
  collectPreflight,
  preflight,
  closeEpisode,
  reopenEpisode,
  listClosures,
  publicClosure,
  publicEpisode,
  CLOSURE_ROLES: [ROLES.CARE_COORDINATOR, ROLES.CLINICAL_REVIEWER],
};
