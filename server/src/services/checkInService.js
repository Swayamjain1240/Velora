'use strict';

// Recovery check-ins (VEL-015). A clinic defines versioned check-in templates;
// this service MATERIALISES one due slot per template interval for an episode,
// records answers, and routes a rule's "a person should look at this" into the
// review queue.
//
// Three rules are structural here, not stylistic:
//
//   1. A missing response is never stored. `no_response` is DERIVED from a slot
//      whose window closed with no submission, so the product cannot classify
//      recovery from silence (controls #3/#4).
//   2. A clinic rule only ever asks for workflow attention. `triggeredRules`
//      carries the clinic's own label, and only a human can move `reviewState`.
//   3. Authority is re-resolved per request: assigned team, the patient owner, or
//      a caregiver whose ACTIVE grant includes the scope being exercised.
const { errors } = require('./errors');
const audit = require('./auditService');
const policy = require('../policies/checkInPolicy');
const clinicHoursPolicy = require('../policies/clinicHoursPolicy');
const zonedTime = require('./zonedTime');
const episodeService = require('./episodeService');
const carePlanService = require('./carePlanService');
const checkInTemplateService = require('./checkInTemplateService');
const {
  CHECKIN_RESPONSE_STATES,
  CHECKIN_REVIEW_STATES,
  ROLES,
} = require('../config/constants');
const CheckInResponse = require('../models/CheckInResponse');
const CheckInTemplateVersion = require('../models/CheckInTemplateVersion');
const Clinic = require('../models/Clinic');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const PatientProfile = require('../models/PatientProfile');
const CaregiverGrant = require('../models/CaregiverGrant');
const CareTeamAssignment = require('../models/CareTeamAssignment');

// A check-in becomes due at this local wall-clock time. It is an operational
// convention, not a clinical deadline, and it is stated in the UI.
const DUE_TIME = '09:00';
// A materialisation run may create at most this many slots per template.
const MAX_SLOTS_PER_TEMPLATE = 100;

const VIEWS = Object.freeze(['due', 'open', 'no_response', 'submitted', 'needs_review']);

function idOf(value) {
  return value && value._id ? String(value._id) : value === null || value === undefined ? null : String(value);
}

