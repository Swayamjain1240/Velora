'use strict';

const closureService = require('../services/closureService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function preflight(req, res, next) {
  try {
    const result = await closureService.preflight({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function close(req, res, next) {
  try {
    const result = await closureService.closeEpisode({
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

async function reopen(req, res, next) {
  try {
    const result = await closureService.reopenEpisode({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function history(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await closureService.listClosures({
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

module.exports = { preflight, close, reopen, history };
