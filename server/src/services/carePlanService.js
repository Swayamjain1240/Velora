'use strict';

// Manual care plans (Part 5).
//
// Flow: an ASSIGNED care coordinator drafts items by hand and cites READY
// documents; the draft is submitted for review; an ASSIGNED, clinic-verified
// clinical reviewer either requests clarification or approves it. Approval
// happens in ONE MongoDB transaction that supersedes the previous current
// version and moves the episode's approved-plan pointer - so there is never more
// than one current approved version, and a retry is idempotent.
//
// Nothing here is automated: no AI, no inference, no defaulting. A missing,
// unclear or conflicting dose/frequency/duration stays unresolved and blocks
// approval (see policies/carePlanPolicy.js).
const { errors } = require('./errors');
const audit = require('./auditService');
const episodeService = require('./episodeService');
const { withTransaction } = require('./txService');
const policy = require('../policies/carePlanPolicy');
const { ROLES, PERMISSIONS } = require('../config/constants');
const CarePlanVersion = require('../models/CarePlanVersion');
const CarePlanItem = require('../models/CarePlanItem');
const SourceReference = require('../models/SourceReference');
const ReviewEvent = require('../models/ReviewEvent');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const EpisodeDocument = require('../models/EpisodeDocument');
const ClinicMembership = require('../models/ClinicMembership');
const MembershipRole = require('../models/MembershipRole');
const PatientProfile = require('../models/PatientProfile');
const CareTeamAssignment = require('../models/CareTeamAssignment');

const { STATES, ITEM_REVIEW_STATES } = policy;

function idOf(value) {
  return value && value._id ? String(value._id) : String(value);
}

function publicVersion(version) {
  if (!version) return null;
  return {
    id: idOf(version),
    episode: idOf(version.episode),
    version: version.version,
    state: version.state,
    revision: version.revision,
    title: version.title || null,
    summary: version.summary || null,
    isCurrent: Boolean(version.isCurrent),
    createdByLabel: version.createdByLabel || null,
    createdAt: version.createdAt,
    submittedAt: version.submittedAt || null,
    clarificationReason: version.clarificationReason || null,
    clarificationByLabel: version.clarificationByLabel || null,
    clarificationAt: version.clarificationAt || null,
    // Human-facing approval facts. The patient sees these too.
    approvedByLabel: version.approvedByLabel || null,
    approvedAt: version.approvedAt || null,
    supersededBy: version.supersededBy ? idOf(version.supersededBy) : null,
    supersededAt: version.supersededAt || null,
    editable: policy.EDITABLE_STATES.includes(version.state),
    updatedAt: version.updatedAt,
  };
}

function publicItem(item, sources = []) {
  return {
    id: idOf(item),
    version: idOf(item.version),
    order: item.order,
    kind: item.kind,
    originalWording: item.originalWording,
    medication: item.medication || null,
    dose: item.dose || null,
    route: item.route || null,
    frequency: item.frequency || null,
    timing: item.timing || null,
    duration: item.duration || null,
    condition: item.condition || null,
    homeCare: item.homeCare || null,
    dietActivity: item.dietActivity || null,
    followUp: item.followUp || null,
    warning: item.warning || null,
    // Server-computed: the reason approval is blocked.
    unresolvedFields: item.unresolvedFields || [],
    clinicalReviewState: item.clinicalReviewState,
    reviewNote: item.reviewNote || null,
    reviewedByLabel: item.reviewedByLabel || null,
    reviewedAt: item.reviewedAt || null,
    sourceCount: sources.length,
    sources: sources.map(publicSource),
    updatedAt: item.updatedAt,
  };
}

function publicSource(source) {
  return {
    id: idOf(source),
    document: idOf(source.document),
    documentFilename: source.documentFilename || null,
    documentMediaType: source.documentMediaType || null,
    page: source.page || null,
    text: source.text,
    location: source.location || null,
    createdByLabel: source.createdByLabel || null,
    createdAt: source.createdAt,
  };
}

// The patient-facing projection: the approved clinical content, the approval
// facts and the permitted source references. Deliberately WITHOUT the reviewer's
// working state (`clinicalReviewState`, `reviewNote`, `reviewedByLabel`), the
// clarification history and the internal unresolved-field diagnostics.
function publicPatientVersion(version) {
  if (!version) return null;
  return {
    id: idOf(version),
    episode: idOf(version.episode),
    version: version.version,
    state: version.state,
    title: version.title || null,
    summary: version.summary || null,
    isCurrent: Boolean(version.isCurrent),
    approvedByLabel: version.approvedByLabel || null,
    approvedAt: version.approvedAt || null,
  };
}

