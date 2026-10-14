'use strict';

// In-app reminders (VEL-014, Part 8).
//
// The flow is deliberately boring and auditable:
//
//   queue  ->  recheck  ->  deliver (bounded retries)  ->  visible outcome
//
//   * QUEUEING derives reminders from work that is actually due (a check-in slot,
//     a scheduled occurrence, a prescribed follow-up) and de-duplicates them by
//     recipient + event version + channel, so running the queue twice changes
//     nothing.
//   * RECHECK happens immediately before delivery. A closed episode, a superseded
//     plan version, an ended task or a revoked recipient stops the reminder, and
//     the reason is recorded as a SKIPPED attempt rather than a silent drop.
//   * DELIVERY is bounded: attempts are counted, the retry delay grows, and the
//     attempt chain either delivers or leaves the reminder visibly FAILED.
//   * Delivery is NOT acknowledgement: only an explicit action by the recipient
//     sets `acknowledgedAt`.
const { errors } = require('./errors');
const audit = require('./auditService');
const policy = require('../policies/reminderPolicy');
const checkInService = require('./checkInService');
const zonedTime = require('./zonedTime');
const providerRegistry = require('../providers/notificationProvider');
const { getEnv } = require('../config/env');
const {
  NOTIFICATION_STATES,
  DELIVERY_OUTCOMES,
  ROLES,
  CHECKIN_RESPONSE_STATES,
  REMINDER_MAX_ATTEMPTS,
  REMINDER_BATCH_LIMIT,
} = require('../config/constants');
const Notification = require('../models/Notification');
const DeliveryAttempt = require('../models/DeliveryAttempt');
const CheckInResponse = require('../models/CheckInResponse');
const CheckInTemplateVersion = require('../models/CheckInTemplateVersion');
const CarePlanVersion = require('../models/CarePlanVersion');
const ScheduleOccurrence = require('../models/ScheduleOccurrence');
const MedicationSchedule = require('../models/MedicationSchedule');
const RecoveryTask = require('../models/RecoveryTask');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const PatientProfile = require('../models/PatientProfile');
const CaregiverGrant = require('../models/CaregiverGrant');
const User = require('../models/User');

function idOf(value) {
  return value && value._id ? String(value._id) : value === null || value === undefined ? null : String(value);
}

function publicNotification(doc, { attempts = 0 } = {}) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    kind: doc.kind,
    channel: doc.channel,
    title: doc.title,
    body: doc.body,
    state: doc.state,
    recipientRole: doc.recipientRole,
    patient: idOf(doc.patient),
    episode: idOf(doc.episode),
    sourceType: doc.sourceType,
    source: idOf(doc.source),
    localDate: doc.localDate || null,
    localTime: doc.localTime || null,
    timezone: doc.timezone || null,
    attempts: doc.attempts || 0,
    maxAttempts: doc.maxAttempts || REMINDER_MAX_ATTEMPTS,
    nextAttemptAt: doc.nextAttemptAt || null,
    deliveredAt: doc.deliveredAt || null,
    deliveredVia: doc.deliveredVia || null,
    failedAt: doc.failedAt || null,
    lastError: doc.lastError || null,
    cancelledAt: doc.cancelledAt || null,
    cancelledReason: doc.cancelledReason || null,
    acknowledgedAt: doc.acknowledgedAt || null,
    // The two notes the UI shows: delivery is not acknowledgement, and a failure
    // is a delivery problem rather than a statement about the patient.
    acknowledgementNote:
      doc.state === NOTIFICATION_STATES.DELIVERED
        ? doc.acknowledgementNote || 'A delivered reminder has not been acknowledged by the recipient.'
        : null,
    failureNote:
      doc.state === NOTIFICATION_STATES.FAILED
        ? 'This reminder could not be delivered. That is a delivery problem, not a missed dose or a clinical finding.'
        : null,
    attemptCount: attempts,
    createdAt: doc.createdAt,
  };
}

function publicAttempt(doc) {
  return {
    id: idOf(doc),
    attempt: doc.attempt,
    channel: doc.channel,
    provider: doc.provider,
    outcome: doc.outcome,
    reason: doc.reason || null,
    errorCode: doc.errorCode || null,
    durationMs: doc.durationMs ?? null,
    checks: doc.checks,
    at: doc.at,
  };
}

