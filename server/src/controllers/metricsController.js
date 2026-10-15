'use strict';

const metricsService = require('../services/metricsService');

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function overview(req, res, next) {
  try {
    const { from, to } = req.query;
    const result = await metricsService.overview({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      from,
      to,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { overview };
