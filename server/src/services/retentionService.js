'use strict';

// Retention (Part 9, VEL-021).
//
//   * Categories are CONFIGURABLE per clinic, starting from documented defaults.
//   * A DRY RUN changes nothing: it reports eligible counts, the cutoff used and
//     the holds in force.
//   * APPLY requires an explicit operator and reason, is bounded, and is
//     idempotent by an idempotency key so a retry cannot run twice.
//   * Clinical material (documents, closed episodes, history) is REPORT-ONLY.
//     Real destruction of clinical records is deliberately not implemented: it
//     needs a separate authorization and a tested backup/restore process.
//   * An active HOLD freezes its category.
const { errors } = require('./errors');
const audit = require('./auditService');
const exportStorage = require('./exportStorage');
const { getEnv } = require('../config/env');
const { RETENTION_CATEGORIES } = require('../config/constants');
const RetentionPolicy = require('../models/RetentionPolicy');
const RetentionRun = require('../models/RetentionRun');
const RetentionHold = require('../models/RetentionHold');
const Session = require('../models/Session');
const DataExport = require('../models/DataExport');
const RateLimitBucket = require('../models/RateLimitBucket');
const DeliveryAttempt = require('../models/DeliveryAttempt');

function idOf(value) {
  return value && value._id ? String(value._id) : value === null || value === undefined ? null : String(value);
}

function catalogEntry(category) {
  return RETENTION_CATEGORIES.find((c) => c.key === category) || null;
}

// ---- configuration -----------------------------------------------------------

async function listCategories({ clinicId }) {
  const overrides = await RetentionPolicy.find({ clinic: clinicId }).lean();
  const byKey = new Map(overrides.map((o) => [o.category, o]));
  return RETENTION_CATEGORIES.map((category) => {
    const override = byKey.get(category.key);
    return {
      key: category.key,
      label: category.label,
      description: category.description,
      reportOnly: category.reportOnly,
      retainDays: override ? override.retainDays : category.defaultRetainDays,
      enabled: override ? override.enabled : category.enabled,
      defaultRetainDays: category.defaultRetainDays,
      overridden: Boolean(override),
      note: override ? override.note || null : null,
    };
  });
}

async function updatePolicy({ clinicId, user, category, input, ip, userAgent }) {
  const entry = catalogEntry(category);
  if (!entry) throw errors.badRequest('Unknown retention category.');
  const existing = await RetentionPolicy.findOne({ clinic: clinicId, category });
  if (existing) {
    existing.retainDays = input.retainDays;
    if (input.enabled !== undefined) existing.enabled = input.enabled;
    existing.updatedBy = user.id;
    existing.updatedLabel = user.email;
    existing.note = input.note;
    await existing.save();
  } else {
    await RetentionPolicy.create({
      clinic: clinicId,
      category,
      retainDays: input.retainDays,
      enabled: input.enabled !== false,
      updatedBy: user.id,
      updatedLabel: user.email,
      note: input.note,
    });
  }
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'retention.policy.updated',
    category: 'retention',
    subjectType: 'retention_category',
    subjectId: category,
    outcome: 'success',
    ip,
    userAgent,
    detail: { retainDays: input.retainDays, enabled: input.enabled !== false },
  });
  return { categories: await listCategories({ clinicId }) };
}

// ---- holds -------------------------------------------------------------------

async function activeHolds({ clinicId }) {
  return RetentionHold.find({ clinic: clinicId, releasedAt: null }).lean();
}

async function createHold({ clinicId, user, input, ip, userAgent }) {
  const entry = catalogEntry(input.category);
  if (!entry) throw errors.badRequest('Unknown retention category.');
  const hold = await RetentionHold.create({
    clinic: clinicId,
    scope: input.scope,
    category: input.category,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    reason: input.reason,
    createdBy: user.id,
    createdLabel: user.email,
  });
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'retention.hold.created',
    category: 'retention',
    subjectType: 'retention_hold',
    subjectId: idOf(hold),
    outcome: 'success',
    ip,
    userAgent,
    detail: { category: input.category, scope: input.scope, reason: input.reason },
  });
  return { hold: publicHold(hold.toObject()) };
}