async function assertTeamScope({ clinicId, user, roleKey, episodeId }) {
  return checkInService.resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
}

// ---- recipients --------------------------------------------------------------

// Who may be reminded about this episode, and under which authority. A linked,
// active patient account qualifies; a caregiver qualifies only while an ACTIVE,
// unexpired grant carries the scope the reminder is about.
async function recipientsFor({ episode, requiredScope }) {
  const recipients = [];
  const patient = await PatientProfile.findById(episode.patient).lean();
  if (patient && patient.linkedUserId && patient.status === 'active') {
    const user = await User.findById(patient.linkedUserId).lean();
    if (user && user.status === 'active') {
      recipients.push({
        recipientUser: patient.linkedUserId,
        recipientLabel: user.email,
        recipientRole: 'patient',
        recipientGrant: null,
        authorized: true,
      });
    }
  }

  const grants = await CaregiverGrant.find({
    clinic: episode.clinic,
    patient: episode.patient,
    status: 'active',
    caregiverUser: { $ne: null },
  }).lean();
  for (const grant of grants) {
    const usable = typeof grant.isUsable === 'function' ? grant.isUsable() : true;
    if (!usable) continue;
    if (!(grant.scopes || []).includes(requiredScope)) continue;
    const user = await User.findById(grant.caregiverUser).lean();
    if (!user || user.status !== 'active') continue;
    recipients.push({
      recipientUser: grant.caregiverUser,
      recipientLabel: user.email,
      recipientRole: 'caregiver',
      recipientGrant: grant._id,
      authorized: true,
    });
  }
  return recipients;
}

// ---- queueing ----------------------------------------------------------------

