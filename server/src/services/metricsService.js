'use strict';

// Operational workflow metrics (Part 9, VEL-021).
//
// These are durations and counts about the COORDINATION PROCESS, nothing else.
// The service cannot compute clinical success, adherence or readmission: there is
// no such input, and every definition carries an explicit "not a measure of"
// statement so a reader cannot mistake a duration for a clinical outcome.
const { errors } = require('./errors');
const dashboardService = require('./dashboardService');
const { METRIC_DEFINITIONS, METRICS_NO_CLINICAL_INFERENCE, QUEUE_KEYS } = require('../config/constants');
const CarePlanVersion = require('../models/CarePlanVersion');
const ClarificationThread = require('../models/ClarificationThread');
const QueueAssignment = require('../models/QueueAssignment');

const HOUR_MS = 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

function buildWindow({ from, to }) {
  const now = new Date();
  const end = to ? new Date(to) : now;
  if (Number.isNaN(end.getTime())) throw errors.badRequest('Enter a valid end of the metrics window.');
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * HOUR_MS);
  if (Number.isNaN(start.getTime())) throw errors.badRequest('Enter a valid start of the metrics window.');
  if (start > end) throw errors.badRequest('The start of the metrics window is after its end.');
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 24 * HOUR_MS) {
    throw errors.badRequest(`A metrics window may cover at most ${MAX_RANGE_DAYS} days.`);
  }
  return { from: start, to: end };
}

function hoursBetween(a, b) {
  if (!a || !b) return null;
  const value = (new Date(b).getTime() - new Date(a).getTime()) / HOUR_MS;
  return value < 0 ? null : value;
}

function summarise(durations) {
  const values = durations.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return { count: 0, averageHours: null, medianHours: null, maxHours: null };
  const sum = values.reduce((a, b) => a + b, 0);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return {
    count: values.length,
    averageHours: Number((sum / values.length).toFixed(2)),
    medianHours: Number(median.toFixed(2)),
    maxHours: Number(values[values.length - 1].toFixed(2)),
  };
}

function describe(key, value) {
  const definition = METRIC_DEFINITIONS[key];
  return { key, ...definition, value };
}

async function approvalTime({ clinicId, from, to }) {
  const versions = await CarePlanVersion.find({
    clinic: clinicId,
    submittedAt: { $gte: from, $lte: to },
  })
    .select('submittedAt approvedAt clarificationAt')
    .lean();
  const durations = versions.map((v) =>
    v.approvedAt ? hoursBetween(v.submittedAt, v.approvedAt) : hoursBetween(v.submittedAt, v.clarificationAt)
  );
  const decisions = versions.filter((v) => v.approvedAt || v.clarificationAt).length;
  return describe('approval_time', { ...summarise(durations), decisions });
}

async function clarificationResponseTime({ clinicId, from, to }) {
  const threads = await ClarificationThread.find({
    clinic: clinicId,
    createdAt: { $gte: from, $lte: to },
  })
    .select('createdAt answeredAt')
    .lean();
  const durations = threads.map((t) => hoursBetween(t.createdAt, t.answeredAt));
  return describe('clarification_response_time', {
    ...summarise(durations),
    answered: threads.filter((t) => t.answeredAt).length,
  });
}

// Age of the OLDEST still-open item in each queue, scoped to the caller's own
// assignments by the dashboard service, so this is never a clinic-wide number.
async function queueAge({ clinicId, user, roleKey, now }) {
  const out = {};
  let scopeNote = null;
  for (const queueKey of dashboardService.QUEUES) {
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await dashboardService.queue({
        clinicId,
        user,
        roleKey,
        queueKey,
        page: 1,
        limit: 25,
        mineOnly: false,
      });
    } catch (err) {
      // A caller with no assigned clinical queue scope (for example an
      // administrator) sees an empty panel rather than a failed metrics call.
      scopeNote = 'Queue age is shown only for a caller with active care-team assignments.';
      result = { items: [], total: 0 };
    }
    const stamps = (result.items || [])
      .map((item) => item.since || item.createdAt || null)
      .filter(Boolean)
      .map((value) => new Date(value).getTime());
    out[queueKey] = stamps.length
      ? { openItems: result.total ?? stamps.length, oldestHours: Number(((now.getTime() - Math.min(...stamps)) / HOUR_MS).toFixed(2)) }
      : { openItems: result.total ?? 0, oldestHours: null };
  }
  return describe('queue_age', { queues: out, countedQueues: Object.keys(QUEUE_KEYS).length, scopeNote });
}

async function coordinationWorkload({ clinicId, from, to }) {
  const rows = await QueueAssignment.aggregate([
    { $match: { clinic: require('mongoose').Types.ObjectId.createFromHexString(String(clinicId)) } },
    {
      $group: {
        _id: '$assigneeUser',
        label: { $first: '$assigneeLabel' },
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
        released: { $sum: { $cond: [{ $eq: ['$status', 'released'] }, 1, 0] } },
        inWindow: {
          $sum: { $cond: [{ $and: [{ $gte: ['$assignedAt', from] }, { $lte: ['$assignedAt', to] }] }, 1, 0] },
        },
      },
    },
    { $sort: { total: -1 } },
    { $limit: 50 },
  ]);
  return describe('coordination_workload', {
    members: rows.map((r) => ({
      member: String(r._id),
      label: r.label || null,
      total: r.total,
      active: r.active,
      released: r.released,
      claimedInWindow: r.inWindow,
    })),
  });
}

async function overview({ clinicId, user, roleKey, from, to, now = new Date() }) {
  const window = buildWindow({ from, to });
  const [approval, clarification, ages, workload] = await Promise.all([
    approvalTime({ clinicId, from: window.from, to: window.to }),
    clarificationResponseTime({ clinicId, from: window.from, to: window.to }),
    queueAge({ clinicId, user, roleKey, now }),
    coordinationWorkload({ clinicId, from: window.from, to: window.to }),
  ]);
  return {
    window,
    metrics: [approval, clarification, ages, workload],
    definitions: METRIC_DEFINITIONS,
    note: METRICS_NO_CLINICAL_INFERENCE,
    clinicianNote:
      'Queue age is scoped to your own active assignments. It is a workload fact, not a judgement about any patient.',
  };
}

module.exports = { overview, approvalTime, clarificationResponseTime, queueAge, coordinationWorkload, buildWindow };
