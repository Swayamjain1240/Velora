'use strict';

const episodeService = require('../services/episodeService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

async function createEpisode(req, res, next) {
  try {
    const episode = await episodeService.createEpisode({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.body.patientId,
      data: req.body,
      ...auditContext(req),
    });
    return res.status(201).json({ episode });
  } catch (err) {
    return next(err);
  }
}

async function listEpisodes(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await episodeService.listEpisodes({
      clinicId: req.clinicId,
      user: req.user,
      page,
      limit,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function getEpisode(req, res, next) {
  try {
    const episode = await episodeService.getEpisode({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
    });
    return res.json({ episode });
  } catch (err) {
    return next(err);
  }
}

async function correctDischarge(req, res, next) {
  try {
    const episode = await episodeService.correctDischarge({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      changes: req.body,
      expectedRevision: req.body.expectedRevision,
      ...auditContext(req),
    });
    return res.json({ episode });
  } catch (err) {
    return next(err);
  }
}

async function listCorrections(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await episodeService.listCorrections({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      page,
      limit,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listTeam(req, res, next) {
  try {
    const result = await episodeService.listTeam({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function listCandidates(req, res, next) {
  try {
    const result = await episodeService.listCandidates({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function assignTeam(req, res, next) {
  try {
    const assignment = await episodeService.assignTeam({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      memberUserId: req.body.memberUserId,
      responsibility: req.body.responsibility,
      ...auditContext(req),
    });
    return res.status(201).json({ assignment });
  } catch (err) {
    return next(err);
  }
}

async function revokeTeam(req, res, next) {
  try {
    const assignment = await episodeService.revokeTeam({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
      assignmentId: req.params.assignmentId,
      ...auditContext(req),
    });
    return res.json({ assignment });
  } catch (err) {
    return next(err);
  }
}

async function ownListEpisodes(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await episodeService.listOwnEpisodes({
      clinicId: req.clinicId,
      user: req.user,
      page,
      limit,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function ownGetEpisode(req, res, next) {
  try {
    const episode = await episodeService.getOwnEpisode({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
    });
    return res.json({ episode });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createEpisode,
  listEpisodes,
  getEpisode,
  correctDischarge,
  listCorrections,
  listTeam,
  listCandidates,
  assignTeam,
  revokeTeam,
  ownListEpisodes,
  ownGetEpisode,
};
