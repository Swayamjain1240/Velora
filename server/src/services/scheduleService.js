'use strict';

// Medication schedules and recovery tasks (Part 7, VEL-012/VEL-013).
//
// Only an item from the episode's CURRENT APPROVED, clinician-confirmed plan
// version can produce a schedule. Preparation is an explicit, authorized,
// attributed action - an approval alone still activates nothing, and a schedule
// becomes patient-visible only through a second explicit activation step (a
// verified clinical reviewer for medication).
//
// Reconciliation rule when the approved plan changes: schedules prepared from a
// superseded version are SUPERSEDED, their FUTURE occurrences are superseded,
// newly approved items produce new schedules/occurrences, and every occurrence
// and log that already happened is left exactly as it is.
const { errors } = require('./errors');
const audit = require('./auditService');
const episodeService = require('./episodeService');
const carePlanService = require('./carePlanService');
const { withTransaction } = require('./txService');
const policy = require('../policies/schedulePolicy');
const zonedTime = require('./zonedTime');
const { ROLES } = require('../config/constants');
const { getEnv } = require('../config/env');
const MedicationSchedule = require('../models/MedicationSchedule');
const RecoveryTask = require('../models/RecoveryTask');
const ScheduleOccurrence = require('../models/ScheduleOccurrence');
const CarePlanVersion = require('../models/CarePlanVersion');
const CarePlanItem = require('../models/CarePlanItem');
const CareTeamAssignment = require('../models/CareTeamAssignment');

const {
  SCHEDULE_TYPE,
  SCHEDULE_STATUS,
  ACTIVATION,
  OCCURRENCE_STATUS,
  OCCURRENCE_ORIGIN,
} = policy;

const OWNER_MODEL = Object.freeze({
  [SCHEDULE_TYPE.MEDICATION]: MedicationSchedule,
  [SCHEDULE_TYPE.TASK]: RecoveryTask,
});

const MAX_HORIZON_DAYS = 60;
const MAX_PAST_START_DAYS = 90;
const MAX_FUTURE_START_DAYS = 30;

function idOf(value) {
  return value && value._id ? String(value._id) : String(value);
}

function dateOnlyOf(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

function startDateValue(dateOnly) {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}

function publicSchedule(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    type: doc.type,
    kind: 'medication_schedule',
    planVersion: idOf(doc.planVersion),
    item: idOf(doc.item),
    medicationName: doc.medicationName || null,
    dose: doc.dose || null,
    route: doc.route || null,
    frequency: doc.frequency || null,
    timing: doc.timing || null,
    condition: doc.condition || null,
    duration: doc.duration || null,
    originalWording: doc.originalWording,
    scheduleKind: doc.scheduleKind,
    conditional: Boolean(doc.conditional),
    conditionalReason: doc.conditionalReason || null,
    timesOfDay: [...(doc.timesOfDay || [])],
    timingDetail: doc.timingDetail || null,
    timezone: doc.timezone,
    startDate: dateOnlyOf(doc.startDate),
    endDate: dateOnlyOf(doc.endDate),
    horizonDays: doc.horizonDays || policy.DEFAULT_HORIZON_DAYS,
    status: doc.status,
    needsDetailsReason: doc.needsDetailsReason || null,
    activationRequired: doc.activationRequired,
    revision: doc.revision,
    generatedCount: doc.generatedCount || 0,
    generatedThrough: doc.generatedThrough || null,
    preparedAt: doc.preparedAt,
    preparedByLabel: doc.preparedByLabel || null,
    activatedAt: doc.activatedAt || null,
    activatedByLabel: doc.activatedByLabel || null,
    endedAt: doc.endedAt || null,
    endedReason: doc.endedReason || null,
    supersededAt: doc.supersededAt || null,
    patientActionable: doc.status === SCHEDULE_STATUS.ACTIVE,
  };
}

