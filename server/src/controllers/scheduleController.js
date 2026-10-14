'use strict';

const scheduleService = require('../services/scheduleService');
const activityLogService = require('../services/activityLogService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  // Schedule and task responses are private clinical data: never cached.
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function prepare(req, res, next) {
  try {
    const summary = await scheduleService.prepareFromApprovedVersion({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      data: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json({ summary });
  } catch (err) {
    return next(err);
  }
}

async function list(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await scheduleService.listSchedules({
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

async function get(req, res, next) {
  try {
    const result = await scheduleService.getSchedule({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      scheduleId: req.params.scheduleId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listOccurrences(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await scheduleService.listOccurrences({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      scheduleId: req.params.scheduleId,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function activate(req, res, next) {
  try {
    const result = await scheduleService.activateSchedule({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      scheduleId: req.params.scheduleId,
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

async function end(req, res, next) {
  try {
    const result = await scheduleService.endSchedule({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      scheduleId: req.params.scheduleId,
      reason: req.body.reason,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listActivity(req, res, next) {
  try {
    const { page, limit } = req.query;
    await scheduleService.assertTeamRead({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
    });
    const result = await activityLogService.listEpisodeLogs({
      clinicId: req.clinicId,
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

module.exports = { prepare, list, get, listOccurrences, activate, end, listActivity };
