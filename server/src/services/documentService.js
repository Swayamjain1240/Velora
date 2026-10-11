'use strict';

// Private discharge documents.
//
// Flow: authorize -> bounded body read -> isolated validation -> encrypted
// private storage -> metadata in MongoDB. MongoDB stores METADATA ONLY; the
// bytes live in encrypted storage addressed by an opaque UUID, and no public
// URL is ever recorded or returned.
//
// Atomicity limit (documented, and reconciled by scripts/reconcile-documents.js):
// the object write and the Mongo metadata update cannot be one transaction. We
// therefore insert metadata as `uploading` FIRST, then write the object, then
// finalize the status - a crash between the two leaves an `uploading` row that
// the reconciliation command detects and resolves.
const crypto = require('node:crypto');
const { errors } = require('./errors');
const audit = require('./auditService');
const storage = require('./documentStorage');
const validator = require('./documentValidator');
const episodeService = require('./episodeService');
const EpisodeDocument = require('../models/EpisodeDocument');

const DEDUP_LIVE = new Set(['uploading', 'ready', 'quarantined']);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// The ONLY shape a document may leave the server in. Never the storage key,
// never a path, never a URL.
function publicDocument(doc) {
  return {
    id: String(doc._id || doc.id),
    episode: String(doc.episode),
    filename: doc.originalFilename,
    mediaType: doc.mediaType,
    byteSize: doc.byteSize,
    sha256: doc.sha256,
    status: doc.status,
    rejectionCode: doc.rejectionCode || null,
    technical: doc.technical
      ? {
          pages: doc.technical.pages ?? null,
          width: doc.technical.width ?? null,
          height: doc.technical.height ?? null,
        }
      : null,
    // A `ready` document is technically accepted for later clinical review.
    // It is never clinically approved by this status.
    readyForReview: doc.status === 'ready',
    uploadedAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function technicalOf(result) {
  const technical = {};
  if (result.detail && result.detail.pages !== undefined) technical.pages = result.detail.pages;
  if (result.width !== undefined) technical.width = result.width;
  if (result.height !== undefined) technical.height = result.height;
  return technical;
}

function auditContext(ip, userAgent) {
  return { ip, userAgent };
}

// Validates bytes and returns the metadata row (new, reused, or a duplicate).
async function uploadDocument({
  clinicId,
  user,
  roleKey,
  episodeId,
  filename,
  declaredMediaType,
  bytes,
  ip,
  userAgent,
}) {
  // 1. Authorize BEFORE any bytes are persisted or read further.
  const first = await episodeService.assertEpisodeTeamWrite({ clinicId, user, episodeId, roleKey });

  const digest = sha256(bytes);

  // 2. Byte-level validation in the bounded worker.
  const verdict = await validator.validate(bytes, { filename, declaredMediaType });

  // 3. Duplicate short-circuit: byte-identical live upload returns the existing
  //    row without storing a second object.
  const existing = await EpisodeDocument.findOne({ episode: episodeId, sha256: digest });
  if (existing && DEDUP_LIVE.has(existing.status)) {
    return { document: publicDocument(existing), duplicate: true, created: false };
  }

  const storageKey = existing ? existing.storageKey : storage.newStorageKey();

  if (!verdict.ok) {
    // The request never described an acceptable document: refuse safely and
    // record nothing (no metadata row, no object).
    if (verdict.errorClass === 'invalid') throw verdict.error;
    if (verdict.errorClass === 'rejected') {
      // Structural rejection: record the reason, store NO bytes.
      const doc = await persistMetadata({
        existing,
        clinicId,
        patient: first.episode.patient,
        episodeId,
        storageKey,
        filename,
        mediaType: declaredMediaType,
        byteSize: bytes.length,
        sha256: digest,
        status: 'rejected',
        rejectionCode: verdict.code,
        technical: {},
        user,
      });
      await audit.record({
        clinic: clinicId,
        actorUser: user.id,
        actorLabel: user.email,
        action: 'document.rejected',
        targetType: 'episode_document',
        targetId: doc.id,
        outcome: 'failure',
        ...auditContext(ip, userAgent),
        detail: { code: verdict.code, mediaType: declaredMediaType, byteSize: bytes.length },
      });
      return { document: publicDocument(doc), created: true, rejected: true };
    }
    // Inconclusive (timeout/parser error): quarantine, do not fail the request.
    const quarantined = await persistQuarantine({
      existing,
      first,
      clinicId,
      episodeId,
      storageKey,
      filename,
      declaredMediaType,
      bytes,
      digest,
      code: verdict.code,
      user,
    });
    await audit.record({
      clinic: clinicId,
      actorUser: user.id,
      actorLabel: user.email,
      action: 'document.quarantined',
      targetType: 'episode_document',
      targetId: quarantined.id,
      outcome: 'success',
      ...auditContext(ip, userAgent),
      detail: { code: verdict.code, mediaType: declaredMediaType, byteSize: bytes.length },
    });
    return { document: publicDocument(quarantined), created: true, quarantined: true };
  }

  // 4. Re-check authorization immediately before persistence.
  await episodeService.assertEpisodeTeamWrite({ clinicId, user, episodeId, roleKey });

  // 5. Insert metadata (uploading), write the encrypted object, finalize.
  const doc = await persistMetadata({
    existing,
    clinicId,
    patient: first.episode.patient,
    episodeId,
    storageKey,
    filename: verdict.result.filename,
    mediaType: verdict.result.mediaType,
    byteSize: bytes.length,
    sha256: digest,
    status: 'uploading',
    rejectionCode: null,
    technical: technicalOf(verdict.result),
    user,
  });

  // A parallel insert race resolved to another request's row: it owns the
  // object, so this request must NOT write a second one.
  if (doc.storageKey !== storageKey) {
    return { document: publicDocument(doc), duplicate: true, created: false };
  }

  try {
    await storage.put(storageKey, bytes);
  } catch {
    // Never leak storage internals; mark the row failed so reconciliation and
    // the UI agree that no usable object exists.
    await markFailed(doc, clinicId, user, ip, userAgent);
    throw errors.internal('The document could not be stored. Please try again.');
  }

  doc.status = 'ready';
  await doc.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'document.uploaded',
    targetType: 'episode_document',
    targetId: doc.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    detail: {
      mediaType: doc.mediaType,
      byteSize: doc.byteSize,
      pages: doc.technical && doc.technical.pages,
    },
  });
  return { document: publicDocument(doc), created: true };
}

