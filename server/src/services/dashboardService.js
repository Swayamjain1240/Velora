'use strict';

// The assigned-team dashboard (Part 8).
//
// Two rules shape everything here:
//
//   1. EVERY list and EVERY count is tenant-scoped AND assignment-scoped. The
//      scope is the caller's ACTIVE care-team assignments, resolved server-side
//      on each request, so a colleague who is not on the episode sees neither the
//      item nor its count.
//   2. Being an administrator is not a way in. Admin status holds no clinical
//      permission and the dashboard is clinical work, so an admin is refused
//      outright rather than handed a narrower view.
//
// The queues are workflow queues: an approval waiting for a person, a question
// waiting for an answer, a check-in a clinic rule asked someone to look at, a
// reminder that failed to deliver, and an item with nobody accountable for it.
// None of them is a clinical judgement about a patient.
const { errors } = require('./errors');
const audit = require('./auditService');
const policy = require('../policies/clarificationPolicy');
const {
  QUEUE_KEYS,
  QUEUE_TARGETS,
  ROLES,
  THREAD_STATES,
  CHECKIN_REVIEW_STATES,
} = require('../config/constants');
const { STATES } = require('../policies/carePlanPolicy');
const QueueAssignment = require('../models/QueueAssignment');
const CareTeamAssignment = require('../models/CareTeamAssignment');
const CarePlanVersion = require('../models/CarePlanVersion');
const ClarificationThread = require('../models/ClarificationThread');
const CheckInResponse = require('../models/CheckInResponse');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const PatientProfile = require('../models/PatientProfile');
const Notification = require('../models/Notification');

const QUEUES = Object.freeze([
  QUEUE_KEYS.PENDING_APPROVALS,
  QUEUE_KEYS.OPEN_QUESTIONS,
  QUEUE_KEYS.CHECKIN_REVIEWS,
  QUEUE_KEYS.FAILED_REMINDERS,
  QUEUE_KEYS.MISSING_OWNERS,
]);

const MAX_PER_QUEUE = 100;

function idOf(value) {
  return value && value._id ? String(value._id) : value === null || value === undefined ? null : String(value);
}

// ---- scope -------------------------------------------------------------------

// The caller's assignment scope: the episodes this person is actively on, split
// by responsibility. Nothing here is taken from the request.
async function resolveScope({ clinicId, user, roleKey }) {
  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot browse assigned clinical queues.');
  }
  if (roleKey === ROLES.PATIENT || roleKey === ROLES.CAREGIVER) {
    throw errors.forbidden('This dashboard is for assigned care-team staff.');
  }

  const assignments = await CareTeamAssignment.find({
    clinic: clinicId,
    memberUser: user.id,
    status: 'active',
  }).lean();

  const episodeIds = assignments.map((a) => a.episode);
  const asReviewer = assignments
    .filter((a) => a.responsibility === 'clinical_reviewer')
    .map((a) => a.episode);
  const asCoordinator = assignments
    .filter((a) => a.responsibility === 'care_coordinator')
    .map((a) => a.episode);

  return { assignments, episodeIds, asReviewer, asCoordinator };
}

function scoped(filter, scope) {
  return { ...filter, episode: { $in: scope.episodeIds } };
}

// ---- queue readers -----------------------------------------------------------

async function pendingApprovals({ clinicId, scope, user }) {
  const rows = await CarePlanVersion.find(
    scoped({ clinic: clinicId, state: STATES.IN_REVIEW }, scope)
  )
    .sort({ submittedAt: 1, createdAt: 1 })
    .limit(MAX_PER_QUEUE)
    .lean();

  const owners = await activeOwners({
    clinicId,
    queueKey: QUEUE_KEYS.PENDING_APPROVALS,
    targets: rows.map((r) => r._id),
  });

  return rows.map((row) => ({
    id: idOf(row),
    queue: QUEUE_KEYS.PENDING_APPROVALS,
    targetType: QUEUE_TARGETS.PLAN_VERSION,
    episode: idOf(row.episode),
    patient: idOf(row.patient),
    title: row.title || `Plan version ${row.version}`,
    version: row.version,
    state: row.state,
    since: row.submittedAt || row.createdAt,
    // Whether THIS caller is the responsible reviewer for the episode, which is
    // what makes a queue "assigned" rather than merely visible.
    mine: scope.asReviewer.some((id) => String(id) === idOf(row.episode)),
    owner: owners.get(idOf(row)) || null,
    route: { surface: 'episode', episodeId: idOf(row.episode), planId: idOf(row) },
  }));
}

