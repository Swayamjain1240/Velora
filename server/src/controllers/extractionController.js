'use strict';

const extractionService = require('../services/extractionService');
const languageVariantService = require('../services/languageVariantService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  // AI job and suggestion responses are private clinical working state: never
  // cached, never indexed (control #11).
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function createJob(req, res, next) {
  try {
    const result = await extractionService.createJob({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      documentId: req.body.documentId,
      versionId: req.body.versionId,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(result.deduplicated ? 200 : 201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function runJob(req, res, next) {
  try {
    const result = await extractionService.runJob({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      jobId: req.params.jobId,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listJobs(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await extractionService.listJobs({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function getJob(req, res, next) {
  try {
    const result = await extractionService.getJob({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      jobId: req.params.jobId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function cancelJob(req, res, next) {
  try {
    const result = await extractionService.cancelJob({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      jobId: req.params.jobId,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listSuggestions(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await extractionService.listSuggestions({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      jobId: req.params.jobId,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function applySuggestion(req, res, next) {
  try {
    const result = await extractionService.applySuggestion({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      jobId: req.params.jobId,
      suggestionId: req.params.suggestionId,
      expectedRevision: req.body.expectedRevision,
      fields: req.body.fields,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function dismissSuggestion(req, res, next) {
  try {
    const result = await extractionService.dismissSuggestion({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      jobId: req.params.jobId,
      suggestionId: req.params.suggestionId,
      reason: req.body.reason,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// ---- reviewed language renderings -------------------------------------------

async function listVariants(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await languageVariantService.listVariants({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      itemId: req.query.itemId,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function createVariant(req, res, next) {
  try {
    const variant = await languageVariantService.createVariant({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      itemId: req.params.itemId,
      language: req.body.language,
      kind: req.body.kind,
      text: req.body.text,
      producedBy: req.body.producedBy,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({ variant });
  } catch (err) {
    return next(err);
  }
}

async function submitVariant(req, res, next) {
  try {
    const result = await languageVariantService.submitVariant({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      variantId: req.params.variantId,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function approveVariant(req, res, next) {
  try {
    const result = await languageVariantService.approveVariant({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      variantId: req.params.variantId,
      fidelityNote: req.body.fidelityNote,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function rejectVariant(req, res, next) {
  try {
    const result = await languageVariantService.rejectVariant({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      variantId: req.params.variantId,
      reason: req.body.reason,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createJob,
  runJob,
  listJobs,
  getJob,
  cancelJob,
  listSuggestions,
  applySuggestion,
  dismissSuggestion,
  listVariants,
  createVariant,
  submitVariant,
  approveVariant,
  rejectVariant,
};