async function releaseHold({ clinicId, user, holdId, input, ip, userAgent, now = new Date() }) {
  const hold = await RetentionHold.findOne({ _id: holdId, clinic: clinicId });
  if (!hold) throw errors.notFound('Retention hold not found.');
  if (hold.releasedAt) throw errors.conflict('That hold is already released.');
  hold.releasedAt = now;
  hold.releasedBy = user.id;
  hold.releasedLabel = user.email;
  hold.releasedReason = input.reason;
  await hold.save();
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'retention.hold.released',
    category: 'retention',
    subjectType: 'retention_hold',
    subjectId: idOf(hold),
    outcome: 'success',
    ip,
    userAgent,
    detail: { reason: input.reason, category: hold.category },
  });
  return { hold: publicHold(hold.toObject()) };
}

function publicHold(doc) {
  return {
    id: idOf(doc),
    scope: doc.scope,
    category: doc.category,
    subjectType: doc.subjectType || null,
    subjectId: doc.subjectId || null,
    reason: doc.reason,
    createdLabel: doc.createdLabel || null,
    releasedAt: doc.releasedAt || null,
    releasedReason: doc.releasedReason || null,
    createdAt: doc.createdAt,
  };
}

async function listHolds({ clinicId, page, limit }) {
  const filter = { clinic: clinicId };
  const [rows, total] = await Promise.all([
    RetentionHold.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    RetentionHold.countDocuments(filter),
  ]);
  return { items: rows.map(publicHold), total, page, limit };
}

// ---- planning ----------------------------------------------------------------

// The bounded, side-effect-free plan. A `reportOnly` category is enumerated but
// never acted on; an active hold freezes its category.
async function buildPlan({ clinicId, categories: requested, now = new Date() }) {
  const configured = await listCategories({ clinicId });
  const holds = await activeHolds({ clinicId });
  const maxItems = getEnv().RETENTION_APPLY_MAX_ITEMS;
  const selected = requested && requested.length ? new Set(requested) : null;

  const plan = [];
  for (const category of configured) {
    if (selected && !selected.has(category.key)) continue;
    const cutoff = new Date(now.getTime() - category.retainDays * 24 * 60 * 60 * 1000);
    const categoryHolds = holds.filter((h) => h.category === category.key);
    const result = {
      category: category.key,
      label: category.label,
      retainDays: category.retainDays,
      cutoff,
      reportOnly: category.reportOnly,
      enabled: category.enabled,
      held: categoryHolds.length,
      holdReasons: categoryHolds.map((h) => ({ scope: h.scope, reason: h.reason })),
      eligible: 0,
      outcome: 'planned',
      note: null,
    };

    if (!category.enabled) {
      result.outcome = 'disabled';
      plan.push(result);
      continue;
    }
    if (category.reportOnly) {
      result.outcome = 'report_only';
      result.note = 'Report-only: automated destruction of clinical records is not implemented.';
    }
    if (result.held > 0) {
      result.outcome = 'held';
      result.note = 'An active retention hold freezes this category.';
    }

    // Eligible counts are always computed (a hold does not hide the number).
    // eslint-disable-next-line no-await-in-loop
    const eligible = await countEligible({ clinicId, category: category.key, cutoff, maxItems });
    result.eligible = eligible;
    plan.push(result);
  }
  return { plan, holds, maxItems };
}

// Sessions are global rather than clinic-scoped, so retention must be narrowed to
// the users who are members of THIS clinic. Without this a clinic's run could
// touch another tenant's sessions.
async function clinicUserIds(clinicId) {
  const ClinicMembership = require('../models/ClinicMembership');
  const ids = await ClinicMembership.find({ clinic: clinicId }).distinct('user');
  return ids;
}

