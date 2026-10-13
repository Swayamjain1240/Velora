'use strict';

// AI-assisted extraction service (Part 6).
//
// The service treats the model as an UNTRUSTED drafting tool. A provider can
// produce SUGGESTIONS and nothing else: it cannot approve, publish, prescribe,
// change clinical state, activate a task or send a reminder. Applying a
// suggestion is a SEPARATE, actor-attributed draft edit performed through the
// ordinary Part 5 draft service, so AI-proposed content gets exactly the same
// authority checks, revision guards, audit trail and clinical review as
// hand-typed content.
//
// Reliability is explicit and bounded: one job per identical request
// (deduplication), a terminal job is never re-run (idempotency), attempts are
// bounded with a deterministic backoff, every attempt is recorded as a ModelRun,
// and every failure ends with a stable code the UI can show - while the manual
// workflow keeps working regardless.
const crypto = require('node:crypto');
const { errors } = require('./errors');
const audit = require('./auditService');
const episodeService = require('./episodeService');
const carePlanService = require('./carePlanService');
const documentStorage = require('./documentStorage');
const documentValidator = require('./documentValidator');
const policy = require('../policies/extractionPolicy');
const providers = require('../providers/extractionProvider');
const { getEnv } = require('../config/env');
const ExtractionJob = require('../models/ExtractionJob');
const DraftSuggestion = require('../models/DraftSuggestion');
const ExtractedField = require('../models/ExtractedField');
const SourceCitation = require('../models/SourceCitation');
const ModelRun = require('../models/ModelRun');
const EpisodeDocument = require('../models/EpisodeDocument');
const CarePlanVersion = require('../models/CarePlanVersion');

const { JOB_STATES, SUGGESTION_STATES, FIELD_STATES } = policy;

// Safe, stable failure codes. A provider's own error text, a prompt, source text
// or a stack trace never reaches a client (control #9).
const JOB_ERROR_CODES = Object.freeze({
  NO_TEXT_LAYER: 'NO_TEXT_LAYER',
  TEXT_LAYER_TIMEOUT: 'TEXT_LAYER_TIMEOUT',
  TEXT_LAYER_ERROR: 'TEXT_LAYER_ERROR',
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  NO_SUGGESTIONS: 'NO_SUGGESTIONS',
  STALE_DRAFT: 'STALE_DRAFT',
});

const JOB_ERROR_MESSAGES = Object.freeze({
  [JOB_ERROR_CODES.NO_TEXT_LAYER]:
    'This document has no readable text layer, so it must be drafted by hand.',
  [JOB_ERROR_CODES.TEXT_LAYER_TIMEOUT]:
    'Reading the document text took too long. Draft this plan by hand.',
  [JOB_ERROR_CODES.TEXT_LAYER_ERROR]:
    'The document text could not be read. Draft this plan by hand.',
  [JOB_ERROR_CODES.PROVIDER_DISABLED]:
    'AI-assisted extraction is not enabled. Draft this plan by hand.',
  [JOB_ERROR_CODES.PROVIDER_ERROR]:
    'The extraction provider failed. Draft this plan by hand.',
  [JOB_ERROR_CODES.PROVIDER_TIMEOUT]:
    'The extraction provider timed out. Draft this plan by hand.',
  [JOB_ERROR_CODES.INVALID_OUTPUT]:
    'The extraction provider returned output that failed validation. Draft this plan by hand.',
  [JOB_ERROR_CODES.NO_SUGGESTIONS]:
    'The extraction provider produced no usable suggestion. Draft this plan by hand.',
  [JOB_ERROR_CODES.STALE_DRAFT]: 'The draft changed after this job was created.',
});