function publicTask(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    type: doc.type,
    kind: 'recovery_task',
    itemKind: doc.itemKind,
    planVersion: idOf(doc.planVersion),
    item: idOf(doc.item),
    title: doc.title,
    frequency: doc.frequency || null,
    timing: doc.timing || null,
    condition: doc.condition || null,
    duration: doc.duration || null,
    originalWording: doc.originalWording,
    scheduleKind: doc.scheduleKind,
    conditional: Boolean(doc.conditional),
    conditionalReason: doc.conditionalReason || null,
    timesOfDay: [...(doc.timesOfDay || [])],
    timingDetail: doc.timingDetail || null,
    timezone: doc.timezone,
    startDate: dateOnlyOf(doc.startDate),
    endDate: dateOnlyOf(doc.endDate),
    horizonDays: doc.horizonDays || policy.DEFAULT_HORIZON_DAYS,
    status: doc.status,
    needsDetailsReason: doc.needsDetailsReason || null,
    activationRequired: doc.activationRequired,
    revision: doc.revision,
    generatedCount: doc.generatedCount || 0,
    generatedThrough: doc.generatedThrough || null,
    preparedAt: doc.preparedAt,
    preparedByLabel: doc.preparedByLabel || null,
    activatedAt: doc.activatedAt || null,
    activatedByLabel: doc.activatedByLabel || null,
    endedAt: doc.endedAt || null,
    endedReason: doc.endedReason || null,
    supersededAt: doc.supersededAt || null,
    patientActionable: doc.status === SCHEDULE_STATUS.ACTIVE,
  };
}

function publicOwner(doc) {
  if (!doc) return null;
  return doc.type === SCHEDULE_TYPE.MEDICATION ? publicSchedule(doc) : publicTask(doc);
}

function publicOccurrence(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    ownerType: doc.ownerType,
    owner: idOf(doc.owner),
    planVersion: idOf(doc.planVersion),
    origin: doc.origin,
    scheduledAtUtc: doc.scheduledAtUtc,
    localDate: doc.localDate,
    localTime: doc.localTime,
    timezone: doc.timezone,
    offset: doc.offset || null,
    status: doc.status,
  };
}

// ---- authority --------------------------------------------------------------

// Preparation authority: an ACTIVE care-team member who is the episode's
// assigned care coordinator. An administrator, a patient owner, a non-member and
// a closed episode are all refused, and the refusal is explicit rather than a
// silent 404, because the caller already passed authentication.
async function assertPreparerAuthority({ clinicId, user, episodeId, roleKey }) {
  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot prepare clinical schedules.');
  }
  const resolved = await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  if (resolved.access !== 'team') {
    throw errors.forbidden('Only assigned care-team staff may prepare schedules.');
  }
  if (resolved.episode.status === 'closed') {
    throw errors.conflict('This episode is closed. New schedules cannot be prepared.');
  }
  const assignment = await CareTeamAssignment.findOne({
    clinic: clinicId,
    episode: resolved.episode.id,
    memberUser: user.id,
    responsibility: 'care_coordinator',
    status: 'active',
  });
  if (!assignment) {
    throw errors.forbidden('You are not the assigned care coordinator for this episode.');
  }
  return { episode: resolved.episode, assignment };
}

// Activation authority. A MEDICATION schedule needs the assigned, verified
// clinical reviewer (the same authority that approved the plan); a task is
// operational and can be activated by the assigned coordinator.
async function assertActivationAuthority({ clinicId, user, episodeId, roleKey, activationRequired }) {
  if (activationRequired === ACTIVATION.CLINICAL_REVIEWER) {
    await carePlanService.assertReviewerAuthority({ clinicId, user, episodeId, roleKey });
    return { authority: 'clinical_reviewer' };
  }
  await assertPreparerAuthority({ clinicId, user, episodeId, roleKey });
  return { authority: 'coordinator' };
}

// Read authority for the staff workspace.
async function assertTeamRead({ clinicId, user, episodeId, roleKey }) {
  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot read clinical schedules.');
  }
  const resolved = await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  if (resolved.access !== 'team') {
    throw errors.forbidden('Only the assigned care team can read schedules.');
  }
  return resolved;
}

// ---- preparation ------------------------------------------------------------

function resolveTimezone({ requested, episode }) {
  const timezone = requested || episode.dischargeTimezone || getEnv().SCHEDULE_FALLBACK_TIMEZONE;
  if (!zonedTime.isValidTimezone(timezone)) {
    throw errors.badRequest('An explicit IANA scheduling timezone is required.');
  }
  return timezone;
}