function publicPatientItem(item, sources = []) {
  return {
    id: idOf(item),
    order: item.order,
    kind: item.kind,
    originalWording: item.originalWording,
    medication: item.medication || null,
    dose: item.dose || null,
    route: item.route || null,
    frequency: item.frequency || null,
    timing: item.timing || null,
    duration: item.duration || null,
    condition: item.condition || null,
    homeCare: item.homeCare || null,
    dietActivity: item.dietActivity || null,
    followUp: item.followUp || null,
    warning: item.warning || null,
    sources: sources.map(publicSource),
  };
}

function publicEvent(event) {
  return {
    id: idOf(event),
    action: event.action,
    actorLabel: event.actorLabel || null,
    actorRole: event.actorRole || null,
    stateBefore: event.stateBefore || null,
    stateAfter: event.stateAfter || null,
    revisionBefore: event.revisionBefore ?? null,
    revisionAfter: event.revisionAfter ?? null,
    reason: event.reason || null,
    at: event.at,
  };
}

// ---- access -----------------------------------------------------------------

async function assertCoordinatorWrite({ clinicId, user, episodeId, roleKey }) {
  // Reuses the Part 4 write rule: an ACTIVE care-team assignment on a DRAFT
  // episode. A patient owner, an administrator, a non-member or a closed episode
  // can never create or edit a plan.
  const resolved = await episodeService.assertEpisodeTeamWrite({ clinicId, user, episodeId, roleKey });
  const coordinator = await requireAssignment({
    clinicId,
    user,
    episodeId,
    responsibility: 'care_coordinator',
  });
  return { episode: resolved.episode, assignment: coordinator };
}

async function requireAssignment({ clinicId, user, episodeId, responsibility }) {
  const assignment = await CareTeamAssignment.findOne({
    clinic: clinicId,
    episode: episodeId,
    memberUser: user.id,
    responsibility,
    status: 'active',
  });
  if (!assignment) {
    throw errors.forbidden(
      responsibility === 'clinical_reviewer'
        ? 'You are not the assigned clinical reviewer for this episode.'
        : 'You are not the assigned care coordinator for this episode.'
    );
  }
  return assignment;
}

// Approval authority is re-derived from the database on every decision: role,
// verified eligibility, the permission catalog and a CURRENT active assignment.
// An admin, a revoked reviewer or a reviewer whose eligibility lapsed can never
// approve.
async function assertReviewerAuthority({ clinicId, user, episodeId, roleKey }) {
  if (roleKey === ROLES.ADMIN) {
    throw errors.forbidden('Administrators cannot read or approve clinical content.');
  }
  const membership = await ClinicMembership.findOne({
    clinic: clinicId,
    user: user.id,
    status: 'active',
  }).lean();
  if (!membership || membership.roleKey !== ROLES.CLINICAL_REVIEWER) {
    throw errors.forbidden('Verified clinical reviewer eligibility required.');
  }
  const eligible =
    membership.reviewerEligibility && membership.reviewerEligibility.status === 'verified';
  if (!eligible) {
    throw errors.forbidden('Verified clinical reviewer eligibility required.');
  }
  const role = await MembershipRole.findOne({ clinic: clinicId, key: ROLES.CLINICAL_REVIEWER }).lean();
  const canReview = Boolean(role && role.permissions.includes(PERMISSIONS.PLAN_REVIEW));
  if (!canReview) throw errors.forbidden('Verified clinical reviewer eligibility required.');

  await requireAssignment({
    clinicId,
    user,
    episodeId,
    responsibility: 'clinical_reviewer',
  });
  return membership;
}

// Reads: an ACTIVE team member sees every version they are entitled to during
// the workflow. An administrator is explicitly denied (never a 404 fall-through)
// and so is the patient owner, who has a dedicated approved-plan route instead:
// the version workspace contains drafts, clarification notes and the reviewer's
// working timeline, none of which a patient may see.
async function resolveVersionRead({ clinicId, user, episodeId, roleKey }) {
  const resolved = await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  if (resolved.access !== 'team') {
    throw errors.forbidden('Only the assigned care team can read plan versions.');
  }
  return resolved;
}

// ---- helpers ----------------------------------------------------------------

async function itemsWithSources(versionId) {
  const items = await CarePlanItem.find({ version: versionId }).sort({ order: 1 }).lean();
  const sources = await SourceReference.find({ version: versionId }).sort({ createdAt: 1 }).lean();
  const byItem = new Map();
  for (const source of sources) {
    const key = idOf(source.item);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(source);
  }
  return items.map((item) => publicItem(item, byItem.get(idOf(item)) || []));
}

async function blockersFor(version) {
  const items = await itemsWithSources(version.id);
  const counts = items.map((item) => ({
    id: item.id,
    order: item.order,
    unresolvedFields: item.unresolvedFields,
    clinicalReviewState: item.clinicalReviewState,
    sourceCount: item.sourceCount,
    kind: item.kind,
  }));
  return {
    items,
    approval: policy.approvalBlockers({ items: counts }),
    submit: policy.submitBlockers({ items: counts }),
  };
}