// Accepts a document, a lean document, a plain projection (which exposes `id`)
// or a raw id, so an audit detail can never record "[object Object]".
function idOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return String(value._id || value.id);
  return String(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function auditContext(ip, userAgent) {
  return { ip, userAgent };
}

// ---- public projections -----------------------------------------------------

function publicJob(job, documentFilename = null) {
  if (!job) return null;
  return {
    id: idOf(job),
    episode: idOf(job.episode),
    document: idOf(job.document),
    documentFilename: documentFilename || job.documentFilename || null,
    version: idOf(job.version),
    targetRevision: job.targetRevision,
    state: job.state,
    provider: job.provider,
    model: job.model || null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    suggestionCount: job.suggestionCount || 0,
    rejectedCount: job.rejectedCount || 0,
    unresolvedCount: job.unresolvedCount || 0,
    injectionSignalCount: job.injectionSignalCount || 0,
    // Page/line/pattern LABEL only - never the matching document text.
    injectionSignals: (job.injectionSignals || []).map((signal) => ({
      page: signal.page,
      line: signal.line,
      label: signal.label,
    })),
    inputChars: job.inputChars || 0,
    inputTruncated: Boolean(job.inputTruncated),
    pages: job.pages || [],
    // A stable code plus a safe sentence. Never a provider diagnostic.
    errorCode: job.errorCode || null,
    errorMessage: job.errorCode ? JOB_ERROR_MESSAGES[job.errorCode] || null : null,
    latencyMs: job.latencyMs ?? null,
    createdByLabel: job.createdByLabel || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    cancelledAt: job.cancelledAt || null,
    terminal: policy.TERMINAL_JOB_STATES.includes(job.state),
    // The manual workflow is available at every point of the lifecycle.
    manualFallbackAvailable: true,
  };
}

function publicField(field) {
  return {
    field: field.field,
    value: field.value || null,
    state: field.state,
    claimedMissing: Boolean(field.claimedMissing),
    claimedConflict: Boolean(field.claimedConflict),
    confidence: field.confidence ?? null,
    evidenceText: field.evidenceText || null,
    reasonCode: field.reasonCode || null,
    citation: field.citation ? idOf(field.citation) : null,
  };
}

function publicCitation(citation) {
  return {
    id: idOf(citation),
    document: idOf(citation.document),
    documentFilename: citation.documentFilename || null,
    documentMediaType: citation.documentMediaType || null,
    page: citation.page || null,
    location: citation.location || null,
    text: citation.text,
    verified: Boolean(citation.verified),
  };
}

function publicSuggestion(suggestion, fields = [], citations = []) {
  return {
    id: idOf(suggestion),
    job: idOf(suggestion.job),
    version: idOf(suggestion.version),
    order: suggestion.order,
    kind: suggestion.kind,
    // The wording the model quoted, preserved verbatim.
    originalWording: suggestion.originalWording,
    // The proposed value per field, with the SERVER's state for each.
    fields: fields.map(publicField),
    // Blocking issues versus what the document simply did not state.
    unresolvedFields: suggestion.unresolvedFields || [],
    missingFields: suggestion.missingFields || [],
    // A short map the UI uses to pre-fill the manual editor.
    proposed: Object.fromEntries(
      fields.filter((field) => field.value).map((field) => [field.field, field.value])
    ),
    confidence: suggestion.confidence ?? null,
    citationCount: suggestion.citationCount || 0,
    citations: citations.map(publicCitation),
    injectionSuspected: Boolean(suggestion.injectionSuspected),
    state: suggestion.state,
    needsReview: Boolean(suggestion.needsReview),
    appliedItem: suggestion.appliedItem ? idOf(suggestion.appliedItem) : null,
    appliedAt: suggestion.appliedAt || null,
    appliedByLabel: suggestion.appliedByLabel || null,
    dismissedAt: suggestion.dismissedAt || null,
    dismissedByLabel: suggestion.dismissedByLabel || null,
    dismissReason: suggestion.dismissReason || null,
    createdAt: suggestion.createdAt,
  };
}

function publicModelRun(run) {
  return {
    id: idOf(run),
    attempt: run.attempt,
    provider: run.provider,
    model: run.model || null,
    network: Boolean(run.network),
    status: run.status,
    code: run.code || null,
    latencyMs: run.latencyMs ?? null,
    inputChars: run.inputChars ?? null,
    outputBytes: run.outputBytes ?? null,
    suggestionCount: run.suggestionCount ?? null,
    usage: run.usage
      ? {
          promptTokens: run.usage.promptTokens ?? null,
          completionTokens: run.usage.completionTokens ?? null,
          totalTokens: run.usage.totalTokens ?? null,
        }
      : null,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
  };
}

// ---- access -----------------------------------------------------------------

// Drafting authority, re-derived from the database: activity + assignment on a
// draft episode + the permission the route already checked. An AI job is a
// DRAFTING action, so it uses exactly the drafting authority - never review or
// approval authority.
async function resolveDraftAuthority({ clinicId, user, episodeId, roleKey }) {
  return carePlanService.assertCoordinatorWrite({ clinicId, user, episodeId, roleKey });
}

// Reads require ordinary team access (the same rule the Part 5 version
// workspace uses); a patient or caregiver is refused here, never silently.
async function resolveTeamRead({ clinicId, user, episodeId, roleKey }) {
  const resolved = await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  if (resolved.access !== 'team') {
    throw errors.forbidden('Only the assigned care team can read extraction jobs.');
  }
  return resolved;
}

// Rule 1: the job belongs to ONE authorized ready document of this episode.
async function loadReadyDocument({ clinicId, episodeId, documentId }) {
  const document = await EpisodeDocument.findOne({
    _id: documentId,
    clinic: clinicId,
    episode: episodeId,
  }).lean();
  if (!document) throw errors.notFound('Source document not found.');
  if (document.status !== 'ready') {
    throw errors.conflict('Only a ready document can be extracted.');
  }
  return document;
}

// Rule 2: the job targets a draft (unapproved, still editable) version.
async function loadDraftVersion({ clinicId, episodeId, versionId }) {
  const version = await CarePlanVersion.findOne({
    _id: versionId,
    clinic: clinicId,
    episode: episodeId,
  });
  if (!version) throw errors.notFound('Care plan not found.');
  if (!policy.JOB_TRACKS_STATE(version.state)) {
    throw errors.conflict(
      'AI suggestions can only target a draft or clarified plan version, never an approved one.'
    );
  }
  return version;
}

// ---- job creation -----------------------------------------------------------

function dedupeKeyFor({ clinicId, document, version, provider, model }) {
  return sha256(
    [
      'extraction-job',
      idOf(clinicId),
      idOf(document._id),
      document.sha256,
      idOf(version._id),
      version.revision,
      provider.name,
      model || provider.defaultModel || '',
    ].join('|')
  );
}

async function createJob({ clinicId, user, episodeId, roleKey, documentId, versionId, ip, userAgent }) {
  await resolveDraftAuthority({ clinicId, user, episodeId, roleKey });
  const document = await loadReadyDocument({ clinicId, episodeId, documentId });
  const version = await loadDraftVersion({ clinicId, episodeId, versionId });

  const provider = providers.activeProvider();
  const model = provider.defaultModel || null;
  const limits = policy.limitsFromEnv(getEnv());
  const dedupeKey = dedupeKeyFor({ clinicId, document, version, provider, model });

  const existing = await ExtractionJob.findOne({ dedupeKey }).lean();
  if (existing) {
    // Deduplication: an identical request never creates a second job, so a
    // double-clicked button or a retried request cannot multiply provider calls.
    return { job: publicJob(existing, document.originalFilename), deduplicated: true };
  }

  let created;
  try {
    created = await ExtractionJob.create({
      clinic: clinicId,
      patient: document.patient,
      episode: episodeId,
      document: document._id,
      documentSha256: document.sha256,
      version: version._id,
      targetRevision: version.revision,
      state: JOB_STATES.QUEUED,
      provider: provider.name,
      model,
      dedupeKey,
      maxAttempts: limits.maxRetries + 1,
      limits: {
        maxInputChars: limits.maxInputChars,
        maxOutputBytes: limits.maxOutputBytes,
        timeoutMs: limits.timeoutMs,
        maxSuggestions: limits.maxSuggestions,
      },
      createdBy: user.id,
      createdByLabel: user.email,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Lost a race with an identical request: return the winner, never a duplicate.
      const winner = await ExtractionJob.findOne({ dedupeKey }).lean();
      if (winner) return { job: publicJob(winner, document.originalFilename), deduplicated: true };
    }
    throw err;
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'extraction.job_created',
    targetType: 'extraction_job',
    targetId: created.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    // No prompt, no document text, no model output: identity and limits only.
    detail: {
      provider: provider.name,
      network: Boolean(provider.network),
      targetRevision: version.revision,
      maxAttempts: limits.maxRetries + 1,
    },
  });

  return {
    job: publicJob(created.toObject ? created.toObject() : created, document.originalFilename),
    deduplicated: false,
  };
}

// ---- running ----------------------------------------------------------------

// One provider call under a wall-clock limit. The provider is a pure function of
// text in, JSON out; it never receives a database handle, a mutation helper or
// any credential beyond what its own adapter needs.
async function callProvider(provider, input) {
  const startedAt = new Date();
  const begin = Date.now();
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __timeout: true }), input.timeoutMs);
    });
    const result = await Promise.race([provider.extract(input), timeout]);
    if (result && result.__timeout) {
      return { ok: false, code: JOB_ERROR_CODES.PROVIDER_TIMEOUT, latencyMs: Date.now() - begin, startedAt };
    }
    return { ok: true, result, latencyMs: Date.now() - begin, startedAt };
  } catch (err) {
    const disabled = Boolean(err && err.code === 'EXTRACTION_DISABLED');
    return {
      ok: false,
      code: disabled ? JOB_ERROR_CODES.PROVIDER_DISABLED : JOB_ERROR_CODES.PROVIDER_ERROR,
      latencyMs: Date.now() - begin,
      startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

// Records the outcome of one attempt without ever storing the prompt or the raw
// response (fingerprints only).
async function recordRun({ job, attempt, provider, inputFingerprint, call, checked, raw }) {
  const outputBytes = raw === undefined ? undefined : Buffer.byteLength(String(raw || ''), 'utf8');
  await ModelRun.create({
    clinic: job.clinic,
    patient: job.patient,
    episode: job.episode,
    job: job._id,
    version: job.version,
    attempt,
    provider: provider.name,
    model: job.model,
    network: Boolean(provider.network),
    status: !call.ok ? (call.code === JOB_ERROR_CODES.PROVIDER_TIMEOUT ? 'timeout' : 'failed') : checked && !checked.ok ? 'invalid' : 'succeeded',
    code: call.ok ? (checked && !checked.ok ? checked.code : undefined) : call.code,
    requestFingerprint: inputFingerprint,
    responseFingerprint: call.ok ? sha256(raw) : undefined,
    latencyMs: call.latencyMs,
    inputChars: job.inputChars,
    outputBytes: call.ok ? (checked && checked.ok ? checked.bytes : outputBytes) : undefined,
    suggestionCount: call.ok && checked && checked.ok ? checked.value.suggestions.length : undefined,
    usage: call.ok && call.result.usage ? call.result.usage : undefined,
    startedAt: call.startedAt,
    finishedAt: new Date(),
  });
}

// Persists one validated suggestion with its per-field rows and verified
// citations.
async function persistSuggestion({ job, order, classified, citations, document }) {
  const suggestion = await DraftSuggestion.create({
    clinic: job.clinic,
    patient: job.patient,
    episode: job.episode,
    version: job.version,
    job: job._id,
    order,
    kind: classified.kind,
    originalWording: classified.originalWording,
    unresolvedFields: classified.unresolvedFields,
    missingFields: classified.missingFields,
    fieldStates: policy.classificationForFieldNames(classified.fields),
    confidence: classified.confidence,
    citationCount: citations.length,
    injectionSuspected: Boolean(classified.injectionSuspected),
    state: classified.needsReview ? SUGGESTION_STATES.NEEDS_REVIEW : SUGGESTION_STATES.PROPOSED,
    needsReview: classified.needsReview,
  });

  const citationDocs = await SourceCitation.insertMany(
    citations.map((citation) => ({
      clinic: job.clinic,
      patient: job.patient,
      episode: job.episode,
      version: job.version,
      job: job._id,
      suggestion: suggestion._id,
      document: job.document,
      documentFilename: document.originalFilename,
      documentMediaType: document.mediaType,
      documentSha256: job.documentSha256,
      page: citation.page,
      location: citation.location,
      text: citation.text,
      verified: true,
      verifiedAt: new Date(),
    }))
  );

  // Each field points at the citation that actually supports it, so a reviewer
  // can see the evidence next to the value.
  const byText = new Map(citationDocs.map((doc) => [doc.text, doc]));
  const fieldDocs = Object.values(classified.fields).map((field) => {
    const anchor = field.evidenceText ? byText.get(field.evidenceText) : null;
    return {
      clinic: job.clinic,
      patient: job.patient,
      episode: job.episode,
      version: job.version,
      job: job._id,
      suggestion: suggestion._id,
      field: field.field,
      value: field.value,
      state: field.state,
      claimedMissing: field.claimedMissing,
      claimedConflict: field.claimedConflict,
      confidence: classified.confidence,
      evidenceText: field.evidenceText || null,
      citation: anchor ? anchor._id : null,
      reasonCode: field.reasonCode || null,
    };
  });
  if (fieldDocs.length) await ExtractedField.insertMany(fieldDocs);

  return suggestion;
}

// Runs a queued job. Idempotent: a terminal job is returned as-is instead of
// being run again, so a retried request cannot duplicate suggestions.
async function runJob({ clinicId, user, episodeId, roleKey, jobId, ip, userAgent }) {
  await resolveDraftAuthority({ clinicId, user, episodeId, roleKey });
  const job = await ExtractionJob.findOne({ _id: jobId, clinic: clinicId, episode: episodeId });
  if (!job) throw errors.notFound('Extraction job not found.');

  if (policy.TERMINAL_JOB_STATES.includes(job.state)) {
    // Idempotent retry: the same terminal job, no second provider call.
    return { job: publicJob(job), idempotent: true };
  }
  if (job.state === JOB_STATES.RUNNING) {
    throw errors.conflict('This extraction job is already running.');
  }

  // Re-check the target draft revision BEFORE starting: a job created against an
  // older revision must not write into a draft that has moved on.
  const version = await CarePlanVersion.findOne({
    _id: job.version,
    clinic: clinicId,
    episode: episodeId,
  });
  if (!version) throw errors.notFound('Care plan not found.');
  if (!policy.JOB_TRACKS_STATE(version.state)) {
    throw errors.conflict('AI suggestions can only target a draft or clarified plan version.');
  }
  if (version.revision !== job.targetRevision) {
    job.state = JOB_STATES.FAILED;
    job.errorCode = JOB_ERROR_CODES.STALE_DRAFT;
    job.finishedAt = new Date();
    await job.save();
    throw errors.conflict('The draft changed after this job was created. Start a new extraction job.');
  }

  const claimed = await ExtractionJob.findOneAndUpdate(
    { _id: job._id, clinic: clinicId, state: JOB_STATES.QUEUED },
    { $set: { state: JOB_STATES.RUNNING, startedAt: new Date() } },
    { new: true }
  );
  if (!claimed) throw errors.conflict('This extraction job is already running.');

  const provider = providers.activeProvider();
  const limits = {
    maxInputChars: claimed.limits?.maxInputChars ?? policy.LIMIT_DEFAULTS.maxInputChars,
    maxOutputBytes: claimed.limits?.maxOutputBytes ?? policy.LIMIT_DEFAULTS.maxOutputBytes,
    timeoutMs: claimed.limits?.timeoutMs ?? policy.LIMIT_DEFAULTS.timeoutMs,
    maxSuggestions: claimed.limits?.maxSuggestions ?? policy.LIMIT_DEFAULTS.maxSuggestions,
  };

  const failWith = async (code) => {
    claimed.state = JOB_STATES.FAILED;
    claimed.errorCode = code;
    claimed.finishedAt = new Date();
    await claimed.save();
    await audit.record({
      clinic: clinicId,
      actorUser: user.id,
      actorLabel: user.email,
      action: 'extraction.job_failed',
      targetType: 'extraction_job',
      targetId: claimed.id,
      outcome: 'failure',
      ...auditContext(ip, userAgent),
      detail: { provider: provider.name, code },
    });
    return { job: publicJob(claimed.toObject()), idempotent: false };
  };

  const document = await EpisodeDocument.findOne({
    _id: claimed.document,
    clinic: clinicId,
    episode: episodeId,
  }).lean();
  if (!document || document.status !== 'ready') {
    return failWith(JOB_ERROR_CODES.TEXT_LAYER_ERROR);
  }

  // 1. Read the text layer of the stored bytes. The bytes are parsed in the
  //    isolated worker; only stable codes come back.
  let bytes;
  try {
    bytes = await documentStorage.get(document.storageKey);
  } catch {
    return failWith(JOB_ERROR_CODES.TEXT_LAYER_ERROR);
  }
  const textLayer = await documentValidator.extractTextLayer(bytes, {
    mediaType: document.mediaType,
    maxChars: limits.maxInputChars,
  });
  if (!textLayer.ok) {
    return failWith(
      textLayer.code === 'NO_TEXT_LAYER'
        ? JOB_ERROR_CODES.NO_TEXT_LAYER
        : textLayer.code === 'TEXT_LAYER_TIMEOUT'
          ? JOB_ERROR_CODES.TEXT_LAYER_TIMEOUT
          : JOB_ERROR_CODES.TEXT_LAYER_ERROR
    );
  }

  // 2. Build the minimum-necessary, delimiter-quoted input and look for attempts
  //    to talk to the model. Detection raises a warning; it never changes data.
  const built = policy.buildModelInput({ pages: textLayer.pages, maxChars: limits.maxInputChars });
  const injectionSignals = policy.detectInjectionSignals(textLayer.pages);
  const inputFingerprint = sha256(built.text);

  claimed.inputChars = built.text.length;
  claimed.inputTruncated = built.truncated;
  claimed.pages = textLayer.pages.map((page) => page.page);
  claimed.injectionSignals = injectionSignals;
  claimed.injectionSignalCount = injectionSignals.length;
  claimed.inputFingerprint = inputFingerprint;
  await claimed.save();

  // 3. Bounded attempts. Every attempt is recorded as a ModelRun.
  let validated = null;
  let lastCode = JOB_ERROR_CODES.INVALID_OUTPUT;
  for (let attempt = claimed.attempts + 1; attempt <= claimed.maxAttempts; attempt += 1) {
    if (attempt > claimed.attempts + 1) await wait(policy.retryDelayMs(attempt - 1));
    // eslint-disable-next-line no-await-in-loop
    const call = await callProvider(provider, {
      text: built.text,
      pages: textLayer.pages,
      maxOutputBytes: limits.maxOutputBytes,
      timeoutMs: limits.timeoutMs,
      model: claimed.model,
    });
    const checked = call.ok
      ? policy.validateModelOutput(call.result.raw, { maxOutputBytes: limits.maxOutputBytes })
      : null;
    // eslint-disable-next-line no-await-in-loop
    await recordRun({
      job: claimed,
      attempt,
      provider,
      inputFingerprint,
      call,
      checked,
      raw: call.ok ? call.result.raw : undefined,
    });
    claimed.attempts = attempt;
    // eslint-disable-next-line no-await-in-loop
    await claimed.save();

    if (!call.ok) {
      lastCode = call.code;
      continue;
    }
    if (!checked.ok) {
      lastCode = JOB_ERROR_CODES.INVALID_OUTPUT;
      continue;
    }
    validated = checked.value;
    break;
  }

  if (!validated) return failWith(lastCode);

  // 4. Citation verification and classification, then persistence. A suggestion
  //    whose citation cannot be verified is REJECTED, never silently kept.
  const persisted = [];
  let rejected = 0;
  let order = 1;
  for (const suggestion of validated.suggestions) {
    const citationCheck = policy.verifyCitations(suggestion.citations, textLayer.pages);
    if (!citationCheck.ok) {
      rejected += 1;
      continue;
    }
    const citations = citationCheck.citations.map((citation) => ({
      ...citation,
      documentFilename: document.originalFilename,
      documentMediaType: document.mediaType,
    }));
    // A suggestion whose OWN supporting text carries an injection signal can
    // never be presented as a clean one-click accept.
    const injected = citations.some(
      (citation) => policy.detectInjectionSignals([{ page: citation.page, text: citation.text }]).length > 0
    );
    const classified = policy.classifySuggestion(suggestion, { injected });
    classified.injectionSuspected = injected;
    for (const field of Object.values(classified.fields)) {
      const anchor =
        (field.value && citations.find((citation) => policy.appearsInText(field.value, [citation.text]))) ||
        citations[0];
      field.evidenceText = anchor ? anchor.text : null;
      field.reasonCode =
        field.state === FIELD_STATES.MISSING
          ? 'not_stated_in_source'
          : field.state === FIELD_STATES.CONFLICTING
            ? 'conflicting_source_text'
            : field.state === FIELD_STATES.UNRESOLVED
              ? 'value_not_supported_by_citation'
              : null;
    }
    // eslint-disable-next-line no-await-in-loop
    const created = await persistSuggestion({ job: claimed, order, classified, citations, document });
    persisted.push(created);
    order += 1;
  }

  claimed.rejectedCount = rejected;
  if (!persisted.length) {
    await claimed.save();
    return failWith(JOB_ERROR_CODES.NO_SUGGESTIONS);
  }

  const unresolvedCount = persisted.filter((suggestion) => suggestion.unresolvedFields.length > 0).length;
  const outcome = policy.jobOutcome({
    suggestions: persisted.map((suggestion) => ({
      needsReview: suggestion.needsReview,
      unresolvedFields: suggestion.unresolvedFields,
    })),
    injectionSignals,
  });

  claimed.state = outcome;
  claimed.suggestionCount = persisted.length;
  claimed.unresolvedCount = unresolvedCount;
  claimed.finishedAt = new Date();
  claimed.latencyMs = claimed.startedAt ? claimed.finishedAt - claimed.startedAt : null;
  await claimed.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'extraction.job_completed',
    targetType: 'extraction_job',
    targetId: claimed.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    // Counts and identity only: never the document text or model output.
    detail: {
      provider: provider.name,
      network: Boolean(provider.network),
      state: outcome,
      suggestions: persisted.length,
      rejected,
      unresolved: unresolvedCount,
      injectionSignals: injectionSignals.length,
    },
  });

  return { job: publicJob(claimed.toObject(), document.originalFilename), idempotent: false };
}

