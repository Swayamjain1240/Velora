'use strict';

const metricsService = require('../services/metricsService');
const processMetrics = require('../services/processMetrics');

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
    // D-6: process health travels beside the workflow metrics, never inside
    // them - these numbers are about the server, not about care.
    return res.json({
      ...result,
      runtime: processMetrics.snapshot(),
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { overview };
