'use strict';

// Caregiver access and patient activation.
//
// A grant is INACTIVE until its invitation is accepted, holds only the scopes
// that were explicitly granted, and stops working the moment it is revoked or
// expires. A caregiver can never invite anyone else and never receives clinical
// approval rights (no such permission is reachable through these paths).
const {
  ROLES,
  CAREGIVER_SCOPES,
  CAREGIVER_INVITATION_TTL_DAYS,
  PATIENT_ACTIVATION_TTL_DAYS,
} = require('../config/constants');
const { errors } = require('./errors');
const { randomToken, hmac } = require('./crypto');
const { hashPassword } = require('./passwordService');
const audit = require('./auditService');
const { withTransaction } = require('./txService');
const patientService = require('./patientService');
const consentService = require('./consentService');
const AccessInvitation = require('../models/AccessInvitation');
const CaregiverGrant = require('../models/CaregiverGrant');
const PatientProfile = require('../models/PatientProfile');
const ClinicMembership = require('../models/ClinicMembership');
const User = require('../models/User');
const { getEnv } = require('../config/env');

function publicGrant(grant) {
  return {
    // Works for both hydrated documents (.id) and .lean() results (._id only).
    id: grant._id ? String(grant._id) : grant.id,
    caregiverUserId: grant.caregiverUser ? String(grant.caregiverUser) : null,
    email: grant.granteeEmail || null,
    scopes: [...(grant.scopes || [])],
    status: grant.status,
    grantedByRole: grant.grantedByRole,
    acceptedAt: grant.acceptedAt || null,
    expiresAt: grant.expiresAt || null,
    revokedAt: grant.revokedAt || null,
    createdAt: grant.createdAt,
  };
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// Development delivery only: no mail provider is authorised yet (control #22).
function logInvitationLink(kind, email, token) {
  const origin = getEnv().CLIENT_ORIGIN;
  const path = kind === 'patient_activation' ? 'activate' : 'caregiver-invite';
  // eslint-disable-next-line no-console
  console.info(`[access-invitation] synthetic link for ${email}: ${origin}/${path}/${token}`);
}

function normalizeScopes(scopes) {
  const requested = Array.isArray(scopes) && scopes.length ? scopes : ['view_profile'];
  for (const scope of requested) {
    if (!CAREGIVER_SCOPES.includes(scope)) {
      throw errors.badRequest('Unknown caregiver scope.');
    }
  }
  return [...new Set(requested)];
}

async function inviteCaregiver({ clinicId, patientId, email, scopes, actor, actorRole, ip, userAgent }) {
  if (actorRole === 'staff') {
    await patientService.requireStaffAssignment({ clinicId, user: actor, patientId });
  } else {
    // The patient owner controls their own grants.
    const patient = await PatientProfile.findOne({ _id: patientId, clinic: clinicId }).lean();
    if (!patient || String(patient.linkedUserId) !== String(actor.id)) {
      throw errors.notFound('Patient not found.');
    }
  }

  const normalizedEmail = String(email).toLowerCase();
  const grantedScopes = normalizeScopes(scopes);
  const token = randomToken(32);
  const expiresAt = daysFromNow(CAREGIVER_INVITATION_TTL_DAYS);

  const created = await withTransaction(async (session) => {
    let invitation;
    try {
      [invitation] = await AccessInvitation.create(
        [
          {
            clinic: clinicId,
            patient: patientId,
            kind: 'caregiver',
            email: normalizedEmail,
            scopes: grantedScopes,
            tokenHash: hmac(token),
            expiresAt,
            outstanding: true,
            invitedByRole: actorRole,
            invitedByUser: actor.id,
          },
        ],
        { session }
      );
    } catch (err) {
      if (err && err.code === 11000) {
        throw errors.conflict('An invitation for that person is already outstanding.');
      }
      throw err;
    }

    const [grant] = await CaregiverGrant.create(
      [
        {
          clinic: clinicId,
          patient: patientId,
          granteeEmail: normalizedEmail,
          caregiverUser: null,
          scopes: grantedScopes,
          status: 'pending',
          grantedByRole: actorRole,
          grantedByUser: actor.id,
          invitation: invitation.id,
          expiresAt,
        },
      ],
      { session }
    );
    return { invitation, grant };
  });

  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'caregiver.invited',
    targetType: 'caregiver_grant',
    targetId: created.grant.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { scopes: grantedScopes },
  });
  logInvitationLink('caregiver', normalizedEmail, token);

  return {
    grant: publicGrant(created.grant),
    invitation: {
      id: created.invitation.id,
      email: created.invitation.email,
      scopes: grantedScopes,
      expiresAt,
      // No mail provider is authorised yet (control #22), so the invitation
      // link is returned to the authenticated inviter to pass on. Only the
      // hash is stored; this is the single moment the raw token exists.
      token,
    },
  };
}

