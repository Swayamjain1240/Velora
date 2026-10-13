'use strict';

// Reviewed Hindi/English presentation of plan instructions (Part 6 language
// rules).
//
// A variant is a RENDERING of one plan item's instruction into Hindi or into a
// simpler English form. It is:
//   - linked to the original instruction (the source wording is captured at
//     creation and preserved);
//   - versioned (a revision is a NEW variant, never an edit in place);
//   - meaning-preserving (a numeric guard runs on every write, and the reviewer
//     must state that fidelity holds before it can be approved);
//   - reviewer-approved (only an assigned, verified clinical reviewer may approve
//     it, using the same authority as plan approval);
//   - never patient-visible automatically (no patient route reads variants).
//
// Approving a rendering never changes an item's clinical fields, its unresolved
// fields, its review state or the plan's approval state: it changes presentation
// metadata only.
const crypto = require('node:crypto');
const { errors } = require('./errors');
const audit = require('./auditService');
const episodeService = require('./episodeService');
const carePlanService = require('./carePlanService');
const { EXTRACTION_FIELDS } = require('../policies/extractionPolicy');
const ReviewedLanguageVariant = require('../models/ReviewedLanguageVariant');
const CarePlanItem = require('../models/CarePlanItem');
const CarePlanVersion = require('../models/CarePlanVersion');
const ReviewEvent = require('../models/ReviewEvent');

const LANGUAGES = Object.freeze(['hi', 'en']);
const KINDS = Object.freeze(['translation', 'simplification']);
// The clinical values that must survive a rendering unchanged. Numbers are
// language-neutral, so they must appear in ANY rendering; the full value is
// required only for an English rendering of an English source.
const NUMERIC_FIELDS = Object.freeze(['dose', 'frequency', 'duration']);

function idOf(value) {
  return value && value._id ? String(value._id) : String(value);
}

function auditContext(ip, userAgent) {
  return { ip, userAgent };
}

function numbersIn(value) {
  return String(value || '').match(/\d+(?:[.,]\d+)?/g) || [];
}

function normalize(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// The automated guard. It cannot prove that a Hindi sentence means the same
// thing, and it does not try. It proves two narrow, checkable things:
//   1. no NUMBER was silently lost (dose, frequency and duration figures are
//      language-neutral, so this holds for any rendering);
//   2. for an ENGLISH rendering, each stated dose/frequency/duration value is
//      still present as written.
// The route is deliberately NOT checked: "by mouth" for "oral" is a legitimate
// simplification, and meaning remains the reviewer's judgement. Anything the
// guard cannot confirm becomes a warning that blocks approval until it is fixed
// or the wording is rewritten by hand.
function fidelityCheck(item, text, language) {
  const warnings = [];
  const body = normalize(text);
  if (!body) warnings.push('empty_text');

  for (const field of NUMERIC_FIELDS) {
    const value = item[field];
    if (!value) continue;
    for (const number of numbersIn(value)) {
      // A dropped dose or frequency number is the single most dangerous
      // rendering error, so it is a hard warning in every language.
      if (!body.includes(normalize(number))) warnings.push(`missing_number_in_${field}`);
    }
  }
  if (language === 'en' && item.kind === 'medication') {
    for (const field of NUMERIC_FIELDS) {
      const value = item[field];
      if (!value) continue;
      if (!body.includes(normalize(value))) warnings.push(`missing_value_in_${field}`);
    }
  }
  return { checked: true, passed: warnings.length === 0, warnings: [...new Set(warnings)] };
}

// A fingerprint of the instruction a rendering was drafted from. The rendering
// is only meaningful while the instruction still reads the same, so approval
// recomputes this and refuses when anything clinical moved.
function sourceFingerprint(item) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        originalWording: item.originalWording || '',
        kind: item.kind || '',
        dose: item.dose || '',
        frequency: item.frequency || '',
        duration: item.duration || '',
        route: item.route || '',
        medication: item.medication || '',
      })
    )
    .digest('hex');
}

function publicVariant(variant) {
  return {
    id: idOf(variant),
    episode: idOf(variant.episode),
    version: idOf(variant.version),
    item: idOf(variant.item),
    language: variant.language,
    kind: variant.kind,
    variant: variant.variant,
    // The instruction this rendering is tied to, captured at creation.
    sourceWording: variant.sourceWording,
    text: variant.text,
    producedBy: variant.producedBy,
    provider: variant.provider || null,
    model: variant.model || null,
    reviewState: variant.reviewState,
    fidelity: {
      checked: Boolean(variant.fidelity && variant.fidelity.checked),
      passed: Boolean(variant.fidelity && variant.fidelity.passed),
      warnings: (variant.fidelity && variant.fidelity.warnings) || [],
    },
    createdByLabel: variant.createdByLabel || null,
    submittedAt: variant.submittedAt || null,
    fidelityNote: variant.fidelityNote || null,
    approvedByLabel: variant.approvedByLabel || null,
    approvedAt: variant.approvedAt || null,
    rejectedByLabel: variant.rejectedByLabel || null,
    rejectedAt: variant.rejectedAt || null,
    rejectionReason: variant.rejectionReason || null,
    supersededBy: variant.supersededBy ? idOf(variant.supersededBy) : null,
    supersededAt: variant.supersededAt || null,
    createdAt: variant.createdAt,
    updatedAt: variant.updatedAt,
  };
}