function resolveStartDate({ requested, timezone }) {
  const today = zonedTime.todayInTimezone(timezone);
  const startDate = requested || today;
  if (!zonedTime.isValidDateOnly(startDate)) {
    throw errors.badRequest('Start date must be a real calendar date (YYYY-MM-DD).');
  }
  const offset = zonedTime.daysBetween(today, startDate);
  if (offset < -MAX_PAST_START_DAYS || offset > MAX_FUTURE_START_DAYS) {
    throw errors.badRequest(`Start date must be within ${MAX_PAST_START_DAYS} days before or ${MAX_FUTURE_START_DAYS} days after today.`);
  }
  return startDate;
}

function resolveHorizonDays(requested) {
  if (requested === undefined || requested === null) return policy.DEFAULT_HORIZON_DAYS;
  const value = Number(requested);
  if (!Number.isInteger(value) || value < 1 || value > MAX_HORIZON_DAYS) {
    throw errors.badRequest(`Horizon must be a whole number of days between 1 and ${MAX_HORIZON_DAYS}.`);
  }
  return value;
}

function ownerFieldsForItem({
  item,
  plan,
  versionId,
  clinicId,
  episode,
  timezone,
  startDate,
  preparedBy,
  preparedByLabel,
}) {
  const base = {
    clinic: clinicId,
    patient: episode.patient,
    episode: episode.id,
    planVersion: versionId,
    item: item.id,
    scheduleKind: plan.conditional ? OCCURRENCE_ORIGIN.AS_NEEDED : 'fixed',
    conditional: plan.conditional,
    conditionalReason: plan.conditionalReason || undefined,
    timesOfDay: plan.timesOfDay,
    timingDetail: plan.timingDetail,
    timezone,
    startDate: startDateValue(startDate),
    endDate: plan.endDate ? startDateValue(plan.endDate) : null,
    horizonDays: plan.horizonDays,
    status: plan.status,
    needsDetailsReason:
      plan.status === SCHEDULE_STATUS.NEEDS_DETAILS
        ? String(plan.timingDetail || 'timing_not_stated').slice(0, 200)
        : undefined,
    activationRequired: plan.activationRequired,
    preparedBy: preparedBy.id,
    preparedByLabel,
    preparedAt: new Date(),
  };

  if (plan.type === SCHEDULE_TYPE.MEDICATION) {
    return {
      ...base,
      type: SCHEDULE_TYPE.MEDICATION,
      medicationName: item.medication,
      dose: item.dose,
      route: item.route,
      frequency: item.frequency,
      timing: item.timing,
      condition: item.condition,
      duration: item.duration,
      originalWording: item.originalWording,
    };
  }
  return {
    ...base,
    type: SCHEDULE_TYPE.TASK,
    itemKind: item.kind,
    title: (item.medication || item.originalWording || 'Recovery task').slice(0, 200),
    frequency: item.frequency,
    timing: item.timing,
    condition: item.condition,
    duration: item.duration,
    originalWording: item.originalWording,
  };
}

// Stable cross-version identity for "the same instruction" so a superseded
// schedule can point at its replacement. The approved wording is copied
// verbatim across versions, which makes it the honest natural key here.
function matchKey(doc) {
  return `${doc.type}|${String(doc.originalWording || '').trim().toLowerCase()}`;
}

function scopedQuery(query, session) {
  return session ? query.session(session) : query;
}

