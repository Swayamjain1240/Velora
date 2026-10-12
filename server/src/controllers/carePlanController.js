'use strict';

const carePlanService = require('../services/carePlanService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  // Clinical plan responses are private: never cached, never indexed.
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function createVersion(req, res, next) {
  try {
    const plan = await carePlanService.createDraftVersion({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      data: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({ plan });
  } catch (err) {
    return next(err);
  }
}

async function listVersions(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await carePlanService.listVersions({
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

async function getVersion(req, res, next) {
  try {
    const result = await carePlanService.getVersion({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listItems(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await carePlanService.listItems({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function updateVersion(req, res, next) {
  try {
    const plan = await carePlanService.updateVersion({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      expectedRevision: req.body.expectedRevision,
      data: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json({ plan });
  } catch (err) {
    return next(err);
  }
}

async function addItem(req, res, next) {
  try {
    const item = await carePlanService.addItem({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      expectedRevision: req.body.expectedRevision,
      data: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({ item });
  } catch (err) {
    return next(err);
  }
}

async function updateItem(req, res, next) {
  try {
    const item = await carePlanService.updateItem({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      itemId: req.params.itemId,
      expectedRevision: req.body.expectedRevision,
      data: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json({ item });
  } catch (err) {
    return next(err);
  }
}

async function deleteItem(req, res, next) {
  try {
    const result = await carePlanService.deleteItem({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      itemId: req.params.itemId,
      expectedRevision: req.body.expectedRevision,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function reorderItem(req, res, next) {
  try {
    const result = await carePlanService.reorderItem({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      itemId: req.params.itemId,
      expectedRevision: req.body.expectedRevision,
      direction: req.body.direction,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function linkSource(req, res, next) {
  try {
    const source = await carePlanService.linkSource({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      itemId: req.params.itemId,
      expectedRevision: req.body.expectedRevision,
      data: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({ source });
  } catch (err) {
    return next(err);
  }
}

async function removeSource(req, res, next) {
  try {
    const result = await carePlanService.removeSource({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      sourceId: req.params.sourceId,
      expectedRevision: req.body.expectedRevision,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function submitForReview(req, res, next) {
  try {
    const plan = await carePlanService.submitForReview({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      expectedRevision: req.body.expectedRevision,
      ...auditContext(req),
    });
    noStore(res);
    return res.json({ plan });
  } catch (err) {
    return next(err);
  }
}

async function requestClarification(req, res, next) {
  try {
    const plan = await carePlanService.requestClarification({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      expectedRevision: req.body.expectedRevision,
      reason: req.body.reason,
      ...auditContext(req),
    });
    noStore(res);
    return res.json({ plan });
  } catch (err) {
    return next(err);
  }
}

async function reviewItem(req, res, next) {
  try {
    const item = await carePlanService.reviewItem({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      itemId: req.params.itemId,
      expectedRevision: req.body.expectedRevision,
      decision: req.body.decision,
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json({ item });
  } catch (err) {
    return next(err);
  }
}

async function approve(req, res, next) {
  try {
    const result = await carePlanService.approve({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      planId: req.params.planId,
      expectedRevision: req.body.expectedRevision,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function patientCurrentPlan(req, res, next) {
  try {
    const result = await carePlanService.getPatientCurrentPlan({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createVersion,
  listVersions,
  getVersion,
  listItems,
  updateVersion,
  addItem,
  updateItem,
  deleteItem,
  reorderItem,
  linkSource,
  removeSource,
  submitForReview,
  requestClarification,
  reviewItem,
  approve,
  patientCurrentPlan,
};