// Drafting a rendering is a DRAFTING action; approving it is a REVIEW action.
async function resolveDraftAuthority({ clinicId, user, episodeId, roleKey }) {
  return carePlanService.assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
}

async function resolveTeamRead({ clinicId, user, episodeId, roleKey }) {
  const resolved = await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  if (resolved.access !== 'team') {
    throw errors.forbidden('Only the assigned care team can read plan renderings.');
  }
  return resolved;
}

async function loadItem({ clinicId, episodeId, planId, itemId }) {
  const item = await CarePlanItem.findOne({
    _id: itemId,
    version: planId,
    clinic: clinicId,
    episode: episodeId,
  }).lean();
  if (!item) throw errors.notFound('Care plan item not found.');
  return item;
}

async function loadVersion({ clinicId, episodeId, planId }) {
  const version = await CarePlanVersion.findOne({ _id: planId, clinic: clinicId, episode: episodeId }).lean();
  if (!version) throw errors.notFound('Care plan not found.');
  return version;
}

async function createVariant({
  clinicId,
  user,
  episodeId,
  roleKey,
  planId,
  itemId,
  language,
  kind,
  text,
  producedBy = 'human',
  provider = null,
  model = null,
  modelRun = null,
  ip,
  userAgent,
}) {
  await resolveDraftAuthority({ clinicId, user, episodeId, roleKey });
  const version = await loadVersion({ clinicId, episodeId, planId });
  if (version.state === 'superseded') {
    throw errors.conflict('A superseded plan version cannot receive new renderings.');
  }
  const item = await loadItem({ clinicId, episodeId, planId, itemId });
  if (!LANGUAGES.includes(language)) throw errors.badRequest('Unsupported language.');
  if (!KINDS.includes(kind)) throw errors.badRequest('Unsupported rendering kind.');

  const fidelity = fidelityCheck(item, text, language);
  const latest = await ReviewedLanguageVariant.findOne({
    item: item._id,
    language,
    kind,
  })
    .sort({ variant: -1 })
    .lean();
  const nextVariant = latest ? latest.variant + 1 : 1;

  const created = await ReviewedLanguageVariant.create({
    clinic: clinicId,
    patient: version.patient,
    episode: episodeId,
    version: version._id,
    item: item._id,
    language,
    kind,
    variant: nextVariant,
    // The instruction as it reads NOW: if the item is later edited, the rendering
    // no longer matches its source and approval is refused.
    sourceWording: item.originalWording,
    sourceFingerprint: sourceFingerprint(item),
    text,
    producedBy,
    provider,
    model,
    modelRun,
    reviewState: 'draft',
    fidelity,
    createdBy: user.id,
    createdByLabel: user.email,
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'language.variant_created',
    targetType: 'reviewed_language_variant',
    targetId: created.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    // Language, kind, origin and fidelity outcome - never the rendered wording.
    detail: { language, kind, producedBy, variant: nextVariant, fidelityPassed: fidelity.passed },
  });

  return publicVariant(created.toObject ? created.toObject() : created);
}

async function submitVariant({ clinicId, user, episodeId, roleKey, planId, variantId, ip, userAgent }) {
  await resolveDraftAuthority({ clinicId, user, episodeId, roleKey });
  const variant = await ReviewedLanguageVariant.findOne({
    _id: variantId,
    clinic: clinicId,
    episode: episodeId,
    version: planId,
  });
  if (!variant) throw errors.notFound('Rendering not found.');
  if (variant.reviewState === 'approved') {
    return { variant: publicVariant(variant.toObject()), idempotent: true };
  }
  if (variant.reviewState !== 'draft') {
    throw errors.conflict('Only a draft rendering can be submitted for review.');
  }
  variant.reviewState = 'in_review';
  variant.submittedAt = new Date();
  await variant.save();
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'language.variant_submitted',
    targetType: 'reviewed_language_variant',
    targetId: variant.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    detail: { language: variant.language, kind: variant.kind, variant: variant.variant },
  });
  return { variant: publicVariant(variant.toObject()), idempotent: false };
}

