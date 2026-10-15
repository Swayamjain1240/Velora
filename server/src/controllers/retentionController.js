'use strict';

const retentionService = require('../services/retentionService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function categories(req, res, next) {
  try {
    const items = await retentionService.listCategories({ clinicId: req.clinicId });
    noStore(res);
    return res.json({ categories: items });
  } catch (err) {
    return next(err);
  }
}

async function updateCategory(req, res, next) {
  try {
    const result = await retentionService.updatePolicy({
      clinicId: req.clinicId,
      user: req.user,
      category: req.params.category,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function dryRun(req, res, next) {
  try {
    const result = await retentionService.dryRun({ clinicId: req.clinicId, user: req.user });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function apply(req, res, next) {
  try {
    const result = await retentionService.apply({
      clinicId: req.clinicId,
      user: req.user,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function runs(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await retentionService.listRuns({ clinicId: req.clinicId, page, limit });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function holds(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await retentionService.listHolds({ clinicId: req.clinicId, page, limit });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function createHold(req, res, next) {
  try {
    const result = await retentionService.createHold({
      clinicId: req.clinicId,
      user: req.user,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function releaseHold(req, res, next) {
  try {
    const result = await retentionService.releaseHold({
      clinicId: req.clinicId,
      user: req.user,
      holdId: req.params.holdId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { categories, updateCategory, dryRun, apply, runs, holds, createHold, releaseHold };
