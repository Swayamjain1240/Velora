'use strict';

// Clinic-scoped recovery episodes and care-team assignment. Every handler
// resolves the caller's active care-team assignment (or explicit admin team
// administration) in the service, so a clinic role alone is never sufficient.
const express = require('express');
const episodeController = require('../controllers/episodeController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const createLimit = mongoRateLimit({
  keyPrefix: 'episode-create',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const readLimit = mongoRateLimit({
  keyPrefix: 'episode-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const mutateLimit = mongoRateLimit({
  keyPrefix: 'episode-mutate',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.post(
  '/',
  requirePermission(PERMISSIONS.EPISODE_MANAGE),
  createLimit,
  validate({ body: schemas.createEpisodeSchema }),
  episodeController.createEpisode
);

router.get(
  '/',
  readLimit,
  validate({ query: schemas.paginationQuery }),
  episodeController.listEpisodes
);

router.get(
  '/:episodeId',
  readLimit,
  validate({ params: schemas.episodeIdParam }),
  episodeController.getEpisode
);

router.patch(
  '/:episodeId/discharge',
  mutateLimit,
  validate({ params: schemas.episodeIdParam, body: schemas.correctDischargeSchema }),
  episodeController.correctDischarge
);

router.get(
  '/:episodeId/corrections',
  readLimit,
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  episodeController.listCorrections
);

router.get(
  '/:episodeId/team',
  readLimit,
  validate({ params: schemas.episodeIdParam }),
  episodeController.listTeam
);

router.get(
  '/:episodeId/team/candidates',
  readLimit,
  validate({ params: schemas.episodeIdParam }),
  episodeController.listCandidates
);

router.post(
  '/:episodeId/team',
  mutateLimit,
  validate({ params: schemas.episodeIdParam, body: schemas.assignTeamSchema }),
  episodeController.assignTeam
);

router.delete(
  '/:episodeId/team/:assignmentId',
  mutateLimit,
  validate({ params: schemas.episodeTeamParams }),
  episodeController.revokeTeam
);

module.exports = router;