async function loadVersion({ clinicId, episodeId, planId }) {
  const version = await CarePlanVersion.findOne({ _id: planId, clinic: clinicId, episode: episodeId });
  if (!version) throw errors.notFound('Care plan not found.');
  return version;
}

function requireEditable(version) {
  if (!policy.EDITABLE_STATES.includes(version.state)) {
    throw errors.conflict(
      version.state === STATES.APPROVED
        ? 'An approved plan is immutable. Create a new draft version to make changes.'
        : 'This plan version can no longer be edited.'
    );
  }
}

// Atomic state+revision guard: the update is filtered on the version id, the
// states that could legally perform this write AND the expected revision, so a
// parallel writer, a stale editor or a version in the wrong state can never be
// overwritten. Callers state which states may write (draft editing versus a
// reviewer decision); nothing is ever "just updated".
async function bumpVersion({
  clinicId,
  planId,
  expectedRevision,
  update = {},
  states = policy.EDITABLE_STATES,
  session = null,
}) {
  const mutation = { $inc: { revision: 1 } };
  if (Object.keys(update).length) mutation.$set = update;
  const query = CarePlanVersion.findOneAndUpdate(
    {
      _id: planId,
      clinic: clinicId,
      state: { $in: states },
      revision: expectedRevision,
    },
    mutation,
    { new: true }
  );
  if (session) query.session(session);
  return query;
}

function revisionConflict() {
  return errors.conflict('Your copy is out of date. Reload the plan and try again.');
}

async function episodePlanState(clinicId, episodeId) {
  // Coarse, non-clinical state for the episode's plan slot.
  const current = await CarePlanVersion.findOne({
    clinic: clinicId,
    episode: episodeId,
    state: { $in: [STATES.DRAFT, STATES.IN_REVIEW, STATES.NEEDS_CLARIFICATION] },
  })
    .sort({ version: -1 })
    .lean();
  if (!current) {
    const approved = await CarePlanVersion.findOne({
      clinic: clinicId,
      episode: episodeId,
      isCurrent: true,
    }).lean();
    return approved ? 'approved' : 'none';
  }
  return current.state;
}

async function syncEpisodePlanState({ clinicId, episodeId, session = null }) {
  const state = await episodePlanState(clinicId, episodeId);
  const update = { $set: { planState: state } };
  if (session) {
    await RecoveryEpisode.updateOne({ _id: episodeId, clinic: clinicId }, update, { session });
  } else {
    await RecoveryEpisode.updateOne({ _id: episodeId, clinic: clinicId }, update);
  }
  return state;
}

async function recordEvent({ clinicId, episode, version, action, user, roleKey, before, after, revisionBefore, revisionAfter, reason = undefined, session = null }) {
  const doc = {
    clinic: clinicId,
    patient: version.patient,
    episode: version.episode,
    version: version._id,
    action,
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: roleKey,
    stateBefore: before,
    stateAfter: after,
    revisionBefore,
    revisionAfter,
    reason,
    at: new Date(),
  };
  if (session) await ReviewEvent.create([doc], { session });
  else await ReviewEvent.create(doc);
  return doc;
}

// ---- draft lifecycle --------------------------------------------------------