async function openQuestions({ clinicId, scope, user }) {
  const rows = await ClarificationThread.find(
    scoped({ clinic: clinicId, state: { $in: [THREAD_STATES.OPEN, THREAD_STATES.ASSIGNED, THREAD_STATES.REOPENED] } }, scope)
  )
    .sort({ lastMessageAt: 1, createdAt: 1 })
    .limit(MAX_PER_QUEUE)
    .lean();

  const owners = await activeOwners({
    clinicId,
    queueKey: QUEUE_KEYS.OPEN_QUESTIONS,
    targets: rows.map((r) => r._id),
  });

  return rows.map((row) => {
    const owner = owners.get(idOf(row)) || null;
    return {
      id: idOf(row),
      queue: QUEUE_KEYS.OPEN_QUESTIONS,
      targetType: QUEUE_TARGETS.THREAD,
      episode: idOf(row.episode),
      patient: idOf(row.patient),
      title: row.subject,
      kind: row.kind,
      state: row.state,
      since: row.lastMessageAt || row.createdAt,
      // A CLINICAL question is only answerable by an assigned verified reviewer,
      // so the queue says which authority it needs rather than implying anyone
      // can pick it up.
      requires: row.kind === 'clinical' ? 'clinical_reviewer' : 'care_coordinator',
      mine: owner ? owner.assigneeUser === idOf(user) : false,
      owner,
      route: { surface: 'question', episodeId: idOf(row.episode), threadId: idOf(row) },
    };
  });
}

async function checkInReviews({ clinicId, scope, user }) {
  const rows = await CheckInResponse.find(
    scoped(
      { clinic: clinicId, reviewState: CHECKIN_REVIEW_STATES.NEEDS_REVIEW },
      scope
    )
  )
    .sort({ submittedAt: 1 })
    .limit(MAX_PER_QUEUE)
    .lean();

  const owners = await activeOwners({
    clinicId,
    queueKey: QUEUE_KEYS.CHECKIN_REVIEWS,
    targets: rows.map((r) => r._id),
  });

  return rows.map((row) => {
    const owner = owners.get(idOf(row)) || null;
    return {
      id: idOf(row),
      queue: QUEUE_KEYS.CHECKIN_REVIEWS,
      targetType: QUEUE_TARGETS.CHECKIN_RESPONSE,
      episode: idOf(row.episode),
      patient: idOf(row.patient),
      title: `${row.templateKey} (${row.slotDate})`,
      state: row.reviewState,
      since: row.submittedAt,
      // A clinic rule asked a person to look. The queue repeats that framing: it
      // is workflow attention, never a diagnosis.
      attention: policy.systemMessage('open', { actorLabel: 'The clinic rule' }),
      rules: (row.triggeredRules || []).map((r) => ({ id: r.id, label: r.label })),
      mine: owner ? owner.assigneeUser === idOf(user) : false,
      owner,
      route: { surface: 'check_in', episodeId: idOf(row.episode), responseId: idOf(row) },
    };
  });
}

async function failedReminders({ clinicId, scope, user }) {
  if (!scope.episodeIds.length) return [];
  const rows = await Notification.find({
    clinic: clinicId,
    state: 'failed',
    episode: { $in: scope.episodeIds },
  })
    .sort({ updatedAt: -1 })
    .limit(MAX_PER_QUEUE)
    .lean();

  const owners = await activeOwners({
    clinicId,
    queueKey: QUEUE_KEYS.FAILED_REMINDERS,
    targets: rows.map((r) => r._id),
  });

  return rows.map((row) => {
    const owner = owners.get(idOf(row)) || null;
    return {
      id: idOf(row),
      queue: QUEUE_KEYS.FAILED_REMINDERS,
      targetType: QUEUE_TARGETS.NOTIFICATION,
      episode: idOf(row.episode),
      patient: idOf(row.patient),
      title: row.title,
      state: row.state,
      attempts: row.attempts || 0,
      lastError: row.lastError || null,
      since: row.updatedAt,
      // A delivery failure is an operational fact, never a statement about the
      // patient or their treatment.
      mine: owner ? owner.assigneeUser === idOf(user) : false,
      owner,
      route: { surface: 'reminder', episodeId: idOf(row.episode), notificationId: idOf(row) },
    };
  });
}

