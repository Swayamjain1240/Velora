'use strict';

const episodeService = require('../services/episodeService');

// Authorizes an upload BEFORE the request body is read (control #5). It resolves
// the caller's active care-team assignment, the episode's clinic and its state,
// and attaches the resolved episode for the handler. The controller re-checks
// immediately before persistence.
async function requireDocumentUploadAccess(req, res, next) {
  try {
    const resolved = await episodeService.assertEpisodeTeamWrite({
      clinicId: req.clinicId,
      user: req.user,
      episodeId: req.params.episodeId,
      roleKey: req.roleKey,
    });
    req.authorizedEpisode = resolved.episode;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireDocumentUploadAccess };
