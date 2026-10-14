'use strict';

const checkInTemplateService = require('../services/checkInTemplateService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function list(req, res, next) {
  try {
    const { page, limit, state } = req.query;
    const result = await checkInTemplateService.listTemplates({
      clinicId: req.clinicId,
      page,
      limit,
      state,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function get(req, res, next) {
  try {
    const template = await checkInTemplateService.getTemplate({
      clinicId: req.clinicId,
      templateId: req.params.templateId,
    });
    noStore(res);
    return res.json({ template });
  } catch (err) {
    return next(err);
  }
}

async function create(req, res, next) {
  try {
    const template = await checkInTemplateService.createVersion({
      clinicId: req.clinicId,
      actor: req.user,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({ template });
  } catch (err) {
    return next(err);
  }
}

async function update(req, res, next) {
  try {
    const template = await checkInTemplateService.updateDraft({
      clinicId: req.clinicId,
      templateId: req.params.templateId,
      actor: req.user,
      expectedRevision: req.body.expectedRevision,
      changes: {
        title: req.body.title,
        description: req.body.description,
        questions: req.body.questions,
        cadence: req.body.cadence,
        responseWindowHours: req.body.responseWindowHours,
        reviewRules: req.body.reviewRules,
      },
      ...auditContext(req),
    });
    noStore(res);
    return res.json({ template });
  } catch (err) {
    return next(err);
  }
}

async function activate(req, res, next) {
  try {
    const result = await checkInTemplateService.activate({
      clinicId: req.clinicId,
      templateId: req.params.templateId,
      actor: req.user,
      membership: req.membership,
      expectedRevision: req.body.expectedRevision,
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, get, create, update, activate };