async function listCaregivers({ clinicId, user, patientId, actorRole }) {
  if (actorRole === 'staff') {
    await patientService.requireStaffAssignment({ clinicId, user, patientId });
  } else {
    const patient = await PatientProfile.findOne({ _id: patientId, clinic: clinicId }).lean();
    if (!patient || String(patient.linkedUserId) !== String(user.id)) {
      throw errors.notFound('Patient not found.');
    }
  }
  const items = await CaregiverGrant.find({ clinic: clinicId, patient: patientId })
    .sort({ createdAt: -1 })
    .lean();
  return { items: items.map(publicGrant) };
}

// Revocation is immediate: the grant stops authorising on the very next request.
async function revokeCaregiverGrant({ clinicId, patientId, grantId, actor, actorRole, ip, userAgent }) {
  if (actorRole === 'staff') {
    await patientService.requireStaffAssignment({ clinicId, user: actor, patientId });
  } else {
    const patient = await PatientProfile.findOne({ _id: patientId, clinic: clinicId }).lean();
    if (!patient || String(patient.linkedUserId) !== String(actor.id)) {
      throw errors.notFound('Patient not found.');
    }
  }

  const grant = await CaregiverGrant.findOne({ _id: grantId, clinic: clinicId, patient: patientId });
  if (!grant) throw errors.notFound('Grant not found.');
  if (grant.status === 'revoked') return publicGrant(grant);

  await withTransaction(async (session) => {
    grant.status = 'revoked';
    grant.revokedAt = new Date();
    grant.revokedByRole = actorRole;
    grant.revokedByUser = actor.id;
    await grant.save({ session });
    // Any outstanding invitation for this grant can no longer be accepted.
    if (grant.invitation) {
      await AccessInvitation.updateOne(
        { _id: grant.invitation, outstanding: true },
        { $set: { outstanding: false, revokedAt: new Date() } },
        { session }
      );
    }
  });

  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'caregiver.revoked',
    targetType: 'caregiver_grant',
    targetId: grant.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { actorRole },
  });
  return publicGrant(grant);
}

