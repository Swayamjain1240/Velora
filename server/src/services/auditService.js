'use strict';

// Append-only audit trail (Part 9, VEL-020).
//
// The trail must cover sensitive reads/downloads, membership and role changes,
// caregiver grants, approvals, AI suggestion application, log and response
// writes, export/deletion requests and closure/reopen. It must NEVER record
// secrets, tokens, password material, raw clinical text or unnecessary PII
// (controls #9, #18, #19).
//
// Auditing must never break the primary request: a write failure is logged, not
// thrown. READING the trail is a separate, scoped, paginated search that
// re-derives which records the caller may see.
const AuditEvent = require('../models/AuditEvent');
const { errors } = require('./errors');
const { getEnv } = require('../config/env');

// Key names that must never reach the trail, whatever the caller passes.
const FORBIDDEN_KEYS = [
  'password',
  'passwordhash',
  'token',
  'tok enhash',
  'tokenhash',
  'secret',
  'csrf',
  'autorization',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'key',
  'uri',
  'connectionstring',
  'recoverycode',
  'recoverycodes',
  'otp',
  'totp',
  'salt',
  'hash',
  // Raw clinical text is never needed to audit an action.
  'originalwording',
  'rawtext',
  'clinicaltext',
  'messagebody',
  'answertext',
];

const FORBIDDEN = new Set(FORBIDDEN_KEYS);
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 40;

function isForbiddenKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (FORBIDDEN.has(normalized)) return true;
  // Substring guard catches `sessionToken`, `export_key`, `userPasswordHash`.
  return (
    normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('apikey') ||
    normalized.includes('csrf')
  );
}

// Bounded, redacting deep copy. Only primitives survive; anything forbidden is
// replaced by an explicit marker so the trail shows that a value was withheld
// rather than silently dropping the field.
function redactDetail(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[redacted: too deep]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => redactDetail(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    const entries = Object.entries(value).slice(0, MAX_KEYS);
    for (const [key, inner] of entries) {
      if (isForbiddenKey(key)) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = redactDetail(inner, depth + 1);
    }
    return out;
  }
  return '[redacted: unsupported]';
}

function publicEvent(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    clinic: doc.clinic ? String(doc.clinic) : null,
    actorUser: doc.actorUser ? String(doc.actorUser) : null,
    actorLabel: doc.actorLabel || null,
    actorRole: doc.actorRole || null,
    action: doc.action,
    category: doc.category || 'admin',
    subjectType: doc.subjectType || null,
    subjectId: doc.subjectId || null,
    targetType: doc.targetType || null,
    targetId: doc.targetId || null,
    purpose: doc.purpose || null,
    correlationId: doc.correlationId || null,
    outcome: doc.outcome,
    at: doc.createdAt,
    // The detail is already redacted at write time; it is shown as-is.
    detail: doc.detail || null,
  };
}

// Every existing sensitive action is categorised by its name, so the trail is
// searchable by category without editing every call site and a new call site is
// categorised by default rather than silently landing in `admin`.
const CATEGORY_RULES = Object.freeze([
  [/^privacy\.export\./, 'export'],
  [/^privacy\./, 'privacy_request'],
  [/^retention\./, 'retention'],
  [/^auth\./, 'auth'],
  [/^(staff|clinic)\./, 'membership'],
  [/^(caregiver|patient\.assignment)\./, 'caregiver_grant'],
  [/^care_plan\.approved$/, 'approval'],
  [/^care_plan\./, 'admin'],
  [/^extraction\./, 'ai_application'],
  [/^document\.downloaded$/, 'download'],
  [/^document\./, 'read'],
  [/^activity\./, 'log_write'],
  [/^checkin\./, 'checkin_response'],
  [/^clarification\./, 'clarification_response'],
  [/^episode\.(closed|reopened)$/, 'closure'],
]);

function inferCategory(action) {
  const value = String(action || '');
  for (const [pattern, category] of CATEGORY_RULES) {
    if (pattern.test(value)) return category;
  }
  return 'admin';
}

