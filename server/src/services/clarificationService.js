'use strict';

// Clarification queue (VEL-016). A patient, an authorized caregiver or a staff
// member asks a question about an episode; the question is answered by the RIGHT
// authority and the whole exchange is an audited conversation.
//
// Three commitments, enforced here rather than in the routes:
//
//   1. The state machine is the policy's. Every change goes through
//      `transition()`, which appends actor/time/history and refuses an illegal
//      move, so reopening a closed question is visible instead of silent.
//   2. The answer permission follows the thread's KIND. A clinical question
//      needs an eligible clinical reviewer who is ASSIGNED to it; an operational
//      question belongs to the assigned care coordinator.
//   3. A status line says what happened to the WORKFLOW. Messages are plain text
//      and the patient never sees an internal note.
const { errors } = require('./errors');
const audit = require('./auditService');
const policy = require('../policies/clarificationPolicy');
const clinicHoursPolicy = require('../policies/clinicHoursPolicy');
const carePlanService = require('./carePlanService');
const checkInService = require('./checkInService');
const {
  THREAD_STATES,
  THREAD_ACTIONS,
  THREAD_KINDS,
  PERMISSIONS,
  ROLES,
} = require('../config/constants');
const ClarificationThread = require('../models/ClarificationThread');
const ClarificationMessage = require('../models/ClarificationMessage');
const Clinic = require('../models/Clinic');
const ClinicMembership = require('../models/ClinicMembership');
const User = require('../models/User');

const NOT_FOUND = 'Question not found.';
// Re-declared here so the service reads as one story; it is the same permission
// the route layer requires.
const ASSIGN_PERMISSION = PERMISSIONS.QUESTION_ASSIGN;

function idOf(value) {
  return value && value._id ? String(value._id) : value === null || value === undefined ? null : String(value);
}

function publicMessage(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    kind: doc.kind,
    body: doc.body,
    authorLabel: doc.authorLabel || (doc.kind === 'system' ? 'System' : null),
    authorRole: doc.authorRole,
    patientVisible: doc.patientVisible !== false,
    answeredAs: doc.answeredAs || null,
    at: doc.createdAt,
  };
}

function publicThread(doc, { messages, guidance, viewer } = {}) {
  if (!doc) return null;
  const thread = {
    id: idOf(doc),
    episode: idOf(doc.episode),
    patient: idOf(doc.patient),
    response: idOf(doc.response),
    kind: doc.kind,
    subject: doc.subject,
    state: doc.state,
    openedByLabel: doc.openedByLabel || null,
    openedByRole: doc.openedByRole,
    openedAt: doc.createdAt,
    assignedTo: idOf(doc.assignedTo),
    assignedToLabel: doc.assignedToLabel || null,
    assignedAt: doc.assignedAt || null,
    answeredAt: doc.answeredAt || null,
    answeredByLabel: doc.answeredByLabel || null,
    closedAt: doc.closedAt || null,
    reopenedAt: doc.reopenedAt || null,
    reopenCount: doc.reopenCount || 0,
    messageCount: doc.messageCount || 0,
    lastMessageAt: doc.lastMessageAt || doc.createdAt,
    history: (doc.history || []).map((entry) => ({
      from: entry.from,
      to: entry.to,
      action: entry.action,
      actorLabel: entry.actorLabel || null,
      actorRole: entry.actorRole,
      note: entry.note || null,
      at: entry.at,
    })),
    notes: {
      state: policy.STATE_NOTE,
      monitoring: policy.NO_MONITORING_NOTE,
      answered: doc.state === THREAD_STATES.ANSWERED ? policy.ANSWERED_NOTE : null,
      reopened: doc.state === THREAD_STATES.REOPENED ? policy.REOPEN_NOTE : null,
      closed: doc.state === THREAD_STATES.CLOSED ? policy.CLOSED_NOTE : null,
    },
  };
  if (messages) thread.messages = messages.map(publicMessage);
  if (guidance) thread.guidance = guidance;
  if (viewer) thread.canAnswer = viewer.canAnswer;
  return thread;
}

async function clinicGuidance(clinicId) {
  const clinic = await Clinic.findById(clinicId).lean();
  return clinicHoursPolicy.responseHoursSummary(clinic);
}

// ---- visibility --------------------------------------------------------------

