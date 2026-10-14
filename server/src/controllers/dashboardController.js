'use strict';

const dashboardService = require('../services/dashboardService');
const providerRegistry = require('../providers/notificationProvider');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  // Queue listings are private clinical workflow data: never cached.
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function overview(req, res, next) {
  try {
    const summary = await dashboardService.summary({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
    });
    noStore(res);
    return res.json({ summary, queues: dashboardService.QUEUES, provider: providerRegistry.providerStatus() });
  } catch (err) {
    return next(err);
  }
}

async function queue(req, res, next) {
  try {
    const { page, limit, mine } = req.query;
    const result = await dashboardService.queue({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      queueKey: req.params.queueKey,
      page,
      limit,
      mineOnly: mine === true,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function myAssignments(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await dashboardService.myAssignments({
      clinicId: req.clinicId,
      user: req.user,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function claim(req, res, next) {
  try {
    const result = await dashboardService.claim({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      queueKey: req.params.queueKey,
      targetId: req.params.targetId,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function release(req, res, next) {
  try {
    const result = await dashboardService.release({
      clinicId: req.clinicId,
      user: req.user,
      assignmentId: req.params.assignmentId,
      reason: req.body.reason,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { overview, queue, myAssignments, claim, release };