// ---- reads ------------------------------------------------------------------

async function listJobs({ clinicId, user, episodeId, roleKey, page, limit }) {
  await resolveTeamRead({ clinicId, user, episodeId, roleKey });
  const filter = { clinic: clinicId, episode: episodeId };
  const [rows, total] = await Promise.all([
    ExtractionJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ExtractionJob.countDocuments(filter),
  ]);
  const documents = await EpisodeDocument.find({ _id: { $in: rows.map((row) => row.document) } })
    .select('originalFilename')
    .lean();
  const nameById = new Map(documents.map((doc) => [idOf(doc), doc.originalFilename]));
  return {
    items: rows.map((row) => publicJob(row, nameById.get(idOf(row.document)) || null)),
    total,
    page,
    limit,
  };
}

async function getJob({ clinicId, user, episodeId, roleKey, jobId }) {
  await resolveTeamRead({ clinicId, user, episodeId, roleKey });
  const job = await ExtractionJob.findOne({ _id: jobId, clinic: clinicId, episode: episodeId }).lean();
  if (!job) throw errors.notFound('Extraction job not found.');
  const [document, runs, counts] = await Promise.all([
    EpisodeDocument.findOne({ _id: job.document }).select('originalFilename').lean(),
    ModelRun.find({ job: job._id }).sort({ attempt: 1 }).lean(),
    DraftSuggestion.aggregate([{ $match: { job: job._id } }, { $group: { _id: '$state', count: { $sum: 1 } } }]),
  ]);
  const version = await CarePlanVersion.findOne({ _id: job.version }).select('state revision').lean();
  return {
    job: publicJob(job, document ? document.originalFilename : null),
    planState: version ? version.state : null,
    planRevision: version ? version.revision : null,
    modelRuns: runs.map(publicModelRun),
    suggestionCounts: Object.fromEntries(counts.map((row) => [row._id, row.count])),
  };
}