// Reviewer authority is the SAME authority Part 5 requires to approve a plan:
// active membership, clinical_reviewer role, verified eligibility, the role
// permission and a current active reviewer assignment on this episode.
async function approveVariant({
  clinicId,
  user,
  episodeId,
  roleKey,
  planId,
  variantId,
  fidelityNote,
  ip,
  userAgent,
}) {
  await carePlanService.assertReviewerAuthority({ clinicId, user, episodeId, roleKey });
  const variant = await ReviewedLanguageVariant.findOne({
    _id: variantId,
    clinic: clinicId,
    episode: episodeId,
    version: planId,
  });
  if (!variant) throw errors.notFound('Rendering not found.');

  if (variant.reviewState === 'approved') {
    // Idempotent retry by the same reviewer.
    return { variant: publicVariant(variant.toObject()), idempotent: true };
  }
  if (variant.reviewState !== 'in_review') {
    throw errors.conflict('Only a rendering that is in review can be approved.');
  }

  const item = await loadItem({ clinicId, episodeId, planId, itemId: idOf(variant.item) });
  // The instruction may have been edited since the rendering was drafted, which
  // would make an approval meaningless: the rendering would no longer render the
  // current wording.
  if (
    item.originalWording !== variant.sourceWording ||
    sourceFingerprint(item) !== variant.sourceFingerprint
  ) {
    throw errors.conflict('The instruction changed after this rendering was drafted. Draft it again.');
  }
  const fidelity = fidelityCheck(item, variant.text, variant.language);
  if (!fidelity.passed) {
    throw errors.conflict(
      'This rendering does not preserve the stated clinical values and cannot be approved.'
    );
  }

  const now = new Date();
  // Supersede the previous approved rendering for the same item/language/kind
  // BEFORE this one becomes approved, so the one-approved rendering index can
  // never be violated.
  const previous = await ReviewedLanguageVariant.findOneAndUpdate(
    {
      item: variant.item,
      language: variant.language,
      kind: variant.kind,
      reviewState: 'approved',
      _id: { $ne: variant._id },
    },
    { $set: { reviewState: 'superseded', supersededBy: variant._id, supersededAt: now } },
    { new: true }
  ).lean();

  variant.reviewState = 'approved';
  variant.fidelity = fidelity;
  variant.fidelityNote = fidelityNote;
  variant.approvedBy = user.id;
  variant.approvedByLabel = user.email;
  variant.approvedAt = now;
  await variant.save();

  await ReviewEvent.create({
    clinic: clinicId,
    patient: variant.patient,
    episode: variant.episode,
    version: variant.version,
    action: 'approved',
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: roleKey,
    stateBefore: 'in_review',
    stateAfter: 'approved',
    at: now,
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'language.variant_approved',
    targetType: 'reviewed_language_variant',
    targetId: variant.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    // The reviewer's note is bounded and non-clinical; the wording itself is not
    // copied into the audit trail.
    detail: {
      language: variant.language,
      kind: variant.kind,
      variant: variant.variant,
      superseded: previous ? previous.variant : null,
    },
  });

  return {
    variant: publicVariant(variant.toObject()),
    superseded: previous ? publicVariant(previous) : null,
    idempotent: false,
  };
}

async function rejectVariant({
  clinicId,
  user,
  episodeId,
  roleKey,
  planId,
  variantId,
  reason,
  ip,
  userAgent,
}) {
  await carePlanService.assertReviewerAuthority({ clinicId, user, episodeId, roleKey });
  const variant = await ReviewedLanguageVariant.findOne({
    _id: variantId,
    clinic: clinicId,
    episode: episodeId,
    version: planId,
  });
  if (!variant) throw errors.notFound('Rendering not found.');
  if (variant.reviewState !== 'in_review') {
    throw errors.conflict('Only a rendering that is in review can be rejected.');
  }
  variant.reviewState = 'draft';
  variant.rejectedBy = user.id;
  variant.rejectedByLabel = user.email;
  variant.rejectedAt = new Date();
  variant.rejectionReason = reason;
  await variant.save();
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'language.variant_rejected',
    targetType: 'reviewed_language_variant',
    targetId: variant.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    detail: { language: variant.language, kind: variant.kind, variant: variant.variant },
  });
  return { variant: publicVariant(variant.toObject()) };
}

async function listVariants({ clinicId, user, episodeId, roleKey, planId, itemId, page, limit }) {
  await resolveTeamRead({ clinicId, user, episodeId, roleKey });
  const filter = { clinic: clinicId, episode: episodeId, version: planId };
  if (itemId) filter.item = itemId;
  const [rows, total] = await Promise.all([
    ReviewedLanguageVariant.find(filter)
      .sort({ item: 1, language: 1, kind: 1, variant: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ReviewedLanguageVariant.countDocuments(filter),
  ]);
  // The fields a reviewer checks the rendering against, so the panel can show
  // source, rendering and the clinical values side by side.
  const items = await CarePlanItem.find({ version: planId, _id: { $in: rows.map((row) => row.item) } })
    .select([...EXTRACTION_FIELDS, 'order', 'kind'].join(' '))
    .lean();
  const itemById = new Map(items.map((item) => [idOf(item), item]));
  return {
    items: rows.map((row) => {
      const item = itemById.get(idOf(row.item));
      return {
        ...publicVariant(row),
        itemOrder: item ? item.order : null,
        itemKind: item ? item.kind : null,
        clinicalValues: item
          ? Object.fromEntries(EXTRACTION_FIELDS.filter((field) => item[field]).map((field) => [field, item[field]]))
          : {},
      };
    }),
    total,
    page,
    limit,
  };
}

module.exports = {
  LANGUAGES,
  KINDS,
  fidelityCheck,
  sourceFingerprint,
  publicVariant,
  createVariant,
  submitVariant,
  approveVariant,
  rejectVariant,
  listVariants,
};