// An internal note is team-only. A patient or caregiver view is built from
// patient-visible messages alone, so a note can never leak by accident.
function messageFilterFor(capacity) {
  return capacity === 'team' ? {} : { patientVisible: true };
}

function assertThreadVisibleToCaregiver(grant) {
  const scopes = (grant && grant.scopes) || [];
  if (!scopes.includes('ask_questions')) {
    // A 404 keeps an out-of-scope caregiver from learning that a thread exists.
    throw errors.notFound(NOT_FOUND);
  }
}

async function guidanceAndThread(thread, capacity) {
  return publicThread(thread.toObject ? thread.toObject() : thread, {
    guidance: await clinicGuidance(thread.clinic),
    viewer: { canAnswer: false, capacity },
  });
}

// ---- messages ----------------------------------------------------------------

async function addMessage({
  thread,
  kind,
  body,
  author,
  authorLabel,
  authorRole,
  grant,
  patientVisible = true,
  answeredAs = null,
  at = new Date(),
  session,
}) {
  const [message] = await ClarificationMessage.create(
    [
      {
        clinic: thread.clinic,
        thread: thread._id || thread.id,
        episode: thread.episode,
        patient: thread.patient,
        kind,
        body,
        author: author || undefined,
        authorLabel: authorLabel || null,
        authorRole,
        authorGrant: grant ? grant._id || grant.id : undefined,
        patientVisible,
        answeredAs,
        createdAt: at,
      },
    ],
    session ? { session } : undefined
  );
  await ClarificationThread.updateOne(
    { _id: thread._id || thread.id },
    { $inc: { messageCount: 1 }, $set: { lastMessageAt: at } },
    session ? { session } : undefined
  );
  return message;
}

// The single transition path. It refuses an illegal move, appends the history
// entry and writes the system line, so no route can change a thread without
// leaving actor/time/history behind.
async function transition({ thread, action, actor, capacity, note, extra = {}, at = new Date() }) {
  const to = policy.assertTransition(thread.state, action);

  const entry = {
    from: thread.state,
    to,
    action,
    actorUser: actor.id,
    actorLabel: actor.email,
    actorRole: capacity,
    note,
    at,
  };

  const updated = await ClarificationThread.findOneAndUpdate(
    // Optimistic guard on the state we read: two simultaneous transitions cannot
    // both succeed, and the loser sees a conflict instead of a lost update.
    { _id: thread._id, clinic: thread.clinic, state: thread.state },
    { $set: { ...extra, state: to }, $push: { history: entry } },
    { new: true }
  );
  if (!updated) {
    throw errors.conflict('This question changed while you were working on it. Reload and try again.');
  }

  await addMessage({
    thread: updated,
    kind: 'system',
    body: policy.systemMessage(action, { actorLabel: actor.email, toState: to, note }),
    author: actor.id,
    authorLabel: actor.email,
    authorRole: 'system',
    patientVisible: true,
    at,
  });

  return updated;
}

// ---- authority ---------------------------------------------------------------

async function staffScope({ clinicId, user, roleKey, episodeId }) {
  return checkInService.resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
}

async function loadThread({ clinicId, threadId }) {
  const thread = await ClarificationThread.findOne({ _id: threadId, clinic: clinicId });
  if (!thread) throw errors.notFound(NOT_FOUND);
  return thread;
}

// A clinical answer needs an ELIGIBLE reviewer who is ASSIGNED to this thread and
// currently on the episode's care team. Assignment alone, or eligibility alone,
// is not enough.
async function isAssignedReviewer({ thread, user }) {
  if (!thread.assignedTo || String(thread.assignedTo) !== String(user.id)) return false;
  try {
    const membership = await carePlanService.assertReviewerAuthority({
      clinicId: thread.clinic,
      user,
      episodeId: thread.episode,
      roleKey: ROLES.CLINICAL_REVIEWER,
    });
    return Boolean(membership);
  } catch {
    return false;
  }
}

