'use strict';

const todayService = require('../services/todayService');
const activityLogService = require('../services/activityLogService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function getToday(req, res, next) {
  try {
    const day = await todayService.getToday({ user: req.user, query: req.query });
    noStore(res);
    return res.json(day);
  } catch (err) {
    return next(err);
  }
}

async function recordEntry(req, res, next) {
  try {
    const result = await activityLogService.recordEntry({
      user: req.user,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(result.idempotent ? 200 : 201).json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { getToday, recordEntry };
