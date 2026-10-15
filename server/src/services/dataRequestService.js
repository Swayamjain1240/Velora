'use strict';

// Privacy requests: export, correction and deletion_request (Part 9, VEL-020).
//
// Design commitments:
//   * There is NO destructive endpoint. A deletion request is policy-evaluated
//     into a defensible record; nothing is destroyed.
//   * Identity is verified BEFORE a request is assigned or decided, and the
//     verifier is recorded.
//   * An export is generated asynchronously AFTER approval, stored ENCRYPTED with
//     its own key, expires automatically, and every download is freshly
//     authorized with a short-lived single-use token.
//   * Every transition appends to the request's own history and to the audit
//     trail, and payloads never carry clinical free text.
const fs = require('node:fs');
const { errors } = require('./errors');
const audit = require('./auditService');
const policy = require('../policies/dataRequestPolicy');
const exportStorage = require('./exportStorage');
const { hmac, randomToken } = require('./crypto');
const { getEnv } = require('../config/env');
const { ROLES, DATA_REQUEST_STATES } = require('../config/constants');
const DataRequest = require('../models/DataRequest');
const DataExport = require('../models/DataExport');
const ExportDownloadGrant = require('../models/ExportDownloadGrant');
const RetentionHold = require('../models/RetentionHold');
const PatientProfile = require('../models/PatientProfile');
const RecoveryEpisode = require('../models/RecoveryEpisode');
const CarePlanVersion = require('../models/CarePlanVersion');
const CarePlanItem = require('../models/CarePlanItem');
const ActivityLog = require('../models/ActivityLog');
const CheckInResponse = require('../models/CheckInResponse');
const ClarificationThread = require('../models/ClarificationThread');
const ClarificationMessage = require('../models/ClarificationMessage');
const Notification = require('../models/Notification');
const EpisodeClosure = require('../models/EpisodeClosure');
const FollowUpPlan = require('../models/FollowUpPlan');

