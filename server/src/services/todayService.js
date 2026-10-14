'use strict';

// The Today day view (Part 7). One local calendar day, one patient, one
// episode, split into a medication panel and a task panel.
//
// Facts this view is careful about:
//   - `not_recorded` means NO ENTRY EXISTS. It is never rendered as a missed
//     dose and never produces advice, so a missing entry can never lead to a
//     double dose.
//   - a patient or caregiver entry is a self-report and is labelled as one; it
//     is never presented as clinician verification.
//   - an as-needed (PRN) item is shown as available, never as due, and never
//     generates a repeating time.
const { errors } = require('./errors');
const policy = require('../policies/schedulePolicy');
const zonedTime = require('./zonedTime');
const activityLogService = require('./activityLogService');
const MedicationSchedule = require('../models/MedicationSchedule');
const RecoveryTask = require('../models/RecoveryTask');
const ScheduleOccurrence = require('../models/ScheduleOccurrence');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const PatientProfile = require('../models/PatientProfile');
const CaregiverGrant = require('../models/CaregiverGrant');
const ClinicMembership = require('../models/ClinicMembership');
const CareTeamAssignment = require('../models/CareTeamAssignment');
const { ROLES } = require('../config/constants');

const CLINIC_ROLES = Object.freeze([ROLES.CARE_COORDINATOR, ROLES.CLINICAL_REVIEWER]);
const MAX_DAY_ROWS = 200;

function idOf(value) {
  return value && value._id ? String(value._id) : String(value);
}

const NOT_FOUND = 'Nothing to show for that record.';

// ---- scope ------------------------------------------------------------------

// The caller's relationship to the record is DERIVED here (ownership, then an
// active grant, then an active membership plus assignment). Nothing about the
// caller's clinic or role is taken from the request.
async function resolveScope({ user, query }) {
  const requestedPatient = query.patientId || null;
  const requestedEpisode = query.episodeId || null;

  // 1. The patient's own day view. Ownership of the profile - not a clinic-wide
  //    permission - is the authority, and a named patient id can never widen it.
  const own = await PatientProfile.findOne({ linkedUserId: user.id, status: 'active' }).lean();
  if (own) {
    if (requestedPatient && String(requestedPatient) !== idOf(own)) throw errors.notFound(NOT_FOUND);
    return {
      clinicId: own.clinic,
      patient: idOf(own),
      access: 'patient',
      logAllowed: true,
      caregiverScopes: [],
    };
  }

  // 2. A caregiver needs an ACTIVE, unexpired grant holding `view_tasks`; the
  //    clinic comes from the grant, so the caller cannot name another clinic.
  const caregiverGrants = await CaregiverGrant.find({
    caregiverUser: user.id,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  }).lean();
  if (caregiverGrants.length) {
    const grant = requestedPatient
      ? caregiverGrants.find((g) => idOf(g.patient) === String(requestedPatient))
      : caregiverGrants[0];
    if (!grant) throw errors.notFound(NOT_FOUND);
    if (!(grant.scopes || []).includes('view_tasks')) throw errors.notFound(NOT_FOUND);
    return {
      clinicId: grant.clinic,
      patient: idOf(grant.patient),
      access: 'caregiver',
      // Reading the day view and recording an entry are separate scopes: a grant
      // with `view_tasks` only can look, never write.
      logAllowed: (grant.scopes || []).includes('log_tasks'),
      caregiverScopes: [...(grant.scopes || [])],
      grantId: idOf(grant),
    };
  }

  // 3. Assigned staff. The clinic is derived from the patient record, and the
  //    caller must hold an ACTIVE membership there plus a current assignment on
  //    one of that patient's episodes.
  if (!requestedPatient) throw errors.badRequest('A patient is required to view a day.');
  const profile = await PatientProfile.findById(requestedPatient).lean();
  if (!profile) throw errors.notFound(NOT_FOUND);
  const membership = await ClinicMembership.findOne({
    clinic: profile.clinic,
    user: user.id,
    status: 'active',
  }).lean();
  if (!membership || !CLINIC_ROLES.includes(membership.roleKey)) throw errors.notFound(NOT_FOUND);
  const episodes = await RecoveryEpisode.find({ clinic: profile.clinic, patient: profile._id })
    .select('_id')
    .lean();
  const assignment = await CareTeamAssignment.findOne({
    clinic: profile.clinic,
    episode: { $in: episodes.map((e) => e._id) },
    memberUser: user.id,
    status: 'active',
  }).lean();
  if (!assignment) throw errors.forbidden('You are not assigned to this episode.');

  return {
    clinicId: profile.clinic,
    patient: idOf(profile),
    access: 'team',
    logAllowed: true,
    caregiverScopes: [],
  };
}

