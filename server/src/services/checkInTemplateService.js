'use strict';

// Clinic-defined check-in templates (VEL-015).
//
// A template is clinic configuration, not patient data, and it follows the same
// discipline as a care plan version: a coordinator DRAFTS, a clinic-verified
// clinical reviewer ACTIVATES, and activating a new version supersedes the
// previous one in one transaction. Nothing here writes to a patient record, and
// nothing here classifies recovery.
const { errors } = require('./errors');
const audit = require('./auditService');
const { withTransaction } = require('./txService');
const policy = require('../policies/checkInPolicy');
const { CHECKIN_TEMPLATE_STATES, ROLES } = require('../config/constants');
const CheckInTemplateVersion = require('../models/CheckInTemplateVersion');
const ClinicMembership = require('../models/ClinicMembership');

const NOT_FOUND = 'Check-in template not found.';

function idOf(value) {
  return value && value._id ? String(value._id) : String(value);
}

function publicTemplate(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    key: doc.key,
    version: doc.version,
    title: doc.title,
    description: doc.description || null,
    questions: (doc.questions || []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      kind: q.kind,
      required: Boolean(q.required),
      options: q.options ? [...q.options] : null,
      scaleMin: q.scaleMin ?? null,
      scaleMax: q.scaleMax ?? null,
    })),
    cadence: {
      startOffsetDays: doc.cadence.startOffsetDays,
      everyDays: doc.cadence.everyDays,
      horizonDays: doc.cadence.horizonDays,
    },
    responseWindowHours: doc.responseWindowHours,
    reviewRules: (doc.reviewRules || []).map((rule) => ({
      id: rule.id,
      label: rule.label,
      action: rule.action,
      when: {
        questionId: rule.when.questionId,
        operator: rule.when.operator,
        values: rule.when.values ? [...rule.when.values] : [],
        value: rule.when.value ?? null,
      },
    })),
    state: doc.state,
    revision: doc.revision,
    createdByLabel: doc.createdByLabel || null,
    activatedByLabel: doc.activatedByLabel || null,
    activatedAt: doc.activatedAt || null,
    supersededAt: doc.supersededAt || null,
    supersededByVersion: doc.supersededByVersion ?? null,
    note: policy.TEMPLATE_WORDING_NOTE,
  };
}

// A definition is validated structurally AND for wording before it is stored, so
// an invalid template can never reach activation.
function assertDefinition(definition) {
  const problems = policy.validateTemplateDefinition(definition);
  if (problems.length) throw errors.badRequest(problems.join(' '));
}

async function listTemplates({ clinicId, page, limit, state }) {
  const filter = { clinic: clinicId };
  if (state) filter.state = state;
  const [items, total] = await Promise.all([
    CheckInTemplateVersion.find(filter)
      .sort({ key: 1, version: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CheckInTemplateVersion.countDocuments(filter),
  ]);
  return { items: items.map(publicTemplate), total, page, limit };
}

async function getTemplate({ clinicId, templateId }) {
  const doc = await CheckInTemplateVersion.findOne({ _id: templateId, clinic: clinicId }).lean();
  if (!doc) throw errors.notFound(NOT_FOUND);
  return publicTemplate(doc);
}

// The active template set for a clinic, used when materialising check-in slots.
async function listActive({ clinicId, keys }) {
  const filter = { clinic: clinicId, state: CHECKIN_TEMPLATE_STATES.ACTIVE };
  if (keys && keys.length) filter.key = { $in: keys };
  return CheckInTemplateVersion.find(filter).sort({ key: 1 }).lean();
}

async function createVersion({ clinicId, actor, input, ip, userAgent }) {
  assertDefinition(input);
  const last = await CheckInTemplateVersion.findOne({ clinic: clinicId, key: input.key })
    .sort({ version: -1 })
    .lean();
  const version = last ? last.version + 1 : 1;

  const created = await CheckInTemplateVersion.create({
    clinic: clinicId,
    key: input.key,
    version,
    title: input.title,
    description: input.description,
    questions: input.questions,
    cadence: input.cadence,
    responseWindowHours: input.responseWindowHours ?? 24,
    reviewRules: input.reviewRules || [],
    state: CHECKIN_TEMPLATE_STATES.DRAFT,
    createdBy: actor.id,
    createdByLabel: actor.email,
  });

  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'checkin.template.created',
    targetType: 'check_in_template_version',
    targetId: created.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { key: created.key, version: created.version, questions: created.questions.length },
  });

  return publicTemplate(created.toObject());
}

