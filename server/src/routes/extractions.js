'use strict';

// AI-assisted extraction and reviewed language renderings (Part 6).
//
// Every route is behind a session, a resolved clinic context and the drafting or
// reviewing permission the action actually needs. Budgets are durable
// (Mongo-backed) and per user: a bounded number of jobs per hour and a bounded
// number of provider runs per day, so a runaway client cannot spend an unbounded
// provider budget (control #8).
const express = require('express');
const extractionController = require('../controllers/extractionController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit, mongoRateLimitFromEnv } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

const readLimit = mongoRateLimit({
  keyPrefix: 'extraction-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
// Budgets, not constants: a deployment can tighten them without a code change.
const jobLimit = mongoRateLimitFromEnv({
  keyPrefix: 'extraction-jobs',
  envKey: 'EXTRACTION_JOBS_PER_HOUR',
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const runLimit = mongoRateLimitFromEnv({
  keyPrefix: 'extraction-runs',
  envKey: 'EXTRACTION_RUNS_PER_DAY',
  windowMs: 24 * 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const draftLimit = mongoRateLimit({
  keyPrefix: 'extraction-draft',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const reviewLimit = mongoRateLimit({
  keyPrefix: 'extraction-review',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

// ---- jobs -------------------------------------------------------------------

router.post(
  '/:episodeId/extraction-jobs',
  requirePermission(PERMISSIONS.EXTRACTION_RUN),
  jobLimit,
  validate({ params: schemas.episodeIdParam, body: schemas.createExtractionJobSchema }),
  extractionController.createJob
);

router.get(
  '/:episodeId/extraction-jobs',
  readLimit,
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  extractionController.listJobs
);

router.get(
  '/:episodeId/extraction-jobs/:jobId',
  readLimit,
  validate({ params: schemas.extractionJobParams }),
  extractionController.getJob
);

// Running a job spends the provider budget, so it is limited separately (and far
// more tightly) than creating one.
router.post(
  '/:episodeId/extraction-jobs/:jobId/run',
  requirePermission(PERMISSIONS.EXTRACTION_RUN),
  runLimit,
  validate({ params: schemas.extractionJobParams }),
  extractionController.runJob
);

router.post(
  '/:episodeId/extraction-jobs/:jobId/cancel',
  requirePermission(PERMISSIONS.EXTRACTION_RUN),
  draftLimit,
  validate({ params: schemas.extractionJobParams }),
  extractionController.cancelJob
);

router.get(
  '/:episodeId/extraction-jobs/:jobId/suggestions',
  readLimit,
  validate({ params: schemas.extractionJobParams, query: schemas.paginationQuery }),
  extractionController.listSuggestions
);

// Applying is a DRAFT edit through the ordinary Part 5 service.
router.post(
  '/:episodeId/extraction-jobs/:jobId/suggestions/:suggestionId/apply',
  requirePermission(PERMISSIONS.EXTRACTION_RUN),
  draftLimit,
  validate({ params: schemas.extractionSuggestionParams, body: schemas.applySuggestionSchema }),
  extractionController.applySuggestion
);

router.post(
  '/:episodeId/extraction-jobs/:jobId/suggestions/:suggestionId/dismiss',
  requirePermission(PERMISSIONS.EXTRACTION_RUN),
  draftLimit,
  validate({ params: schemas.extractionSuggestionParams, body: schemas.dismissSuggestionSchema }),
  extractionController.dismissSuggestion
);

// ---- reviewed language renderings -------------------------------------------

router.get(
  '/:episodeId/plans/:planId/variants',
  readLimit,
  validate({ params: schemas.planIdParam, query: schemas.paginationQuery }),
  extractionController.listVariants
);

router.post(
  '/:episodeId/plans/:planId/items/:itemId/variants',
  requirePermission(PERMISSIONS.PLAN_DRAFT),
  draftLimit,
  validate({ params: schemas.planItemVariantParams, body: schemas.createVariantSchema }),
  extractionController.createVariant
);

router.post(
  '/:episodeId/plans/:planId/variants/:variantId/submit',
  requirePermission(PERMISSIONS.PLAN_DRAFT),
  draftLimit,
  validate({ params: schemas.variantParams }),
  extractionController.submitVariant
);

// Approval is a CLINICAL REVIEW decision: the same permission, the same verified
// reviewer eligibility and the same active reviewer assignment Part 5 requires.
router.post(
  '/:episodeId/plans/:planId/variants/:variantId/approve',
  requirePermission(PERMISSIONS.PLAN_REVIEW),
  reviewLimit,
  validate({ params: schemas.variantParams, body: schemas.approveVariantSchema }),
  extractionController.approveVariant
);

router.post(
  '/:episodeId/plans/:planId/variants/:variantId/reject',
  requirePermission(PERMISSIONS.PLAN_REVIEW),
  reviewLimit,
  validate({ params: schemas.variantParams, body: schemas.rejectVariantSchema }),
  extractionController.rejectVariant
);

module.exports = router;
