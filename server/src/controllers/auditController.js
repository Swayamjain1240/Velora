'use strict';

const audit = require('../services/auditService');

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function search(req, res, next) {
  try {
    const { page, limit, category, action, subjectType, subjectId, outcome, from, to } = req.query;
    const result = await audit.search({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      rolePermissions: req.permissions,
      filters: { category, action, subjectType, subjectId, outcome, from, to },
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { search };
