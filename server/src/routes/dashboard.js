'use strict';

// The assigned-team dashboard (Part 8).
//
// Holding `dashboard.read` is necessary but not sufficient: every queue is
// re-scoped to the caller's OWN active care-team assignments in the service, and
// an administrator - who holds no clinical permission at all - is refused both
// here and in the service.
const express = require('express');
const dashboardController = require('../controllers/dashboardController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

// A dashboard read is heavier than a single record, so it keeps its own durable
// budget separate from check-in and message traffic (control #8).
const readLimit = mongoRateLimit({
  keyPrefix: 'dashboard-read',
  limit: 300,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const writeLimit = mongoRateLimit({
  keyPrefix: 'dashboard-write',
  limit: 120,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get(
  '/',
  readLimit,
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  dashboardController.overview
);

router.get(
  '/assignments',
  readLimit,
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  validate({ query: schemas.dashboardQuery }),
  dashboardController.myAssignments
);

router.post(
  '/assignments/:assignmentId/release',
  writeLimit,
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  validate({ params: schemas.assignmentIdParam, body: schemas.releaseAssignmentSchema }),
  dashboardController.release
);

router.get(
  '/queues/:queueKey',
  readLimit,
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  validate({ params: schemas.queueKeyParam, query: schemas.dashboardQuery }),
  dashboardController.queue
);

router.post(
  '/queues/:queueKey/:targetId/claim',
  writeLimit,
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  validate({ params: schemas.queueTargetParams }),
  dashboardController.claim
);

module.exports = router;
