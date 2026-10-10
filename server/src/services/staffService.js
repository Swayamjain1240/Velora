'use strict';

// Clinic staff administration: members, invitations and reviewer eligibility.
// Two invariants are enforced here in addition to route-level policy:
//   1. The last active admin can never be deactivated or demoted.
//   2. Reviewer eligibility can only be verified by a DIFFERENT already
//      verified, eligible clinical reviewer - never by an admin alone and
//      never by yourself (VEL-002 boundary).
const { ROLES } = require('../config/constants');
const { errors } = require('./errors');
const { hmac, randomToken } = require('./crypto');
const audit = require('./auditService');
const ClinicMembership = require('../models/ClinicMembership');
const MembershipRole = require('../models/MembershipRole');
const Invitation = require('../models/Invitation');
const User = require('../models/User');
const { getEnv } = require('../config/env');

function publicMember(membership) {
  return {
    id: membership.id,
    userId: membership.user && membership.user._id ? membership.user._id : membership.user,
    email: membership.user ? membership.user.email : undefined,
    name: membership.user ? membership.user.name : undefined,
    roleKey: membership.roleKey,
    status: membership.status,
    reviewerEligibility: {
      status: membership.reviewerEligibility.status,
      verifiedAt: membership.reviewerEligibility.verifiedAt || null,
    },
    joinedAt: membership.createdAt,
  };
}

async function listMembers({ clinicId, page, limit, query }) {
  const filter = { clinic: clinicId };
  if (query) {
    // Escape regex metacharacters so user input can never build a hostile pattern.
    const safe = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ 'user.name': new RegExp(safe, 'i') }];
  }
  const [items, total] = await Promise.all([
    ClinicMembership.find(filter)
      .populate('user', 'email name')
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    ClinicMembership.countDocuments(filter),
  ]);
  return { items: items.map(publicMember), total, page, limit };
}

async function activeAdminCount(clinicId) {
  return ClinicMembership.countDocuments({
    clinic: clinicId,
    roleKey: ROLES.ADMIN,
    status: 'active',
  });
}

async function updateMember({ clinicId, membershipId, actor, changes, ip, userAgent }) {
  const membership = await ClinicMembership.findOne({
    _id: membershipId,
    clinic: clinicId,
  }).populate('user', 'email name');
  if (!membership) throw errors.notFound('Staff member not found.');

  const demoting =
    changes.roleKey && changes.roleKey !== ROLES.ADMIN && membership.roleKey === ROLES.ADMIN;
  const deactivating =
    changes.status === 'inactive' &&
    membership.status === 'active' &&
    membership.roleKey === ROLES.ADMIN;

  if ((demoting || deactivating) && (await activeAdminCount(clinicId)) <= 1) {
    throw errors.conflict('A clinic must keep at least one active admin.');
  }

  const previous = { roleKey: membership.roleKey, status: membership.status };
  if (changes.roleKey) membership.roleKey = changes.roleKey;
  if (changes.status) membership.status = changes.status;

  // Reviewer eligibility follows the role: entering the reviewer role starts
  // as pending (never auto-verified); leaving it clears eligibility.
  if (changes.roleKey) {
    if (changes.roleKey === ROLES.CLINICAL_REVIEWER) {
      membership.reviewerEligibility = { status: 'pending' };
    } else {
      membership.reviewerEligibility = { status: 'not_applicable' };
    }
  }

  await membership.save();
  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'staff.member.updated',
    targetType: 'membership',
    targetId: membership.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { previous, next: { roleKey: membership.roleKey, status: membership.status } },
  });
  return publicMember(membership);
}

