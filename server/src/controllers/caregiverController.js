'use strict';

const caregiverService = require('../services/caregiverService');
const patientService = require('../services/patientService');

function auditContext(req) {
  return { ip: req.clientIp, userAgent: req.clientUserAgent };
}

// ----- staff acting on behalf of a patient (clinic-scoped) -----

async function listCaregivers(req, res, next) {
  try {
    const result = await caregiverService.listCaregivers({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
      actorRole: 'staff',
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function inviteCaregiver(req, res, next) {
  try {
    const result = await caregiverService.inviteCaregiver({
      clinicId: req.clinicId,
      patientId: req.params.patientId,
      email: req.body.email,
      scopes: req.body.scopes,
      actor: req.user,
      actorRole: 'staff',
      ...auditContext(req),
    });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function revokeCaregiverGrant(req, res, next) {
  try {
    const grant = await caregiverService.revokeCaregiverGrant({
      clinicId: req.clinicId,
      patientId: req.params.patientId,
      grantId: req.params.grantId,
      actor: req.user,
      actorRole: 'staff',
      ...auditContext(req),
    });
    return res.json({ grant });
  } catch (err) {
    return next(err);
  }
}

async function invitePatientActivation(req, res, next) {
  try {
    const invitation = await caregiverService.invitePatientActivation({
      clinicId: req.clinicId,
      patientId: req.params.patientId,
      email: req.body.email,
      actor: req.user,
      actorRole: 'staff',
      ...auditContext(req),
    });
    return res.status(201).json({ invitation });
  } catch (err) {
    return next(err);
  }
}

// ----- the patient's own account -----

async function ownProfile(req, res, next) {
  try {
    const patient = await patientService.getOwnProfile({
      clinicId: req.clinicId,
      user: req.user,
    });
    return res.json({ patient });
  } catch (err) {
    return next(err);
  }
}

async function ownCaregivers(req, res, next) {
  try {
    const result = await caregiverService.listCaregivers({
      clinicId: req.clinicId,
      user: req.user,
      patientId: req.params.patientId,
      actorRole: 'patient',
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function ownInviteCaregiver(req, res, next) {
  try {
    const result = await caregiverService.inviteCaregiver({
      clinicId: req.clinicId,
      patientId: req.params.patientId,
      email: req.body.email,
      scopes: req.body.scopes,
      actor: req.user,
      actorRole: 'patient',
      ...auditContext(req),
    });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function ownRevokeCaregiver(req, res, next) {
  try {
    const grant = await caregiverService.revokeCaregiverGrant({
      clinicId: req.clinicId,
      patientId: req.params.patientId,
      grantId: req.params.grantId,
      actor: req.user,
      actorRole: 'patient',
      ...auditContext(req),
    });
    return res.json({ grant });
  } catch (err) {
    return next(err);
  }
}

// ----- the caregiver's own scoped view -----

async function caregiverPatients(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await caregiverService.listCaregiverPatients({
      user: req.user,
      page,
      limit,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function caregiverPatientDetail(req, res, next) {
  try {
    const { patient } = await caregiverService.accessPatientAsCaregiver({
      user: req.user,
      patientId: req.params.patientId,
      requiredScope: 'view_profile',
    });
    return res.json({ patient: { ...patientService.publicPatient(patient), scopes: ['view_profile'] } });
  } catch (err) {
    return next(err);
  }
}

// ----- public acceptance (token + password, no ambient authority) -----

async function acceptCaregiverInvitation(req, res, next) {
  try {
    const result = await caregiverService.acceptCaregiverInvitation({
      token: req.body.token,
      password: req.body.password,
      name: req.body.name,
      ...auditContext(req),
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function acceptPatientActivation(req, res, next) {
  try {
    const result = await caregiverService.acceptPatientActivation({
      token: req.body.token,
      password: req.body.password,
      name: req.body.name,
      ...auditContext(req),
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listCaregivers,
  inviteCaregiver,
  revokeCaregiverGrant,
  invitePatientActivation,
  ownProfile,
  ownCaregivers,
  ownInviteCaregiver,
  ownRevokeCaregiver,
  caregiverPatients,
  caregiverPatientDetail,
  acceptCaregiverInvitation,
  acceptPatientActivation,
};