async function assignableReviewer({ thread, memberUserId }) {
  const membership = await ClinicMembership.findOne({
    clinic: thread.clinic,
    user: memberUserId,
    status: 'active',
  }).lean();
  if (!membership) throw errors.badRequest('That person is not an active member of this clinic.');
  if (membership.roleKey !== ROLES.CLINICAL_REVIEWER || !membership.reviewerEligibility || membership.reviewerEligibility.status !== 'verified') {
    throw errors.badRequest('A clinical question can only be assigned to a clinic-verified clinical reviewer.');
  }
  await carePlanService.assertReviewerAuthority({
    clinicId: thread.clinic,
    user: { id: memberUserId },
    episodeId: thread.episode,
    roleKey: ROLES.CLINICAL_REVIEWER,
  });
  return membership;
}

// ---- operations --------------------------------------------------------------

async function openThread({
  clinicId,
  user,
  roleKey,
  episodeId,
  kind,
  subject,
  body,
  responseId,
  ip,
  userAgent,
  at = new Date(),
}) {
  const scope = await staffScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity === 'caregiver') {
    assertThreadVisibleToCaregiver(scope.grant);
    if (!scope.grant.scopes.includes('ask_questions')) throw errors.notFound(NOT_FOUND);
  }

  const problems = [...policy.validateSubject(subject), ...policy.validateBody(body)];
  if (problems.length) throw errors.badRequest(problems.join(' '));
  if (!Object.values(THREAD_KINDS).includes(kind)) throw errors.badRequest('Choose a question kind.');

  // A question may be asked about a closed episode: the conversation is how a
  // care team is still reachable, and nothing here changes the clinical record.
  const thread = await ClarificationThread.create({
    clinic: clinicId,
    episode: scope.episode._id,
    patient: scope.episode.patient,
    response: responseId || null,
    kind,
    subject,
    state: THREAD_STATES.OPEN,
    openedBy: user.id,
    openedByLabel: user.email,
    openedByRole: scope.capacity,
    openedByGrant: scope.grant ? scope.grant._id : undefined,
    history: [
      {
        from: THREAD_STATES.OPEN,
        to: THREAD_STATES.OPEN,
        action: THREAD_ACTIONS.OPEN,
        actorUser: user.id,
        actorLabel: user.email,
        actorRole: scope.capacity,
        at,
      },
    ],
  });

  await addMessage({
    thread,
    kind: 'question',
    body,
    author: user.id,
    authorLabel: user.email,
    authorRole: scope.capacity,
    grant: scope.grant,
    at,
  });
  await addMessage({
    thread,
    kind: 'system',
    body: policy.systemMessage(THREAD_ACTIONS.OPEN, { actorLabel: user.email }),
    author: user.id,
    authorLabel: user.email,
    authorRole: 'system',
    at,
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'clarification.opened',
    targetType: 'clarification_thread',
    targetId: idOf(thread),
    outcome: 'success',
    ip,
    userAgent,
    detail: { kind, capacity: scope.capacity, episode: idOf(scope.episode) },
  });

  return {
    thread: await guidanceAndThread(await loadThread({ clinicId, threadId: thread._id }), scope.capacity),
  };
}

async function listThreads({ clinicId, user, roleKey, episodeId, state, assignedToMe, page, limit }) {
  const scope = await staffScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity === 'caregiver') assertThreadVisibleToCaregiver(scope.grant);

  const filter = { clinic: clinicId, episode: scope.episode._id };
  if (state) filter.state = state;
  if (assignedToMe) filter.assignedTo = user.id;

  const [rows, total] = await Promise.all([
    ClarificationThread.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ClarificationThread.countDocuments(filter),
  ]);

  return {
    items: rows.map((row) => publicThread(row)),
    total,
    page,
    limit,
    capacity: scope.capacity,
    // The response hours, contact guidance and emergency instructions travel
    // with the queue so the surface can never show a question without them.
    guidance: await clinicGuidance(clinicId),
  };
}