async function record(event) {
  try {
    await AuditEvent.create({
      clinic: event.clinic,
      actorUser: event.actorUser,
      actorLabel: event.actorLabel,
      actorRole: event.actorRole,
      action: event.action,
      category: event.category || inferCategory(event.action),
      subjectType: event.subjectType,
      subjectId: event.subjectId ? String(event.subjectId) : undefined,
      targetType: event.targetType,
      targetId: event.targetId ? String(event.targetId) : undefined,
      purpose: event.purpose,
      correlationId: event.correlationId,
      outcome: event.outcome,
      ip: event.ip,
      userAgent: event.userAgent ? String(event.userAgent).slice(0, 400) : undefined,
      detail: event.detail === undefined ? undefined : redactDetail(event.detail),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('audit record failed:', err.message);
  }
}

// A convenience wrapper for a sensitive READ or DOWNLOAD, which must be audited
// even though nothing changed.
function recordAccess({ category = 'read', ...event }) {
  return record({ ...event, category, outcome: event.outcome || 'success' });
}

// ---- scoped, paginated search ------------------------------------------------

function buildWindow({ from, to }) {
  const maxDays = getEnv().AUDIT_SEARCH_MAX_RANGE_DAYS;
  const now = new Date();
  const windowTo = to ? new Date(to) : now;
  if (Number.isNaN(windowTo.getTime())) throw errors.badRequest('Enter a valid end of the search window.');
  const defaultFrom = new Date(windowTo.getTime() - 30 * 24 * 60 * 60 * 1000);
  const windowFrom = from ? new Date(from) : defaultFrom;
  if (Number.isNaN(windowFrom.getTime())) throw errors.badRequest('Enter a valid start of the search window.');
  if (windowFrom > windowTo) throw errors.badRequest('The start of the search window is after its end.');
  const limitMs = maxDays * 24 * 60 * 60 * 1000;
  if (windowTo.getTime() - windowFrom.getTime() > limitMs) {
    throw errors.badRequest(`A search window may cover at most ${maxDays} days. Narrow it and try again.`);
  }
  return { from: windowFrom, to: windowTo };
}

// The audit trail is clinic-scoped and permission-gated. Reading it requires the
// dedicated `audit.read` permission, which only administration holds: a patient,
// caregiver or clinical caller never reaches this surface at all. The service
// re-checks the permission so the route is not the only guard.
async function search({ clinicId, rolePermissions, filters = {}, page = 1, limit = 25 }) {
  if (!rolePermissions || !rolePermissions.has('audit.read')) {
    throw errors.forbidden('The audit trail is not available to this role.');
  }

  const { from, to } = buildWindow(filters);
  const query = { clinic: clinicId, createdAt: { $gte: from, $lte: to } };
  if (filters.category) query.category = filters.category;
  if (filters.action) query.action = String(filters.action).slice(0, 120);
  if (filters.subjectType) query.subjectType = String(filters.subjectType).slice(0, 80);
  if (filters.subjectId) query.subjectId = String(filters.subjectId).slice(0, 120);
  if (filters.actorUser) query.actorUser = filters.actorUser;
  if (filters.outcome) query.outcome = filters.outcome;


  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    AuditEvent.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditEvent.countDocuments(query),
  ]);

  return {
    items: rows.map(publicEvent),
    total,
    page,
    limit,
    window: { from, to },
    note: 'Audit payloads are redacted at write time: no secrets, tokens or raw clinical text are stored or returned.',
    appliedFilters: {
      category: filters.category || null,
      action: filters.action || null,
      subjectType: filters.subjectType || null,
      subjectId: filters.subjectId || null,
      outcome: filters.outcome || null,
      actorUser: filters.actorUser ? String(filters.actorUser) : null,
    },
  };
}

module.exports = { record, recordAccess, search, redactDetail, publicEvent, inferCategory, CATEGORY_RULES };