function dateOnlyOf(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

// ---- projections -------------------------------------------------------------

function publicResponse(doc, { view, template, questions } = {}) {
  if (!doc) return null;
  const derived = view || policy.slotView(doc);
  return {
    id: idOf(doc),
    patient: idOf(doc.patient),
    episode: idOf(doc.episode),
    template: idOf(doc.template),
    templateKey: doc.templateKey,
    templateVersion: doc.templateVersion,
    title: template ? template.title : null,
    slotKey: doc.slotKey,
    slotDate: doc.slotDate,
    dueAt: doc.dueAt,
    windowEndsAt: doc.windowEndsAt,
    timezone: doc.timezone,
    state: derived.state,
    isMissing: Boolean(derived.isMissing),
    isLate: Boolean(derived.isLate),
    note: derived.note || null,
    // Answers are the patient's own words, returned only for a submitted slot.
    answers: (doc.answers || []).map((a) => ({
      questionId: a.questionId,
      kind: a.kind,
      value: a.value ?? null,
      values: a.values ? [...a.values] : null,
    })),
    submittedAt: doc.submittedAt || null,
    submittedByRole: doc.submittedByRole || null,
    submittedByLabel: doc.submittedByLabel || null,
    reviewState: doc.reviewState,
    triggeredRules: (doc.triggeredRules || []).map((r) => ({
      id: r.id,
      label: r.label,
      questionId: r.questionId,
      operator: r.operator,
    })),
    reviewNote: doc.reviewState === CHECKIN_REVIEW_STATES.NONE ? null : doc.reviewNote || null,
    reviewedAt: doc.reviewState === CHECKIN_REVIEW_STATES.NONE ? null : doc.reviewedAt || null,
    reviewedByLabel:
      doc.reviewState === CHECKIN_REVIEW_STATES.NONE ? null : doc.reviewedByLabel || null,
    reviewOwner: idOf(doc.reviewOwner),
    // The questions are only returned where a caller may actually answer; the
    // review/queue views never need a patient's form.
    questions: questions || null,
    attentionNote: (doc.triggeredRules || []).length ? policy.RULE_ATTENTION_NOTE : null,
  };
}

function summarise(rows, now = new Date()) {
  const summary = { due: 0, no_response: 0, submitted: 0, needs_review: 0, late: 0 };
  for (const row of rows) {
    const view = policy.slotView(row, now);
    if (view.state === 'submitted') {
      summary.submitted += 1;
      if (view.isLate) summary.late += 1;
    } else if (view.isMissing) {
      summary.no_response += 1;
    } else {
      summary.due += 1;
    }
    if (row.reviewState === CHECKIN_REVIEW_STATES.NEEDS_REVIEW) summary.needs_review += 1;
  }
  return summary;
}

async function clinicGuidance(clinicId) {
  const clinic = await Clinic.findById(clinicId).lean();
  // Response hours and emergency guidance travel WITH every check-in read so the
  // surface can never display a question without saying when it is answered.
  return clinicHoursPolicy.responseHoursSummary(clinic);
}

// ---- materialisation ---------------------------------------------------------

// Pure: the due slots a template asks for on this episode, bounded by the
// clinic's own horizon. The local date is computed in the EPISODE's timezone, so
// a daylight-saving change cannot shift a check-in onto the wrong day.
function plannedSlots({ template, dischargeDate, dischargeTimezone, now = new Date() }) {
  const zone = dischargeTimezone || 'UTC';
  const start = zonedTime.addDays(dateOnlyOf(dischargeDate), template.cadence.startOffsetDays);
  const slots = [];
  for (let index = 0; index < MAX_SLOTS_PER_TEMPLATE; index += 1) {
    const elapsed = index * template.cadence.everyDays;
    if (elapsed > template.cadence.horizonDays) break;
    const slotDate = zonedTime.addDays(start, elapsed);
    // `zonedTimeToUtc` reports a nonexistent local time (a DST spring-forward
    // gap) instead of guessing, so a slot that cannot exist is skipped rather
    // than silently pinned to a different hour.
    const resolved = zonedTime.zonedTimeToUtc({ dateOnly: slotDate, time: DUE_TIME, timezone: zone });
    if (!resolved.instant) continue;
    const dueAt = resolved.instant;
    const windowEndsAt = new Date(dueAt.getTime() + template.responseWindowHours * 60 * 60 * 1000);
    slots.push({
      slotKey: `${template.key}@${slotDate}`,
      slotDate,
      dueAt,
      windowEndsAt,
    });
  }
  return { zone, slots, generatedAt: now };
}

function assertTeamScope({ resolved, roleKey }) {
  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot read or manage check-in content.');
  }
  if (resolved.access !== 'team') {
    throw errors.forbidden('Only the assigned care team may manage check-ins for this episode.');
  }
  return resolved;
}

