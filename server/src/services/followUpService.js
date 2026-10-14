'use strict';

// Basic prescribed follow-ups (Part 8): a date, a location, a contact and an
// optional in-app reminder.
//
// What is NOT here is as important as what is: there is no test-result field, no
// report matching, no referral destination and no clinical outcome, because this
// part does not implement any of those workflows. The policy refuses both the
// stray field and the wording that would describe them, so the boundary is
// enforced rather than merely intended.
const { errors } = require('./errors');
const audit = require('./auditService');
const policy = require('../policies/followUpPolicy');
const checkInService = require('./checkInService');
const zonedTime = require('./zonedTime');
const FollowUpPlan = require('../models/FollowUpPlan');

function idOf(value) {
  return value && value._id ? String(value._id) : value === null || value === undefined ? null : String(value);
}

function publicFollowUp(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    episode: idOf(doc.episode),
    patient: idOf(doc.patient),
    date: doc.date,
    time: doc.time || null,
    timezone: doc.timezone,
    location: doc.location,
    contact: { name: doc.contactName || null, phone: doc.contactPhone || null },
    note: doc.note || null,
    reminder: {
      enabled: Boolean(doc.reminder && doc.reminder.enabled),
      localTime: (doc.reminder && doc.reminder.localTime) || null,
      daysBefore: doc.reminder ? doc.reminder.daysBefore : null,
      // The local date the reminder appears on, computed from the appointment.
      appearsOn: doc.reminder && doc.reminder.enabled
        ? policy.reminderDateOnly({
            date: doc.date,
            daysBefore: doc.reminder.daysBefore ?? 1,
          })
        : null,
    },
    status: doc.status,
    revision: doc.revision,
    createdByLabel: doc.createdByLabel || null,
    cancelledAt: doc.cancelledAt || null,
    cancelReason: doc.cancelReason || null,
    note_wording: policy.FOLLOW_UP_NOTE,
    reminderNote: policy.REMINDER_NOTE,
  };
}

function assertInput(input) {
  const problems = policy.validateFollowUpInput(input);
  if (problems.length) throw errors.badRequest(problems.join(' '));
}

async function createFollowUp({ clinicId, user, roleKey, episodeId, input, ip, userAgent }) {
  const scope = await checkInService.resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity !== 'team') {
    throw errors.forbidden('Only the assigned care team may prescribe a follow-up.');
  }
  if (scope.episode.status === 'closed') {
    throw errors.conflict('This episode is closed. New follow-ups cannot be added.');
  }
  assertInput(input);

  const created = await FollowUpPlan.create({
    clinic: clinicId,
    patient: scope.episode.patient,
    episode: scope.episode._id,
    date: input.date,
    time: input.time,
    timezone: input.timezone,
    location: input.location,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
    note: input.note,
    reminder: {
      enabled: input.reminder ? input.reminder.enabled !== false : true,
      localTime: (input.reminder && input.reminder.localTime) || '09:00',
      daysBefore: (input.reminder && input.reminder.daysBefore) ?? 1,
    },
    status: 'scheduled',
    createdBy: user.id,
    createdByLabel: user.email,
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'followup.created',
    targetType: 'follow_up',
    targetId: idOf(created),
    outcome: 'success',
    ip,
    userAgent,
    detail: { date: created.date, reminder: created.reminder.enabled, episode: String(scope.episode._id) },
  });

  return { followUp: publicFollowUp(created.toObject()) };
}