// One candidate reminder plus the identity that makes it unique.
async function queueBatch({ clinicId, user, roleKey, episodeId, kinds, ip, userAgent, now = new Date() }) {
  const scope = await assertTeamScope({ clinicId, user, roleKey, episodeId });
  const episode = scope.episode;
  if (episode.status === 'closed') {
    throw errors.conflict('This episode is closed. No new reminders are queued for it.');
  }

  const wanted = kinds && kinds.length ? kinds : ['check_in_due', 'task_due'];
  const created = [];
  const skipped = [];

  // 1. Check-ins that are due and unanswered.
  if (wanted.includes('check_in_due')) {
    const slots = await CheckInResponse.find({
      clinic: clinicId,
      episode: episode._id,
      state: CHECKIN_RESPONSE_STATES.OPEN,
      dueAt: { $lte: now },
      windowEndsAt: { $gt: now },
    })
      .sort({ dueAt: 1 })
      .limit(50)
      .lean();

    const templates = await CheckInTemplateVersion.find({
      _id: { $in: slots.map((s) => s.template) },
    }).lean();
    const templateById = new Map(templates.map((t) => [idOf(t), t]));
    const recipients = await recipientsFor({ episode, requiredScope: 'view_checkins' });

    for (const slot of slots) {
      const template = templateById.get(idOf(slot.template));
      for (const recipient of recipients) {
        const key = policy.dedupeKey({
          recipientUser: recipient.recipientUser,
          recipientRole: recipient.recipientRole,
          channel: 'in_app',
          kind: 'check_in_due',
          // The TEMPLATE VERSION is the event version: a new version is a new
          // reminder, the same version is not.
          eventVersion: slot.templateVersion,
          eventId: slot._id,
          localDate: slot.slotDate,
        });
        created.push({
          dedupeKey: key,
          doc: {
            clinic: clinicId,
            patient: episode.patient,
            episode: episode._id,
            kind: 'check_in_due',
            channel: 'in_app',
            title: template ? template.title : 'A check-in is due',
            // The reminder states the OPERATIONAL fact and links to the questions.
            // It never summarises an answer and never says what a missing one means.
            body: 'A check-in is due today. Open it to answer the clinic’s questions.',
            recipientUser: recipient.recipientUser,
            recipientLabel: recipient.recipientLabel,
            recipientRole: recipient.recipientRole,
            recipientGrant: recipient.recipientGrant,
            sourceType: 'check_in',
            source: slot._id,
            templateVersion: slot.template,
            localDate: slot.slotDate,
            localTime: zonedTime.localParts(slot.dueAt, slot.timezone).timeOnly,
            timezone: slot.timezone,
          },
        });
      }
    }
  }

  // 2. Scheduled occurrences (medication and task) that are due and still owned by
  //    a CURRENT approved plan version.
  if (wanted.includes('task_due') || wanted.includes('medication_due')) {
    const occurrences = await ScheduleOccurrence.find({
      clinic: clinicId,
      episode: episode._id,
      status: 'scheduled',
      scheduledAtUtc: { $lte: now },
    })
      .sort({ scheduledAtUtc: 1 })
      .limit(50)
      .lean();

    if (occurrences.length) {
      const planVersions = await CarePlanVersion.find({
        _id: { $in: occurrences.map((o) => o.planVersion) },
      }).lean();
      const planById = new Map(planVersions.map((p) => [idOf(p), p]));
      const schedules = await MedicationSchedule.find({
        _id: { $in: occurrences.filter((o) => o.ownerType === 'medication').map((o) => o.owner) },
      }).lean();
      const tasks = await RecoveryTask.find({
        _id: { $in: occurrences.filter((o) => o.ownerType === 'task').map((o) => o.owner) },
      }).lean();
      const ownerById = new Map(
        [...schedules, ...tasks].map((o) => [idOf(o), o])
      );
      const recipients = await recipientsFor({ episode, requiredScope: 'view_tasks' });

      for (const occurrence of occurrences) {
        const plan = planById.get(idOf(occurrence.planVersion));
        // Only a CURRENT approved version can produce a reminder. A stale plan
        // produces nothing at all rather than a reminder about withdrawn work.
        if (!plan || !plan.isCurrent || plan.state !== 'approved') {
          skipped.push({ reason: 'stale_plan', occurrence: idOf(occurrence) });
          continue;
        }
        const owner = ownerById.get(idOf(occurrence.owner));
        const kind = occurrence.ownerType === 'medication' ? 'medication_due' : 'task_due';
        if (wanted.length && !wanted.includes(kind)) continue;

        for (const recipient of recipients) {
          const key = policy.dedupeKey({
            recipientUser: recipient.recipientUser,
            recipientRole: recipient.recipientRole,
            channel: 'in_app',
            kind,
            eventVersion: plan.version,
            eventId: occurrence._id,
            localDate: occurrence.localDate,
          });
          created.push({
            dedupeKey: key,
            doc: {
              clinic: clinicId,
              patient: episode.patient,
              episode: episode._id,
              kind,
              channel: 'in_app',
              title: owner
                ? owner.type === 'medication'
                  ? owner.medicationName || 'A medicine is due'
                  : owner.title
                : 'A scheduled item is due',
              body: `Scheduled for ${occurrence.localTime} on ${occurrence.localDate}.`,
              recipientUser: recipient.recipientUser,
              recipientLabel: recipient.recipientLabel,
              recipientRole: recipient.recipientRole,
              recipientGrant: recipient.recipientGrant,
              sourceType: 'occurrence',
              source: occurrence._id,
              planVersion: occurrence.planVersion,
              localDate: occurrence.localDate,
              localTime: occurrence.localTime,
              timezone: occurrence.timezone,
            },
          });
        }
      }
    }
  }

  let queued = 0;
  let duplicates = 0;
  for (const candidate of created) {
    try {
      // The unique dedupe index is the real guard; `$setOnInsert` makes a second
      // pass a no-op even under concurrency.
      const result = await Notification.updateOne(
        { clinic: clinicId, dedupeKey: candidate.dedupeKey },
        { $setOnInsert: { ...candidate.doc, state: NOTIFICATION_STATES.QUEUED, attempts: 0, maxAttempts: getEnv().REMINDER_MAX_ATTEMPTS ?? REMINDER_MAX_ATTEMPTS, nextAttemptAt: now } },
        { upsert: true }
      );
      if (result.upsertedCount) queued += 1;
      else duplicates += 1;
    } catch (err) {
      if (err && err.code === 11000) duplicates += 1;
      else throw err;
    }
  }

  if (queued) {
    await audit.record({
      clinic: clinicId,
      actorUser: user.id,
      actorLabel: user.email,
      action: 'reminder.queued',
      targetType: 'recovery_episode',
      targetId: idOf(episode),
      outcome: 'success',
      ip,
      userAgent,
      detail: { queued, duplicates, kinds: wanted },
    });
  }

  return { queued, duplicates, candidates: created.length, skipped };
}

