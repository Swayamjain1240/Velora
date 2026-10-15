'use strict';

const dataRequestService = require('../services/dataRequestService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function create(req, res, next) {
  try {
    const result = await dataRequestService.createRequest({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function list(req, res, next) {
  try {
    const { page, limit, state, kind, mineOnly } = req.query;
    const result = await dataRequestService.listRequests({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      page,
      limit,
      state,
      kind,
      mineOnly,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function detail(req, res, next) {
  try {
    const result = await dataRequestService.getRequest({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function verifyIdentity(req, res, next) {
  try {
    const result = await dataRequestService.verifyIdentity({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function assign(req, res, next) {
  try {
    const result = await dataRequestService.assign({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function decide(req, res, next) {
  try {
    const result = await dataRequestService.decide({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function execute(req, res, next) {
  try {
    const result = await dataRequestService.execute({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function revokeExport(req, res, next) {
  try {
    const result = await dataRequestService.revokeExport({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function authorizeExport(req, res, next) {
  try {
    const result = await dataRequestService.authorizeExportDownload({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function downloadExport(req, res, next) {
  try {
    const result = await dataRequestService.downloadExport({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
      token: req.query.token,
      ...auditContext(req),
    });
    for (const [header, value] of Object.entries(result.headers)) {
      res.setHeader(header, value);
    }
    res.setHeader('Content-Type', result.mediaType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-Content-Hash', result.contentHash);
    return res.send(result.bytes);
  } catch (err) {
    return next(err);
  }
}

async function cancel(req, res, next) {
  try {
    const result = await dataRequestService.cancel({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      requestId: req.params.requestId,
      input: req.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  create,
  list,
  detail,
  verifyIdentity,
  assign,
  decide,
  execute,
  revokeExport,
  authorizeExport,
  downloadExport,
  cancel,
};
