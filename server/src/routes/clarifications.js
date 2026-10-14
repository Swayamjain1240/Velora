'use strict';

// The clarification queue for one episode (Part 8, VEL-016).
//
// The staff surface. The state machine, the authority split and the wording all
// live in the service and the policy; these routes only carry the request and
// apply rate limits. An administrator holds no clinical permission and is
// refused, and a staff member who is not on the episode's care team is refused
// with an explicit message.
const express = require('express');
const clarificationController = require('../controllers/clarificationController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const {
  requireAuth,
  loadClinicContext,
  requirePermission,
} = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { errors } = require('../services/errors');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

// Durable, separate buckets (control #8): reading the queue, asking, answering
// and assigning each have their own budget.
const readLimit = mongoRateLimit({
  keyPrefix: 'clarification-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const askLimit = mongoRateLimit({
  keyPrefix: 'clarification-ask',
  limit: 60,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const answerLimit = mongoRateLimit({
  keyPrefix: 'clarification-answer',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

function anyPermission(...needed) {
  return (req, res, next) => {
    const allowed =
      req.permissions && needed.some((permission) => req.permissions.has(permission));
    if (!allowed) return next(errors.forbidden());
    return next();
  };
}

router.get(
  '/:episodeId/questions',
  readLimit,
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.episodeIdParam, query: schemas.threadStateSchema }),
  clarificationController.list
);

router.post(
  '/:episodeId/questions',
  askLimit,
  requirePermission(PERMISSIONS.QUESTION_ASK),
  validate({ params: schemas.episodeIdParam, body: schemas.openThreadSchema }),
  clarificationController.open
);

router.get(
  '/:episodeId/questions/:threadId',
  readLimit,
  requirePermission(PERMISSIONS.PATIENT_READ),
  validate({ params: schemas.clarificationThreadParams }),
  clarificationController.get
);

router.post(
  '/:episodeId/questions/:threadId/assign',
  askLimit,
  requirePermission(PERMISSIONS.QUESTION_ASSIGN),
  validate({ params: schemas.clarificationThreadParams, body: schemas.assignThreadSchema }),
  clarificationController.assign
);

// Either answer authority may reach the route; the SERVICE decides whether the
// permission fits this thread's kind and whether the caller is the assigned,
// verified reviewer a clinical question requires.
router.post(
  '/:episodeId/questions/:threadId/answer',
  answerLimit,
  anyPermission(
    PERMISSIONS.QUESTION_ANSWER_CLINICAL,
    PERMISSIONS.QUESTION_ANSWER_OPERATIONAL
  ),
  validate({ params: schemas.clarificationThreadParams, body: schemas.answerThreadSchema }),
  clarificationController.answer
);

router.post(
  '/:episodeId/questions/:threadId/notes',
  answerLimit,
  requirePermission(PERMISSIONS.QUESTION_ANSWER_OPERATIONAL),
  validate({ params: schemas.clarificationThreadParams, body: schemas.threadNoteSchema }),
  clarificationController.note
);

router.post(
  '/:episodeId/questions/:threadId/close',
  answerLimit,
  requirePermission(PERMISSIONS.QUESTION_ASK),
  validate({ params: schemas.clarificationThreadParams, body: schemas.threadTransitionSchema }),
  clarificationController.close
);

router.post(
  '/:episodeId/questions/:threadId/reopen',
  answerLimit,
  requirePermission(PERMISSIONS.QUESTION_ASK),
  validate({ params: schemas.clarificationThreadParams, body: schemas.threadTransitionSchema }),
  clarificationController.reopen
);

router.post(
  '/:episodeId/questions/:threadId/reclassify',
  askLimit,
  requirePermission(PERMISSIONS.QUESTION_ASSIGN),
  validate({ params: schemas.clarificationThreadParams, body: schemas.threadTransitionSchema }),
  clarificationController.reclassify
);

module.exports = router;
