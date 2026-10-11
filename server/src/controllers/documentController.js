'use strict';

const documentService = require('../services/documentService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  // Document responses are private and must never be cached or indexed.
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

// RFC 5987 / RFC 6266 attachment disposition. The ORIGINAL filename is only
// ever delivered in the download response, never in a URL, a query string or a
// routine log line.
function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// HTTP headers are latin-1, so the browser percent-encodes the display filename
// in `X-Document-Filename`. Decoding here keeps the original name intact - it is
// never placed in the URL, a query string or a routine log line.
function headerFilename(req) {
  const raw = req.get('x-document-filename') || '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed encoding is passed through unchanged; the validator rejects a
    // filename it cannot accept (BAD_FILENAME) instead of guessing.
    return raw;
  }
}

async function uploadDocument(req, res, next) {
  try {
    const filename = headerFilename(req);
    const declaredMediaType = req.get('content-type');
    if (!req.fileBytes || req.fileBytes.length === 0) {
      res.setHeader('Cache-Control', 'no-store, private, max-age=0');
      return res.status(400).json({
        error: { code: 'EMPTY', message: 'The file is empty.' },
      });
    }
    const result = await documentService.uploadDocument({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      filename,
      declaredMediaType,
      bytes: req.fileBytes,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({
      document: result.document,
      duplicate: Boolean(result.duplicate),
    });
  } catch (err) {
    return next(err);
  }
}

async function listDocuments(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await documentService.listDocuments({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function getDocument(req, res, next) {
  try {
    const document = await documentService.getDocument({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      documentId: req.params.documentId,
    });
    noStore(res);
    return res.json({ document });
  } catch (err) {
    return next(err);
  }
}

async function downloadDocument(req, res, next) {
  try {
    const { document, bytes } = await documentService.downloadDocument({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      documentId: req.params.documentId,
      ...auditContext(req),
    });
    noStore(res);
    // Force a download and neutralise any inline rendering (control #7, #11).
    res.setHeader('Content-Type', document.mediaType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', contentDisposition(document.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    return res.status(200).send(bytes);
  } catch (err) {
    return next(err);
  }
}

module.exports = { uploadDocument, listDocuments, getDocument, downloadDocument };