async function getThread({ clinicId, user, roleKey, permissions, episodeId, threadId }) {
  const scope = await staffScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity === 'caregiver') assertThreadVisibleToCaregiver(scope.grant);

  const thread = await loadThread({ clinicId, threadId });
  if (String(thread.episode) !== String(scope.episode._id)) throw errors.notFound(NOT_FOUND);

  const messages = await ClarificationMessage.find({
    thread: thread._id,
    ...messageFilterFor(scope.capacity),
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(policy.THREAD_MAX_MESSAGES)
    .lean();

  const assigned =
    scope.capacity === 'team'
      ? await isAssignedReviewer({ thread, user })
      : false;

  return {
    thread: publicThread(thread.toObject(), {
      messages,
      guidance: await clinicGuidance(clinicId),
      viewer: {
        capacity: scope.capacity,
        // The caller's own permission set, resolved by the auth middleware.
        canAnswer:
          scope.capacity === 'team'
            ? policy.canAnswer({
                kind: thread.kind,
                permissions,
                isAssignedReviewer: assigned,
              })
            : false,
      },
    }),
    capacity: scope.capacity,
  };
}

async function assign({ clinicId, user, permissions, roleKey, threadId, assigneeUserId, note, ip, userAgent, at = new Date() }) {
  const thread = await loadThread({ clinicId, threadId });
  await assertTeamThreadAccess({ clinicId, user, roleKey, thread });

  if (!permissions.has(ASSIGN_PERMISSION)) {
    throw errors.forbidden('Assigning a question requires the assignment permission.');
  }

  let assigneeLabel = null;
  if (thread.kind === THREAD_KINDS.CLINICAL) {
    await assignableReviewer({ thread, memberUserId: assigneeUserId });
  } else {
    const target = await ClinicMembership.findOne({
      clinic: clinicId,
      user: assigneeUserId,
      status: 'active',
    }).lean();
    if (!target) throw errors.badRequest('That person is not an active member of this clinic.');
  }
  const assignee = await User.findById(assigneeUserId).lean();
  assigneeLabel = (assignee && assignee.email) || null;

  const updated = await transition({
    thread,
    action: THREAD_ACTIONS.ASSIGN,
    actor: user,
    capacity: 'staff',
    note,
    at,
    extra: { assignedTo: assigneeUserId, assignedToLabel: assigneeLabel, assignedAt: at, assignedBy: user.id },
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'clarification.assigned',
    targetType: 'clarification_thread',
    targetId: idOf(thread),
    outcome: 'success',
    ip,
    userAgent,
    detail: { kind: thread.kind, assigneeUserId: String(assigneeUserId), roleKey },
  });

  return { thread: await guidanceAndThread(updated, 'team') };
}

async function assertTeamThreadAccess({ clinicId, user, roleKey, thread }) {
  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot read or answer clarification questions.');
  }
  const scope = await checkInService.resolveEpisodeScope({
    clinicId,
    user,
    roleKey,
    episodeId: thread.episode,
  });
  if (scope.capacity !== 'team') {
    throw errors.forbidden('Only the assigned care team may work this clarification queue.');
  }
  return scope;
}

async function answer({ clinicId, user, roleKey, permissions, threadId, body, note, ip, userAgent, at = new Date() }) {
  const thread = await loadThread({ clinicId, threadId });
  await assertTeamThreadAccess({ clinicId, user, roleKey, thread });

  const assigned = await isAssignedReviewer({ thread, user });
  const allowed = policy.canAnswer({ kind: thread.kind, permissions, isAssignedReviewer: assigned });
  if (!allowed) {
    throw errors.forbidden(
      thread.kind === THREAD_KINDS.CLINICAL
        ? 'A clinical question can only be answered by the assigned, clinic-verified clinical reviewer.'
        : 'Only an assigned care coordinator may answer an operational question.'
    );
  }

  const problems = policy.validateBody(body);
  if (problems.length) throw errors.badRequest(problems.join(' '));

  await addMessage({
    thread,
    kind: 'answer',
    body,
    author: user.id,
    authorLabel: user.email,
    authorRole: 'staff',
    answeredAs: thread.kind,
    at,
  });

  const updated = await transition({
    thread,
    action: THREAD_ACTIONS.ANSWER,
    actor: user,
    capacity: 'staff',
    note,
    at,
    extra: {
      answeredAt: at,
      answeredBy: user.id,
      answeredByLabel: user.email,
    },
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'clarification.answered',
    targetType: 'clarification_thread',
    targetId: idOf(thread),
    outcome: 'success',
    ip,
    userAgent,
    detail: { kind: thread.kind, answeredAs: thread.kind },
  });

  return { thread: await guidanceAndThread(updated, 'team') };
}

