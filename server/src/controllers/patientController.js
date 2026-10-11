'use strict';

const patientService = require('../services/patientService');
const consentService = require('../services/consentService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

async function createPatient(req, res, next) {
  try {
    const patient = await patientService.createPatient({
      clinicId: req.clinicId,
      actor: req.user,
      data: req.body,
      ...auditContext(req),
    });
    return res.status(201).json({ patient });
  } catch (err) {
    return next(err);
  }
}

async function listPatients(req, res, next) {
  try {
    const { page, limit, query } = req.query;
    const result = await patientService.listPatients({
      clinicId: req.clinicId,
      user: req.user,
      page,
      limit,
      query,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function getPatient(req, res, next) {
  try {
    const patient = await patientService.getPatient({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
    });
    return res.json({ patient });
  } catch (err) {
    return next(err);
  }
}

async function updatePatient(req, res, next) {
  try {
    const patient = await patientService.updatePatient({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
      changes: req.body,
      ...auditContext(req),
    });
    return res.json({ patient });
  } catch (err) {
    return next(err);
  }
}

async function activatePatient(req, res, next) {
  try {
    const patient = await patientService.activatePatient({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
      ...auditContext(req),
    });
    return res.json({ patient });
  } catch (err) {
    return next(err);
  }
}

async function listAssignments(req, res, next) {
  try {
    const result = await patientService.listAssignments({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listEligibleAssignees(req, res, next) {
  try {
    const result = await patientService.listEligibleAssignees({ clinicId: req.clinicId });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function createAssignment(req, res, next) {
  try {
    const assignment = await patientService.createAssignment({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
      memberUserId: req.body.memberUserId,
      ...auditContext(req),
    });
    return res.status(201).json({ assignment });
  } catch (err) {
    return next(err);
  }
}

async function revokeAssignment(req, res, next) {
  try {
    const assignment = await patientService.revokeAssignment({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
      assignmentId: req.params.assignmentId,
      ...auditContext(req),
    });
    return res.json({ assignment });
  } catch (err) {
    return next(err);
  }
}

async function listConsent(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await consentService.listConsent({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
      page,
      limit,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function appendConsent(req, res, next) {
  try {
    const consent = await consentService.appendConsent({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
      data: req.body,
      ...auditContext(req),
    });
    return res.status(201).json({ consent });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createPatient,
  listPatients,
  getPatient,
  updatePatient,
  activatePatient,
  listAssignments,
  listEligibleAssignees,
  createAssignment,
  revokeAssignment,
  listConsent,
  appendConsent,
};