const S = DATA_REQUEST_STATES;
const MANAGE = 'privacy.request.manage';
const EXPORT_ROW_LIMIT = 500;
const DOWNLOAD_HEADERS = {
  'Cache-Control': 'no-store, private, max-age=0',
  // A downloaded artifact is an attachment, never renderable HTML (control #7).
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

function idOf(value) {
  return value && value._id ? String(value._id) : value === null || value === undefined ? null : String(value);
}

function reference(prefix) {
  return `${prefix}-${randomToken(4).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}`;
}

function publicRequest(doc) {
  if (!doc) return null;
  return {
    id: idOf(doc),
    reference: doc.reference,
    kind: doc.kind,
    state: doc.state,
    patient: idOf(doc.patient),
    episode: idOf(doc.episode),
    requesterLabel: doc.requesterLabel || null,
    requesterRole: doc.requesterRole,
    detail: doc.detail,
    correction: doc.correction || null,
    identity: {
      status: doc.identity.status,
      method: doc.identity.method || null,
      verifiedAt: doc.identity.verifiedAt || null,
    },
    ownerUser: idOf(doc.ownerUser),
    ownerLabel: doc.ownerLabel || null,
    dueAt: doc.dueAt || null,
    decision: doc.decision.outcome
      ? {
          outcome: doc.decision.outcome,
          reason: doc.decision.reason || null,
          label: doc.decision.label || null,
          at: doc.decision.at || null,
        }
      : null,
    execution: {
      attemptedAt: doc.execution.attemptedAt || null,
      result: doc.execution.result || null,
      exportArtifact: idOf(doc.execution.exportArtifact),
      appliedCorrection: doc.execution.appliedCorrection || null,
      holds: doc.execution.holds || [],
      limited: Boolean(doc.execution.limited),
    },
    history: (doc.history || []).map((t) => ({
      action: t.action,
      from: t.from || null,
      to: t.to,
      actorLabel: t.actorLabel || null,
      note: t.note || null,
      at: t.at,
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ---- access ------------------------------------------------------------------

function isManager({ roleKey, permissions }) {
  if (roleKey === ROLES.ADMIN) return true;
  return Boolean(permissions && permissions.has(MANAGE));
}

// Who may see this request. A manager sees the clinic's requests; the requester
// and the assigned owner always see their own; nobody else does.
function canView({ doc, user, roleKey, permissions }) {
  if (isManager({ roleKey, permissions })) return true;
  if (String(doc.requesterUser) === String(user.id)) return true;
  if (doc.ownerUser && String(doc.ownerUser) === String(user.id)) return true;
  return false;
}

async function resolveSubject({ clinicId, user, roleKey, patientId }) {
  if (roleKey === ROLES.PATIENT) {
    const profile = await PatientProfile.findOne({ clinic: clinicId, linkedUserId: user.id }).lean();
    if (!profile) throw errors.forbidden('No patient record is linked to your account.');
    return profile;
  }
  if (roleKey === ROLES.CAREGIVER) {
    throw errors.forbidden('A caregiver cannot raise a privacy request directly.');
  }
  if (!patientId) throw errors.badRequest('Choose the patient this request is about.');
  const profile = await PatientProfile.findOne({ _id: patientId, clinic: clinicId }).lean();
  if (!profile) throw errors.notFound('Patient not found.');
  return profile;
}

// ---- create ------------------------------------------------------------------

async function createRequest({ clinicId, user, roleKey, permissions, input, ip, userAgent, now = new Date() }) {
  const profile = await resolveSubject({
    clinicId,
    user,
    roleKey,
    patientId: input.patientId,
  });

  let episode = null;
  if (input.episodeId) {
    episode = await RecoveryEpisode.findOne({ _id: input.episodeId, clinic: clinicId, patient: profile._id }).lean();
    if (!episode) throw errors.notFound('Episode not found for this patient.');
  }

  const doc = await DataRequest.create({
    clinic: clinicId,
    reference: reference('DR'),
    kind: input.kind,
    patient: profile._id,
    episode: episode ? episode._id : null,
    requesterUser: user.id,
    requesterLabel: user.email,
    requesterRole: roleKey,
    detail: input.detail,
    correction: input.kind === 'correction' ? input.correction : null,
    identity: { status: 'pending' },
    state: S.IDENTITY_PENDING,
    dueAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    history: [
      {
        action: 'created',
        to: S.IDENTITY_PENDING,
        actorUser: user.id,
        actorLabel: user.email,
        note: 'Request received. Identity verification is the next step.',
        at: now,
      },
    ],
  });

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: roleKey,
    action: 'privacy.request.created',
    category: 'privacy_request',
    subjectType: 'patient_profile',
    subjectId: idOf(profile),
    targetType: 'data_request',
    targetId: idOf(doc),
    outcome: 'success',
    ip,
    userAgent,
    detail: { kind: input.kind, reference: doc.reference, episode: episode ? idOf(episode) : null },
  });

  return { request: publicRequest(doc.toObject()), meanings: policy.meanings() };
}

// ---- transitions -------------------------------------------------------------

function requireTransition(doc, to) {
  if (!policy.canTransition(doc.state, to)) {
    throw errors.conflict(`A request in state "${doc.state}" cannot move to "${to}".`);
  }
}

async function loadForManagement({ clinicId, user, roleKey, permissions, requestId }) {
  const doc = await DataRequest.findOne({ _id: requestId, clinic: clinicId });
  if (!doc) throw errors.notFound('Privacy request not found.');
  if (!canView({ doc, user, roleKey, permissions })) throw errors.notFound('Privacy request not found.');
  return doc;
}

function pushHistory(doc, { action, from, to, user, note, at = new Date() }) {
  doc.history.push({
    action,
    from,
    to,
    actorUser: user.id,
    actorLabel: user.email,
    note,
    at,
  });
}

async function auditTransition({ doc, user, roleKey, action, outcome = 'success', ip, userAgent, detail }) {
  await audit.record({
    clinic: doc.clinic,
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: roleKey,
    action,
    category: 'privacy_request',
    subjectType: 'data_request',
    subjectId: idOf(doc),
    outcome,
    ip,
    userAgent,
    detail,
  });
}

async function verifyIdentity({ clinicId, user, roleKey, permissions, requestId, input, ip, userAgent, now = new Date() }) {
  if (!isManager({ roleKey, permissions })) throw errors.forbidden('Identity verification is an administrative step.');
  const doc = await loadForManagement({ clinicId, user, roleKey, permissions, requestId });
  requireTransition(doc, S.IDENTITY_VERIFIED);
  const from = doc.state;
  doc.identity = { status: 'verified', method: input.method, note: input.note, verifiedBy: user.id, verifiedAt: now };
  doc.state = S.IDENTITY_VERIFIED;
  pushHistory(doc, { action: 'identity_verified', from, to: doc.state, user, note: `Method: ${input.method}` });
  await doc.save();
  await auditTransition({ doc, user, roleKey, action: 'privacy.request.identity_verified', ip, userAgent, detail: { method: input.method } });
  return { request: publicRequest(doc.toObject()) };
}

async function assign({ clinicId, user, roleKey, permissions, requestId, input, ip, userAgent, now = new Date() }) {
  if (!isManager({ roleKey, permissions })) throw errors.forbidden('Assigning a privacy request is an administrative step.');
  const doc = await loadForManagement({ clinicId, user, roleKey, permissions, requestId });
  if (doc.identity.status !== 'verified') {
    throw errors.conflict('Verify the requester’s identity before assigning this request.');
  }
  requireTransition(doc, S.IN_REVIEW);
  const from = doc.state;
  const owner = await requireActiveMember({ clinicId, userId: input.ownerUserId });
  doc.ownerUser = input.ownerUserId;
  doc.ownerLabel = owner;
  doc.state = S.IN_REVIEW;
  pushHistory(doc, { action: 'assigned', from, to: doc.state, user, note: input.note });
  await doc.save();
  await auditTransition({ doc, user, roleKey, action: 'privacy.request.assigned', ip, userAgent, detail: { owner: owner } });
  return { request: publicRequest(doc.toObject()) };
}

async function requireActiveMember({ clinicId, userId }) {
  const ClinicMembership = require('../models/ClinicMembership');
  const membership = await ClinicMembership.findOne({ clinic: clinicId, user: userId, status: 'active' }).lean();
  if (!membership) throw errors.badRequest('That person is not an active member of this clinic.');
  const User = require('../models/User');
  const target = await User.findById(userId).lean();
  return (target && target.email) || 'member';
}

async function decide({ clinicId, user, roleKey, permissions, requestId, input, ip, userAgent, now = new Date() }) {
  if (!isManager({ roleKey, permissions })) throw errors.forbidden('Deciding a privacy request is an administrative step.');
  const doc = await loadForManagement({ clinicId, user, roleKey, permissions, requestId });
  if (doc.identity.status !== 'verified') throw errors.conflict('Verify the requester’s identity first.');
  const to = input.outcome === 'approved' ? S.APPROVED : S.DENIED;
  requireTransition(doc, to);
  const from = doc.state;
  doc.decision = {
    outcome: input.outcome,
    reason: input.reason,
    by: user.id,
    label: user.email,
    at: now,
  };
  doc.state = to;
  if (input.retentionNote) {
    doc.execution.holds = [{ category: 'deletion_request', reason: input.retentionNote }];
  }
  pushHistory(doc, { action: `decision_${input.outcome}`, from, to, user, note: input.reason });
  await doc.save();
  await auditTransition({
    doc,
    user,
    roleKey,
    action: `privacy.request.${input.outcome}`,
    ip,
    userAgent,
    detail: { reason: input.reason, kind: doc.kind },
  });
  return { request: publicRequest(doc.toObject()), meanings: policy.meanings() };
}

async function cancel({ clinicId, user, roleKey, permissions, requestId, input, ip, userAgent, now = new Date() }) {
  const doc = await loadForManagement({ clinicId, user, roleKey, permissions, requestId });
  const isRequester = String(doc.requesterUser) === String(user.id);
  if (!isRequester && !isManager({ roleKey, permissions })) throw errors.forbidden('Only the requester or an administrator may cancel.');
  requireTransition(doc, S.CANCELLED);
  const from = doc.state;
  doc.state = S.CANCELLED;
  pushHistory(doc, { action: 'cancelled', from, to: doc.state, user, note: input.reason });
  await doc.save();
  await auditTransition({ doc, user, roleKey, action: 'privacy.request.cancelled', ip, userAgent, detail: { reason: input.reason } });
  return { request: publicRequest(doc.toObject()) };
}

// ---- reads -------------------------------------------------------------------

async function listRequests({ clinicId, user, roleKey, permissions, page, limit, state, kind, mineOnly }) {
  const filter = { clinic: clinicId };
  if (state) filter.state = state;
  if (kind) filter.kind = kind;
  if (mineOnly) {
    filter.requesterUser = user.id;
  } else if (!isManager({ roleKey, permissions })) {
    filter.$or = [{ requesterUser: user.id }, { ownerUser: user.id }];
  }
  const [rows, total] = await Promise.all([
    DataRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    DataRequest.countDocuments(filter),
  ]);
  return { items: rows.map(publicRequest), total, page, limit, meanings: policy.meanings() };
}

async function getRequest({ clinicId, user, roleKey, permissions, requestId }) {
  const doc = await loadForManagement({ clinicId, user, roleKey, permissions, requestId });
  let artifact = null;
  if (doc.execution.exportArtifact) {
    const exportDoc = await DataExport.findById(doc.execution.exportArtifact).lean();
    if (exportDoc) {
      artifact = {
        id: idOf(exportDoc),
        byteLength: exportDoc.byteLength,
        contentHash: exportDoc.contentHash,
        generatedAt: exportDoc.generatedAt,
        expiresAt: exportDoc.expiresAt,
        expired: new Date(exportDoc.expiresAt) <= new Date(),
        revoked: Boolean(exportDoc.revokedAt),
        downloadCount: exportDoc.downloadCount,
        manifest: exportDoc.manifest || [],
      };
    }
  }
  return { request: publicRequest(doc.toObject()), export: artifact, meanings: policy.meanings() };
}

// ---- export bundle -----------------------------------------------------------

// A bounded, non-secret bundle of the records held for one patient. It never
// contains the patient's credentials, session material or a clinical
// interpretation.
async function buildExportBundle({ clinicId, patientId, reference: patientRef, now }) {
  const [patient, episodes] = await Promise.all([
    PatientProfile.findOne({ _id: patientId, clinic: clinicId }).lean(),
    RecoveryEpisode.find({ clinic: clinicId, patient: patientId }).sort({ createdAt: 1 }).limit(EXPORT_ROW_LIMIT).lean(),
  ]);
  if (!patient) throw errors.notFound('Patient not found for this export.');
  const episodeIds = episodes.map((e) => e._id);

  const [plans, logs, checkIns, threads, followUps, notifications, closures, holds] = await Promise.all([
    CarePlanVersion.find({ clinic: clinicId, patient: patientId }).sort({ version: 1 }).limit(EXPORT_ROW_LIMIT).lean(),
    ActivityLog.find({ clinic: clinicId, patient: patientId }).sort({ recordedAtUtc: 1 }).limit(EXPORT_ROW_LIMIT).lean(),
    CheckInResponse.find({ clinic: clinicId, patient: patientId }).sort({ dueAt: 1 }).limit(EXPORT_ROW_LIMIT).lean(),
    ClarificationThread.find({ clinic: clinicId, patient: patientId }).sort({ createdAt: 1 }).limit(EXPORT_ROW_LIMIT).lean(),
    FollowUpPlan.find({ clinic: clinicId, patient: patientId }).sort({ date: 1 }).limit(EXPORT_ROW_LIMIT).lean(),
    Notification.find({ clinic: clinicId, patient: patientId }).sort({ createdAt: 1 }).limit(EXPORT_ROW_LIMIT).lean(),
    EpisodeClosure.find({ clinic: clinicId, patient: patientId }).sort({ createdAt: 1 }).limit(EXPORT_ROW_LIMIT).lean(),
    RetentionHold.find({ clinic: clinicId, releasedAt: null }).lean(),
  ]);

  const planItems = await CarePlanItem.find({ planVersion: { $in: plans.map((p) => p._id) } })
    .limit(EXPORT_ROW_LIMIT * 4)
    .lean();
  const threadMessages = await ClarificationMessage.find({ thread: { $in: threads.map((t) => t._id) } })
    .limit(EXPORT_ROW_LIMIT * 4)
    .lean();

  const itemsByPlan = new Map();
  for (const item of planItems) {
    const key = idOf(item.planVersion);
    if (!itemsByPlan.has(key)) itemsByPlan.set(key, []);
    itemsByPlan.get(key).push({
      kind: item.kind,
      order: item.order,
      originalWording: item.originalWording,
      medication: item.medication || null,
      dose: item.dose || null,
      frequency: item.frequency || null,
      timing: item.timing || null,
      duration: item.duration || null,
    });
  }
  const messagesByThread = new Map();
  for (const message of threadMessages) {
    const key = idOf(message.thread);
    if (!messagesByThread.has(key)) messagesByThread.set(key, []);
    messagesByThread.get(key).push({
      kind: message.kind,
      body: message.body,
      authorRole: message.authorRole,
      at: message.at,
    });
  }

  return {
    format: 'velora.privacy-export/1',
    generatedAt: now.toISOString(),
    note: 'This export contains records Velora holds for one patient. It is not a clinical summary and carries no medical interpretation.',
    patient: {
      reference: patient.reference,
      fullName: patient.fullName,
      dateOfBirth: patient.dateOfBirth || null,
      contactEmail: patient.contactEmail || null,
      contactPhone: patient.contactPhone || null,
      status: patient.status,
    },
    episodes: episodes.map((e) => ({
      reference: e.reference,
      status: e.status,
      closureState: e.closureState || 'open',
      dischargeDate: e.dischargeDate,
      dischargeTimezone: e.dischargeTimezone,
      createdAt: e.createdAt,
    })),
    planVersions: plans.map((p) => ({
      version: p.version,
      state: p.state,
      title: p.title || null,
      summary: p.summary || null,
      approvedAt: p.approvedAt || null,
      items: itemsByPlan.get(idOf(p)) || [],
    })),
    activityLogs: logs.map((l) => ({
      entryState: l.entryState,
      occurrenceTimeUtc: l.occurrenceTimeUtc,
      recordedAtUtc: l.recordedAtUtc,
      actorRole: l.actorRole,
      selfReport: l.actorRole === 'patient' || l.actorRole === 'caregiver',
    })),
    checkIns: checkIns.map((c) => ({
      slotDate: c.slotDate,
      dueAt: c.dueAt,
      state: c.state,
      submittedAt: c.submittedAt || null,
      answers: (c.answers || []).map((a) => ({ questionId: a.questionId, kind: a.kind, value: a.value, values: a.values || null })),
    })),
    clarifications: threads.map((t) => ({
      kind: t.kind,
      subject: t.subject,
      state: t.state,
      createdAt: t.createdAt,
      messages: messagesByThread.get(idOf(t)) || [],
    })),
    followUps: followUps.map((f) => ({
      date: f.date,
      time: f.time || null,
      location: f.location,
      status: f.status,
    })),
    reminders: notifications.map((n) => ({
      kind: n.kind,
      channel: n.channel,
      state: n.state,
      localDate: n.localDate || null,
      acknowledgedAt: n.acknowledgedAt || null,
    })),
    closures: closures.map((c) => ({
      action: c.action,
      state: c.state,
      reason: c.reason,
      closureDate: c.closureDate || null,
      at: c.createdAt,
    })),
    retentionHolds: holds.map((h) => ({ category: h.category, scope: h.scope, reason: h.reason })),
    bounded: { rowLimitPerSection: EXPORT_ROW_LIMIT, episodes: episodeIds.length },
    patientReference: patientRef,
  };
}

async function generateExportArtifact({ clinicId, request, user, now }) {
  const bundle = await buildExportBundle({
    clinicId,
    patientId: request.patient,
    reference: request.reference,
    now,
  });
  const plaintext = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
  const max = getEnv().EXPORT_MAX_BYTES;
  if (plaintext.length > max) {
    throw errors.conflict(
      'This record is larger than the configured export limit, so it cannot be generated as one file.'
    );
  }
  const storageKey = exportStorage.newStorageKey();
  await exportStorage.put(storageKey, plaintext);
  const contentHash = require('node:crypto').createHash('sha256').update(plaintext).digest('hex');
  const ttlHours = getEnv().EXPORT_ARTIFACT_TTL_HOURS;
  const exportDoc = await DataExport.create({
    clinic: clinicId,
    request: request._id,
    patient: request.patient,
    storageKey,
    mediaType: 'application/json',
    byteLength: plaintext.length,
    contentHash,
    manifest: [
      { section: 'episodes', count: bundle.episodes.length },
      { section: 'planVersions', count: bundle.planVersions.length },
      { section: 'activityLogs', count: bundle.activityLogs.length },
      { section: 'checkIns', count: bundle.checkIns.length },
      { section: 'clarifications', count: bundle.clarifications.length },
      { section: 'followUps', count: bundle.followUps.length },
      { section: 'reminders', count: bundle.reminders.length },
      { section: 'closures', count: bundle.closures.length },
    ],
    generatedBy: user.id,
    generatedAt: now,
    expiresAt: new Date(now.getTime() + ttlHours * 60 * 60 * 1000),
  });
  return exportDoc;
}

// ---- execution ---------------------------------------------------------------

const CORRECTION_FIELDS = Object.freeze(['fullName', 'contactEmail', 'contactPhone']);

function assertCorrectionValue(field, value) {
  const v = String(value).trim();
  if (field === 'contactEmail' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
    throw errors.badRequest('The corrected email address is not valid.');
  }
  if (field === 'contactPhone' && !/^[0-9+()\-\s]{3,40}$/.test(v)) {
    throw errors.badRequest('The corrected phone number is not valid.');
  }
  return field === 'contactEmail' ? v.toLowerCase() : v;
}

async function evaluateDeletion({ clinicId, request }) {
  const EpisodeDocument = require('../models/EpisodeDocument');
  const [documents, closedEpisodes, logs, holds] = await Promise.all([
    EpisodeDocument.countDocuments({ clinic: clinicId, patient: request.patient }),
    RecoveryEpisode.countDocuments({ clinic: clinicId, patient: request.patient, status: 'closed' }),
    ActivityLog.countDocuments({ clinic: clinicId, patient: request.patient }),
    RetentionHold.find({
      clinic: clinicId,
      releasedAt: null,
      $or: [{ scope: 'category' }, { scope: 'subject', subjectId: idOf(request.patient) }],
    }).lean(),
  ]);
  const eligible = documents + closedEpisodes + logs;
  const outcome = policy.deletionOutcome({ eligible, held: holds.length, reportOnly: true });
  return {
    ...outcome,
    evidence: {
      documents,
      closedEpisodes,
      activityLogs: logs,
      holds: holds.map((h) => ({ category: h.category, scope: h.scope, reason: h.reason })),
      destructiveActionPerformed: false,
    },
  };
}

async function execute({ clinicId, user, roleKey, permissions, requestId, input, ip, userAgent, now = new Date() }) {
  if (!isManager({ roleKey, permissions })) throw errors.forbidden('Executing a privacy request is an administrative step.');
  const doc = await loadForManagement({ clinicId, user, roleKey, permissions, requestId });
  if (doc.kind === 'deletion_request' && input.acknowledgeNoDestruction !== true) {
    throw errors.badRequest(
      'A deletion request is evaluated against retention, not instantly applied. Confirm that you understand no destructive deletion is performed.'
    );
  }
  requireTransition(doc, S.EXECUTING);
  const from = doc.state;
  doc.state = S.EXECUTING;
  doc.execution.attemptedAt = now;
  pushHistory(doc, { action: 'executing', from, to: doc.state, user });
  await doc.save();

  try {
    if (doc.kind === 'export') {
      const artifact = await generateExportArtifact({ clinicId, request: doc, user, now });
      doc.execution.exportArtifact = artifact._id;
      doc.execution.result = `Encrypted export generated (${artifact.byteLength} bytes). It expires at ${artifact.expiresAt.toISOString()} and each download needs a fresh authorization.`;
      doc.state = S.COMPLETED;
    } else if (doc.kind === 'correction') {
      const field = doc.correction && doc.correction.field;
      if (!CORRECTION_FIELDS.includes(field)) {
        throw errors.badRequest('That field cannot be corrected automatically.');
      }
      const current = await PatientProfile.findById(doc.patient).lean();
      const to = assertCorrectionValue(field, doc.correction.newValue);
      const fromValue = current ? current[field] || null : null;
      const update = {};
      update[field] = to;
      await PatientProfile.updateOne({ _id: doc.patient, clinic: clinicId }, { $set: update });
      doc.execution.appliedCorrection = { field, from: fromValue, to };
      doc.execution.result = `Corrected ${field}.`;
      doc.state = S.COMPLETED;
    } else {
      const evaluated = await evaluateDeletion({ clinicId, request: doc });
      doc.execution.holds = evaluated.evidence.holds;
      doc.execution.limited = evaluated.limited;
      doc.execution.result = evaluated.result;
      doc.state = evaluated.state;
    }
  } catch (err) {
    doc.state = S.FAILED;
    doc.execution.result = err && err.status ? err.message : 'The request could not be completed.';
  }

  pushHistory(doc, { action: 'executed', from: S.EXECUTING, to: doc.state, user, note: doc.execution.result });
  await doc.save();

  await auditTransition({
    doc,
    user,
    roleKey,
    action: 'privacy.request.executed',
    outcome: doc.state === S.FAILED ? 'failure' : 'success',
    ip,
    userAgent,
    detail: { kind: doc.kind, result: doc.execution.result, limited: doc.execution.limited },
  });
  return { request: publicRequest(doc.toObject()) };
}

// ---- export download ---------------------------------------------------------

async function revokeExport({ clinicId, user, roleKey, permissions, requestId, input, ip, userAgent, now = new Date() }) {
  if (!isManager({ roleKey, permissions })) throw errors.forbidden('Revoking an export is an administrative step.');
  const doc = await loadForManagement({ clinicId, user, roleKey, permissions, requestId });
  const artifact = await DataExport.findOne({ request: doc._id, clinic: clinicId });
  if (!artifact) throw errors.notFound('This request has no generated export.');
  artifact.revokedAt = now;
  artifact.revokedReason = input.reason;
  await artifact.save();
  await auditTransition({ doc, user, roleKey, action: 'privacy.export.revoked', ip, userAgent, detail: { reason: input.reason } });
  return { request: publicRequest(doc.toObject()), revoked: true };
}

// Fresh authorization: a short-lived single-use token is minted at download time
// for the person who is about to download, and only its hash is stored.
async function authorizeExportDownload({ clinicId, user, roleKey, permissions, requestId, input, ip, userAgent, now = new Date() }) {
  const doc = await loadForManagement({ clinicId, user, roleKey, permissions, requestId });
  const isRequester = String(doc.requesterUser) === String(user.id);
  if (!isRequester && !isManager({ roleKey, permissions })) {
    throw errors.forbidden('Only the requester or an administrator may download this export.');
  }
  if (!doc.execution.exportArtifact) throw errors.conflict('This request has no generated export to download.');
  const artifact = await DataExport.findById(doc.execution.exportArtifact).lean();
  if (!artifact || artifact.revokedAt) throw errors.conflict('This export has been revoked.');
  if (new Date(artifact.expiresAt) <= now) throw errors.conflict('This export has expired.');

  const token = randomToken(32);
  const ttlMinutes = getEnv().EXPORT_DOWNLOAD_TTL_MINUTES;
  const grant = await ExportDownloadGrant.create({
    clinic: clinicId,
    export: artifact._id,
    request: doc._id,
    tokenHash: hmac(token),
    issuedTo: user.id,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
    ip,
  });
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: roleKey,
    action: 'privacy.export.authorized',
    category: 'export',
    subjectType: 'data_request',
    subjectId: idOf(doc),
    purpose: input.purpose,
    outcome: 'success',
    ip,
    userAgent,
    detail: { expiresAt: grant.expiresAt.toISOString() },
  });
  return {
    token,
    expiresAt: grant.expiresAt,
    note: 'This download link is short-lived and can be used once. It is freshly authorized and audited.',
  };
}

async function downloadExport({ clinicId, user, roleKey, permissions, requestId, token, ip, userAgent, now = new Date() }) {
  const grant = await ExportDownloadGrant.findOne({ clinic: clinicId, request: requestId, tokenHash: hmac(token) });
  if (!grant) throw errors.notFound('That download link is not valid.');
  if (String(grant.issuedTo) !== String(user.id)) throw errors.forbidden('That download link was issued to someone else.');
  if (grant.usedAt) throw errors.conflict('That download link has already been used.');
  if (new Date(grant.expiresAt) <= now) throw errors.conflict('That download link has expired.');

  const artifact = await DataExport.findOne({ _id: grant.export, clinic: clinicId });
  if (!artifact || artifact.revokedAt) throw errors.conflict('This export has been revoked.');
  if (new Date(artifact.expiresAt) <= now) throw errors.conflict('This export has expired.');

  const bytes = await exportStorage.get(artifact.storageKey);
  grant.usedAt = now;
  await grant.save();
  artifact.downloadCount += 1;
  await artifact.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    actorRole: roleKey,
    action: 'privacy.export.downloaded',
    category: 'download',
    subjectType: 'data_request',
    subjectId: String(requestId),
    outcome: 'success',
    ip,
    userAgent,
    detail: { bytes: bytes.length, hash: artifact.contentHash },
  });

  return {
    bytes,
    filename: `velora-export-${idOf(artifact)}.json`,
    mediaType: 'application/json',
    headers: DOWNLOAD_HEADERS,
    contentHash: artifact.contentHash,
  };
}

module.exports = {
  STATES: S,
  publicRequest,
  isManager,
  canView,
  createRequest,
  verifyIdentity,
  assign,
  decide,
  cancel,
  listRequests,
  getRequest,
  execute,
  revokeExport,
  authorizeExportDownload,
  downloadExport,
  buildExportBundle,
  DOWNLOAD_HEADERS,
};