async function resolveEpisode({ clinicId, patient, requestedEpisodeId }) {
  if (requestedEpisodeId) {
    const episode = await RecoveryEpisode.findOne({
      _id: requestedEpisodeId,
      clinic: clinicId,
      patient,
    }).lean();
    if (!episode) throw errors.notFound(NOT_FOUND);
    return episode;
  }
  // With no episode named, prefer the newest OPEN episode that actually has an
  // active schedule; otherwise the newest open episode. Deterministic and
  // never a closed one, which is read-only.
  const open = await RecoveryEpisode.find({ clinic: clinicId, patient, status: { $ne: 'closed' } })
    .sort({ createdAt: -1 })
    .lean();
  if (!open.length) {
    const any = await RecoveryEpisode.findOne({ clinic: clinicId, patient }).sort({ createdAt: -1 }).lean();
    if (!any) throw errors.notFound('This patient has no recovery episode yet.');
    return any;
  }
  const activeOwners = await MedicationSchedule.find({
    clinic: clinicId,
    patient,
    status: policy.SCHEDULE_STATUS.ACTIVE,
  })
    .select('episode')
    .lean();
  const withSchedules = new Set(activeOwners.map((row) => idOf(row.episode)));
  return open.find((episode) => withSchedules.has(idOf(episode))) || open[0];
}

// ---- day view ---------------------------------------------------------------

function publicItem({ occurrence, owner: detail, ownerType, chain, ownerActive = true }) {
  const latest = chain.length ? chain[chain.length - 1] : null;
  const state = policy.todayState(latest);
  const asNeeded = detail.scheduleKind === policy.OCCURRENCE_ORIGIN.AS_NEEDED;
  const occurrenceOpen = Boolean(occurrence) && occurrence.status === policy.OCCURRENCE_STATUS.SCHEDULED;
  // An as-needed item can be recorded whenever it happens; a scheduled slot only
  // while it is still open, and never once its version was superseded.
  const actionable = Boolean(ownerActive) && (asNeeded || occurrenceOpen);
  return {
    id: occurrence ? idOf(occurrence) : null,
    owner: idOf(detail),
    ownerType,
    asNeeded,
    // A historical row belongs to a schedule that a newer approved version
    // superseded. It is shown for the record and is never actionable again.
    historical: !ownerActive,
    actionable,
    state,
    // Explicit, machine-readable honesty flags so the UI cannot word this as
    // adherence or verification.
    noEntryRecorded: state === policy.NOT_RECORDED,
    selfReport: latest ? policy.isSelfReport(latest.actorRole) : false,
    clinicianVerified: false,
    // `dueAtUtc` is only ever set for a scheduled slot. An as-needed entry has
    // no due time at all - it reports when it HAPPENED instead.
    dueAtUtc: !asNeeded && occurrence ? occurrence.scheduledAtUtc : null,
    happenedAtUtc: asNeeded && occurrence ? occurrence.scheduledAtUtc : null,
    localTime: occurrence ? occurrence.localTime : null,
    offset: occurrence && occurrence.offset ? occurrence.offset : null,
    recordedAtUtc: latest ? latest.recordedAtUtc : null,
    // `corrected` means a later entry explicitly named an earlier one, which is
    // different from two independent entries about the same slot.
    corrected: chain.some((row) => Boolean(row.correctsLog)),
    entryCount: chain.length,
    entries: chain.map(activityLogService.publicLog),
    medication: detail.type === 'medication'
      ? {
          name: detail.medicationName || null,
          dose: detail.dose || null,
          route: detail.route || null,
          frequency: detail.frequency || null,
          timing: detail.timing || null,
          condition: detail.condition || null,
        }
      : null,
    task: detail.type === 'task'
      ? {
          itemKind: detail.itemKind || null,
          title: detail.title || null,
          frequency: detail.frequency || null,
          timing: detail.timing || null,
        }
      : null,
    instruction: detail.originalWording,
    scheduleKind: detail.scheduleKind,
    planVersion: idOf(detail.planVersion),
  };
}

