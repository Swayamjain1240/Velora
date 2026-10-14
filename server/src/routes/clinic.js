'use strict';

const express = require('express');
const staffController = require('../controllers/staffController');
const reminderController = require('../controllers/reminderController');
const { validate } = require('../middleware/validate');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

router.get('/', staffController.getClinic);

// Part 8: what the deployment is configured to do about reminders, and what would
// still have to be disclosed before an external channel could carry one. This is
// configuration, not clinical content, so an administrator may read it (control
// #22 - the disclosure is stated before anything external is enabled).
router.get('/reminder-provider', requirePermission(PERMISSIONS.CLINIC_UPDATE), reminderController.provider);

router.patch(
  '/',
  requirePermission(PERMISSIONS.CLINIC_UPDATE),
  validate({ body: schemas.updateClinicSchema }),
  staffController.updateClinic
);

module.exports = router;
