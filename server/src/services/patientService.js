'use strict';

// Patient onboarding, intake assignment and access resolution.
//
// Access model (control #5, default deny):
//   - a clinic-scoped patient record is only reachable by someone the record
//     itself authorises: an ACTIVE intake assignment (staff), ownership
//     (patient), or an ACTIVE unexpired scoped grant (caregiver);
//   - whenever none of those hold - including for a valid staff member of the
//     SAME clinic - the answer is a uniform 404 so cross-tenant existence is
//     never revealed.
const crypto = require('node:crypto');
const { ROLES } = require('../config/constants');
const { errors } = require('./errors');
const audit = require('./auditService');
const { withTransaction } = require('./txService');
const PatientProfile = require('../models/PatientProfile');
const PatientAssignment = require('../models/PatientAssignment');
const PatientConsent = require('../models/PatientConsent');
const CaregiverGrant = require('../models/CaregiverGrant');
const ClinicMembership = require('../models/ClinicMembership');

const STAFF_ROLES = [ROLES.ADMIN, ROLES.CARE_COORDINATOR, ROLES.CLINICAL_REVIEWER];

const REF_PREFIX = 'PT';
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous characters

function randomReference() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const byte of bytes) out += REF_ALPHABET[byte % REF_ALPHABET.length];
  return `${REF_PREFIX}-${out}`;
}

function toDateOnly(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// Never expose internal linkage/token fields through the API.
function publicPatient(patient) {
  return {
    // Works for both hydrated documents (.id) and .lean() results (._id only).
    id: patient._id ? String(patient._id) : patient.id,
    reference: patient.reference,
    fullName: patient.fullName,
    dateOfBirth: patient.dateOfBirth || null,
    contactEmail: patient.contactEmail || null,
    contactPhone: patient.contactPhone || null,
    status: patient.status,
    activatedAt: patient.activatedAt || null,
    hasAccount: Boolean(patient.linkedUserId),
    createdAt: patient.createdAt,
  };
}

function publicAssignment(assignment) {
  const user = assignment.memberUser && assignment.memberUser.email ? assignment.memberUser : null;
  return {
    id: assignment._id ? String(assignment._id) : assignment.id,
    memberUserId: user
      ? String(user._id || user.id)
      : String(assignment.memberUser),
    memberName: user ? user.name : undefined,
    memberEmail: user ? user.email : undefined,
    kind: assignment.kind,
    status: assignment.status,
    assignedAt: assignment.assignedAt,
    revokedAt: assignment.revokedAt || null,
  };
}

async function activeAssignmentCount(clinicId, patientId) {
  return PatientAssignment.countDocuments({
    clinic: clinicId,
    patient: patientId,
    status: 'active',
  });
}

// Resolves what the caller may do with this patient. Throws a uniform 404 when
// nothing authorises them, so the response never distinguishes "belongs to
// another clinic" from "not yours".
async function resolvePatientAccess({ clinicId, user, patientId }) {
  const patient = await PatientProfile.findOne({ _id: patientId, clinic: clinicId });
  if (!patient) throw errors.notFound('Patient not found.');

  if (patient.linkedUserId && String(patient.linkedUserId) === String(user.id)) {
    return { patient, access: 'patient', scopes: ['view_profile'] };
  }

  const assignment = await PatientAssignment.findOne({
    clinic: clinicId,
    patient: patient.id,
    memberUser: user.id,
    status: 'active',
  });
  if (assignment) return { patient, access: 'staff', assignment };

  const grant = await CaregiverGrant.findOne({
    clinic: clinicId,
    patient: patient.id,
    caregiverUser: user.id,
    status: 'active',
  });
  if (grant && grant.isUsable()) {
    return { patient, access: 'caregiver', scopes: [...grant.scopes], grant };
  }
  if (grant) {
    // Expired grant: record the transition once, then deny.
    grant.status = 'expired';
    await grant.save();
  }

  throw errors.notFound('Patient not found.');
}

// Requires an active intake assignment. Used by every staff read/write path.
async function requireStaffAssignment({ clinicId, user, patientId }) {
  const resolved = await resolvePatientAccess({ clinicId, user, patientId });
  if (resolved.access !== 'staff') throw errors.notFound('Patient not found.');
  return resolved;
}

// Resolves a unique clinic-scoped reference BEFORE opening a transaction. A
// duplicate-key error inside a transaction aborts the whole transaction, so
// collisions must be resolved outside it (a caller-supplied duplicate is a
// plain 409 rather than a retryable internal error).
async function resolveReference(clinicId, requested) {
  if (requested) {
    const clash = await PatientProfile.exists({ clinic: clinicId, reference: requested });
    if (clash) throw errors.conflict('That patient reference is already used in this clinic.');
    return requested;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = randomReference();
    // eslint-disable-next-line no-await-in-loop
    const clash = await PatientProfile.exists({ clinic: clinicId, reference: candidate });
    if (!clash) return candidate;
  }
  throw errors.conflict('Could not allocate a unique patient reference. Try again.');
}

async function createPatient({ clinicId, actor, data, ip, userAgent }) {
  const reference = await resolveReference(clinicId, data.reference);

  // The profile and its initial intake assignment are written atomically: a
  // patient record must never exist without somebody accountable for it.
  const patient = await withTransaction(async (session) => {
    const [created] = await PatientProfile.create(
      [
        {
          clinic: clinicId,
          reference,
          fullName: data.fullName,
          dateOfBirth: toDateOnly(data.dateOfBirth),
          contactEmail: data.contactEmail,
          contactPhone: data.contactPhone,
          status: 'draft',
          createdBy: actor.id,
        },
      ],
      { session }
    );

    const actorMembership = await ClinicMembership.findOne({
      clinic: clinicId,
      user: actor.id,
      status: 'active',
    }).session(session);
    await PatientAssignment.create(
      [
        {
          clinic: clinicId,
          patient: created.id,
          membership: actorMembership ? actorMembership.id : undefined,
          memberUser: actor.id,
          kind: 'intake',
          status: 'active',
          assignedBy: actor.id,
          assignedAt: new Date(),
        },
      ],
      { session }
    );
    return created;
  });

  await audit.record({
    clinic: clinicId,
    actorUser: actor.id,
    actorLabel: actor.email,
    action: 'patient.created',
    targetType: 'patient',
    targetId: patient.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { reference: patient.reference },
  });
  return publicPatient(patient);
}


// Staff see ONLY the patients they are actively assigned to (scoped totals).
async function listPatients({ clinicId, user, page, limit, query }) {
  const assignments = await PatientAssignment.find({
    clinic: clinicId,
    memberUser: user.id,
    status: 'active',
  })
    .select('patient')
    .lean();
  const patientIds = assignments.map((a) => a.patient);

  const filter = { clinic: clinicId, _id: { $in: patientIds } };
  if (query) {
    const safe = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { reference: new RegExp(safe, 'i') },
      { fullName: new RegExp(safe, 'i') },
    ];
  }

  const [items, total] = await Promise.all([
    PatientProfile.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PatientProfile.countDocuments(filter),
  ]);
  return { items: items.map(publicPatient), total, page, limit };
}