async function createInvitation({ clinicId, email, roleKey, actor, ip, userAgent }) {
  const normalizedEmail = String(email).toLowerCase();
  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    const alreadyMember = await ClinicMembership.findOne({
      clinic: clinicId,
      user: existingUser.id,
    });
    if (alreadyMember) {
      throw errors.conflict('That person is already part of this clinic.');
    }
  }
  const raw = randomToken(32);
  const invitation = await Invitation.create({
    clinic: clinicId,
    email: normalizedEmail,
    roleKey,
    tokenHash: hmac(raw),
    invitedBy: actor.id,
  });
  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'staff.invitation.created',
    targetType: 'invitation',
    targetId: invitation.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { roleKey },
  });
  const origin = getEnv().CLIENT_ORIGIN;
  // Development-only delivery: no mail provider is authorized (control #22).
  // eslint-disable-next-line no-console
  console.info(
    `[invitation] synthetic link for ${normalizedEmail}: ${origin}/accept-invite/${raw}`
  );
  return {
    id: invitation.id,
    email: invitation.email,
    roleKey: invitation.roleKey,
    expiresAt: invitation.expiresAt,
  };
}

async function listInvitations({ clinicId, page, limit }) {
  const filter = { clinic: clinicId };
  const [items, total] = await Promise.all([
    Invitation.find(filter)
      .populate('invitedBy', 'email name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Invitation.countDocuments(filter),
  ]);
  return {
    items: items.map((inv) => ({
      id: inv.id,
      email: inv.email,
      roleKey: inv.roleKey,
      status: inv.acceptedAt
        ? 'accepted'
        : inv.revokedAt
          ? 'revoked'
          : inv.expiresAt < new Date()
            ? 'expired'
            : 'pending',
      expiresAt: inv.expiresAt,
      invitedBy: inv.invitedBy ? inv.invitedBy.email : null,
      createdAt: inv.createdAt,
    })),
    total,
    page,
    limit,
  };
}

async function revokeInvitation({ clinicId, invitationId, actor, ip, userAgent }) {
  const invitation = await Invitation.findOne({ _id: invitationId, clinic: clinicId });
  if (!invitation || invitation.acceptedAt) {
    throw errors.notFound('Invitation not found.');
  }
  invitation.revokedAt = new Date();
  await invitation.save();
  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'staff.invitation.revoked',
    targetType: 'invitation',
    targetId: invitation.id,
    outcome: 'success',
    ip,
    userAgent,
  });
}

// Self-grant protection lives here: actor must be a verified eligible clinical
// reviewer of the SAME clinic and cannot verify themselves. Admin role alone
// never satisfies this check.
async function setReviewerEligibility({ clinicId, membershipId, action, actor, ip, userAgent }) {
  const actorMembership = await ClinicMembership.findOne({
    clinic: clinicId,
    user: actor.id,
    status: 'active',
  });
  const actorEligible =
    actorMembership &&
    actorMembership.roleKey === ROLES.CLINICAL_REVIEWER &&
    actorMembership.reviewerEligibility.status === 'verified';
  if (!actorEligible) {
    throw errors.forbidden(
      'Only an already verified clinical reviewer can change reviewer eligibility.'
    );
  }

  const target = await ClinicMembership.findOne({
    _id: membershipId,
    clinic: clinicId,
  }).populate('user', 'email name');
  if (!target) throw errors.notFound('Staff member not found.');
  if (target.id === actorMembership.id) {
    throw errors.forbidden('You cannot change your own reviewer eligibility.');
  }
  if (target.roleKey !== ROLES.CLINICAL_REVIEWER) {
    throw errors.conflict('Reviewer eligibility applies only to the clinical reviewer role.');
  }

  if (action === 'verify') {
    target.reviewerEligibility = {
      status: 'verified',
      verifiedBy: actor.id,
      verifiedAt: new Date(),
    };
  } else {
    target.reviewerEligibility = { status: 'pending' };
  }
  await target.save();

  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: `staff.reviewer_eligibility.${action === 'verify' ? 'verified' : 'revoked'}`,
    targetType: 'membership',
    targetId: target.id,
    outcome: 'success',
    ip,
    userAgent,
  });
  return publicMember(target);
}

module.exports = {
  listMembers,
  updateMember,
  createInvitation,
  listInvitations,
  revokeInvitation,
  setReviewerEligibility,
  activeAdminCount,
};