// Idempotent insertion of occurrences: existing instants are looked up first and
// the unique (owner, instant) index is the backstop, so a repeated generation is
// a no-op instead of a duplicate dose row.
async function insertOccurrences({ owner, ownerType, plans, session }) {
  if (!plans.length) return 0;
  const existing = await scopedQuery(
    ScheduleOccurrence.find({
      owner: owner._id,
      scheduledAtUtc: { $in: plans.map((plan) => plan.scheduledAtUtc) },
    }).select('scheduledAtUtc'),
    session
  ).lean();
  const known = new Set(existing.map((row) => new Date(row.scheduledAtUtc).getTime()));

  const docs = plans
    .filter((plan) => !known.has(plan.scheduledAtUtc.getTime()))
    .map((plan) => ({
      clinic: owner.clinic,
      patient: owner.patient,
      episode: owner.episode,
      planVersion: owner.planVersion,
      item: owner.item,
      ownerType,
      owner: owner._id,
      origin: OCCURRENCE_ORIGIN.SCHEDULED,
      scheduledAtUtc: plan.scheduledAtUtc,
      localDate: plan.localDate,
      localTime: plan.localTime,
      timezone: owner.timezone,
      offset: plan.offset,
      status: OCCURRENCE_STATUS.SCHEDULED,
    }));
  if (!docs.length) return 0;
  try {
    const rows = await ScheduleOccurrence.insertMany(docs, { ordered: false, session });
    return rows.length;
  } catch (err) {
    // A concurrent duplicate is the expected outcome of a retry; anything else
    // is a real failure and must not be swallowed.
    const duplicate = err && err.code === 11000;
    const duplicateBulk =
      err && Array.isArray(err.writeErrors) && err.writeErrors.every((e) => e.code === 11000);
    if (duplicate || duplicateBulk) return 0;
    throw err;
  }
}

async function generateForOwner({ owner, ownerType, session }) {
  if (owner.scheduleKind !== 'fixed' || !owner.timesOfDay.length) {
    return { created: 0, skipped: [], truncated: false };
  }
  const startDate = dateOnlyOf(owner.startDate);
  const horizonDays = owner.horizonDays || policy.DEFAULT_HORIZON_DAYS;
  const horizonEnd = zonedTime.addDays(startDate, horizonDays - 1);
  const endDate = owner.endDate ? dateOnlyOf(owner.endDate) : horizonEnd;
  const throughDate = endDate < horizonEnd ? endDate : horizonEnd;

  const generated = policy.generateOccurrences({
    timesOfDay: owner.timesOfDay,
    timezone: owner.timezone,
    fromDate: startDate,
    throughDate,
  });
  const created = await insertOccurrences({ owner, ownerType, plans: generated.items, session });
  const total = await scopedQuery(ScheduleOccurrence.countDocuments({ owner: owner._id }), session);
  await OWNER_MODEL[ownerType].updateOne(
    { _id: owner._id },
    { $set: { generatedCount: total, generatedThrough: startDateValue(throughDate) } },
    { session }
  );
  return { created, skipped: generated.skipped, truncated: generated.truncated };
}