async function materialise({ clinicId, user, roleKey, episodeId, ip, userAgent }) {
  const resolved = assertTeamScope({
    resolved: await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey }),
    roleKey,
  });
  const episode = resolved.episode;
  if (episode.status === 'closed') {
    throw errors.conflict('This episode is closed. No further check-ins are created.');
  }

  const templates = await checkInTemplateService.listActive({ clinicId });
  const now = new Date();
  let created = 0;
  const perTemplate = [];

  for (const template of templates) {
    const planned = plannedSlots({
      template,
      dischargeDate: episode.dischargeDate,
      dischargeTimezone: episode.dischargeTimezone,
      now,
    });
    if (!planned.slots.length) continue;

    // Upsert keyed on the deterministic slot identity, so a second run is a
    // no-op and a race can never create two slots for the same due date.
    const operations = planned.slots.map((slot) => ({
      updateOne: {
        filter: { episode: episode.id, slotKey: slot.slotKey },
        update: {
          $setOnInsert: {
            clinic: clinicId,
            episode: episode.id,
            patient: episode.patient,
            template: template._id,
            templateKey: template.key,
            templateVersion: template.version,
            slotKey: slot.slotKey,
            slotDate: slot.slotDate,
            dueAt: slot.dueAt,
            windowEndsAt: slot.windowEndsAt,
            timezone: planned.zone,
            state: CHECKIN_RESPONSE_STATES.OPEN,
          },
        },
        upsert: true,
      },
    }));
    const result = await CheckInResponse.bulkWrite(operations, { ordered: false });
    const inserted = result.upsertedCount || 0;
    created += inserted;
    perTemplate.push({
      key: template.key,
      version: template.version,
      planned: planned.slots.length,
      created: inserted,
    });
  }

  if (created > 0) {
    await audit.record({
      clinic: clinicId,
      actorUser: user.id,
      actorLabel: user.email,
      action: 'checkin.materialised',
      targetType: 'recovery_episode',
      targetId: idOf(episode),
      outcome: 'success',
      ip,
      userAgent,
      detail: { created, templates: perTemplate.length },
    });
  }

  return { created, templates: perTemplate };
}

// ---- scope resolution --------------------------------------------------------

// Resolves HOW the caller may touch this episode's check-ins. Assignment is
// re-derived on every request; nothing is taken from the client.
async function resolveEpisodeScope({ clinicId, user, roleKey, episodeId }) {
  const episode = await RecoveryEpisode.findOne({ _id: episodeId, clinic: clinicId }).lean();
  if (!episode) throw errors.notFound('Episode not found.');

  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot read check-in content.');
  }

  const assignment = await CareTeamAssignment.findOne({
    clinic: clinicId,
    episode: episode._id,
    memberUser: user.id,
    status: 'active',
  }).lean();
  if (assignment) return { episode, capacity: 'team', assignment, grant: null };

  const owned = await PatientProfile.findOne({
    _id: episode.patient,
    clinic: clinicId,
    linkedUserId: user.id,
  }).lean();
  if (owned) return { episode, capacity: 'patient', assignment: null, grant: null };

  const grant = await CaregiverGrant.findOne({
    clinic: clinicId,
    patient: episode.patient,
    caregiverUser: user.id,
    status: 'active',
  });
  if (grant && grant.isUsable && grant.isUsable()) {
    return { episode, capacity: 'caregiver', assignment: null, grant };
  }

  // A same-clinic STAFF caller who is not assigned to this episode gets an
  // explicit refusal (they already know the episode can exist), while a patient
  // or caregiver without ownership or a grant learns nothing at all - the same
  // split Part 7 uses for schedules.
  if ([ROLES.CARE_COORDINATOR, ROLES.CLINICAL_REVIEWER].includes(roleKey)) {
    throw errors.forbidden('Only the assigned care team may read or answer these check-ins.');
  }
  throw errors.notFound('Episode not found.');
}

function requireCaregiverScope(grant, scope) {
  if (!grant || !(grant.scopes || []).includes(scope)) {
    // A 404 keeps an unauthorized caregiver from learning that the record exists.
    throw errors.notFound('Check-in not found.');
  }
}

// ---- reads -------------------------------------------------------------------