async function updateDraft({ clinicId, templateId, actor, expectedRevision, changes, ip, userAgent }) {
  const doc = await CheckInTemplateVersion.findOne({ _id: templateId, clinic: clinicId });
  if (!doc) throw errors.notFound(NOT_FOUND);
  if (doc.state !== CHECKIN_TEMPLATE_STATES.DRAFT) {
    throw errors.conflict(
      'Only a draft template can be edited. Create a new version so the wording patients were asked stays intact.'
    );
  }
  if (doc.revision !== expectedRevision) {
    throw errors.conflict('This template changed since you loaded it. Reload and try again.');
  }

  const merged = {
    title: changes.title ?? doc.title,
    description: changes.description ?? doc.description,
    questions: changes.questions ?? doc.questions,
    cadence: changes.cadence ?? doc.cadence,
    responseWindowHours: changes.responseWindowHours ?? doc.responseWindowHours,
    reviewRules: changes.reviewRules ?? doc.reviewRules,
  };
  assertDefinition(merged);

  // Only the fields the caller actually sent are applied: a partial edit must
  // never blank out a required field by passing `undefined` (which would fail
  // model validation long after the request looked valid).
  const applied = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined)
  );
  doc.set({ ...applied, revision: doc.revision + 1 });
  await doc.save();

  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'checkin.template.updated',
    targetType: 'check_in_template_version',
    targetId: doc.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { key: doc.key, version: doc.version, fields: Object.keys(applied) },
  });

  return publicTemplate(doc.toObject());
}

// A verified reviewer of the same clinic activates a version. The definition is
// re-validated here (defence in depth, mirroring plan approval), and the swap is
// one transaction: the previous active version is superseded only when this one
// becomes active, so a clinic is never left without an active template.
async function activate({ clinicId, templateId, actor, membership, expectedRevision, note, ip, userAgent }) {
  const isVerifiedReviewer =
    membership &&
    membership.roleKey === ROLES.CLINICAL_REVIEWER &&
    membership.reviewerEligibility &&
    membership.reviewerEligibility.status === 'verified';
  if (!isVerifiedReviewer) {
    throw errors.forbidden('Only an assigned, clinic-verified clinical reviewer may activate a template.');
  }

  const target = await CheckInTemplateVersion.findOne({ _id: templateId, clinic: clinicId });
  if (!target) throw errors.notFound(NOT_FOUND);
  if (target.state === CHECKIN_TEMPLATE_STATES.ACTIVE) {
    // Idempotent: re-activating the same version is not an error and writes no
    // second history entry.
    return { template: publicTemplate(target.toObject()), supersededVersion: null, idempotent: true };
  }
  if (target.state !== CHECKIN_TEMPLATE_STATES.DRAFT) {
    throw errors.conflict('A superseded template version cannot be activated again.');
  }
  if (target.revision !== expectedRevision) {
    throw errors.conflict('This template changed since you loaded it. Reload and try again.');
  }
  assertDefinition(target.toObject());

  let supersededVersion = null;

  const activated = await withTransaction(async (session) => {
    const previous = await CheckInTemplateVersion.findOne({
      clinic: clinicId,
      key: target.key,
      state: CHECKIN_TEMPLATE_STATES.ACTIVE,
    }).session(session);

    if (previous) {
      supersededVersion = previous.version;
      await CheckInTemplateVersion.updateOne(
        { _id: previous._id, state: CHECKIN_TEMPLATE_STATES.ACTIVE },
        {
          $set: {
            state: CHECKIN_TEMPLATE_STATES.SUPERSEDED,
            supersededAt: new Date(),
            supersededByVersion: target.version,
          },
        },
        { session }
      );
    }

    const claimed = await CheckInTemplateVersion.findOneAndUpdate(
      { _id: target._id, state: CHECKIN_TEMPLATE_STATES.DRAFT, revision: expectedRevision },
      {
        $set: {
          state: CHECKIN_TEMPLATE_STATES.ACTIVE,
          activatedBy: actor.id,
          activatedByLabel: actor.email,
          activatedAt: new Date(),
          activationNote: note,
          revision: expectedRevision + 1,
        },
      },
      { new: true, session }
    );
    if (!claimed) throw errors.conflict('This template was activated by someone else.');

    await audit.record({
      clinic: clinicId,
      actorUser: actor.id,
      actorLabel: actor.email,
      action: 'checkin.template.activated',
      targetType: 'check_in_template_version',
      targetId: String(claimed._id),
      outcome: 'success',
      ip,
      userAgent,
      session,
      detail: {
        key: claimed.key,
        version: claimed.version,
        supersededVersion,
        reviewRules: claimed.reviewRules.length,
      },
    });

    return claimed;
  });

  return { template: publicTemplate(activated.toObject()), supersededVersion, idempotent: false };
}

// Convenience for tests and other services: the caller's membership document.
async function membershipFor(clinicId, userId) {
  return ClinicMembership.findOne({ clinic: clinicId, user: userId, status: 'active' }).lean();
}

module.exports = {
  listTemplates,
  getTemplate,
  listActive,
  createVersion,
  updateDraft,
  activate,
  membershipFor,
  publicTemplate,
};
