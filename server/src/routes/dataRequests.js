'use strict';

// Privacy requests (Part 9). A patient may raise a request about their OWN data;
// an administrator verifies identity, assigns, decides and executes. There is no
// destructive endpoint: deletion is evaluated, never instantly applied, and an
// export download is freshly authorized with a short-lived single-use token.
const express = require('express');
const dataRequestController = require('../controllers/dataRequestController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const readLimit = mongoRateLimit({
  keyPrefix: 'privacy-read',
  limit: 300,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const writeLimit = mongoRateLimit({
  keyPrefix: 'privacy-write',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
// Downloads get their own tighter budget (control #8).
const downloadLimit = mongoRateLimit({
  keyPrefix: 'privacy-download',
  limit: 30,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.post(
  '/',
  writeLimit,
  requirePermission(PERMISSIONS.PRIVACY_REQUEST_CREATE),
  validate({ body: schemas.createDataRequestSchema }),
  dataRequestController.create
);

router.get('/', readLimit, validate({ query: schemas.dataRequestQuery }), dataRequestController.list);

router.get(
  '/:requestId',
  readLimit,
  validate({ params: schemas.dataRequestParams }),
  dataRequestController.detail
);

router.post(
  '/:requestId/identity',
  writeLimit,
  requirePermission(PERMISSIONS.PRIVACY_REQUEST_MANAGE),
  validate({ params: schemas.dataRequestParams, body: schemas.verifyIdentitySchema }),
  dataRequestController.verifyIdentity
);

router.post(
  '/:requestId/assign',
  writeLimit,
  requirePermission(PERMISSIONS.PRIVACY_REQUEST_MANAGE),
  validate({ params: schemas.dataRequestParams, body: schemas.assignDataRequestSchema }),
  dataRequestController.assign
);

router.post(
  '/:requestId/decide',
  writeLimit,
  requirePermission(PERMISSIONS.PRIVACY_REQUEST_MANAGE),
  validate({ params: schemas.dataRequestParams, body: schemas.decideDataRequestSchema }),
  dataRequestController.decide
);

router.post(
  '/:requestId/execute',
  writeLimit,
  requirePermission(PERMISSIONS.PRIVACY_REQUEST_MANAGE),
  validate({ params: schemas.dataRequestParams, body: schemas.executeDataRequestSchema }),
  dataRequestController.execute
);

router.post(
  '/:requestId/revoke-export',
  writeLimit,
  requirePermission(PERMISSIONS.PRIVACY_REQUEST_MANAGE),
  validate({ params: schemas.dataRequestParams, body: schemas.revokeExportSchema }),
  dataRequestController.revokeExport
);

router.post(
  '/:requestId/export/authorize',
  downloadLimit,
  validate({ params: schemas.dataRequestParams, body: schemas.authorizeExportSchema }),
  dataRequestController.authorizeExport
);

router.get(
  '/:requestId/export/download',
  downloadLimit,
  validate({ params: schemas.dataRequestParams, query: schemas.exportDownloadQuery }),
  dataRequestController.downloadExport
);

router.post(
  '/:requestId/cancel',
  writeLimit,
  validate({ params: schemas.dataRequestParams, body: schemas.cancelDataRequestSchema }),
  dataRequestController.cancel
);

module.exports = router;