async function listForEpisode({ clinicId, user, roleKey, episodeId, page, limit, view, now = new Date() }) {
  const scope = await resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity === 'caregiver') requireCaregiverScope(scope.grant, 'view_checkins');

  const filter = { clinic: clinicId, episode: scope.episode._id };
  if (view === 'submitted') filter.state = CHECKIN_RESPONSE_STATES.SUBMITTED;
  if (view === 'needs_review') {
    filter.state = CHECKIN_RESPONSE_STATES.SUBMITTED;
    filter.reviewState = CHECKIN_REVIEW_STATES.NEEDS_REVIEW;
  }
  if (view === 'due') {
    // "Due" means still answerable: an open slot whose window has not closed.
    filter.state = CHECKIN_RESPONSE_STATES.OPEN;
    filter.windowEndsAt = { $gt: now };
  }
  if (view === 'open' || view === 'no_response') {
    filter.state = CHECKIN_RESPONSE_STATES.OPEN;
    filter.windowEndsAt = view === 'no_response' ? { $lte: now } : { $gt: now };
  }

  const [rows, total, allRows] = await Promise.all([
    CheckInResponse.find(filter)
      .sort({ dueAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CheckInResponse.countDocuments(filter),
    CheckInResponse.find({ clinic: clinicId, episode: scope.episode._id })
      .select('state windowEndsAt reviewState isLate')
      .lean(),
  ]);

  const templates = await CheckInTemplateVersion.find({
    _id: { $in: rows.map((r) => r.template) },
  }).lean();
  const byId = new Map(templates.map((t) => [idOf(t), t]));

  return {
    items: rows.map((row) =>
      publicResponse(row, {
        template: byId.get(idOf(row.template)),
        // A patient/caregiver filling in a due slot needs the questions; the
        // team reviewing one does not, and never receives a form they cannot use.
        questions:
          scope.capacity !== 'team' && policy.slotView(row, now).state === 'open'
            ? (byId.get(idOf(row.template)) || {}).questions || null
            : null,
      })
    ),
    total,
    page,
    limit,
    summary: summarise(allRows, now),
    capacity: scope.capacity,
    guidance: await clinicGuidance(clinicId),
  };
}

// The patient's own queue (and a caregiver's scoped read of one patient): every
// slot belonging to the patient, across episodes, newest due date first. The
// patient id is resolved from ownership or a grant by the caller, never from a
// query parameter alone.
async function listForPatient({ clinicId, patientId, page, limit, view, now = new Date() }) {
  const filter = { clinic: clinicId, patient: patientId };
  if (view === 'submitted') filter.state = CHECKIN_RESPONSE_STATES.SUBMITTED;
  if (view === 'due') {
    filter.state = CHECKIN_RESPONSE_STATES.OPEN;
    filter.windowEndsAt = { $gt: now };
  }
  if (view === 'open' || view === 'no_response') {
    filter.state = CHECKIN_RESPONSE_STATES.OPEN;
    filter.windowEndsAt = view === 'no_response' ? { $lte: now } : { $gt: now };
  }

  const [rows, total, allRows] = await Promise.all([
    CheckInResponse.find(filter).sort({ dueAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CheckInResponse.countDocuments(filter),
    CheckInResponse.find({ clinic: clinicId, patient: patientId })
      .select('state windowEndsAt reviewState isLate')
      .lean(),
  ]);
  const templates = await CheckInTemplateVersion.find({
    _id: { $in: rows.map((r) => r.template) },
  }).lean();
  const byId = new Map(templates.map((t) => [idOf(t), t]));

  return {
    items: rows.map((row) => {
      const template = byId.get(idOf(row.template));
      // The form travels only with a slot that is still answerable: a slot whose
      // window has closed is a MISSING slot and carries no form at all.
      const answerable = policy.slotView(row, now).state === 'open';
      return publicResponse(row, {
        template,
        questions: answerable ? (template || {}).questions || null : null,
      });
    }),
    total,
    page,
    limit,
    summary: summarise(allRows, now),
    guidance: await clinicGuidance(clinicId),
  };
}

async function getResponse({ clinicId, user, roleKey, episodeId, responseId, now = new Date() }) {
  const scope = await resolveEpisodeScope({ clinicId, user, roleKey, episodeId });
  if (scope.capacity === 'caregiver') requireCaregiverScope(scope.grant, 'view_checkins');

  const doc = await CheckInResponse.findOne({
    _id: responseId,
    clinic: clinicId,
    episode: scope.episode._id,
  }).lean();
  if (!doc) throw errors.notFound('Check-in not found.');
  const template = await CheckInTemplateVersion.findById(doc.template).lean();
  const derived = policy.slotView(doc, now);
  // A team member reviewing a response never receives a patient's form, and a
  // closed slot carries no form for anyone.
  const canAnswer = scope.capacity !== 'team' && derived.state === 'open';

  return {
    response: publicResponse(doc, {
      template,
      questions: canAnswer ? template.questions : null,
      view: derived,
    }),
    capacity: scope.capacity,
    guidance: await clinicGuidance(clinicId),
  };
}

// ---- submission --------------------------------------------------------------

function templateFor(doc) {
  return CheckInTemplateVersion.findById(doc.template).lean();
}

// The single submission path, shared by the patient surface, the caregiver
// surface and assigned staff. `capacity` was resolved by the caller's route.
async function submit({ clinicId, user, roleKey, responseId, answers, ip, userAgent, now = new Date() }) {
  const doc = await CheckInResponse.findOne({ _id: responseId, clinic: clinicId });
  if (!doc) throw errors.notFound('Check-in not found.');

  const scope = await resolveEpisodeScope({
    clinicId,
    user,
    roleKey,
    episodeId: doc.episode,
  });

  // An ANSWER is authorized by capacity: the patient answers their own check-in,
  // a caregiver needs the logging scope, and assigned staff may record what the
  // patient told them.
  if (scope.capacity === 'caregiver') requireCaregiverScope(scope.grant, 'log_checkins');
  if (scope.episode.status === 'closed') {
    throw errors.conflict('This episode is closed, so this check-in can no longer be answered.');
  }
  if (doc.state === CHECKIN_RESPONSE_STATES.SUBMITTED) {
    // Duplicate submission: the recorded answers are the patient's, so a second
    // set is refused instead of overwriting them.
    throw errors.conflict('This check-in has already been answered. Ask your care team if something needs correcting.');
  }

  const template = await templateFor(doc);
  if (!template) throw errors.conflict('The check-in questions for this slot are unavailable.');

  // Re-validated against the FROZEN version that asked the questions, so a
  // template edited afterwards cannot widen or narrow what is accepted here.
  const problems = policy.validateAnswers(template, answers || []);
  if (problems.length) throw errors.badRequest(problems.join(' '));

  const stored = policy.normaliseAnswers(template, answers || []);
  const submittedAt = now;
  const triggeredRules = policy.evaluateRules(template, { answers: stored });

  const claimed = await CheckInResponse.findOneAndUpdate(
    { _id: doc._id, state: CHECKIN_RESPONSE_STATES.OPEN, clinic: clinicId },
    {
      $set: {
        state: CHECKIN_RESPONSE_STATES.SUBMITTED,
        answers: stored,
        submittedAt,
        submittedBy: user.id,
        submittedByLabel: user.email,
        submittedByRole: scope.capacity,
        submittedByGrant: scope.grant ? scope.grant._id : null,
        isLate: policy.isLateSubmission(submittedAt, doc.windowEndsAt),
        triggeredRules,
        reviewState: triggeredRules.length
          ? CHECKIN_REVIEW_STATES.NEEDS_REVIEW
          : CHECKIN_REVIEW_STATES.NONE,
      },
    },
    { new: true }
  );
  if (!claimed) {
    // Lost a race with another submission for the same slot.
    throw errors.conflict('This check-in has already been answered.');
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'checkin.submitted',
    targetType: 'check_in_response',
    targetId: idOf(claimed),
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      capacity: scope.capacity,
      templateKey: claimed.templateKey,
      templateVersion: claimed.templateVersion,
      slotKey: claimed.slotKey,
      late: claimed.isLate,
      rules: triggeredRules.map((r) => r.id),
    },
  });

  return {
    response: publicResponse(claimed.toObject(), {
      template,
      view: policy.slotView(claimed.toObject(), now),
    }),
    // A rule asked for attention: say so in the response so the patient is told
    // a person will look, without any interpretation of the answers.
    attention: triggeredRules.length ? { note: policy.RULE_ATTENTION_NOTE, rules: triggeredRules.map((r) => r.id) } : null,
    guidance: await clinicGuidance(clinicId),
  };
}

// ---- clinical review ---------------------------------------------------------

// Only the episode's ASSIGNED, clinic-verified clinical reviewer may close a
// review, and only for a response a clinic rule actually flagged.
async function review({ clinicId, user, roleKey, episodeId, responseId, note, ip, userAgent, now = new Date() }) {
  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot review check-in responses.');
  }
  await carePlanService.assertReviewerAuthority({ clinicId, user, episodeId, roleKey });

  const doc = await CheckInResponse.findOne({
    _id: responseId,
    clinic: clinicId,
    episode: episodeId,
  });
  if (!doc) throw errors.notFound('Check-in not found.');
  if (doc.state !== CHECKIN_RESPONSE_STATES.SUBMITTED) {
    throw errors.conflict('There is nothing to review until the check-in is answered.');
  }
  if (!(doc.triggeredRules || []).length) {
    throw errors.conflict('This response did not ask for a review.');
  }
  if (doc.reviewState === CHECKIN_REVIEW_STATES.REVIEWED) {
    throw errors.conflict('This response has already been reviewed.');
  }

  const reviewed = await CheckInResponse.findOneAndUpdate(
    { _id: doc._id, reviewState: CHECKIN_REVIEW_STATES.NEEDS_REVIEW },
    {
      $set: {
        reviewState: CHECKIN_REVIEW_STATES.REVIEWED,
        reviewedBy: user.id,
        reviewedByLabel: user.email,
        reviewedAt: now,
        reviewNote: note,
        reviewOwner: user.id,
      },
    },
    { new: true }
  );
  if (!reviewed) throw errors.conflict('This response was reviewed by someone else.');

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'checkin.reviewed',
    targetType: 'check_in_response',
    targetId: idOf(reviewed),
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      templateKey: reviewed.templateKey,
      rules: (reviewed.triggeredRules || []).map((r) => r.id),
      hasNote: Boolean(note),
    },
  });

  const template = await CheckInTemplateVersion.findById(reviewed.template).lean();
  return {
    response: publicResponse(reviewed.toObject(), {
      template,
      view: policy.slotView(reviewed.toObject(), now),
    }),
  };
}