// ---- delivery ----------------------------------------------------------------

// A follow-up reminder is relevant while the prescribed follow-up it is about is
// still active. The lookup is guarded so this module never hard-depends on the
// follow-up surface existing.
async function followUpRelevance(sourceId) {
  let FollowUpPlan = null;
  try {
    // eslint-disable-next-line global-require
    FollowUpPlan = require('../models/FollowUpPlan');
  } catch {
    return true;
  }
  const doc = await FollowUpPlan.findById(sourceId).lean();
  return Boolean(doc) && doc.status !== 'cancelled';
}

// Resolves the four recheck inputs for one notification. Everything is re-read at
// delivery time; nothing is trusted from queueing time.
async function recheckInputs(notification, now = new Date()) {
  const episode = await RecoveryEpisode.findById(notification.episode).lean();
  const planVersion = notification.planVersion
    ? await CarePlanVersion.findById(notification.planVersion).lean()
    : null;

  let source = null;
  if (notification.sourceType === 'occurrence' && notification.source) {
    const occurrence = await ScheduleOccurrence.findById(notification.source).lean();
    source = { relevant: Boolean(occurrence) && occurrence.status === 'scheduled' };
  } else if (notification.sourceType === 'check_in' && notification.source) {
    const slot = await CheckInResponse.findById(notification.source).lean();
    source = {
      // A reminder about a check-in stops being relevant once it is answered.
      relevant: Boolean(slot) && slot.state === CHECKIN_RESPONSE_STATES.OPEN && slot.windowEndsAt > now,
    };
  } else if (notification.sourceType === 'follow_up' && notification.source) {
    source = { relevant: await followUpRelevance(notification.source) };
  } else {
    source = { relevant: true };
  }

  let authorized = false;
  const user = await User.findById(notification.recipientUser).lean();
  if (user && user.status === 'active') {
    if (notification.recipientRole === 'patient') {
      const patient = await PatientProfile.findById(notification.patient).lean();
      authorized = Boolean(patient && String(patient.linkedUserId) === String(notification.recipientUser));
    } else if (notification.recipientRole === 'caregiver') {
      const grant = await CaregiverGrant.findById(notification.recipientGrant).lean();
      authorized = Boolean(
        grant &&
          grant.status === 'active' &&
          (!grant.expiresAt || grant.expiresAt > now) &&
          String(grant.caregiverUser) === String(notification.recipientUser)
      );
    } else {
      authorized = true;
    }
  }
  if (!user) authorized = false;

  return { episode, planVersion, source, recipient: { authorized } };
}

