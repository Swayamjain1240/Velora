'use strict';

const reminderService = require('../services/reminderService');
const providerRegistry = require('../providers/notificationProvider');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  // Reminders are private: never cached by a shared cache.
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

// ---- team surface ------------------------------------------------------------

async function list(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await reminderService.listForEpisode({
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

async function get(req, res, next) {
  try {
    const result = await reminderService.getNotification({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      notificationId: req.params.notificationId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function queue(req, res, next) {
  try {
    const summary = await reminderService.queueBatch({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      kinds: req.body.kinds,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({ summary });
  } catch (err) {
    return next(err);
  }
}

async function deliver(req, res, next) {
  try {
    const summary = await reminderService.deliverBatch({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      limit: req.body.limit,
      ...auditContext(req),
    });
    noStore(res);
    return res.json({ summary });
  } catch (err) {
    return next(err);
  }
}

async function retry(req, res, next) {
  try {
    const result = await reminderService.retry({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      notificationId: req.params.notificationId,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// What the deployment is configured to do, and what would still have to be
// disclosed before an external channel could be enabled (control #22).
async function provider(req, res, next) {
  try {
    noStore(res);
    return res.json({ provider: providerRegistry.providerStatus() });
  } catch (err) {
    return next(err);
  }
}

// ---- the recipient's own inbox ----------------------------------------------

async function mine(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await reminderService.listMine({
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

async function acknowledge(req, res, next) {
  try {
    const result = await reminderService.acknowledge({
      clinicId: req.clinicId,
      user: req.user,
      notificationId: req.params.notificationId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { list, get, queue, deliver, retry, provider, mine, acknowledge };