// ---- patient and caregiver surfaces ------------------------------------------

// The caregiver surface has no clinic context loaded (a caregiver holds no
// clinic-wide permission), so the clinic is derived from their own ACTIVE grant
// on the slot's patient. A missing or out-of-scope grant is a 404: the caregiver
// learns nothing about whether the record exists.
async function caregiverScope({ user, patientId, requiredScope }) {
  const grant = await CaregiverGrant.findOne({
    patient: patientId,
    caregiverUser: user.id,
    status: 'active',
  });
  if (!grant) throw errors.notFound('Check-in not found.');
  if (!grant.isUsable || !grant.isUsable()) throw errors.notFound('Check-in not found.');
  if (!(grant.scopes || []).includes(requiredScope)) {
    throw errors.notFound('Check-in not found.');
  }
  return grant;
}

async function listForCaregiver({ user, patientId, page, limit, view, now = new Date() }) {
  const grant = await caregiverScope({ user, patientId, requiredScope: 'view_checkins' });
  return listForPatient({ clinicId: grant.clinic, patientId, page, limit, view, now });
}

async function submitAsCaregiver({ user, responseId, answers, ip, userAgent, now = new Date() }) {
  const doc = await CheckInResponse.findById(responseId).lean();
  if (!doc) throw errors.notFound('Check-in not found.');
  const grant = await caregiverScope({ user, patientId: doc.patient, requiredScope: 'log_checkins' });
  return submit({
    clinicId: grant.clinic,
    user,
    roleKey: ROLES.CAREGIVER,
    responseId,
    answers,
    ip,
    userAgent,
    now,
  });
}

module.exports = {
  materialise,
  listForEpisode,
  listForPatient,
  listForCaregiver,
  submitAsCaregiver,
  getResponse,
  submit,
  review,
  plannedSlots,
  publicResponse,
  resolveEpisodeScope,
  clinicGuidance,
  DUE_TIME,
  VIEWS,
  dateOnlyOf,
  idOf,
};