async function note({ clinicId, user, roleKey, threadId, body, at = new Date() }) {
  const thread = await loadThread({ clinicId, threadId });
  await assertTeamThreadAccess({ clinicId, user, roleKey, thread });
  const problems = policy.validateBody(body);
  if (problems.length) throw errors.badRequest(problems.join(' '));

  await addMessage({
    thread,
    kind: 'note',
    body,
    author: user.id,
    authorLabel: user.email,
    authorRole: 'staff',
    // An internal note is never shown to the patient.
    patientVisible: false,
    at,
  });
  const fresh = await loadThread({ clinicId, threadId });
  return { thread: await guidanceAndThread(fresh, 'team') };
}

async function close({ clinicId, user, threadId, capacity, note, ip, userAgent, at = new Date() }) {
  const thread = await loadThread({ clinicId, threadId });
  const scope = await checkInService.resolveEpisodeScope({
    clinicId,
    user,
    episodeId: thread.episode,
  });
  if (scope.capacity !== capacity) {
    throw errors.forbidden('You cannot close this question.');
  }
  if (capacity === 'caregiver') assertThreadVisibleToCaregiver(scope.grant);

  const updated = await transition({
    thread,
    action: THREAD_ACTIONS.CLOSE,
    actor: user,
    capacity,
    note,
    at,
    extra: { closedAt: at, closedBy: user.id },
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'clarification.closed',
    targetType: 'clarification_thread',
    targetId: idOf(thread),
    outcome: 'success',
    ip,
    userAgent,
    detail: { capacity },
  });

  return { thread: await guidanceAndThread(updated, capacity) };
}

async function reopen({ clinicId, user, threadId, capacity, note, ip, userAgent, at = new Date() }) {
  const thread = await loadThread({ clinicId, threadId });
  const scope = await checkInService.resolveEpisodeScope({
    clinicId,
    user,
    episodeId: thread.episode,
  });
  if (scope.capacity !== capacity) throw errors.forbidden('You cannot reopen this question.');
  if (capacity === 'caregiver') assertThreadVisibleToCaregiver(scope.grant);

  const updated = await transition({
    thread,
    action: THREAD_ACTIONS.REOPEN,
    actor: user,
    capacity,
    note,
    at,
    extra: {},
  });
  // The reopen counter is its own fact, incremented only here.
  const counted = await ClarificationThread.findOneAndUpdate(
    { _id: thread._id },
    { $inc: { reopenCount: 1 }, $set: { reopenedAt: at } },
    { new: true }
  );

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'clarification.reopened',
    targetType: 'clarification_thread',
    targetId: idOf(thread),
    outcome: 'success',
    ip,
    userAgent,
    detail: { capacity, reopenCount: counted.reopenCount },
  });

  return { thread: await guidanceAndThread(counted, capacity) };
}

async function reclassify({ clinicId, user, roleKey, permissions, threadId, note, ip, userAgent, at = new Date() }) {
  const thread = await loadThread({ clinicId, threadId });
  await assertTeamThreadAccess({ clinicId, user, roleKey, thread });
  if (!permissions.has(ASSIGN_PERMISSION)) {
    throw errors.forbidden('Moving a question to the clinical queue requires the assignment permission.');
  }
  if (thread.kind === THREAD_KINDS.CLINICAL) {
    throw errors.conflict('This question is already in the clinical queue.');
  }

  const updated = await transition({
    thread,
    action: THREAD_ACTIONS.RECLASSIFY,
    actor: user,
    capacity: 'staff',
    note,
    at,
    extra: { kind: THREAD_KINDS.CLINICAL },
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'clarification.reclassified',
    targetType: 'clarification_thread',
    targetId: idOf(thread),
    outcome: 'success',
    ip,
    userAgent,
    detail: { from: thread.kind, to: THREAD_KINDS.CLINICAL },
  });

  return { thread: await guidanceAndThread(updated, 'team') };
}

// ---- the asker's own surfaces ------------------------------------------------

async function ownThreads({ clinicId, patientId, page, limit }) {
  const [rows, total] = await Promise.all([
    ClarificationThread.find({ clinic: clinicId, patient: patientId })
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ClarificationThread.countDocuments({ clinic: clinicId, patient: patientId }),
  ]);
  return {
    items: rows.map((row) => publicThread(row)),
    total,
    page,
    limit,
    guidance: await clinicGuidance(clinicId),
  };
}