async function prepareFromApprovedVersion({ clinicId, user, episodeId, roleKey, data = {}, ip, userAgent }) {
  const { episode } = await assertPreparerAuthority({ clinicId, user, episodeId, roleKey });

  // Only the CURRENT APPROVED version qualifies. A draft, an in-review version,
  // a needs-clarification version or a superseded version produces nothing.
  const plan = await CarePlanVersion.findOne({
    _id: episode.approvedPlanVersion,
    clinic: clinicId,
    episode: episodeId,
    state: 'approved',
    isCurrent: true,
  });
  if (!plan) {
    throw errors.conflict('An approved, current plan version is required before schedules can be prepared.');
  }

  const timezone = resolveTimezone({ requested: data.timezone, episode });
  const startDate = resolveStartDate({ requested: data.startDate, timezone });
  const horizonDays = resolveHorizonDays(data.horizonDays);

  const items = await CarePlanItem.find({ clinic: clinicId, version: plan._id }).sort({ order: 1 });
  const schedulable = items.filter((item) => policy.isSchedulable(item));
  const notSchedulable = items.filter((item) => !policy.isSchedulable(item));

  const summary = {
    planVersion: idOf(plan),
    versionNumber: plan.version,
    timezone,
    startDate,
    horizonDays,
    created: [],
    updated: [],
    needsDetails: [],
    superseded: [],
    occurrencesCreated: 0,
    occurrencesSuperseded: 0,
    dstSkipped: [],
    notSchedulable: notSchedulable.map((item) => ({ item: idOf(item), kind: item.kind })),
    unconfirmedItems: [],
  };

  const now = new Date();

  await withTransaction(async (session) => {
    // 1. Supersede every schedule/task of this episode that came from a DIFFERENT
    //    (older) approved version. Future occurrences end; past ones are kept.
    for (const ownerType of Object.keys(OWNER_MODEL)) {
      const Model = OWNER_MODEL[ownerType];
      const stale = await Model.find({
        clinic: clinicId,
        episode: episodeId,
        planVersion: { $ne: plan._id },
        status: { $in: [SCHEDULE_STATUS.NEEDS_DETAILS, SCHEDULE_STATUS.PENDING_ACTIVATION, SCHEDULE_STATUS.ACTIVE] },
      }).session(session);
      for (const doc of stale) {
        // eslint-disable-next-line no-await-in-loop
        const updated = await Model.findOneAndUpdate(
          { _id: doc._id, status: doc.status },
          { $set: { status: SCHEDULE_STATUS.SUPERSEDED, supersededAt: now } },
          { new: true, session }
        );
        if (updated) summary.superseded.push(publicOwner(updated));
      }
      // eslint-disable-next-line no-await-in-loop
      const future = await ScheduleOccurrence.updateMany(
        { owner: { $in: stale.map((doc) => doc._id) }, status: OCCURRENCE_STATUS.SCHEDULED, scheduledAtUtc: { $gt: now } },
        { $set: { status: OCCURRENCE_STATUS.SUPERSEDED, supersededByVersion: plan._id, endedAt: now } },
        { session }
      );
      summary.occurrencesSuperseded += future.modifiedCount || 0;
    }

    // 2. Create or refresh one owner per approved, clinically confirmed item.
    for (const item of schedulable) {
      if (item.clinicalReviewState !== 'accepted') {
        summary.unconfirmedItems.push({ item: idOf(item), order: item.order });
        continue;
      }
      const planned = policy.planForItem(item, { startDate, timezone, horizonDays });
      const fields = ownerFieldsForItem({
        item,
        plan: planned,
        versionId: plan._id,
        clinicId,
        episode,
        timezone,
        startDate,
        preparedBy: user,
        preparedByLabel: user.email,
      });
      // eslint-disable-next-line no-await-in-loop
      const existing = await OWNER_MODEL[planned.type]
        .findOne({ planVersion: plan._id, item: item._id })
        .session(session);

      let owner;
      if (existing) {
        // A retry: refresh only the derived fields, never the clinical copy.
        // eslint-disable-next-line no-await-in-loop
        owner = await OWNER_MODEL[planned.type].findOneAndUpdate(
          { _id: existing._id },
          {
            $set: {
              timesOfDay: fields.timesOfDay,
              timingDetail: fields.timingDetail,
              status: existing.status === SCHEDULE_STATUS.NEEDS_DETAILS ? fields.status : existing.status,
              needsDetailsReason: fields.needsDetailsReason,
              endDate: fields.endDate,
              timezone: fields.timezone,
              scheduleKind: fields.scheduleKind,
              conditional: fields.conditional,
              conditionalReason: fields.conditionalReason,
            },
            $inc: { revision: 1 },
          },
          { new: true, session }
        );
        summary.updated.push(publicOwner(owner));
      } else {
        // eslint-disable-next-line no-await-in-loop
        owner = await OWNER_MODEL[planned.type].create([fields], { session }).then((rows) => rows[0]);
        summary.created.push(publicOwner(owner));
      }

      if (owner.status === SCHEDULE_STATUS.NEEDS_DETAILS) {
        summary.needsDetails.push({ id: idOf(owner), reason: owner.needsDetailsReason });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const generated = await generateForOwner({
        owner,
        ownerType: planned.type,
        session,
      });
      summary.occurrencesCreated += generated.created;
      summary.dstSkipped.push(...generated.skipped);
    }

    // 3. Link a superseded owner to its verbatim replacement, when one exists.
    for (const ownerType of Object.keys(OWNER_MODEL)) {
      const Model = OWNER_MODEL[ownerType];
      // eslint-disable-next-line no-await-in-loop
      const fresh = await Model.find({ clinic: clinicId, episode: episodeId, planVersion: plan._id }).session(session);
      const byKey = new Map(fresh.map((doc) => [matchKey(doc), doc._id]));
      // eslint-disable-next-line no-await-in-loop
      const stale = await Model.find({
        clinic: clinicId,
        episode: episodeId,
        status: SCHEDULE_STATUS.SUPERSEDED,
        supersededBy: null,
      }).session(session);
      for (const doc of stale) {
        const replacement = byKey.get(matchKey(doc));
        if (!replacement) continue;
        // eslint-disable-next-line no-await-in-loop
        await Model.updateOne({ _id: doc._id }, { $set: { supersededBy: replacement } }, { session });
      }
    }
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'schedule.prepared',
    targetType: 'recovery_episode',
    targetId: episodeId,
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      planVersion: idOf(plan),
      timezone,
      created: summary.created.length,
      updated: summary.updated.length,
      needsDetails: summary.needsDetails.length,
      superseded: summary.superseded.length,
      occurrencesCreated: summary.occurrencesCreated,
    },
  });

  return summary;
}