// Single-use acceptance. Two parallel acceptances race on the conditional
// update of `outstanding`, so exactly one wins.
async function acceptCaregiverInvitation({ token, password, name, ip, userAgent }) {
  const invitation = await AccessInvitation.findOne({
    tokenHash: hmac(String(token)),
    kind: 'caregiver',
  }).select('+tokenHash');
  if (!invitation) throw errors.badRequest('This invitation link is not valid.');
  if (invitation.revokedAt) throw errors.badRequest('This invitation was revoked.');
  if (invitation.acceptedAt) throw errors.badRequest('This invitation has already been used.');
  if (invitation.expiresAt <= new Date()) throw errors.badRequest('This invitation has expired.');

  const claimed = await AccessInvitation.findOneAndUpdate(
    { _id: invitation.id, outstanding: true },
    { $set: { outstanding: false, acceptedAt: new Date() } },
    { new: true }
  );
  if (!claimed) throw errors.conflict('This invitation has already been used.');

  // Refuse to grant access to a patient who is not active.
  const patient = await PatientProfile.findOne({
    _id: invitation.patient,
    clinic: invitation.clinic,
  }).lean();
  if (!patient || patient.status !== 'active') {
    throw errors.conflict('This patient record is not active.');
  }

  const email = invitation.email;
  const result = await withTransaction(async (session) => {
    let user = await User.findOne({ email }).session(session);
    if (!user) {
      const created = await User.create(
        [{ email, name: name || email, passwordHash: await hashPassword(password) }],
        { session }
      );
      [user] = created;
    }
    const existingMembership = await ClinicMembership.findOne({
      clinic: invitation.clinic,
      user: user.id,
    }).session(session);
    if (!existingMembership) {
      await ClinicMembership.create(
        [
          {
            clinic: invitation.clinic,
            user: user.id,
            roleKey: ROLES.CAREGIVER,
            status: 'active',
            reviewerEligibility: { status: 'not_applicable' },
          },
        ],
        { session }
      );
    }

    const grant = await CaregiverGrant.findOne({ invitation: invitation.id }).session(session);
    if (!grant) throw errors.internal('Grant not found for this invitation.');
    if (grant.status === 'revoked') throw errors.forbidden('This access was revoked.');
    grant.caregiverUser = user.id;
    grant.granteeEmail = email;
    grant.status = 'active';
    grant.acceptedAt = new Date();
    await grant.save({ session });

    await AccessInvitation.updateOne(
      { _id: invitation.id },
      { $set: { acceptedByUser: user.id } },
      { session }
    );
    return { user, grant };
  });

  await audit.record({
    clinic: invitation.clinic,
    actorUser: result.user.id,
    actorLabel: result.user.email,
    action: 'caregiver.invitation.accepted',
    targetType: 'caregiver_grant',
    targetId: result.grant.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { scopes: result.grant.scopes },
  });
  return { user: { id: result.user.id, email: result.user.email, name: result.user.name }, grant: publicGrant(result.grant) };
}