async function getPatient({ clinicId, user, patientId }) {
  const { patient } = await requireStaffAssignment({ clinicId, user, patientId });
  return publicPatient(patient);
}

async function updatePatient({ clinicId, user, patientId, changes, ip, userAgent }) {
  const { patient } = await requireStaffAssignment({ clinicId, user, patientId });
  const before = { fullName: patient.fullName, contactEmail: patient.contactEmail };

  if (changes.fullName !== undefined) patient.fullName = changes.fullName;
  if (changes.dateOfBirth !== undefined) patient.dateOfBirth = toDateOnly(changes.dateOfBirth);
  if (changes.contactEmail !== undefined) patient.contactEmail = changes.contactEmail;
  if (changes.contactPhone !== undefined) patient.contactPhone = changes.contactPhone;
  if (changes.status === 'inactive') patient.status = 'inactive';
  await patient.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'patient.updated',
    targetType: 'patient',
    targetId: patient.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { before, after: { fullName: patient.fullName, contactEmail: patient.contactEmail } },
  });
  return publicPatient(patient);
}

// Activation requires recorded care_coordination consent AND a responsible
// assignee; a profile can never be activated with nobody accountable for it.
async function activatePatient({ clinicId, user, patientId, ip, userAgent }) {
  const { patient } = await requireStaffAssignment({ clinicId, user, patientId });
  if (patient.status === 'active') return publicPatient(patient);
  if (patient.status !== 'draft') {
    throw errors.conflict('Only a draft patient can be activated.');
  }

  const consent = await PatientConsent.findOne({
    clinic: clinicId,
    patient: patient.id,
    action: 'granted',
    categories: 'care_coordination',
  }).lean();
  if (!consent) {
    throw errors.conflict('Record care_coordination consent before activating the patient.');
  }
  if ((await activeAssignmentCount(clinicId, patient.id)) === 0) {
    throw errors.conflict('Assign a responsible staff member before activating the patient.');
  }

  patient.status = 'active';
  patient.activatedAt = new Date();
  await patient.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'patient.activated',
    targetType: 'patient',
    targetId: patient.id,
    outcome: 'success',
    ip,
    userAgent,
  });
  return publicPatient(patient);
}

