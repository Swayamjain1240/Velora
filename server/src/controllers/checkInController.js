'use strict';

const checkInService = require('../services/checkInService');
const patientService = require('../services/patientService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  // Check-in content is private clinical data: never cached by a shared cache.
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function list(req, res, next) {
  try {
    const { page, limit, view } = req.query;
    const result = await checkInService.listForEpisode({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      page,
      limit,
      view,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const result = await checkInService.getResponse({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      responseId: req.params.responseId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function materialise(req, res, next) {
  try {
    const summary = await checkInService.materialise({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({ summary });
  } catch (err) {
    return next(err);
  }
}

async function submit(req, res, next) {
  try {
    const result = await checkInService.submit({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      responseId: req.params.responseId,
      answers: req.body.answers,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function review(req, res, next) {
  try {
    const result = await checkInService.review({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      responseId: req.params.responseId,
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// ---- the patient's own queue -------------------------------------------------

// Ownership, not a clinic-wide permission: the patient id comes from the account
// that owns the profile.
async function ownList(req, res, next) {
  try {
    const { page, limit, view } = req.query;
    const patient = await patientService.getOwnProfile({
      clinicId: req.clinicId,
      user: req.user,
    });
    const result = await checkInService.listForPatient({
      clinicId: req.clinicId,
      patientId: patient.id,
      page,
      limit,
      view,
    });
    noStore(res);
    return res.json({ ...result, patient });
  } catch (err) {
    return next(err);
  }
}

async function ownSubmit(req, res, next) {
  try {
    const result = await checkInService.submit({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: 'patient',
      responseId: req.params.responseId,
      answers: req.body.answers,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// ---- the caregiver's scoped queue --------------------------------------------

async function caregiverList(req, res, next) {
  try {
    const { page, limit, view } = req.query;
    const result = await checkInService.listForCaregiver({
      user: req.user,
      patientId: req.params.patientId,
      page,
      limit,
      view,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function caregiverSubmit(req, res, next) {
  try {
    const result = await checkInService.submitAsCaregiver({
      user: req.user,
      responseId: req.params.responseId,
      answers: req.body.answers,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list,
  get,
  materialise,
  submit,
  review,
  ownList,
  ownSubmit,
  caregiverList,
  caregiverSubmit,
};