async function createDraftVersion({ clinicId, user, episodeId, roleKey, data, ip, userAgent }) {
  const { episode } = await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });

  // A new version is numbered from the highest existing one. The unique
  // (episode, version) index makes a parallel duplicate impossible.
  const latest = await CarePlanVersion.findOne({ episode: episodeId }).sort({ version: -1 }).lean();
  const nextVersion = latest ? latest.version + 1 : 1;

  let source = null;
  if (data.fromVersionId) {
    source = await CarePlanVersion.findOne({
      _id: data.fromVersionId,
      clinic: clinicId,
      episode: episodeId,
    });
    // Copying is allowed from any existing version: an approved plan is never
    // edited, a linked COPY becomes the new draft with unreviewed items.
    if (!source) throw errors.notFound('Care plan not found.');
  }

  let created;
  try {
    created = await withTransaction(async (session) => {
      const [version] = await CarePlanVersion.create(
        [
          {
            clinic: clinicId,
            patient: episode.patient,
            episode: episodeId,
            version: nextVersion,
            state: STATES.DRAFT,
            revision: 1,
            title: data.title,
            summary: data.summary,
            createdBy: user.id,
            createdByLabel: user.email,
          },
        ],
        { session }
      );

      if (source) {
        const items = await CarePlanItem.find({ version: source._id }).sort({ order: 1 }).lean();
        const sources = await SourceReference.find({ version: source._id }).lean();
        if (items.length) {
          const created_items = await CarePlanItem.create(
            items.map((item) => ({
              clinic: clinicId,
              patient: episode.patient,
              episode: episodeId,
              version: version._id,
              order: item.order,
              kind: item.kind,
              originalWording: item.originalWording,
              medication: item.medication,
              dose: item.dose,
              route: item.route,
              frequency: item.frequency,
              timing: item.timing,
              duration: item.duration,
              condition: item.condition,
              homeCare: item.homeCare,
              dietActivity: item.dietActivity,
              followUp: item.followUp,
              warning: item.warning,
              unresolvedFields: item.unresolvedFields,
              // A copy starts UNREVIEWED: the previous approval does not carry
              // over to edited clinical content.
              clinicalReviewState: ITEM_REVIEW_STATES.PENDING,
              createdBy: user.id,
            })),
            { session, ordered: true }
          );
          const byOldId = new Map(items.map((item, index) => [idOf(item), created_items[index]._id]));
          const sourceDocs = sources
            .filter((s) => byOldId.has(idOf(s.item)))
            .map((s) => ({
              clinic: clinicId,
              patient: episode.patient,
              episode: episodeId,
              version: version._id,
              item: byOldId.get(idOf(s.item)),
              document: s.document,
              documentFilename: s.documentFilename,
              documentMediaType: s.documentMediaType,
              page: s.page,
              text: s.text,
              location: s.location,
              createdBy: user.id,
              createdByLabel: user.email,
            }));
          if (sourceDocs.length) await SourceReference.create(sourceDocs, { session, ordered: true });
        }
      }

      await recordEvent({
        clinicId,
        episode,
        version,
        action: 'created',
        user,
        roleKey,
        before: null,
        after: STATES.DRAFT,
        revisionBefore: null,
        revisionAfter: 1,
        session,
      });
      return version;
    });
  } catch (err) {
    if (err && err.code === 11000) {
      throw errors.conflict('Another draft version was created at the same time. Reload and retry.');
    }
    throw err;
  }

  await syncEpisodePlanState({ clinicId, episodeId });
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.created',
    targetType: 'care_plan_version',
    targetId: created.id,
    outcome: 'success',
    ip,
    userAgent,
    // Never the clinical text: only the version pointer and state.
    detail: { version: created.version, method: 'manual', copiedFrom: source ? source.version : null },
  });
  return publicVersion(created);
}

async function listVersions({ clinicId, user, episodeId, roleKey, page, limit }) {
  await resolveVersionRead({ clinicId, user, episodeId, roleKey });
  const filter = { clinic: clinicId, episode: episodeId };
  const [items, total] = await Promise.all([
    CarePlanVersion.find(filter).sort({ version: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CarePlanVersion.countDocuments(filter),
  ]);
  return { items: items.map(publicVersion), total, page, limit };
}

async function getVersion({ clinicId, user, episodeId, roleKey, planId }) {
  await resolveVersionRead({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  const { items, approval, submit } = await blockersFor(version);
  const events = await ReviewEvent.find({ version: version._id }).sort({ at: 1 }).lean();
  return {
    plan: publicVersion(version),
    items,
    blockers: { approval, submit },
    events: events.map(publicEvent),
  };
}

async function listItems({ clinicId, user, episodeId, roleKey, planId, page, limit }) {
  await resolveVersionRead({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  const filter = { version: version._id, clinic: clinicId };
  const [rows, total] = await Promise.all([
    CarePlanItem.find(filter).sort({ order: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    CarePlanItem.countDocuments(filter),
  ]);
  const sources = await SourceReference.find({
    version: version._id,
    item: { $in: rows.map((r) => r._id) },
  })
    .sort({ createdAt: 1 })
    .lean();
  const byItem = new Map();
  for (const source of sources) {
    const key = idOf(source.item);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(source);
  }
  return {
    items: rows.map((row) => publicItem(row, byItem.get(idOf(row)) || [])),
    total,
    page,
    limit,
    planRevision: version.revision,
    planState: version.state,
  };
}

async function updateVersion({ clinicId, user, episodeId, roleKey, planId, expectedRevision, data, ip, userAgent }) {
  await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  requireEditable(version);

  const update = {};
  if (data.title !== undefined) update.title = data.title;
  if (data.summary !== undefined) update.summary = data.summary;
  const updated = await bumpVersion({ clinicId, planId, expectedRevision, update });
  if (!updated) throw revisionConflict();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.updated',
    targetType: 'care_plan_version',
    targetId: planId,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: version.version, fields: Object.keys(update).sort() },
  });
  return publicVersion(updated);
}

// ---- items ------------------------------------------------------------------

function itemFields(data) {
  const fields = {};
  for (const field of policy.CLINICAL_FIELDS) {
    if (data[field] !== undefined) fields[field] = data[field];
  }
  return fields;
}

async function addItem({ clinicId, user, episodeId, roleKey, planId, expectedRevision, data, ip, userAgent }) {
  const { episode } = await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  requireEditable(version);

  const fields = itemFields(data);
  const unresolvedFields = policy.computeUnresolvedFields({ ...fields, kind: data.kind });
  const highest = await CarePlanItem.findOne({ version: version._id }).sort({ order: -1 }).lean();
  const order = data.order || (highest ? highest.order + 1 : 1);

  const updated = await bumpVersion({ clinicId, planId, expectedRevision, update: {} });
  if (!updated) throw revisionConflict();

  let item;
  try {
    item = await CarePlanItem.create({
      clinic: clinicId,
      patient: episode.patient,
      episode: episodeId,
      version: version._id,
      order,
      kind: data.kind || 'instruction',
      ...fields,
      unresolvedFields,
      clinicalReviewState: ITEM_REVIEW_STATES.PENDING,
      createdBy: user.id,
      updatedBy: user.id,
    });
  } catch (err) {
    // Roll the revision forward even on failure so the client cannot get stuck
    // on a revision that no longer exists.
    await CarePlanVersion.updateOne({ _id: version._id }, { $inc: { revision: 1 } }).catch(() => {});
    throw err;
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.item_created',
    targetType: 'care_plan_item',
    targetId: item.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: version.version, kind: item.kind, unresolved: unresolvedFields.length },
  });
  return publicItem(item.toObject ? item.toObject() : item, []);
}

async function updateItem({
  clinicId,
  user,
  episodeId,
  roleKey,
  planId,
  itemId,
  expectedRevision,
  data,
  ip,
  userAgent,
}) {
  const { episode } = await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  requireEditable(version);

  const item = await CarePlanItem.findOne({ _id: itemId, version: version._id, clinic: clinicId });
  if (!item) throw errors.notFound('Care plan item not found.');

  const fields = itemFields(data);
  const merged = {
    ...item.toObject(),
    ...fields,
    kind: data.kind || item.kind,
  };
  const unresolvedFields = policy.computeUnresolvedFields(merged);

  const updated = await bumpVersion({ clinicId, planId, expectedRevision, update: {} });
  if (!updated) throw revisionConflict();

  for (const [key, value] of Object.entries(fields)) item.set(key, value);
  if (data.kind) item.set('kind', data.kind);
  item.set('unresolvedFields', unresolvedFields);
  // Editing resets the clinical review: an approval can never survive an edit.
  item.set('clinicalReviewState', ITEM_REVIEW_STATES.PENDING);
  item.set('reviewNote', undefined);
  item.set('reviewedBy', undefined);
  item.set('reviewedByLabel', undefined);
  item.set('reviewedAt', undefined);
  item.set('updatedBy', user.id);
  await item.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.item_updated',
    targetType: 'care_plan_item',
    targetId: item.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: version.version, fields: Object.keys(fields).sort(), unresolved: unresolvedFields.length },
  });
  const sources = await SourceReference.find({ item: item._id }).sort({ createdAt: 1 }).lean();
  return publicItem(item.toObject(), sources);
}