// The bounded delivery batch. Returns what happened to each reminder, so a caller
// can see the failure instead of guessing.
async function deliverBatch({ clinicId, user, roleKey, episodeId, limit, ip, userAgent, now = new Date() }) {
  if (episodeId) await assertTeamScope({ clinicId, user, roleKey, episodeId });

  const provider = providerRegistry.activeProvider();
  const batchLimit = Math.min(limit || REMINDER_BATCH_LIMIT, REMINDER_BATCH_LIMIT);

  const filter = {
    clinic: clinicId,
    state: NOTIFICATION_STATES.QUEUED,
    $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
  };
  if (episodeId) filter.episode = episodeId;

  const due = await Notification.find(filter).sort({ nextAttemptAt: 1, createdAt: 1 }).limit(batchLimit);
  const summary = { checked: due.length, delivered: 0, skipped: 0, failed: 0, retrying: 0, attempts: [] };

  for (const notification of due) {
    const inputs = await recheckInputs(notification, now);
    const verdict = policy.recheck({
      episode: inputs.episode,
      notification: notification.toObject(),
      planVersion: inputs.planVersion,
      source: inputs.source,
      recipient: inputs.recipient,
    });

    const attemptNumber = (notification.attempts || 0) + 1;

    if (!verdict.deliverable) {
      // Refused BEFORE contacting the provider. It is recorded as a skipped
      // attempt with the checks that refused it, and the reminder is cancelled so
      // it stops being retried forever.
      await DeliveryAttempt.create({
        clinic: clinicId,
        notification: notification._id,
        episode: notification.episode,
        attempt: attemptNumber,
        channel: notification.channel,
        provider: provider.name,
        outcome: DELIVERY_OUTCOMES.SKIPPED,
        reason: verdict.problems.join(' '),
        checks: verdict.checks,
        at: now,
      });
      notification.set({
        state: NOTIFICATION_STATES.CANCELLED,
        // A refused delivery IS a try: the attempt counter advances so the
        // attempt chain stays monotonic (and a repeated refusal cannot collide
        // with the previous attempt's number).
        attempts: attemptNumber,
        cancelledAt: now,
        cancelledReason: 'A check before delivery stopped this reminder.',
        lastError: verdict.problems.join(' '),
      });
      await notification.save();
      summary.skipped += 1;
      summary.attempts.push({ id: idOf(notification), outcome: 'skipped', reason: verdict.problems.join(' ') });
      continue;
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await provider.deliver({ notification, attempt: attemptNumber });
    } catch (err) {
      result = {
        outcome: DELIVERY_OUTCOMES.FAILED,
        provider: provider.name,
        errorCode: 'PROVIDER_ERROR',
        reason: 'The reminder provider could not be reached.',
      };
    }
    const durationMs = Date.now() - startedAt;

    await DeliveryAttempt.create({
      clinic: clinicId,
      notification: notification._id,
      episode: notification.episode,
      attempt: attemptNumber,
      channel: notification.channel,
      provider: result.provider || provider.name,
      outcome: result.outcome,
      reason: result.reason || null,
      errorCode: result.errorCode || null,
      durationMs,
      checks: verdict.checks,
      renderedBody: notification.body,
      at: now,
    });
    summary.attempts.push({
      id: idOf(notification),
      outcome: result.outcome,
      attempt: attemptNumber,
      reason: result.reason || null,
    });

    if (result.outcome === DELIVERY_OUTCOMES.DELIVERED) {
      notification.set({
        state: NOTIFICATION_STATES.DELIVERED,
        attempts: attemptNumber,
        deliveredAt: now,
        deliveredVia: result.provider || provider.name,
        nextAttemptAt: null,
        lastError: null,
      });
      await notification.save();
      summary.delivered += 1;
      continue;
    }

    // A failure either schedules a bounded retry or becomes a VISIBLE failure.
    const exhausted = attemptNumber >= (notification.maxAttempts || REMINDER_MAX_ATTEMPTS);
    notification.set({
      attempts: attemptNumber,
      lastError: result.reason || 'The reminder could not be delivered.',
      lastErrorCode: result.errorCode || null,
      nextAttemptAt: exhausted ? null : policy.nextAttemptAt(attemptNumber, now),
      state: exhausted ? NOTIFICATION_STATES.FAILED : NOTIFICATION_STATES.QUEUED,
      failedAt: exhausted ? now : null,
    });
    await notification.save();
    if (exhausted) summary.failed += 1;
    else summary.retrying += 1;
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'reminder.batch',
    targetType: 'clinic',
    targetId: String(clinicId),
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      provider: provider.name,
      checked: summary.checked,
      delivered: summary.delivered,
      skipped: summary.skipped,
      failed: summary.failed,
      retrying: summary.retrying,
      episode: episodeId ? String(episodeId) : null,
    },
  });

  return summary;
}

// ---- reads -------------------------------------------------------------------

