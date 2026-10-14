'use strict';

const clarificationService = require('../services/clarificationService');
const patientService = require('../services/patientService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

function noStore(res) {
  // A clarification thread is private clinical communication: never cached.
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

// ---- staff surface -----------------------------------------------------------

async function list(req, res, next) {
  try {
    const { page, limit, state, assignedToMe } = req.query;
    const result = await clarificationService.listThreads({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      state,
      assignedToMe,
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
    const result = await clarificationService.getThread({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      episodeId: req.params.episodeId,
      threadId: req.params.threadId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function open(req, res, next) {
  try {
    const result = await clarificationService.openThread({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      episodeId: req.params.episodeId,
      kind: req.body.kind,
      subject: req.body.subject,
      body: req.body.body,
      responseId: req.body.responseId,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function assign(req, res, next) {
  try {
    const result = await clarificationService.assign({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      threadId: req.params.threadId,
      assigneeUserId: req.body.assigneeUserId,
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function answer(req, res, next) {
  try {
    const result = await clarificationService.answer({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      threadId: req.params.threadId,
      body: req.body.body,
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function note(req, res, next) {
  try {
    const result = await clarificationService.note({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      threadId: req.params.threadId,
      body: req.body.body,
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function close(req, res, next) {
  try {
    const result = await clarificationService.close({
      clinicId: req.clinicId,
      user: req.user,
      threadId: req.params.threadId,
      capacity: 'team',
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function reopen(req, res, next) {
  try {
    const result = await clarificationService.reopen({
      clinicId: req.clinicId,
      user: req.user,
      threadId: req.params.threadId,
      capacity: 'team',
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function reclassify(req, res, next) {
  try {
    const result = await clarificationService.reclassify({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: req.roleKey,
      permissions: req.permissions,
      threadId: req.params.threadId,
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// ---- the patient's own surface -----------------------------------------------

async function ownList(req, res, next) {
  try {
    const { page, limit } = req.query;
    const patient = await patientService.getOwnProfile({
      clinicId: req.clinicId,
      user: req.user,
    });
    const result = await clarificationService.ownThreads({
      clinicId: req.clinicId,
      patientId: patient.id,
      page,
      limit,
    });
    noStore(res);
    return res.json({ ...result, patient });
  } catch (err) {
    return next(err);
  }
}

async function ownGet(req, res, next) {
  try {
    const patient = await patientService.getOwnProfile({
      clinicId: req.clinicId,
      user: req.user,
    });
    const result = await clarificationService.ownThreadMessages({
      clinicId: req.clinicId,
      patientId: patient.id,
      threadId: req.params.threadId,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function ownOpen(req, res, next) {
  try {
    const result = await clarificationService.openThread({
      clinicId: req.clinicId,
      user: req.user,
      roleKey: 'patient',
      episodeId: req.params.episodeId,
      kind: req.body.kind,
      subject: req.body.subject,
      body: req.body.body,
      responseId: req.body.responseId,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function ownReply(req, res, next) {
  try {
    const result = await clarificationService.askerReply({
      clinicId: req.clinicId,
      user: req.user,
      threadId: req.params.threadId,
      body: req.body.body,
      capacity: 'patient',
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function ownClose(req, res, next) {
  try {
    const result = await clarificationService.close({
      clinicId: req.clinicId,
      user: req.user,
      threadId: req.params.threadId,
      capacity: 'patient',
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function ownReopen(req, res, next) {
  try {
    const result = await clarificationService.reopen({
      clinicId: req.clinicId,
      user: req.user,
      threadId: req.params.threadId,
      capacity: 'patient',
      note: req.body.note,
      ...auditContext(req),
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

// ---- the caregiver's scoped surface ------------------------------------------

async function caregiverList(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await clarificationService.caregiverThreads({
      user: req.user,
      patientId: req.params.patientId,
      page,
      limit,
    });
    noStore(res);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function caregiverGet(req, res, next) {
  try {
    const { clinicId, thread } = await clarificationService.caregiverThreadScope({
      user: req.user,
      threadId: req.params.threadId,
    });
    const result = await clarificationService.ownThreadMessages({
      clinicId,
      patientId: thread.patient,
      threadId: thread._id,
    });
    noStore(res);
    return res.json({ ...result, scopes: ['ask_questions'] });
  } catch (err) {
    return next(err);
  }
}

async function caregiverOpen(req, res, next) {
  try {
    const { clinicId } = await clarificationService.caregiverEpisodeScope({
      user: req.user,
      episodeId: req.params.episodeId,
    });
    const result = await clarificationService.openThread({
      clinicId,
      user: req.user,
      roleKey: 'caregiver',
      episodeId: req.params.episodeId,
      kind: req.body.kind,
      subject: req.body.subject,
      body: req.body.body,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function caregiverReply(req, res, next) {
  try {
    const { clinicId, grant, thread } = await clarificationService.caregiverThreadScope({
      user: req.user,
      threadId: req.params.threadId,
    });
    const result = await clarificationService.askerReply({
      clinicId,
      user: req.user,
      threadId: thread._id,
      body: req.body.body,
      capacity: 'caregiver',
      grant,
      ...auditContext(req),
    });
    noStore(res);
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  list,
  get,
  open,
  assign,
  answer,
  note,
  close,
  reopen,
  reclassify,
  ownList,
  ownGet,
  ownOpen,
  ownReply,
  ownClose,
  ownReopen,
  caregiverList,
  caregiverGet,
  caregiverOpen,
  caregiverReply,
};