async function deleteItem({ clinicId, user, episodeId, roleKey, planId, itemId, expectedRevision, ip, userAgent }) {
  await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  requireEditable(version);

  const item = await CarePlanItem.findOne({ _id: itemId, version: version._id, clinic: clinicId }).lean();
  if (!item) throw errors.notFound('Care plan item not found.');

  const updated = await bumpVersion({ clinicId, planId, expectedRevision, update: {} });
  if (!updated) throw revisionConflict();

  await SourceReference.deleteMany({ item: item._id });
  await CarePlanItem.deleteOne({ _id: item._id });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.item_deleted',
    targetType: 'care_plan_item',
    targetId: itemId,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: version.version },
  });
  return { deleted: true };
}

async function reorderItem({
  clinicId,
  user,
  episodeId,
  roleKey,
  planId,
  itemId,
  expectedRevision,
  direction,
  ip,
  userAgent,
}) {
  await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  requireEditable(version);

  const items = await CarePlanItem.find({ version: version._id }).sort({ order: 1, createdAt: 1 });
  const index = items.findIndex((row) => idOf(row) === String(itemId));
  if (index === -1) throw errors.notFound('Care plan item not found.');

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= items.length) {
    // A no-op move is not an error; it simply changes nothing.
    return { items: items.map((row) => row.order), moved: false };
  }

  const updated = await bumpVersion({ clinicId, planId, expectedRevision, update: {} });
  if (!updated) throw revisionConflict();

  // Rewrite the two affected orders inside a transaction so the list can never
  // end up with duplicate orders.
  await withTransaction(async (session) => {
    const a = items[index];
    const b = items[targetIndex];
    await CarePlanItem.updateOne({ _id: a._id }, { $set: { order: b.order } }, { session });
    await CarePlanItem.updateOne({ _id: b._id }, { $set: { order: a.order } }, { session });
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.item_reordered',
    targetType: 'care_plan_item',
    targetId: itemId,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: version.version, direction },
  });
  const rows = await CarePlanItem.find({ version: version._id }).sort({ order: 1 }).lean();
  return { moved: true, items: rows.map((row) => publicItem(row, [])) };
}

// ---- sources ----------------------------------------------------------------

