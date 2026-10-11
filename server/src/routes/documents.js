'use strict';

// Private discharge documents for one recovery episode. Every handler resolves
// the caller's access in the service; upload additionally authorizes BEFORE the
// request body is read, and the raw body is streamed under a hard byte cap.
const express = require('express');
const documentController = require('../controllers/documentController');
const { boundedBody } = require('../middleware/boundedBody');
const { requireDocumentUploadAccess } = require('../middleware/documentAccess');
const { uploadLimit, downloadLimit, readLimit } = require('../middleware/documentLimits');
const { validate } = require('../middleware/validate');
const { requireAuth, loadClinicContext } = require('../middleware/auth');
const schemas = require('../validators/schemas');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

router.post(
  '/:episodeId/documents',
  validate({ params: schemas.episodeIdParam }),
  uploadLimit,
  // Authorization happens HERE, before boundedBody reads a single byte.
  requireDocumentUploadAccess,
  boundedBody(),
  documentController.uploadDocument
);

router.get(
  '/:episodeId/documents',
  readLimit,
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  documentController.listDocuments
);

router.get(
  '/:episodeId/documents/:documentId',
  readLimit,
  validate({ params: schemas.documentParams }),
  documentController.getDocument
);

router.get(
  '/:episodeId/documents/:documentId/download',
  downloadLimit,
  validate({ params: schemas.documentParams }),
  documentController.downloadDocument
);

module.exports = router;