function emptyCounts() {
  return {
    [policy.ENTRY_STATES.TAKEN]: 0,
    [policy.ENTRY_STATES.SKIPPED]: 0,
    [policy.ENTRY_STATES.REPORTED_DONE]: 0,
    [policy.ENTRY_STATES.NEEDS_HELP]: 0,
    [policy.NOT_RECORDED]: 0,
  };
}

async function buildDay({ scope, episode, timezone, date, tab, page, limit }) {
  const clinicId = scope.clinicId;
  const patient = scope.patient;
  const base = { clinic: clinicId, patient, episode: episode._id };
  const activeFilter = { ...base, status: policy.SCHEDULE_STATUS.ACTIVE };

  const [medications, tasks] = await Promise.all([
    MedicationSchedule.find(activeFilter).lean(),
    RecoveryTask.find(activeFilter).lean(),
  ]);
  const ownersById = new Map();
  for (const doc of medications) ownersById.set(idOf(doc), { owner: doc, ownerType: 'medication' });
  for (const doc of tasks) ownersById.set(idOf(doc), { owner: doc, ownerType: 'task' });
  const ownerIds = [...ownersById.keys()];

  // Actionable slots of the current approved version, plus every recorded fact
  // of that date - including as-needed entries and slots whose owner a newer
  // approved version superseded. History is shown for the record; it is never
  // actionable again.
  const [occurrences, otherOccurrences] = await Promise.all([
    ownerIds.length
      ? ScheduleOccurrence.find({
          owner: { $in: ownerIds },
          localDate: date,
          status: policy.OCCURRENCE_STATUS.SCHEDULED,
        })
          .sort({ scheduledAtUtc: 1 })
          .limit(MAX_DAY_ROWS)
          .lean()
      : [],
    ScheduleOccurrence.find({ clinic: clinicId, patient, episode: episode._id, localDate: date })
      .sort({ scheduledAtUtc: 1 })
      .limit(MAX_DAY_ROWS)
      .lean(),
  ]);

  const scheduledIds = new Set(occurrences.map((row) => idOf(row)));
  const extras = otherOccurrences.filter((row) => !scheduledIds.has(idOf(row)));
  const allOccurrences = [...occurrences, ...extras];

  const chain = await activityLogService.chainFor(allOccurrences.map((row) => idOf(row)));

  // Owners of the extras may belong to a superseded version, so fetch any owner
  // the active set does not already hold.
  const missingOwnerIds = [
    ...new Set(
      extras.map((row) => idOf(row.owner)).filter((ownerId) => !ownersById.has(ownerId))
    ),
  ];
  if (missingOwnerIds.length) {
    const [oldMedications, oldTasks] = await Promise.all([
      MedicationSchedule.find({ _id: { $in: missingOwnerIds } }).lean(),
      RecoveryTask.find({ _id: { $in: missingOwnerIds } }).lean(),
    ]);
    for (const doc of oldMedications) ownersById.set(idOf(doc), { owner: doc, ownerType: 'medication', active: false });
    for (const doc of oldTasks) ownersById.set(idOf(doc), { owner: doc, ownerType: 'task', active: false });
  }

  const rows = [];
  let hiddenCount = 0;
  for (const occurrence of allOccurrences) {
    const entry = ownersById.get(idOf(occurrence.owner));
    if (!entry) continue;
    const ownerActive = entry.owner.status === policy.SCHEDULE_STATUS.ACTIVE;
    const occurrenceChain = chain.get(idOf(occurrence)) || [];
    const isActionableSlot =
      ownerActive && occurrence.status === policy.OCCURRENCE_STATUS.SCHEDULED;
    const isRecordedFact =
      occurrenceChain.length > 0 || occurrence.origin === policy.OCCURRENCE_ORIGIN.AS_NEEDED;
    // A superseded slot with nothing recorded is noise from an older plan.
    if (!isActionableSlot && !isRecordedFact) {
      hiddenCount += 1;
      continue;
    }
    rows.push(
      publicItem({
        occurrence,
        owner: entry.owner,
        ownerType: entry.ownerType,
        chain: occurrenceChain,
        ownerActive,
      })
    );
  }

  // As-needed owners that have nothing recorded today are still shown - labelled
  // as available, never as due - so the patient can record one when it happens.
  for (const doc of [...medications, ...tasks]) {
    if (doc.scheduleKind !== policy.OCCURRENCE_ORIGIN.AS_NEEDED) continue;
    const recordedToday = allOccurrences.some((row) => idOf(row.owner) === idOf(doc));
    if (recordedToday) continue;
    rows.push(
      publicItem({
        occurrence: null,
        owner: doc,
        ownerType: doc.type === 'medication' ? 'medication' : 'task',
        chain: [],
      })
    );
  }

  const countsByTab = { medication: emptyCounts(), task: emptyCounts() };
  for (const row of rows) {
    const bucket = countsByTab[row.ownerType];
    if (!bucket) continue;
    bucket[row.state] = (bucket[row.state] || 0) + 1;
  }

  const tabRows = rows.filter((row) => row.ownerType === tab);
  // Scheduled slots first, in clock order; as-needed entries then, newest first.
  tabRows.sort((a, b) => {
    if (a.dueAtUtc && b.dueAtUtc) return new Date(a.dueAtUtc) - new Date(b.dueAtUtc);
    if (a.dueAtUtc) return -1;
    if (b.dueAtUtc) return 1;
    return new Date(b.recordedAtUtc || 0) - new Date(a.recordedAtUtc || 0);
  });

  const total = tabRows.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const items = tabRows.slice((page - 1) * limit, page * limit);

  return {
    date,
    timezone,
    offset: zonedTime.offsetLabel(new Date(`${date}T12:00:00.000Z`), timezone),
    episode: {
      id: idOf(episode),
      reference: episode.reference,
      status: episode.status,
      readOnly: episode.status === 'closed',
      planState: episode.planState,
    },
    access: scope.access,
    logAllowed: scope.logAllowed,
    activeScheduleCount: ownersById.size,
    tab,
    page,
    limit,
    total,
    pages,
    otherTabTotal: rows.length - total,
    counts: countsByTab[tab],
    countsByTab,
    hiddenOccurrenceCount: hiddenCount,
    items,
    safety: {
      missingEntryMeans: 'no_entry_recorded',
      notRecordedIsNotAMissedDose: true,
      adviceAboutExtraDose: 'none',
      note: policy.SAFETY_NOTE,
      asNeededNote: policy.AS_NEEDED_NOTE,
      selfReportNote: policy.SELF_REPORT_NOTE,
    },
  };
}

async function getToday({ user, query }) {
  const scope = await resolveScope({ user, query });
  const episode = await resolveEpisode({
    clinicId: scope.clinicId,
    patient: scope.patient,
    requestedEpisodeId: query.episodeId || null,
  });

  // An explicit request timezone must be a real IANA zone; otherwise the
  // episode's own scheduling timezone governs the day boundary.
  let timezone = query.timezone || episode.dischargeTimezone;
  if (!zonedTime.isValidTimezone(timezone)) {
    throw errors.badRequest('A valid IANA timezone is required.');
  }
  const date = query.date || zonedTime.todayInTimezone(timezone);
  if (!zonedTime.isValidDateOnly(date)) {
    throw errors.badRequest('A valid calendar date (YYYY-MM-DD) is required.');
  }

  const day = await buildDay({
    scope,
    episode,
    timezone,
    date,
    tab: query.tab,
    page: query.page,
    limit: query.limit,
  });
  return { ...day, caregiverScopes: scope.caregiverScopes };
}

module.exports = {
  resolveScope,
  resolveEpisode,
  buildDay,
  getToday,
  publicItem,
};