// Patients a caregiver may see: active, unexpired grants holding view_profile.
// Any other scope is deliberately NOT honoured yet (Part 2 grants no episode or
// document access), so a future scope cannot silently widen this list.
async function listCaregiverPatients({ user, page, limit }) {
  const grants = await CaregiverGrant.find({
    caregiverUser: user.id,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
    .sort({ createdAt: -1 })
    .lean();

  const usable = grants.filter((g) => (g.scopes || []).includes('view_profile'));
  const ids = usable.map((g) => g.patient);
  const [items, total] = await Promise.all([
    PatientProfile.find({ _id: { $in: ids } })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PatientProfile.countDocuments({ _id: { $in: ids } }),
  ]);
  return {
    items: items.map((p) => ({ ...patientService.publicPatient(p), scopes: ['view_profile'] })),
    total,
    page,
    limit,
  };
}

async function accessPatientAsCaregiver({ clinicId, user, patientId, requiredScope }) {
  // The grant is the source of truth for scope; clinicId is derived from it so
  // a caregiver can never widen their reach by naming another clinic.
  const grantFilter = {
    patient: patientId,
    caregiverUser: user.id,
    status: 'active',
  };
  if (clinicId) grantFilter.clinic = clinicId;
  const grant = await CaregiverGrant.findOne(grantFilter);
  if (!grant) throw errors.notFound('Patient not found.');

  const patient = await PatientProfile.findOne({
    _id: patientId,
    clinic: grant.clinic,
  }).lean();
  if (!patient) throw errors.notFound('Patient not found.');
  if (!grant.isUsable()) throw errors.notFound('Patient not found.');
  if (!grant.scopes.includes(requiredScope)) {
    // Deliberately a 404: a caregiver without the scope learns nothing about
    // whether the record exists.
    throw errors.notFound('Patient not found.');
  }
  return { patient, grant };
}

// Staff (or the patient) requests activation of the patient's own account.
async function invitePatientActivation({ clinicId, patientId, email, actor, actorRole, ip, userAgent }) {
  const patient = await PatientProfile.findOne({ _id: patientId, clinic: clinicId });
  if (!patient) throw errors.notFound('Patient not found.');
  if (actorRole === 'staff') {
    await patientService.requireStaffAssignment({ clinicId, user: actor, patientId });
  } else if (String(patient.linkedUserId) !== String(actor.id)) {
    throw errors.notFound('Patient not found.');
  }

  const normalizedEmail = String(email).toLowerCase();
  const token = randomToken(32);
  const expiresAt = daysFromNow(PATIENT_ACTIVATION_TTL_DAYS);

  let invitation;
  try {
    invitation = await AccessInvitation.create({
      clinic: clinicId,
      patient: patientId,
      kind: 'patient_activation',
      email: normalizedEmail,
      scopes: [],
      tokenHash: hmac(token),
      expiresAt,
      outstanding: true,
      invitedByRole: actorRole,
      invitedByUser: actor.id,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      throw errors.conflict('An activation invitation for that email is already outstanding.');
    }
    throw err;
  }

  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'patient.activation.invited',
    targetType: 'patient',
    targetId: String(patientId),
    outcome: 'success',
    ip,
    userAgent,
  });
  logInvitationLink('patient_activation', normalizedEmail, token);
  return { id: invitation.id, email: normalizedEmail, expiresAt, token };
}

// Acceptance links the account to the profile and activates it, but ONLY when
// care_coordination consent and a responsible assignee already exist.
async function acceptPatientActivation({ token, password, name, ip, userAgent }) {
  const invitation = await AccessInvitation.findOne({
    tokenHash: hmac(String(token)),
    kind: 'patient_activation',
  }).select('+tokenHash');
  if (!invitation) throw errors.badRequest('This activation link is not valid.');
  if (invitation.revokedAt) throw errors.badRequest('This activation link was revoked.');
  if (invitation.acceptedAt) throw errors.badRequest('This activation link has already been used.');
  if (invitation.expiresAt <= new Date()) throw errors.badRequest('This activation link has expired.');

  const patient = await PatientProfile.findOne({
    _id: invitation.patient,
    clinic: invitation.clinic,
  });
  if (!patient) throw errors.notFound('Patient not found.');
  if (patient.linkedUserId) throw errors.conflict('This patient profile already has an account.');

  const claimed = await AccessInvitation.findOneAndUpdate(
    { _id: invitation.id, outstanding: true },
    { $set: { outstanding: false, acceptedAt: new Date() } },
    { new: true }
  );
  if (!claimed) throw errors.conflict('This activation link has already been used.');

  await consentService.assertConsentFor({
    clinicId: invitation.clinic,
    patientId: patient.id,
    category: 'care_coordination',
    message: 'Care coordination consent is not recorded for this patient.',
  });
  if ((await patientService.activeAssignmentCount(invitation.clinic, patient.id)) === 0) {
    throw errors.conflict('A responsible staff member must be assigned before activation.');
  }

  const email = invitation.email;
  const result = await withTransaction(async (session) => {
    let user = await User.findOne({ email }).session(session);
    if (!user) {
      const created = await User.create(
        [{ email, name: name || patient.fullName, passwordHash: await hashPassword(password) }],
        { session }
      );
      [user] = created;
    }
    const existingMembership = await ClinicMembership.findOne({
      clinic: invitation.clinic,
      user: user.id,
    }).session(session);
    if (!existingMembership) {
      await ClinicMembership.create(
        [
          {
            clinic: invitation.clinic,
            user: user.id,
            roleKey: ROLES.PATIENT,
            status: 'active',
            reviewerEligibility: { status: 'not_applicable' },
          },
        ],
        { session }
      );
    }

    patient.linkedUserId = user.id;
    patient.status = 'active';
    patient.activatedAt = new Date();
    await patient.save({ session });

    await AccessInvitation.updateOne(
      { _id: invitation.id },
      { $set: { acceptedByUser: user.id } },
      { session }
    );
    return { user };
  });

  await audit.record({
    clinic: invitation.clinic,
    actorUser: result.user.id,
    actorLabel: result.user.email,
    action: 'patient.activation.accepted',
    targetType: 'patient',
    targetId: String(patient.id),
    outcome: 'success',
    ip,
    userAgent,
  });
  return {
    user: { id: result.user.id, email: result.user.email, name: result.user.name },
    patient: patientService.publicPatient(patient),
  };
}

module.exports = {
  publicGrant,
  inviteCaregiver,
  listCaregivers,
  revokeCaregiverGrant,
  acceptCaregiverInvitation,
  listCaregiverPatients,
  accessPatientAsCaregiver,
  invitePatientActivation,
  acceptPatientActivation,
};