async function linkSource({
  clinicId,
  user,
  episodeId,
  roleKey,
  planId,
  itemId,
  expectedRevision,
  data,
  ip,
  userAgent,
}) {
  await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  requireEditable(version);

  const item = await CarePlanItem.findOne({ _id: itemId, version: version._id, clinic: clinicId }).lean();
  if (!item) throw errors.notFound('Care plan item not found.');

  // The source must be a READY document of THIS episode and clinic; an unready
  // document is a 409 and a foreign/unready episode document is a 404.
  const document = await EpisodeDocument.findOne({
    _id: data.documentId,
    clinic: clinicId,
    episode: episodeId,
  }).lean();
  if (!document) throw errors.notFound('Source document not found.');
  if (document.status !== 'ready') {
    throw errors.conflict('Only a ready document can be cited as a source.');
  }

  const duplicate = await SourceReference.findOne({
    item: item._id,
    document: document._id,
    text: data.text,
  }).lean();
  if (duplicate) throw errors.conflict('That source reference is already linked to this item.');

  const updated = await bumpVersion({ clinicId, planId, expectedRevision, update: {} });
  if (!updated) throw revisionConflict();

  const source = await SourceReference.create({
    clinic: clinicId,
    patient: version.patient,
    episode: episodeId,
    version: version._id,
    item: item._id,
    document: document._id,
    documentFilename: document.originalFilename,
    documentMediaType: document.mediaType,
    page: data.page,
    text: data.text,
    location: data.location,
    createdBy: user.id,
    createdByLabel: user.email,
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.source_linked',
    targetType: 'source_reference',
    targetId: source.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: version.version, documentStatus: document.status, page: data.page || null },
  });
  return publicSource(source.toObject());
}

async function removeSource({ clinicId, user, episodeId, roleKey, planId, sourceId, expectedRevision, ip, userAgent }) {
  await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  requireEditable(version);

  const source = await SourceReference.findOne({ _id: sourceId, version: version._id, clinic: clinicId }).lean();
  if (!source) throw errors.notFound('Source reference not found.');

  const updated = await bumpVersion({ clinicId, planId, expectedRevision, update: {} });
  if (!updated) throw revisionConflict();

  await SourceReference.deleteOne({ _id: source._id });
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.source_removed',
    targetType: 'source_reference',
    targetId: sourceId,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: version.version },
  });
  return { deleted: true };
}

// ---- review actions ---------------------------------------------------------

async function submitForReview({ clinicId, user, episodeId, roleKey, planId, expectedRevision, ip, userAgent }) {
  const { episode } = await assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });

  // Submitting is allowed from an editable state, and only along a declared
  // transition (draft -> in_review, needs_clarification -> in_review).
  const from = version.state;
  if (!policy.EDITABLE_STATES.includes(from) || !policy.assertTransition(from, STATES.IN_REVIEW)) {
    throw errors.conflict('Only a draft or clarified plan can be submitted for review.');
  }

  const { submit } = await blockersFor(version);
  if (submit.length) {
    throw errors.conflict(submit[0].message);
  }

  const now = new Date();
  const updated = await bumpVersion({
    clinicId,
    planId,
    expectedRevision,
    update: { state: STATES.IN_REVIEW, submittedAt: now, submittedBy: user.id },
  });
  if (!updated) throw revisionConflict();

  await recordEvent({
    clinicId,
    episode,
    version: updated,
    action: from === STATES.NEEDS_CLARIFICATION ? 'resubmitted' : 'submitted',
    user,
    roleKey,
    before: from,
    after: STATES.IN_REVIEW,
    revisionBefore: expectedRevision,
    revisionAfter: updated.revision,
  });
  await syncEpisodePlanState({ clinicId, episodeId });
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.submitted',
    targetType: 'care_plan_version',
    targetId: planId,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: updated.version, itemCount: (await CarePlanItem.countDocuments({ version: planId })) },
  });
  return publicVersion(updated);
}

async function requestClarification({
  clinicId,
  user,
  episodeId,
  roleKey,
  planId,
  expectedRevision,
  reason,
  ip,
  userAgent,
}) {
  await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  await assertReviewerAuthority({ clinicId, user, episodeId, roleKey });

  if (version.state !== STATES.IN_REVIEW) {
    throw errors.conflict('Only a plan that is in review can be sent back for clarification.');
  }
  if (!policy.assertTransition(version.state, STATES.NEEDS_CLARIFICATION)) {
    throw errors.conflict('That transition is not allowed.');
  }

  const now = new Date();
  const updated = await bumpVersion({
    clinicId,
    planId,
    expectedRevision,
    // A reviewer decision happens while the plan IS in review.
    states: [STATES.IN_REVIEW],
    update: {
      state: STATES.NEEDS_CLARIFICATION,
      clarificationReason: reason,
      clarificationBy: user.id,
      clarificationByLabel: user.email,
      clarificationAt: now,
    },
  });
  if (!updated) throw revisionConflict();

  await recordEvent({
    clinicId,
    episode: version.episode,
    version: updated,
    action: 'clarification_requested',
    user,
    roleKey,
    before: STATES.IN_REVIEW,
    after: STATES.NEEDS_CLARIFICATION,
    revisionBefore: expectedRevision,
    revisionAfter: updated.revision,
    reason,
  });
  await syncEpisodePlanState({ clinicId, episodeId });
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.clarification_requested',
    targetType: 'care_plan_version',
    targetId: planId,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: updated.version },
  });
  return publicVersion(updated);
}