async function listForEpisode({ clinicId, user, roleKey, episodeId, page, limit }) {
  const scope = await assertTeamScope({ clinicId, user, roleKey, episodeId });
  const filter = { clinic: clinicId, episode: scope.episode._id };
  const [rows, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  const attemptCounts = await DeliveryAttempt.aggregate([
    { $match: { notification: { $in: rows.map((r) => r._id) } } },
    { $group: { _id: '$notification', count: { $sum: 1 } } },
  ]);
  const counts = new Map(attemptCounts.map((c) => [String(c._id), c.count]));
  return {
    items: rows.map((row) => publicNotification(row, { attempts: counts.get(idOf(row)) || 0 })),
    total,
    page,
    limit,
    provider: providerRegistry.providerStatus(),
  };
}

async function getNotification({ clinicId, user, roleKey, episodeId, notificationId }) {
  await assertTeamScope({ clinicId, user, roleKey, episodeId });
  const notification = await Notification.findOne({
    _id: notificationId,
    clinic: clinicId,
    episode: episodeId,
  }).lean();
  if (!notification) throw errors.notFound('Reminder not found.');
  const attempts = await DeliveryAttempt.find({ notification: notification._id })
    .sort({ attempt: 1 })
    .lean();
  return {
    notification: publicNotification(notification, { attempts: attempts.length }),
    attempts: attempts.map(publicAttempt),
  };
}

// The recipient's own in-app inbox. A person sees only reminders addressed to
// them, which is why the filter is by recipient rather than by role or clinic: a
// caregiver may hold grants in more than one clinic and every reminder they can
// see is one the care team addressed to them.
async function listMine({ clinicId, user, page, limit }) {
  const filter = { recipientUser: user.id };
  if (clinicId) filter.clinic = clinicId;
  const [rows, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  return {
    items: rows.map((row) => publicNotification(row)),
    total,
    page,
    limit,
    note: 'Reminders that failed to deliver are shown to the care team, not silently dropped.',
  };
}

async function acknowledge({ clinicId, user, notificationId, now = new Date() }) {
  const filter = {
    _id: notificationId,
    // An acknowledgement is a statement by the RECIPIENT; nobody acknowledges on
    // someone else's behalf.
    recipientUser: user.id,
  };
  if (clinicId) filter.clinic = clinicId;
  const notification = await Notification.findOne(filter);
  if (!notification) throw errors.notFound('Reminder not found.');
  if (notification.acknowledgedAt) {
    return { notification: publicNotification(notification.toObject()), alreadyAcknowledged: true };
  }
  notification.set({ acknowledgedAt: now, acknowledgedBy: user.id });
  await notification.save();
  return { notification: publicNotification(notification.toObject()), alreadyAcknowledged: false };
}

// A staff-triggered retry of a FAILED reminder. The chain stays bounded: once the
// attempt budget is spent, the only ways forward are a new event or an explicit
// acknowledgement that it could not be delivered.
async function retry({ clinicId, user, roleKey, episodeId, notificationId, ip, userAgent, now = new Date() }) {
  await assertTeamScope({ clinicId, user, roleKey, episodeId });
  const notification = await Notification.findOne({
    _id: notificationId,
    clinic: clinicId,
    episode: episodeId,
  });
  if (!notification) throw errors.notFound('Reminder not found.');
  if (notification.state !== NOTIFICATION_STATES.FAILED) {
    throw errors.conflict('Only a failed reminder can be retried.');
  }
  if (policy.attemptsExhausted(notification)) {
    throw errors.conflict(
      'This reminder has used its whole attempt budget. The failure stays visible in the dashboard instead of retrying forever.'
    );
  }
  notification.set({ state: NOTIFICATION_STATES.QUEUED, nextAttemptAt: now, failedAt: null });
  await notification.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'reminder.retry.requested',
    targetType: 'notification',
    targetId: idOf(notification),
    outcome: 'success',
    ip,
    userAgent,
    detail: { attempts: notification.attempts },
  });
  return { notification: publicNotification(notification.toObject()) };
}

module.exports = {
  queueBatch,
  deliverBatch,
  listForEpisode,
  getNotification,
  listMine,
  acknowledge,
  retry,
  recipientsFor,
  recheckInputs,
  publicNotification,
  publicAttempt,
  ROLES,
};