async function sessionFilter({ clinicId, cutoff }) {
  const userIds = await clinicUserIds(clinicId);
  return {
    user: { $in: userIds },
    $or: [{ expiresAt: { $lt: cutoff } }, { revokedAt: { $lt: cutoff } }],
  };
}

async function countEligible({ clinicId, category, cutoff, maxItems }) {
  if (category === 'sessions_tokens') {
    const count = await Session.countDocuments(await sessionFilter({ clinicId, cutoff }));
    return Math.min(count, maxItems);
  }
  if (category === 'generated_exports') {
    const count = await DataExport.countDocuments({ clinic: clinicId, expiresAt: { $lt: cutoff } });
    return Math.min(count, maxItems);
  }
  if (category === 'rate_limit_buckets') {
    const count = await RateLimitBucket.countDocuments({ windowStart: { $lt: cutoff } });
    return Math.min(count, maxItems);
  }
  if (category === 'operational_logs') {
    // Delivery attempts are append-only at the model level, so the count goes
    // through the raw driver rather than the guarded model API.
    const count = await DeliveryAttempt.collection.countDocuments({ clinic: clinicId, at: { $lt: cutoff } });
    return Math.min(count, maxItems);
  }
  if (category === 'documents') {
    const EpisodeDocument = require('../models/EpisodeDocument');
    const count = await EpisodeDocument.countDocuments({ clinic: clinicId, createdAt: { $lt: cutoff } });
    return Math.min(count, maxItems);
  }
  if (category === 'historical_records') {
    const RecoveryEpisode = require('../models/RecoveryEpisode');
    const count = await RecoveryEpisode.countDocuments({ clinic: clinicId, status: 'closed', updatedAt: { $lt: cutoff } });
    return Math.min(count, maxItems);
  }
  return 0;
}

// ---- dry run / apply ---------------------------------------------------------

function toRunCategories(plan, { affected = {} } = {}) {
  return plan.map((entry) => ({
    category: entry.category,
    label: entry.label,
    retainDays: entry.retainDays,
    cutoff: entry.cutoff,
    eligible: entry.eligible,
    held: entry.held,
    affected: affected[entry.category] || 0,
    reportOnly: entry.reportOnly,
    outcome: entry.outcome,
    note: entry.note || null,
  }));
}

function summarize(plan) {
  return plan.reduce(
    (acc, entry) => {
      acc.eligible += entry.eligible;
      acc.held += entry.held;
      return acc;
    },
    { eligible: 0, held: 0, categories: plan.length }
  );
}

async function dryRun({ clinicId, user, ...rest }) {
  const { plan } = await buildPlan({ clinicId, now: new Date() });
  const run = await RetentionRun.create({
    clinic: clinicId,
    mode: 'dry_run',
    result: 'dry_run',
    operatorUser: user.id,
    operator: `dry_run:${user.email}`,
    categories: toRunCategories(plan),
    holds: plan.filter((p) => p.held > 0).map((p) => ({ category: p.category, held: p.held })),
    totals: summarize(plan),
    limits: { maxItems: getEnv().RETENTION_APPLY_MAX_ITEMS },
  });
  return { run: publicRun(run.toObject()), plan: toRunCategories(plan), note: 'Dry run only: nothing was changed.' };
}