async function reviewItem({
  clinicId,
  user,
  episodeId,
  roleKey,
  planId,
  itemId,
  expectedRevision,
  decision,
  note,
  ip,
  userAgent,
}) {
  await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  await assertReviewerAuthority({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  if (version.state !== STATES.IN_REVIEW) {
    throw errors.conflict('Items can only be reviewed while the plan is in review.');
  }

  const item = await CarePlanItem.findOne({ _id: itemId, version: version._id, clinic: clinicId }).lean();
  if (!item) throw errors.notFound('Care plan item not found.');

  if (decision === 'accepted') {
    const unresolved = item.unresolvedFields || policy.computeUnresolvedFields(item);
    if (unresolved.length) {
      throw errors.conflict(
        `This item still has unresolved clinical fields (${unresolved.join(', ')}). Send it back for clarification instead.`
      );
    }
  }

  const updated = await bumpVersion({
    clinicId,
    planId,
    expectedRevision,
    states: [STATES.IN_REVIEW],
  });
  if (!updated) throw revisionConflict();

  const now = new Date();
  await CarePlanItem.updateOne(
    { _id: item._id },
    {
      $set: {
        clinicalReviewState:
          decision === 'accepted' ? ITEM_REVIEW_STATES.ACCEPTED : ITEM_REVIEW_STATES.CLARIFY_REQUESTED,
        reviewNote: note,
        reviewedBy: user.id,
        reviewedByLabel: user.email,
        reviewedAt: now,
      },
    }
  );

  await recordEvent({
    clinicId,
    episode: version.episode,
    version,
    action: decision === 'accepted' ? 'item_accepted' : 'item_clarification_requested',
    user,
    roleKey,
    before: version.state,
    after: version.state,
    revisionBefore: expectedRevision,
    revisionAfter: updated.revision,
    reason: note,
  });
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.item_reviewed',
    targetType: 'care_plan_item',
    targetId: itemId,
    outcome: 'success',
    ip,
    userAgent,
    detail: { version: version.version, decision },
  });
  const refreshed = await CarePlanItem.findOne({ _id: item._id }).lean();
  const sources = await SourceReference.find({ item: item._id }).sort({ createdAt: 1 }).lean();
  return publicItem(refreshed, sources);
}

// ---- approval ---------------------------------------------------------------