async function cancelJob({ clinicId, user, episodeId, roleKey, jobId, ip, userAgent }) {
  await resolveDraftAuthority({ clinicId, user, episodeId, roleKey });
  const job = await ExtractionJob.findOne({ _id: jobId, clinic: clinicId, episode: episodeId });
  if (!job) throw errors.notFound('Extraction job not found.');
  if (policy.TERMINAL_JOB_STATES.includes(job.state)) {
    return { job: publicJob(job), idempotent: true };
  }
  if (!policy.assertJobTransition(job.state, JOB_STATES.CANCELLED)) {
    throw errors.conflict('This extraction job cannot be cancelled now.');
  }
  job.state = JOB_STATES.CANCELLED;
  job.cancelledBy = user.id;
  job.cancelledAt = new Date();
  job.finishedAt = new Date();
  await job.save();
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'extraction.job_cancelled',
    targetType: 'extraction_job',
    targetId: job.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    detail: { provider: job.provider },
  });
  return { job: publicJob(job.toObject()), idempotent: false };
}

async function listSuggestions({ clinicId, user, episodeId, roleKey, jobId, page, limit }) {
  await resolveTeamRead({ clinicId, user, episodeId, roleKey });
  const job = await ExtractionJob.findOne({ _id: jobId, clinic: clinicId, episode: episodeId }).lean();
  if (!job) throw errors.notFound('Extraction job not found.');

  const filter = { job: job._id, clinic: clinicId };
  const [rows, total, version] = await Promise.all([
    DraftSuggestion.find(filter).sort({ order: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    DraftSuggestion.countDocuments(filter),
    CarePlanVersion.findOne({ _id: job.version }).select('revision state').lean(),
  ]);
  const ids = rows.map((row) => row._id);
  const [fields, citations] = await Promise.all([
    ExtractedField.find({ suggestion: { $in: ids } }).sort({ field: 1 }).lean(),
    SourceCitation.find({ suggestion: { $in: ids } }).sort({ page: 1, createdAt: 1 }).lean(),
  ]);
  const fieldsBy = new Map();
  for (const field of fields) {
    const key = idOf(field.suggestion);
    if (!fieldsBy.has(key)) fieldsBy.set(key, []);
    fieldsBy.get(key).push(field);
  }
  const citationsBy = new Map();
  for (const citation of citations) {
    const key = idOf(citation.suggestion);
    if (!citationsBy.has(key)) citationsBy.set(key, []);
    citationsBy.get(key).push(citation);
  }

  return {
    items: rows.map((row) =>
      publicSuggestion(row, fieldsBy.get(idOf(row)) || [], citationsBy.get(idOf(row)) || [])
    ),
    total,
    page,
    limit,
    // The revision the client must send when applying, so an apply is always
    // guarded by the draft revision the coordinator is looking at.
    planRevision: version ? version.revision : null,
    planState: version ? version.state : null,
  };
}

// ---- applying and dismissing ------------------------------------------------

// Applying a suggestion is a SEPARATE, actor-attributed draft edit: it goes
// through the ordinary Part 5 draft service, so the same assignment checks, the
// same revision guard, the same computed unresolved fields and the same audit
// trail apply. The coordinator may override any suggested value with what they
// actually accept (`fields`), which is what makes the AI a drafting aid rather
// than a source of truth.
async function applySuggestion({
  clinicId,
  user,
  episodeId,
  roleKey,
  jobId,
  suggestionId,
  expectedRevision,
  fields,
  ip,
  userAgent,
}) {
  await resolveDraftAuthority({ clinicId, user, episodeId, roleKey });
  const job = await ExtractionJob.findOne({ _id: jobId, clinic: clinicId, episode: episodeId }).lean();
  if (!job) throw errors.notFound('Extraction job not found.');
  const suggestion = await DraftSuggestion.findOne({
    _id: suggestionId,
    job: job._id,
    clinic: clinicId,
  });
  if (!suggestion) throw errors.notFound('Suggestion not found.');
  if (suggestion.state === SUGGESTION_STATES.APPLIED) {
    // Idempotent: one suggestion can never create a second item.
    const [fieldRows, citations] = await Promise.all([
      ExtractedField.find({ suggestion: suggestion._id }).lean(),
      SourceCitation.find({ suggestion: suggestion._id }).lean(),
    ]);
    return { suggestion: publicSuggestion(suggestion.toObject(), fieldRows, citations), idempotent: true };
  }
  if (suggestion.state === SUGGESTION_STATES.DISMISSED) {
    throw errors.conflict('This suggestion was dismissed.');
  }

  // Re-check the target draft revision BEFORE applying.
  const version = await CarePlanVersion.findOne({ _id: job.version, clinic: clinicId, episode: episodeId });
  if (!version) throw errors.notFound('Care plan not found.');
  if (!policy.JOB_TRACKS_STATE(version.state)) {
    throw errors.conflict('An approved plan version cannot receive AI suggestions.');
  }
  if (version.revision !== expectedRevision) {
    throw errors.conflict('Your copy is out of date. Reload the plan and try again.');
  }

  const [fieldRows, citations] = await Promise.all([
    ExtractedField.find({ suggestion: suggestion._id }).lean(),
    SourceCitation.find({ suggestion: suggestion._id }).lean(),
  ]);
  if (!citations.length) throw errors.conflict('This suggestion has no verifiable source.');

  // The FINAL values: the coordinator's accepted values win; a field they did not
  // supply falls back to the suggestion, and nothing is invented.
  const proposed = {};
  for (const row of fieldRows) {
    if (row.value) proposed[row.field] = row.value;
  }
  const accepted = { ...proposed, ...(fields || {}) };

  // A. The draft edit itself (Part 5 authority, revision guard, audit, review).
  const item = await carePlanService.addItem({
    clinicId,
    user,
    episodeId,
    roleKey,
    planId: idOf(version),
    expectedRevision,
    data: {
      kind: suggestion.kind,
      originalWording: suggestion.originalWording,
      ...accepted,
    },
    ip,
    userAgent,
  });

  // B. Cite the same evidence the suggestion cited, now as an ordinary
  //    SourceReference on the created item - so AI-proposed content carries the
  //    same traceable origin as hand-typed content. Each link bumps the draft
  //    revision, so the current revision is re-read immediately before it.
  for (const citation of citations) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await CarePlanVersion.findOne({ _id: version._id }).select('revision').lean();
    // eslint-disable-next-line no-await-in-loop
    await carePlanService.linkSource({
      clinicId,
      user,
      episodeId,
      roleKey,
      planId: idOf(version),
      itemId: item.id,
      expectedRevision: fresh.revision,
      data: {
        documentId: idOf(citation.document),
        text: citation.text,
        page: citation.page,
        location: citation.location,
      },
      ip,
      userAgent,
    });
  }

  suggestion.state = SUGGESTION_STATES.APPLIED;
  suggestion.appliedItem = item.id;
  suggestion.appliedRevision = expectedRevision;
  suggestion.appliedBy = user.id;
  suggestion.appliedByLabel = user.email;
  suggestion.appliedAt = new Date();
  await suggestion.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'extraction.suggestion_applied',
    targetType: 'draft_suggestion',
    targetId: suggestion.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    // The resulting item and the fact a human accepted it - never the clinical text.
    detail: {
      job: idOf(job),
      // `item` is the Part 5 projection, which exposes `id`.
      item: idOf(item),
      provider: job.provider,
      overriddenFields: fields ? Object.keys(fields).sort() : [],
      revision: expectedRevision,
    },
  });

  return {
    suggestion: publicSuggestion(suggestion.toObject(), fieldRows, citations),
    item,
    idempotent: false,
  };
}