async function listAssignments({ clinicId, user, patientId }) {
  await requireStaffAssignment({ clinicId, user, patientId });
  const items = await PatientAssignment.find({ clinic: clinicId, patient: patientId })
    .populate('memberUser', 'email name')
    .sort({ status: 1, assignedAt: 1 })
    .lean();
  return { items: items.map(publicAssignment) };
}

// Staff who may be assigned: active clinic members holding a staff role.
async function listEligibleAssignees({ clinicId }) {
  const memberships = await ClinicMembership.find({
    clinic: clinicId,
    status: 'active',
    roleKey: { $in: STAFF_ROLES },
  })
    .populate('user', 'email name')
    .sort({ createdAt: 1 })
    .lean();
  return {
    items: memberships
      .filter((m) => m.user)
      .map((m) => ({
        membershipId: String(m._id || m.id),
        userId: String(m.user._id || m.user.id),
        name: m.user.name,
        email: m.user.email,
        roleKey: m.roleKey,
        reviewerEligibility: m.reviewerEligibility.status,
      })),
  };
}

async function createAssignment({ clinicId, user, patientId, memberUserId, ip, userAgent }) {
  await requireStaffAssignment({ clinicId, user, patientId });

  const target = await ClinicMembership.findOne({
    clinic: clinicId,
    user: memberUserId,
    status: 'active',
    roleKey: { $in: STAFF_ROLES },
  }).populate('user', 'email name');
  if (!target) throw errors.notFound('Staff member not found.');

  let assignment;
  try {
    assignment = await PatientAssignment.create({
      clinic: clinicId,
      patient: patientId,
      membership: target.id,
      memberUser: target.user._id,
      kind: 'intake',
      status: 'active',
      assignedBy: user.id,
      assignedAt: new Date(),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Idempotent: a repeat request must not create a duplicate interval.
      const existing = await PatientAssignment.findOne({
        clinic: clinicId,
        patient: patientId,
        memberUser: target.user._id,
        status: 'active',
      }).populate('memberUser', 'email name');
      return publicAssignment(existing);
    }
    throw err;
  }

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'patient.assignment.created',
    targetType: 'patient_assignment',
    targetId: assignment.id,
    outcome: 'success',
    ip,
    userAgent,
    detail: { memberUser: String(target.user._id) },
  });
  const populated = await PatientAssignment.findById(assignment.id).populate('memberUser', 'email name');
  return publicAssignment(populated);
}

// Reassignment ends an interval and opens a new one; history is never erased.
// The last responsible assignee can never be removed.
async function revokeAssignment({ clinicId, user, patientId, assignmentId, ip, userAgent }) {
  await requireStaffAssignment({ clinicId, user, patientId });

  const assignment = await PatientAssignment.findOne({
    _id: assignmentId,
    clinic: clinicId,
    patient: patientId,
  });
  if (!assignment) throw errors.notFound('Assignment not found.');
  if (assignment.status === 'revoked') return publicAssignment(assignment);

  if ((await activeAssignmentCount(clinicId, patientId)) <= 1) {
    throw errors.conflict('A patient must keep at least one active assignee.');
  }

  assignment.status = 'revoked';
  assignment.revokedAt = new Date();
  assignment.revokedBy = user.id;
  await assignment.save();

  await audit.record({
    clinic: clinicId,
    actorUser: user.id,
    actorLabel: user.email,
    action: 'patient.assignment.revoked',
    targetType: 'patient_assignment',
    targetId: assignment.id,
    outcome: 'success',
    ip,
    userAgent,
  });
  return publicAssignment(assignment);
}

// The patient's own view: their profile plus the grants they control.
async function getOwnProfile({ clinicId, user }) {
  const patient = await PatientProfile.findOne({
    clinic: clinicId,
    linkedUserId: user.id,
  }).lean();
  if (!patient) throw errors.notFound('No patient profile is linked to this account.');
  return publicPatient(patient);
}

module.exports = {
  STAFF_ROLES,
  publicPatient,
  resolvePatientAccess,
  requireStaffAssignment,
  createPatient,
  listPatients,
  getPatient,
  updatePatient,
  activatePatient,
  listAssignments,
  listEligibleAssignees,
  createAssignment,
  revokeAssignment,
  getOwnProfile,
  activeAssignmentCount,
  randomReference,
};