// "Missing owners": work that is inside the caller's own assignment scope but has
// nobody accountable for it. It is the queue that keeps the other four honest.
async function missingOwners({ clinicId, scope, user }) {
  const [approvals, questions, reviews, reminders] = await Promise.all([
    pendingApprovals({ clinicId, scope, user }),
    openQuestions({ clinicId, scope, user }),
    checkInReviews({ clinicId, scope, user }),
    failedReminders({ clinicId, scope, user }),
  ]);

  const unowned = [...approvals, ...questions, ...reviews, ...reminders].filter(
    (item) => !item.owner
  );

  // An episode with no active care coordinator at all is the most fundamental
  // missing owner, so it is listed too.
  const coordinatorEpisodes = new Set(scope.asCoordinator.map(String));
  const reviewerEpisodes = new Set(scope.asReviewer.map(String));
  const episodes = await RecoveryEpisode.find({ clinic: clinicId, _id: { $in: scope.episodeIds } })
    .select('reference patient status')
    .lean();

  const rows = unowned.map((item) => ({ ...item, queue: QUEUE_KEYS.MISSING_OWNERS }));

  for (const episode of episodes) {
    const id = idOf(episode);
    if (coordinatorEpisodes.has(id) && reviewerEpisodes.has(id)) continue;
    rows.push({
      id: `${id}:care_team`,
      queue: QUEUE_KEYS.MISSING_OWNERS,
      targetType: QUEUE_TARGETS.EPISODE,
      episode: id,
      patient: idOf(episode.patient),
      title: `Care team for ${episode.reference}`,
      state: episode.status,
      // Which responsibility is missing - the actionable half of the fact.
      missing: [
        coordinatorEpisodes.has(id) ? null : 'care_coordinator',
        reviewerEpisodes.has(id) ? null : 'clinical_reviewer',
      ].filter(Boolean),
      mine: false,
      owner: null,
      route: { surface: 'episode', episodeId: id },
    });
  }

  return rows.slice(0, MAX_PER_QUEUE);
}

const READERS = Object.freeze({
  [QUEUE_KEYS.PENDING_APPROVALS]: pendingApprovals,
  [QUEUE_KEYS.OPEN_QUESTIONS]: openQuestions,
  [QUEUE_KEYS.CHECKIN_REVIEWS]: checkInReviews,
  [QUEUE_KEYS.FAILED_REMINDERS]: failedReminders,
  [QUEUE_KEYS.MISSING_OWNERS]: missingOwners,
});

// ---- ownership ---------------------------------------------------------------

// The id and label of the current owner of each item, so a caller can filter and
// claim without a second round trip.
async function activeOwners({ clinicId, queueKey, targets }) {
  if (!targets.length) return new Map();
  const rows = await QueueAssignment.find({
    clinic: clinicId,
    queueKey,
    target: { $in: targets },
    status: 'active',
  }).lean();
  const map = new Map();
  for (const row of rows) {
    map.set(idOf(row.target), {
      assignmentId: idOf(row),
      assigneeUser: idOf(row.assigneeUser),
      assigneeLabel: row.assigneeLabel || null,
      assignedAt: row.assignedAt,
      claimedBySelf: Boolean(row.claimedBySelf),
    });
  }
  return map;
}