// ONE transaction: claim the version, supersede the previous current version,
// flip the current pointer, move the episode's approved-plan pointer and write
// the audit trail. Parallel approvals cannot both win: the conditional claim is
// filtered on state AND revision, and the partial unique index forbids two
// current approved versions even if a future code path tried.
async function approve({ clinicId, user, episodeId, roleKey, planId, expectedRevision, ip, userAgent }) {
  await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  await assertReviewerAuthority({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });

  // Idempotent retry: the same reviewer repeating the same approval of the same
  // revision returns the approved version instead of a conflict.
  if (
    version.state === STATES.APPROVED &&
    version.revision === expectedRevision + 1 &&
    idOf(version.approvedBy) === idOf(user)
  ) {
    return { plan: publicVersion(version), idempotent: true, superseded: null };
  }

  if (version.state !== STATES.IN_REVIEW) {
    throw errors.conflict('Only a plan in review can be approved.');
  }
  if (!policy.assertTransition(version.state, STATES.APPROVED)) {
    throw errors.conflict('That transition is not allowed.');
  }

  // Completeness is validated on the SERVER, immediately before approval.
  const { approval } = await blockersFor(version);
  if (approval.length) {
    throw errors.conflict(approval[0].message);
  }

  const now = new Date();
  const claimedRevision = expectedRevision + 1;

  const result = await withTransaction(async (session) => {
    // 1. Claim: state + revision constrained, so exactly one caller can win.
    const claimed = await CarePlanVersion.findOneAndUpdate(
      {
        _id: version._id,
        clinic: clinicId,
        episode: episodeId,
        state: STATES.IN_REVIEW,
        revision: expectedRevision,
      },
      {
        $set: {
          state: STATES.APPROVED,
          approvedBy: user.id,
          approvedByLabel: user.email,
          approvedAt: now,
        },
        $inc: { revision: 1 },
      },
      { new: true, session }
    );
    if (!claimed) throw errors.conflict('This plan was already decided. Reload to see the current state.');

    // 2. Supersede the previous current version (if any) BEFORE the new version
    //    becomes current, so the one-current-version index is never violated.
    //    The flip is conditional on the row still being the approved current
    //    one, and we keep the UPDATED document so the response and the timeline
    //    describe the real resulting state.
    const previous = await CarePlanVersion.findOneAndUpdate(
      {
        clinic: clinicId,
        episode: episodeId,
        isCurrent: true,
        state: STATES.APPROVED,
        _id: { $ne: claimed._id },
      },
      {
        $set: {
          isCurrent: false,
          state: STATES.SUPERSEDED,
          supersededBy: claimed._id,
          supersededAt: now,
        },
      },
      { new: true, session }
    );

    if (previous) {
      await ReviewEvent.create(
        [
          {
            clinic: clinicId,
            patient: previous.patient,
            episode: episodeId,
            version: previous._id,
            action: 'superseded',
            actorUser: user.id,
            actorLabel: user.email,
            actorRole: roleKey,
            stateBefore: STATES.APPROVED,
            stateAfter: STATES.SUPERSEDED,
            revisionBefore: previous.revision,
            revisionAfter: previous.revision,
            at: now,
          },
        ],
        { session }
      );
    }

    // 3. The approved version becomes THE current version.
    await CarePlanVersion.updateOne(
      { _id: claimed._id },
      { $set: { isCurrent: true } },
      { session }
    );

    // 4. Episode pointer/state. NOTE: no task, reminder or message is created -
    //    approval activates nothing downstream.
    await RecoveryEpisode.updateOne(
      { _id: episodeId, clinic: clinicId },
      { $set: { approvedPlanVersion: claimed._id, planState: 'approved' } },
      { session }
    );

    // 5. Audit history (no clinical text).
    await ReviewEvent.create(
      [
        {
          clinic: clinicId,
          patient: claimed.patient,
          episode: episodeId,
          version: claimed._id,
          action: 'approved',
          actorUser: user.id,
          actorLabel: user.email,
          actorRole: roleKey,
          stateBefore: STATES.IN_REVIEW,
          stateAfter: STATES.APPROVED,
          revisionBefore: expectedRevision,
          revisionAfter: claimedRevision,
          at: now,
        },
      ],
      { session }
    );

    return { claimed, previous };
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'care_plan.approved',
    targetType: 'care_plan_version',
    targetId: planId,
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      version: result.claimed.version,
      supersededVersion: result.previous ? result.previous.version : null,
      itemCount: await CarePlanItem.countDocuments({ version: planId }),
    },
  });

  return {
    plan: publicVersion({ ...result.claimed.toObject(), isCurrent: true }),
    idempotent: false,
    superseded: result.previous ? publicVersion(result.previous) : null,
  };
}

// ---- patient view -----------------------------------------------------------

// The patient owner sees ONLY the current approved version, with the approval
// actor/time and the permitted source references. Drafts, clarification notes
// and the reviewer's working state are invisible here.
async function getPatientCurrentPlan({ clinicId, user, episodeId }) {
  const episode = await RecoveryEpisode.findOne({ _id: episodeId, clinic: clinicId }).lean();
  if (!episode) throw errors.notFound('Episode not found.');

  const owned = await PatientProfile.findOne({
    _id: episode.patient,
    clinic: clinicId,
    linkedUserId: user.id,
  }).lean();
  // Ownership is required; there is no clinic-wide permission and no caregiver
  // path to a plan yet.
  if (!owned) throw errors.notFound('Episode not found.');

  const version = await CarePlanVersion.findOne({
    clinic: clinicId,
    episode: episodeId,
    state: STATES.APPROVED,
    isCurrent: true,
  }).lean();
  // No approved plan yet: an empty (not erroring) answer, because a patient must
  // never learn whether a draft exists.
  if (!version) return { plan: null, items: [] };

  const items = await CarePlanItem.find({ clinic: clinicId, version: version._id })
    .sort({ order: 1 })
    .lean();
  const sources = await SourceReference.find({ clinic: clinicId, version: version._id })
    .sort({ createdAt: 1 })
    .lean();
  const byItem = new Map();
  for (const source of sources) {
    const key = idOf(source.item);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(source);
  }
  return {
    plan: publicPatientVersion(version),
    items: items.map((item) => publicPatientItem(item, byItem.get(idOf(item)) || [])),
  };
}

module.exports = {
  publicVersion,
  publicItem,
  publicSource,
  publicEvent,
  publicPatientVersion,
  publicPatientItem,
  createDraftVersion,
  listVersions,
  getVersion,
  listItems,
  updateVersion,
  addItem,
  updateItem,
  deleteItem,
  reorderItem,
  linkSource,
  removeSource,
  submitForReview,
  requestClarification,
  reviewItem,
  approve,
  getPatientCurrentPlan,
  assertCoordinatorWrite,
  assertReviewerAuthority,
};