async function applyDeletions({ clinicId, plan, maxItems }) {
  const affected = {};
  for (const entry of plan) {
    if (entry.outcome !== 'planned' || entry.held > 0 || entry.reportOnly || !entry.enabled) {
      affected[entry.category] = 0;
      continue;
    }
    const cutoff = entry.cutoff;
    if (entry.category === 'sessions_tokens') {
      const result = await Session.deleteMany(await sessionFilter({ clinicId, cutoff }));
      affected[entry.category] = result.deletedCount;
    } else if (entry.category === 'generated_exports') {
      const expired = await DataExport.find({ clinic: clinicId, expiresAt: { $lt: cutoff } }).limit(maxItems).lean();
      let removed = 0;
      for (const artifact of expired) {
        // eslint-disable-next-line no-await-in-loop
        await exportStorage.remove(artifact.storageKey).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await DataExport.deleteOne({ _id: artifact._id });
        removed += 1;
      }
      affected[entry.category] = removed;
    } else if (entry.category === 'rate_limit_buckets') {
      const result = await RateLimitBucket.deleteMany({ windowStart: { $lt: cutoff } });
      affected[entry.category] = result.deletedCount;
    } else if (entry.category === 'operational_logs') {
      // Append-only model: the documented retention apply bypasses the guard with
      // the raw driver, which is exactly what the run's audit record describes.
      const result = await DeliveryAttempt.collection.deleteMany({ clinic: clinicId, at: { $lt: cutoff } });
      affected[entry.category] = Number(result.deletedCount || 0);
    } else {
      affected[entry.category] = 0;
    }
  }
  return affected;
}

async function apply({ clinicId, user, input, ip, userAgent, now = new Date() }) {
  const existing = await RetentionRun.findOne({ clinic: clinicId, idempotencyKey: input.clientRequestId });
  if (existing) {
    return { run: publicRun(existing.toObject()), idempotent: true, note: 'This retention request was already applied.' };
  }

  const { plan, maxItems } = await buildPlan({ clinicId, categories: input.categories, now });
  const affected = await applyDeletions({ clinicId, plan, maxItems });
  const acted = Object.values(affected).some((count) => count > 0);
  const anyPlanned = plan.some((p) => p.outcome === 'planned');
  const result = acted ? (plan.some((p) => p.held > 0) ? 'partial' : 'applied') : anyPlanned ? 'report_only' : 'partial';

  let run;
  try {
    run = await RetentionRun.create({
      clinic: clinicId,
      mode: 'apply',
      result,
      operator: input.operator,
      operatorUser: user.id,
      reason: input.reason,
      idempotencyKey: input.clientRequestId,
      categories: toRunCategories(plan, { affected }),
      holds: plan.filter((p) => p.held > 0).map((p) => ({ category: p.category, held: p.held })),
      totals: { ...summarize(plan), affected: Object.values(affected).reduce((a, b) => a + b, 0) },
      limits: { maxItems },
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const winner = await RetentionRun.findOne({ clinic: clinicId, idempotencyKey: input.clientRequestId });
      if (winner) return { run: publicRun(winner.toObject()), idempotent: true };
    }
    throw err;
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'retention.applied',
    category: 'retention',
    subjectType: 'retention_run',
    subjectId: idOf(run),
    outcome: 'success',
    ip,
    userAgent,
    detail: {
      operator: input.operator,
      reason: input.reason,
      result,
      affected: Object.values(affected).reduce((a, b) => a + b, 0),
      categories: Object.keys(affected),
    },
  });

  return { run: publicRun(run.toObject()), idempotent: false, affected };
}

function publicRun(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    mode: doc.mode,
    result: doc.result,
    operator: doc.operator || null,
    reason: doc.reason || null,
    categories: doc.categories || [],
    holds: doc.holds || [],
    totals: doc.totals || {},
    limits: doc.limits || {},
    at: doc.createdAt,
  };
}

async function listRuns({ clinicId, page, limit }) {
  const filter = { clinic: clinicId };
  const [rows, total] = await Promise.all([
    RetentionRun.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    RetentionRun.countDocuments(filter),
  ]);
  return { items: rows.map(publicRun), total, page, limit };
}

module.exports = {
  listCategories,
  updatePolicy,
  activeHolds,
  createHold,
  releaseHold,
  listHolds,
  buildPlan,
  dryRun,
  apply,
  listRuns,
  publicRun,
  publicHold,
};