async function dismissSuggestion({
  clinicId,
  user,
  episodeId,
  roleKey,
  jobId,
  suggestionId,
  reason,
  ip,
  userAgent,
}) {
  await resolveDraftAuthority({ clinicId, user, episodeId, roleKey });
  const job = await ExtractionJob.findOne({ _id: jobId, clinic: clinicId, episode: episodeId }).lean();
  if (!job) throw errors.notFound('Extraction job not found.');
  const suggestion = await DraftSuggestion.findOne({
    _id: suggestionId,
    job: job._id,
    clinic: clinicId,
  });
  if (!suggestion) throw errors.notFound('Suggestion not found.');
  if (suggestion.state === SUGGESTION_STATES.APPLIED) {
    throw errors.conflict('An applied suggestion cannot be dismissed.');
  }
  if (suggestion.state === SUGGESTION_STATES.DISMISSED) {
    return { suggestion: publicSuggestion(suggestion.toObject(), [], []), idempotent: true };
  }
  suggestion.state = SUGGESTION_STATES.DISMISSED;
  suggestion.dismissedBy = user.id;
  suggestion.dismissedByLabel = user.email;
  suggestion.dismissedAt = new Date();
  suggestion.dismissReason = reason;
  await suggestion.save();
  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'extraction.suggestion_dismissed',
    targetType: 'draft_suggestion',
    targetId: suggestion.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    detail: { job: idOf(job), provider: job.provider },
  });
  const [fieldRows, citations] = await Promise.all([
    ExtractedField.find({ suggestion: suggestion._id }).lean(),
    SourceCitation.find({ suggestion: suggestion._id }).lean(),
  ]);
  return { suggestion: publicSuggestion(suggestion.toObject(), fieldRows, citations), idempotent: false };
}

module.exports = {
  JOB_ERROR_CODES,
  JOB_ERROR_MESSAGES,
  publicJob,
  publicSuggestion,
  publicModelRun,
  publicCitation,
  createJob,
  runJob,
  listJobs,
  getJob,
  cancelJob,
  listSuggestions,
  applySuggestion,
  dismissSuggestion,
  resolveDraftAuthority,
  resolveTeamRead,
};