async function listForEpisode({ clinicId, user, roleKey, episodeId, page, limit }) {
  const scope = await checkInService.resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity === 'caregiver') {
    const scopes = (scope.grant && scope.grant.scopes) || [];
    if (!scopes.includes('view_tasks')) throw errors.notFound('Follow-up not found.');
  }
  const filter = { clinic: clinicId, episode: scope.episode._id };
  const [items, total] = await Promise.all([
    FollowUpPlan.find(filter).sort({ date: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    FollowUpPlan.countDocuments(filter),
  ]);
  return {
    items: items.map(publicFollowUp),
    total,
    page,
    limit,
    capacity: scope.capacity,
    note: policy.FOLLOW_UP_NOTE,
  };
}

// Rescheduling changes only the prescribed fields. The date, the place and the
// contact may move; what the follow-up IS cannot.
async function updateFollowUp({ clinicId, user, roleKey, episodeId, followUpId, input, ip, userAgent }) {
  const scope = await checkInService.resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity !== 'team') {
    throw errors.forbidden('Only the assigned care team may change a follow-up.');
  }
  const doc = await FollowUpPlan.findOne({
    _id: followUpId,
    clinic: clinicId,
    episode: scope.episode._id,
  });
  if (!doc) throw errors.notFound('Follow-up not found.');
  if (doc.status === 'cancelled') throw errors.conflict('A cancelled follow-up cannot be changed.');

  const merged = {
    date: input.date ?? doc.date,
    time: input.time ?? doc.time,
    timezone: input.timezone ?? doc.timezone,
    location: input.location ?? doc.location,
    contactName: input.contactName ?? doc.contactName,
    contactPhone: input.contactPhone ?? doc.contactPhone,
    note: input.note ?? doc.note,
    reminder: input.reminder ?? {
      enabled: doc.reminder.enabled,
      localTime: doc.reminder.localTime,
      daysBefore: doc.reminder.daysBefore,
    },
  };
  assertInput(merged);

  doc.set({ ...merged, revision: doc.revision + 1, updatedBy: user.id, updatedByLabel: user.email });
  await doc.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'followup.updated',
    targetType: 'follow_up',
    targetId: idOf(doc),
    outcome: 'success',
    ip,
    userAgent,
    detail: { fields: Object.keys(input) },
  });

  return { followUp: publicFollowUp(doc.toObject()) };
}

async function cancelFollowUp({ clinicId, user, roleKey, episodeId, followUpId, reason, ip, userAgent }) {
  const scope = await checkInService.resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity !== 'team') {
    throw errors.forbidden('Only the assigned care team may cancel a follow-up.');
  }
  const doc = await FollowUpPlan.findOne({
    _id: followUpId,
    clinic: clinicId,
    episode: scope.episode._id,
  });
  if (!doc) throw errors.notFound('Follow-up not found.');
  if (doc.status === 'cancelled') return { followUp: publicFollowUp(doc.toObject()) };

  doc.set({
    status: 'cancelled',
    cancelledAt: new Date(),
    cancelledBy: user.id,
    cancelReason: reason,
  });
  await doc.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'followup.cancelled',
    targetType: 'follow_up',
    targetId: idOf(doc),
    outcome: 'success',
    ip,
    userAgent,
  });

  return { followUp: publicFollowUp(doc.toObject()) };
}

// The patient's own list (ownership) and the caregiver's scoped list.
async function listForPatient({ clinicId, patientId, page, limit }) {
  const [items, total] = await Promise.all([
    FollowUpPlan.find({ clinic: clinicId, patient: patientId })
      .sort({ date: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    FollowUpPlan.countDocuments({ clinic: clinicId, patient: patientId }),
  ]);
  return {
    items: items.map(publicFollowUp),
    total,
    page,
    limit,
    note: policy.FOLLOW_UP_NOTE,
  };
}

async function listForCaregiver({ user, patientId, page, limit }) {
  const grant = await checkInService.caregiverGrantFor({ user, patientId });
  if (!grant || !(grant.scopes || []).includes('view_tasks')) {
    throw errors.notFound('Follow-up not found.');
  }
  return listForPatient({ clinicId: grant.clinic, patientId, page, limit });
}

// ---- the reminder source -----------------------------------------------------

// Follow-ups whose reminder should be queued now: scheduled, reminder enabled, and
// whose reminder date has arrived in the episode's own zone.
async function dueForReminder({ clinicId, episode, now = new Date() }) {
  const today = zonedTime.todayInTimezone(episode.dischargeTimezone || 'UTC', now);
  const candidates = await FollowUpPlan.find({
    clinic: clinicId,
    episode: episode._id,
    status: 'scheduled',
    'reminder.enabled': true,
    date: { $gte: today },
  })
    .sort({ date: 1 })
    .limit(20)
    .lean();

  return candidates.filter((doc) => {
    const appearsOn = policy.reminderDateOnly({
      date: doc.date,
      daysBefore: doc.reminder.daysBefore ?? 1,
    });
    // Queue on the reminder date only, so a reminder cannot fire days early.
    return appearsOn === today;
  });
}

async function findById(id) {
  return FollowUpPlan.findById(id).lean();
}

module.exports = {
  createFollowUp,
  listForEpisode,
  updateFollowUp,
  cancelFollowUp,
  listForPatient,
  listForCaregiver,
  dueForReminder,
  findById,
  publicFollowUp,
};
