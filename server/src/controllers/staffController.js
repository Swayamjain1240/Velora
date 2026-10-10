'use strict';

const staffService = require('../services/staffService');
const Clinic = require('../models/Clinic');

async function getClinic(req, res, next) {
  try {
    const clinic = await Clinic.findById(req.clinicId).lean();
    if (!clinic) return next();
    return res.json({
      clinic: { id: clinic.id, name: clinic.name, code: clinic.code, status: clinic.status },
      roleKey: req.roleKey,
      reviewerEligibility: req.membership.reviewerEligibility.status,
    });
  } catch (err) {
    return next(err);
  }
}

async function updateClinic(req, res, next) {
  try {
    const clinic = await Clinic.findByIdAndUpdate(
      req.clinicId,
      { $set: { name: req.body.name } },
      { new: true }
    ).lean();
    return res.json({ clinic: { id: clinic.id, name: clinic.name, code: clinic.code } });
  } catch (err) {
    return next(err);
  }
}

async function listMembers(req, res, next) {
  try {
    const { page, limit, query } = req.query;
    const result = await staffService.listMembers({
      clinicId: req.clinicId,
      page,
      limit,
      query,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function updateMember(req, res, next) {
  try {
    const member = await staffService.updateMember({
      clinicId: req.clinicId,
      membershipId: req.params.membershipId,
      actor: req.user,
      changes: req.body,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    return res.json({ member });
  } catch (err) {
    return next(err);
  }
}

async function createInvitation(req, res, next) {
  try {
    const invitation = await staffService.createInvitation({
      clinicId: req.clinicId,
      email: req.body.email,
      roleKey: req.body.roleKey,
      actor: req.user,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    return res.status(201).json({ invitation });
  } catch (err) {
    return next(err);
  }
}

async function listInvitations(req, res, next) {
  try {
    const { page, limit } = req.query;
    const result = await staffService.listInvitations({ clinicId: req.clinicId, page, limit });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

async function revokeInvitation(req, res, next) {
  try {
    await staffService.revokeInvitation({
      clinicId: req.clinicId,
      invitationId: req.params.invitationId,
      actor: req.user,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

async function setReviewerEligibility(req, res, next) {
  try {
    const member = await staffService.setReviewerEligibility({
      clinicId: req.clinicId,
      membershipId: req.params.membershipId,
      action: req.body.action,
      actor: req.user,
      ip: req.clientIp,
      userAgent: req.clientUserAgent,
    });
    return res.json({ member });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getClinic,
  updateClinic,
  listMembers,
  updateMember,
  createInvitation,
  listInvitations,
  revokeInvitation,
  setReviewerEligibility,
};