// ---- reads ------------------------------------------------------------------

async function listSchedules({ clinicId, user, episodeId, roleKey, page, limit }) {
  await assertTeamRead({ clinicId, user, episodeId, roleKey });
  const skip = (page - 1) * limit;
  const filter = { clinic: clinicId, episode: episodeId };
  const [medications, tasks, medicationTotal, taskTotal] = await Promise.all([
    MedicationSchedule.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    RecoveryTask.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    MedicationSchedule.countDocuments(filter),
    RecoveryTask.countDocuments(filter),
  ]);
  return {
    items: [...medications.map(publicSchedule), ...tasks.map(publicTask)],
    medications: medications.map(publicSchedule),
    tasks: tasks.map(publicTask),
    total: medicationTotal + taskTotal,
    medicationTotal,
    taskTotal,
    page,
    limit,
  };
}

async function loadOwner({ clinicId, episodeId, scheduleId }) {
  const medication = await MedicationSchedule.findOne({ _id: scheduleId, clinic: clinicId, episode: episodeId });
  if (medication) return { owner: medication, ownerType: SCHEDULE_TYPE.MEDICATION, Model: MedicationSchedule };
  const task = await RecoveryTask.findOne({ _id: scheduleId, clinic: clinicId, episode: episodeId });
  if (task) return { owner: task, ownerType: SCHEDULE_TYPE.TASK, Model: RecoveryTask };
  throw errors.notFound('Schedule not found.');
}

async function getSchedule({ clinicId, user, episodeId, roleKey, scheduleId }) {
  await assertTeamRead({ clinicId, user, episodeId, roleKey });
  const { owner } = await loadOwner({ clinicId, episodeId, scheduleId });
  const occurrences = await ScheduleOccurrence.find({ owner: owner._id })
    .sort({ scheduledAtUtc: 1 })
    .limit(limitOr(policy.MAX_GENERATED_OCCURRENCES))
    .lean();
  return {
    schedule: publicOwner(owner),
    occurrences: occurrences.map(publicOccurrence),
    occurrenceTotal: occurrences.length,
  };
}

function limitOr(value) {
  return Number.isInteger(value) && value > 0 ? value : 100;
}

async function listOccurrences({ clinicId, user, episodeId, roleKey, scheduleId, page, limit }) {
  await assertTeamRead({ clinicId, user, episodeId, roleKey });
  const { owner } = await loadOwner({ clinicId, episodeId, scheduleId });
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    ScheduleOccurrence.find({ owner: owner._id })
      .sort({ scheduledAtUtc: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ScheduleOccurrence.countDocuments({ owner: owner._id }),
  ]);
  return { items: items.map(publicOccurrence), total, page, limit };
}

// ---- activation / ending ----------------------------------------------------

