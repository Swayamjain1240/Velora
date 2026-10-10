'use strict';

const express = require('express');
const staffController = require('../controllers/staffController');
const { validate } = require('../middleware/validate');
const { requireAuth, loadClinicContext, requirePermission } = require('../middleware/auth');
const schemas = require('../validators/schemas');
const { PERMISSIONS } = require('../config/constants');

const router = express.Router();

router.use(requireAuth, loadClinicContext);

router.get('/', staffController.getClinic);

router.patch(
  '/',
  requirePermission(PERMISSIONS.CLINIC_UPDATE),
  validate({ body: schemas.updateClinicSchema }),
  staffController.updateClinic
);

module.exports = router;