async function ownThreadMessages({ clinicId, patientId, threadId }) {
  const thread = await loadThread({ clinicId, threadId });
  if (String(thread.patient) !== String(patientId)) throw errors.notFound(NOT_FOUND);
  const messages = await ClarificationMessage.find({ thread: thread._id, patientVisible: true })
    .sort({ createdAt: 1, _id: 1 })
    .limit(policy.THREAD_MAX_MESSAGES)
    .lean();
  return {
    thread: publicThread(thread.toObject(), {
      messages,
      guidance: await clinicGuidance(clinicId),
    }),
  };
}

// A follow-up message from the asker. It appends to the conversation and never
// rewrites the subject, so the thread stays readable end to end.
async function askerReply({ clinicId, user, threadId, body, capacity, grant, ip, userAgent, at = new Date() }) {
  const thread = await loadThread({ clinicId, threadId });
  const scope = await checkInService.resolveEpisodeScope({
    clinicId,
    user,
    episodeId: thread.episode,
  });
  if (scope.capacity !== capacity) throw errors.notFound(NOT_FOUND);
  if (capacity === 'caregiver') assertThreadVisibleToCaregiver(scope.grant);

  const problems = policy.validateBody(body);
  if (problems.length) throw errors.badRequest(problems.join(' '));

  await addMessage({
    thread,
    kind: 'question',
    body,
    author: user.id,
    authorLabel: user.email,
    authorRole: capacity,
    grant,
    at,
  });

  // A reply on a settled thread re-opens the work in front of the team.
  let updated = await loadThread({ clinicId, threadId });
  if ([THREAD_STATES.ANSWERED, THREAD_STATES.CLOSED].includes(updated.state)) {
    updated = await transition({
      thread: updated,
      action: THREAD_ACTIONS.REOPEN,
      actor: user,
      capacity,
      note: 'A reply was added.',
      at,
      extra: {},
    });
    updated = await ClarificationThread.findOneAndUpdate(
      { _id: thread._id },
      { $inc: { reopenCount: 1 }, $set: { reopenedAt: at } },
      { new: true }
    );
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'clarification.replied',
    targetType: 'clarification_thread',
    targetId: idOf(thread),
    outcome: 'success',
    ip,
    userAgent,
    detail: { capacity, state: updated.state },
  });

  return ownThreadMessages({ clinicId, patientId: thread.patient, threadId });
}

// ---- caregiver entry points --------------------------------------------------

// A caregiver holds no clinic-wide permission and the caregiver routes carry no
// clinic context, so the episode is looked up first and the CLINIC then comes
// from the caregiver's own active grant on that episode's patient. An
// out-of-scope caregiver learns nothing.
async function caregiverEpisodeScope({ user, episodeId }) {
  const episode = await checkInService.loadEpisode({ episodeId });
  const grant = await checkInService.caregiverGrantFor({ user, patientId: episode.patient });
  if (!grant || !(grant.scopes || []).includes('ask_questions')) {
    throw errors.notFound(NOT_FOUND);
  }
  return { episode, grant, clinicId: String(episode.clinic) };
}

async function caregiverThreadScope({ user, threadId }) {
  const thread = await ClarificationThread.findById(threadId).lean();
  if (!thread) throw errors.notFound(NOT_FOUND);
  const grant = await checkInService.caregiverGrantFor({ user, patientId: thread.patient });
  if (!grant || !(grant.scopes || []).includes('ask_questions')) {
    throw errors.notFound(NOT_FOUND);
  }
  return { thread, grant, clinicId: String(thread.clinic) };
}

async function caregiverThreads({ user, patientId, page, limit }) {
  const grant = await checkInService.caregiverGrantFor({ user, patientId });
  if (!grant || !(grant.scopes || []).includes('ask_questions')) {
    throw errors.notFound(NOT_FOUND);
  }
  return ownThreads({ clinicId: grant.clinic, patientId, page, limit });
}

module.exports = {
  openThread,
  caregiverThreads,
  caregiverEpisodeScope,
  caregiverThreadScope,
  listThreads,
  getThread,
  assign,
  answer,
  note,
  close,
  reopen,
  reclassify,
  ownThreads,
  ownThreadMessages,
  askerReply,
  publicThread,
  publicMessage,
  isAssignedReviewer,
  transition,
  addMessage,
};