// Inserts or reuses the metadata row. A duplicate-key race resolves to the
// winner's row: the caller has not written any object yet, so nothing is orphaned.
async function persistMetadata(fields) {
  const { existing, ...data } = fields;
  const payload = {
    clinic: data.clinicId,
    patient: data.patient,
    episode: data.episodeId,
    storageKey: data.storageKey,
    originalFilename: data.filename,
    mediaType: data.mediaType,
    byteSize: data.byteSize,
    sha256: data.sha256,
    status: data.status,
    rejectionCode: data.rejectionCode || undefined,
    technical: data.technical || {},
    uploadedBy: data.user.id,
    uploadedByRole: 'staff',
  };

  if (existing) {
    Object.assign(existing, payload);
    return existing.save();
  }
  try {
    return await EpisodeDocument.create(payload);
  } catch (err) {
    if (err && err.code === 11000) {
      const winner = await EpisodeDocument.findOne({ episode: data.episodeId, sha256: data.sha256 });
      if (winner) return winner;
    }
    throw err;
  }
}

async function persistQuarantine(fields) {
  const { existing, first, clinicId, episodeId, storageKey, filename, declaredMediaType, bytes, digest, code, user } =
    fields;
  const doc = await persistMetadata({
    existing,
    clinicId,
    patient: first.episode.patient,
    episodeId,
    storageKey,
    filename,
    mediaType: declaredMediaType,
    byteSize: bytes.length,
    sha256: digest,
    status: 'uploading',
    rejectionCode: code,
    technical: {},
    user,
  });
  if (doc.storageKey !== storageKey) {
    // Lost a duplicate race: do not write a second object.
    return doc;
  }
  try {
    await storage.put(storageKey, bytes);
  } catch {
    await markFailed(doc, clinicId, user);
    throw errors.internal('The document could not be stored. Please try again.');
  }
  doc.status = 'quarantined';
  await doc.save();
  return doc;
}

async function markFailed(doc, clinicId, user, ip, userAgent) {
  try {
    doc.status = 'failed';
    await doc.save();
    await audit.record({
      clinic: clinicId,
      actorUser: user.id,
      actorLabel: user.email,
      action: 'document.failed',
      targetType: 'episode_document',
      targetId: doc.id,
      outcome: 'failure',
      ...auditContext(ip, userAgent),
      detail: {},
    });
  } catch {
    // Best effort: never mask the original failure.
  }
}

async function listDocuments({ clinicId, user, roleKey, episodeId, page, limit }) {
  await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  const filter = { clinic: clinicId, episode: episodeId };
  const [items, total] = await Promise.all([
    EpisodeDocument.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    EpisodeDocument.countDocuments(filter),
  ]);
  return { items: items.map(publicDocument), total, page, limit };
}

async function getDocument({ clinicId, user, roleKey, episodeId, documentId }) {
  await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  const doc = await EpisodeDocument.findOne({ _id: documentId, clinic: clinicId, episode: episodeId }).lean();
  if (!doc) throw errors.notFound('Document not found.');
  return publicDocument(doc);
}

// Fresh authorization, ready-only, decrypt, verify size AND checksum, audit.
async function downloadDocument({ clinicId, user, roleKey, episodeId, documentId, ip, userAgent }) {
  await episodeService.resolveClinicalAccess({ clinicId, user, episodeId, roleKey });
  const doc = await EpisodeDocument.findOne({ _id: documentId, clinic: clinicId, episode: episodeId });
  if (!doc) throw errors.notFound('Document not found.');
  if (doc.status !== 'ready') {
    // A quarantined/rejected/failed document can never be downloaded.
    throw errors.conflict('This document is not available for download.');
  }

  let bytes;
  try {
    bytes = await storage.get(doc.storageKey);
  } catch {
    // A missing object or tampered ciphertext is an integrity failure: fail
    // closed AND record the failed state so reconciliation and the UI agree.
    await markFailed(doc, clinicId, user, ip, userAgent);
    throw errors.internal('The document could not be read.');
  }

  const digest = sha256(bytes);
  if (bytes.length !== doc.byteSize || digest !== doc.sha256) {
    // The stored object no longer matches its metadata: fail closed.
    await markFailed(doc, clinicId, user, ip, userAgent);
    throw errors.internal('The document failed an integrity check.');
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'document.downloaded',
    targetType: 'episode_document',
    targetId: doc.id,
    outcome: 'success',
    ...auditContext(ip, userAgent),
    detail: { mediaType: doc.mediaType, byteSize: doc.byteSize },
  });

  return { document: publicDocument(doc), bytes };
}

module.exports = {
  publicDocument,
  uploadDocument,
  listDocuments,
  getDocument,
  downloadDocument,
  sha256,
};
