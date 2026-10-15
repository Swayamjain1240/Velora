'use strict';

// Episode closure and reopening (Part 9). Every handler resolves the caller's
// LIVE care-team assignment in the service, so a clinic role alone is never
// enough, and the episode revision is rechecked inside the transaction so a
// concurrent close cannot slip through.
const express = require('express');
const closureController = require('../controllers/closureController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const readLimit = mongoRateLimit({
  keyPrefix: 'closure-read',
  limit: 300,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const mutateLimit = mongoRateLimit({
  keyPrefix: 'closure-mutate',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/:episodeId/closure/preflight',
  readLimit,
  requirePermission(PERMISSIONS.CLOSURE_MANAGE),
  validate({ params: schemas.episodeIdParam }),
  closureController.preflight
);

router.get(
  '/:episodeId/closure',
  readLimit,
  requirePermission(PERMISSIONS.CLOSURE_MANAGE),
  validate({ params: schemas.episodeIdParam, query: schemas.closureHistoryQuery }),
  closureController.history
);

router.post(
  '/:episodeId/closure',
  mutateLimit,
  requirePermission(PERMISSIONS.CLOSURE_MANAGE),
  validate({ params: schemas.episodeIdParam, body: schemas.closeEpisodeSchema }),
  closureController.close
);

router.post(
  '/:episodeId/closure/reopen',
  mutateLimit,
  requirePermission(PERMISSIONS.CLOSURE_MANAGE),
  validate({ params: schemas.episodeIdParam, body: schemas.reopenEpisodeSchema }),
  closureController.reopen
);

module.exports = router;