async function myAssignments({ clinicId, user, page, limit }) {
  const filter = { clinic: clinicId, assigneeUser: user.id, status: 'active' };
  const [items, total] = await Promise.all([
    QueueAssignment.find(filter)
      .sort({ assignedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    QueueAssignment.countDocuments(filter),
  ]);
  return {
    items: items.map((row) => ({
      id: idOf(row),
      queue: row.queueKey,
      targetType: row.targetType,
      target: idOf(row.target),
      episode: idOf(row.episode),
      patient: idOf(row.patient),
      assigneeLabel: row.assigneeLabel || null,
      claimedBySelf: Boolean(row.claimedBySelf),
      assignedAt: row.assignedAt,
    })),
    total,
    page,
    limit,
  };
}

// ---- dashboard reads ---------------------------------------------------------

async function summary({ clinicId, user, roleKey }) {
  const scope = await resolveScope({ clinicId, user, roleKey });
  const results = await Promise.all(
    QUEUES.map(async (queueKey) => [queueKey, await READERS[queueKey]({ clinicId, scope, user })])
  );
  const counts = { total: 0, mine: 0, unowned: 0 };
  const byQueue = {};
  for (const [queueKey, items] of results) {
    const mine = items.filter((item) => item.mine).length;
    const unowned = items.filter((item) => !item.owner).length;
    byQueue[queueKey] = { count: items.length, mine, unowned };
    counts[queueKey] = items.length;
    counts.total += items.length;
    counts.mine += mine;
    counts.unowned += unowned;
  }
  return {
    counts: { ...counts, byQueue },
    episodes: scope.episodeIds.length,
    // The dashboard is a workflow aid on top of the clinic's published hours.
    note: 'These queues are workflow lists for assigned care-team staff. They are not monitored continuously, and an item appearing here is not a clinical finding.',
  };
}

async function queue({ clinicId, user, roleKey, queueKey, page, limit, mineOnly }) {
  if (!QUEUES.includes(queueKey)) throw errors.badRequest('Unknown queue.');
  const scope = await resolveScope({ clinicId, user, roleKey });
  const items = await READERS[queueKey]({ clinicId, scope, user });
  const filtered = mineOnly ? items.filter((item) => item.mine) : items;
  const start = (page - 1) * limit;
  return {
    queue: queueKey,
    items: filtered.slice(start, start + limit),
    total: filtered.length,
    page,
    limit,
    summary: await summary({ clinicId, user, roleKey }),
  };
}

// ---- claim and release -------------------------------------------------------

// Only an item inside the caller's OWN assignment scope can be claimed, so the
// dashboard cannot be used to reach work that is not theirs.
async function claim({ clinicId, user, roleKey, queueKey, targetId, ip, userAgent }) {
  if (!QUEUES.includes(queueKey)) throw errors.badRequest('Unknown queue.');
  const scope = await resolveScope({ clinicId, user, roleKey });
  const items = await READERS[queueKey]({ clinicId, scope, user });
  const item = items.find((row) => String(row.id) === String(targetId));
  if (!item) throw errors.notFound('That item is not in your assigned queues.');

  let assignment;
  try {
    assignment = await QueueAssignment.create({
      clinic: clinicId,
      queueKey,
      targetType: item.targetType,
      // A synthetic missing-owner row is not a claimable document.
      target: item.targetType === QUEUE_TARGETS.EPISODE ? item.episode : targetId,
      patient: item.patient,
      episode: item.episode,
      assigneeUser: user.id,
      assigneeLabel: user.email,
      status: 'active',
      assignedBy: user.id,
      assignedByLabel: user.email,
      claimedBySelf: true,
      assignedAt: new Date(),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      throw errors.conflict('Someone else already owns that item.');
    }
    throw err;
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'dashboard.claimed',
    targetType: 'queue_assignment',
    targetId: idOf(assignment),
    outcome: 'success',
    ip,
    userAgent,
    detail: { queueKey, target: String(targetId) },
  });

  return {
    assignment: {
      id: idOf(assignment),
      queue: assignment.queueKey,
      target: idOf(assignment.target),
      assigneeLabel: assignment.assigneeLabel,
      assignedAt: assignment.assignedAt,
    },
  };
}

async function release({ clinicId, user, assignmentId, reason, ip, userAgent }) {
  // A caller may release their OWN assignment, and the query itself is scoped to
  // them: an assignment owned by someone else is simply not theirs to see, which
  // is a 404 rather than a confirmation that it exists.
  const assignment = await QueueAssignment.findOne({
    _id: assignmentId,
    clinic: clinicId,
    assigneeUser: user.id,
    status: 'active',
  });
  if (!assignment) throw errors.notFound('That assignment is not active, or it is not yours.');

  const released = await QueueAssignment.findOneAndUpdate(
    { _id: assignment._id, status: 'active' },
    {
      $set: {
        status: 'released',
        releasedBy: user.id,
        releasedAt: new Date(),
        releaseReason: reason,
      },
    },
    { new: true }
  );
  if (!released) throw errors.conflict('That assignment was released already.');

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'dashboard.released',
    targetType: 'queue_assignment',
    targetId: idOf(released),
    outcome: 'success',
    ip,
    userAgent,
    detail: { queueKey: released.queueKey },
  });

  return { released: true };
}

module.exports = {
  QUEUES,
  resolveScope,
  summary,
  queue,
  claim,
  release,
  myAssignments,
  pendingApprovals,
  openQuestions,
  checkInReviews,
  failedReminders,
  missingOwners,
};
