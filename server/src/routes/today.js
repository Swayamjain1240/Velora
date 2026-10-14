'use strict';

// The day view and entry recording (Part 7), used by patients, caregivers and
// assigned staff through one route. There is no clinic-wide permission here on
// purpose: a patient and a caregiver hold none, so the service derives the
// clinic from the record (and from the caregiver's grant) and re-checks
// ownership / grant scope / assignment on every request.
const express = require('express');
const todayController = require('../controllers/todayController');
const { validate } = require('../middleware/validate');
const { mongoRateLimit } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');
const schemas = require('../validators/schemas');

const router = express.Router();

router.use(requireAuth);

const readLimit = mongoRateLimit({
  keyPrefix: 'today-read',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});
const logLimit = mongoRateLimit({
  keyPrefix: 'today-log',
  limit: 240,
  windowMs: 60 * 60 * 1000,
  keyFn: (req) => (req.user ? req.user.id : req.clientIp),
});

router.get('/', readLimit, validate({ query: schemas.todayQuery }), todayController.getToday);

// A retry with the same clientRequestId returns the original entry rather than
// appending a second one (the unique index is the actual guarantee).
router.post(
  '/entries',
  logLimit,
  validate({ body: schemas.recordEntrySchema }),
  todayController.recordEntry
);

module.exports = router;
