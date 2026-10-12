'use strict';

// Manual care plans for one recovery episode. Authority is resolved in the
// service on every request: drafting needs an ACTIVE coordinator assignment on a
// draft episode, while clarification/approval additionally re-derive reviewer
// role, verified eligibility and the reviewer assignment from the database.
const express = require('express');
const carePlanController = require('../controllers/carePlanController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext } = require('../middleware/auth');
const schemas = require('../validators/schemas');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

// Reading a plan is ordinary clinical reading; writing a draft is a drafting
// limit; review decisions get their own (tighter) bucket so a noisy editor can
// never exhaust a reviewer's approval budget (control #8).
const readLimit = mongoRateLimit({
  keyPrefix: 'plan-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const draftLimit = mongoRateLimit({
  keyPrefix: 'plan-draft',
  limit: 240,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const reviewLimit = mongoRateLimit({
  keyPrefix: 'plan-review',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/:episodeId/plans',
  readLimit,
  validate({ params: schemas.episodeIdParam, query: schemas.paginationQuery }),
  carePlanController.listVersions
);

router.post(
  '/:episodeId/plans',
  draftLimit,
  validate({ params: schemas.episodeIdParam, body: schemas.createPlanSchema }),
  carePlanController.createVersion
);

router.get(
  '/:episodeId/plans/:planId',
  readLimit,
  validate({ params: schemas.planIdParam }),
  carePlanController.getVersion
);

router.patch(
  '/:episodeId/plans/:planId',
  draftLimit,
  validate({ params: schemas.planIdParam, body: schemas.updatePlanSchema }),
  carePlanController.updateVersion
);

router.get(
  '/:episodeId/plans/:planId/items',
  readLimit,
  validate({ params: schemas.planIdParam, query: schemas.paginationQuery }),
  carePlanController.listItems
);

router.post(
  '/:episodeId/plans/:planId/items',
  draftLimit,
  validate({ params: schemas.planIdParam, body: schemas.createPlanItemSchema }),
  carePlanController.addItem
);

router.patch(
  '/:episodeId/plans/:planId/items/:itemId',
  draftLimit,
  validate({ params: schemas.planItemParams, body: schemas.updatePlanItemSchema }),
  carePlanController.updateItem
);

router.delete(
  '/:episodeId/plans/:planId/items/:itemId',
  draftLimit,
  validate({ params: schemas.planItemParams, body: schemas.revisionOnlySchema }),
  carePlanController.deleteItem
);

router.post(
  '/:episodeId/plans/:planId/items/:itemId/reorder',
  draftLimit,
  validate({ params: schemas.planItemParams, body: schemas.reorderPlanItemSchema }),
  carePlanController.reorderItem
);

router.post(
  '/:episodeId/plans/:planId/items/:itemId/sources',
  draftLimit,
  validate({ params: schemas.planItemParams, body: schemas.linkSourceSchema }),
  carePlanController.linkSource
);

router.post(
  '/:episodeId/plans/:planId/items/:itemId/review',
  reviewLimit,
  validate({ params: schemas.planItemParams, body: schemas.reviewPlanItemSchema }),
  carePlanController.reviewItem
);

router.delete(
  '/:episodeId/plans/:planId/sources/:sourceId',
  draftLimit,
  validate({ params: schemas.planSourceParams, body: schemas.revisionOnlySchema }),
  carePlanController.removeSource
);

router.post(
  '/:episodeId/plans/:planId/submit',
  draftLimit,
  validate({ params: schemas.planIdParam, body: schemas.revisionOnlySchema }),
  carePlanController.submitForReview
);

router.post(
  '/:episodeId/plans/:planId/clarification',
  reviewLimit,
  validate({ params: schemas.planIdParam, body: schemas.clarificationSchema }),
  carePlanController.requestClarification
);

// Resubmitting after clarification is the COORDINATOR's action, so it belongs to
// the drafting bucket, not the reviewer's decision bucket.
router.post(
  '/:episodeId/plans/:planId/resubmit',
  draftLimit,
  validate({ params: schemas.planIdParam, body: schemas.revisionOnlySchema }),
  carePlanController.submitForReview
);

router.post(
  '/:episodeId/plans/:planId/approve',
  reviewLimit,
  validate({ params: schemas.planIdParam, body: schemas.approvePlanSchema }),
  carePlanController.approve
);

module.exports = router;
