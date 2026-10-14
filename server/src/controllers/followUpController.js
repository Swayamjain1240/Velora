'use strict';

const followUpService = require('../services/followUpService');
const patientService = require('../services/patientService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function list(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await followUpService.listForEpisode({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const result = await followUpService.createFollowUp({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const result = await followUpService.updateFollowUp({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      followUpId: req.params.followUpId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function cancel(req, res, next) {
  try {
    const result = await followUpService.cancelFollowUp({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      followUpId: req.params.followUpId,
      reason: req.body.reason,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// ---- the patient's own surface ----------------------------------------------

async function ownList(req, res, next) {
  try {
    const { page, limit } = req.query;
    const patient = await patientService.getOwnProfile({
      clinicId: req.clinicId,
      user: req.user,
    });
    const result = await followUpService.listForPatient({
      clinicId: req.clinicId,
      patientId: patient.id,
      page,
      limit,
    });
    noStore(res);
    return res.json({ ...result, patient });
  } catch (err) {
    return next(err);
  }
}

// ---- the caregiver's scoped surface -----------------------------------------

async function caregiverList(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await followUpService.listForCaregiver({
      user: req.user,
      patientId: req.params.patientId,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, create, update, cancel, ownList, caregiverList };