async function activateSchedule({ clinicId, user, episodeId, roleKey, scheduleId, expectedRevision, note, ip, userAgent }) {
  const { owner, ownerType, Model } = await loadOwner({ clinicId, episodeId, scheduleId });

  // Stale-plan guard: a schedule may only be activated while the version it came
  // from is STILL the episode's current approved version.
  const episode = await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  if (String(episode.episode.approvedPlanVersion || '') !== String(owner.planVersion)) {
    throw errors.conflict('This schedule belongs to a superseded plan version. Prepare the current approved version first.');
  }

  await assertActivationAuthority({
    clinicId,
    user,
    episodeId,
    roleKey,
    activationRequired: owner.activationRequired,
  });

  if (owner.status === SCHEDULE_STATUS.ACTIVE) {
    if (owner.revision === expectedRevision + 1 && idOf(owner.activatedBy) === idOf(user)) {
      return { schedule: publicOwner(owner), idempotent: true, occurrencesCreated: 0 };
    }
    throw errors.conflict('This schedule is already active.');
  }
  if (owner.status === SCHEDULE_STATUS.NEEDS_DETAILS) {
    throw errors.conflict(
      'The approved wording does not state when this happens, so it cannot be activated. Correct the plan wording and approve a new version.'
    );
  }
  if (owner.status !== SCHEDULE_STATUS.PENDING_ACTIVATION) {
    throw errors.conflict('This schedule can no longer be activated.');
  }

  const now = new Date();
  const claimed = await Model.findOneAndUpdate(
    { _id: owner._id, clinic: clinicId, status: SCHEDULE_STATUS.PENDING_ACTIVATION, revision: expectedRevision },
    {
      $set: {
        status: SCHEDULE_STATUS.ACTIVE,
        activatedBy: user.id,
        activatedByLabel: user.email,
        activatedAt: now,
        needsDetailsReason: undefined,
      },
      $inc: { revision: 1 },
    },
    { new: true }
  );
  if (!claimed) {
    throw errors.conflict('This schedule was already decided. Reload to see the current state.');
  }

  const generated = await generateForOwner({ owner: claimed, ownerType });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'schedule.activated',
    targetType: ownerType === SCHEDULE_TYPE.MEDICATION ? 'medication_schedule' : 'recovery_task',
    targetId: String(claimed._id),
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      episode: episodeId,
      planVersion: idOf(owner.planVersion),
      activationRequired: owner.activationRequired,
      authority: roleKey,
      note: note ? String(note).slice(0, 300) : undefined,
    },
  });

  return { schedule: publicOwner(claimed), idempotent: false, occurrencesCreated: generated.created };
}

async function endSchedule({ clinicId, user, episodeId, roleKey, scheduleId, reason, ip, userAgent }) {
  await assertPreparerAuthority({ clinicId, user, episodeId, roleKey });
  const { owner, Model } = await loadOwner({ clinicId, episodeId, scheduleId });
  if (owner.status === SCHEDULE_STATUS.ENDED) {
    throw errors.conflict('This schedule is already ended.');
  }
  if (owner.status === SCHEDULE_STATUS.SUPERSEDED) {
    throw errors.conflict('This schedule was superseded by a newer approved plan version.');
  }

  const now = new Date();
  const ended = await Model.findOneAndUpdate(
    { _id: owner._id, clinic: clinicId, status: owner.status },
    { $set: { status: SCHEDULE_STATUS.ENDED, endedBy: user.id, endedAt: now, endedReason: reason || undefined }, $inc: { revision: 1 } },
    { new: true }
  );
  if (!ended) throw errors.conflict('This schedule changed. Reload and try again.');

  const updated = await ScheduleOccurrence.updateMany(
    { owner: owner._id, status: OCCURRENCE_STATUS.SCHEDULED, scheduledAtUtc: { $gt: now } },
    { $set: { status: OCCURRENCE_STATUS.ENDED, endedAt: now } }
  );

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'schedule.ended',
    targetType: 'schedule',
    targetId: String(ended._id),
    outcome: 'success',
    ip,
    userAgent,
    detail: { episode: episodeId, occurrencesEnded: updated.modifiedCount || 0 },
  });

  return { schedule: publicOwner(ended), occurrencesEnded: updated.modifiedCount || 0 };
}

module.exports = {
  publicSchedule,
  publicTask,
  publicOwner,
  publicOccurrence,
  assertPreparerAuthority,
  assertTeamRead,
  prepareFromApprovedVersion,
  listSchedules,
  getSchedule,
  listOccurrences,
  activateSchedule,
  endSchedule,
  idOf,
  dateOnlyOf,
};
